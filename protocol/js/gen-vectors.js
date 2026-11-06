// Regenerates ../test-vectors.json from this codec. Python and Kotlin must reproduce it byte-for-byte.
import { writeFileSync } from 'node:fs';
import { encode, crc16, smsEncode } from './index.js';

const key101 = Buffer.from([...Array(32).keys()]); // 00 01 .. 1f
const key102 = Buffer.alloc(32, 0xab);
const base = { version: 1, jeep_id: 101, seq: 1, ts: 1794000000, lat_e7: 137840000, lon_e7: 1210740000, speed_cms: 833, heading_cdeg: 18050, accuracy_dm: 50, flags: 0 };

const reports = [
  ['normal Batangas point', base],
  ['moving fast north', { ...base, seq: 2, speed_cms: 1111, heading_cdeg: 0, accuracy_dm: 120 }],
  ['negative lat/lon', { ...base, seq: 3, lat_e7: -337000000, lon_e7: -706000000 }],
  ['min negative lat/lon', { ...base, seq: 4, lat_e7: -900000000, lon_e7: -1800000000 }],
  ['all max values', { version: 1, jeep_id: 65535, seq: 4294967295, ts: 4294967295, lat_e7: 900000000, lon_e7: 1800000000, speed_cms: 65535, heading_cdeg: 35999, accuracy_dm: 65535, flags: 3 }],
  ['all zero', { version: 1, jeep_id: 0, seq: 0, ts: 0, lat_e7: 0, lon_e7: 0, speed_cms: 0, heading_cdeg: 0, accuracy_dm: 0, flags: 0 }],
  ['flag offline buffer', { ...base, seq: 5, flags: 1 }],
  ['flag simulated', { ...base, seq: 6, flags: 2 }],
  ['flags both', { ...base, seq: 7, flags: 3 }],
  ['other jeep', { ...base, jeep_id: 102, seq: 99, heading_cdeg: 27000 }],
  ['big seq near terminal', { ...base, seq: 123456789, lat_e7: 137565000, lon_e7: 1210580000, speed_cms: 0 }],
].map(([name, fields]) => ({ name, fields, hex: encode(fields).toString('hex') }));

const good = encode(base);
const flipCrc = Buffer.from(good); flipCrc[27] ^= 0xff;
const v2 = Buffer.from(good); v2[0] = 2; v2.writeUInt16BE(crc16(v2.subarray(0, 26)), 26);
const flipBody = Buffer.from(good); flipBody[12] ^= 0x01;

const bad_reports = [
  { name: 'corrupted crc', hex: flipCrc.toString('hex'), error: 'crc' },
  { name: 'corrupted body byte', hex: flipBody.toString('hex'), error: 'crc' },
  { name: 'version 2', hex: v2.toString('hex'), error: 'version' },
  { name: '27 bytes', hex: good.subarray(0, 27).toString('hex'), error: 'length' },
  { name: '29 bytes', hex: Buffer.concat([good, Buffer.from([0])]).toString('hex'), error: 'length' },
];

const sms = [
  ['normal', reports[0].fields],
  ['offline flag', reports[6].fields],
  ['jeep 102', reports[9].fields],
].map(([name, fields]) => ({ name, fields, text: smsEncode(fields, fields.jeep_id === 102 ? key102 : key101) }));

const goodSms = sms[0].text;
const [, body, mac] = goodSms.split(':');
const macBytes = Buffer.from(mac, 'base64url'); macBytes[0] ^= 0x01;
const unknown = smsEncode({ ...base, jeep_id: 999 }, key101);
const bad_sms = [
  { name: 'bad hmac', text: `JT1:${body}:${macBytes.toString('base64url')}`, error: 'hmac' },
  { name: 'wrong key (102 key on 101 report)', text: smsEncode(base, key102), error: 'hmac' },
  { name: 'wrong prefix', text: goodSms.replace('JT1:', 'JT2:'), error: 'prefix' },
  { name: 'unknown jeep', text: unknown, error: 'unknown_jeep' },
  { name: 'missing hmac part', text: `JT1:${body}`, error: 'format' },
  { name: 'truncated body', text: `JT1:${body.slice(0, 37)}:${mac}`, error: 'format' },
  { name: 'corrupted crc inside sms', text: `JT1:${flipCrc.toString('base64url')}:${mac}`, error: 'crc' },
];

const out = {
  sms_keys: { 101: key101.toString('hex'), 102: key102.toString('hex') },
  crc_check: { ascii: '123456789', crc: 0x29b1 },
  reports, bad_reports, sms, bad_sms,
};
writeFileSync(new URL('../test-vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${reports.length} reports, ${bad_reports.length} bad reports, ${sms.length} sms, ${bad_sms.length} bad sms`);
