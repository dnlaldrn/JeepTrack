import { EventEmitter } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { makePool } from './db.js';
import { startIngest } from './ingest.js';
import { buildRoute } from './geo.js';
import { EtaEngine } from './eta.js';
import { createApi } from './api.js';
import { log } from './log.js';

const pool = makePool();
const emitter = new EventEmitter();

const routeRow = (await pool.query('SELECT ST_AsGeoJSON(geom)::json AS g FROM route WHERE id = 1')).rows[0];
if (!routeRow) throw new Error('no route in DB — run: node --env-file=../.env scripts/load-route.js');
const routeGeoJson = routeRow.g;
const stops = (await pool.query(
  `SELECT id, name, order_no, route_m, verified, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon FROM stops ORDER BY order_no`,
)).rows;

const engine = new EtaEngine({ route: buildRoute(routeGeoJson.coordinates), stops });
const api = createApi({ engine, stops, routeGeoJson, emitter });
api.app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web')));

const server = http.createServer(api.app);
api.attachWs(server);
const port = Number(process.env.HTTP_PORT ?? 8080);
server.listen(port, () => log('server_started', { port, stops: stops.length }));

startIngest({ pool, emitter });
