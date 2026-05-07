#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "DHT.h"
#include <math.h>
#include <esp_task_wdt.h>   // Hardware Watchdog Timer
#include <esp_system.h>     // esp_restart()

// ═══════════════════════════════════════════════════════════
// ─── WiFi ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
#define WIFI_SSID     "hem"
#define WIFI_PASSWORD "00000000"

// ─── Firebase ──────────────────────────────────────────────
#define DATABASE_URL    "mikroklimat-dod-default-rtdb.asia-southeast1.firebasedatabase.app"
#define DATABASE_SECRET "m4K8gPUF3YK21ZDzRvXERce8Ph1YweV4YfUE8uRr"

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
// Jika loop() tidak jalan selama 60 detik → ESP32 restart otomatis
#define WDT_TIMEOUT_S   60

// ─── Threshold heap minimum ────────────────────────────────
// Jika free heap < 40 KB → soft restart (cegah crash dari OOM)
#define HEAP_RESTART_THRESHOLD  40000   // bytes

// ─── Firebase objects (GLOBAL — tidak reallocate tiap loop) ─
// Membuat FirebaseJson di dalam loop menyebabkan heap fragmentation
// yang lama-lama bikin ESP32 crash setelah berjam-jam
FirebaseData    fbdo;        // kirim data sensor
FirebaseData    statusFbdo;  // kirim status relay
FirebaseData    streamFbdo;  // listen /control stream
FirebaseAuth    auth;
FirebaseConfig  config;
FirebaseJson    sensorJson;  // ← GLOBAL: reallocate nol kali

// ─── State relay ───────────────────────────────────────────
volatile bool heater       = false;
volatile bool intake       = false;
volatile bool exhaust      = false;
volatile bool isManualMode = false;
volatile bool statusPending = false;

bool lastWrittenHeater  = false;
bool lastWrittenIntake  = false;
bool lastWrittenExhaust = false;

// ─── Timers ────────────────────────────────────────────────
unsigned long lastSensorMs     = 0;
unsigned long lastWiFiCheckMs  = 0;
unsigned long lastHeapLogMs    = 0;
unsigned long lastSuccessMs    = 0;   // terakhir kali kirim sensor berhasil

const unsigned long SENSOR_INTERVAL      = 3000;   // kirim sensor tiap 3 detik
const unsigned long WIFI_CHECK_INTERVAL  = 15000;  // cek WiFi tiap 15 detik
const unsigned long HEAP_LOG_INTERVAL    = 60000;  // log heap tiap 1 menit
const unsigned long NO_SEND_RESTART_MS   = 300000; // restart jika 5 menit tidak berhasil kirim

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
    esp_task_wdt_reset(); // feed WDT selama kalibrasi panjang
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
  WiFi.disconnect(true);
  delay(500);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    esp_task_wdt_reset(); // feed WDT selama tunggu WiFi
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

// applyGPIO: tulis pin langsung — TIDAK ada Firebase call
// Aman dipanggil dari FreeRTOS stream callback
void applyGPIO() {
  digitalWrite(HEATER_PIN,  heater  ? RELAY_ON : RELAY_OFF);
  digitalWrite(INTAKE_PIN,  intake  ? RELAY_ON : RELAY_OFF);
  digitalWrite(EXHAUST_PIN, exhaust ? RELAY_ON : RELAY_OFF);
  statusPending = true; // loop utama akan sync ke Firebase
}

// writeStatus: hanya dari loop utama, hanya field yang berubah
// Gunakan statusFbdo agar tidak konflik dengan fbdo sensor
void writeStatus() {
  if (!Firebase.ready()) return;
  statusPending = false;
  bool h = heater, i = intake, e = exhaust;
  if (h != lastWrittenHeater)  { Firebase.RTDB.setString(&statusFbdo, "/status/heater",  h ? "ON" : "OFF"); lastWrittenHeater  = h; }
  if (i != lastWrittenIntake)  { Firebase.RTDB.setString(&statusFbdo, "/status/intake",  i ? "ON" : "OFF"); lastWrittenIntake  = i; }
  if (e != lastWrittenExhaust) { Firebase.RTDB.setString(&statusFbdo, "/status/exhaust", e ? "ON" : "OFF"); lastWrittenExhaust = e; }
  Serial.printf("📤 Status → H:%s I:%s E:%s\n", h?"ON":"OFF", i?"ON":"OFF", e?"ON":"OFF");
}

// autoControl: hanya apply jika ada perubahan
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
// Stream callback — dipanggil saat /control berubah di Firebase
// Berjalan di FreeRTOS task TERPISAH dari loop()
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

// ═══════════════════════════════════════════════════════════
// Mulai stream /control (helper agar mudah dipanggil ulang)
// ═══════════════════════════════════════════════════════════
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
  // Jika loop() tidak memanggil esp_task_wdt_reset() dalam 60 detik
  // → ESP32 restart otomatis (proteksi dari hang)
  // ESP32 Arduino core v3.x (IDF v5.x) mengubah API esp_task_wdt_init()
  // dari (timeout, panic) menjadi (const esp_task_wdt_config_t*)
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  const esp_task_wdt_config_t wdt_config = {
    .timeout_ms     = WDT_TIMEOUT_S * 1000,  // dalam millisecond
    .idle_core_mask = 0,                      // tidak monitor idle task
    .trigger_panic  = true,                   // panic (restart) saat timeout
  };
  esp_task_wdt_init(&wdt_config);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);    // API lama (core v2.x)
#endif
  esp_task_wdt_add(NULL); // daftarkan task loop() ke WDT
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
  // Cegah alokasi heap besar yang menyebabkan fragmentation
  fbdo.setResponseSize(1024);
  statusFbdo.setResponseSize(512);

  // ── Warm-up MQ135 ────────────────────────────────────────
  Serial.print("Warm-up MQ135");
  for (int i = 20; i > 0; i--) {
    Serial.print(".");
    esp_task_wdt_reset(); // feed WDT tiap detik selama warm-up
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
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    esp_task_wdt_reset();
    delay(500);
  }
  Serial.println(" OK → " + WiFi.localIP().toString());

  // ── Firebase ─────────────────────────────────────────────
  config.database_url = DATABASE_URL;
  config.signer.tokens.legacy_token = DATABASE_SECRET;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true); // Firebase ikut reconnect saat WiFi pulih

  Serial.print("Menunggu Firebase");
  unsigned long t0 = millis();
  while (!Firebase.ready() && millis() - t0 < 10000) {
    Serial.print(".");
    esp_task_wdt_reset();
    delay(200);
  }
  Serial.println();

  if (Firebase.ready()) {
    Firebase.RTDB.setString(&fbdo, "/control/mode", "auto");
    Serial.println("✅ Mode default 'auto' ditulis");
  } else {
    Serial.println("⚠️ Firebase belum siap saat setup — akan retry di loop");
  }

  // ── Mulai stream ─────────────────────────────────────────
  startStream();

  // ── Init timer ───────────────────────────────────────────
  lastSuccessMs = millis();
  Serial.println("🚀 Setup selesai — masuk loop 24/7\n");
}

// ═══════════════════════════════════════════════════════════
// LOOP
// ═══════════════════════════════════════════════════════════
void loop() {
  // ─── [1] Feed hardware watchdog ──────────────────────────
  // Wajib dipanggil tiap iterasi — jika tidak dipanggil 60 detik → restart
  esp_task_wdt_reset();

  // ─── [2] Cek & reconnect WiFi tiap 15 detik ──────────────
  if (millis() - lastWiFiCheckMs >= WIFI_CHECK_INTERVAL) {
    lastWiFiCheckMs = millis();
    reconnectWiFiIfNeeded();
  }

  // ─── [3] Restart stream jika koneksi putus ───────────────
  if (Firebase.ready() && !streamFbdo.httpConnected()) {
    Serial.println("🔄 Stream putus — restart...");
    startStream();
  }

  // ─── [4] Sync status relay ke Firebase jika ada perubahan ─
  if (statusPending) writeStatus();

  // ─── [5] Baca & kirim sensor tiap 3 detik ────────────────
  if (millis() - lastSensorMs >= SENSOR_INTERVAL) {
    lastSensorMs = millis();

    // ── DHT22: baca dengan retry maks 3x ──
    float suhu = NAN, kelembaban = NAN;
    for (int retry = 0; retry < 3 && (isnan(suhu) || isnan(kelembaban)); retry++) {
      if (retry > 0) delay(250); // beri jeda sebelum retry
      suhu       = dht.readTemperature();
      kelembaban = dht.readHumidity();
    }

    // ── MQ135: 10-sample averaging ──
    long sum = 0;
    for (int i = 0; i < 10; i++) { sum += analogRead(MQ135_AO); delay(2); }
    int   raw_gas = sum / 10;
    float ppm_nh3 = bacaNH3ppm(raw_gas);

    if (isnan(suhu) || isnan(kelembaban)) {
      Serial.println("⚠️ DHT gagal setelah 3x retry — skip kirim sensor.");
    } else {
      // ── Kirim semua sensor dalam 1 JSON request ──
      if (Firebase.ready()) {
        sensorJson.clear();                        // hapus isi sebelumnya (objek global)
        sensorJson.set("suhu",       suhu);
        sensorJson.set("kelembaban", kelembaban);
        sensorJson.set("gas_ppm",    ppm_nh3);
        sensorJson.set("gas_raw",    raw_gas);

        if (Firebase.RTDB.setJSON(&fbdo, "/sensor", &sensorJson)) {
          lastSuccessMs = millis(); // catat waktu kirim berhasil
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

  // ─── [6] Monitor heap setiap 1 menit ─────────────────────
  if (millis() - lastHeapLogMs >= HEAP_LOG_INTERVAL) {
    lastHeapLogMs = millis();
    uint32_t freeHeap = ESP.getFreeHeap();
    Serial.printf("💾 Free heap: %u bytes | Uptime: %lu detik\n",
      freeHeap, millis() / 1000);

    // Jika heap kritis → restart terkontrol sebelum crash
    if (freeHeap < HEAP_RESTART_THRESHOLD) {
      Serial.println("🚨 Heap kritis! Restart terkontrol...");
      delay(500);
      esp_restart();
    }
  }

  // ─── [7] Safety restart jika tidak berhasil kirim > 5 menit ─
  // Menangani kasus WiFi/Firebase stuck yang tidak terdeteksi reconnect
  if (millis() - lastSuccessMs >= NO_SEND_RESTART_MS) {
    Serial.println("🚨 Tidak ada data terkirim 5 menit! Restart...");
    delay(500);
    esp_restart();
  }

  // ─── yield: beri giliran FreeRTOS task lain ──────────────
  yield();
}
