import json
from pathlib import Path

import pytest

from jeeptrack_protocol import ProtocolError, crc16, decode, encode, sms_decode, sms_encode

V = json.loads((Path(__file__).resolve().parents[2] / "test-vectors.json").read_text())
KEYS = {int(k): bytes.fromhex(v) for k, v in V["sms_keys"].items()}
OK = V["reports"][0]["fields"]


def key_for(jeep_id):
    return KEYS.get(jeep_id)


def raises_code(code, fn, *args):
    with pytest.raises(ProtocolError) as e:
        fn(*args)
    assert e.value.code == code


def test_crc16_check_value():
    assert crc16(V["crc_check"]["ascii"].encode()) == V["crc_check"]["crc"] == 0x29B1


@pytest.mark.parametrize("v", V["reports"], ids=lambda v: v["name"])
def test_report_roundtrip(v):
    assert encode(v["fields"]).hex() == v["hex"]
    assert decode(bytes.fromhex(v["hex"])) == v["fields"]


@pytest.mark.parametrize("v", V["bad_reports"], ids=lambda v: v["name"])
def test_bad_report(v):
    raises_code(v["error"], decode, bytes.fromhex(v["hex"]))


@pytest.mark.parametrize("v", V["sms"], ids=lambda v: v["name"])
def test_sms_roundtrip(v):
    text = sms_encode(v["fields"], KEYS[v["fields"]["jeep_id"]])
    assert text == v["text"] and len(text) == 54
    assert sms_decode(v["text"], key_for) == v["fields"]


@pytest.mark.parametrize("v", V["bad_sms"], ids=lambda v: v["name"])
def test_bad_sms(v):
    raises_code(v["error"], sms_decode, v["text"], key_for)


@pytest.mark.parametrize("field,value", [("heading_cdeg", 36000), ("lat_e7", 900000001), ("lon_e7", -1800000001), ("seq", 2**32), ("seq", 1.5)])
def test_encode_range(field, value):
    raises_code("range", encode, {**OK, field: value})


def test_encode_clamps_accuracy():
    assert decode(encode({**OK, "accuracy_dm": 70000}))["accuracy_dm"] == 65535
