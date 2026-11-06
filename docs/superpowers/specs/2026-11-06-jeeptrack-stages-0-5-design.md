# JeepTrack Stages 0–5 — Design

Date: 2026-11-06. Source of truth for requirements: `README.md` (stages 0–5). This doc records only the decisions the README leaves open.

## Scope
Stages 0–5 in order: infra, wire protocol (JS/Python/Kotlin), server ingest, fleet simulator, ETA engine + API, commuter PWA + kiosk. Each stage ends with passing tests, `docs/stage-N.md`, and a commit `stage N: <title>`.
Out of scope this round: Android apps (6–8), security hardening (9), field evaluation (10), Supabase, anything not in the README.

## Decisions

1. **Runtime.** `infra/docker-compose.yml` runs Mosquitto 2 + PostGIS 16 only. Server (Node 24, README says 20 — compatible) and simulator (Python 3.13 venv, README says 3.11) run on the host. `psql` / `mosquitto_passwd` are invoked via `docker compose exec`. TLS listener 8883; plain listener `127.0.0.1:1883` used by tests only.
2. **Device auth.** Usernames are `jeep-{id}` but topics use bare `{id}`, so Mosquitto pattern ACLs can't express it. `server/scripts/add-jeep.js` inserts the DB row (bcrypt token hash, random 32-byte SMS key), appends a per-user ACL block (`user jeep-{id}` / `topic write jeeptrack/v1/jeep/{id}/#`), runs `mosquitto_passwd -b` in the container, then reloads Mosquitto (SIGHUP). The server has its own user with `topic read jeeptrack/v1/jeep/#`.
3. **Protocol.** `protocol/test-vectors.json` is the single shared fixture; tests in `protocol/js` (node:test), `protocol/python` (pytest), `protocol/kotlin` (Kotlin/JVM Gradle project, wrapper pinned to Gradle 9.x + Kotlin 2.2 for JDK 25) all load it. Vectors include the SMS key used for HMAC cases.
4. **ETA engine.** Stop `route_m` precomputed in PostGIS (`ST_LineLocatePoint × ST_Length`). Live map-matching is pure JS: project the point onto the route polyline using a local equirectangular metric projection (error negligible over ~10 km). Per-segment EWMA speeds (α=0.3, 30-min window, default 15 km/h) and jeep state live in server memory. Algorithm documented in `docs/eta.md`.
5. **Route data.** Route LineString fetched once from the public OSRM router between BatStateU Alangilan and Batangas City Grand Terminal, saved to `data/route.geojson`. ~15 stops at landmarks or evenly spaced along it, all `verified=false`; logged in `docs/open-questions.md`.
6. **Verification.** Integration tests require `docker compose up -d`. `eval/eta_accuracy.py` compares predicted ETAs (sampled from the API) to simulator ground truth over a 30-min real-time synthetic run. PWA installability via `npx lighthouse` if headless Chrome is available; otherwise manual manifest/service-worker check, stated in `docs/stage-5.md`.

## Explicitly not built
No REST/WS auth for public read endpoints (README doesn't require it), no fares/seats/multi-route, no Supabase.
