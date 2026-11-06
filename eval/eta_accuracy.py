"""ETA accuracy vs simulator ground truth (README Stage 4 / Stage 10: MAE <= 2 min).

Run alongside `simulator/replay.py` (synthetic mode):
    python eval/eta_accuracy.py --minutes 30 [--truth eval/out/truth-<x>.csv] [--base http://localhost:8080]

Every 30 s it samples /api/etas for every stop. Each prediction (sample_time + eta_s) is matched to the
jeep's first true arrival at that stop at or after sample_time - 60 s. The slack covers a jeep that is
already dwelling at the stop while GPS noise still projects it a few meters short.
Predictions from stale jeeps, and ones the run ended before they could be checked, are dropped.
"""
import argparse
import bisect
import csv
import json
import statistics
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
MATCH_SLACK_S = 60


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=10) as r:
        return json.load(r)


def collect(base, minutes, period):
    stops = [s["id"] for s in get(base, "/api/stops")]
    preds = []
    end = time.time() + minutes * 60
    while time.time() < end:
        t = time.time()
        for sid in stops:
            for e in get(base, f"/api/etas?stop_id={sid}"):
                if not e["stale"]:
                    preds.append((t, e["jeep_id"], sid, t + e["eta_s"]))
        print(f"{time.strftime('%H:%M:%S')} sampled, {len(preds)} predictions so far", flush=True)
        time.sleep(max(0, period - (time.time() - t)))
    return preds


def evaluate(preds, truth_rows):
    arrivals = defaultdict(list)
    for r in truth_rows:
        arrivals[(int(r["jeep_id"]), int(r["stop_id"]))].append(float(r["arrival_ts"]))
    for v in arrivals.values():
        v.sort()
    last_truth = max((float(r["arrival_ts"]) for r in truth_rows), default=0)
    errors = []
    for t, jeep, stop, predicted in preds:
        times = arrivals.get((jeep, stop), [])
        i = bisect.bisect_left(times, t - MATCH_SLACK_S)
        if i < len(times):
            errors.append((t, jeep, stop, predicted, times[i], abs(predicted - times[i])))
        elif predicted < last_truth:
            # should have arrived before the run ended but never did: count it as an error against run end
            errors.append((t, jeep, stop, predicted, last_truth, abs(predicted - last_truth)))
    return errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--period", type=float, default=30)
    ap.add_argument("--truth", help="default: newest eval/out/truth-*.csv at the end of the run")
    a = ap.parse_args()

    preds = collect(a.base, a.minutes, a.period)
    truth_path = Path(a.truth) if a.truth else max(OUT.glob("truth-*.csv"), key=lambda p: p.stat().st_mtime)
    with open(truth_path, newline="") as f:
        truth = list(csv.DictReader(f))
    errors = evaluate(preds, truth)
    if not errors:
        sys.exit("no predictions could be matched to ground truth")

    stamp = int(time.time())
    with open(OUT / f"eta-pred-{stamp}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["sample_ts", "jeep_id", "stop_id", "predicted_ts", "actual_ts", "abs_err_s"])
        w.writerows([(f"{t:.1f}", j, s, f"{p:.1f}", f"{act:.1f}", f"{e:.1f}") for t, j, s, p, act, e in errors])

    errs = [e[-1] for e in errors]
    mae_min = statistics.mean(errs) / 60
    p90 = sorted(errs)[int(0.9 * (len(errs) - 1))] / 60
    print(f"truth: {truth_path.name}; matched {len(errs)} of {len(preds)} predictions")
    print(f"ETA MAE = {mae_min:.2f} min (p90 abs error {p90:.2f} min); target <= 2.00 min -> {'PASS' if mae_min <= 2 else 'FAIL'}")
    sys.exit(0 if mae_min <= 2 else 1)


if __name__ == "__main__":
    main()
