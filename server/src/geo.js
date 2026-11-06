// Route geometry in local planar meters: equirectangular around the first vertex.
// shortcut: planar approximation (<0.1% error over a few km), switch to geodesic if routes exceed ~50 km.
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function buildRoute(coords) {
  if (coords.length < 2) throw new Error('route needs at least 2 points');
  const [lon0, lat0] = coords[0];
  const k = Math.cos(rad(lat0));
  const pts = coords.map(([lon, lat]) => ({ x: R * rad(lon - lon0) * k, y: R * rad(lat - lat0) }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, lengthM: cum.at(-1), lat0, lon0, k };
}

export function projectToRoute(route, lat, lon) {
  const px = R * rad(lon - route.lon0) * route.k;
  const py = R * rad(lat - route.lat0);
  let best = { routeM: 0, distM: Infinity };
  for (let i = 1; i < route.pts.length; i++) {
    const a = route.pts[i - 1], b = route.pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    const d = Math.hypot(a.x + t * dx - px, a.y + t * dy - py);
    if (d < best.distM) best = { routeM: route.cum[i - 1] + t * Math.sqrt(len2), distM: d };
  }
  return best;
}

export function pointAt(route, m) {
  const mm = Math.max(0, Math.min(m, route.lengthM));
  let i = route.cum.findIndex((c) => c >= mm);
  if (i <= 0) i = 1;
  const seg = route.cum[i] - route.cum[i - 1];
  const f = seg === 0 ? 0 : (mm - route.cum[i - 1]) / seg;
  const x = route.pts[i - 1].x + f * (route.pts[i].x - route.pts[i - 1].x);
  const y = route.pts[i - 1].y + f * (route.pts[i].y - route.pts[i - 1].y);
  return { lat: route.lat0 + deg(y / R), lon: route.lon0 + deg(x / (R * route.k)) };
}
