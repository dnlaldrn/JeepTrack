import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, pointAt } from '../src/geo.js';
import { EtaEngine } from '../src/eta.js';

// Straight ~2000 m route north; stops at 0 / 1000 / 2000 m.
const route = buildRoute([[121, 13.7], [121, 13.718]]);
const stops = [0, 1000, 2000].map((m, i) => ({ id: i + 1, name: `S${i + 1}`, order_no: i + 1, route_m: m, ...pointAt(route, m) }));
const DEFAULT = 15 / 3.6;
const T0 = 1_800_000_000_000;
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

let seq = 0;
function row(m, tsMs, extra = {}) {
  const p = pointAt(route, m);
  return { jeep_id: 101, seq: ++seq, ts: new Date(tsMs), lat: p.lat, lon: p.lon, speed_mps: 5, accuracy_m: 5, source: 'mqtt', eta_eligible: true, ...extra };
}
const engine = () => new EtaEngine({ route, stops });
const etaTo = (e, stopId, now) => e.etasForStop(stopId, now).find((x) => x.jeep_id === 101)?.eta_s;

test('ETA with default speeds: 500 m → stop 3 = 120 + 240 + 20 dwell = 380 s', () => {
  const e = engine();
  e.update(row(500, T0), T0);
  near(etaTo(e, 3, T0), 500 / DEFAULT + 1000 / DEFAULT + 20);
  near(etaTo(e, 3, T0), 380);
});

test('ETA to the next stop has no dwell: 120 s', () => {
  const e = engine();
  e.update(row(500, T0), T0);
  near(etaTo(e, 2, T0), 120);
});

test('stops behind the jeep do not list it', () => {
  const e = engine();
  e.update(row(500, T0), T0);
  assert.equal(etaTo(e, 1, T0), undefined);
});

test('first observed speed seeds the segment EWMA, later ones blend with α = 0.3', () => {
  const e = engine();
  e.update(row(100, T0), T0);
  e.update(row(200, T0 + 10_000), T0 + 10_000);
  near(e.segmentSpeed(0, T0 + 10_000), 10, 0.05);
  e.update(row(250, T0 + 20_000), T0 + 20_000);
  near(e.segmentSpeed(0, T0 + 20_000), 0.3 * 5 + 0.7 * 10, 0.05); // 8.5
});

test('segment speed older than 30 min falls back to default', () => {
  const e = engine();
  e.update(row(100, T0), T0);
  e.update(row(200, T0 + 10_000), T0 + 10_000);
  near(e.segmentSpeed(0, T0 + 10_000 + 31 * 60_000), DEFAULT, 0.01);
});

test('segment speed never drops below the 1 m/s floor', () => {
  const e = engine();
  e.update(row(100, T0), T0);
  e.update(row(100.5, T0 + 10_000), T0 + 10_000);
  near(e.segmentSpeed(0, T0 + 10_000), 1, 0.001);
});

test('out-of-order point (ts <= last) is ignored and does not move the jeep back', () => {
  const e = engine();
  e.update(row(800, T0), T0);
  assert.equal(e.update(row(300, T0 - 5_000), T0 + 1_000), null);
  near(e.jeeps(T0 + 1_000)[0].route_m, 800);
  near(e.segmentSpeed(0, T0 + 1_000), DEFAULT, 0.01);
});

test('large backwards jump starts a new trip without a speed sample', () => {
  const e = engine();
  e.update(row(1900, T0), T0);
  e.update(row(50, T0 + 10_000), T0 + 10_000);
  near(e.segmentSpeed(0, T0 + 10_000), DEFAULT, 0.01);
  near(e.segmentSpeed(1, T0 + 10_000), DEFAULT, 0.01);
  near(etaTo(e, 3, T0 + 10_000), 950 / DEFAULT + 1000 / DEFAULT + 20);
});

test('point more than 40 m off the route is ignored', () => {
  const e = engine();
  const p = pointAt(route, 500);
  assert.equal(e.update({ ...row(500, T0), lon: p.lon + 50 / (6371008.8 * Math.cos((13.7 * Math.PI) / 180)) * (180 / Math.PI) }, T0), null);
  assert.equal(e.jeeps(T0).length, 0);
});

test('non-eta-eligible point (accuracy > 30 m) is ignored', () => {
  const e = engine();
  assert.equal(e.update(row(500, T0, { eta_eligible: false, accuracy_m: 45 }), T0), null);
  assert.equal(e.jeeps(T0).length, 0);
});

test('stale after 60 s, hidden after 10 min', () => {
  const e = engine();
  e.update(row(500, T0), T0);
  assert.equal(e.jeeps(T0 + 61_000)[0].stale, true);
  assert.equal(e.etasForStop(3, T0 + 61_000)[0].stale, true);
  assert.equal(e.jeeps(T0 + 59_000)[0].stale, false);
  assert.equal(e.jeeps(T0 + 601_000).length, 0);
  assert.equal(e.etasForStop(3, T0 + 601_000).length, 0);
});

test('etasForStop sorts by eta and rejects unknown stops', () => {
  const e = engine();
  e.update(row(500, T0), T0);
  e.update({ ...row(1500, T0), jeep_id: 102 }, T0);
  assert.deepEqual(e.etasForStop(3, T0).map((x) => x.jeep_id), [102, 101]);
  assert.throws(() => e.etasForStop(99, T0), /unknown stop/);
});

test('dwelling jeep (reported speed < 0.5 m/s) does not drag the segment speed down', () => {
  const e = engine();
  e.update(row(100, T0), T0);
  e.update(row(200, T0 + 10_000), T0 + 10_000); // seeds segment 0 at 10 m/s
  e.update(row(203, T0 + 20_000, { speed_mps: 0.1 }), T0 + 20_000); // stopped, GPS noise moved it 3 m
  e.update(row(205, T0 + 30_000, { speed_mps: 0 }), T0 + 30_000);
  near(e.segmentSpeed(0, T0 + 30_000), 10, 0.05);
  near(e.jeeps(T0 + 30_000)[0].route_m, 205, 0.5); // position still updates
});
