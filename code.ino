#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "DHT.h"
#include <math.h>

// ─── WiFi ─────────────────────────────────────────────────
#define WIFI_SSID     "hem"
#define WIFI_PASSWORD "00000000"

// ─── Firebase ─────────────────────────────────────────────
#define DATABASE_URL    "mikroklimat-dod-default-rtdb.asia-southeast1.firebasedatabase.app"
#define DATABASE_SECRET "m4K8gPUF3YK21ZDzRvXERce8Ph1YweV4YfUE8uRr"

// ─── DHT22 ────────────────────────────────────────────────
#define DHTPIN  4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// ─── MQ135 ────────────────────────────────────────────────
#define MQ135_AO         34
#define RL_VALUE         10.0f    // Load resistance modul (kΩ)
#define VCC_SENSOR       5.0f    // VCC sensor (dari VIN ESP32)
#define ADC_VREF         3.3f    // ESP32 ADC reference
#define ADC_RESOLUTION   4095.0f // 12-bit ADC
#define CLEAN_AIR_FACTOR 3.6f    // Rs/Ro di udara bersih (datasheet MQ135)
#define NH3_A            102.2f  // Koefisien kurva NH3
#define NH3_B            -2.473f

// Kalibrasi:
//   1. Set MODE_KALIBRASI = true, upload, taruh sensor di udara bersih
//   2. Catat nilai Ro dari Serial Monitor (tunggu 60 detik)
//   3. Masukkan ke RO_CALIBRATED, set MODE_KALIBRASI = false, upload ulang
#define MODE_KALIBRASI  false
#define RO_CALIBRATED   10.0f   // ← GANTI dengan hasil kalibrasi kamu
float Ro = RO_CALIBRATED;

// ─── Relay (active LOW) ───────────────────────────────────
#define HEATER_PIN  25
#define INTAKE_PIN  26
#define EXHAUST_PIN 33
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// ─── Firebase objects ─────────────────────────────────────
// Dua objek terpisah: fbdo untuk write, streamFbdo untuk stream
// Mencegah konflik saat loop tulis sensor bersamaan dengan stream
FirebaseData fbdo;
FirebaseData streamFbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ─── State relay ──────────────────────────────────────────
// volatile: agar compiler tidak cache nilai — diakses dari 2 FreeRTOS task
volatile bool heater       = false;
volatile bool intake       = false;
volatile bool exhaust      = false;
volatile bool isManualMode = false;
volatile bool statusPending = false;

// Hanya tulis ke Firebase jika ada perubahan — cegah write berulang
bool lastWrittenHeater  = false;
bool lastWrittenIntake  = false;
bool lastWrittenExhaust = false;

// ─── Timer ────────────────────────────────────────────────
unsigned long lastSensorMs  = 0;
const unsigned long SENSOR_INTERVAL = 2000;

// ════════════════════════════════════════════════════════════
// MQ135
// ════════════════════════════════════════════════════════════

float hitungRs(int raw_adc) {
  if (raw_adc <= 0) return 999999.0f;
  float v_adc = (raw_adc / ADC_RESOLUTION) * ADC_VREF;
  if (v_adc <= 0.01f) return 999999.0f;
  // Rs = ((Vcc - Vout) / Vout) * RL
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

// ════════════════════════════════════════════════════════════
// Relay & Status
// ════════════════════════════════════════════════════════════

// applyGPIO: tulis pin langsung — TIDAK ada Firebase call
// Aman dipanggil dari FreeRTOS stream callback
void applyGPIO() {
  digitalWrite(HEATER_PIN,  heater  ? RELAY_ON : RELAY_OFF);
  digitalWrite(INTAKE_PIN,  intake  ? RELAY_ON : RELAY_OFF);
  digitalWrite(EXHAUST_PIN, exhaust ? RELAY_ON : RELAY_OFF);
  statusPending = true; // loop utama akan sync ke Firebase
}

// writeStatus: hanya dari loop utama, hanya field yang berubah
void writeStatus() {
  if (!Firebase.ready()) return;
  statusPending = false; // clear SEBELUM write agar update baru tidak hilang
  bool h = heater, i = intake, e = exhaust;
  if (h != lastWrittenHeater)  { Firebase.RTDB.setString(&fbdo, "/status/heater",  h ? "ON" : "OFF"); lastWrittenHeater  = h; }
  if (i != lastWrittenIntake)  { Firebase.RTDB.setString(&fbdo, "/status/intake",  i ? "ON" : "OFF"); lastWrittenIntake  = i; }
  if (e != lastWrittenExhaust) { Firebase.RTDB.setString(&fbdo, "/status/exhaust", e ? "ON" : "OFF"); lastWrittenExhaust = e; }
  Serial.printf("📤 Status → H:%s I:%s E:%s\n", h?"ON":"OFF", i?"ON":"OFF", e?"ON":"OFF");
}

// autoControl: hanya apply jika ada perubahan (hemat write Firebase)
void autoControl(float suhu, float ppm_nh3) {
  bool newHeater  = (suhu < 32.0f);
  bool newIntake  = (suhu > 35.0f) || (ppm_nh3 > 25.0f);
  bool newExhaust = (suhu > 35.0f) || (ppm_nh3 > 25.0f);

  if (newHeater != (bool)heater || newIntake != (bool)intake || newExhaust != (bool)exhaust) {
    heater  = newHeater;
    intake  = newIntake;
    exhaust = newExhaust;
    applyGPIO();
    Serial.println("🤖 AUTO relay berubah");
  }
}

// ════════════════════════════════════════════════════════════
// Stream callback — dipanggil saat /control berubah di Firebase
// Berjalan di FreeRTOS task TERPISAH dari loop()
// ════════════════════════════════════════════════════════════
void onControlStream(FirebaseStream data) {
  String path = data.dataPath();
  String type = data.dataType();

  if (type == "json") {
    // Snapshot awal: Firebase kirim seluruh /control sebagai JSON saat connect
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

// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== ESP32 MIKROKLIMAT DOD ===");

  // ADC: resolusi 12-bit + atenuasi 11dB (range 0–3.3V)
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // Sensor
  dht.begin();

  // Relay — semua OFF saat boot
  pinMode(HEATER_PIN,  OUTPUT); digitalWrite(HEATER_PIN,  RELAY_OFF);
  pinMode(INTAKE_PIN,  OUTPUT); digitalWrite(INTAKE_PIN,  RELAY_OFF);
  pinMode(EXHAUST_PIN, OUTPUT); digitalWrite(EXHAUST_PIN, RELAY_OFF);

  // Warm-up MQ135 (20 detik)
  Serial.print("Warm-up MQ135");
  for (int i = 20; i > 0; i--) { Serial.print("."); delay(1000); }
  Serial.println(" OK");

  // Kalibrasi (jika MODE_KALIBRASI = true)
  if (MODE_KALIBRASI) {
    Ro = kalibrasiRo();
  } else {
    Serial.printf("Pakai Ro = %.4f kΩ\n", Ro);
  }

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { Serial.print("."); delay(500); }
  Serial.println(" OK → " + WiFi.localIP().toString());

  // Firebase
  config.database_url = DATABASE_URL;
  config.signer.tokens.legacy_token = DATABASE_SECRET;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // Tunggu Firebase siap (maks 5 detik)
  Serial.print("Menunggu Firebase");
  unsigned long t0 = millis();
  while (!Firebase.ready() && millis() - t0 < 5000) { Serial.print("."); delay(200); }
  Serial.println();

  if (Firebase.ready()) {
    Firebase.RTDB.setString(&fbdo, "/control/mode", "auto");
    Serial.println("✅ Mode default 'auto' ditulis");
  }

  // Mulai stream /control
  if (!Firebase.RTDB.beginStream(&streamFbdo, "/control")) {
    Serial.println("❌ Stream gagal: " + streamFbdo.errorReason());
  } else {
    Firebase.RTDB.setStreamCallback(&streamFbdo, onControlStream, onStreamTimeout);
    Serial.println("✅ Stream /control aktif");
  }
}

// ════════════════════════════════════════════════════════════
void loop() {
  // Restart stream jika koneksi putus
  if (!streamFbdo.httpConnected() && Firebase.ready()) {
    Serial.println("🔄 Restart stream...");
    Firebase.RTDB.beginStream(&streamFbdo, "/control");
    Firebase.RTDB.setStreamCallback(&streamFbdo, onControlStream, onStreamTimeout);
  }

  // Sync relay status ke Firebase jika ada perubahan
  if (statusPending) writeStatus();

  // Baca & kirim sensor tiap SENSOR_INTERVAL
  if (millis() - lastSensorMs >= SENSOR_INTERVAL) {
    lastSensorMs = millis();

    float suhu       = dht.readTemperature();
    float kelembaban = dht.readHumidity();

    // 10-sample averaging untuk stabilitas ADC ESP32
    long sum = 0;
    for (int i = 0; i < 10; i++) { sum += analogRead(MQ135_AO); delay(5); }
    int   raw_gas = sum / 10;
    float ppm_nh3 = bacaNH3ppm(raw_gas);

    if (isnan(suhu) || isnan(kelembaban)) {
      Serial.println("⚠️ Gagal baca DHT!");
    } else {
      if (Firebase.ready()) {
        Firebase.RTDB.setFloat(&fbdo, "/sensor/suhu",       suhu);
        Firebase.RTDB.setFloat(&fbdo, "/sensor/kelembaban", kelembaban);
        Firebase.RTDB.setFloat(&fbdo, "/sensor/gas_ppm",    ppm_nh3);
        Firebase.RTDB.setInt(&fbdo,   "/sensor/gas_raw",    raw_gas);
      }

      Serial.printf("🌡️ %.1f°C  💧 %.1f%%  RAW:%d  NH3:%.2f ppm  [%s]\n",
        suhu, kelembaban, raw_gas, ppm_nh3, isManualMode ? "MANUAL" : "AUTO");

      if (!isManualMode) autoControl(suhu, ppm_nh3);
    }
  }

  // yield: beri giliran FreeRTOS task lain (stream, WiFi stack)
  yield();
}
