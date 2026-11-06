import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { buildRoute, pointAt } from '../src/geo.js';
import { EtaEngine } from '../src/eta.js';
import { createApi } from '../src/api.js';

const coords = [[121, 13.7], [121, 13.718]];
const route = buildRoute(coords);
const stops = [0, 1000, 2000].map((m, i) => ({ id: i + 1, name: `S${i + 1}`, order_no: i + 1, route_m: m, verified: false, ...pointAt(route, m) }));
const emitter = new EventEmitter();
const engine = new EtaEngine({ route, stops });
let server, wss, base, seq = 0;

const pos = (m, jeep_id = 101) => ({ jeep_id, seq: ++seq, ts: new Date(), ...pointAt(route, m), speed_mps: 5, accuracy_m: 5, source: 'mqtt', eta_eligible: true });
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

function openWs() {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.inbox = [];
  ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
  return new Promise((r) => ws.on('open', () => r(ws)));
}
async function waitFor(ws, pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = ws.inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for message');
}

before(async () => {
  const api = createApi({ engine, stops, routeGeoJson: { type: 'LineString', coordinates: coords }, emitter, tickMs: 0 });
  server = http.createServer(api.app);
  wss = api.attachWs(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(); });

test('GET /healthz', async () => {
  assert.deepEqual(await get('/healthz'), { status: 200, body: { ok: true } });
});

test('GET /api/stops and /api/route', async () => {
  const s = await get('/api/stops');
  assert.equal(s.body.length, 3);
  assert.deepEqual(Object.keys(s.body[0]).sort(), ['id', 'lat', 'lon', 'name', 'order_no', 'route_m', 'verified']);
  assert.equal((await get('/api/route')).body.type, 'LineString');
});

test('GET /api/etas after a position at 500 m', async () => {
  emitter.emit('position', pos(500));
  const { status, body } = await get('/api/etas?stop_id=3');
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].jeep_id, 101);
  assert.ok(Math.abs(body[0].eta_s - 380) <= 1);
  assert.equal(body[0].stale, false);
});

test('GET /api/etas with unknown or missing stop → 400', async () => {
  assert.deepEqual(await get('/api/etas?stop_id=99'), { status: 400, body: { error: 'unknown stop_id' } });
  assert.equal((await get('/api/etas')).status, 400);
});

test('GET /api/jeeps returns ISO last_seen', async () => {
  const { body } = await get('/api/jeeps');
  assert.ok(body.length >= 1);
  assert.ok(!Number.isNaN(Date.parse(body[0].last_seen)));
});

test('WS: subscribed client gets pos + eta with server_sent_at', async () => {
  const ws = await openWs();
  ws.send(JSON.stringify({ subscribe: { stop_id: 3 } }));
  await waitFor(ws, (m) => m.type === 'eta'); // immediate answer to subscribe
  ws.inbox.length = 0;
  emitter.emit('position', pos(600));
  const p = await waitFor(ws, (m) => m.type === 'pos');
  const e = await waitFor(ws, (m) => m.type === 'eta');
  assert.equal(p.jeep_id, 101);
  assert.equal(e.stop_id, 3);
  assert.ok(Date.parse(p.server_sent_at) && Date.parse(e.server_sent_at));
  ws.close();
});

test('WS: malformed input is ignored and the socket stays usable', async () => {
  const ws = await openWs();
  ws.send('not json');
  ws.send(JSON.stringify({ subscribe: { stop_id: 99 } }));
  ws.send(JSON.stringify({ subscribe: 'x' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ws.readyState, WebSocket.OPEN);
  emitter.emit('position', pos(700));
  await waitFor(ws, (m) => m.type === 'pos');
  assert.ok(!ws.inbox.some((m) => m.type === 'eta'), 'no eta for an invalid subscription');
  ws.close();
});

test('ignored position (off-route) is not broadcast', async () => {
  const ws = await openWs();
  await new Promise((r) => setTimeout(r, 100));
  ws.inbox.length = 0; // drop the on-connect snapshot of current jeeps
  emitter.emit('position', { ...pos(700), lon: 121.01 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ws.inbox.filter((m) => m.type === 'pos').length, 0);
  ws.close();
});
