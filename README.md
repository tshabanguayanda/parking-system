# Crossing Mall — Smart Parking (React + Supabase + ESP32)

Two sides, synced in real time through Supabase (Postgres + Realtime):

| Driver portal | Admin control dashboard |
| --- | --- |
| Register an RFID card (name + card UID) | Live bays: which are occupied/free, who's in each one |
| Tap to enter, tap to leave — no booking, no app needed on site | Live RFID detections: every card tap, matched to a driver |
| Live "You're parked" timer while checked in | Sessions table: every visit, entry/exit time, points earned |
| **Loyalty points + discount** for every completed visit | Drivers & cards, activity log, a day-by-day in/out chart |
| History of past visits | **Gate maintenance** toggle + an **Emergency** button that forces both gates open |

Who sees what: an account whose `profiles.role` is `admin` gets the admin dashboard.
Every other account gets the driver portal.

## How it works

1. A driver signs up, then registers their RFID card (name + card UID) on the driver portal.
2. At the car park, they tap their card at the one shared reader. The ESP32 calls
   `fn_gate_tap`, which looks up the card, decides whether to open the **entry** or **exit**
   gate (entry if they have no currently-active session, exit if they do), and refuses if an
   admin has put that gate into maintenance. Either way it logs the tap to `rfid`,
   `card_taps` and `taps` — the admin sees it immediately in **Live RFID detections**.
3. First tap: `fn_gate_tap` opens the entry gate and starts a `parking_sessions` row
   (`status = 'active'`). The driver's portal shows a live "You're parked" timer.
4. An IR sensor sees the car and the ESP32 calls `fn_set_slot`, which upserts
   `sensors.occupied = true` for that bay — this is purely the live occupancy display, not
   what starts or stops the timer.
5. Second tap (same card): `fn_gate_tap` opens the exit gate, closes the session
   (`status = 'completed'`, records the duration), and awards **+10 loyalty points** to the
   driver's profile — all inside the same database function, so it's correct even with no
   client open.

## Run it

```sh
npm install
npm run dev
```

## Supabase setup (once)

1. **Run the schema.** Open your project's SQL Editor and run every statement in
   [`supabase/schema.sql`](supabase/schema.sql). It creates the tables, Row Level Security
   policies, and the hardware RPCs the ESP32 calls
   (`fn_gate_tap`/`fn_set_slot`/`fn_check_emergency`). Safe to re-run.
2. **Add your client env vars.** `.env.local` (gitignored, already filled in for this
   project's Supabase instance):
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```
   Both are in Project Settings → API.
3. **Make an admin.** Sign up in the app (`Ayandacse@gmail.com`), then from a trusted
   terminal (needs the secret **service_role** key from Project Settings → API — never
   commit it):
   ```sh
   SUPABASE_URL=https://your-project.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
     npm run grant-admin -- Ayandacse@gmail.com
   ```
   Sign out and back in. You'll now get the admin dashboard.

   The ESP32 needs **no account at all** — it calls `fn_gate_tap`/`fn_set_slot`/
   `fn_check_emergency` with just the publishable key, and those functions do their
   privileged reads/writes internally (`security definer`). No device login step.

## ESP32 firmware

`firmware/smart_parking_esp32/smart_parking_esp32.ino`. One RC522 reader shared by two
boom gates (independently tunable open/closed angles per gate), three IR obstacle sensors
(one per bay), a buzzer, two status LEDs, and a 16x2 I2C LCD. Talks to Supabase's REST API
(PostgREST) over HTTPS — see the wiring diagram and pin map in the sketch's header comment.

* Libraries: **MFRC522**, **ArduinoJson** (v7.x), **ESP32Servo**, **LiquidCrystal_I2C**.
  `HTTPClient`/`WiFiClientSecure` ship with the ESP32 board core — no extra HTTP/TLS library.
* Fill in `WIFI_SSID`/`WIFI_PASSWORD`. `SUPABASE_URL`/`SUPABASE_KEY` already match
  `.env.local`. Check `IR_ACTIVE_LOW` against your specific sensor modules (test with Serial
  output if unsure). The firmware requires readings to stay stable for 500 ms before
  changing a bay's status, syncs the stable state on startup, and retries failed Supabase
  updates. Only P2's sensor is enabled and uses the ESP32's internal pull-up. P1 (GPIO33)
  and P3 (GPIO34) are intentionally treated as always empty/available: their sensors are
  not read, the dashboard ignores stored values, and the ESP32 LCD shows `F` for both.
  Update only the `fn_set_slot` definition in Supabase to ignore P1 and P3 writes from
  older firmware; do not rerun the full schema file just for this change.
* Update the `fn_set_slot` function in the Supabase SQL Editor and flash the updated
  sketch to the ESP32.
* Open the Serial Monitor at 115200 baud: every card shows as e.g. `Card Detected: 04A1B2C3`.
  That is the number a driver enters when registering their card.
* The sketch calls `client.setInsecure()` to skip TLS certificate validation, which keeps
  the code simple on constrained hardware — standard practice for small ESP32 sketches, but
  worth knowing if you're hardening this for a real deployment.
* A card that isn't registered to anyone gets "Access denied — Unknown card" on the LCD and
  neither gate opens.
* **Power the servos from a separate 5V supply**, not the ESP32's own 5V pin — a stalled
  servo browning out the board is the #1 cause of flaky RFID reads (and of a gate that
  "feels weak") on this kind of build.
* **No physical emergency sensor** — there's an **Emergency** button on the admin dashboard
  instead. The ESP32 finds out about it by polling `fn_check_emergency` every 2 seconds
  (`EMERGENCY_POLL_MS`), not from a local sensor. **This means the emergency response only
  works while the device has WiFi/Supabase reachability** — if it's offline, clicking the
  dashboard button does nothing on-site until connectivity returns. Clicking the button
  again clears it; the device picks that up on its next poll and closes both gates
  automatically.

Data the ESP32 writes/reads (all through the RPCs below — never direct table access):

```
fn_gate_tap(card)                       -> writes rfid, card_taps, taps, parking_sessions, profiles.points
fn_set_slot(slot, occupied, card, name) -> writes sensors, logs (type: IN|OUT)
fn_check_emergency()                    -> reads whether an admin-triggered flame_alerts row is unresolved
```

## Bays

The bays are `P1`, `P2`, `P3` (`PARKING_SLOTS` in `src/seed.js`). To add a bay, add it
there, wire up another IR sensor, and add its pin to `IR_PINS`/`SLOT_NAME` in the firmware.

## Loyalty points & gate maintenance

- **Points**: `fn_gate_tap` (in `schema.sql`) adds `POINTS_PER_VISIT` (10) to
  `profiles.points` the moment a driver's exit tap closes their session. `discountFor()` in
  `src/lib.js` turns that into a percentage (every 100 points = +10% off, capped at 50%) and
  a Rand value (R0.50/point) — shown on the driver portal under "Your rewards". Change the
  constants in both places (they're intentionally not derived from one another, since the
  device must work with no server running) if you want a different scheme.
- **Gate maintenance**: the admin dashboard's "Gate maintenance" card toggles
  `boom_gates.maintenance` for the entry/exit gate. `fn_gate_tap` refuses to open a gate
  under maintenance — enforced in the database, so it can't be bypassed by the device.
- **Emergency button**: when there's no active emergency, the dashboard shows a red
  "Trigger emergency" button (with a confirm prompt) that inserts a `flame_alerts` row —
  that's the entire signal. The ESP32 picks it up on its next poll (≤2s) and forces both
  gates open with the buzzer sounding; the banner then shows "Clear emergency" to end it.

  See [ESP32 firmware](#esp32-firmware) above for the important caveat: this only works
  while the device is online, since there's no local sensor anymore to fall back on.

## Files

```
src/App.jsx             sign in / sign up, and the admin or driver view by role
src/UserPortal.jsx      driver portal (register card, parking timer, rewards, history)
src/AdminDashboard.jsx  admin dashboard (bays, RFID feed, sessions, drivers, activity log)
src/lib.js              formatting helpers, points/discount formula
src/ui.jsx              shared pieces (live data hooks, toasts, top bar)
src/supabase.js         Supabase client
supabase/schema.sql     Postgres schema, Row Level Security policies, RPCs
scripts/grant-role.js   grant the admin role (needs the service_role key)
firmware/…              ESP32 sketch
```
