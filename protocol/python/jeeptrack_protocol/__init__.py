"""JeepTrack wire protocol v1 — see protocol/SPEC.md."""
import base64
import hashlib
import hmac
import struct

REPORT_LEN = 28
MAX_BATCH = 200
_FMT = ">BHIIiiHHHB"  # 26 bytes before the CRC
FIELDS = ("version", "jeep_id", "seq", "ts", "lat_e7", "lon_e7", "speed_cms", "heading_cdeg", "accuracy_dm", "flags")
_RANGES = {
    "version": (0, 0xFF), "jeep_id": (0, 0xFFFF), "seq": (0, 0xFFFFFFFF), "ts": (0, 0xFFFFFFFF),
    "lat_e7": (-900000000, 900000000), "lon_e7": (-1800000000, 1800000000),
    "speed_cms": (0, 0xFFFF), "heading_cdeg": (0, 35999), "accuracy_dm": (0, float("inf")), "flags": (0, 0xFF),
}


class ProtocolError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def encode(r: dict) -> bytes:
    for k, (lo, hi) in _RANGES.items():
        v = r[k]
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise ProtocolError("range", f"{k} out of range: {v!r}")
    vals = [r[k] for k in FIELDS]
    vals[8] = min(vals[8], 0xFFFF)
    body = struct.pack(_FMT, *vals)
    return body + struct.pack(">H", crc16(body))


def decode(b: bytes) -> dict:
    if len(b) != REPORT_LEN:
        raise ProtocolError("length", f"expected {REPORT_LEN} bytes, got {len(b)}")
    if b[0] != 1:
        raise ProtocolError("version", f"unsupported version {b[0]}")
    if crc16(b[:26]) != struct.unpack(">H", b[26:])[0]:
        raise ProtocolError("crc")
    return dict(zip(FIELDS, struct.unpack(_FMT, b[:26])))


def decode_batch(b: bytes) -> list[dict]:
    n, rem = divmod(len(b), REPORT_LEN)
    if rem or not 1 <= n <= MAX_BATCH:
        raise ProtocolError("length", f"bad batch length {len(b)}")
    return [decode(b[i * REPORT_LEN:(i + 1) * REPORT_LEN]) for i in range(n)]


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _hmac8(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()[:8]


_B64CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def sms_encode(r: dict, key: bytes) -> str:
    data = encode(r)
    return f"JT1:{_b64(data)}:{_b64(_hmac8(key, data))}"


def sms_decode(text: str, key_for) -> dict:
    if not isinstance(text, str) or not text.startswith("JT1:"):
        raise ProtocolError("prefix")
    parts = text.strip().split(":")
    if len(parts) != 3 or len(parts[1]) != 38 or len(parts[2]) != 11 or not set(parts[1] + parts[2]) <= _B64CHARS:
        raise ProtocolError("format")
    data = _unb64(parts[1])
    r = decode(data)
    key = key_for(r["jeep_id"])
    if not key:
        raise ProtocolError("unknown_jeep", f"unknown jeep {r['jeep_id']}")
    if not hmac.compare_digest(_hmac8(key, data), _unb64(parts[2])):
        raise ProtocolError("hmac")
    return r
