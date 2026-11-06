"""Simulator fleet state: tokens and the last seq per jeep (persisted so re-runs never reuse a seq)."""
import json
import os
from pathlib import Path

FLEET_PATH = Path(__file__).parent / ".fleet.json"


def load_fleet(path=FLEET_PATH) -> dict:
    return json.loads(Path(path).read_text())


def save_fleet(path, fleet: dict) -> None:
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(fleet, indent=2))
    os.replace(tmp, path)  # atomic: a crash mid-write can't lose seq state


def next_seq(fleet: dict, jeep_id: int) -> int:
    entry = fleet[str(jeep_id)]
    entry["seq"] += 1
    return entry["seq"]


def merge_seed(existing: dict, tokens: dict) -> dict:
    return {jid: {"token": tok, "seq": existing.get(jid, {}).get("seq", 0)} for jid, tok in tokens.items()}
