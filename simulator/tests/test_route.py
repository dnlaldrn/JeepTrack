import json

import pytest

from route import Route


@pytest.fixture
def north_route(tmp_path):
    p = tmp_path / "r.geojson"
    p.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[121.0, 13.7], [121.0, 13.709]]}}]}))
    s = tmp_path / "s.csv"
    s.write_text("stop_id,name,lat,lon,order,verified\n1,A,13.7,121.0,1,false\n2,B,13.7045,121.0,2,false\n3,C,13.709,121.0,3,false\n")
    return Route.load(p, s)


def test_length(north_route):
    assert north_route.length_m == pytest.approx(1000.8, abs=1)


def test_point_at_ends_and_middle(north_route):
    lat, lon, _ = north_route.point_at(0)
    assert (lat, lon) == pytest.approx((13.7, 121.0))
    lat, lon, _ = north_route.point_at(north_route.length_m)
    assert (lat, lon) == pytest.approx((13.709, 121.0))
    lat, lon, hdg = north_route.point_at(north_route.length_m / 2)
    assert lat == pytest.approx(13.7045, abs=1e-5)  # ~1 m
    assert hdg == pytest.approx(0, abs=0.5)


def test_stops_projected_in_order(north_route):
    assert north_route.stop_ms == pytest.approx([0, 500.4, 1000.8], abs=1)
