// Live ETA engine — algorithm in docs/eta.md. All state is in memory; it rebuilds from new points after a restart.
import { projectToRoute } from './geo.js';

const MAX_MATCH_DIST_M = 40;
const MAX_SAMPLE_GAP_S = 120;
const NEW_TRIP_BACKJUMP_M = 500;
const MIN_MOVING_MPS = 0.5;

export class EtaEngine {
  constructor({ route, stops, defaultMps = 15 / 3.6, alpha = 0.3, windowMs = 1_800_000, dwellS = 20, staleMs = 60_000, hideMs = 600_000, minMps = 1 }) {
    this.route = route;
    this.stops = [...stops].sort((a, b) => a.order_no - b.order_no);
    this.stopIndex = new Map(this.stops.map((s, i) => [s.id, i]));
    this.s = this.stops.map((st) => st.route_m);
    Object.assign(this, { defaultMps, alpha, windowMs, dwellS, staleMs, hideMs, minMps });
    this.seg = new Array(Math.max(1, this.s.length - 1)).fill(null); // {v, at}
    this.jeepState = new Map();
  }

  segmentOf(x) {
    let i = 0;
    while (i < this.s.length - 2 && x >= this.s[i + 1]) i++;
    return i;
  }

  segmentSpeed(i, nowMs) {
    const e = this.seg[i];
    const v = e && nowMs - e.at <= this.windowMs ? e.v : this.defaultMps;
    return Math.max(this.minMps, v);
  }

  update(row, nowMs) {
    if (!row.eta_eligible) return null;
    const tsMs = row.ts.getTime();
    const prev = this.jeepState.get(row.jeep_id);
    if (prev && tsMs <= prev.lastTs) return null; // late/backfilled point: stored, but no effect on live state
    const { routeM, distM } = projectToRoute(this.route, row.lat, row.lon);
    if (distM > MAX_MATCH_DIST_M) return null;

    if (prev && routeM >= prev.routeM - NEW_TRIP_BACKJUMP_M) {
      const dt = (tsMs - prev.lastTs) / 1000;
      // Dwell is covered by the fixed per-stop term, so only moving samples feed segment speed.
      const moving = !(row.speed_mps < MIN_MOVING_MPS);
      if (moving && dt > 0 && dt <= MAX_SAMPLE_GAP_S && routeM >= prev.routeM) {
        const v = (routeM - prev.routeM) / dt;
        const i = this.segmentOf((routeM + prev.routeM) / 2);
        const e = this.seg[i];
        this.seg[i] = { v: e && nowMs - e.at <= this.windowMs ? this.alpha * v + (1 - this.alpha) * e.v : v, at: nowMs };
      }
    } // else: first point, or a big backwards jump = new trip → no speed sample

    const st = { routeM, lastTs: tsMs, lastSeen: nowMs, lat: row.lat, lon: row.lon, speed: row.speed_mps };
    this.jeepState.set(row.jeep_id, st);
    return this.view(row.jeep_id, st, nowMs);
  }

  view(jeep_id, st, nowMs) {
    return { jeep_id, lat: st.lat, lon: st.lon, route_m: st.routeM, speed: st.speed, last_seen: st.lastSeen, stale: nowMs - st.lastSeen > this.staleMs };
  }

  visible(nowMs) {
    return [...this.jeepState].filter(([, st]) => nowMs - st.lastSeen <= this.hideMs);
  }

  jeeps(nowMs) {
    return this.visible(nowMs).map(([id, st]) => this.view(id, st, nowMs));
  }

  etaSeconds(x, k, nowMs) {
    const i = this.segmentOf(x);
    let t = (this.s[i + 1] - x) / this.segmentSpeed(i, nowMs);
    for (let j = i + 1; j < k; j++) t += (this.s[j + 1] - this.s[j]) / this.segmentSpeed(j, nowMs);
    return t + this.dwellS * Math.max(0, k - 1 - i);
  }

  etasForStop(stopId, nowMs) {
    const k = this.stopIndex.get(stopId);
    if (k === undefined) throw new Error(`unknown stop ${stopId}`);
    return this.visible(nowMs)
      .filter(([, st]) => st.routeM < this.s[k])
      .map(([jeep_id, st]) => ({ jeep_id, eta_s: Math.round(this.etaSeconds(st.routeM, k, nowMs)), stale: nowMs - st.lastSeen > this.staleMs }))
      .sort((a, b) => a.eta_s - b.eta_s);
  }
}
