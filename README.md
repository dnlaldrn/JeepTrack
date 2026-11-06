# JeepTrack — Implementation Guide for AI Agents

Real-time jeepney arrival tracker for the **Alangilan → Batangas City Grand Terminal** route.
Driver phones send GPS over **4G LTE (MQTT over TLS)**; in data dead zones they fall back to **GSM SMS**.
A server computes **ETAs per stop** and pushes them to a **commuter PWA** and a **terminal kiosk**.

Source of truth: `CS312-LA2 - JeepTrack Proposal.docx` (CS 312 Mobile Computing, BatStateU).
Final demo: **first week of December 2026**. Today's plan starts **Nov 6, 2026**.

---

## How to use this document (rules for the agent)

1. Work **one stage at a time, in order**. Do not start stage N+1 until every acceptance check in stage N passes.
2. Each stage ends with: tests passing, a short `docs/stage-N.md` note (what was built, how to run it, known gaps), and a git commit `stage N: <title>`.
3. Keep the build minimal. Do not add features beyond what this file lists (no fares, no seat sensing, no multi-route, no iOS app).
4. The wire format in **Stage 1** is a contract. Every component (Kotlin, Node.js, Python) must pass the same test vectors.
5. Never commit secrets. Use `.env` (gitignored) and an `.env.example` with placeholder values.
6. If something here is ambiguous or blocked (e.g., real stop coordinates), write it in `docs/open-questions.md` and use the stated fallback. Don't guess silently.

---

## Target numbers (from the proposal — the evaluation in Stage 10 checks these)

| ID | Requirement | Target |
|----|-------------|--------|
| R1 | Location reaches server + commuter app quickly (LTE) | ≤ 5 s end-to-end in ≥ 90% of reports |
| R2 | Reports continue in data dead zones | SMS fallback received ≤ 30 s in ≥ 90% of trials; 0 lost points after data returns |
| R3 | Session survives handoff / IP change | Reconnect ≤ 3 s; 0 duplicate points stored |
| R4 | Reports are authentic | 100% of bad-HMAC / non-TLS / bad-token reports rejected |
| —  | ETA accuracy | Mean absolute error ≤ 2 min |
| —  | Driver app battery | ≤ 8% per hour (screen off) |

---

## Architecture

```
Driver phone (Android) --4G LTE, MQTT/TLS--> Mosquitto broker --sub--> Node.js server --WebSocket--> Commuter PWA / Kiosk
        |                                                                ^
        +--GSM SMS (fallback)--> SMS gateway phone (Android) --HTTPS-----+
Simulator (Python) --MQTT/TLS--> Mosquitto broker   (test fleet of 10 virtual jeepneys)
Server <--> PostgreSQL + PostGIS
```

| Component | Tech | Folder |
|-----------|------|--------|
| Wire protocol + codecs | spec + JS/Python/Kotlin implementations | `protocol/` |
| Broker | Eclipse Mosquitto 2.x, MQTT 5, TLS 1.3, port 8883 | `infra/mosquitto/` |
| Database | PostgreSQL 16 + PostGIS (local Docker; Supabase optional for hosting) | `infra/db/` |
| Server | Node.js 20, Express, `mqtt`, `ws`, `pg` | `server/` |
| Simulator | Python 3.11, `paho-mqtt` | `simulator/` |
| Commuter PWA + kiosk | HTML/JS, Leaflet + OpenStreetMap | `web/` |
| Driver app | Android (Kotlin), minSdk 29, Fused Location, Paho MQTT, Room, SmsManager | `android/driver/` |
| SMS gateway app | Android (Kotlin), BroadcastReceiver + HTTPS | `android/gateway/` |
| Evaluation | Python scripts + notebooks | `eval/` |

Repository layout:

```
jeeptrack/
  README.md            <- this file
  docs/                <- stage notes, open questions
  protocol/            <- SPEC.md, test-vectors.json, js/, python/, kotlin/
  infra/               <- docker-compose.yml, mosquitto/, db/ (migrations, seed)
  data/                <- route.geojson, stops.csv, recorded GPS traces
  server/
  simulator/
  web/
  android/driver/  android/gateway/
  eval/
```

---

## Stage 0 — Repo and local infrastructure

**Goal:** one command brings up the broker and database locally.

Tasks
- Create the folder layout above, `.gitignore`, `.env.example`.
- `infra/docker-compose.yml` with:
  - `mosquitto` (eclipse-mosquitto:2): listener 8883 with TLS, `allow_anonymous false`, password file, ACL file. Also a plain 1883 listener bound to `127.0.0.1` **for local tests only**.
  - `db` (postgis/postgis:16-3.4) with a volume.
- Script `infra/gen-certs.sh` that makes a dev CA + server cert with `openssl` (CN = `localhost`, SAN includes the LAN IP so real phones can connect).
- Migration runner (plain SQL files in `infra/db/migrations/`, applied in order by `server/scripts/migrate.js`).

Acceptance
- `docker compose up -d` starts both services healthy.
- `mosquitto_pub` with TLS + valid user succeeds; with wrong password fails.
- `psql` can run `SELECT PostGIS_Version();`.

---

## Stage 1 — Wire protocol (the contract)

**Goal:** a single, tested binary format used by every component.

Write `protocol/SPEC.md` with exactly this format.

**Position report — 28 bytes, big-endian:**

| Offset | Size | Field | Type | Unit / notes |
|--------|------|-------|------|--------------|
| 0 | 1 | version | u8 | `1` |
| 1 | 2 | jeep_id | u16 | registered device ID |
| 3 | 4 | seq | u32 | per-device, +1 per GPS fix, never resets (persist on phone) |
| 7 | 4 | ts | u32 | Unix seconds (UTC) at GPS fix |
| 11 | 4 | lat | i32 | degrees × 1e7 |
| 15 | 4 | lon | i32 | degrees × 1e7 |
| 19 | 2 | speed | u16 | cm/s |
| 21 | 2 | heading | u16 | degrees × 100 (0–35999) |
| 23 | 2 | accuracy | u16 | decimeters (cap 65535) |
| 25 | 1 | flags | u8 | bit0 = from offline buffer, bit1 = simulated |
| 26 | 2 | crc | u16 | CRC-16/CCITT-FALSE over bytes 0–25 |

**MQTT**
- Topic: `jeeptrack/v1/jeep/{jeep_id}/pos` — payload = one 28-byte report.
- Batch topic: `jeeptrack/v1/jeep/{jeep_id}/batch` — payload = N concatenated reports (N ≤ 200).
- QoS 1. Client ID `jeep-{jeep_id}`. **Clean start = false, session expiry = 3600 s** (this is the Mobile IP "home address" idea: the broker keeps the session when the phone's IP changes).
- Auth: username `jeep-{jeep_id}`, password = device token. ACL: each device may only publish to its own topics.

**SMS fallback**
- Text: `JT1:<base64url(report)>:<base64url(hmac8)>` (54 chars unpadded, fits one 160-char SMS).
- `hmac8` = first 8 bytes of HMAC-SHA256(device_sms_key, report bytes).
- Gateway rejects: bad prefix, bad CRC, bad HMAC, unknown jeep_id, `ts` older than 15 min or > 2 min in the future.

Tasks
- Implement `encode/decode/crc16` + `smsEncode/smsDecode` in `protocol/js`, `protocol/python`, `protocol/kotlin`.
- `protocol/test-vectors.json`: ≥ 10 cases (normal, negative lat/lon, max values, flags set, corrupted CRC, bad HMAC). Each language runs them in its test suite.

Acceptance
- All three implementations pass all vectors (`npm test`, `pytest`, `./gradlew test`).
- Round-trip encode→decode is lossless within stated units.

---

## Stage 2 — Server ingest

**Goal:** server receives reports from MQTT and stores them exactly once.

Schema (`infra/db/migrations/001_init.sql`):

```sql
CREATE TABLE jeepneys (
  id         INT PRIMARY KEY,
  plate      TEXT NOT NULL,
  token_hash TEXT NOT NULL,      -- bcrypt of MQTT password
  sms_key    BYTEA NOT NULL,     -- HMAC key for SMS
  active     BOOLEAN DEFAULT TRUE
);
CREATE TABLE positions (
  jeep_id    INT REFERENCES jeepneys(id),
  seq        BIGINT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  geom       GEOGRAPHY(POINT, 4326) NOT NULL,
  speed_mps  REAL, heading_deg REAL, accuracy_m REAL,
  source     TEXT CHECK (source IN ('mqtt','batch','sms')),
  received_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (jeep_id, seq)     -- de-duplication (R3)
);
CREATE INDEX ON positions (jeep_id, ts DESC);
```

Tasks
- `server/src/ingest.js`: subscribe to `jeeptrack/v1/jeep/+/pos` and `+/batch` over TLS (server uses its own broker user with read ACL).
- Decode, verify CRC, check topic `jeep_id` == payload `jeep_id`, then `INSERT ... ON CONFLICT DO NOTHING`.
- Reject points with accuracy > 30 m from ETA use (still store them, flag `accuracy_m`).
- Emit an in-process event `position` for later stages.
- Structured logs (JSON) with counters: received, stored, duplicate, rejected.
- `server/scripts/add-jeep.js` to register a device and print its token + SMS key once.

Acceptance
- Integration test publishes 100 reports + 20 duplicates + 5 corrupted → exactly 100 rows stored, 5 rejected logged.
- Publishing to another device's topic is refused by the broker ACL.

---

## Stage 3 — Fleet simulator

**Goal:** test the whole system without 10 real jeepneys.

Tasks
- `data/route.geojson`: LineString of the route. `data/stops.csv`: `stop_id,name,lat,lon,order` (~15 stops).
  - **Fallback if the team hasn't supplied verified data:** trace the route from OpenStreetMap roads between BatStateU Alangilan and Batangas City Grand Terminal, mark every stop `verified=false`, and log it in `docs/open-questions.md`.
- `simulator/replay.py`:
  - Mode `synthetic`: moves N virtual jeepneys along the route with speeds 0–40 km/h, random dwell 10–60 s at stops, GPS noise σ = 5 m.
  - Mode `trace`: replays a recorded CSV (`ts,lat,lon,speed,heading,accuracy`) in real time or ×10 speed.
  - Options: `--jeeps 10 --interval 10 --dead-zone START_M:END_M` (stop publishing inside that stretch, buffer, then publish a batch on exit).
  - Sets `flags.bit1 = simulated`. Writes a ground-truth log (`eval/out/truth-*.csv`) with true arrival times at each stop.
- Seeds jeepneys 101–110 in the DB.

Acceptance
- `python replay.py --jeeps 10 --interval 10 --minutes 5` → ≈ 300 rows in `positions`, no duplicates, no rejects.
- Dead-zone run → after exit, all buffered points arrive with `source='batch'`, sequence has no gaps.

---

## Stage 4 — ETA engine and API

**Goal:** live ETAs per stop, served over REST and WebSocket.

Schema (`002_route.sql`): `route(id, geom GEOGRAPHY(LINESTRING))`, `stops(id, name, order_no, geom, route_m REAL)` where `route_m` = distance along the route (precompute with `ST_LineLocatePoint` × route length).

ETA algorithm (keep it simple, document it in `docs/eta.md`):
1. Map-match: project each new point onto the route → `route_m` (ignore if > 40 m from the line or accuracy > 30 m).
2. Split the route into segments between consecutive stops. Keep an EWMA (α = 0.3) of observed speed per segment from all jeepneys over the last 30 min; default 15 km/h if no data.
3. For a jeepney at `route_m = x`, ETA to each stop ahead = sum over remaining segment lengths ÷ segment EWMA speed + 20 s dwell per intermediate stop.
4. A jeepney with no update for 60 s is marked `stale` (show "last seen N min ago"); after 10 min it is hidden.

API (`server/src/api.js`):
- `GET /api/stops` → stops with coordinates.
- `GET /api/jeeps` → `[{jeep_id, lat, lon, route_m, speed, last_seen, stale}]`.
- `GET /api/etas?stop_id=…` → `[{jeep_id, eta_s, stale}]` sorted.
- `WS /ws` → server pushes `{"type":"pos", ...}` and `{"type":"eta", "stop_id":…, "etas":[…]}` on every update. Client may send `{"subscribe":{"stop_id":…}}`.
- `GET /healthz`.
- Server timestamps every push with `server_sent_at` (needed for latency measurement in Stage 10).

Acceptance
- Unit tests for map-matching and ETA math with hand-computed cases.
- With the simulator running, `/api/etas` returns values for every stop ahead of each jeep; ETA MAE against simulator ground truth ≤ 2 min over a 30-min synthetic run.

---

## Stage 5 — Commuter PWA and terminal kiosk

**Goal:** commuters see jeepneys and arrival times on any phone browser.

Tasks (`web/`, plain HTML/CSS/JS, no framework needed)
- `index.html`: Leaflet map with OSM tiles, route line, stop markers, live jeepney markers (gray if stale). Tap a stop → list "Jeep 104 — 3 min".
- "Nearest stop" button using browser Geolocation (optional for the user; works without it).
- WebSocket with auto-reconnect (exponential backoff 1 s → 30 s) and a visible "offline / reconnecting" banner — commuters also switch LTE ↔ Wi-Fi.
- `manifest.json` + service worker caching the app shell (not live data) so it loads on weak signal.
- `kiosk.html`: full-screen board for the Grand Terminal tablet: next 5 arrivals inbound/outbound, large text, auto-refresh, no interaction needed.
- Accessibility: readable at 360 px width, color is not the only stale indicator, text ≥ 16 px.

Acceptance
- With the simulator running, markers move and ETAs update without a page reload.
- Killing and restarting the server → banner shows, app reconnects by itself.
- Lighthouse PWA "installable" passes.

---

## Stage 6 — Driver Android app (LTE path)

**Goal:** a real phone in a jeepney reports its position every 10 s.

Tasks (`android/driver/`, Kotlin, minSdk 29)
- Setup screen: enter server host + jeep ID + token (or scan a QR printed by `add-jeep.js`). Store in EncryptedSharedPreferences.
- **Foreground service** with a persistent notification ("JeepTrack running"); start/stop button. Request location + notification permissions and battery-optimization exemption.
- Fused Location Provider: `PRIORITY_HIGH_ACCURACY`, interval 10 s, min distance 0.
- For each fix: increment persisted `seq`, encode with the Stage 1 Kotlin codec, publish QoS 1 to `.../pos`.
- Paho MQTT client: TLS (trust the dev CA bundled in the app for the prototype), clean start false, session expiry 3600, keepalive 60 s, automatic reconnect.
- Status screen: connection state, last fix, last ack, queue size.

Acceptance
- On a real phone over mobile data, points appear on the PWA within 5 s.
- App keeps reporting for 30 min with the screen off.

---

## Stage 7 — Offline buffer, batch upload, handoff

**Goal:** no point is lost when the connection drops or the IP changes (R2, R3).

Tasks
- Every report is first written to a Room table `outbox(seq PK, bytes, created_at, sent BOOLEAN)`, then published. Mark `sent` only after PUBACK.
- On reconnect: send unsent rows oldest-first on `.../batch` (≤ 200 per message), set `flags.bit0`.
- Listen to `ConnectivityManager.NetworkCallback`; on network change (LTE ↔ Wi-Fi, new IP) force an immediate reconnect instead of waiting for keepalive timeout.
- Prune sent rows older than 24 h.
- Add a **debug "simulate dead zone" switch** that blocks the MQTT client without airplane mode (for repeatable tests).

Acceptance
- 5-min forced outage → after reconnect, server has every `seq` in order, none duplicated.
- 20 LTE ↔ Wi-Fi toggles → median reconnect ≤ 3 s, 0 duplicate rows (verify via PK and logs).

---

## Stage 8 — GSM SMS fallback and gateway phone

**Goal:** the server still knows roughly where a jeepney is inside a data dead zone.

Driver app
- If no MQTT connection for **20 s**, send one SMS every **60 s** with the latest report (Stage 1 SMS format) to the gateway number set in setup. Requires `SEND_SMS` permission.
- Stop SMS as soon as MQTT reconnects; the full 10-s track still goes through the Stage 7 batch.
- Daily SMS cap (default 200) to avoid draining prepaid load.

Gateway app (`android/gateway/`)
- `BroadcastReceiver` for `SMS_RECEIVED`; parse `JT1:` messages only.
- POST raw text + sender number to `POST /api/sms-ingest` over HTTPS with a bearer token. Retry with backoff if offline; keep a local queue.

Server
- `/api/sms-ingest`: verify bearer token, decode, verify CRC + HMAC with the jeep's `sms_key`, check timestamp window, insert with `source='sms'` (same PK de-dup — the later batch copy is ignored).

Acceptance
- With driver data blocked, a fallback position is stored ≤ 30 s after sending in ≥ 9 of 10 tries.
- Forged SMS (wrong HMAC, replayed old ts, unknown jeep) → rejected and logged.

---

## Stage 9 — Security hardening

**Goal:** meet R4 and close obvious holes before the demo.

Checklist
- Broker: TLS only on public interfaces, no anonymous, per-device ACL (verified in Stage 2).
- Device tokens stored only as bcrypt hashes on the server; revocation = `active=false` + remove from Mosquitto password file (script `server/scripts/revoke-jeep.js`).
- Server: Helmet headers, CORS limited to the web origin, rate limit `/api/sms-ingest` (e.g., 30/min), input validation on all endpoints.
- No PII collected from commuters; geolocation stays in the browser.
- Wi-Fi at the terminal: document WPA2/WPA3 requirement in `docs/deploy.md`.
- Write `eval/security_test.py`: sends bad token, wrong-topic publish, plaintext connection attempt, bad CRC, bad HMAC, replayed SMS → asserts every one is rejected.

Acceptance
- `security_test.py` passes 100%.

---

## Stage 10 — Evaluation and demo

**Goal:** produce the numbers for the final presentation.

Scripts in `eval/` (each writes CSV to `eval/out/` and prints a pass/fail summary vs. targets):

| Metric | Script | Method | Target |
|--------|--------|--------|--------|
| Update latency | `latency.py` | Compare GPS `ts` vs. PWA receive time (PWA logs to `/api/telemetry` in eval mode; all devices NTP-synced). 300 reports, 3 phones, 3 real rides. | ≤ 5 s in ≥ 90% |
| Fallback delivery + loss | `fallback.py` | 20 dead-zone trials; SMS send → server receive; compare server seq set vs. phone outbox export. | ≤ 30 s in ≥ 90%; 0 lost |
| ETA accuracy | `eta_accuracy.py` | Predicted vs. actual arrival at 15 stops: 10 real trips + 50 simulated trips. | MAE ≤ 2 min |
| Battery | manual + `battery.md` | 2 h run, screen off, Battery Historian. | ≤ 8 %/h |
| Handoff recovery | `handoff.py` | 20 forced IP changes; reconnect time + duplicate count. | ≤ 3 s; 0 dupes |

Demo script (`docs/demo.md`)
1. Show the simulator fleet moving on the PWA and kiosk.
2. Ride/walk with a real phone; show its marker live.
3. Toggle the dead-zone switch → SMS fallback marker appears → toggle back → buffered track fills in.
4. Run `security_test.py` live.
5. Show the metrics table.

Acceptance
- All metrics computed and recorded in `docs/results.md`, with honest notes for any target missed.

---

## Schedule (from the proposal work plan)

| Stage(s) | Owner | Dates (2026) |
|----------|-------|--------------|
| 0–1 | All | Nov 6–11 |
| 2, 4 | Member 1 | Nov 12–20 |
| 6, 7 | Member 2 | Nov 12–20 |
| 3, 5 | Member 3 | Nov 12–22 |
| 8 | Member 2 + Member 1 | Nov 21–26 |
| 9 + field tests | All | Nov 23–29 |
| 10 | Member 3 leads | Nov 30–Dec 3 |
| Demo | All | ~Dec 4 |

**Priority if time runs short:** the LTE path end-to-end (Stages 0–6) must work by Nov 20. The kiosk (part of Stage 5) is optional.

---

## Known risks (carry into decisions)

- **GPS drift near buildings/terminal** → map-matching + accuracy filter (Stage 4).
- **SMS slow or costly** → 60-s rate, daily cap, measure real delay early in Stage 8.
- **Android kills background apps** (Doze, OEM savers) → foreground service + battery exemption; test on ≥ 2 phone brands.
- **Schedule (~4 weeks)** → strict stage gating; cut the kiosk before cutting tests.
