import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, projectToRoute, pointAt } from '../src/geo.js';

const route = buildRoute([[121, 13.7], [121, 13.709]]);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} not within ${tol} of ${b}`);

test('route length in meters', () => near(route.lengthM, 1000.8, 1, 'length'));

test('projects an off-line point onto the route', () => {
  const { routeM, distM } = projectToRoute(route, 13.7045, 121.0001);
  near(routeM, 500.4, 1, 'routeM');
  near(distM, 10.8, 0.5, 'distM');
});

test('point before the start clamps to 0', () => {
  assert.equal(projectToRoute(route, 13.691, 121).routeM, 0);
});

test('pointAt round-trips through projection', () => {
  const p = pointAt(route, 500.4);
  const back = projectToRoute(route, p.lat, p.lon);
  near(back.routeM, 500.4, 0.5, 'routeM');
  near(back.distM, 0, 0.5, 'distM');
});

test('multi-segment route picks the nearest segment', () => {
  const l = buildRoute([[121, 13.7], [121, 13.709], [121.009, 13.709]]); // north then east
  const p = pointAt(l, 1500);
  near(projectToRoute(l, p.lat, p.lon).routeM, 1500, 0.5, 'routeM on 2nd segment');
});
