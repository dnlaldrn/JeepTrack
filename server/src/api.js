import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from './log.js';

// tickMs: how often to re-push jeeps + ETAs so staleness updates without new points (0 disables, for tests).
export function createApi({ engine, stops, routeGeoJson, emitter, now = Date.now, tickMs = 10_000 }) {
  const app = express();
  const stopIds = new Set(stops.map((s) => s.id));
  const stopsOut = stops.map(({ id, name, order_no, lat, lon, route_m, verified }) => ({ id, name, order_no, lat, lon, route_m, verified }));
  const iso = (j) => ({ ...j, last_seen: new Date(j.last_seen).toISOString() });
  const parseStop = (v) => {
    const id = Number(v);
    return Number.isInteger(id) && stopIds.has(id) ? id : null;
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/stops', (_req, res) => res.json(stopsOut));
  app.get('/api/route', (_req, res) => res.json(routeGeoJson));
  app.get('/api/jeeps', (_req, res) => res.json(engine.jeeps(now()).map(iso)));
  app.get('/api/etas', (req, res) => {
    const id = parseStop(req.query.stop_id);
    if (id === null) return res.status(400).json({ error: 'unknown stop_id' });
    res.json(engine.etasForStop(id, now()));
  });

  function attachWs(server) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
    const send = (ws, msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...msg, server_sent_at: new Date().toISOString() }));
    const sendEta = (ws) => ws.stopId != null && send(ws, { type: 'eta', stop_id: ws.stopId, etas: engine.etasForStop(ws.stopId, now()) });
    const broadcastPos = (view) => { for (const ws of wss.clients) send(ws, { type: 'pos', ...iso(view) }); };
    const pushEtas = () => { for (const ws of wss.clients) sendEta(ws); };

    wss.on('connection', (ws) => {
      ws.stopId = null;
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        const id = parseStop(msg?.subscribe?.stop_id);
        if (id === null) return;
        ws.stopId = id;
        sendEta(ws);
      });
      ws.on('error', () => {});
      for (const j of engine.jeeps(now())) send(ws, { type: 'pos', ...iso(j) });
    });

    emitter.on('position', (row) => {
      try {
        const view = engine.update(row, now());
        if (!view) return;
        broadcastPos(view);
        pushEtas();
      } catch (e) {
        log('eta_error', { message: e.message, jeep_id: row.jeep_id });
      }
    });

    if (tickMs > 0) {
      const t = setInterval(() => { for (const j of engine.jeeps(now())) broadcastPos(j); pushEtas(); }, tickMs);
      t.unref();
      server.on('close', () => clearInterval(t));
    }
    return wss;
  }

  return { app, attachWs };
}
