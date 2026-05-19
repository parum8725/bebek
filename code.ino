#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "DHT.h"
#include <math.h>
#include <time.h>
#include <esp_task_wdt.h>
#include <esp_system.h>

// ═══════════════════════════════════════════════════════════
// ─── WiFi ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
#define WIFI_SSID     "hem"
#define WIFI_PASSWORD "00000000"

// ─── Firebase ──────────────────────────────────────────────
#define DATABASE_URL        "mikroklimat-dod-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_PROJECT_ID "mikroklimat-dod"
#define FIREBASE_API_KEY    "AIzaSyAiUdBLlfaemZ_aTytRiuHbvUurAGHnOgk"

// ─── DHT22 ─────────────────────────────────────────────────
#define DHTPIN  4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// ─── MQ135 ─────────────────────────────────────────────────
#define MQ135_AO         34
#define RL_VALUE         10.0f
#define VCC_SENSOR       5.0f
#define ADC_VREF         3.3f
#define ADC_RESOLUTION   4095.0f
#define CLEAN_AIR_FACTOR 3.6f
#define NH3_A            102.2f
#define NH3_B            -2.473f

#define MODE_KALIBRASI  false
#define RO_CALIBRATED   10.0f
float Ro = RO_CALIBRATED;

// ─── Relay (active LOW) ────────────────────────────────────
#define HEATER_PIN  25
#define INTAKE_PIN  26
#define EXHAUST_PIN 33
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// ─── Watchdog ──────────────────────────────────────────────
#define WDT_TIMEOUT_S   60

// ─── Threshold heap minimum ────────────────────────────────
#define HEAP_RESTART_THRESHOLD  40000   // bytes

// ─── Firebase objects (GLOBAL — tidak reallocate tiap loop) ─
FirebaseData    fbdo;        // kirim data sensor (real-time)
FirebaseData    histFbdo;    // kirim history ke Firestore
FirebaseData    statusFbdo;  // kirim status relay
FirebaseData    streamFbdo;  // listen /control stream
FirebaseAuth    auth;
FirebaseConfig  config;
FirebaseJson    sensorJson;  // GLOBAL: tidak reallocate tiap loop
FirebaseJson    histJson;    // GLOBAL: tidak reallocate tiap loop

// ─── State relay ───────────────────────────────────────────
volatile bool heater        = false;
volatile bool intake        = false;
volatile bool exhaust       = false;
volatile bool isManualMode  = false;
volatile bool statusPending = false;

bool lastWrittenHeater  = false;
bool lastWrittenIntake  = false;
bool lastWrittenExhaust = false;

// ─── Nilai sensor terakhir (untuk history push) ────────────
float lastSuhu       = NAN;
float lastKelembaban = NAN;
float lastPpmNh3     = 0.0f;
int   lastRawGas     = 0;
bool  sensorValid    = false;

// ─── Timers ────────────────────────────────────────────────
unsigned long lastSensorMs      = 0;
unsigned long lastHistoryMs     = 0;
unsigned long lastWiFiCheckMs   = 0;
unsigned long lastHeapLogMs     = 0;
unsigned long lastSuccessMs     = 0;
unsigned long lastStreamForceMs = 0;

const unsigned long SENSOR_INTERVAL         = 3000;
const unsigned long HISTORY_INTERVAL        = 5000;
const unsigned long WIFI_CHECK_INTERVAL     = 15000;
const unsigned long HEAP_LOG_INTERVAL       = 60000;
const unsigned long NO_SEND_RESTART_MS      = 300000;
const unsigned long STREAM_FORCE_RESTART_MS = 180000;

// ═══════════════════════════════════════════════════════════
// MQ135
// ═══════════════════════════════════════════════════════════

float hitungRs(int raw_adc) {
  if (raw_adc <= 0) return 999999.0f;
  float v_adc = (raw_adc / ADC_RESOLUTION) * ADC_VREF;
  if (v_adc <= 0.01f) return 999999.0f;
  return ((VCC_SENSOR - v_adc) / v_adc) * RL_VALUE;
}

float kalibrasiRo() {
  Serial.println("\n>>> MULAI KALIBRASI MQ135 (60 detik) <<<");
  Serial.println(">>> Pastikan sensor di UDARA BERSIH! <<<");
  float total = 0;
  for (int i = 0; i < 60; i++) {
    int raw = analogRead(MQ135_AO);
    float rs = hitungRs(raw);
    total += rs;
    Serial.printf("Sampel %d | RAW: %d | Rs: %.4f kΩ\n", i + 1, raw, rs);
    esp_task_wdt_reset();
    delay(1000);
  }
  float ro = (total / 60.0f) / CLEAN_AIR_FACTOR;
  Serial.printf("\n>>> Ro HASIL KALIBRASI = %.4f kΩ\n", ro);
  Serial.println(">>> Masukkan ke #define RO_CALIBRATED");
  Serial.println(">>> Lalu set MODE_KALIBRASI = false dan upload ulang\n");
  return ro;
}

float bacaNH3ppm(int raw_adc) {
  float rs    = hitungRs(raw_adc);
  float ratio = rs / Ro;
  if (ratio <= 0.0f) return 0.0f;
  return max(0.0f, NH3_A * powf(ratio, NH3_B));
}

// ═══════════════════════════════════════════════════════════
// WiFi — reconnect otomatis jika putus
// ═══════════════════════════════════════════════════════════
void reconnectWiFiIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("⚠️  WiFi putus! Mencoba reconnect...");
  WiFi.disconnect(false);
  delay(500);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    esp_task_wdt_reset();
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi reconnect OK → " + WiFi.localIP().toString());
  } else {
    Serial.println("\n❌ WiFi reconnect GAGAL — akan dicoba lagi 15 detik kemudian");
  }
}

// ═══════════════════════════════════════════════════════════
// Relay & Status
// ═══════════════════════════════════════════════════════════

void applyGPIO() {
  digitalWrite(HEATER_PIN,  heater  ? RELAY_ON : RELAY_OFF);
  digitalWrite(INTAKE_PIN,  intake  ? RELAY_ON : RELAY_OFF);
  digitalWrite(EXHAUST_PIN, exhaust ? RELAY_ON : RELAY_OFF);
  statusPending = true;
}

void writeStatus() {
  if (!Firebase.ready()) return;
  statusPending = false;
  bool h = heater, i = intake, e = exhaust;
  if (h != lastWrittenHeater)  { Firebase.RTDB.setString(&statusFbdo, "/status/heater",  h ? "ON" : "OFF"); lastWrittenHeater  = h; }
  if (i != lastWrittenIntake)  { Firebase.RTDB.setString(&statusFbdo, "/status/intake",  i ? "ON" : "OFF"); lastWrittenIntake  = i; }
  if (e != lastWrittenExhaust) { Firebase.RTDB.setString(&statusFbdo, "/status/exhaust", e ? "ON" : "OFF"); lastWrittenExhaust = e; }
  Serial.printf("📤 Status → H:%s I:%s E:%s\n", h?"ON":"OFF", i?"ON":"OFF", e?"ON":"OFF");
}

void autoControl(float suhu, float ppm_nh3) {
  bool newHeater  = (suhu < 32.0f);
  bool newIntake  = (suhu > 35.0f);
  bool newExhaust = (ppm_nh3 > 25.0f);

  if (newHeater != (bool)heater || newIntake != (bool)intake || newExhaust != (bool)exhaust) {
    heater  = newHeater;
    intake  = newIntake;
    exhaust = newExhaust;
    applyGPIO();
    Serial.println("🤖 AUTO relay berubah");
  }
}

// ═══════════════════════════════════════════════════════════
// Stream callback
// ═══════════════════════════════════════════════════════════
void onControlStream(FirebaseStream data) {
  String path = data.dataPath();
  String type = data.dataType();

  if (type == "json") {
    FirebaseJson &json = data.jsonObject();
    FirebaseJsonData result;

    if (json.get(result, "mode")) {
      isManualMode = result.stringValue.equalsIgnoreCase("manual");
      Serial.println("📱 Mode (init): " + result.stringValue);
    }
    if (isManualMode) {
      if (json.get(result, "heater"))  heater  = (result.stringValue == "ON");
      if (json.get(result, "intake"))  intake  = (result.stringValue == "ON");
      if (json.get(result, "exhaust")) exhaust = (result.stringValue == "ON");
      applyGPIO();
    }

  } else if (type == "string") {
    String val = data.stringData();

    if (path == "/mode") {
      isManualMode = val.equalsIgnoreCase("manual");
      Serial.println("📱 Mode: " + val);

    } else if (isManualMode) {
      bool state   = (val == "ON");
      bool changed = false;

      if      (path == "/heater")  { heater  = state; changed = true; }
      else if (path == "/intake")  { intake  = state; changed = true; }
      else if (path == "/exhaust") { exhaust = state; changed = true; }

      if (changed) {
        applyGPIO();
        Serial.println("🔌 Manual: " + path + " = " + val);
      }
    }
  }
}

void onStreamTimeout(bool timeout) {
  if (timeout) Serial.println("⚠️ Stream timeout — reconnect otomatis...");
}

void startStream() {
  if (!Firebase.RTDB.beginStream(&streamFbdo, "/control")) {
    Serial.println("❌ Stream gagal: " + streamFbdo.errorReason());
  } else {
    Firebase.RTDB.setStreamCallback(&streamFbdo, onControlStream, onStreamTimeout);
    Serial.println("✅ Stream /control aktif");
  }
}

// ═══════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== ESP32 MIKROKLIMAT DOD (24/7 Mode) ===");
  Serial.printf("Reset reason: %d\n", esp_reset_reason());

  // ── Hardware Watchdog ────────────────────────────────────
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  const esp_task_wdt_config_t wdt_config = {
    .timeout_ms     = WDT_TIMEOUT_S * 1000,
    .idle_core_mask = 0,
    .trigger_panic  = true,
  };
  esp_task_wdt_init(&wdt_config);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
  Serial.printf("✅ Watchdog aktif (timeout %d detik)\n", WDT_TIMEOUT_S);

  // ── ADC ─────────────────────────────────────────────────
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // ── Sensor & Relay ───────────────────────────────────────
  dht.begin();
  pinMode(HEATER_PIN,  OUTPUT); digitalWrite(HEATER_PIN,  RELAY_OFF);
  pinMode(INTAKE_PIN,  OUTPUT); digitalWrite(INTAKE_PIN,  RELAY_OFF);
  pinMode(EXHAUST_PIN, OUTPUT); digitalWrite(EXHAUST_PIN, RELAY_OFF);

  // ── Limit buffer ukuran respons Firebase ─────────────────
  fbdo.setResponseSize(1024);
  histFbdo.setResponseSize(512);
  statusFbdo.setResponseSize(512);
  streamFbdo.setResponseSize(1024);

  // ── Warm-up MQ135 ────────────────────────────────────────
  Serial.print("Warm-up MQ135");
  for (int i = 20; i > 0; i--) {
    Serial.print(".");
    esp_task_wdt_reset();
    delay(1000);
  }
  Serial.println(" OK");

  // ── Kalibrasi (jika MODE_KALIBRASI = true) ───────────────
  if (MODE_KALIBRASI) {
    Ro = kalibrasiRo();
  } else {
    Serial.printf("Pakai Ro = %.4f kΩ\n", Ro);
  }

  // ── WiFi ─────────────────────────────────────────────────
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  {
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) {
      Serial.print(".");
      esp_task_wdt_reset();
      delay(500);
    }
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n❌ WiFi gagal saat startup — restart...");
    delay(500);
    esp_restart();
  }
  Serial.println(" OK → " + WiFi.localIP().toString());

  // ── NTP ──────────────────────────────────────────────────
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("Sinkronisasi NTP");
  {
    struct tm t;
    unsigned long t0 = millis();
    while (!getLocalTime(&t) && millis() - t0 < 15000) {
      Serial.print(".");
      esp_task_wdt_reset();
      delay(500);
    }
    if (getLocalTime(&t)) {
      char buf[25]; strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
      Serial.println(" OK → " + String(buf));
    } else {
      Serial.println(" GAGAL — timestamp tidak akurat");
    }
  }

  // ── Firebase ─────────────────────────────────────────────
  config.api_key = FIREBASE_API_KEY;
  config.database_url = DATABASE_URL;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // Anonymous sign-in — menghasilkan ID token valid untuk RTDB & Firestore
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("✅ Firebase anonymous auth OK");
  } else {
    Serial.printf("⚠️ Auth gagal: %s\n", config.signer.signupError.message.c_str());
  }

  Serial.print("Menunggu Firebase");
  unsigned long t0 = millis();
  while (!Firebase.ready() && millis() - t0 < 15000) {
    Serial.print(".");
    esp_task_wdt_reset();
    delay(200);
  }
  Serial.println();

  if (Firebase.ready()) {
    // Baca mode tersimpan — jangan overwrite saat restart
    if (Firebase.RTDB.getString(&fbdo, "/control/mode") && fbdo.stringData().length() > 0) {
      String savedMode = fbdo.stringData();
      isManualMode = savedMode.equalsIgnoreCase("manual");
      Serial.println("✅ Mode dipulihkan: " + savedMode);

      if (isManualMode) {
        if (Firebase.RTDB.getJSON(&fbdo, "/control")) {
          FirebaseJson &json = fbdo.to<FirebaseJson>();
          FirebaseJsonData result;
          if (json.get(result, "heater"))  heater  = (result.stringValue == "ON");
          if (json.get(result, "intake"))  intake  = (result.stringValue == "ON");
          if (json.get(result, "exhaust")) exhaust = (result.stringValue == "ON");
          applyGPIO();
          Serial.printf("✅ Relay dipulihkan → H:%s I:%s E:%s\n",
            heater?"ON":"OFF", intake?"ON":"OFF", exhaust?"ON":"OFF");
        }
      }
    } else {
      Firebase.RTDB.setString(&fbdo, "/control/mode", "auto");
      Serial.println("✅ Mode default 'auto' ditulis (pertama kali)");
    }
  } else {
    Serial.println("⚠️ Firebase belum siap saat setup — akan retry di loop");
  }

  // ── Mulai stream ─────────────────────────────────────────
  startStream();

  lastSuccessMs = millis();
  Serial.println("🚀 Setup selesai — masuk loop 24/7\n");
}

// ═══════════════════════════════════════════════════════════
// LOOP
// ═══════════════════════════════════════════════════════════
void loop() {
  // ─── [1] Feed hardware watchdog ──────────────────────────
  esp_task_wdt_reset();

  // ─── [2] Cek & reconnect WiFi tiap 15 detik ──────────────
  if (millis() - lastWiFiCheckMs >= WIFI_CHECK_INTERVAL) {
    lastWiFiCheckMs = millis();
    reconnectWiFiIfNeeded();
  }

  // ─── [3] Restart stream jika koneksi putus ───────────────
  if (Firebase.ready() && !streamFbdo.httpConnected()) {
    Serial.println("🔄 Stream putus — restart...");
    lastStreamForceMs = millis();
    startStream();
  }

  // ─── [3b] Periodic stream force-restart tiap 3 menit ─────
  if (Firebase.ready() && millis() - lastStreamForceMs >= STREAM_FORCE_RESTART_MS) {
    lastStreamForceMs = millis();
    Serial.println("🔄 Periodic stream refresh...");
    startStream();
  }

  // ─── [4] Sync status relay ke Firebase ───────────────────
  if (statusPending) writeStatus();

  // ─── [5] Baca & kirim sensor tiap 3 detik ────────────────
  if (millis() - lastSensorMs >= SENSOR_INTERVAL) {
    lastSensorMs = millis();

    float suhu = NAN, kelembaban = NAN;
    for (int retry = 0; retry < 3 && (isnan(suhu) || isnan(kelembaban)); retry++) {
      if (retry > 0) delay(250);
      suhu       = dht.readTemperature();
      kelembaban = dht.readHumidity();
    }

    long sum = 0;
    for (int i = 0; i < 10; i++) { sum += analogRead(MQ135_AO); delay(2); }
    int   raw_gas = sum / 10;
    float ppm_nh3 = bacaNH3ppm(raw_gas);

    if (isnan(suhu) || isnan(kelembaban)) {
      Serial.println("⚠️ DHT gagal setelah 3x retry — skip kirim sensor.");
    } else {
      lastSuhu       = suhu;
      lastKelembaban = kelembaban;
      lastPpmNh3     = ppm_nh3;
      lastRawGas     = raw_gas;
      sensorValid    = true;

      if (Firebase.ready()) {
        sensorJson.clear();
        sensorJson.set("suhu",       suhu);
        sensorJson.set("kelembaban", kelembaban);
        sensorJson.set("gas_ppm",    ppm_nh3);
        sensorJson.set("gas_raw",    raw_gas);

        if (Firebase.RTDB.setJSON(&fbdo, "/sensor", &sensorJson)) {
          lastSuccessMs = millis();
        } else {
          Serial.println("❌ Gagal kirim sensor: " + fbdo.errorReason());
        }
      } else {
        Serial.println("⚠️ Firebase belum siap — skip kirim.");
      }

      Serial.printf("🌡️ %.1f°C  💧 %.1f%%  RAW:%d  NH3:%.2f ppm  [%s]\n",
        suhu, kelembaban, raw_gas, ppm_nh3, isManualMode ? "MANUAL" : "AUTO");

      if (!isManualMode) autoControl(suhu, ppm_nh3);
    }
  }

  // ─── [6] Simpan history ke Firestore tiap 5 detik ────────
  if (sensorValid && Firebase.ready() && millis() - lastHistoryMs >= HISTORY_INTERVAL) {
    lastHistoryMs = millis();

    char tsStr[25] = "";
    time_t now; time(&now);
    struct tm* utc = gmtime(&now);
    if (utc) strftime(tsStr, sizeof(tsStr), "%Y-%m-%dT%H:%M:%SZ", utc);

    histJson.clear();
    histJson.set("fields/timestamp/timestampValue", String(tsStr));
    histJson.set("fields/suhu/doubleValue",         lastSuhu);
    histJson.set("fields/kelembapan/doubleValue",   lastKelembaban);
    histJson.set("fields/amonia/doubleValue",       lastPpmNh3);
    histJson.set("fields/heater/stringValue",       heater  ? "ON" : "OFF");
    histJson.set("fields/intake/stringValue",       intake  ? "ON" : "OFF");
    histJson.set("fields/exhaust/stringValue",      exhaust ? "ON" : "OFF");

    if (!Firebase.Firestore.createDocument(&histFbdo, FIREBASE_PROJECT_ID, "(default)", "monitoring", histJson.raw())) {
      Serial.println("❌ Gagal simpan history Firestore: " + histFbdo.errorReason());
    }
  }

  // ─── [7] Monitor heap setiap 1 menit ─────────────────────
  if (millis() - lastHeapLogMs >= HEAP_LOG_INTERVAL) {
    lastHeapLogMs = millis();
    uint32_t freeHeap = ESP.getFreeHeap();
    Serial.printf("💾 Free heap: %u bytes | Uptime: %lu detik\n",
      freeHeap, millis() / 1000);

    if (freeHeap < HEAP_RESTART_THRESHOLD) {
      Serial.println("🚨 Heap kritis! Restart terkontrol...");
      delay(500);
      esp_restart();
    }
  }

  // ─── [8] Safety restart jika tidak
  //  berhasil kirim > 5 menit
  if (millis() - lastSuccessMs >= NO_SEND_RESTART_MS) {
    Serial.println("🚨 Tidak ada data terkirim 5 menit! Restart...");
    delay(500);
    esp_restart();
  }

  yield();
}
