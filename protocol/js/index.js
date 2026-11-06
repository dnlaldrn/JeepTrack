// JeepTrack wire protocol v1 — see ../SPEC.md
import { createHmac, timingSafeEqual } from 'node:crypto';

export const REPORT_LEN = 28;
export const MAX_BATCH = 200;

export class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// [field, min, max]
const RANGES = [
  ['version', 0, 0xff],
  ['jeep_id', 0, 0xffff],
  ['seq', 0, 0xffffffff],
  ['ts', 0, 0xffffffff],
  ['lat_e7', -900000000, 900000000],
  ['lon_e7', -1800000000, 1800000000],
  ['speed_cms', 0, 0xffff],
  ['heading_cdeg', 0, 35999],
  ['accuracy_dm', 0, Infinity], // clamped below
  ['flags', 0, 0xff],
];

export function encode(r) {
  for (const [k, min, max] of RANGES) {
    const v = r[k];
    if (!Number.isInteger(v) || v < min || v > max) throw new ProtocolError('range', `${k} out of range: ${v}`);
  }
  const b = Buffer.alloc(REPORT_LEN);
  b.writeUInt8(r.version, 0);
  b.writeUInt16BE(r.jeep_id, 1);
  b.writeUInt32BE(r.seq, 3);
  b.writeUInt32BE(r.ts, 7);
  b.writeInt32BE(r.lat_e7, 11);
  b.writeInt32BE(r.lon_e7, 15);
  b.writeUInt16BE(r.speed_cms, 19);
  b.writeUInt16BE(r.heading_cdeg, 21);
  b.writeUInt16BE(Math.min(r.accuracy_dm, 0xffff), 23);
  b.writeUInt8(r.flags, 25);
  b.writeUInt16BE(crc16(b.subarray(0, 26)), 26);
  return b;
}

export function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== REPORT_LEN) throw new ProtocolError('length', `expected ${REPORT_LEN} bytes, got ${b.length}`);
  if (b.readUInt8(0) !== 1) throw new ProtocolError('version', `unsupported version ${b.readUInt8(0)}`);
  if (crc16(b.subarray(0, 26)) !== b.readUInt16BE(26)) throw new ProtocolError('crc');
  return {
    version: b.readUInt8(0),
    jeep_id: b.readUInt16BE(1),
    seq: b.readUInt32BE(3),
    ts: b.readUInt32BE(7),
    lat_e7: b.readInt32BE(11),
    lon_e7: b.readInt32BE(15),
    speed_cms: b.readUInt16BE(19),
    heading_cdeg: b.readUInt16BE(21),
    accuracy_dm: b.readUInt16BE(23),
    flags: b.readUInt8(25),
  };
}

export function decodeBatch(buf) {
  const n = buf.length / REPORT_LEN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) throw new ProtocolError('length', `bad batch length ${buf.length}`);
  const out = [];
  for (let i = 0; i < n; i++) out.push(decode(buf.subarray(i * REPORT_LEN, (i + 1) * REPORT_LEN)));
  return out;
}

const hmac8 = (key, bytes) => createHmac('sha256', key).update(bytes).digest().subarray(0, 8);
const B64URL = /^[A-Za-z0-9_-]+$/;

export function smsEncode(r, key) {
  const bytes = encode(r);
  return `JT1:${bytes.toString('base64url')}:${hmac8(key, bytes).toString('base64url')}`;
}

export function smsDecode(text, keyFor) {
  if (typeof text !== 'string' || !text.startsWith('JT1:')) throw new ProtocolError('prefix');
  const parts = text.trim().split(':');
  if (parts.length !== 3 || parts[1].length !== 38 || parts[2].length !== 11 || !B64URL.test(parts[1]) || !B64URL.test(parts[2]))
    throw new ProtocolError('format');
  const bytes = Buffer.from(parts[1], 'base64url');
  const r = decode(bytes);
  const key = keyFor(r.jeep_id);
  if (!key) throw new ProtocolError('unknown_jeep', `unknown jeep ${r.jeep_id}`);
  if (!timingSafeEqual(hmac8(key, bytes), Buffer.from(parts[2], 'base64url'))) throw new ProtocolError('hmac');
  return r;
}
