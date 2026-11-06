import pg from 'pg';

export const makePool = () => new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Inserts rows, skipping (jeep_id, seq) duplicates. Resolves to the rows that were actually new.
export async function insertPositions(pool, rows) {
  if (rows.length === 0) return [];
  const params = [];
  const values = rows.map((r, i) => {
    params.push(r.jeep_id, r.seq, r.ts, r.lon, r.lat, r.speed_mps, r.heading_deg, r.accuracy_m, r.source);
    const p = (k) => `$${i * 9 + k}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ST_SetSRID(ST_MakePoint(${p(4)}, ${p(5)}), 4326)::geography, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)})`;
  });
  const { rows: inserted } = await pool.query(
    `INSERT INTO positions (jeep_id, seq, ts, geom, speed_mps, heading_deg, accuracy_m, source)
     VALUES ${values.join(', ')}
     ON CONFLICT DO NOTHING RETURNING jeep_id, seq`,
    params,
  );
  const isNew = new Set(inserted.map((r) => `${r.jeep_id}:${r.seq}`));
  return rows.filter((r) => isNew.has(`${r.jeep_id}:${r.seq}`));
}
