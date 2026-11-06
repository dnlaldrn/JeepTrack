# JeepTrack Stages 0–5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working LTE-path backend for JeepTrack — broker + DB, a 28-byte wire protocol in JS/Python/Kotlin, MQTT ingest with de-dup, a simulated 10-jeep fleet, a live ETA engine/API, and a commuter PWA + kiosk.

**Architecture:** Docker Compose runs Mosquitto (TLS 8883 + test-only plain 127.0.0.1:1883) and PostGIS. A single Node server process subscribes to MQTT, stores positions, keeps ETA state in memory, and serves REST + WebSocket + the static PWA. A Python simulator publishes the fake fleet using the shared protocol.

**Tech Stack:** Docker, eclipse-mosquitto:2, postgis/postgis:16-3.4, Node 24 (ESM, `node:test`, express, mqtt, ws, pg, bcryptjs), Python 3.13 (paho-mqtt 2.x, pytest), Kotlin/JVM + Gradle wrapper 9.x, Leaflet 1.9.4 + OSM.

**Spec:** `docs/superpowers/specs/2026-11-06-jeeptrack-stages-0-5-design.md` and `README.md` stages 0–5 (the README's tables and numbers are authoritative).

## Global Constraints

- One git commit per stage, message `stage N: <title>`, made only after every acceptance check for that stage passes. Each stage also writes `docs/stage-N.md` (what was built, how to run, known gaps).
- No features beyond README stages 0–5 (no fares, seat sensing, multi-route, auth on public read endpoints).
- Secrets only in repo-root `.env` (gitignored). `.env.example` has placeholders for every variable. Node reads it with `node --env-file=../.env` (no dotenv).
- Ambiguities and fallbacks go into `docs/open-questions.md`. Don't guess silently.
- Node ESM (`"type": "module"`), tests use `node --test`. Python venv at repo-root `.venv` (`.venv/Scripts/python` on Windows).
- MQTT: topics `jeeptrack/v1/jeep/{jeep_id}/pos` and `/batch` (batch N ≤ 200), QoS 1, client ID `jeep-{jeep_id}`, clean start = false, session expiry = 3600 s, username `jeep-{jeep_id}`, password = device token.
- The server's MQTT client also uses clean start = false and session expiry 3600 s with client ID `jeeptrack-server`, so QoS 1 messages queue while it restarts.
- Position field names are the same snake_case names everywhere (JS/Python/vectors): `version, jeep_id, seq, ts, lat_e7, lon_e7, speed_cms, heading_cdeg, accuracy_dm, flags`. Kotlin uses the camelCase equivalents.
- ETA constants: accuracy filter 30 m, map-match distance 40 m, EWMA α = 0.3, window 30 min, default 15 km/h, dwell 20 s, stale after 60 s, hidden after 10 min.
- Postgres is published on host port `127.0.0.1:5433` (avoids clashing with a local 5432).
- Web: text ≥ 16 px, usable at 360 px width, stale shown by text plus gray (not color alone), WS backoff 1 s → 30 s.

## Review Focus

1. **Simulator re-runs** must not reuse `seq` values (PK de-dup would silently drop the whole second run). `seq` persists per jeep in `simulator/.fleet.json`. Pinned in Task 8.
2. **Late or out-of-order points** (batch after a dead zone, `ts` ≤ the jeep's latest) are stored but must not move the jeep backwards or feed the EWMA. Pinned in Task 10.
3. **Jeep finishes a trip and restarts at Alangilan** (route_m drops > 500 m). This counts as a new trip: no negative speed sample and no stale "behind" ETAs. Pinned in Task 10.
4. **Malformed MQTT payloads** (batch length not a multiple of 28, > 200 reports, non-numeric topic id, topic/payload id mismatch) are rejected and logged as one rejection without crashing the ingest. Pinned in Task 6.
5. **Malformed WebSocket input** (non-JSON, unknown stop_id) is ignored and the socket stays open. Pinned in Task 11.

---

## Stage 0 — Repo and local infrastructure

### Task 1: Compose, TLS certs, broker users, migrations

**Files:**
- Create: `.gitattributes` (`* text=auto eol=lf`), `.env.example`, `infra/docker-compose.yml`, `infra/mosquitto/mosquitto.conf`, `infra/gen-certs.sh`, `infra/smoke.sh`
- Create: `server/package.json`, `server/scripts/broker.js`, `server/scripts/bootstrap-broker.js`, `server/scripts/migrate.js`, `infra/db/migrations/000_postgis.sql`
- Modify: `.gitignore` (add `infra/mosquitto/passwd`, `infra/mosquitto/acl`, `simulator/.fleet.json`)
- Create: `docs/stage-0.md`

**Interfaces:**
- Produces `.env` variables: `MQTT_TLS_URL=mqtts://localhost:8883`, `MQTT_TEST_URL=mqtt://127.0.0.1:1883`, `MQTT_CA=../infra/certs/ca.crt`, `MQTT_SERVER_USER=jeeptrack-server`, `MQTT_SERVER_PASS`, `DATABASE_URL=postgres://jeeptrack:<pw>@127.0.0.1:5433/jeeptrack`, `POSTGRES_PASSWORD`, `HTTP_PORT=8080`, `LAN_IP`
- Produces `server/scripts/broker.js`:
  - `setBrokerPassword(user: string, pass: string): void`: runs `docker compose -f infra/docker-compose.yml exec -T mosquitto mosquitto_passwd -b /mosquitto/config/passwd <user> <pass>`
  - `writeAcl(entries: {user: string, lines: string[]}[]): void`: rewrites `infra/mosquitto/acl` entirely
  - `reloadBroker(): void`: sends SIGHUP via `docker compose kill -s HUP mosquitto`
- Produces `server/scripts/migrate.js`: applies `infra/db/migrations/*.sql` in filename order, tracked in table `schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`, each file in its own transaction. Idempotent.

- [ ] **Step 1: Write `infra/gen-certs.sh`.** It makes a dev CA and a server cert into `infra/certs/` (`ca.crt`, `ca.key`, `server.crt`, `server.key`) with CN=`localhost` and SAN `DNS:localhost,IP:127.0.0.1,IP:$LAN_IP`. `LAN_IP` is read from `.env`. Run it and confirm with: `openssl x509 -in infra/certs/server.crt -noout -ext subjectAltName` lists the LAN IP.
- [ ] **Step 2: Write `mosquitto.conf`.** It has `per_listener_settings false`, `allow_anonymous false`, `password_file /mosquitto/config/passwd` and `acl_file /mosquitto/config/acl`. Add listener 8883 with the certs and `tls_version tlsv1.3`, plus listener 1883 (the compose file maps it only to `127.0.0.1:1883`). Persistence is on, so sessions survive restarts.
- [ ] **Step 3: Write `docker-compose.yml`.** Two services: `mosquitto` (config dir + certs mounted, healthcheck = TCP connect to 8883) and `db` (`postgis/postgis:16-3.4`, named volume, `127.0.0.1:5433:5432`, healthcheck `pg_isready`).
- [ ] **Step 4: Bootstrap the broker user.** `bootstrap-broker.js` creates an empty passwd file if it's missing and sets the `MQTT_SERVER_USER` password. It writes an ACL with `topic read jeeptrack/v1/jeep/#` for the server user, keeps any existing `jeep-*` entries (they're re-derived from the DB in Task 5), then reloads the broker.
- [ ] **Step 5: Write `000_postgis.sql`** (`CREATE EXTENSION IF NOT EXISTS postgis;`) and `migrate.js`. Run `node --env-file=../.env scripts/migrate.js` twice. The second run applies 0 files.
- [ ] **Step 6: Write `infra/smoke.sh`.** It checks the three Stage 0 acceptance items inside the containers:
  - `mosquitto_pub --cafile … -p 8883 -u $MQTT_SERVER_USER -P $MQTT_SERVER_PASS -t smoke -m x` exits 0.
  - The same command with a wrong password exits non-zero.
  - `psql -c 'SELECT PostGIS_Version();'` prints a version.
- [ ] **Step 7: Run** `docker compose -f infra/docker-compose.yml up -d`, wait for both services to report `healthy` in `docker compose ps`, then run `bash infra/smoke.sh`. Expected: 3/3 PASS.
- [ ] **Step 8: Write `docs/stage-0.md` and commit** `stage 0: repo and local infrastructure`.

---

## Stage 1 — Wire protocol

### Task 2: SPEC, test vectors, JS codec

**Files:**
- Create: `protocol/SPEC.md` (the README's Stage 1 tables copied verbatim, plus the error codes below), `protocol/test-vectors.json`, `protocol/js/package.json`, `protocol/js/index.js`, `protocol/js/gen-vectors.js`, `protocol/js/test/codec.test.js`

**Interfaces:**
- Produces `protocol/js/index.js` (imported by the server as `../protocol/js/index.js`):
  - `crc16(bytes: Uint8Array): number`: CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflect, xorout 0)
  - `encode(r: Report): Buffer` (28 bytes, big-endian). Clamps `accuracy_dm` to 65535 and throws `ProtocolError('range')` for any other out-of-range field (heading > 35999, lat outside ±900000000, lon outside ±1800000000, ints that don't fit their width).
  - `decode(buf: Uint8Array): Report`. Throws `ProtocolError` with `.code` set to `'length'` (≠ 28), `'version'` (≠ 1) or `'crc'`.
  - `decodeBatch(buf): Report[]`. Throws `'length'` if the length is 0, not a multiple of 28, or more than 200 × 28. Any bad report rejects the whole batch.
  - `smsEncode(r: Report, key: Buffer): string` returns `JT1:<b64url(28 bytes)>:<b64url(hmac8)>`, unpadded and 54 chars long.
  - `smsDecode(text: string, keyFor: (jeepId: number) => Buffer | null): Report`. Error codes: `'prefix'` (not `JT1:`), `'format'` (wrong part count or bad base64 length), `'length'`/`'version'`/`'crc'` (from `decode`), `'unknown_jeep'` (`keyFor` returns null), `'hmac'` (constant-time compare fails).
  - `class ProtocolError extends Error { code: string }`
  - `Report = { version, jeep_id, seq, ts, lat_e7, lon_e7, speed_cms, heading_cdeg, accuracy_dm, flags }` (all integers)
- Produces `protocol/test-vectors.json` with this shape: `{ "sms_keys": {"<jeep_id>": "<64 hex chars>"}, "crc_check": {"ascii": "123456789", "crc": 10673}, "reports": [{name, fields, hex}], "bad_reports": [{name, hex, error}], "sms": [{name, text, fields}], "bad_sms": [{name, text, error}] }`

- [ ] **Step 1: Write `codec.test.js`.** It loads `../../test-vectors.json` and checks:
  - `crc16(Buffer.from('123456789')) === 0x29B1`
  - for every `reports[i]`: `encode(fields).toString('hex') === hex` and `deepEqual(decode(hex), fields)`
  - for every `bad_reports`: `decode` throws with `.code === error`
  - for every `sms`: `smsEncode(fields, key) === text`, `text.length === 54`, and `deepEqual(smsDecode(text, keyFor), fields)`
  - for every `bad_sms`: `smsDecode` throws with `.code === error`
  - `decodeBatch` of 3 concatenated vectors returns 3 reports
  - `decodeBatch` throws `'length'` for 29 bytes and for 201 × 28 bytes
  - `encode({...ok, heading_cdeg: 36000})` throws `'range'`
  - `encode({...ok, accuracy_dm: 70000})` decodes back to 65535
- [ ] **Step 2: Run `npm test` in `protocol/js`.** Expected: FAIL, module missing.
- [ ] **Step 3: Implement `index.js`.**
- [ ] **Step 4: Write `gen-vectors.js` and generate the vectors.** It writes `test-vectors.json` using the new codec with SMS key `000102…1f` for jeep 101.
  - At least 10 `reports`: normal Batangas point (lat 137840000, lon 1210740000), negative lat/lon, all-max values (jeep 65535, seq/ts 4294967295, lat 900000000, lon 1800000000, speed 65535, heading 35999, accuracy 65535, flags 3), all-zero, flags bit0 only, flags bit1 only, and min-negative (lat −900000000, lon −1800000000).
  - `bad_reports`: CRC byte flipped → `crc`, version 2 with recomputed CRC → `version`, 27 bytes → `length`.
  - `bad_sms`: one byte of hmac changed → `hmac`, `JT2:` prefix → `prefix`, jeep 999 → `unknown_jeep`, missing third part → `format`, corrupted CRC inside a valid-format SMS → `crc`.
  - Check one normal report by hand: decode its hex field-by-field against the README offsets.
- [ ] **Step 5: Run `npm test`.** Expected: all PASS.

### Task 3: Python codec

**Files:**
- Create: `protocol/python/pyproject.toml` (package `jeeptrack_protocol`), `protocol/python/jeeptrack_protocol/__init__.py`, `protocol/python/tests/test_codec.py`

**Interfaces:**
- Consumes: `protocol/test-vectors.json` (Task 2)
- Produces: `crc16(b: bytes) -> int`, `encode(r: dict) -> bytes`, `decode(b: bytes) -> dict`, `sms_encode(r: dict, key: bytes) -> str`, `sms_decode(text: str, key_for: Callable[[int], bytes | None]) -> dict`, and `class ProtocolError(Exception)` with `.code`. Same codes and semantics as JS, dict keys as in Global Constraints. Installed in `.venv` with `pip install -e protocol/python`.

- [ ] **Step 1: Write `test_codec.py`.** It mirrors the JS vector assertions (crc check, reports both ways, bad_reports, sms both ways, bad_sms, `range`, accuracy clamp).
- [ ] **Step 2: Create the venv and run the tests.** `python -m venv .venv`, `.venv/Scripts/pip install pytest -e protocol/python`, then `.venv/Scripts/python -m pytest protocol/python`. Expected: FAIL.
- [ ] **Step 3: Implement the codec** with `struct.pack('>BHIIiiHHHB', …)` + CRC, `hmac`, `base64.urlsafe_b64encode(...).rstrip(b'=')`, and `hmac.compare_digest`.
- [ ] **Step 4: Run pytest.** Expected: all PASS.

### Task 4: Kotlin codec

**Files:**
- Create: `protocol/kotlin/settings.gradle.kts`, `protocol/kotlin/build.gradle.kts`, Gradle wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`), `protocol/kotlin/src/main/kotlin/jeeptrack/protocol/Codec.kt`, `protocol/kotlin/src/test/kotlin/jeeptrack/protocol/CodecTest.kt`
- Create: `docs/stage-1.md`

**Interfaces:**
- Consumes: `protocol/test-vectors.json`, read from the test via relative path `../test-vectors.json`
- Produces (for the Android apps later): `data class Report(version: Int, jeepId: Int, seq: Long, ts: Long, latE7: Int, lonE7: Int, speedCms: Int, headingCdeg: Int, accuracyDm: Int, flags: Int)` and `object Codec { fun crc16(b: ByteArray): Int; fun encode(r: Report): ByteArray; fun decode(b: ByteArray): Report; fun smsEncode(r: Report, key: ByteArray): String; fun smsDecode(text: String, keyFor: (Int) -> ByteArray?): Report }`. Errors use `class ProtocolError(val code: String) : Exception(code)` with the same codes as JS.

- [ ] **Step 1: Get the Gradle wrapper.** Download the Gradle 9.x binary zip into the scratchpad and run its `bin/gradle wrapper --gradle-version <same>` in `protocol/kotlin`. Use the Kotlin JVM plugin 2.2.x or newer with `jvmTarget = 21` and Java `targetCompatibility = 21`, so it compiles on JDK 25. Test deps: `kotlin("test")` and `org.json:json` for reading vectors.
- [ ] **Step 2: Write `CodecTest.kt`.** Same assertions as the JS test.
- [ ] **Step 3: Run `./gradlew test`.** Expected: FAIL (unresolved `Codec`).
- [ ] **Step 4: Implement `Codec.kt`.** Use `ByteBuffer` (BIG_ENDIAN), `javax.crypto.Mac("HmacSHA256")`, `Base64.getUrlEncoder().withoutPadding()` and `MessageDigest.isEqual`.
- [ ] **Step 5: Run `./gradlew test`.** Expected: BUILD SUCCESSFUL, all vectors pass. Then rerun `npm test` and pytest to confirm all three are green.
- [ ] **Step 6: Write `docs/stage-1.md` and commit** `stage 1: wire protocol`.

---

## Stage 2 — Server ingest

### Task 5: Schema and device registration

**Files:**
- Create: `infra/db/migrations/001_init.sql` (the README schema, verbatim), `server/src/db.js`, `server/src/jeeps.js`, `server/scripts/add-jeep.js`, `server/test/jeeps.test.js`

**Interfaces:**
- Consumes: `setBrokerPassword`, `writeAcl`, `reloadBroker` (Task 1)
- Produces `server/src/db.js`:
  - `makePool(): pg.Pool` (from `DATABASE_URL`)
  - `insertPositions(pool, rows: Row[]): Promise<Row[]>`: one multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING jeep_id, seq`. Returns only the rows that were actually inserted.
  - `Row = { jeep_id, seq, ts: Date, lat, lon, speed_mps, heading_deg, accuracy_m, source: 'mqtt'|'batch'|'sms' }`
- Produces `server/src/jeeps.js`:
  - `registerJeep(pool, {id: number, plate: string}): Promise<{token: string, smsKey: Buffer}>`. Token = 24 random bytes as base64url. Stores the `bcryptjs` hash (cost 10) and a random 32-byte `sms_key`, upserting on id. It then calls `setBrokerPassword('jeep-'+id, token)`, rebuilds the ACL from all active jeepneys (each gets `topic write jeeptrack/v1/jeep/{id}/#`) plus the server user, and calls `reloadBroker()`.
  - `aclEntries(activeIds: number[], serverUser: string): {user, lines}[]` is pure.
- Produces CLI: `node --env-file=../.env scripts/add-jeep.js --id 101 --plate ABC-123 [--json]`. It prints the token and SMS key (hex) once. With `--json` it prints `{"id","token","sms_key"}`.

- [ ] **Step 1: Write `jeeps.test.js`.** `aclEntries([101,102],'jeeptrack-server')` deep-equals the server entry `['topic read jeeptrack/v1/jeep/#']` followed by `jeep-101` → `['topic write jeeptrack/v1/jeep/101/#']` and the same for 102.
- [ ] **Step 2: Run `node --test test/jeeps.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement `db.js`, `jeeps.js` and `add-jeep.js`, then run the migration.** Expected: unit test PASS. `add-jeep.js --id 9999 --plate TEST` prints a token. Running `mosquitto_pub` over TLS with `jeep-9999`/token exits 0.

### Task 6: MQTT ingest

**Files:**
- Create: `server/src/log.js`, `server/src/ingest.js`, `server/src/index.js`, `server/test/ingest.test.js`, `server/test/integration/ingest.int.test.js`
- Modify: `server/package.json` (scripts: `start` = `node --env-file=../.env src/index.js`, `test` = `node --test test/*.test.js`, `test:integration` = `node --env-file=../.env --test test/integration/`)
- Create: `docs/stage-2.md`

**Interfaces:**
- Consumes: `decode`, `decodeBatch`, `ProtocolError` (Task 2); `insertPositions`, `makePool` (Task 5)
- Produces `server/src/log.js`: `log(event: string, fields?: object): void` writes one JSON line to stdout with `t` (ISO timestamp) and `event`.
- Produces `server/src/ingest.js`:
  - `toRow(r: Report, source): Row` (lat = lat_e7/1e7, speed_mps = cms/100, heading_deg = cdeg/100, accuracy_m = dm/10, ts = `new Date(ts*1000)`)
  - `handleMessage(topic: string, payload: Buffer, deps: {insert: (rows) => Promise<Row[]>, emit: (row) => void}): Promise<{received: number, stored: number, duplicate: number, rejected: number}>`
    - Topic must match `^jeeptrack/v1/jeep/(\d+)/(pos|batch)$`; `pos` → `decode`, `batch` → `decodeBatch`.
    - Every report's `jeep_id` must equal the topic id. Any failure rejects the whole message and counts as `rejected: 1`, logged with `event:'reject'` and the reason.
    - Calls `emit(row)` for each newly stored row. The row has an added field `eta_eligible: row.accuracy_m <= 30`.
    - A DB foreign-key error (unknown jeep) counts as a rejection.
  - `startIngest({pool, emitter: EventEmitter}): mqtt.Client` connects to `MQTT_TLS_URL` with the CA, server credentials and the session settings from Global Constraints. It subscribes QoS 1 to `jeeptrack/v1/jeep/+/pos` and `jeeptrack/v1/jeep/+/batch`, emits `'position'` on `emitter`, keeps cumulative counters, and logs `event:'counters'` every 30 s.
- Produces `server/src/index.js`: creates the pool and emitter and starts ingest. Task 11 adds the API to it.

- [ ] **Step 1: Write the `ingest.test.js` unit tests** against a fake `insert` that de-dups by `jeep_id:seq` in a Set:
  - a valid `pos` → `{received:1, stored:1}` and `emit` called once with `eta_eligible: true`
  - the same payload again → `duplicate:1`, no emit
  - a flipped CRC byte → `rejected:1`
  - topic `jeep/102/pos` with a payload for jeep 101 → `rejected:1`
  - topic `jeep/abc/pos` → `rejected:1`
  - a batch of 3 → `stored:3`, rows with `source:'batch'`
  - a batch of 29 bytes → `rejected:1`
  - `accuracy_dm: 400` (40 m) → stored with `eta_eligible: false`
  - `toRow` converts `speed_cms: 1234` to `12.34`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement `log.js`, `ingest.js` and `index.js`.** Expected: `npm test` PASS.
- [ ] **Step 4: Write the integration test.** It needs compose up and migrations applied.
  - Setup: delete positions for jeeps 9001/9002, then `registerJeep` both. Start `startIngest` in-process.
  - As `jeep-9001`, connect over `MQTT_TEST_URL` (MQTT 5, QoS 1) and publish 100 reports (seq 1–100), 20 repeats of seq 1–20, and 5 CRC-corrupted payloads.
  - Wait until the counters stop changing for 2 s, then assert `SELECT count(*) … jeep_id=9001` is 100 and the rejected counter is 5.
  - As `jeep-9001`, publish one valid report for jeep 9002 to `jeeptrack/v1/jeep/9002/pos`. Assert either a PUBACK reason code ≥ 0x80, or 0 rows for 9002 after 2 s.
- [ ] **Step 5: Run `npm run test:integration`.** Expected: PASS. Write `docs/stage-2.md` and commit `stage 2: server ingest`.

---

## Stage 3 — Fleet simulator

### Task 7: Route and stops data

**Files:**
- Create: `data/fetch_route.py`, `data/route.geojson`, `data/stops.csv`, `docs/open-questions.md`

**Interfaces:**
- Produces `data/route.geojson`: a FeatureCollection with one LineString feature (`[lon, lat]`), ordered from BatStateU Alangilan to Batangas City Grand Terminal.
- Produces `data/stops.csv`: header `stop_id,name,lat,lon,order,verified`. 15 rows, order 1..15, every `verified=false`. Stop 1 = `BatStateU Alangilan`, stop 15 = `Batangas City Grand Terminal`.

- [ ] **Step 1: Write `fetch_route.py`.** It uses stdlib `urllib` only.
  - Geocode both endpoints with Nominatim (User-Agent `jeeptrack-dev`) and print what was found.
  - Fetch `https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson` and write `route.geojson`.
  - Place 15 stops: both endpoints plus 13 evenly spaced by distance along the line. Name each by reverse-geocoding its road or neighbourhood name, or `Stop N` if that fails.
- [ ] **Step 2: Run it and sanity-check the output.** Route length should be between 3 and 25 km, the first and last coordinates within 300 m of the geocoded endpoints, and 15 stops in order.
- [ ] **Step 3: Write `docs/open-questions.md`.** Include the endpoint coordinates used, the route source (OSRM public router, not the actual jeepney path), that all stops are `verified=false` and auto-placed, and that only the Alangilan → Terminal direction is modeled (affects the kiosk "outbound" column).

### Task 8: Simulator

**Files:**
- Create: `simulator/requirements.txt` (`paho-mqtt>=2,<3`, `pytest`), `simulator/route.py`, `simulator/replay.py`, `simulator/seed_fleet.py`, `simulator/tests/test_route.py`, `simulator/tests/test_fleet_state.py`
- Create: `docs/stage-3.md`

**Interfaces:**
- Consumes: `encode` (Task 3), `add-jeep.js --json` (Task 5), and the data files (Task 7)
- Produces `simulator/route.py`:
  - `Route.load(path) -> Route` with `length_m: float`, `point_at(m: float) -> (lat, lon, heading_deg)` and `stop_ms: list[float]`. Stops are projected the same way as the server's planar geometry: equirectangular around the first coordinate, R = 6371008.8.
- Produces `simulator/seed_fleet.py`: runs `add-jeep.js --json` for ids 101–110 (plates `SIM-101` and so on) and writes `simulator/.fleet.json` = `{"101": {"token": "...", "seq": 0}, ...}`. It keeps the existing `seq` values when re-seeding.
- Produces `simulator/replay.py`. The CLI is the README's: `--mode synthetic|trace`, `--jeeps 10`, `--interval 10`, `--minutes N`, `--dead-zone START_M:END_M`, `--trace FILE`, `--speedup 1|10`, plus `--broker mqtt://127.0.0.1:1883` (default) or an mqtts URL with `--ca`.
  - Each jeep has its own paho client (client ID `jeep-{id}`, MQTT 5, clean start false, session expiry 3600) and publishes QoS 1 to `.../pos` with `flags = 0b10`.
  - `ts` = wall-clock now. `seq` is read from `.fleet.json`, incremented per fix, and written back after every publish round.
  - **Synthetic motion:** each inter-stop segment has a base speed drawn once from 15–40 km/h with `random.Random(42)`. Each jeep gets a ±20% per-jeep factor. Dwell at each stop is uniform 10–60 s. GPS noise is Gaussian σ = 5 m, and the reported accuracy is 5 m. Jeeps start staggered along the route. At the end of the route a jeep waits 60 s and restarts at stop 1.
  - **Dead zone:** while route_m is inside `[START_M, END_M]`, fixes are buffered instead of published. On exit they go out as one `.../batch` payload (chunks of ≤ 200) with `flags = 0b11`.
  - **Ground truth:** `eval/out/truth-<unix>.csv` with `jeep_id,trip,stop_id,arrival_ts`, written when a jeep actually reaches each stop.

- [ ] **Step 1: Write the tests.**
  - `test_route.py`: on a 2-point synthetic route ~1000 m due north, `point_at(0)` is the start, `point_at(length_m)` is the end, and `point_at(500)` is within 1 m of the midpoint with a heading of about 0°.
  - `test_fleet_state.py`: load the fleet state, bump seq for jeep 101 three times, save, reload → seq == 3. Re-seeding preserves seq (Review Focus 1).
- [ ] **Step 2: Run** `.venv/Scripts/pip install -r simulator/requirements.txt` and `.venv/Scripts/python -m pytest simulator`. Expected: FAIL.
- [ ] **Step 3: Implement `route.py`, `seed_fleet.py` and `replay.py`.** Expected: pytest PASS.
- [ ] **Step 4: Acceptance run.** Server running, then `seed_fleet.py`, then `replay.py --jeeps 10 --interval 10 --minutes 5`. Expected: `positions` count for 101–110 increases by ≈ 300 (±10), the ingest logs show 0 duplicate and 0 rejected, and a truth CSV is written.
- [ ] **Step 5: Dead-zone run.** Run `replay.py --jeeps 1 --minutes 5 --dead-zone 500:1500`. Expected: rows with `source='batch'` exist, and `SELECT max(seq)-min(seq)+1 = count(*)` holds for that jeep's run (no gaps).
- [ ] **Step 6: Write `docs/stage-3.md` and commit** `stage 3: fleet simulator`.

---

## Stage 4 — ETA engine and API

### Task 9: Route schema, loader, geometry

**Files:**
- Create: `infra/db/migrations/002_route.sql`, `server/scripts/load-route.js`, `server/src/geo.js`, `server/test/geo.test.js`

**Interfaces:**
- Produces `002_route.sql`: `route(id INT PRIMARY KEY, geom GEOGRAPHY(LINESTRING,4326) NOT NULL)` and `stops(id INT PRIMARY KEY, name TEXT NOT NULL, order_no INT NOT NULL, geom GEOGRAPHY(POINT,4326) NOT NULL, route_m REAL NOT NULL, verified BOOLEAN DEFAULT FALSE)`.
- Produces `load-route.js`: upserts route id 1 from `data/route.geojson` and the stops from `data/stops.csv`. It sets `route_m = ST_LineLocatePoint(route.geom::geometry, stop.geom::geometry) * ST_Length(route.geom)` and fails if stop route_m values aren't strictly increasing with `order_no`.
- Produces `server/src/geo.js`:
  - `buildRoute(coords: [lon, lat][]): {pts: {x, y}[], cum: number[], lengthM: number, lat0: number, lon0: number}` (planar meters, equirectangular around `coords[0]`, R = 6371008.8)
  - `projectToRoute(route, lat, lon): {routeM: number, distM: number}` (nearest segment, clamped)
  - `pointAt(route, m): {lat, lon}`

- [ ] **Step 1: Write `geo.test.js`.** Route = `[[121,13.7],[121,13.709]]`, about 1000.8 m north.
  - `lengthM` is within 1 m of 1000.8.
  - Projecting `(13.7045, 121.0001)` gives `routeM` ≈ 500.4 ± 1 and `distM` ≈ 10.8 ± 0.5.
  - A point 1 km before the start gives `routeM === 0`.
  - `pointAt(route, 500.4)` round-trips to within 0.5 m.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL. Implement `geo.js`. Expected: PASS.
- [ ] **Step 3: Implement the migration and the loader.** Run migrate, then `load-route.js`. Expected: 15 stops with increasing `route_m`, and the last stop's `route_m` within 50 m of the JS `buildRoute(...).lengthM`.

### Task 10: ETA engine

**Files:**
- Create: `server/src/eta.js`, `server/test/eta.test.js`, `docs/eta.md`

**Interfaces:**
- Consumes: `buildRoute`, `projectToRoute`, `pointAt` (Task 9); the `position` row shape from Task 6
- Produces `server/src/eta.js`:
  - `new EtaEngine({route, stops: {id, name, order_no, route_m, lat, lon}[], defaultMps = 15/3.6, alpha = 0.3, windowMs = 1_800_000, dwellS = 20, staleMs = 60_000, hideMs = 600_000, minMps = 1})`
  - `update(row, nowMs: number): {jeep_id, lat, lon, route_m, speed, last_seen, stale} | null` returns `null` if the row is ignored.
  - `jeeps(nowMs): JeepView[]` excludes hidden jeeps.
  - `etasForStop(stopId, nowMs): {jeep_id, eta_s: number, stale: boolean}[]` sorted by `eta_s` ascending, only jeeps with `route_m < stop.route_m`.
  - `segmentSpeed(i, nowMs): number` (m/s)

The algorithm (the ingredients are fixed by the spec; these are the choices the tests pin):

```
update(row):
  ignore if !row.eta_eligible or row.ts <= jeep.last_ts       (out-of-order / batch backfill)
  {routeM, distM} = projectToRoute(row.lat, row.lon); ignore if distM > 40
  prev = jeep state
  if prev and routeM < prev.routeM - 500: new trip → replace state, no speed sample
  elif prev and 0 < dt <= 120 s and routeM >= prev.routeM:
      v = (routeM - prev.routeM) / dt;  i = segment containing (routeM + prev.routeM)/2
      seg[i] = (seg[i] missing or older than windowMs) ? v : alpha*v + (1-alpha)*seg[i]
  store {routeM, last_ts = row.ts, last_seen = nowMs, lat, lon, speed = row.speed_mps}
segmentSpeed(i) = max(minMps, seg[i] fresh ? seg[i] : defaultMps)
eta(jeep at x in segment i, target stop k) =
  (s[i+1]-x)/v(i) + Σ_{j=i+1}^{k-1} (s[j+1]-s[j])/v(j) + dwellS*(k-1-i)
stale = now - last_seen > staleMs; hidden = now - last_seen > hideMs
```

`minMps` is a shortcut that keeps a dwelling jeep from producing an infinite ETA. Note it in `docs/eta.md`: `shortcut: 1 m/s floor, revisit if MAE suffers at stops`.

- [ ] **Step 1: Write `eta.test.js`.** Straight route, stops at 0/1000/2000 m (use `pointAt` to place the lat/lon). Cases:
  - Jeep at 500 m, no speed data, ETA to stop 3 → 500/4.1667 + 1000/4.1667 + 20 = **380 s ± 1**.
  - ETA to stop 2 → **120 s ± 1**.
  - Stop 1 (behind) → jeep not listed.
  - Two updates 100 m apart, 10 s apart, inside segment 0 → `segmentSpeed(0)` = 10 (first sample seeds it). A third update +50 m/10 s → 0.3·5 + 0.7·10 = **8.5**.
  - A sample older than 30 min → `segmentSpeed` back to the default.
  - Update with `ts` ≤ last → returns null and the state is unchanged (Review Focus 2).
  - Jump from 1900 m to 50 m → new trip, `segmentSpeed` unchanged and the ETA to stop 3 is computed from 50 m (Review Focus 3).
  - Point 50 m off the line → ignored.
  - `eta_eligible: false` → ignored.
  - `now = last_seen + 61 s` → `stale: true`. `+601 s` → absent from `jeeps()` and from the ETAs.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL. Implement `eta.js`. Expected: PASS.
- [ ] **Step 3: Write `docs/eta.md`** with the algorithm above in prose, including the shortcut.

### Task 11: REST + WebSocket API and ETA accuracy check

**Files:**
- Create: `server/src/api.js`, `server/test/api.test.js`, `eval/eta_accuracy.py`
- Modify: `server/src/index.js` (load route + stops from the DB, build the `EtaEngine`, feed it from `emitter.on('position')`, start the API on `HTTP_PORT`, serve `../web` as static files)
- Create: `docs/stage-4.md`

**Interfaces:**
- Consumes: `EtaEngine` (Task 10)
- Produces `server/src/api.js`: `createApi({engine, stops, routeGeoJson, emitter, now = Date.now}): {app: express.Express, attachWs(server: http.Server): void}`
  - `GET /api/stops` → `[{id, name, order_no, lat, lon, route_m, verified}]`
  - `GET /api/route` → the route GeoJSON. This isn't in the README list; the PWA needs it to draw the line.
  - `GET /api/jeeps` → `engine.jeeps(now())` with `last_seen` as an ISO string
  - `GET /api/etas?stop_id=N` → `engine.etasForStop`. Missing or unknown stop → `400 {"error":"unknown stop_id"}`.
  - `GET /healthz` → `{ok: true}`
  - `WS /ws` (same server, path `/ws`). On each `position` the engine updates and broadcasts `{"type":"pos", ...JeepView, server_sent_at}`, then sends `{"type":"eta", stop_id, etas, server_sent_at}` to every socket subscribed to a stop. `server_sent_at` = `new Date().toISOString()`.
  - A client message `{"subscribe":{"stop_id":N}}` sets that socket's stop (one at a time) and is answered with an immediate `eta`. Invalid JSON or an unknown stop is ignored.
  - A 10 s tick re-sends `pos` for all visible jeeps plus `eta` for subscriptions, so staleness updates without new points.
- Produces `eval/eta_accuracy.py --base http://localhost:8080 --truth eval/out/truth-<x>.csv --minutes 30`:
  - Every 30 s it records `(sample_time, jeep_id, stop_id, sample_time + eta_s)` for all stops into `eval/out/eta-pred-<x>.csv`.
  - At the end it joins each prediction to the first truth arrival of that jeep at that stop after `sample_time`.
  - It prints the MAE in minutes and `PASS` if ≤ 2.0.

- [ ] **Step 1: Write `api.test.js`** against a real `EtaEngine` built on the Task 10 straight route, with the app on an ephemeral port:
  - `GET /api/etas?stop_id=3` after one update at 500 m → `[{jeep_id: 101, eta_s: ≈380, stale: false}]`
  - `stop_id=99` → 400
  - WS: subscribe to stop 3, emit `position` → receive one `pos` and one `eta`, both with `server_sent_at`
  - WS: send `"not json"` and then `{"subscribe":{"stop_id":99}}` → socket still open and a later `position` still delivers `pos` (Review Focus 5)
  - `GET /healthz` → 200
- [ ] **Step 2: Run `npm test`.** Expected: FAIL. Implement `api.js` and wire up `index.js`. Expected: PASS.
- [ ] **Step 3: Live check.** With the server and `replay.py --jeeps 10 --minutes 35` running, `curl /api/etas?stop_id=15` returns a non-empty list. Every stop ahead of each active jeep has an entry.
- [ ] **Step 4: Accuracy run.** Run `eval/eta_accuracy.py --minutes 30` alongside the simulator (in the background). Expected: MAE ≤ 2.0 min, PASS. If it fails, tune only within the spec (the EWMA sampling rule or the `minMps` floor), record what changed in `docs/eta.md`, and rerun.
- [ ] **Step 5: Write `docs/stage-4.md`** (including the measured MAE) and commit `stage 4: ETA engine and API`.

---

## Stage 5 — Commuter PWA and terminal kiosk

### Task 12: Commuter map app

**Files:**
- Create: `web/index.html`, `web/app.js`, `web/live.js`, `web/geo.js`, `web/styles.css`, `web/test/live.test.js`, `web/test/geo.test.js`, `web/package.json` (`"type":"module"`, test script only)

**Interfaces:**
- Consumes: the REST + WS API (Task 11)
- Produces `web/live.js` (ES module, browser and Node):
  - `backoffDelay(attempt: number): number` = `min(30000, 1000 * 2**attempt)`
  - `connectLive({url, onMessage, onStatus: (s: 'online'|'reconnecting') => void, subscribeStopId?: () => number|null, WebSocketImpl = globalThis.WebSocket}): {setStop(id): void, close(): void}`. Reconnects with `backoffDelay`, resets the attempt counter on open, and re-sends the subscription after reconnecting.
- Produces `web/geo.js`: `nearestStop(stops, lat, lon): stop` (haversine)

- [ ] **Step 1: Write the tests.**
  - `live.test.js`: `backoffDelay(0)=1000`, `(1)=2000`, `(4)=16000`, `(5)=30000`, `(10)=30000`. With a fake `WebSocketImpl`: fire close → `onStatus('reconnecting')`, then fire open → `onStatus('online')` and the subscribe message is re-sent.
  - `geo.test.js`: of 3 stops, `nearestStop` returns the closest one.
- [ ] **Step 2: Run `node --test web/test/`.** Expected: FAIL. Implement both modules. Expected: PASS.
- [ ] **Step 3: Build the map page.** `index.html` + `app.js` + `styles.css` use Leaflet 1.9.4 from unpkg with OSM tiles.
  - Draw the route line from `/api/route` and stop markers from `/api/stops`. Jeep markers come from `pos` messages; stale markers are gray and labelled "last seen N min ago". Markers with `last_seen` > 10 min are removed.
  - Tapping a stop opens a panel listing `Jeep 104 — 3 min` (stale entries suffixed "(last seen N min ago)") and calls `setStop`.
  - A "Nearest stop" button uses `navigator.geolocation` and `nearestStop`. If permission is denied, show a short message; the rest of the app keeps working.
  - A banner with `role="status"` shows "Offline — reconnecting…" while the status is `reconnecting`.
  - Base font 16 px; layout works at 360 px.
- [ ] **Step 4: Check it in a browser** with the server and simulator running. Use the claude-in-chrome skill if it's available; otherwise write manual steps in `docs/stage-5.md`.
  - Markers move and ETAs update without a reload.
  - Stop the server → banner appears. Restart it → the banner clears on its own and updates resume.

### Task 13: Kiosk, manifest, service worker

**Files:**
- Create: `web/kiosk.html`, `web/kiosk.js`, `web/manifest.json`, `web/sw.js`, `web/icons/icon-192.png`, `web/icons/icon-512.png`, `web/icons/make_icons.py`
- Modify: `web/index.html` (manifest link, SW registration)
- Create: `docs/stage-5.md`

**Interfaces:**
- Consumes: `connectLive` (Task 12), the API (Task 11)

- [ ] **Step 1: Build the kiosk.** `kiosk.html` + `kiosk.js` show a full-screen board subscribed to the last stop (Grand Terminal), listing the next 5 inbound arrivals.
  - Each row has jeep id, minutes and a stale text marker. Minimum text size 32 px.
  - It uses the same reconnect banner and needs no interaction.
  - The outbound column says "Outbound not tracked yet" (see `docs/open-questions.md`).
- [ ] **Step 2: Add the manifest, icons and service worker.**
  - `manifest.json` (name, short_name, `start_url: "/"`, `display: "standalone"`, theme colors, 192 and 512 PNG icons).
  - `make_icons.py` writes the PNGs with stdlib `zlib` + `struct` (a solid color with a simple shape, no Pillow).
  - `sw.js` precaches the app shell (html/js/css/manifest/icons/Leaflet assets) with cache-first for the shell, and lets `/api/*` and `/ws` go straight to the network.
- [ ] **Step 3: Installability check.** Run `npx lighthouse@11 http://localhost:8080 --only-categories=pwa --chrome-flags=--headless --output=json`. Pin v11: Lighthouse 12 removed the PWA category. Expected: the `installable-manifest` audit passes. If Chrome isn't available, check manually in DevTools → Application → Manifest and record that instead.
- [ ] **Step 4: Rerun everything.** Run all unit test suites (`protocol/js`, pytest for protocol + simulator, `./gradlew test`, `server` npm test, `web` tests) and the integration test. Expected: all green.
- [ ] **Step 5: Write `docs/stage-5.md`** (how to run the full demo locally, results of the Task 12 Step 4 checks, Lighthouse result) and commit `stage 5: commuter PWA and kiosk`.
