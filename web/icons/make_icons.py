"""Writes icon-192.png and icon-512.png (stdlib only): green square, white rounded 'bus' block, red dot."""
import struct
import zlib
from pathlib import Path

GREEN, WHITE, RED = (15, 81, 50), (255, 255, 255), (214, 58, 26)


def pixel(x, y, n):
    u, v = x / n, y / n
    if 0.22 < u < 0.78 and 0.28 < v < 0.68:  # body (inside the maskable safe zone)
        if 0.30 < u < 0.70 and 0.34 < v < 0.48:
            return GREEN  # windscreen
        return WHITE
    for cx in (0.34, 0.66):  # wheels
        if (u - cx) ** 2 + (v - 0.70) ** 2 < 0.055 ** 2:
            return WHITE
    if (u - 0.5) ** 2 + (v - 0.18) ** 2 < 0.06 ** 2:
        return RED  # live dot
    return GREEN


def png(n):
    raw = b"".join(b"\x00" + bytes(c for x in range(n) for c in pixel(x, y, n)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


for n in (192, 512):
    (Path(__file__).parent / f"icon-{n}.png").write_bytes(png(n))
    print(f"icon-{n}.png")
