import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { setBrokerPassword, writeAcl, reloadBroker, ensureBrokerFiles } from '../scripts/broker.js';

export function aclEntries(activeIds, serverUser) {
  return [
    { user: serverUser, lines: ['topic read jeeptrack/v1/jeep/#'] },
    ...activeIds.map((id) => {
      if (!Number.isInteger(id)) throw new Error(`bad jeep id ${id}`);
      return { user: `jeep-${id}`, lines: [`topic write jeeptrack/v1/jeep/${id}/#`] };
    }),
  ];
}

export async function syncAcl(pool) {
  const { rows } = await pool.query('SELECT id FROM jeepneys WHERE active ORDER BY id');
  writeAcl(aclEntries(rows.map((r) => r.id), process.env.MQTT_SERVER_USER));
  reloadBroker();
}

// Creates or re-keys a jeepney. The token and SMS key are returned once and only their hash/key are stored.
export async function registerJeep(pool, { id, plate }) {
  if (!Number.isInteger(id) || id < 1 || id > 65535) throw new Error('id must be an integer 1..65535');
  const token = randomBytes(24).toString('base64url');
  const smsKey = randomBytes(32);
  await pool.query(
    `INSERT INTO jeepneys (id, plate, token_hash, sms_key, active) VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (id) DO UPDATE SET plate = EXCLUDED.plate, token_hash = EXCLUDED.token_hash, sms_key = EXCLUDED.sms_key, active = TRUE`,
    [id, plate, await bcrypt.hash(token, 10), smsKey],
  );
  ensureBrokerFiles();
  setBrokerPassword(`jeep-${id}`, token);
  await syncAcl(pool);
  return { token, smsKey };
}
