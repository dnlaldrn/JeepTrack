// Requires: docker compose up, migrations applied, .env loaded (npm run test:integration).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';
import { encode } from '../../../protocol/js/index.js';
import { makePool } from '../../src/db.js';
import { registerJeep } from '../../src/jeeps.js';
import { startIngest } from '../../src/ingest.js';

const pool = makePool();
let ingest, jeep, token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (seq, jeep_id = 9001) => encode({ version: 1, jeep_id, seq, ts: Math.floor(Date.now() / 1000), lat_e7: 137840000, lon_e7: 1210740000, speed_cms: 500, heading_cdeg: 18000, accuracy_dm: 50, flags: 2 });
const count = async (id) => Number((await pool.query('SELECT count(*) FROM positions WHERE jeep_id = $1', [id])).rows[0].count);

async function settle() {
  let last = -1;
  for (;;) {
    await sleep(2000);
    await ingest.idle();
    const now = Object.values(ingest.counters).reduce((a, b) => a + b, 0);
    if (now === last) return;
    last = now;
  }
}

before(async () => {
  await pool.query('DELETE FROM positions WHERE jeep_id IN (9001, 9002)');
  ({ token } = await registerJeep(pool, { id: 9001, plate: 'IT-9001' }));
  await registerJeep(pool, { id: 9002, plate: 'IT-9002' });
  await sleep(500); // broker reload after SIGHUP
  ingest = startIngest({ pool, emitter: new EventEmitter(), clientId: 'jeeptrack-server-it' });
  await new Promise((r) => ingest.once('connect', r));
  await sleep(300); // subscription
  jeep = await mqtt.connectAsync(process.env.MQTT_TEST_URL, { username: 'jeep-9001', password: token, clientId: 'jeep-9001', protocolVersion: 5 });
});

after(async () => {
  await jeep?.endAsync();
  await ingest?.endAsync();
  await pool.end();
});

test('100 reports + 20 duplicates + 5 corrupted → 100 rows, 5 rejected', async () => {
  await settle(); // drain messages the persistent test session queued since the last run
  const before = { ...ingest.counters };
  const pubs = [];
  for (let s = 1; s <= 100; s++) pubs.push(jeep.publishAsync('jeeptrack/v1/jeep/9001/pos', report(s), { qos: 1 }));
  for (let s = 1; s <= 20; s++) pubs.push(jeep.publishAsync('jeeptrack/v1/jeep/9001/pos', report(s), { qos: 1 }));
  for (let s = 101; s <= 105; s++) { const b = report(s); b[27] ^= 0xff; pubs.push(jeep.publishAsync('jeeptrack/v1/jeep/9001/pos', b, { qos: 1 })); }
  await Promise.all(pubs);
  await settle();
  assert.equal(await count(9001), 100);
  assert.equal(ingest.counters.rejected - before.rejected, 5);
  // stored vs duplicate split depends on whether a live server is also subscribed and inserting; their sum doesn't.
  assert.equal(ingest.counters.stored + ingest.counters.duplicate - before.stored - before.duplicate, 120);
});

test("publishing to another device's topic is refused by the broker ACL", async () => {
  let reasonCode;
  try {
    const ack = await jeep.publishAsync('jeeptrack/v1/jeep/9002/pos', report(1, 9002), { qos: 1 });
    reasonCode = ack?.reasonCode;
  } catch (e) {
    reasonCode = e.code;
  }
  await sleep(2000);
  assert.equal(await count(9002), 0, 'no row stored for 9002');
  assert.ok(reasonCode === undefined || reasonCode >= 0x80, `expected not-authorized PUBACK, got ${reasonCode}`);
});
