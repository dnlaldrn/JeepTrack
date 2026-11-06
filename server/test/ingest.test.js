import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../protocol/js/index.js';
import { handleMessage, toRow } from '../src/ingest.js';

const base = { version: 1, jeep_id: 101, seq: 1, ts: 1794000000, lat_e7: 137840000, lon_e7: 1210740000, speed_cms: 833, heading_cdeg: 18050, accuracy_dm: 50, flags: 0 };
const POS = 'jeeptrack/v1/jeep/101/pos';
const BATCH = 'jeeptrack/v1/jeep/101/batch';

function fakeDeps() {
  const seen = new Set();
  const emitted = [];
  return {
    emitted,
    insert: async (rows) => rows.filter((r) => { const k = `${r.jeep_id}:${r.seq}`; if (seen.has(k)) return false; seen.add(k); return true; }),
    emit: (row) => emitted.push(row),
  };
}

test('valid pos is stored and emitted as eta-eligible', async () => {
  const d = fakeDeps();
  assert.deepEqual(await handleMessage(POS, encode(base), d), { received: 1, stored: 1, duplicate: 0, rejected: 0 });
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].eta_eligible, true);
  assert.equal(d.emitted[0].source, 'mqtt');
});

test('duplicate seq counts as duplicate and is not emitted', async () => {
  const d = fakeDeps();
  await handleMessage(POS, encode(base), d);
  assert.deepEqual(await handleMessage(POS, encode(base), d), { received: 1, stored: 0, duplicate: 1, rejected: 0 });
  assert.equal(d.emitted.length, 1);
});

test('corrupted CRC is rejected', async () => {
  const bad = encode(base); bad[27] ^= 0xff;
  assert.equal((await handleMessage(POS, bad, fakeDeps())).rejected, 1);
});

test('topic jeep_id must match payload jeep_id', async () => {
  const d = fakeDeps();
  assert.equal((await handleMessage('jeeptrack/v1/jeep/102/pos', encode(base), d)).rejected, 1);
  assert.equal(d.emitted.length, 0);
});

test('non-numeric topic id is rejected', async () => {
  assert.equal((await handleMessage('jeeptrack/v1/jeep/abc/pos', encode(base), fakeDeps())).rejected, 1);
});

test('batch of 3 stored with source batch', async () => {
  const d = fakeDeps();
  const buf = Buffer.concat([1, 2, 3].map((seq) => encode({ ...base, seq, flags: 1 })));
  assert.deepEqual(await handleMessage(BATCH, buf, d), { received: 3, stored: 3, duplicate: 0, rejected: 0 });
  assert.ok(d.emitted.every((r) => r.source === 'batch'));
});

test('batch with bad length is rejected whole', async () => {
  assert.equal((await handleMessage(BATCH, Buffer.alloc(29), fakeDeps())).rejected, 1);
});

test('batch with one report for another jeep is rejected whole', async () => {
  const d = fakeDeps();
  const buf = Buffer.concat([encode(base), encode({ ...base, jeep_id: 102, seq: 2 })]);
  assert.equal((await handleMessage(BATCH, buf, d)).rejected, 1);
  assert.equal(d.emitted.length, 0);
});

test('low-accuracy point is stored but not eta-eligible', async () => {
  const d = fakeDeps();
  await handleMessage(POS, encode({ ...base, accuracy_dm: 400 }), d);
  assert.equal(d.emitted[0].eta_eligible, false);
  assert.equal(d.emitted[0].accuracy_m, 40);
});

test('DB failure (e.g. unknown jeep FK) counts as rejected, does not throw', async () => {
  const d = { insert: async () => { throw Object.assign(new Error('fk'), { code: '23503' }); }, emit: () => {} };
  assert.equal((await handleMessage(POS, encode(base), d)).rejected, 1);
});

test('toRow converts wire units', () => {
  const r = toRow({ ...base, speed_cms: 1234, heading_cdeg: 9050, accuracy_dm: 55 }, 'mqtt');
  assert.equal(r.speed_mps, 12.34);
  assert.equal(r.heading_deg, 90.5);
  assert.equal(r.accuracy_m, 5.5);
  assert.equal(r.lat, 13.784);
  assert.equal(r.lon, 121.074);
  assert.equal(r.ts.toISOString(), new Date(1794000000 * 1000).toISOString());
});
