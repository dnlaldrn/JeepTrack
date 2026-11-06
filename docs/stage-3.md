# Stage 3 — Fleet simulator

## Built
- `data/fetch_route.py`: builds `data/route.geojson` (OSRM driving route, 3.9 km) and `data/stops.csv` (15 stops, all `verified=false`). See `docs/open-questions.md` §1.
- `simulator/route.py`: planar route geometry (same projection as the server), `point_at`, `project`, GPS-noise offset.
- `simulator/fleet.py` + `simulator/seed_fleet.py`: registers jeeps 101–110 and keeps tokens + per-jeep `seq` in `simulator/.fleet.json` (gitignored). `seq` survives re-runs and re-seeds, so a second run is never silently de-duplicated away.
- `simulator/replay.py`:
  - **Synthetic mode:**
    - Each inter-stop segment gets a fixed base speed of 15–40 km/h (seed 42), times a ±20% factor per jeep, capped at 40 km/h.
    - Dwell is 10–60 s at each stop, with a 60 s layover at the terminal before a new trip from Alangilan. GPS noise σ = 5 m.
    - Ground truth arrivals go to `eval/out/truth-<unix>.csv`.
  - **Dead zone:** inside the zone, reports are buffered with flags bit0 and sent as a `/batch` on exit.
  - **Trace mode:** replays a CSV, optionally ×10 speed. All reports set flags bit1 (simulated).

## Run
```bash
.venv/Scripts/pip install -r simulator/requirements.txt
.venv/Scripts/python simulator/seed_fleet.py
(cd server && npm start) &
.venv/Scripts/python simulator/replay.py --jeeps 10 --interval 10 --minutes 5
(cd simulator && ../.venv/Scripts/python -m pytest)   # 5 pass
```

## Acceptance (2026-11-06)
- 10 jeeps × 5 min × every 10 s → **300 rows**, 300 distinct `(jeep_id, seq)`, 0 duplicates, 0 rejects. PASS.
- Dead zone 500–1500 m, 1 jeep, 5 min → 12 live + **18 `source='batch'`**. The run's seq span is 30 with 30 rows: no gaps. PASS.

## Known gaps
- Trace mode stamps reports with the current wall-clock time, not the trace's `ts`, so the live server treats them as fresh. The trace's original timing only controls replay pacing.
- The return leg is not simulated: after the terminal layover a jeep reappears at Alangilan.
