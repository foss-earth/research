"""Download a small reproducible elevation fixture set. Requires Pillow.

Network/decode time is recorded separately and excluded from CPU benchmarks.
"""
import array
import hashlib
import json
import math
from pathlib import Path
import sys
import time
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parent / ".cache" / "data"
LOCATIONS = [
    ("lax", 33.9425, -118.4081, 15),
    ("msp", 44.8848, -93.2223, 15),
    ("la_hills", 34.1203, -118.3200, 14),
    ("rainier", 46.8523, -121.7603, 12),
    ("grand_canyon", 36.1069, -112.1129, 12),
    ("alps", 45.8326, 6.8652, 12),
]


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, lat, lon, zoom in LOCATIONS:
        n = 2 ** zoom
        x = math.floor((lon + 180) / 360 * n)
        y = math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        url = f"https://tiles.mapterhorn.com/{zoom}/{x}/{y}.webp"
        path = ROOT / f"{name}.webp"
        if not path.exists():
            request = Request(url, headers={"User-Agent": "Mozilla/5.0 foss-earth-terrain-benchmark", "Accept": "image/webp,*/*"})
            with urlopen(request, timeout=25) as response:
                path.write_bytes(response.read())
        started = time.perf_counter()
        with Image.open(path) as image:
            assert image.width == image.height == 512, (name, image.size)
            pixels = list(image.convert("RGB").getdata())
        heights = array.array("f", (r * 256 + g + b / 256 - 32768 for r, g, b in pixels))
        decode_ms = (time.perf_counter() - started) * 1000
        minimum, maximum = min(heights), max(heights)
        if sys.byteorder != "little":
            heights.byteswap()
        (ROOT / f"{name}.f32").write_bytes(heights.tobytes())
        record = dict(name=name, lat=lat, lon=lon, z=zoom, x=x, y=y, size=512,
                      url=url, bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                      minimum=minimum, maximum=maximum, python_decode_ms=decode_ms,
                      approximate_width_m=40075016.6856 * math.cos(math.radians(lat)) / n)
        manifest.append(record)
        print(json.dumps(record), flush=True)
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
