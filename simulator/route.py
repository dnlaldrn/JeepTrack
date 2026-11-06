"""Route geometry in local planar meters. Same projection as server/src/geo.js (equirectangular, R=6371008.8)."""
import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path

R = 6371008.8


@dataclass
class Route:
    coords: list  # [(lon, lat)]
    xy: list      # [(x, y)] meters
    cum: list     # cumulative meters at each vertex
    stop_ms: list
    stops: list   # [{stop_id, name, lat, lon, order}]
    lat0: float
    lon0: float

    @property
    def length_m(self):
        return self.cum[-1]

    @classmethod
    def load(cls, geojson_path, stops_path):
        coords = [tuple(c) for c in json.loads(Path(geojson_path).read_text())["features"][0]["geometry"]["coordinates"]]
        lon0, lat0 = coords[0]
        k = math.cos(math.radians(lat0))
        to_xy = lambda lon, lat: (R * math.radians(lon - lon0) * k, R * math.radians(lat - lat0))
        xy = [to_xy(lon, lat) for lon, lat in coords]
        cum = [0.0]
        for (x1, y1), (x2, y2) in zip(xy, xy[1:]):
            cum.append(cum[-1] + math.hypot(x2 - x1, y2 - y1))
        with open(stops_path, newline="") as f:
            stops = sorted(({"stop_id": int(r["stop_id"]), "name": r["name"], "lat": float(r["lat"]), "lon": float(r["lon"]), "order": int(r["order"])}
                            for r in csv.DictReader(f)), key=lambda s: s["order"])
        route = cls(coords, xy, cum, [], stops, lat0, lon0)
        route.stop_ms = [route.project(*to_xy(s["lon"], s["lat"])) for s in stops]
        return route

    def project(self, px, py):
        best = (float("inf"), 0.0)
        for i in range(1, len(self.xy)):
            (x1, y1), (x2, y2) = self.xy[i - 1], self.xy[i]
            dx, dy = x2 - x1, y2 - y1
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg2))
            d = math.hypot(x1 + t * dx - px, y1 + t * dy - py)
            if d < best[0]:
                best = (d, self.cum[i - 1] + t * math.sqrt(seg2))
        return best[1]

    def point_at(self, m):
        """Returns (lat, lon, heading_deg) at distance m along the route (clamped)."""
        m = max(0.0, min(m, self.length_m))
        i = next((j for j in range(1, len(self.cum)) if self.cum[j] >= m), len(self.cum) - 1)
        seg = self.cum[i] - self.cum[i - 1]
        f = 0.0 if seg == 0 else (m - self.cum[i - 1]) / seg
        (lo1, la1), (lo2, la2) = self.coords[i - 1], self.coords[i]
        (x1, y1), (x2, y2) = self.xy[i - 1], self.xy[i]
        heading = math.degrees(math.atan2(x2 - x1, y2 - y1)) % 360
        return la1 + f * (la2 - la1), lo1 + f * (lo2 - lo1), heading

    def offset(self, lat, lon, east_m, north_m):
        """Shifts a lat/lon by meters (for GPS noise)."""
        k = math.cos(math.radians(self.lat0))
        return lat + math.degrees(north_m / R), lon + math.degrees(east_m / (R * k))
