// Applies infra/db/migrations/*.sql in filename order, each once, each in a transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../infra/db/migrations');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  let applied = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(path.join(dir, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${name} failed: ${e.message}`);
    }
    console.log(`applied ${name}`);
    applied++;
  }
  console.log(`${applied} migration(s) applied`);
} finally {
  await client.end();
}
