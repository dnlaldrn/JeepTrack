// Loads data/route.geojson + data/stops.csv into the DB and precomputes stops.route_m in PostGIS.
// Usage: node --env-file=../.env scripts/load-route.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makePool } from '../src/db.js';
import { buildRoute } from '../src/geo.js';

const data = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const line = JSON.parse(readFileSync(path.join(data, 'route.geojson'), 'utf8')).features[0].geometry;
const [header, ...lines] = readFileSync(path.join(data, 'stops.csv'), 'utf8').trim().split(/\r?\n/);
const cols = header.split(',');
// shortcut: naive CSV split, stop names must not contain commas
const stops = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));

const pool = makePool();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO route (id, geom) VALUES (1, ST_GeomFromGeoJSON($1)::geography)
     ON CONFLICT (id) DO UPDATE SET geom = EXCLUDED.geom`,
    [JSON.stringify(line)],
  );
  await client.query('DELETE FROM stops');
  for (const s of stops) {
    await client.query(
      `INSERT INTO stops (id, name, order_no, geom, route_m, verified)
       SELECT $1, $2, $3, p, ST_LineLocatePoint(r.geom::geometry, p::geometry) * ST_Length(r.geom), $6
       FROM route r, (SELECT ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography AS p) q WHERE r.id = 1`,
      [Number(s.stop_id), s.name, Number(s.order), Number(s.lat), Number(s.lon), s.verified === 'true'],
    );
  }
  const { rows } = await client.query('SELECT id, name, route_m FROM stops ORDER BY order_no');
  for (let i = 1; i < rows.length; i++)
    if (!(rows[i].route_m > rows[i - 1].route_m)) throw new Error(`stop ${rows[i].id} route_m not increasing`);
  await client.query('COMMIT');
  const jsLen = buildRoute(line.coordinates).lengthM;
  console.log(`loaded route (PostGIS ${(await pool.query('SELECT ST_Length(geom) l FROM route')).rows[0].l.toFixed(0)} m, planar ${jsLen.toFixed(0)} m) and ${rows.length} stops`);
  console.log(`last stop route_m = ${rows.at(-1).route_m.toFixed(1)}`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
