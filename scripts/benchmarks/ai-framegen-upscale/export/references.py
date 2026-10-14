"""Reference cases for every candidate/profile: inputs, PyTorch fp32 CPU outputs, expected 8-bit outputs.

DESIGN.md section 6. For each candidate/profile (export order: small for both candidates, then
720p, 1080p, then RIFE 540p) and case writes <work>/references/<candidate>/<profile>/<case>/:

  src0.rgba8, src1.rgba8 (RIFE) / src0.rgba8 (RT4KSR)  u8 RGBA, alpha 255, valid size, row-major
  out.f32     PyTorch fp32 CPU reference output, valid region only, NCHW [1,3,H,W] float32, unclamped
  out.rgba8   expected 8-bit output rint(clip(out, 0, 1) * 255) as RGBA (alpha 255)
  meta.json   dims, hashes (sha256F32 = sha256 of the padded float32 model input), content, reference

All binary files are little-endian without headers. Cases:
  synthetic  RIFE: synthetic_pair(h, w, seed=20261012, dx=6, dy=3) (img1 is img0's canvas shifted by
             (dx, dy)); RT4KSR: img0 of the same generator (blurred seeded noise, rectangles, a line)
  natural    crops of the decoded northrop-mall equirect (corpus panorama 363729, sha256-verified):
             RIFE two crops, the second offset by (dx, dy) = (5, 2) source pixels; RT4KSR a crop at twice
             the input size reduced by PIL Image.reduce(2). The crop origin is the most detailed window
             (mean |luma gradient|) on a 32-pixel grid inside latitudes +-45 degrees (recorded).

The reference is the official PyTorch path (candidates.load(...)["reference"]): RIFE
Model.inference(img0, img1, 0.5, 1.0); RT4KSR the strict-loaded training form. The exported module
is also run and compared (RIFE: bitwise equality expected; RT4KSR: reparameterization error).
An existing case with identical hashes is kept; a changed one is moved to
<work>/references/superseded/<stamp>/. Also writes <work>/references/index.json and a run summary
under build/benchmarks/ai-framegen-upscale/references/<stamp>/results/references.json.

Run (nice: heavy CPU at 1080p):
  nice -n 10 <work>/venv/bin/python -I -B -X pycache_prefix=<work>/cache/pycache \\
    scripts/benchmarks/ai-framegen-upscale/export/references.py --corpus-root=<folder holding <panorama>/6144.jpg> \\
    [--candidates=rife-4.25-lite,rt4ksr-x2] [--profiles=small,720p,1080p,540p] [--cases=synthetic,natural] [--work=<dir>]
"""
from __future__ import annotations

import argparse
import json
import resource
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

CASES = ("synthetic", "natural")
SEED = 20261012
SYNTHETIC_SHIFT = (6, 3)  # (dx, dy) of the RIFE synthetic pair
NATURAL_PANORAMA = "northrop-mall"
NATURAL_SHIFT = (5, 2)  # (dx, dy) source pixels between the two RIFE natural crops
DETAIL_STRIDE = 32
DETAIL_BAND = (0.25, 0.75)  # rows of the equirect searched: latitudes +45 .. -45 degrees


# ─── Content ────────────────────────────────────────────────────────────

def _box_blur(a, r):
    """Separable box blur via cumulative sums, edge-padded, float64 (probes/rife/rife_common.py)."""
    import numpy as np

    if r <= 0:
        return a
    k = 2 * r + 1
    p = np.pad(a, ((r, r), (r, r), (0, 0)), mode="edge")
    c = np.cumsum(p, axis=0)
    c = np.concatenate([np.zeros_like(c[:1]), c], axis=0)
    a = (c[k:] - c[:-k]) / k
    c = np.cumsum(a, axis=1)
    c = np.concatenate([np.zeros_like(c[:, :1]), c], axis=1)
    return (c[:, k:] - c[:, :-k]) / k


def synthetic_canvas(h: int, w: int, seed: int = SEED):
    """(h + 64) x (w + 64) x 3 uint8 canvas: blurred noise at two scales, 12 flat rectangles, a white line."""
    import numpy as np

    rng = np.random.default_rng(seed)
    H, W = h + 64, w + 64
    base = 0.6 * _box_blur(rng.random((H, W, 3)), 6) + 0.4 * _box_blur(rng.random((H, W, 3)), 1)
    base = (base - base.min()) / (base.max() - base.min())
    for _ in range(12):
        y0, x0 = rng.integers(0, H - 20), rng.integers(0, W - 20)
        hh, ww = rng.integers(8, max(9, H // 4)), rng.integers(8, max(9, W // 4))
        base[y0:y0 + hh, x0:x0 + ww] = rng.random(3)
    yy, xx = np.mgrid[0:H, 0:W]
    base[np.abs(yy - xx * (H / W)) < 1.0] = (1.0, 1.0, 1.0)
    return np.clip(np.round(base * 255.0), 0, 255).astype(np.uint8)


def synthetic_pair(h: int, w: int, seed: int = SEED, dx: int = 6, dy: int = 3):
    """Deterministic RGB uint8 pair (H, W, 3): img1(y, x) = canvas(y + 32 + dy, x + 32 + dx).

    Port of synthetic_pair in build/ai-framegen-upscale/probes/rife/rife_common.py (same output):
    content moves by (-dx, -dy) from img0 to img1.
    """
    import numpy as np

    canvas = synthetic_canvas(h, w, seed)
    oy, ox = 32, 32
    img0 = canvas[oy:oy + h, ox:ox + w]
    img1 = canvas[oy + dy:oy + dy + h, ox + dx:ox + dx + w]
    return np.ascontiguousarray(img0), np.ascontiguousarray(img1), canvas


def detail_origin(rgb, height: int, width: int) -> dict:
    """Most detailed height x width window of an equirect (top-left on a DETAIL_STRIDE grid).

    Score = mean of |dY/dx| + |dY/dy| over the window, Y = (299 R + 587 G + 114 B) / 1000 (float64),
    differences to the right/lower neighbour; rows limited to DETAIL_BAND, no horizontal wrap.
    Ties go to the smallest (y, x).
    """
    import numpy as np

    rgb = np.asarray(rgb)
    full_h, full_w = rgb.shape[:2]
    luma = (299.0 * rgb[..., 0] + 587.0 * rgb[..., 1] + 114.0 * rgb[..., 2]) / 1000.0
    gradient = np.zeros_like(luma)
    gradient[:, :-1] += np.abs(np.diff(luma, axis=1))
    gradient[:-1, :] += np.abs(np.diff(luma, axis=0))
    integral = np.zeros((full_h + 1, full_w + 1))
    integral[1:, 1:] = gradient.cumsum(0).cumsum(1)
    top, bottom = int(DETAIL_BAND[0] * full_h), int(DETAIL_BAND[1] * full_h)
    ys = np.arange(top, bottom - height + 1, DETAIL_STRIDE)
    xs = np.arange(0, full_w - width + 1, DETAIL_STRIDE)
    if len(ys) == 0 or len(xs) == 0:
        raise SystemExit(f"crop {width}x{height} does not fit the search band of a {full_w}x{full_h} equirect")
    Y, X = np.meshgrid(ys, xs, indexing="ij")
    sums = integral[Y + height, X + width] - integral[Y, X + width] - integral[Y + height, X] + integral[Y, X]
    index = np.unravel_index(int(np.argmax(sums)), sums.shape)  # first maximum in (y, x) order
    return {"x": int(X[index]), "y": int(Y[index]), "width": width, "height": height,
            "score": round(float(sums[index]) / (height * width), 6),
            "rule": f"argmax mean(|dY/dx| + |dY/dy|), Y = (299R + 587G + 114B)/1000, top-left on a {DETAIL_STRIDE}-px "
                    f"grid, rows {top}..{bottom} (latitude +-45 deg), no wrap, ties to smallest (y, x)"}


def case_images(candidate: str, profile: str, case: str, corpus) -> tuple[list, dict]:
    """([HxWx3 uint8 per model input], content record) at the profile's valid input size.

    `corpus` is a callable returning the decoded northrop-mall equirect (cached by the caller).
    """
    import numpy as np
    from PIL import Image

    h, w = common.PROFILES[candidate][profile]["valid"]
    rife = candidate == "rife-4.25-lite"
    if case == "synthetic":
        dx, dy = SYNTHETIC_SHIFT
        img0, img1, canvas = synthetic_pair(h, w, SEED, dx, dy)
        content = {"kind": "synthetic",
                   "source": f"references.synthetic_pair({h}, {w}, seed={SEED}, dx={dx}, dy={dy})"
                             + ("" if rife else ", first image only"),
                   "sha256": common.sha256_bytes(canvas.tobytes()), "sha256Of": "generator canvas (HxWx3 uint8)",
                   "canvas": {"width": int(canvas.shape[1]), "height": int(canvas.shape[0])},
                   "crop": {"x": 32, "y": 32, "width": w, "height": h, **({"dx": dx, "dy": dy} if rife else {})}}
        return ([img0, img1] if rife else [img0]), content
    if case != "natural":
        raise SystemExit(f"unknown case: {case}")
    name, entry = common.corpus_entry(NATURAL_PANORAMA)
    pano = corpus()
    content = {"kind": "natural", "source": f"corpus {name} (YouVisit panorama {entry['panorama']}, {entry['file']})",
               "sha256": entry["sha256"], "sha256Of": "source JPEG bytes (decoded with PIL, RGB)"}
    if rife:
        dx, dy = NATURAL_SHIFT
        crop = detail_origin(pano, h + dy, w + dx)
        x, y = crop["x"], crop["y"]
        img0 = np.ascontiguousarray(pano[y:y + h, x:x + w])
        img1 = np.ascontiguousarray(pano[y + dy:y + dy + h, x + dx:x + dx + w])
        content["crop"] = {**crop, "width": w, "height": h, "dx": dx, "dy": dy,
                           "searchWindow": {"width": w + dx, "height": h + dy}}
        return [img0, img1], content
    crop = detail_origin(pano, 2 * h, 2 * w)
    x, y = crop["x"], crop["y"]
    with Image.fromarray(np.ascontiguousarray(pano[y:y + 2 * h, x:x + 2 * w])) as region:
        low = np.asarray(region.reduce(2))
    if low.shape != (h, w, 3):
        raise SystemExit(f"reduce(2) gave {low.shape}, expected {(h, w, 3)}")
    content["crop"] = {**crop, "downsample": "PIL.Image.reduce(2) (2x2 box average)", "output": {"width": w, "height": h}}
    return [np.ascontiguousarray(low)], content


# ─── Files ──────────────────────────────────────────────────────────────

def case_dir(work: Path, candidate: str, profile: str, case: str) -> Path:
    return Path(work) / "references" / candidate / profile / case


def rgba8_to_rgb(data: bytes, width: int, height: int):
    import numpy as np

    array = np.frombuffer(data, np.uint8)
    if array.size != width * height * 4:
        raise SystemExit(f"rgba8 size {array.size} != {width}x{height}x4")
    return array.reshape(height, width, 4)[..., :3]


def load_case(directory: Path) -> dict:
    """Stored case, verified: {"meta", "inputs": [padded float32 NCHW], "reference": valid float32 NCHW}.

    The model inputs are rebuilt from the .rgba8 files with common.to_model_input (the page's rule)
    and must reproduce sha256F32; every file must match its recorded sha256.
    """
    import numpy as np

    directory = Path(directory)
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    inputs = []
    for item in meta["inputs"]:
        data = (directory / item["file"]).read_bytes()
        if common.sha256_bytes(data) != item["sha256Rgba8"]:
            raise SystemExit(f"{directory / item['file']}: sha256 differs from meta.json")
        tensor = common.to_model_input(rgba8_to_rgb(data, item["width"], item["height"]), tuple(item["dims"][2:]))
        if common.sha256_array(tensor) != item["sha256F32"]:
            raise SystemExit(f"{directory / item['file']}: rebuilt float32 input does not reproduce sha256F32")
        inputs.append(tensor)
    output = meta["output"]
    data = (directory / output["file"]).read_bytes()
    if common.sha256_bytes(data) != output["sha256"]:
        raise SystemExit(f"{directory / output['file']}: sha256 differs from meta.json")
    reference = np.frombuffer(data, "<f4").reshape(output["fileDims"])
    expected_path = directory / output["expected8"]
    expected = expected_path.read_bytes()
    height, width = reference.shape[2:]
    if (common.sha256_bytes(expected) != output["expected8Sha256"]
            or len(expected) != height * width * 4):
        raise SystemExit(f"{expected_path}: expected8 hash or byte length differs from meta.json")
    rebuilt = np.rint(np.clip(reference[0].transpose(1, 2, 0), 0, 1) * np.float32(255)).astype(np.uint8)
    if common.to_rgba8(rebuilt) != expected:
        raise SystemExit(f"{expected_path}: expected8 does not follow the stored reference rounding rule")
    return {"meta": meta, "inputs": inputs, "reference": reference}


def same_case(old: Path, meta: dict) -> bool:
    """True when an existing case folder has the same input/output hashes (and its files match them)."""
    try:
        previous = json.loads((old / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False

    def key(m):
        return ([(i["file"], i["sha256Rgba8"], i["sha256F32"], tuple(i["dims"])) for i in m["inputs"]],
                (m["output"]["sha256"], m["output"]["expected8Sha256"], tuple(m["output"]["fileDims"])))

    try:
        if key(previous) != key(meta):
            return False
    except (KeyError, TypeError):
        return False
    files = [(i["file"], i["sha256Rgba8"]) for i in previous["inputs"]] + [
        (previous["output"]["file"], previous["output"]["sha256"]),
        (previous["output"]["expected8"], previous["output"]["expected8Sha256"])]
    return all((old / name).is_file() and common.sha256_file(old / name) == digest for name, digest in files)


# ─── Main ───────────────────────────────────────────────────────────────

def parse_list(value: str, allowed) -> list[str]:
    items = [item for item in value.split(",") if item]
    unknown = [item for item in items if item not in allowed]
    if unknown:
        raise SystemExit(f"unknown value(s) {unknown}; allowed: {list(allowed)}")
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", help="work folder (default build/benchmarks/ai-framegen-upscale/work)")
    parser.add_argument("--corpus-root", help="folder holding <panorama>/6144.jpg (natural cases)")
    parser.add_argument("--candidates", default=",".join(common.PROFILES))
    parser.add_argument("--profiles", default="small,720p,1080p,540p")
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    work = common.work_dir(args.work)
    common.apply_scratch_env(work)
    common.limit_threads(args.threads)
    candidates_wanted = parse_list(args.candidates, common.PROFILES)
    profiles_wanted = parse_list(args.profiles, {"small", "540p", "720p", "1080p"})
    cases = parse_list(args.cases, CASES)
    if "natural" in cases and not args.corpus_root:
        raise SystemExit("natural cases need --corpus-root=<folder holding <panorama>/6144.jpg>")

    import numpy as np
    import torch

    import candidates

    run = common.new_output_directory("references")
    stamp = run.name
    root = common.ensure_build_directory(Path(work) / "references")
    scripts = [common.script_receipt(Path(__file__)), common.script_receipt(Path(candidates.__file__)),
               common.script_receipt(Path(common.__file__))]
    environment = common.environment()
    command = common.python_command(Path(__file__), *sys.argv[1:])
    pano_cache = {}

    def corpus():
        if "rgb" not in pano_cache:
            pano_cache["rgb"] = common.corpus_image(args.corpus_root, NATURAL_PANORAMA)
        return pano_cache["rgb"]

    summary = {"schema": 1, "kind": "references", "createdAt": common.now_iso(), "command": command,
               "scripts": scripts, "environment": environment, "corpusRoot": args.corpus_root, "cases": []}
    loaded = {}
    jobs = [(c, p) for c, p in common.ORDER if c in candidates_wanted and p in profiles_wanted]
    for candidate, profile in jobs:
        if candidate not in loaded:
            loaded[candidate] = candidates.load(candidate, work)
        model = loaded[candidate]
        shape = common.PROFILES[candidate][profile]
        names = candidates.CANDIDATES[candidate]["inputs"]
        for case in cases:
            started = time.perf_counter()
            images, content = case_images(candidate, profile, case, corpus)
            tensors = [common.to_model_input(image, shape["padded"]) for image in images]
            torch_inputs = [torch.from_numpy(tensor) for tensor in tensors]
            if candidate == "rife-4.25-lite":
                candidates.clear_rife_grid_cache(model)
            t0 = time.perf_counter()
            with torch.inference_mode():
                output = model["reference"](*torch_inputs)
                reference_seconds = time.perf_counter() - t0
                exported = model["export"](*torch_inputs)
            output = output.numpy()
            exported = exported.numpy()
            out_h, out_w = shape["output"]
            scale = candidates.CANDIDATES[candidate]["outputScale"]
            expected_dims = [1, 3, shape["padded"][0] * scale, shape["padded"][1] * scale]
            if list(output.shape) != expected_dims or output.dtype != np.float32:
                raise SystemExit(f"{candidate} {profile}: reference output {output.shape} {output.dtype}, expected {expected_dims}")
            valid = np.ascontiguousarray(output[:, :, :out_h, :out_w])
            export_difference = np.abs(exported.astype(np.float64) - output.astype(np.float64))[:, :, :out_h, :out_w]
            expected8 = np.rint(np.clip(valid[0], 0, 1) * np.float32(255)).astype(np.uint8).transpose(1, 2, 0)
            out_bytes = valid.astype("<f4").tobytes()
            rgba = common.to_rgba8(expected8)
            inputs = []
            for index, (name, image, tensor) in enumerate(zip(names, images, tensors)):
                inputs.append({"name": name, "file": f"src{index}.rgba8", "width": int(image.shape[1]),
                               "height": int(image.shape[0]), "dims": list(tensor.shape),
                               "sha256Rgba8": common.sha256_bytes(common.to_rgba8(image)),
                               "sha256F32": common.sha256_array(tensor)})
            meta = {
                "schema": 1, "candidate": candidate, "profile": profile, "case": case,
                "inputs": inputs,
                "output": {"name": candidates.CANDIDATES[candidate]["output"], "dims": expected_dims,
                           "valid": {"x": 0, "y": 0, "width": out_w, "height": out_h},
                           "file": "out.f32", "fileDims": [1, 3, out_h, out_w], "sha256": common.sha256_bytes(out_bytes),
                           "expected8": "out.rgba8", "expected8Sha256": common.sha256_bytes(rgba),
                           "expected8Rule": "np.rint(np.clip(out, 0, 1) * float32(255)) as uint8 RGBA, alpha 255",
                           "min": float(valid.min()), "max": float(valid.max()),
                           "fractionOutside01": float(np.mean((valid < 0) | (valid > 1)))},
                "reference": {"implementation": model["referenceImplementation"], "torch": torch.__version__,
                              "threads": torch.get_num_threads(), "device": "cpu", "dtype": "float32",
                              "seconds": round(reference_seconds, 3),
                              "exportModule": {"implementation": model["exportImplementation"],
                                               "bitwiseEqual": bool(np.array_equal(exported, output)),
                                               "maxAbs": float(export_difference.max()),
                                               "meanAbs": float(export_difference.mean())},
                              "model": model["info"]},
                "content": content,
                "script": scripts[0], "modules": scripts[1:],
                "environment": {"python": environment["python"], "lockSha256": environment["lock"]["sha256"],
                                "lockMatchesInstalled": environment["lock"]["matchesInstalled"],
                                "packages": {k: environment["packages"].get(k) for k in ("torch", "numpy", "pillow")}},
                "command": command, "createdAt": common.now_iso(),
            }
            target = case_dir(work, candidate, profile, case)
            if same_case(target, meta):
                status = "unchanged"
                meta = json.loads((target / "meta.json").read_text(encoding="utf-8"))
            else:
                staging = common.ensure_build_directory(target.parent / f".staging-{case}-{stamp}")
                for index, image in enumerate(images):
                    common.write_bytes(staging / f"src{index}.rgba8", common.to_rgba8(image))
                common.write_bytes(staging / "out.f32", out_bytes)
                common.write_bytes(staging / "out.rgba8", rgba)
                common.write_json(staging / "meta.json", meta)
                status = "written"
                if target.exists():
                    moved = common.ensure_build_directory(root / "superseded" / stamp / candidate / profile)
                    shutil.move(str(target), str(moved / case))
                    status = "replaced"
                staging.rename(target)
            seconds = time.perf_counter() - started
            record = {"candidate": candidate, "profile": profile, "case": case, "status": status,
                      "directory": common.repo_relative(target), "inputs": meta["inputs"], "output": meta["output"],
                      "content": meta["content"], "referenceSeconds": meta["reference"]["seconds"],
                      "exportModule": meta["reference"]["exportModule"], "seconds": round(seconds, 3),
                      "maxRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
            summary["cases"].append(record)
            em = meta["reference"]["exportModule"]
            parity = "bitwise equal" if em["bitwiseEqual"] else "max abs %.3g" % em["maxAbs"]
            print(f"{candidate} {profile} {case}: {status}; out [{meta['output']['min']:.4f}, {meta['output']['max']:.4f}], "
                  f"export module {parity}, torch {meta['reference']['seconds']:.2f} s", flush=True)

    index = {"schema": 1, "updatedAt": common.now_iso(), "cases": []}
    for meta_path in sorted(root.glob("*/*/*/meta.json")):
        if "superseded" in meta_path.parts or meta_path.parent.name.startswith("."):
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        index["cases"].append({"candidate": meta["candidate"], "profile": meta["profile"], "case": meta["case"],
                               "path": meta_path.parent.relative_to(root).as_posix(),
                               "inputs": [{k: i[k] for k in ("name", "file", "width", "height", "dims", "sha256Rgba8", "sha256F32")}
                                          for i in meta["inputs"]],
                               "output": {k: meta["output"][k] for k in ("dims", "valid", "fileDims", "sha256", "expected8Sha256")},
                               "createdAt": meta["createdAt"]})
    common.write_json(root / "index.json", index)
    common.write_json(run / "results" / "references.json", summary)
    print(f"index: {common.repo_relative(root / 'index.json')} ({len(index['cases'])} cases); "
          f"summary: {common.repo_relative(run / 'results' / 'references.json')}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
