/*
  Crossing Mall — Smart Parking (ESP32)
  ======================================
  Talks straight to Supabase's REST API over HTTPS using the publishable
  key — no device login, no local server, nothing that breaks if your
  computer's IP changes. All the real logic (which gate a tap opens,
  checking gate-maintenance mode, logging, whether an emergency is active)
  lives in Postgres functions in supabase/schema.sql — fn_gate_tap,
  fn_set_slot, fn_check_emergency — called here as RPCs. The React web app
  reads the exact same tables directly, so both sides always agree on the
  current state.

  One shared RFID reader serves both boom gates. fn_gate_tap decides which
  one opens: if the card's owner has no 'active' parking session it's a
  check-in (entry gate), otherwise it's a check-out (exit gate, which also
  awards loyalty points) — and either way, a gate an admin has put into
  maintenance refuses to open. Three IR sensors report live bay occupancy.

  There's no physical flame/emergency sensor on this build — emergencies
  are triggered remotely from the Emergency button on the admin dashboard,
  which the ESP32 finds out about by polling fn_check_emergency() every
  EMERGENCY_POLL_MS. IMPORTANT TRADE-OFF: unlike a local sensor, this means
  the emergency response only works while the ESP32 has WiFi/Supabase
  reachability — if it's offline, pressing the dashboard button does
  nothing on the device side until connectivity returns. Clicking the same
  button again clears it, which the device also picks up on its next poll
  and closes both gates automatically.

  WiFi connects and reconnects in the background (never blocks RFID taps
  for more than one loop iteration) — see manageWifi().

  Wiring
  ------
  MFRC522 (RFID, SPI, 3.3V only):
    SDA/SS -> GPIO5      SCK  -> GPIO18
    RST    -> GPIO4      MOSI -> GPIO23
                          MISO -> GPIO19
    VCC -> 3.3V, GND -> GND

  16x2 LCD (I2C backpack, address 0x27 — change LCD_I2C_ADDR if yours differs):
    SDA -> GPIO21   SCL -> GPIO22   VCC -> 5V   GND -> GND

  Servos (boom gates, external 5V supply — do NOT power from the ESP32 5V pin):
    Entry gate signal -> GPIO14
    Exit  gate signal -> GPIO13
    (If a gate's movement feels weak/underpowered, that's almost always the
    external 5V supply, not this code — a servo under load can draw well
    over 1A in bursts. Give it its own supply rated for that, thick/short
    wires, and a shared ground with the ESP32. A supply that's borderline
    will show up as exactly this symptom: weak, jittery, or stalling moves.)

  IR obstacle sensors (digital out, one per bay):
    Bay P1 -> GPIO33   Bay P2 -> GPIO32   Bay P3 -> GPIO34
    (Set IR_ACTIVE_LOW below to match your modules — most output LOW when
    they detect an obstacle/car.)

  Buzzer (active buzzer module, digital):
    Signal -> GPIO26

  Status LEDs (each through a ~220-330 ohm resistor to GND):
    Green LED (gate open)   -> GPIO27
    Red   LED (gate closed) -> GPIO25

  Required libraries (Arduino IDE: Tools > Manage Libraries):
    - MFRC522 by GithubCommunity
    - ESP32Servo by Kevin Harrington / madhephaestus
    - LiquidCrystal_I2C by Frank de Brabander (or johnrickman fork)
    - ArduinoJson by Benoit Blanchon
*/

#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// CONFIG — edit these for your network / Supabase project
// ---------------------------------------------------------------------------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// From the Supabase dashboard (Project Settings > API) — same values as
// VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.
const char* SUPABASE_URL = "https://wvccevnmwzcqzbvujycv.supabase.co";
const char* SUPABASE_KEY = "sb_publishable_35T1UB8QF8bUQ47E5gPjFQ_0CtBRkBE";

const bool IR_ACTIVE_LOW = true; // true = sensor reads LOW when a car is present
const uint8_t LCD_I2C_ADDR = 0x27;

// ---------------------------------------------------------------------------
// PIN MAP
// ---------------------------------------------------------------------------
#define RFID_SS_PIN   5
#define RFID_RST_PIN  4

// Swapped from the original 13/14 assignment: the physical servo that was
// wired as "entry" is now driven as "exit" and vice versa.
#define SERVO_ENTRY_PIN 14
#define SERVO_EXIT_PIN  13

// Swapped from the original 32/33 assignment per on-site wiring.
#define IR_BAY1_PIN 33
#define IR_BAY2_PIN 32
#define IR_BAY3_PIN 34

#define BUZZER_PIN 26

#define LED_GREEN_PIN 27 // on while a gate is open
#define LED_RED_PIN   25 // on while both gates are closed

// Each gate's own open/closed angle — independently tunable, since two
// physical servo horns are rarely mounted at exactly the same orientation.
// Entry is set to match exit's angle (both look right at the same value).
const int EXIT_OPEN_ANGLE = 80;
const int EXIT_CLOSED_ANGLE = 0;
const int ENTRY_OPEN_ANGLE = EXIT_OPEN_ANGLE;
const int ENTRY_CLOSED_ANGLE = EXIT_CLOSED_ANGLE;
const unsigned long GATE_OPEN_MS = 5000;           // how long a gate stays open after a tap
const unsigned long CARD_WINDOW_MS = 10UL * 60000; // a tap "claims" the next IN event on any bay for this long

// ---------------------------------------------------------------------------
#define NSLOTS 3
const int IR_PINS[NSLOTS] = { IR_BAY1_PIN, IR_BAY2_PIN, IR_BAY3_PIN };
const char* SLOT_NAME[NSLOTS] = { "P1", "P2", "P3" };
const bool IR_ENABLED[NSLOTS] = { false, true, true };
const unsigned long IR_DEBOUNCE_MS = 500;
const unsigned long IR_SYNC_RETRY_MS = 5000;

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 16, 2);
Servo entryServo;
Servo exitServo;

bool bayOccupied[NSLOTS] = { false, false, false };
bool bayCandidate[NSLOTS] = { false, false, false };
bool bayReadingInitialized[NSLOTS] = { false, false, false };
bool bayNeedsSync[NSLOTS] = { true, true, true };
unsigned long bayCandidateSince[NSLOTS] = { 0, 0, 0 };
unsigned long bayLastSyncAt[NSLOTS] = { 0, 0, 0 };
String bayPendingCard[NSLOTS], bayPendingName[NSLOTS];

bool emergencyActive = false;
unsigned long entryGateOpenedAt = 0;
unsigned long exitGateOpenedAt = 0;
bool entryGateOpen = false;
bool exitGateOpen = false;

String lastCard = "", lastName = "";
unsigned long lastCardMs = 0;
unsigned long lastIdleLcdUpdate = 0;

// WiFi connection state — handled non-blockingly so a dropped network never
// freezes RFID taps.
bool wifiWasConnected = false;
unsigned long wifiAttemptStartedAt = 0;
unsigned long wifiLastAttemptAt = 0;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000; // give one attempt this long to succeed
const unsigned long WIFI_RETRY_INTERVAL_MS = 5000;   // then wait this long before trying again

// How often to ask Supabase whether an admin has hit the Emergency button.
unsigned long lastEmergencyCheckAt = 0;
const unsigned long EMERGENCY_POLL_MS = 2000;

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Crossing Mall Smart Parking boot ===");

  for (int i = 0; i < NSLOTS; i++) {
    if (!IR_ENABLED[i]) continue;
    // GPIO34 is input-only and has no internal pull-up.
    pinMode(IR_PINS[i], IR_PINS[i] == IR_BAY3_PIN ? INPUT : INPUT_PULLUP);
    bayCandidate[i] = IR_ACTIVE_LOW ? digitalRead(IR_PINS[i]) == LOW : digitalRead(IR_PINS[i]) == HIGH;
    bayCandidateSince[i] = millis();
  }
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  // Self-test: flash each LED on its own at boot, independent of any gate
  // logic — if one doesn't light here, it's a wiring/pin issue on the
  // board, not the gate-open code (which only ever writes the same way).
  Serial.println("LED self-test: green...");
  digitalWrite(LED_GREEN_PIN, HIGH); digitalWrite(LED_RED_PIN, LOW);
  delay(500);
  Serial.println("LED self-test: red...");
  digitalWrite(LED_GREEN_PIN, LOW); digitalWrite(LED_RED_PIN, HIGH);
  delay(500);
  updateStatusLeds(); // both gates start closed

  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Crossing Mall");
  lcd.setCursor(0, 1);
  lcd.print("Smart Parking");

  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(rfid.RxGain_max);
  byte rfidVersion = rfid.PCD_ReadRegister(rfid.VersionReg);
  Serial.printf("RFID reader version: 0x%02X\n", rfidVersion);
  if (rfidVersion == 0x00 || rfidVersion == 0xFF) {
    Serial.println("RFID NOT RESPONDING — check wiring (3.3V only) and SPI pins.");
  }

  entryServo.setPeriodHertz(50);
  exitServo.setPeriodHertz(50);
  entryServo.attach(SERVO_ENTRY_PIN, 500, 2400);
  exitServo.attach(SERVO_EXIT_PIN, 500, 2400);
  entryServo.write(ENTRY_CLOSED_ANGLE);
  exitServo.write(EXIT_CLOSED_ANGLE);

  // WIFI_STA (not the default AP+STA) and disabled modem sleep make the
  // ESP32's WiFi noticeably faster to connect and far less prone to
  // randomly dropping mid-session — the single biggest source of "WiFi
  // won't connect" reports on this chip.
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.disconnect(true, true);
  delay(100);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Connecting WiFi");
  startWifiAttempt();
  while (!wifiConnected() && millis() - wifiAttemptStartedAt < WIFI_CONNECT_TIMEOUT_MS) {
    delay(200);
  }
  reportWifiStatus();

  delay(1200);
  showIdleScreen();
}

void loop() {
  manageWifi();

  checkEmergencyState();

  if (emergencyActive) {
    pulseBuzzer();
    return;
  }

  checkIrSensors();
  checkRfidTap();
  autoCloseGates();

  if (millis() - lastIdleLcdUpdate > 3000 && !entryGateOpen && !exitGateOpen) {
    showIdleScreen();
    lastIdleLcdUpdate = millis();
  }
}

// ---------------------------------------------------------------------------
// WiFi — non-blocking connect/reconnect with status feedback
// ---------------------------------------------------------------------------
bool wifiConnected() { return WiFi.status() == WL_CONNECTED; }

void startWifiAttempt() {
  Serial.printf("Connecting to WiFi \"%s\"...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiAttemptStartedAt = millis();
  wifiLastAttemptAt = millis();
}

void reportWifiStatus() {
  if (wifiConnected()) {
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    showMessage("WiFi Connected!", WiFi.localIP().toString(), 1200);
    wifiWasConnected = true;
  } else {
    Serial.println("WiFi connect FAILED (check SSID/password; ESP32 needs a 2.4GHz network). Retrying in background.");
    showMessage("WiFi failed", "Retrying...", 1200);
  }
}

// Called every loop(). Starts/continues a connection attempt without ever
// blocking the main loop for more than one iteration.
void manageWifi() {
  if (wifiConnected()) {
    if (!wifiWasConnected) reportWifiStatus();
    return;
  }

  if (wifiWasConnected) {
    // We had a connection and lost it — the ESP32's WiFi stack auto-retries
    // on its own; just log it once and let manageWifi's own throttle below
    // decide if/when to force a fresh WiFi.begin().
    Serial.println("WiFi dropped — attempting to reconnect...");
    wifiWasConnected = false;
  }

  if (millis() - wifiLastAttemptAt < WIFI_RETRY_INTERVAL_MS) return; // don't hammer WiFi.begin()
  startWifiAttempt();
}

// Row 1: live bay status; P1 is always free, P2/P3 show sensor occupancy.
// Row 2: the entry prompt — "Tap your card to enter" is too long for a
// 16-column display, so it's shortened to fit exactly.
void showIdleScreen() {
  lcd.clear();
  lcd.setCursor(0, 0);
  for (int i = 0; i < NSLOTS; i++) {
    if (i) lcd.print(" ");
    lcd.print(SLOT_NAME[i]);
    lcd.print(":");
    lcd.print(!IR_ENABLED[i] || !bayOccupied[i] ? "F" : "P");
  }
  lcd.setCursor(0, 1);
  lcd.print("Tap card, enter!");
}

void showMessage(const String& line1, const String& line2, unsigned long holdMs) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
  delay(holdMs);
}

// ---------------------------------------------------------------------------
// RFID
// ---------------------------------------------------------------------------
void checkRfidTap() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  rfid.PICC_HaltA();

  showMessage("Checking card", uid, 300);

  String response;
  int httpCode = supabaseRpc("fn_gate_tap", String("{\"p_card\":\"") + uid + "\"}", response);

  if (httpCode != 200) {
    showMessage("Server error", "Try again", 2000);
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response) != DeserializationError::Ok) {
    showMessage("Bad response", "Try again", 2000);
    return;
  }

  bool ok = doc["ok"] | false;
  bool open = doc["open"] | false;
  const char* message = doc["message"] | "";
  const char* gate = doc["gate"] | "";
  const char* name = doc["name"] | "";

  if (!ok || !open) {
    beepShort();
    showMessage("Access denied", String(message), 2000);
    return;
  }

  bool isEntry = strcmp(gate, "entry") == 0;
  if (isEntry) {
    openEntryGate();
  } else {
    openExitGate();
  }

  // remember who just tapped, so the next bay that becomes occupied gets
  // credited to them in the logs (same CARD_WINDOW_MS pairing as before)
  lastCard = uid;
  lastName = String(name);
  lastCardMs = millis();

  showMessage(isEntry ? "Welcome" : "Goodbye", String(name), 2500);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
void openEntryGate() {
  entryServo.write(ENTRY_OPEN_ANGLE);
  entryGateOpen = true;
  entryGateOpenedAt = millis();
  updateStatusLeds();
}

void openExitGate() {
  exitServo.write(EXIT_OPEN_ANGLE);
  exitGateOpen = true;
  exitGateOpenedAt = millis();
  updateStatusLeds();
}

void autoCloseGates() {
  bool changed = false;
  if (entryGateOpen && millis() - entryGateOpenedAt > GATE_OPEN_MS) {
    entryServo.write(ENTRY_CLOSED_ANGLE);
    entryGateOpen = false;
    changed = true;
  }
  if (exitGateOpen && millis() - exitGateOpenedAt > GATE_OPEN_MS) {
    exitServo.write(EXIT_CLOSED_ANGLE);
    exitGateOpen = false;
    changed = true;
  }
  if (changed) updateStatusLeds();
}

// Green = a gate is open. Red = both gates closed (normal idle state).
void updateStatusLeds() {
  bool anyOpen = entryGateOpen || exitGateOpen;
  digitalWrite(LED_GREEN_PIN, anyOpen ? HIGH : LOW);
  digitalWrite(LED_RED_PIN, anyOpen ? LOW : HIGH);
}

// ---------------------------------------------------------------------------
// IR sensors / bay occupancy
// ---------------------------------------------------------------------------
void checkIrSensors() {
  bool changed = false;
  unsigned long now = millis();

  for (int i = 0; i < NSLOTS; i++) {
    if (!IR_ENABLED[i]) continue;
    int raw = digitalRead(IR_PINS[i]);
    bool occupied = IR_ACTIVE_LOW ? (raw == LOW) : (raw == HIGH);
    if (occupied != bayCandidate[i]) {
      bayCandidate[i] = occupied;
      bayCandidateSince[i] = now;
    }
    if (now - bayCandidateSince[i] < IR_DEBOUNCE_MS) continue;

    bool wasInitialized = bayReadingInitialized[i];
    bool stateChanged = wasInitialized && occupied != bayOccupied[i];
    if (!wasInitialized || stateChanged) {
      bayOccupied[i] = occupied;
      bayReadingInitialized[i] = true;
      bayNeedsSync[i] = true;
      if (stateChanged) changed = true;

      if (stateChanged && occupied && lastCard.length() && now - lastCardMs < CARD_WINDOW_MS) {
        bayPendingCard[i] = lastCard;
        bayPendingName[i] = lastName;
        lastCard = "";
      }

      Serial.printf("%s sensor GPIO%d raw=%d occupied=%s\n",
        SLOT_NAME[i], IR_PINS[i], raw, occupied ? "yes" : "no");
    }

    if (bayNeedsSync[i] &&
        (bayLastSyncAt[i] == 0 || now - bayLastSyncAt[i] >= IR_SYNC_RETRY_MS)) {
      String body = String("{\"p_slot\":\"") + SLOT_NAME[i] + "\",\"p_occupied\":" + (bayOccupied[i] ? "true" : "false");
      if (bayPendingCard[i].length()) {
        body += ",\"p_card\":\"" + bayPendingCard[i] + "\",\"p_name\":\"" + bayPendingName[i] + "\"";
      }
      body += "}";

      String response;
      int httpCode = supabaseRpc("fn_set_slot", body, response);
      bayLastSyncAt[i] = now;
      if (httpCode == 200) {
        bayNeedsSync[i] = false;
        bayPendingCard[i] = "";
        bayPendingName[i] = "";
      } else {
        Serial.printf("%s occupancy sync failed (HTTP %d); will retry\n", SLOT_NAME[i], httpCode);
      }
    }
  }

  // Refresh the LCD immediately on a real change — don't wait for the idle
  // screen's periodic timer — but never interrupt a welcome/goodbye message
  // or the emergency screen that's currently on display.
  if (changed && !entryGateOpen && !exitGateOpen && !emergencyActive) {
    showIdleScreen();
    lastIdleLcdUpdate = millis();
  }
}

// ---------------------------------------------------------------------------
// Emergency — triggered remotely from the admin dashboard's Emergency
// button (no local sensor), picked up here by polling fn_check_emergency().
// ---------------------------------------------------------------------------
void checkEmergencyState() {
  if (millis() - lastEmergencyCheckAt < EMERGENCY_POLL_MS) return;
  lastEmergencyCheckAt = millis();

  String response;
  int httpCode = supabaseRpc("fn_check_emergency", "{}", response);
  if (httpCode != 200) return; // offline or request failed — keep current state, try again next poll

  JsonDocument doc;
  if (deserializeJson(doc, response) != DeserializationError::Ok) return;
  bool active = doc["active"] | false;

  if (active && !emergencyActive) {
    emergencyActive = true;
    entryServo.write(ENTRY_OPEN_ANGLE);
    exitServo.write(EXIT_OPEN_ANGLE);
    entryGateOpen = true;
    exitGateOpen = true;
    updateStatusLeds();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("!! EMERGENCY !!");
    lcd.setCursor(0, 1);
    lcd.print("GATES OPEN");
  }

  if (!active && emergencyActive) {
    // Admin cleared it from the dashboard — safe to close both gates and
    // resume normal operation automatically.
    emergencyActive = false;
    digitalWrite(BUZZER_PIN, LOW);
    entryServo.write(ENTRY_CLOSED_ANGLE);
    exitServo.write(EXIT_CLOSED_ANGLE);
    entryGateOpen = false;
    exitGateOpen = false;
    updateStatusLeds();
    showIdleScreen();
  }
}

void pulseBuzzer() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(150);
  digitalWrite(BUZZER_PIN, LOW);
  delay(150);
}

void beepShort() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(120);
  digitalWrite(BUZZER_PIN, LOW);
}

// ---------------------------------------------------------------------------
// Supabase REST (PostgREST) helper — calls POST /rest/v1/rpc/<fn>
// ---------------------------------------------------------------------------
// setInsecure() skips certificate verification (encrypted, but not
// cert-pinned) to keep this simple on constrained hardware. Use
// client.setCACert() instead if you want full verification.
int supabaseRpc(const char* fnName, const String& jsonBody, String& responseOut) {
  if (WiFi.status() != WL_CONNECTED) {
    responseOut = "";
    return -1;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/rpc/" + fnName;
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.setTimeout(8000);

  int httpCode = http.POST(jsonBody);
  responseOut = http.getString();
  http.end();
  return httpCode;
}
