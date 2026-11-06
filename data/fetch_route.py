"""One-off: builds data/route.geojson + data/stops.csv from OSM (Nominatim + public OSRM).

Fallback data per README Stage 3: every stop is verified=false until the team checks it.
Usage: python data/fetch_route.py [--start "lat,lon"] [--end "lat,lon"]
"""
import argparse
import csv
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = {"User-Agent": "jeeptrack-dev (CS312 student project)"}
HERE = Path(__file__).parent
R = 6371008.8
N_STOPS = 15


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.load(r)


def geocode(q):
    res = get("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q, "format": "json", "limit": 1}))
    time.sleep(1.1)  # Nominatim usage policy: max 1 req/s
    if not res:
        raise SystemExit(f"geocode failed for {q!r}; pass --start/--end explicitly")
    print(f"geocoded {q!r} -> {res[0]['lat']},{res[0]['lon']} ({res[0]['display_name'][:90]})")
    return float(res[0]["lat"]), float(res[0]["lon"])


def reverse_name(lat, lon):
    try:
        res = get("https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode({"lat": lat, "lon": lon, "format": "json", "zoom": 17}))
        time.sleep(1.1)
        a = res.get("address", {})
        return a.get("road") or a.get("neighbourhood") or a.get("suburb") or a.get("village")
    except Exception:
        return None


def planar(coords):
    lat0 = math.radians(coords[0][1])
    lon0, la0 = coords[0][0], coords[0][1]
    return [(R * math.radians(lon - lon0) * math.cos(lat0), R * math.radians(lat - la0)) for lon, lat in coords]


def point_at(coords, cum, m):
    for i in range(1, len(cum)):
        if cum[i] >= m:
            f = (m - cum[i - 1]) / ((cum[i] - cum[i - 1]) or 1)
            (lo1, la1), (lo2, la2) = coords[i - 1], coords[i]
            return la1 + f * (la2 - la1), lo1 + f * (lo2 - lo1)
    return coords[-1][1], coords[-1][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start")
    ap.add_argument("--end")
    a = ap.parse_args()
    start = tuple(map(float, a.start.split(","))) if a.start else geocode("Batangas State University Alangilan, Batangas City")
    end = tuple(map(float, a.end.split(","))) if a.end else geocode("Batangas City Grand Terminal")

    url = f"https://router.project-osrm.org/route/v1/driving/{start[1]},{start[0]};{end[1]},{end[0]}?overview=full&geometries=geojson"
    route = get(url)["routes"][0]
    coords = route["geometry"]["coordinates"]
    xy = planar(coords)
    cum = [0.0]
    for (x1, y1), (x2, y2) in zip(xy, xy[1:]):
        cum.append(cum[-1] + math.hypot(x2 - x1, y2 - y1))
    length = cum[-1]
    print(f"route: {len(coords)} points, {length:.0f} m (OSRM says {route['distance']:.0f} m)")

    (HERE / "route.geojson").write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"name": "Alangilan -> Batangas City Grand Terminal", "source": "OSRM public router", "verified": False},
                      "geometry": {"type": "LineString", "coordinates": coords}}],
    }) + "\n")

    with open(HERE / "stops.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["stop_id", "name", "lat", "lon", "order", "verified"])
        used = set()
        for k in range(N_STOPS):
            m = length * k / (N_STOPS - 1)
            lat, lon = point_at(coords, cum, m)
            if k == 0:
                name = "BatStateU Alangilan"
            elif k == N_STOPS - 1:
                name = "Batangas City Grand Terminal"
            else:
                road = reverse_name(lat, lon)
                name = f"{road} ({k + 1})" if road and road in used else (road or f"Stop {k + 1}")
                used.add(road)
            w.writerow([k + 1, name, f"{lat:.7f}", f"{lon:.7f}", k + 1, "false"])
            print(f"  stop {k + 1:2d} @ {m:6.0f} m  {name}")


if __name__ == "__main__":
    main()
