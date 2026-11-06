# Open questions

Items the README leaves ambiguous or blocked, with the fallback in use. Resolve with the team, then update the data or code.

## 1. Route geometry and stop coordinates (Stage 3) — fallback in use
- **Blocked on:** verified jeepney route + real stop list from the team.
- **Fallback used (2026-11-06):** `data/fetch_route.py`.
  - Endpoints geocoded with Nominatim:
    - BatStateU Alangilan → 13.7842948, 121.0742800
    - Batangas City Grand Terminal → 13.7895607, 121.0626962
  - Route = the OSRM public router's fastest *driving* path (3.9 km via National Highway → Diversion Road). This may not be the jeepney's actual path.
  - 15 stops are spaced evenly (~280 m apart) along that line, named after the nearest road. All `verified=false`.
- **To fix:** replace `data/route.geojson` / `data/stops.csv` (same columns), set `verified=true`, re-run `server/scripts/load-route.js`.

## 2. Direction (Stage 4/5)
- Only Alangilan → Grand Terminal (inbound) is modeled. The kiosk's "outbound" column shows "Outbound not tracked yet".
- Simulated jeeps return to Alangilan off-route after each trip. The server treats a large backwards jump in route position as a new trip.
- **Question:** is the return leg the same road reversed? If so, it needs a second route + stops.

## 3. Runtime versions
- The README says Node 20 / Python 3.11; this machine has Node 24 / Python 3.13. Nothing used is version-specific beyond Node ≥ 20 and Python ≥ 3.11.
