"""JeepTrack fleet simulator.

  synthetic: python simulator/replay.py --jeeps 10 --interval 10 --minutes 5 [--dead-zone 500:1500]
  trace:     python simulator/replay.py --mode trace --trace ride.csv [--speedup 10] [--jeep-id 101]

Publishes 28-byte reports (flags bit1 = simulated) as jeep-{id}. In synthetic mode it also writes
ground truth (true stop arrival times) to eval/out/truth-<unix>.csv.
"""
import argparse
import csv
import random
import sys
import time
import urllib.parse
from pathlib import Path

import paho.mqtt.client as mqtt
from paho.mqtt.packettypes import PacketTypes
from paho.mqtt.properties import Properties

from fleet import FLEET_PATH, load_fleet, next_seq, save_fleet
from jeeptrack_protocol import encode
from route import Route

ROOT = Path(__file__).resolve().parent.parent
FLAG_BUFFERED, FLAG_SIMULATED = 0b01, 0b10
MAX_BATCH = 200
LAYOVER_S = 60


def connect(jeep_id, token, broker, ca):
    u = urllib.parse.urlparse(broker)
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"jeep-{jeep_id}", protocol=mqtt.MQTTv5)
    c.username_pw_set(f"jeep-{jeep_id}", token)
    if u.scheme == "mqtts":
        c.tls_set(ca_certs=ca)
    props = Properties(PacketTypes.CONNECT)
    props.SessionExpiryInterval = 3600
    c.connect(u.hostname, u.port or (8883 if u.scheme == "mqtts" else 1883), keepalive=60, clean_start=False, properties=props)
    c.loop_start()
    return c


def report(jeep_id, seq, lat, lon, speed_mps, heading, accuracy_m, flags):
    return encode({
        "version": 1, "jeep_id": jeep_id, "seq": seq, "ts": int(time.time()),
        "lat_e7": round(lat * 1e7), "lon_e7": round(lon * 1e7),
        "speed_cms": max(0, min(65535, round(speed_mps * 100))), "heading_cdeg": round(heading * 100) % 36000,
        "accuracy_dm": round(accuracy_m * 10), "flags": flags,
    })


class Jeep:
    def __init__(self, jeep_id, client, route, start_m, factor):
        self.id, self.client, self.route = jeep_id, client, route
        self.m, self.factor = start_m, factor
        self.trip = 0
        self.dwell_until = 0.0
        self.next_stop = next(i for i, s in enumerate(route.stop_ms) if s > start_m)
        self.speed = 0.0
        self.buffer = []
        self.pending = []  # MessageInfo for the final wait


def run_synthetic(a, route, fleet, ids, clients):
    rng = random.Random(42)
    seg_kmh = [rng.uniform(15, 40) for _ in range(len(route.stop_ms) - 1)]
    jeeps = [Jeep(jid, clients[jid], route, route.length_m * 0.9 * i / len(ids), random.Random(jid).uniform(0.8, 1.2))
             for i, jid in enumerate(ids)]
    dz = tuple(map(float, a.dead_zone.split(":"))) if a.dead_zone else None
    out_dir = ROOT / "eval" / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_path = out_dir / f"truth-{int(time.time())}.csv"
    truth_f = open(truth_path, "w", newline="")
    truth = csv.writer(truth_f)
    truth.writerow(["jeep_id", "trip", "stop_id", "arrival_ts"])
    noise = random.Random()
    stops = route.stops
    t0 = time.time()
    end = t0 + a.minutes * 60
    tick = 0
    published = 0
    print(f"synthetic: {len(ids)} jeeps, route {route.length_m:.0f} m, truth -> {truth_path}", flush=True)

    while time.time() < end:
        now = time.time()
        for j in jeeps:
            # physics, 1 s step
            if now < j.dwell_until:
                j.speed = 0.0
            elif j.next_stop is None:  # layover finished: back to Alangilan for a new trip
                j.trip += 1
                j.m, j.next_stop = 0.0, 0
            else:
                seg = max(0, min(j.next_stop - 1, len(seg_kmh) - 1))
                j.speed = min(40 / 3.6, seg_kmh[seg] / 3.6 * j.factor)
                j.m = min(j.m + j.speed, route.stop_ms[j.next_stop])
                if j.m >= route.stop_ms[j.next_stop]:
                    truth.writerow([j.id, j.trip, stops[j.next_stop]["stop_id"], f"{now:.1f}"])
                    truth_f.flush()
                    last = j.next_stop == len(stops) - 1
                    j.dwell_until = now + (LAYOVER_S if last else noise.uniform(10, 60))
                    j.next_stop = None if last else j.next_stop + 1
                    j.speed = 0.0
            # report every `interval` seconds, phase-staggered per jeep
            if (tick + j.id) % a.interval == 0:
                lat, lon, hdg = route.point_at(j.m)
                lat, lon = route.offset(lat, lon, noise.gauss(0, 5), noise.gauss(0, 5))
                in_dz = dz is not None and dz[0] <= j.m <= dz[1]
                seq = next_seq(fleet, j.id)
                flags = FLAG_SIMULATED | (FLAG_BUFFERED if in_dz else 0)
                payload = report(j.id, seq, lat, lon, j.speed, hdg, 5.0, flags)
                if in_dz:
                    j.buffer.append(payload)
                else:
                    if j.buffer:
                        for i in range(0, len(j.buffer), MAX_BATCH):
                            j.pending.append(j.client.publish(f"jeeptrack/v1/jeep/{j.id}/batch", b"".join(j.buffer[i:i + MAX_BATCH]), qos=1))
                        print(f"jeep {j.id}: left dead zone, sent batch of {len(j.buffer)}", flush=True)
                        j.buffer = []
                    j.pending.append(j.client.publish(f"jeeptrack/v1/jeep/{j.id}/pos", payload, qos=1))
                    published += 1
                save_fleet(FLEET_PATH, fleet)
        tick += 1
        time.sleep(max(0.0, t0 + tick - time.time()))

    for j in jeeps:
        if j.buffer:  # run ended inside a dead zone: flush so nothing is lost
            j.pending.append(j.client.publish(f"jeeptrack/v1/jeep/{j.id}/batch", b"".join(j.buffer[:MAX_BATCH]), qos=1))
    truth_f.close()
    return jeeps, published


def run_trace(a, fleet, jeep_id, client):
    with open(a.trace, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("trace is empty")
    t_first = float(rows[0]["ts"])
    start = time.time()
    j = Jeep.__new__(Jeep)
    j.id, j.client, j.pending = jeep_id, client, []
    for r in rows:
        due = start + (float(r["ts"]) - t_first) / a.speedup
        time.sleep(max(0.0, due - time.time()))
        payload = report(jeep_id, next_seq(fleet, jeep_id), float(r["lat"]), float(r["lon"]), float(r["speed"]),
                         float(r["heading"]), float(r["accuracy"]), FLAG_SIMULATED)
        j.pending.append(client.publish(f"jeeptrack/v1/jeep/{jeep_id}/pos", payload, qos=1))
        save_fleet(FLEET_PATH, fleet)
    return [j], len(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["synthetic", "trace"], default="synthetic")
    ap.add_argument("--jeeps", type=int, default=10)
    ap.add_argument("--interval", type=int, default=10)
    ap.add_argument("--minutes", type=float, default=5)
    ap.add_argument("--dead-zone", help="START_M:END_M along the route")
    ap.add_argument("--trace", help="CSV with ts,lat,lon,speed,heading,accuracy")
    ap.add_argument("--speedup", type=float, default=1)
    ap.add_argument("--jeep-id", type=int, default=101, help="trace mode: which fleet jeep to replay as")
    ap.add_argument("--broker", default="mqtt://127.0.0.1:1883")
    ap.add_argument("--ca", default=str(ROOT / "infra" / "certs" / "ca.crt"))
    a = ap.parse_args()

    if not FLEET_PATH.exists():
        sys.exit("no simulator/.fleet.json — run simulator/seed_fleet.py first")
    fleet = load_fleet()
    route = Route.load(ROOT / "data" / "route.geojson", ROOT / "data" / "stops.csv")
    ids = sorted(int(k) for k in fleet)[: a.jeeps] if a.mode == "synthetic" else [a.jeep_id]
    clients = {jid: connect(jid, fleet[str(jid)]["token"], a.broker, a.ca) for jid in ids}
    try:
        if a.mode == "synthetic":
            jeeps, n = run_synthetic(a, route, fleet, ids, clients)
        else:
            if not a.trace:
                sys.exit("--trace FILE required in trace mode")
            jeeps, n = run_trace(a, fleet, ids[0], clients[ids[0]])
        for j in jeeps:
            for info in j.pending:
                info.wait_for_publish(timeout=10)
        print(f"done: {n} live reports published", flush=True)
    finally:
        save_fleet(FLEET_PATH, fleet)
        for c in clients.values():
            c.disconnect()
            c.loop_stop()


if __name__ == "__main__":
    main()
