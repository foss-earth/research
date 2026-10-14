"""Replay sequences for the ai-framegen-upscale quality screen (DESIGN.md section 10, rule H).

Renders six short camera sequences from the UMN corpus equirectangular panoramas (the spherical
benchmark's CORPUS, 6144x3072 JPEG) at 120 fps for 0.5 s (61 frames, t = i / 120), each at the
native output sizes of the requested profiles and at half each dimension (the SR input):
720p -> 1280x720 and 640x360, 1080p -> 1920x1080 and 960x540.

  pan-slow     northrop-mall  yaw 30 deg/s
  pan-fast     stadium        yaw 120 deg/s, across the equirect's left/right seam
  diagonal     bookstore      yaw 60 deg/s and pitch 20 deg/s, over the shop signage
  zoom         walter-study   vertical FOV 90 -> 40 deg, cosine ease-in-out
  inertia      gardens        yaw rate decelerating linearly 180 deg/s -> 0
  cut          northrop-mall for frames 0-29, superblock from frame 30, yaw 30 deg/s throughout

Camera and image conventions are the spherical benchmark's (lib/views.mjs viewBasis, lib/source.mjs
tapLinear): yaw 0 looks along +Y, the equirect's centre column; positive yaw turns right, positive
pitch looks up; u = 0.5 + atan2(x, y) / 2pi to the right, v = 0.5 - asin(z) / pi downwards; a texel
centre sits at u * width - 0.5. The perspective camera has square pixels and the given vertical FOV.

Renderer: torch CPU grid_sample, bilinear, on the decoded 8-bit sRGB-encoded values (no linearization,
like the WGSL panorama pass sampling an rgba8unorm texture). Longitude wraps by padding the equirect
with WRAP columns copied from the opposite edge; latitude clamps (padding_mode "border"). Every output
pixel averages a regular 2x2 sub-grid of samples (box filter in sRGB-encoded values, summed in a fixed
order), rounded half to even; half-size frames are rendered directly with the same 2x2 sub-grid on
their own pixel grid (not downsampled from the native frame). Rows are rendered in chunks on a thread
pool; the result does not depend on the chunking or the thread count (checked by --verify).

  <work>/venv/bin/python -I -B -X pycache_prefix=<work>/cache/pycache \\
    research/scripts/benchmarks/ai-framegen-upscale/export/replay.py \\
    --corpus-root=<folder holding <panorama>/6144.jpg> [--profiles=720p,1080p] [--sequences=all] \\
    [--work=<dir>] [--threads=4] [--force] [--verify]

Run it under `nice -n 10`. Corpus files are checked against the sha256 pins in export/sources.json.

Writes <work>/replay/<sequence>/<W>x<H>/<frame:04d>.png and <work>/replay/<sequence>/sequence.json
(camera per frame, source file and decoded-pixel hashes, renderer parameters, PNG and pixel hashes of every
frame, script receipt, environment). A sequence whose sequence.json was written by the same script with the same
parameters and whose frames still match their hashes is left alone; otherwise the old folder is moved
to <work>/replay/superseded/<sequence>-<stamp>/ and the sequence is rendered again. --verify re-renders
frames 0, 30 and 60 at every size with a different chunking and compares pixel hashes.
Derived frames stay in build/ (corpus rights: commit numbers only).
"""
from __future__ import annotations

import argparse
import datetime
import io
import json
import math
import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

FPS = 120
FRAMES = 61  # 0.5 s inclusive of both ends
SUPERSAMPLE = 2
WRAP = 2  # wrapped columns on each side; bilinear taps reach at most 1.5 texels past an edge
CHUNK_ROWS = 60
PNG_LEVEL = 6
RAD = math.pi / 180
SIZES = {
    "720p": [{"width": 1280, "height": 720, "role": "native"}, {"width": 640, "height": 360, "role": "half"}],
    "1080p": [{"width": 1920, "height": 1080, "role": "native"}, {"width": 960, "height": 540, "role": "half"}],
}

# Start views were chosen by looking at the six panoramas (yaw grid previews), to put the motion over
# detail that shows warping, seams, ghosting and signage damage: people and buildings (pan-slow), stand
# lettering and the wrap seam (pan-fast), the shop sign and window (diagonal), the ornate doorway and
# shelves (zoom), flower beds (inertia), buildings on both sides of the cut.
SEQUENCES = {
    "pan-slow": {"panoramas": [[0, "northrop-mall"]], "path": "linear", "yaw": -7.5, "pitch": 0.0,
                 "yawRate": 30.0, "pitchRate": 0.0, "fov": 75.0},
    "pan-fast": {"panoramas": [[0, "stadium"]], "path": "linear", "yaw": 150.0, "pitch": 0.0,
                 "yawRate": 120.0, "pitchRate": 0.0, "fov": 75.0},
    "diagonal": {"panoramas": [[0, "bookstore"]], "path": "linear", "yaw": -10.0, "pitch": -5.0,
                 "yawRate": 60.0, "pitchRate": 20.0, "fov": 75.0},
    "zoom": {"panoramas": [[0, "walter-study"]], "path": "zoom", "yaw": 45.0, "pitch": 5.0,
             "fovStart": 90.0, "fovEnd": 40.0, "ease": "cosine"},
    "inertia": {"panoramas": [[0, "gardens"]], "path": "inertia", "yaw": -110.0, "pitch": -5.0,
                "yawRate": 180.0, "fov": 75.0},
    "cut": {"panoramas": [[0, "northrop-mall"], [30, "superblock"]], "path": "linear", "yaw": 60.0,
            "pitch": 0.0, "yawRate": 30.0, "pitchRate": 0.0, "fov": 75.0},
}
RENDERER = {
    "implementation": "torch.nn.functional.grid_sample (CPU, float32)",
    "mode": "bilinear",
    "paddingMode": "border (latitude clamp)",
    "alignCorners": False,
    "values": "8-bit sRGB-encoded values as float32 (no linearization)",
    "wrapColumns": WRAP,
    "supersample": SUPERSAMPLE,
    "filter": "box over the 2x2 regular sub-grid (x + (s + 0.5) / 2), fixed summation order",
    "rounding": "round half to even, clip to [0, 255]",
    "projection": "perspective, square pixels, vertical FOV; a = (2x/W - 1) tan(fov/2) W/H, b = (1 - 2y/H) tan(fov/2)",
    "convention": "spherical-image-representation lib/views.mjs viewBasis and lib/source.mjs tapLinear: "
                  "u = 0.5 + atan2(x, y)/2pi (right), v = 0.5 - asin(z)/pi (down), texel centre u*W - 0.5",
    "png": {"encoder": "Pillow", "compressLevel": PNG_LEVEL, "mode": "RGB"},
}


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--corpus-root", help="folder holding <panorama>/6144.jpg (default: $FOSS_EARTH_RESEARCH_CORPUS, else the spherical benchmark default)")
    parser.add_argument("--profiles", default="720p,1080p", help="comma list of 720p, 1080p")
    parser.add_argument("--sequences", default="all", help=f"comma list of {', '.join(SEQUENCES)} or all")
    parser.add_argument("--work", help="work folder (default: build/benchmarks/ai-framegen-upscale/work)")
    parser.add_argument("--threads", type=int, default=4, help="render threads (default 4)")
    parser.add_argument("--force", action="store_true", help="render again even when up to date (the old folder is moved to superseded/)")
    parser.add_argument("--verify", action="store_true", help="only check existing frames and re-render frames 0, 30, 60")
    args = parser.parse_args(argv)
    args.profiles = [p for p in args.profiles.split(",") if p]
    for profile in args.profiles:
        if profile not in SIZES:
            parser.error(f"unknown profile {profile}")
    args.sequences = list(SEQUENCES) if args.sequences == "all" else [s for s in args.sequences.split(",") if s]
    for sequence in args.sequences:
        if sequence not in SEQUENCES:
            parser.error(f"unknown sequence {sequence}")
    return args


# ─── Camera ─────────────────────────────────────────────────────────────

def camera(definition: dict, index: int) -> dict:
    """The camera of frame `index` (t = index / FPS): yaw, pitch, roll and vertical FOV in degrees."""
    t = index / FPS
    duration = (FRAMES - 1) / FPS
    yaw, pitch, fov = definition["yaw"], definition["pitch"], definition.get("fov")
    if definition["path"] == "linear":
        yaw += definition["yawRate"] * t
        pitch += definition["pitchRate"] * t
    elif definition["path"] == "inertia":
        # Constant deceleration from yawRate to 0 at the last frame.
        yaw += definition["yawRate"] * (t - t * t / (2 * duration))
    elif definition["path"] == "zoom":
        ease = (1 - math.cos(math.pi * t / duration)) / 2
        fov = definition["fovStart"] + (definition["fovEnd"] - definition["fovStart"]) * ease
    else:
        raise ValueError(definition["path"])
    panorama = [name for start, name in definition["panoramas"] if index >= start][-1]
    return {"index": index, "time": t, "panorama": panorama, "yaw": yaw, "pitch": pitch, "roll": 0.0, "fov": fov}


def view_basis(yaw: float, pitch: float, roll: float = 0.0):
    """forward, right, up (lib/views.mjs viewBasis)."""
    cy, sy, cp, sp = math.cos(yaw * RAD), math.sin(yaw * RAD), math.cos(pitch * RAD), math.sin(pitch * RAD)
    forward = (cp * sy, cp * cy, sp)
    right0, up0 = (cy, -sy, 0.0), (-sy * sp, -cy * sp, cp)
    cr, sr = math.cos(roll * RAD), math.sin(roll * RAD)
    right = tuple(r * cr + u * sr for r, u in zip(right0, up0))
    up = tuple(u * cr - r * sr for r, u in zip(right0, up0))
    return forward, right, up


# ─── Renderer ───────────────────────────────────────────────────────────

def wrapped_source(rgb):
    """[1, 3, H, W + 2 WRAP] float32 tensor of the u8 values, longitude wrapped by WRAP columns each side."""
    import torch

    height, width, _ = rgb.shape
    source = torch.empty((1, 3, height, width + 2 * WRAP), dtype=torch.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # PIL's array is read-only; it is only read here
        planar = torch.from_numpy(rgb).permute(2, 0, 1)
    source[0, :, :, WRAP:WRAP + width].copy_(planar)
    source[0, :, :, :WRAP].copy_(planar[:, :, width - WRAP:])
    source[0, :, :, WRAP + width:].copy_(planar[:, :, :WRAP])
    return source


def sample_grid(cam: dict, width: int, height: int, row0: int, row1: int, source_w: int, source_h: int):
    """grid_sample grid [1, rows * n, width * n, 2] for output rows row0..row1, sub-samples in pixel order."""
    import numpy as np
    import torch

    n = SUPERSAMPLE
    forward, right, up = view_basis(cam["yaw"], cam["pitch"], cam["roll"])
    half_v = math.tan(cam["fov"] * RAD / 2)
    half_h = half_v * width / height
    xs = (np.arange(width * n, dtype=np.float64) + 0.5) / n
    ys = (np.arange(row0 * n, row1 * n, dtype=np.float64) + 0.5) / n
    a = ((2 * xs / width - 1) * half_h)[None, :]
    b = ((1 - 2 * ys / height) * half_v)[:, None]
    x = forward[0] + a * right[0] + b * up[0]
    y = forward[1] + a * right[1] + b * up[1]
    z = forward[2] + a * right[2] + b * up[2]
    u = 0.5 + np.arctan2(x, y) / (2 * math.pi)
    v = 0.5 - np.arcsin(np.clip(z / np.sqrt(x * x + y * y + z * z), -1, 1)) / math.pi
    # Texel coordinates in the wrapped source, then grid_sample's align_corners=False normalization.
    fx = u * source_w - 0.5 + WRAP
    fy = v * source_h - 0.5
    grid = np.empty((1, ys.size, xs.size, 2), np.float32)
    grid[0, :, :, 0] = (2 * fx + 1) / (source_w + 2 * WRAP) - 1
    grid[0, :, :, 1] = (2 * fy + 1) / source_h - 1
    return torch.from_numpy(grid)


def render(source, source_w: int, source_h: int, cam: dict, width: int, height: int, pool=None, chunk_rows: int = CHUNK_ROWS):
    """HxWx3 uint8 frame of `cam` from a wrapped_source tensor."""
    import numpy as np
    import torch.nn.functional as F

    n = SUPERSAMPLE
    out = np.empty((height, width, 3), np.uint8)

    def rows(row0):
        row1 = min(height, row0 + chunk_rows)
        grid = sample_grid(cam, width, height, row0, row1, source_w, source_h)
        samples = F.grid_sample(source, grid, mode="bilinear", padding_mode="border", align_corners=False)
        s = samples[0].numpy().reshape(3, row1 - row0, n, width, n)
        total = ((s[:, :, 0, :, 0] + s[:, :, 0, :, 1]) + s[:, :, 1, :, 0]) + s[:, :, 1, :, 1]
        out[row0:row1] = np.clip(np.rint(total * np.float32(0.25)), 0, 255).astype(np.uint8).transpose(1, 2, 0)

    starts = range(0, height, chunk_rows)
    if pool is None:
        for row0 in starts:
            rows(row0)
    else:
        list(pool.map(rows, starts))
    return out


def encode_png(rgb) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buffer, format="PNG", compress_level=PNG_LEVEL)
    return buffer.getvalue()


def decode_png(data: bytes):
    import numpy as np
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        if image.mode != "RGB":
            raise ValueError(f"expected an RGB PNG, got {image.mode}")
        return np.asarray(image).copy()


# ─── Sequences ──────────────────────────────────────────────────────────

def size_key(size: dict) -> str:
    return f"{size['width']}x{size['height']}"


def sequence_parameters(name: str) -> dict:
    """Everything that determines the pixels except the corpus bytes and this script."""
    return {"sequence": name, "fps": FPS, "frames": FRAMES, "camera": SEQUENCES[name], "renderer": RENDERER}


def check_existing(folder: Path, parameters: dict, script_sha: str):
    """(record, verified size keys, problems) of an existing sequence folder; problems exclude per-size damage."""
    record_path = folder / "sequence.json"
    if not record_path.exists():
        return None, set(), ["no sequence.json"]
    record = json.loads(record_path.read_text(encoding="utf-8"))
    problems = []
    if record.get("parameters") != json.loads(json.dumps(parameters)):
        problems.append("parameters differ")
    if record.get("script", {}).get("sha256") != script_sha:
        problems.append("rendered by a different replay.py")
    verified = set()
    for size in record.get("sizes", []):
        key = size_key(size)
        bad = 0
        for frame in record["frames"]:
            entry = frame["files"].get(key)
            path = folder / key / f"{frame['index']:04d}.png"
            if entry is None or not path.exists() or common.sha256_file(path) != entry["sha256Png"]:
                bad += 1
        if bad:
            print(f"  {folder.name} {key}: {bad} frames missing or changed", flush=True)
        else:
            verified.add(key)
    return record, verified, problems


def supersede(folder: Path) -> Path:
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    target_parent = common.ensure_build_directory(folder.parent / "superseded")
    target = target_parent / f"{folder.name}-{stamp}"
    attempt = 2
    while target.exists():
        target = target_parent / f"{folder.name}-{stamp}-{attempt}"
        attempt += 1
    os.replace(folder, target)
    return target


def render_sequence(name: str, sizes: list[dict], replay: Path, corpus_root: Path, pool, threads: int,
                    script: dict, env: dict, command: str, keep: dict | None) -> dict:
    """Render every frame of `name` at `sizes` into replay/<name>.

    `keep` is the previous record of the same parameters and script with only its verified sizes listed;
    those sizes are reused and only the others are rendered.
    """
    definition = SEQUENCES[name]
    folder = common.ensure_build_directory(replay / name)
    started = time.perf_counter()
    cameras = [camera(definition, index) for index in range(FRAMES)]
    kept = keep["sizes"] if keep else []
    reuse = {size_key(s) for s in kept}
    todo = [s for s in sizes if size_key(s) not in reuse]
    frames = [{**cam, "files": {key: entry for key, entry in (keep["frames"][cam["index"]]["files"].items() if keep else [])
                                if key in reuse}} for cam in cameras]
    sources = []
    render_ms = {size_key(s): [] for s in todo}
    for position, (start, panorama) in enumerate(definition["panoramas"]):
        end = definition["panoramas"][position + 1][0] if position + 1 < len(definition["panoramas"]) else FRAMES
        corpus_name, entry = common.corpus_entry(panorama)
        rgb = common.corpus_image(corpus_root, panorama)
        source_h, source_w = rgb.shape[:2]
        sources.append({"name": corpus_name, "panorama": entry["panorama"], "file": f"{entry['panorama']}/{entry.get('file', '6144.jpg')}",
                        "sha256": entry["sha256"], "sha256Decoded": common.sha256_bytes(rgb.tobytes()),
                        "width": source_w, "height": source_h, "frames": [start, end - 1]})
        if not todo:
            continue
        source = wrapped_source(rgb)
        del rgb
        for index in range(start, end):
            for size in todo:
                key = size_key(size)
                t0 = time.perf_counter()
                image = render(source, source_w, source_h, cameras[index], size["width"], size["height"], pool)
                render_ms[key].append((time.perf_counter() - t0) * 1000)
                data = encode_png(image)
                common.write_bytes(folder / key / f"{index:04d}.png", data)
                frames[index]["files"][key] = {"sha256Png": common.sha256_bytes(data), "sha256Rgb": common.sha256_bytes(image.tobytes()), "bytes": len(data)}
            print(f"  {name} frame {index:2d} {cameras[index]['panorama']} yaw {cameras[index]['yaw']:8.3f} pitch {cameras[index]['pitch']:6.3f} fov {cameras[index]['fov']:6.3f}", flush=True)
        del source
    all_sizes = sorted([*kept, *todo], key=lambda s: -s["width"])
    record = {
        "schema": 1,
        "sequence": name,
        "description": describe(definition),
        "parameters": sequence_parameters(name),
        "fps": FPS,
        "frameCount": FRAMES,
        "durationSeconds": (FRAMES - 1) / FPS,
        "sources": sources,
        "corpusRoot": str(corpus_root),
        "sizes": all_sizes,
        "frames": frames,
        "renderMs": {key: {"median": sorted(v)[len(v) // 2], "count": len(v)} for key, v in render_ms.items() if v},
        "threads": threads,
        "elapsedSeconds": round(time.perf_counter() - started, 2),
        "script": script,
        "command": command,
        "environment": env,
        "createdAt": common.now_iso(),
    }
    if keep:
        record["reusedSizes"] = sorted(reuse)
    common.write_json(folder / "sequence.json", record)
    return record


def describe(definition: dict) -> str:
    names = " -> ".join(f"{name} (from frame {start})" if start else name for start, name in definition["panoramas"])
    if definition["path"] == "linear":
        motion = f"yaw {definition['yawRate']:g} deg/s" + (f", pitch {definition['pitchRate']:g} deg/s" if definition["pitchRate"] else "")
    elif definition["path"] == "inertia":
        motion = f"yaw rate {definition['yawRate']:g} deg/s decelerating linearly to 0"
    else:
        motion = f"vertical FOV {definition['fovStart']:g} -> {definition['fovEnd']:g} deg, {definition['ease']} ease-in-out"
    return f"{names}; {motion}; start yaw {definition['yaw']:g}, pitch {definition['pitch']:g}"


def verify_sequence(name: str, replay: Path, corpus_root: Path, pool) -> dict:
    """Check every stored frame hash and re-render frames 0, 30, 60 (single-row chunks differ from the run's)."""
    folder = replay / name
    record = json.loads((folder / "sequence.json").read_text(encoding="utf-8"))
    mismatched = []
    for frame in record["frames"]:
        for key, entry in frame["files"].items():
            path = folder / key / f"{frame['index']:04d}.png"
            data = path.read_bytes() if path.exists() else b""
            if common.sha256_bytes(data) != entry["sha256Png"]:
                mismatched.append(f"{key}/{frame['index']:04d}.png file")
            elif frame["index"] in (0, 30, 60) and common.sha256_bytes(decode_png(data).tobytes()) != entry["sha256Rgb"]:
                mismatched.append(f"{key}/{frame['index']:04d}.png pixels")
    rerendered = []
    definition = SEQUENCES[name]
    for position, (start, panorama) in enumerate(definition["panoramas"]):
        end = definition["panoramas"][position + 1][0] if position + 1 < len(definition["panoramas"]) else FRAMES
        indices = [i for i in (0, 30, 60) if start <= i < end]
        if not indices:
            continue
        rgb = common.corpus_image(corpus_root, panorama)
        source_h, source_w = rgb.shape[:2]
        source = wrapped_source(rgb)
        del rgb
        for index in indices:
            cam = camera(definition, index)
            for size in record["sizes"]:
                key = size_key(size)
                image = render(source, source_w, source_h, cam, size["width"], size["height"], pool, chunk_rows=7)
                same = common.sha256_bytes(image.tobytes()) == record["frames"][index]["files"][key]["sha256Rgb"]
                rerendered.append({"frame": index, "size": key, "identical": same})
                if not same:
                    mismatched.append(f"{key}/{index:04d}.png re-render")
        del source
    return {"sequence": name, "ok": not mismatched, "mismatched": mismatched, "rerendered": rerendered}


def main(argv=None):
    args = parse_arguments(argv)
    work = common.work_dir(args.work)
    common.apply_scratch_env(work)
    common.limit_threads(args.threads)
    import torch

    torch.set_num_threads(1)  # parallelism comes from the row-chunk pool; grid_sample runs one batch per call
    corpus_root = common.corpus_root(args.corpus_root)
    replay = common.ensure_build_directory(work / "replay")
    script = common.script_receipt(Path(__file__).resolve())
    sizes = [{**size, "profile": profile} for profile in args.profiles for size in SIZES[profile]]
    command = common.python_command(Path(__file__).resolve(), *(argv if argv is not None else sys.argv[1:]))
    with ThreadPoolExecutor(args.threads) as pool:
        if args.verify:
            results = [verify_sequence(name, replay, corpus_root, pool) for name in args.sequences]
            for result in results:
                print(f"{result['sequence']}: {'ok' if result['ok'] else 'MISMATCH'} ({len(result['rerendered'])} frames re-rendered)"
                      + ("" if result["ok"] else f" {result['mismatched'][:8]}"), flush=True)
            return 0 if all(r["ok"] for r in results) else 1
        env = common.environment()
        for name in args.sequences:
            folder = replay / name
            keep = None
            if folder.exists():
                record, verified, problems = check_existing(folder, sequence_parameters(name), script["sha256"])
                wanted = {size_key(s) for s in sizes}
                if not args.force and not problems and wanted <= verified:
                    print(f"{name}: up to date ({', '.join(sorted(wanted))})", flush=True)
                    continue
                if not args.force and not problems and verified:
                    # Same parameters and script: keep the verified sizes, render the others.
                    keep = {**record, "sizes": [s for s in record["sizes"] if size_key(s) in verified]}
                    print(f"{name}: reusing {sorted(verified)}", flush=True)
                else:
                    moved = supersede(folder)
                    print(f"{name}: {'; '.join(problems) or 'forced or damaged'}; previous folder moved to {common.repo_relative(moved)}", flush=True)
            print(f"{name}: rendering {', '.join(size_key(s) for s in sizes)}", flush=True)
            record = render_sequence(name, sizes, replay, corpus_root, pool, args.threads, script, env, command, keep)
            print(f"{name}: {record['elapsedSeconds']} s, render ms {record['renderMs']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
