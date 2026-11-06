// Usage: node --env-file=../.env scripts/add-jeep.js --id 101 --plate ABC-123 [--json]
// Prints the device token and SMS key once. Re-running re-keys the device.
import { parseArgs } from 'node:util';
import { makePool } from '../src/db.js';
import { registerJeep } from '../src/jeeps.js';

const { values } = parseArgs({ options: { id: { type: 'string' }, plate: { type: 'string' }, json: { type: 'boolean' } } });
const id = Number(values.id);
if (!values.id || !values.plate) {
  console.error('usage: add-jeep.js --id <1..65535> --plate <plate> [--json]');
  process.exit(2);
}
const pool = makePool();
try {
  const { token, smsKey } = await registerJeep(pool, { id, plate: values.plate });
  if (values.json) console.log(JSON.stringify({ id, token, sms_key: smsKey.toString('hex') }));
  else console.log(`jeep ${id} (${values.plate}) registered\n  MQTT user:  jeep-${id}\n  token:      ${token}\n  SMS key:    ${smsKey.toString('hex')}\nStore these now; they are not shown again.`);
} finally {
  await pool.end();
}
