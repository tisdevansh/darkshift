"""Generate DarkShift toolbar icons (on/off states) as PNGs without external dependencies.

Usage: python tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor

THEMES = {
    "on": {"g0": (154, 123, 255), "g1": (79, 182, 255), "moon": (255, 255, 255), "star": (255, 255, 255)},
    "off": {"g0": (70, 75, 92), "g1": (44, 48, 60), "moon": (170, 176, 192), "star": (150, 156, 172)},
}


def rounded_rect(x, y, size, radius):
    """Signed coverage test for a rounded square spanning [0, size]."""
    r = radius
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(theme, size, x, y):
    t = THEMES[theme]
    if not rounded_rect(x, y, size, size * 0.24):
        return None
    k = (x + y) / (2 * size)
    color = tuple(t["g0"][i] + (t["g1"][i] - t["g0"][i]) * k for i in range(3))
    # Crescent: big disc minus offset disc.
    cx, cy, r = size * 0.47, size * 0.53, size * 0.29
    ox, oy, orr = size * 0.60, size * 0.41, size * 0.25
    in_moon = (x - cx) ** 2 + (y - cy) ** 2 <= r * r and (x - ox) ** 2 + (y - oy) ** 2 > orr * orr
    if in_moon:
        return t["moon"]
    # Small sparkle (only drawn when there is room).
    if size >= 32:
        sx, sy = size * 0.72, size * 0.30
        d = abs(x - sx) + abs(y - sy)
        if d <= size * 0.075 and (abs(x - sx) < size * 0.018 or abs(y - sy) < size * 0.018 or d <= size * 0.03):
            return t["star"]
    return color


def render(theme, size):
    big = size * SS
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    c = pixel(theme, big, px * SS + sx + 0.5, py * SS + sy + 0.5)
                    if c is not None:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 1
            n = SS * SS
            a = acc[3] / n
            if acc[3]:
                row += bytes((round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(a * 255)))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT, exist_ok=True)
    for theme in THEMES:
        for size in SIZES:
            path = os.path.join(OUT, f"{theme}-{size}.png")
            with open(path, "wb") as f:
                f.write(png(size, render(theme, size)))
            print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
