// Creates the server's broker user and a base ACL. Re-run safe.
import { ensureBrokerFiles, setBrokerPassword, writeAcl, reloadBroker } from './broker.js';

const user = process.env.MQTT_SERVER_USER;
const pass = process.env.MQTT_SERVER_PASS;
if (!user || !pass) throw new Error('MQTT_SERVER_USER / MQTT_SERVER_PASS missing from .env');

ensureBrokerFiles();
setBrokerPassword(user, pass);

// If the DB is up, keep registered jeeps' ACL entries; otherwise write the server entry only.
let entries = [{ user, lines: ['topic read jeeptrack/v1/jeep/#'] }];
try {
  const { makePool } = await import('../src/db.js');
  const { aclEntries } = await import('../src/jeeps.js');
  const pool = makePool();
  const { rows } = await pool.query('SELECT id FROM jeepneys WHERE active ORDER BY id');
  await pool.end();
  entries = aclEntries(rows.map((r) => r.id), user);
} catch { /* jeepneys table not created yet (stage 0) */ }

writeAcl(entries);
reloadBroker();
console.log(`broker user ${user} ready; ACL has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
