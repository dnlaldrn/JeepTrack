export function haversineM(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

export function nearestStop(stops, lat, lon) {
  let best = null, bestD = Infinity;
  for (const s of stops) {
    const d = haversineM(lat, lon, s.lat, s.lon);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}
