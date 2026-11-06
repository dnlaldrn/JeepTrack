import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestStop, haversineM } from '../geo.js';

const stops = [
  { id: 1, lat: 13.7843, lon: 121.0743 },
  { id: 2, lat: 13.7870, lon: 121.0690 },
  { id: 3, lat: 13.7896, lon: 121.0627 },
];

test('nearestStop picks the closest stop', () => {
  assert.equal(nearestStop(stops, 13.7868, 121.0695).id, 2);
  assert.equal(nearestStop(stops, 13.79, 121.06).id, 3);
});

test('haversine ~111 m per 0.001° latitude', () => {
  const d = haversineM(13.7, 121, 13.701, 121);
  assert.ok(Math.abs(d - 111.2) < 0.5, String(d));
});
