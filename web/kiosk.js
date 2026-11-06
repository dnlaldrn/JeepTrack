import { connectLive } from './live.js';

const $ = (id) => document.getElementById(id);
const lastSeen = new Map(); // jeep_id -> ISO

function render(etas) {
  const ol = $('inbound');
  ol.replaceChildren();
  const next = etas.slice(0, 5);
  if (next.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No jeepneys on the way';
    ol.append(li);
    return;
  }
  for (const e of next) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const min = document.createElement('span');
    name.textContent = `Jeep ${e.jeep_id}`;
    min.className = 'min';
    min.textContent = e.eta_s < 60 ? 'Arriving' : `${Math.round(e.eta_s / 60)} min`;
    if (e.stale) {
      li.className = 'stale';
      const seen = lastSeen.get(e.jeep_id);
      name.textContent += seen ? ` — last seen ${Math.round((Date.now() - Date.parse(seen)) / 60000)} min ago` : ' — signal lost';
    }
    li.append(name, min);
    ol.append(li);
  }
}

const tick = () => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
tick();
setInterval(tick, 10000);

async function init() {
  const stops = await fetch('/api/stops').then((r) => r.json());
  const terminal = stops.reduce((a, b) => (b.order_no > a.order_no ? b : a));
  const live = connectLive({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    onStatus: (s) => { $('banner').hidden = s === 'online'; },
    onMessage: (m) => {
      if (m.type === 'pos') lastSeen.set(m.jeep_id, m.last_seen);
      else if (m.type === 'eta' && m.stop_id === terminal.id) render(m.etas);
    },
  });
  live.setStop(terminal.id);
}

// Retry the initial load too: the kiosk must recover on its own after a power or network blip.
(function start(attempt = 0) {
  init().catch(() => setTimeout(() => start(attempt + 1), Math.min(30000, 1000 * 2 ** attempt)));
})();
