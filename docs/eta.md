# ETA algorithm (server/src/eta.js)

The design is deliberately simple. All state is in server memory and rebuilds from new points after a restart.

## Inputs
- Route polyline in planar meters (`server/src/geo.js`: equirectangular around the first vertex).
- Stops with `route_m` precomputed in PostGIS (`ST_LineLocatePoint × ST_Length`).
- Every newly stored position from ingest (duplicates never reach the engine).

## Per point
1. **Filter.** Ignore the point for ETA if accuracy > 30 m (it's still stored), or if its GPS `ts` ≤ the jeep's latest `ts`. That second case covers late SMS and batch backfill after a dead zone: those points fill in history but must not move the live jeep backwards.
2. **Map-match.** Project the point onto the route to get `route_m`. Ignore it if it's more than 40 m from the line.
3. **New trip.** If `route_m` dropped by more than 500 m since the last point, the jeep started a new trip. Take no speed sample.
4. **Speed sample.** If the previous point is ≤ 120 s older, the jeep didn't move backwards, and it is moving (reported GPS speed ≥ 0.5 m/s):
   - `v = Δroute_m / Δt`, attributed to the segment containing the midpoint of the two positions.
   - That segment's EWMA becomes `0.3·v + 0.7·old`. If the segment has no sample in the last 30 min, `v` seeds it.
   - Samples are pooled from all jeeps.

## ETA
A segment's speed is its EWMA if updated in the last 30 min, otherwise 15 km/h, with a floor of 1 m/s. For a jeep at `x` inside segment `i` (between stops `i` and `i+1`), the ETA to stop `k` ahead is:

    (s[i+1] − x)/v(i) + Σ_{j=i+1}^{k−1} (s[j+1] − s[j])/v(j) + 20 s × (k − 1 − i)

Here `20 s × (k − 1 − i)` is the dwell at each intermediate stop. Only jeeps with `route_m < stop.route_m` are listed.

## Staleness
- No update for 60 s → `stale: true` (the UI shows "last seen N min ago").
- No update for 10 min → hidden from `/api/jeeps`, `/api/etas` and WS pushes.

Points from a jeep standing still (dwelling at a stop, or the terminal layover) still update its position but are not speed samples. Otherwise each would multiply the segment's EWMA by about 0.7, and dwell would be counted twice (the formula already adds 20 s per stop). In the final review's offline simulation, this guard cut ETA MAE from about 1.06–1.33 min to about 0.8 min.

## Shortcuts
- `shortcut: 1 m/s speed floor` keeps a jeep dwelling at a stop from producing an infinite ETA. Revisit if MAE suffers at stops.
- `shortcut: planar geometry`. Under 0.3% length error on the 3.9 km route (PostGIS 3906 m vs planar 3915 m). Use geodesic math if routes exceed ~50 km.

## Measured accuracy
See `docs/stage-4.md`.
