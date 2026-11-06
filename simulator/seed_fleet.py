"""Registers simulator jeepneys 101-110 (DB + broker) and writes simulator/.fleet.json.
Re-running re-keys the devices but keeps each jeep's seq counter.
Usage: python simulator/seed_fleet.py [--ids 101-110]
"""
import argparse
import json
import subprocess
from pathlib import Path

from fleet import FLEET_PATH, load_fleet, merge_seed, save_fleet

SERVER = Path(__file__).resolve().parent.parent / "server"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", default="101-110")
    lo, hi = map(int, ap.parse_args().ids.split("-"))
    tokens = {}
    for jid in range(lo, hi + 1):
        out = subprocess.run(["node", "--env-file=../.env", "scripts/add-jeep.js", "--id", str(jid), "--plate", f"SIM-{jid}", "--json"],
                             cwd=SERVER, check=True, capture_output=True, text=True).stdout
        tokens[str(jid)] = json.loads(out.strip().splitlines()[-1])["token"]
        print(f"registered jeep {jid}")
    existing = load_fleet() if FLEET_PATH.exists() else {}
    save_fleet(FLEET_PATH, {**existing, **merge_seed(existing, tokens)})
    print(f"wrote {FLEET_PATH}")


if __name__ == "__main__":
    main()
