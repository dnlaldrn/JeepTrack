import { readFileSync } from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import { decode, decodeBatch } from '../../protocol/js/index.js';
import { insertPositions } from './db.js';
import { log } from './log.js';

const TOPIC = /^jeeptrack\/v1\/jeep\/(\d+)\/(pos|batch)$/;
const ETA_MAX_ACCURACY_M = 30;

export function toRow(r, source) {
  return {
    jeep_id: r.jeep_id,
    seq: r.seq,
    ts: new Date(r.ts * 1000),
    lat: r.lat_e7 / 1e7,
    lon: r.lon_e7 / 1e7,
    speed_mps: r.speed_cms / 100,
    heading_deg: r.heading_cdeg / 100,
    accuracy_m: r.accuracy_dm / 10,
    source,
  };
}

// Postgres SQLSTATE classes 22 (data) and 23 (integrity, e.g. unknown jeep FK) won't succeed on retry.
const isPermanentDbError = (e) => typeof e.code === 'string' && /^2[23]/.test(e.code);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handleMessage(topic, payload, { insert, emit, sleep = defaultSleep }) {
  const reject = (reason, extra = {}) => {
    log('reject', { topic, reason, bytes: payload.length, ...extra });
    return { received: 0, stored: 0, duplicate: 0, rejected: 1 };
  };
  const m = TOPIC.exec(topic);
  if (!m) return reject('topic');
  const topicId = Number(m[1]);
  let reports;
  try {
    reports = m[2] === 'pos' ? [decode(payload)] : decodeBatch(payload);
  } catch (e) {
    return reject(e.code ?? 'decode');
  }
  if (reports.some((r) => r.jeep_id !== topicId)) return reject('jeep_id_mismatch');
  const rows = reports.map((r) => toRow(r, m[2] === 'pos' ? 'mqtt' : 'batch'));
  let inserted;
  // Transient DB failures (DB restarting, pool timeout) retry forever with capped backoff. The MQTT ack is held
  // until this returns, so the broker keeps the message even if the server dies meanwhile (no loss, R2).
  for (let attempt = 0; ; attempt++) {
    try {
      inserted = await insert(rows);
      break;
    } catch (e) {
      if (isPermanentDbError(e)) return reject('db', { code: e.code, message: e.message });
      log('db_retry', { topic, attempt, code: e.code, message: e.message });
      await sleep(Math.min(30_000, 250 * 2 ** attempt));
    }
  }
  for (const row of inserted) emit({ ...row, eta_eligible: row.accuracy_m <= ETA_MAX_ACCURACY_M });
  return { received: rows.length, stored: inserted.length, duplicate: rows.length - inserted.length, rejected: 0 };
}

export function startIngest({ pool, emitter, clientId = 'jeeptrack-server' }) {
  const counters = { received: 0, stored: 0, duplicate: 0, rejected: 0 };
  const client = mqtt.connect(process.env.MQTT_TLS_URL, {
    ca: readFileSync(path.resolve(process.env.MQTT_CA)),
    username: process.env.MQTT_SERVER_USER,
    password: process.env.MQTT_SERVER_PASS,
    clientId,
    protocolVersion: 5,
    clean: false,
    properties: { sessionExpiryInterval: 3600 },
    reconnectPeriod: 1000,
  });
  client.on('connect', (ack) => {
    log('mqtt_connected', { session_present: ack.sessionPresent });
    client.subscribe(['jeeptrack/v1/jeep/+/pos', 'jeeptrack/v1/jeep/+/batch'], { qos: 1 }, (err) => {
      if (err) log('mqtt_subscribe_error', { message: err.message });
    });
  });
  client.on('error', (e) => log('mqtt_error', { message: e.message }));
  attachHandlers(client, {
    insert: (rows) => insertPositions(pool, rows),
    emit: (row) => emitter.emit('position', row),
    counters,
  });
  const timer = setInterval(() => log('counters', counters), 30_000);
  timer.unref();
  return client;
}

// Processes messages in arrival order and holds each QoS1 PUBACK until that message is processed.
// mqtt.js emits 'message' synchronously right before calling client.handleMessage(packet, cb), and sends the
// PUBACK when cb runs, so cb chained after the message's work acks exactly that message.
export function attachHandlers(client, { insert, emit, counters = { received: 0, stored: 0, duplicate: 0, rejected: 0 } }) {
  let chain = Promise.resolve();
  client.on('message', (topic, payload) => {
    chain = chain.then(async () => {
      try {
        const res = await handleMessage(topic, payload, { insert, emit });
        for (const k in counters) counters[k] += res[k];
      } catch (e) {
        log('handler_error', { topic, message: e.message });
      }
    });
  });
  client.handleMessage = (_packet, cb) => { chain.then(() => cb(), cb); };
  client.counters = counters;
  client.idle = () => chain;
  return client;
}
