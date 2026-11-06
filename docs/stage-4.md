# Stage 4 — ETA engine and API

## Built
- `infra/db/migrations/002_route.sql` and `server/scripts/load-route.js`: loads the route and stops, and precomputes `stops.route_m` in PostGIS.
- `server/src/geo.js`: planar route projection.
- `server/src/eta.js`: the `EtaEngine` (algorithm in `docs/eta.md`).
- `server/src/api.js`:
  - REST: `GET /api/stops`, `/api/route`, `/api/jeeps`, `/api/etas?stop_id=`, `/healthz`.
  - `WS /ws`: pushes `pos` / `eta` messages, each with `server_sent_at`. Clients subscribe with `{"subscribe":{"stop_id":N}}`. A 10 s tick re-pushes so staleness updates without new points.
- `server/src/index.js`: one process for ingest, ETA engine, API and the static `web/`.
- `eval/eta_accuracy.py`: compares ETA predictions against simulator ground truth.

## Run
```bash
cd server && npm run migrate && node --env-file=../.env scripts/load-route.js && npm start
.venv/Scripts/python simulator/replay.py --jeeps 10 --minutes 35 &
sleep 90 && .venv/Scripts/python eval/eta_accuracy.py --minutes 30
```

## Acceptance
- Unit tests (hand-computed map-matching and ETA cases): geo 5/5, eta 12/12, api 8/8. PASS.
- Live: with the simulator running, `/api/etas?stop_id=15` listed all 10 jeeps in ETA order. PASS.
- **ETA MAE ≤ 2 min over a 30-min synthetic run: PENDING.** The first attempt (2026-11-06) was killed about 7 minutes in because the PC ran out of memory. Result to be recorded here.

## Known gaps
- In a browser check, one ETA dropped from 4 to 2 min within 12 s. The segment EWMA may swing when jeeps are dwelling at stops. The MAE run will tell whether it needs tuning.
- `GET /api/route` was added beyond the README's API list; the PWA needs it to draw the route line.
