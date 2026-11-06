# Stage 2 — Server ingest

## Built
- `infra/db/migrations/001_init.sql`: `jeepneys` and `positions` (PK `(jeep_id, seq)` de-dups).
- `server/src/jeeps.js`: `registerJeep` (bcrypt token hash, random 32-byte SMS key, broker password, ACL rebuilt from active jeeps) and `aclEntries`.
- `server/scripts/add-jeep.js --id N --plate P [--json]`: prints the token and SMS key once.
- `server/src/ingest.js`: TLS MQTT subscriber (`clientId jeeptrack-server`, clean start false, session expiry 3600 s, QoS 1).
  - Decodes and CRC-checks each message, checks topic id == payload id, then `INSERT … ON CONFLICT DO NOTHING`.
  - Emits a `position` event per new row with `eta_eligible = accuracy_m <= 30`.
  - Logs JSON counters (received/stored/duplicate/rejected) every 30 s and a `reject` line per bad message.
- `server/src/index.js`: the server entry point (`npm start`).

## Run
```bash
cd server
node --env-file=../.env scripts/add-jeep.js --id 101 --plate ABC-123
npm start
npm test                  # unit: 13 pass
npm run test:integration  # needs compose up: 2 pass
```

## Acceptance (2026-11-06)
- 100 reports + 20 duplicates + 5 corrupted → exactly 100 rows, 20 duplicates, 5 rejected logged. PASS.
- `jeep-9001` publishing to `jeeptrack/v1/jeep/9002/pos` → refused by broker ACL, 0 rows. PASS.

## Known gaps
- A whole message is rejected if any report in a batch fails decoding or belongs to another jeep. This is intended: the phone resends from its outbox.
- Registering test jeeps 9001/9002/9999 leaves them in the dev DB and ACL. They're harmless; delete the rows if you want a clean ACL.
