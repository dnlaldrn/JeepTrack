# Stage 0 — Repo and local infrastructure

## Built
- `infra/docker-compose.yml`: Mosquitto 2 (TLS 1.3 on 8883, plain 1883 bound to 127.0.0.1 for tests) and PostGIS 16-3.4 (host port `127.0.0.1:5434`).
- `infra/mosquitto/mosquitto.conf`: no anonymous, password file + ACL file, persistence on.
- `infra/gen-certs.sh`: dev CA + server cert (CN=localhost, SAN includes `LAN_IP` so phones on the LAN can connect).
- `server/scripts/broker.js` (`setBrokerPassword`, `writeAcl`, `reloadBroker`) and `bootstrap-broker.js` (creates the server's read-only broker user).
- `server/scripts/migrate.js`: applies `infra/db/migrations/*.sql` once each, in order, tracked in `schema_migrations`.
- `infra/smoke.sh`: the stage acceptance checks.

## Run
```bash
cp .env.example .env            # set LAN_IP and real passwords
bash infra/gen-certs.sh
touch infra/mosquitto/passwd infra/mosquitto/acl
docker compose -f infra/docker-compose.yml --env-file .env up -d
cd server && npm install && node --env-file=../.env scripts/bootstrap-broker.js && npm run migrate && cd ..
bash infra/smoke.sh             # expect 3 passed, 0 failed
```

## Acceptance (2026-11-06)
- Both services `healthy`.
- TLS publish with valid user: PASS. Wrong password: refused (PASS).
- `SELECT PostGIS_Version();` → `3.4 USE_GEOS=1 USE_PROJ=1 USE_STATS=1`.

## Known gaps
- Postgres is on 5434, not 5433: 5433 was taken by another local project.
- The mosquitto healthcheck probes the plain 1883 port. Probing 8883 without a TLS handshake fills the broker log with OpenSSL EOF errors.
- `server.key` is world-readable inside `infra/certs/` so the container user can read it. Dev only; it is gitignored.
