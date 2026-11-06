import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, encode, decode, decodeBatch, smsEncode, smsDecode, ProtocolError } from '../index.js';

const V = JSON.parse(readFileSync(new URL('../../test-vectors.json', import.meta.url)));
const keys = Object.fromEntries(Object.entries(V.sms_keys).map(([id, hex]) => [id, Buffer.from(hex, 'hex')]));
const keyFor = (id) => keys[id] ?? null;
const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof ProtocolError && e.code === code, `expected ProtocolError(${code})`);
const ok = V.reports[0].fields;

test('crc16 check value', () => {
  assert.equal(crc16(Buffer.from(V.crc_check.ascii)), V.crc_check.crc);
  assert.equal(crc16(Buffer.from('123456789')), 0x29b1);
});

test('vectors have the minimum cases', () => {
  assert.ok(V.reports.length >= 10);
  assert.ok(V.bad_reports.length >= 3 && V.bad_sms.length >= 5);
});

for (const v of V.reports) {
  test(`report encode/decode: ${v.name}`, () => {
    assert.equal(encode(v.fields).toString('hex'), v.hex);
    assert.deepEqual(decode(Buffer.from(v.hex, 'hex')), v.fields);
  });
}

for (const v of V.bad_reports) {
  test(`bad report: ${v.name}`, () => throwsCode(() => decode(Buffer.from(v.hex, 'hex')), v.error));
}

for (const v of V.sms) {
  test(`sms encode/decode: ${v.name}`, () => {
    const text = smsEncode(v.fields, keys[v.fields.jeep_id]);
    assert.equal(text, v.text);
    assert.equal(text.length, 54);
    assert.deepEqual(smsDecode(v.text, keyFor), v.fields);
  });
}

for (const v of V.bad_sms) {
  test(`bad sms: ${v.name}`, () => throwsCode(() => smsDecode(v.text, keyFor), v.error));
}

test('decodeBatch splits concatenated reports', () => {
  const buf = Buffer.concat(V.reports.slice(0, 3).map((v) => Buffer.from(v.hex, 'hex')));
  assert.deepEqual(decodeBatch(buf), V.reports.slice(0, 3).map((v) => v.fields));
});

test('decodeBatch rejects bad lengths', () => {
  throwsCode(() => decodeBatch(Buffer.alloc(29)), 'length');
  throwsCode(() => decodeBatch(Buffer.alloc(0)), 'length');
  const one = encode(ok);
  throwsCode(() => decodeBatch(Buffer.concat(Array(201).fill(one))), 'length');
  assert.equal(decodeBatch(Buffer.concat(Array(200).fill(one))).length, 200);
});

test('decodeBatch rejects the whole batch on one bad report', () => {
  const bad = Buffer.from(V.bad_reports.find((b) => b.error === 'crc').hex, 'hex');
  throwsCode(() => decodeBatch(Buffer.concat([encode(ok), bad])), 'crc');
});

test('encode range checks', () => {
  throwsCode(() => encode({ ...ok, heading_cdeg: 36000 }), 'range');
  throwsCode(() => encode({ ...ok, lat_e7: 900000001 }), 'range');
  throwsCode(() => encode({ ...ok, lon_e7: -1800000001 }), 'range');
  throwsCode(() => encode({ ...ok, seq: 2 ** 32 }), 'range');
  throwsCode(() => encode({ ...ok, seq: 1.5 }), 'range');
});

test('encode clamps accuracy to 65535', () => {
  assert.equal(decode(encode({ ...ok, accuracy_dm: 70000 })).accuracy_dm, 65535);
});
