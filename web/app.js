import { connectLive } from './live.js';
import { nearestStop } from './geo.js';

const HIDE_MS = 10 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const map = L.map('map', { zoomControl: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const jeeps = new Map(); // jeep_id -> {marker, data}
let stops = [];
let selected = null;
let lastEtas = null;

const minsAgo = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const staleText = (iso) => `last seen ${minsAgo(iso)} min ago`;
const fmtEta = (s) => (s < 60 ? 'arriving' : `${Math.round(s / 60)} min`);

function jeepIcon(d) {
  const label = d.stale ? `${d.jeep_id} · ${minsAgo(d.last_seen)}m ago` : String(d.jeep_id);
  return L.divIcon({ className: `jeep-icon${d.stale ? ' stale' : ''}`, html: label, iconAnchor: [14, 10] });
}

function upsertJeep(d) {
  const j = jeeps.get(d.jeep_id);
  if (j) {
    j.marker.setLatLng([d.lat, d.lon]).setIcon(jeepIcon(d));
    j.data = d;
  } else {
    const marker = L.marker([d.lat, d.lon], { icon: jeepIcon(d), keyboard: false, title: `Jeep ${d.jeep_id}` }).addTo(map);
    jeeps.set(d.jeep_id, { marker, data: d });
  }
}

function renderEtas() {
  const list = $('etas');
  list.replaceChildren();
  if (!selected) return;
  $('panel-title').textContent = selected.name;
  $('panel-note').textContent = selected.verified ? '' : 'Stop location not yet verified.';
  const etas = lastEtas?.stop_id === selected.id ? lastEtas.etas : null;
  if (!etas) { $('panel-note').textContent = 'Loading arrivals…'; return; }
  if (etas.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No jeepneys on the way right now.';
    list.append(li);
    return;
  }
  for (const e of etas) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const min = document.createElement('span');
    name.textContent = `Jeep ${e.jeep_id}`;
    min.className = 'min';
    min.textContent = fmtEta(e.eta_s);
    if (e.stale) {
      li.className = 'stale';
      const seen = jeeps.get(e.jeep_id)?.data.last_seen;
      name.textContent += seen ? ` (${staleText(seen)})` : ' (stale)';
    }
    li.append(name, min);
    list.append(li);
  }
}

function selectStop(s) {
  selected = s;
  lastEtas = null;
  $('stop-select').value = String(s.id);
  live.setStop(s.id);
  renderEtas();
}

const live = connectLive({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  onStatus: (s) => { $('banner').hidden = s === 'online'; },
  onMessage: (m) => {
    if (m.type === 'pos') upsertJeep(m);
    else if (m.type === 'eta' && m.stop_id === selected?.id) { lastEtas = m; renderEtas(); }
  },
});

// drop jeeps not heard from in 10 min (server stops sending them)
setInterval(() => {
  for (const [id, j] of jeeps) if (Date.now() - Date.parse(j.data.last_seen) > HIDE_MS) { j.marker.remove(); jeeps.delete(id); }
}, 15000);

$('nearest').addEventListener('click', () => {
  if (!navigator.geolocation) { $('panel-note').textContent = 'Location is not available on this device.'; return; }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const s = nearestStop(stops, p.coords.latitude, p.coords.longitude);
      if (!s) return;
      map.setView([s.lat, s.lon], 17);
      selectStop(s);
    },
    () => { $('panel-note').textContent = 'Location permission denied — tap a stop on the map instead.'; },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

async function init() {
  const [route, stopList] = await Promise.all([fetch('/api/route').then((r) => r.json()), fetch('/api/stops').then((r) => r.json())]);
  stops = stopList;
  const line = L.geoJSON(route, { style: { color: '#0f5132', weight: 5, opacity: 0.8 } }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [20, 20] });
  $('stop-select').append(...stops.map((s) => new Option(s.name, s.id)));
  $('stop-select').addEventListener('change', (e) => {
    const s = stops.find((x) => x.id === Number(e.target.value));
    if (s) { map.panTo([s.lat, s.lon]); selectStop(s); }
  });
  for (const s of stops) {
    L.circleMarker([s.lat, s.lon], { radius: 8, color: '#0f5132', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip(s.name)
      .on('click', () => selectStop(s));
  }
}

init().catch(() => { $('panel-note').textContent = 'Could not load the route. Check your connection.'; });
