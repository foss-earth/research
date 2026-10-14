"""Gate H quality screen on the replay sequences (DESIGN.md section 10, acceptance rule H).

Runs the exported ONNX graphs (the same files the browser runs; device parity is gate B) on
onnxruntime's CPUExecutionProvider over the frames written by replay.py, and compares them with
their controls on 8-bit RGB (every output quantized as round(clip(x, 0, 1) * 255), like the stored
reference `out.rgba8`):

- FG (rife-4.25-lite): for k = 4 (30 -> 60: endpoints f and f+4, truth f+2) and k = 2 (60 -> 120:
  endpoints f and f+2, truth f+1), every start frame f with f + k <= 60 of the native-size frames.
  The model midpoint (inputs u8/255 NCHW zero-padded right/bottom to the graph's multiple-of-128
  shape, output cropped top-left) against `repeat` (the earlier endpoint) and `blend`
  (round((A + B) / 2), half to even). Pairs that straddle a cut are excluded from the medians and
  verdicts and reported separately.
- SR (rt4ksr-x2): the 60 fps frames (even frame numbers) of each sequence. SR of the half-size frame
  against the native-size frame, with `bilinear` and `bicubic` controls (torch interpolate,
  align_corners False, antialias False) of the same half-size input. Flicker of a method X is the
  mean over consecutive 60 fps frame pairs, pixels and channels of |(X[t+1] - X[t]) - (N[t+1] - N[t])|
  in [0, 1] units; transitions across a cut are reported separately.
- SR diagnostic (information only, fp32): the same model and bicubic on the native frame downsampled
  by a 2x2 box and by antialiased PIL bicubic, to tell the model's sensitivity to how the
  low-resolution frame was made apart from the rendered half-size input that rule H uses.

PSNR and SSIM are skimage's (data_range 1, channel_axis 2, default 7x7 uniform window) on the
quantized images as float64 / 255. Verdicts follow rule H: the model's median PSNR and median SSIM
must exceed each control's (strictly) and SR flicker must not exceed bicubic's by more than 10 %.
FG is judged per sequence, as the rule says (an FG regime passes when every sequence passes; pooled
medians are reported for information). The SR bullet of the rule names no unit, so SR is judged both
per sequence and on the medians pooled over all sequences and passes only when both pass (the result
records each reading separately). Verdicts come from the fp32 graphs; fp16 graphs that ORT CPU can
run are reported as supplementary. Contact sheets (1:1 crops and |diff| heat maps) are for human
inspection, which this screen does not replace.

Final run (graphs from export.py, with their receipts):

  nice -n 10 <work>/venv/bin/python -I -B -X pycache_prefix=<work>/cache/pycache \\
    research/scripts/benchmarks/ai-framegen-upscale/export/quality.py \\
    [--candidates=rife-4.25-lite,rt4ksr-x2] [--profiles=720p,1080p,540p] [--precisions=fp32,fp16] \\
    [--sequences=all] [--work=<dir>] [--threads=4] [--no-sheets] [--no-sr-diagnostic]

Development run on graphs without receipts (results labelled development-only, written under
quality-dev/ instead of quality/): add --trial-model=<candidate>/<profile>=<file.onnx> (repeatable).
A trial RIFE graph smaller than the frames runs on a centred crop of the graph's size.

Resume an incomplete final run in that same directory (no new folder). Completed official
models and complete checkpoint sequences are reused; a short sequence is refused. Flags must
match the interrupted command. H is written only after a model's six sequences are complete:

  nice -n 10 <work>/venv/bin/python -I -B -X pycache_prefix=<work>/cache/pycache \\
    research/scripts/benchmarks/ai-framegen-upscale/export/quality.py \\
    --resume=<quality/<stamp>> --profiles=720p,1080p,540p --precisions=fp32,fp16 \\
    --threads=4 --no-sr-diagnostic
The RIFE-only 540p profile reuses the directly rendered 960x540 frames already made by
replay.py for the 1080p half-size source; RT4KSR has no 540p-output profile.

Writes build/benchmarks/ai-framegen-upscale/quality/<stamp>/results/{quality.json,quality-fg.csv,
quality-sr.csv}, sheets/<candidate>/<profile>-<precision>/*.png and logs/quality.log.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

RIFE, RT4KSR = "rife-4.25-lite", "rt4ksr-x2"
CANDIDATES = (RIFE, RT4KSR)
PROFILES = ("720p", "1080p", "540p")
NATIVE = {"720p": (720, 1280), "1080p": (1080, 1920), "540p": (540, 960)}
HALF = {"720p": (360, 640), "1080p": (540, 960)}
REGIMES = {4: "30->60", 2: "60->120"}
SR_STEP = 2  # the 60 fps frames of the 120 fps replay
FLICKER_LIMIT = 1.10
PAD_MULTIPLE = 128  # RIFE padding rule (inference_video.py)
CROP = 320  # contact-sheet tile, 1:1 pixels
HEAT_CODES = 48  # mean |diff| (codes) mapped to the top of the heat ramp
FG_METHODS = ("model", "repeat", "blend")
SR_METHODS = ("model", "bilinear", "bicubic")


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--candidates", default=",".join(CANDIDATES))
    parser.add_argument("--profiles", default=",".join(PROFILES))
    parser.add_argument("--precisions", default="fp32,fp16", help="fp16 runs only where ORT CPU can run it")
    parser.add_argument("--sequences", default="all", help="comma list of replay sequences, or all")
    parser.add_argument("--work", help="work folder (default: build/benchmarks/ai-framegen-upscale/work)")
    parser.add_argument("--threads", type=int, default=4, help="ORT intra-op and torch threads (default 4)")
    parser.add_argument("--no-sheets", action="store_true", help="skip contact sheets")
    parser.add_argument("--no-sr-diagnostic", action="store_true",
                        help="skip the informational SR run on downsampled native frames (fp32 only; never a gate input)")
    parser.add_argument("--trial-model", action="append", default=[], metavar="CANDIDATE/PROFILE=FILE",
                        help="development only: run this graph (no receipt) instead of work/models")
    parser.add_argument("--resume", help="continue this incomplete final quality run directory after validating its checkpoints")
    args = parser.parse_args(argv)
    args.candidates = [c for c in args.candidates.split(",") if c]
    args.profiles = [p for p in args.profiles.split(",") if p]
    args.precisions = [p for p in args.precisions.split(",") if p]
    for value, allowed in ((args.candidates, CANDIDATES), (args.profiles, PROFILES), (args.precisions, common.PRECISIONS)):
        for item in value:
            if item not in allowed:
                parser.error(f"unknown {item!r} (expected one of {', '.join(allowed)})")
    trials = {}
    for spec in args.trial_model:
        key, _, file = spec.partition("=")
        candidate, _, profile = key.partition("/")
        if candidate not in CANDIDATES or profile not in PROFILES or not file:
            parser.error(f"bad --trial-model {spec!r}")
        trials[(candidate, profile)] = Path(file).resolve()
    args.trials = trials
    return args


class Log:
    """print() to stdout and to the run's logs/quality.log."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(path, "a", encoding="utf-8")

    def __call__(self, *parts):
        line = " ".join(str(p) for p in parts)
        print(line, flush=True)
        self.handle.write(line + "\n")
        self.handle.flush()


# ─── Replay frames ──────────────────────────────────────────────────────

class Sequence:
    """One replay.py sequence: frames read on demand, each checked against its sha256 in sequence.json."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.name = folder.name
        self.json_path = folder / "sequence.json"
        self.record = json.loads(self.json_path.read_text(encoding="utf-8"))
        # A consistent PNG checksum alone cannot establish the intended camera/corpus. Reject
        # stale or partial records before measuring any quality on their frames.
        import replay

        if self.name not in replay.SEQUENCES or self.record.get("schema") != 1:
            raise SystemExit(f"{self.json_path}: unknown sequence or schema")
        expected_parameters = json.loads(json.dumps(replay.sequence_parameters(self.name)))
        if self.record.get("parameters") != expected_parameters:
            raise SystemExit(f"{self.json_path}: replay parameters differ (run replay.py)")
        if self.record.get("script", {}).get("sha256") != common.sha256_file(common.EXPORT / "replay.py"):
            raise SystemExit(f"{self.json_path}: replay script differs (run replay.py)")
        if self.record.get("frameCount") != replay.FRAMES or self.record.get("fps") != replay.FPS:
            raise SystemExit(f"{self.json_path}: incomplete frame count or wrong fps")
        frames = self.record.get("frames", [])
        if len(frames) != replay.FRAMES:
            raise SystemExit(f"{self.json_path}: expected {replay.FRAMES} frame records")
        definition = replay.SEQUENCES[self.name]
        for index, frame in enumerate(frames):
            if any(frame.get(key) != value for key, value in replay.camera(definition, index).items()):
                raise SystemExit(f"{self.json_path}: camera of frame {index} differs")
            for size in self.record.get("sizes", []):
                if replay.size_key(size) not in frame.get("files", {}):
                    raise SystemExit(f"{self.json_path}: frame {index} is missing a size")
        sources = self.record.get("sources", [])
        if len(sources) != len(definition["panoramas"]):
            raise SystemExit(f"{self.json_path}: corpus source count differs")
        for position, (start, panorama) in enumerate(definition["panoramas"]):
            name, pin = common.corpus_entry(panorama)
            end = definition["panoramas"][position + 1][0] if position + 1 < len(sources) else replay.FRAMES
            expected = {"name": name, "panorama": pin["panorama"], "sha256": pin["sha256"], "frames": [start, end - 1]}
            if any(sources[position].get(key) != value for key, value in expected.items()):
                raise SystemExit(f"{self.json_path}: source {position} differs from the corpus pin/path")
        self.frame_count = self.record["frameCount"]
        # A cut is the first frame of every source after the first.
        self.cuts = [source["frames"][0] for source in self.record["sources"][1:]]
        self.cache = {}

    def has_size(self, hw) -> bool:
        return any((s["height"], s["width"]) == tuple(hw) for s in self.record["sizes"])

    def frame(self, index: int, hw):
        import numpy as np
        from PIL import Image

        key = (index, tuple(hw))
        if key not in self.cache:
            size = f"{hw[1]}x{hw[0]}"
            entry = self.record["frames"][index]["files"][size]
            data = (self.folder / size / f"{index:04d}.png").read_bytes()
            if common.sha256_bytes(data) != entry["sha256Png"]:
                raise SystemExit(f"{self.name} {size} frame {index}: PNG sha256 differs from sequence.json (run replay.py)")
            with Image.open(io.BytesIO(data)) as image:
                if image.mode != "RGB" or image.size != (hw[1], hw[0]):
                    raise SystemExit(f"{self.name} {size} frame {index}: wrong PNG mode or dimensions")
                rgb = np.asarray(image).copy()
            if common.sha256_bytes(rgb.tobytes()) != entry["sha256Rgb"]:
                raise SystemExit(f"{self.name} {size} frame {index}: RGB sha256 differs from sequence.json")
            self.cache[key] = rgb
        return self.cache[key]

    def straddles(self, first: int, last: int) -> bool:
        return any(first < cut <= last for cut in self.cuts)

    def receipt(self) -> dict:
        return {"sequence": self.name, "path": common.repo_relative(self.json_path), "sha256": common.sha256_file(self.json_path),
                "sources": [{k: s[k] for k in ("name", "panorama", "sha256", "frames")} for s in self.record["sources"]],
                "description": self.record.get("description"), "replayScript": self.record.get("script"),
                "cuts": self.cuts}


# ─── Models ─────────────────────────────────────────────────────────────

class Model:
    """An exported graph on ORT CPU, checked against its receipt (final) or labelled as a trial."""

    def __init__(self, candidate: str, profile: str, precision: str, path: Path, receipt_path: Path | None, threads: int):
        import onnxruntime as ort

        self.candidate, self.profile, self.precision, self.path = candidate, profile, precision, path
        self.sha256 = common.sha256_file(path)
        self.receipt, self.receipt_file = None, None
        if receipt_path is not None:
            self.receipt_file = common.script_receipt(receipt_path)
            self.receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            if self.receipt.get("sha256") != self.sha256:
                raise SystemExit(f"{path}: sha256 {self.sha256} differs from its receipt {self.receipt.get('sha256')}")
            for field, want in (("candidate", candidate), ("profile", profile), ("precision", precision)):
                if self.receipt.get(field) != want:
                    raise SystemExit(f"{receipt_path}: {field} {self.receipt.get(field)!r} != {want!r}")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        inputs = self.session.get_inputs()
        self.input_names = [i.name for i in inputs]
        if candidate == RIFE:
            if len(inputs) != 2:
                raise SystemExit(f"{path}: expected two inputs (img0, img1), got {self.input_names}")
            if set(self.input_names) == {"img0", "img1"}:
                self.input_names = ["img0", "img1"]
        elif len(inputs) != 1:
            raise SystemExit(f"{path}: expected one input, got {self.input_names}")
        shapes = [tuple(i.shape) for i in inputs]
        if any(len(s) != 4 or not all(isinstance(d, int) for d in s) or s[:2] != (1, 3) or s != shapes[0] for s in shapes):
            raise SystemExit(f"{path}: inputs are not one fixed NCHW shape: {shapes}")
        self.padded = shapes[0][2:]
        outputs = self.session.get_outputs()
        if len(outputs) != 1 or any(i.type != "tensor(float)" for i in [*inputs, *outputs]):
            raise SystemExit(f"{path}: expected float32 I/O and one output")
        self.output_name = outputs[0].name
        if self.receipt is not None:
            profile_shape = common.PROFILES[candidate][profile]
            expected_inputs = ["img0", "img1"] if candidate == RIFE else ["input"]
            out_hw = profile_shape["padded"] if candidate == RIFE else profile_shape["output"]
            if self.input_names != expected_inputs or self.output_name != "output" or self.padded != profile_shape["padded"]:
                raise SystemExit(f"{path}: final graph input/output contract differs from the profile")
            if tuple(outputs[0].shape) != (1, 3, *out_hw):
                raise SystemExit(f"{path}: final graph output dimensions differ from the profile")
        self.milliseconds = []
        # One run on zeros: a graph ORT CPU loads but cannot execute (e.g. a missing fp16 kernel) fails
        # here rather than mid-screen; it also keeps first-run setup out of the recorded times.
        import numpy as np
        self.non_finite = 0
        self.run(*[np.zeros((1, 3, *self.padded), np.float32) for _ in self.input_names])
        self.zero_probe_non_finite = self.non_finite
        self.milliseconds = []

    def run(self, *arrays):
        import numpy as np

        feeds = {name: array for name, array in zip(self.input_names, arrays)}
        started = time.perf_counter()
        out = np.asarray(self.session.run([self.output_name], feeds)[0])
        self.milliseconds.append((time.perf_counter() - started) * 1000)
        bad = int(out.size - np.count_nonzero(np.isfinite(out)))
        if bad:
            # NaN/inf would quantize to arbitrary codes; count them (fp16 overflow) and pin them to 0.
            self.non_finite += bad
            out = np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)
        return out

    def describe(self) -> dict:
        record = {"candidate": self.candidate, "profile": self.profile, "precision": self.precision,
                  "file": common.repo_relative(self.path), "sha256": self.sha256, "bytes": self.path.stat().st_size,
                  "inputs": self.input_names, "inputDims": [1, 3, *self.padded], "output": self.output_name,
                  "trial": self.receipt is None, "nonFiniteOutputValues": self.non_finite,
                  "zeroProbeNonFiniteOutputValues": self.zero_probe_non_finite}
        if self.receipt is not None:
            record["receipt"] = {**self.receipt_file, **{k: self.receipt.get(k) for k in ("exporter", "opset", "nodeCount", "gateA", "fp16")}}
        return record

    def gate_a(self):
        """The receipt's gate A verdict (True/False), or None for trial graphs and receipts without one.

        Accepts {pass, ...}, a list of such entries (one per reference case) or {case: {pass, ...}}.
        """
        gate = (self.receipt or {}).get("gateA")
        if isinstance(gate, dict) and "pass" in gate:
            return gate["pass"]
        entries = list(gate.values()) if isinstance(gate, dict) else gate if isinstance(gate, list) else []
        verdicts = [e.get("pass") for e in entries if isinstance(e, dict)]
        if not verdicts or any(v is None for v in verdicts):
            return None
        return all(verdicts)


def quantize(planar):
    """[3, H, W] float -> HxWx3 uint8: round(clip(x, 0, 1) * 255), as the stored 8-bit references."""
    import numpy as np

    return np.rint(np.clip(planar, 0, 1) * 255).astype(np.uint8).transpose(1, 2, 0).copy()


def interpolate_midpoint(model: Model, a, b):
    """RIFE midpoint of two HxWx3 u8 frames: zero-pad to the graph shape, run, crop top-left, quantize."""
    height, width = a.shape[:2]
    out = model.run(common.to_model_input(a, model.padded), common.to_model_input(b, model.padded))
    return quantize(out[0, :, :height, :width])


def upscale(model: Model, low):
    out = model.run(common.to_model_input(low, model.padded))
    return quantize(out[0])


def blend(a, b):
    import numpy as np

    return np.rint((a.astype(np.float32) + b.astype(np.float32)) / 2).astype(np.uint8)


def resize(low, hw, mode: str):
    """torch interpolate of the same u8/255 input the model gets (align_corners False, antialias False)."""
    import torch
    import torch.nn.functional as F

    x = torch.from_numpy(common.to_model_input(low, low.shape[:2]))
    with torch.no_grad():
        y = F.interpolate(x, size=tuple(hw), mode=mode, align_corners=False, antialias=False)
    return quantize(y[0].numpy())


# ─── Metrics ────────────────────────────────────────────────────────────

def as_unit(image):
    import numpy as np

    return image.astype(np.float64) / 255


def psnr_ssim(truth_unit, image) -> tuple[float, float]:
    import numpy as np
    from skimage.metrics import peak_signal_noise_ratio, structural_similarity

    x = as_unit(image)
    with np.errstate(divide="ignore"):
        psnr = float(peak_signal_noise_ratio(truth_unit, x, data_range=1.0))
    ssim = float(structural_similarity(truth_unit, x, data_range=1.0, channel_axis=2))
    return psnr, ssim


class MetricRunner:
    """Exact independent method metrics, with content-checked precision-independent controls.

    ORT finishes before calculate() is called. At most three workers run metrics while
    ORT is idle; the cache contains only PSNR/SSIM scalars, never model outputs/images.
    """

    def __init__(self, threads: int):
        import numpy
        import skimage

        self.workers = min(3, threads)
        self.pool = ThreadPoolExecutor(max_workers=self.workers)
        self.cache = {}
        self.hits, self.misses = 0, 0
        self.implementation = common.sha256_bytes(json.dumps({
            "script": common.sha256_file(Path(__file__)), "lock": common.sha256_file(common.LOCK),
            "numpy": numpy.__version__, "skimage": skimage.__version__, "dtype": "float64", "ssim": "default7x7-channel-axis2-data-range1"
        }, sort_keys=True).encode())

    def calculate(self, truth, images: dict, context: tuple):
        truth_unit = as_unit(truth)
        truth_hash = common.sha256_bytes(truth.tobytes())
        results, pending = {}, []
        for method, image in images.items():
            key = (*context, method, truth_hash, common.sha256_bytes(image.tobytes()), self.implementation) if method != "model" else None
            if key is not None and key in self.cache:
                results[method] = self.cache[key]
                self.hits += 1
            else:
                if key is not None:
                    self.misses += 1
                pending.append((method, key, self.pool.submit(psnr_ssim, truth_unit, image)))
        for method, key, future in pending:
            results[method] = future.result()
            if key is not None:
                self.cache[key] = results[method]
        return results

    def describe(self):
        return {"maxMetricWorkers": self.workers, "ortRunsWhileMetricWorkersActive": False,
                "implementationSha256": self.implementation, "controlCacheEntries": len(self.cache),
                "controlCacheHits": self.hits, "controlCacheMisses": self.misses,
                "cacheKey": "candidate/profile/sequence/indices/method + truth/image u8 content hashes + metric implementation hash"}

    def close(self):
        self.pool.shutdown(wait=True)


def flicker(previous, current, native_previous, native_current) -> float:
    import numpy as np

    d = (current.astype(np.int16) - previous.astype(np.int16)) - (native_current.astype(np.int16) - native_previous.astype(np.int16))
    return float(np.abs(d).mean() / 255)


def median(values):
    import numpy as np

    return float(np.median(np.asarray(values, dtype=np.float64))) if len(values) else None


def finite(value, digits=6):
    """JSON-safe number: None for missing or non-finite (identical images give infinite PSNR)."""
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def csv_number(value, digits=6):
    if value is None:
        return ""
    return "inf" if math.isinf(value) else f"{value:.{digits}f}"


def beats(model_value, control_value) -> bool:
    return model_value is not None and control_value is not None and model_value > control_value


# ─── FG ─────────────────────────────────────────────────────────────────

def fg_crop_box(model: Model, hw, development: bool):
    """(y, x, h, w) region of the frames the graph runs on: the whole frame, or a centred dev crop."""
    height, width = hw
    if model.padded == tuple(-(-d // PAD_MULTIPLE) * PAD_MULTIPLE for d in hw):
        return (0, 0, height, width)
    ph, pw = model.padded
    if not development or ph % PAD_MULTIPLE or pw % PAD_MULTIPLE or ph > height or pw > width:
        raise SystemExit(f"{model.path}: graph input {model.padded} does not fit {hw} frames under the multiple-of-{PAD_MULTIPLE} padding rule")
    return ((height - ph) // 2, (width - pw) // 2, ph, pw)


def run_fg(model: Model, sequences: list[Sequence], profile: str, development: bool, log: Log, checkpoint=None, metrics=None, resume_rows=None, skip=()):
    """Every pair of every sequence for both regimes: (rows, crop box)."""
    hw = NATIVE[profile]
    y, x, h, w = fg_crop_box(model, hw, development)
    rows = [dict(row) for row in (resume_rows or [])]
    skip = set(skip)
    missing = skip.difference(sequence.name for sequence in sequences)
    if missing:
        raise SystemExit(f"checkpoint sequences are not in this run: {sorted(missing)}")
    for sequence in sequences:
        if sequence.name in skip:
            log(f"  fg {model.candidate} {profile} {model.precision} {sequence.name}: reused validated checkpoint")
            continue
        started = time.perf_counter()
        frame = lambda i: sequence.frame(i, hw)[y:y + h, x:x + w]  # noqa: E731
        for k in REGIMES:
            for first in range(0, sequence.frame_count - k):
                last, middle = first + k, first + k // 2
                a, b = frame(first), frame(last)
                truth = frame(middle)
                outputs = {"model": interpolate_midpoint(model, a, b), "repeat": a, "blend": blend(a, b)}
                row = {"sequence": sequence.name, "k": k, "regime": REGIMES[k], "first": first, "last": last,
                       "truth": middle, "cut": sequence.straddles(first, last), "modelMs": model.milliseconds[-1]}
                values = metrics.calculate(truth, outputs, (model.candidate, profile, sequence.name, k, first, last, middle)) if metrics else {
                    method: psnr_ssim(as_unit(truth), image) for method, image in outputs.items()}
                for method, value in values.items():
                    row[f"psnr_{method}"], row[f"ssim_{method}"] = value
                rows.append(row)
        sequence.cache.clear()
        log(f"  fg {model.candidate} {profile} {model.precision} {sequence.name}: {time.perf_counter() - started:.1f} s")
        if checkpoint:
            checkpoint(rows, sequence.name)
    return rows, (y, x, h, w)


def summarize_fg(rows: list[dict], sequence_names: list[str]) -> dict:
    regimes = {}
    for k, regime in REGIMES.items():
        per_sequence = {}
        for name in sequence_names:
            selected = [r for r in rows if r["k"] == k and r["sequence"] == name and not r["cut"]]
            per_sequence[name] = fg_medians(selected)
        pooled = fg_medians([r for r in rows if r["k"] == k and not r["cut"]])
        cut_rows = [r for r in rows if r["k"] == k and r["cut"]]
        # Rule H judges FG per sequence; the pooled medians are information only.
        verdict = bool(per_sequence) and all(s["pass"] for s in per_sequence.values())
        regimes[regime] = {"k": k, "sequences": per_sequence, "pooled": pooled, "verdict": "pass" if verdict else "fail",
                           "failingSequences": [n for n, s in per_sequence.items() if not s["pass"]],
                           "cutPairs": {"medians": fg_medians(cut_rows)["medians"] if cut_rows else None,
                                        "pairs": [{key: (finite(v) if isinstance(v, float) else v) for key, v in r.items()
                                                   if key not in ("regime", "modelMs")} for r in cut_rows]}}
    return regimes


def fg_medians(rows: list[dict]) -> dict:
    medians = {f"{metric}_{method}": median([r[f"{metric}_{method}"] for r in rows]) for metric in ("psnr", "ssim") for method in FG_METHODS}
    checks = {f"{metric}>{control}": beats(medians[f"{metric}_model"], medians[f"{metric}_{control}"])
              for metric in ("psnr", "ssim") for control in ("repeat", "blend")}
    wins = {f"{metric}>{control}": sum(1 for r in rows if r[f"{metric}_model"] > r[f"{metric}_{control}"])
            for metric in ("psnr", "ssim") for control in ("repeat", "blend")}
    return {"pairs": len(rows), "medians": {k: finite(v) for k, v in medians.items()}, "checks": checks,
            "pairWins": wins, "pass": bool(rows) and all(checks.values())}


# ─── SR ─────────────────────────────────────────────────────────────────

def run_sr(model: Model, sequences: list[Sequence], profile: str, log: Log, checkpoint=None, metrics=None, resume_rows=None, skip=()):
    hw_low, hw = HALF[profile], NATIVE[profile]
    if model.padded != hw_low:
        raise SystemExit(f"{model.path}: graph input {model.padded} != half-size frames {hw_low}")
    rows = [dict(row) for row in (resume_rows or [])]
    skip = set(skip)
    missing = skip.difference(sequence.name for sequence in sequences)
    if missing:
        raise SystemExit(f"checkpoint sequences are not in this run: {sorted(missing)}")
    for sequence in sequences:
        if sequence.name in skip:
            log(f"  sr {model.candidate} {profile} {model.precision} {sequence.name}: reused validated checkpoint")
            continue
        started = time.perf_counter()
        previous = None
        for index in range(0, sequence.frame_count, SR_STEP):
            low, native = sequence.frame(index, hw_low), sequence.frame(index, hw)
            outputs = {"model": upscale(model, low), "bilinear": resize(low, hw, "bilinear"), "bicubic": resize(low, hw, "bicubic")}
            if outputs["model"].shape != native.shape:
                raise SystemExit(f"{model.path}: output {outputs['model'].shape} != native {native.shape}")
            row = {"sequence": sequence.name, "frame": index, "modelMs": model.milliseconds[-1]}
            values = metrics.calculate(native, outputs, (model.candidate, profile, sequence.name, index)) if metrics else {
                method: psnr_ssim(as_unit(native), image) for method, image in outputs.items()}
            for method, value in values.items():
                row[f"psnr_{method}"], row[f"ssim_{method}"] = value
            if previous is not None:
                row["flickerFrom"] = previous["index"]
                row["flickerCut"] = sequence.straddles(previous["index"], index)
                for method, image in outputs.items():
                    row[f"flicker_{method}"] = flicker(previous["outputs"][method], image, previous["native"], native)
            rows.append(row)
            previous = {"index": index, "outputs": outputs, "native": native}
        sequence.cache.clear()
        log(f"  sr {model.candidate} {profile} {model.precision} {sequence.name}: {time.perf_counter() - started:.1f} s")
        if checkpoint:
            checkpoint(rows, sequence.name)
    return rows


def degraded_inputs(native, hw_low) -> dict:
    """Conventional half-size versions of a native frame (informational SR diagnostic, not rule H inputs)."""
    import numpy as np
    from PIL import Image

    image = Image.fromarray(native)
    return {"area": np.asarray(image.reduce(2)),  # 2x2 box
            "bicubic-aa": np.asarray(image.resize((hw_low[1], hw_low[0]), Image.BICUBIC))}  # antialiased, a = -0.5


def run_sr_diagnostic(model: Model, sequences: list[Sequence], profile: str, log: Log) -> dict:
    """Model and bicubic upscaling of downsampled native frames instead of the rendered half-size frames.

    Separates the model's response to the degradation from the rendering of the low-resolution frame:
    rule H uses the directly rendered half-size frames; super-resolution models are usually trained on
    antialiased bicubic downsamples. Per sequence medians; never part of a verdict.
    """
    hw_low, hw = HALF[profile], NATIVE[profile]
    out = {}
    for sequence in sequences:
        values = {}
        for index in range(0, sequence.frame_count, SR_STEP):
            native = sequence.frame(index, hw)
            truth = as_unit(native)
            for kind, low in degraded_inputs(native, hw_low).items():
                for method, image in (("model", upscale(model, low)), ("bicubic", resize(low, hw, "bicubic"))):
                    psnr, ssim = psnr_ssim(truth, image)
                    values.setdefault(f"{kind}/psnr_{method}", []).append(psnr)
                    values.setdefault(f"{kind}/ssim_{method}", []).append(ssim)
        sequence.cache.clear()
        out[sequence.name] = {}
        for key, items in values.items():
            kind, metric = key.split("/")
            out[sequence.name].setdefault(kind, {})[metric] = finite(median(items))
        log(f"  sr diagnostic {model.candidate} {profile} {model.precision} {sequence.name}: "
            + " ".join(f"{kind} psnr {v['psnr_model']:.3f} vs bicubic {v['psnr_bicubic']:.3f}" for kind, v in out[sequence.name].items()))
    return out


def summarize_sr(rows: list[dict], sequence_names: list[str]) -> dict:
    per_sequence = {name: sr_medians([r for r in rows if r["sequence"] == name]) for name in sequence_names}
    pooled = sr_medians(rows)
    # The SR bullet of rule H names no unit: require both readings, record each.
    per_sequence_pass = bool(per_sequence) and all(s["pass"] for s in per_sequence.values())
    verdict = per_sequence_pass and pooled["pass"]
    cut = [r for r in rows if r.get("flickerCut")]
    return {"sequences": per_sequence, "pooled": pooled, "verdict": "pass" if verdict else "fail",
            "readings": {"perSequence": "pass" if per_sequence_pass else "fail", "pooled": "pass" if pooled["pass"] else "fail"},
            "failingSequences": [n for n, s in per_sequence.items() if not s["pass"]],
            "cutTransitions": [{"sequence": r["sequence"], "from": r["flickerFrom"], "to": r["frame"],
                                **{f"flicker_{m}": finite(r[f"flicker_{m}"]) for m in SR_METHODS}} for r in cut]}


def sr_medians(rows: list[dict]) -> dict:
    medians = {f"{metric}_{method}": median([r[f"{metric}_{method}"] for r in rows]) for metric in ("psnr", "ssim") for method in SR_METHODS}
    transitions = [r for r in rows if "flickerFrom" in r and not r["flickerCut"]]
    flickers = {method: (sum(r[f"flicker_{method}"] for r in transitions) / len(transitions) if transitions else None) for method in SR_METHODS}
    checks = {f"{metric}>{control}": beats(medians[f"{metric}_model"], medians[f"{metric}_{control}"])
              for metric in ("psnr", "ssim") for control in ("bilinear", "bicubic")}
    ratio = flickers["model"] / flickers["bicubic"] if transitions and flickers["bicubic"] else None
    checks[f"flicker<={FLICKER_LIMIT:.2f}*bicubic"] = ratio is not None and ratio <= FLICKER_LIMIT
    return {"frames": len(rows), "transitions": len(transitions), "medians": {k: finite(v) for k, v in medians.items()},
            "flicker": {k: finite(v, 8) for k, v in flickers.items()}, "flickerRatioToBicubic": finite(ratio),
            "checks": checks, "pass": bool(rows) and all(checks.values())}


# ─── Contact sheets ─────────────────────────────────────────────────────

def heat(a, b):
    """Mean |a - b| over RGB as a black-red-yellow-white ramp, HEAT_CODES codes at the top."""
    import numpy as np

    v = np.clip(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean(axis=2) / HEAT_CODES, 0, 1)
    return (np.stack([np.clip(3 * v, 0, 1), np.clip(3 * v - 1, 0, 1), np.clip(3 * v - 2, 0, 1)], axis=2) * 255).astype(np.uint8)


def worst_window(a, b, size: int):
    """(y, x) of the size x size window with the largest mean |a - b| (stride 16)."""
    import numpy as np

    error = np.abs(a.astype(np.int16) - b.astype(np.int16)).sum(axis=2).astype(np.float64)
    height, width = error.shape
    size_y, size_x = min(size, height), min(size, width)
    table = np.zeros((height + 1, width + 1))
    table[1:, 1:] = error.cumsum(0).cumsum(1)
    ys = np.arange(0, height - size_y + 1, 16)
    xs = np.arange(0, width - size_x + 1, 16)
    sums = table[ys[:, None] + size_y, xs[None, :] + size_x] - table[ys[:, None], xs[None, :] + size_x] \
        - table[ys[:, None] + size_y, xs[None, :]] + table[ys[:, None], xs[None, :]]
    iy, ix = np.unravel_index(int(np.argmax(sums)), sums.shape)
    return int(ys[iy]), int(xs[ix])


def thumbnail(image, box, size: int):
    """The whole frame scaled to `size` wide on a size x size tile, the crop box outlined."""
    import numpy as np
    from PIL import Image, ImageDraw

    height, width = image.shape[:2]
    scale = size / width
    thumb = Image.fromarray(image).resize((size, max(1, round(height * scale))), Image.BOX)
    tile = Image.new("RGB", (size, size), (40, 40, 40))
    tile.paste(thumb, (0, 0))
    y, x = box
    ImageDraw.Draw(tile).rectangle([x * scale, y * scale, (x + CROP) * scale, (y + CROP) * scale], outline=(0, 255, 255), width=2)
    return np.asarray(tile)


def font(size: int = 14):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def write_sheet(path: Path, header: list[str], rows: list[list[tuple[str, object]]]):
    """Rows of labelled CROP x CROP tiles under a text header."""
    from PIL import Image, ImageDraw

    label_h, header_h = 18, 8 + 18 * len(header)
    columns = max(len(r) for r in rows)
    sheet = Image.new("RGB", (columns * (CROP + 4) + 4, header_h + len(rows) * (CROP + label_h + 4) + 4), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    for i, line in enumerate(header):
        draw.text((6, 4 + 18 * i), line, fill=(235, 235, 235), font=font())
    for r, row in enumerate(rows):
        top = header_h + r * (CROP + label_h + 4)
        for c, (label, tile) in enumerate(row):
            left = 4 + c * (CROP + 4)
            draw.text((left + 2, top + 1), label, fill=(255, 220, 120), font=font(13))
            sheet.paste(Image.fromarray(tile), (left, top + label_h))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, format="PNG", compress_level=6)


def crop(image, box):
    y, x = box
    return image[y:y + CROP, x:x + CROP]


def fg_sheets(model: Model, sequences: dict, rows: list[dict], box, profile: str, folder: Path, label: str) -> list[str]:
    """Per sequence and regime: the median and the worst non-cut pair (by model PSNR), plus one cut pair."""
    written = []
    y0, x0, h, w = box
    for name, sequence in sequences.items():
        for k, regime in REGIMES.items():
            pairs = sorted([r for r in rows if r["sequence"] == name and r["k"] == k and not r["cut"]], key=lambda r: r["psnr_model"])
            picks = [("worst", pairs[0]), ("median", pairs[len(pairs) // 2])] if pairs else []
            cut = [r for r in rows if r["sequence"] == name and r["k"] == k and r["cut"]]
            if cut:
                picks.append(("cut", cut[len(cut) // 2]))
            for kind, row in picks:
                frame = lambda i: sequence.frame(i, NATIVE[profile])[y0:y0 + h, x0:x0 + w]  # noqa: E731
                a, b, truth = frame(row["first"]), frame(row["last"]), frame(row["truth"])
                images = {"truth": truth, "model": interpolate_midpoint(model, a, b), "repeat": a, "blend": blend(a, b)}
                tiles = []
                for focus in ("model", "blend"):
                    at = worst_window(images[focus], truth, CROP)
                    tiles.append([(f"{m} (crop at max |{focus}-truth|)" if m == "truth" else m, crop(img, at)) for m, img in images.items()])
                    tiles.append([(f"|{m}-truth|", crop(heat(images[m], truth), at)) for m in FG_METHODS] + [("frame", thumbnail(truth, at, CROP))])
                header = [f"{label} {model.candidate} {profile} {model.precision}  {name}  {regime} (k={k}) {kind} pair: "
                          f"endpoints {row['first']},{row['last']} truth {row['truth']}{' CUT' if row['cut'] else ''}",
                          "PSNR model/repeat/blend " + " / ".join(f"{row[f'psnr_{m}']:.2f}" for m in FG_METHODS)
                          + "   SSIM " + " / ".join(f"{row[f'ssim_{m}']:.4f}" for m in FG_METHODS),
                          f"1:1 crops {CROP}px; heat = mean |diff| over RGB, 0..{HEAT_CODES} codes black-red-yellow-white"
                          + (f"; frames cropped to {h}x{w} at ({y0},{x0})" if (h, w) != NATIVE[profile] else "")]
                path = folder / f"fg-{name}-k{k}-{kind}-f{row['first']:02d}.png"
                write_sheet(path, header, tiles)
                written.append(common.repo_relative(path))
            sequence.cache.clear()
    return written


def sr_sheets(model: Model, sequences: dict, rows: list[dict], profile: str, folder: Path, label: str) -> list[str]:
    """Per sequence: the frame with the median and the worst model PSNR."""
    written = []
    for name, sequence in sequences.items():
        frames = sorted([r for r in rows if r["sequence"] == name], key=lambda r: r["psnr_model"])
        for kind, row in (("worst", frames[0]), ("median", frames[len(frames) // 2])) if frames else ():
            low, native = sequence.frame(row["frame"], HALF[profile]), sequence.frame(row["frame"], NATIVE[profile])
            images = {"native": native, "model": upscale(model, low), "bicubic": resize(low, NATIVE[profile], "bicubic"),
                      "bilinear": resize(low, NATIVE[profile], "bilinear")}
            tiles = []
            for focus, other in (("model", "native"), ("model", "bicubic")):
                at = worst_window(images[focus], images[other], CROP)
                tiles.append([(f"{m} (crop at max |{focus}-{other}|)" if m == "native" else m, crop(img, at)) for m, img in images.items()])
                tiles.append([(f"|{m}-native|", crop(heat(images[m], native), at)) for m in SR_METHODS] + [("frame", thumbnail(native, at, CROP))])
            header = [f"{label} {model.candidate} {profile} {model.precision}  {name}  {kind} frame {row['frame']} "
                      f"(SR of {HALF[profile][1]}x{HALF[profile][0]} vs native {NATIVE[profile][1]}x{NATIVE[profile][0]})",
                      "PSNR model/bilinear/bicubic " + " / ".join(f"{row[f'psnr_{m}']:.2f}" for m in SR_METHODS)
                      + "   SSIM " + " / ".join(f"{row[f'ssim_{m}']:.4f}" for m in SR_METHODS),
                      f"1:1 crops {CROP}px; heat = mean |diff| over RGB, 0..{HEAT_CODES} codes black-red-yellow-white"]
            path = folder / f"sr-{name}-{kind}-f{row['frame']:02d}.png"
            write_sheet(path, header, tiles)
            written.append(common.repo_relative(path))
        sequence.cache.clear()
    return written


# ─── CSV ────────────────────────────────────────────────────────────────

FG_COLUMNS = ["candidate", "profile", "precision", "sequence", "regime", "k", "first", "last", "truth", "cut",
              *[f"{m}_{x}" for m in ("psnr", "ssim") for x in FG_METHODS], "modelMs"]
SR_COLUMNS = ["candidate", "profile", "precision", "sequence", "frame", *[f"{m}_{x}" for m in ("psnr", "ssim") for x in SR_METHODS],
              "flickerFrom", "flickerCut", *[f"flicker_{x}" for x in SR_METHODS], "modelMs"]


def csv_digits(column: str) -> int:
    if column == "modelMs":
        return 3
    if column.startswith("flicker"):
        return 8
    return 6


def csv_field(column: str, value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return csv_number(value, csv_digits(column))
    if value is None:
        return ""
    return str(value)


def format_csv_line(columns: list[str], row: dict) -> str:
    """One data line. Fields that need quotes are refused so preserved checkpoint lines stay the writer."""
    fields = [csv_field(column, row.get(column)) for column in columns]
    if any(any(ch in field for ch in ",\"\r\n") for field in fields):
        raise SystemExit("CSV field needs quoting; refusing a formatter that would diverge from checkpoint lines")
    return ",".join(fields)


def write_csv(path: Path, columns: list[str], rows: list[dict]):
    lines = [",".join(columns)]
    lines.extend(format_csv_line(columns, row) for row in rows)
    common.write_bytes(path, ("\n".join(lines) + "\n").encode())


class RowSink:
    """Official CSV. `preserved` lines are written back unchanged; None formats every row."""

    def __init__(self, columns: list[str], preserved):
        self.columns = columns
        self.preserved = None if preserved is None else list(preserved)
        self.rows = []

    def add_raw(self, lines: list[str]):
        if self.preserved is None:
            raise SystemExit("raw checkpoint lines are only appended on resume")
        self.preserved.extend(lines)

    def add(self, rows: list[dict]):
        self.rows.extend(rows)

    def write(self, path: Path):
        if self.preserved is None:
            write_csv(path, self.columns, self.rows)
            return
        body = self.preserved + [format_csv_line(self.columns, row) for row in self.rows]
        common.write_bytes(path, (",".join(self.columns) + "\n" + "".join(f"{line}\n" for line in body)).encode())


def fg_grid(frame_count: int = 61):
    return [(regime, k, first, first + k, first + k // 2)
            for k, regime in REGIMES.items() for first in range(0, frame_count - k)]


def load_table(path: Path, columns: list[str]) -> list[str]:
    text = path.read_bytes()
    if b"\r" in text or not text.endswith(b"\n"):
        raise SystemExit(f"{path}: CSV must be LF-terminated")
    lines = text.decode("utf-8").split("\n")[:-1]
    if not lines or lines[0] != ",".join(columns):
        raise SystemExit(f"{path}: header differs from the current columns")
    return lines[1:]


def parse_line(columns: list[str], line: str) -> dict:
    fields = next(csv.reader([line]))
    if len(fields) != len(columns):
        raise SystemExit(f"CSV column count {len(fields)} != {len(columns)}")
    return dict(zip(columns, fields))


def typed_number(text: str, field: str):
    if text == "":
        raise SystemExit(f"missing {field}")
    value = math.inf if text == "inf" else float(text)
    if not math.isfinite(value) and text != "inf":
        raise SystemExit(f"non-finite {field}")
    return value


def close_to(actual, expected, tolerance, label):
    if expected is None and not math.isfinite(actual):
        return
    if expected is None or abs(actual - expected) > tolerance:
        raise SystemExit(f"{label}: {actual} != stored {expected}")


def typed_fg_row(raw: dict) -> dict:
    if raw["cut"] not in ("true", "false"):
        raise SystemExit(f"bad cut flag {raw['cut']!r}")
    row = {"sequence": raw["sequence"], "regime": raw["regime"], "k": int(raw["k"]), "first": int(raw["first"]),
           "last": int(raw["last"]), "truth": int(raw["truth"]), "cut": raw["cut"] == "true",
           "modelMs": typed_number(raw["modelMs"], "modelMs")}
    for method in FG_METHODS:
        for metric in ("psnr", "ssim"):
            row[f"{metric}_{method}"] = typed_number(raw[f"{metric}_{method}"], f"{metric}_{method}")
    return row


def typed_sr_row(raw: dict) -> dict:
    row = {"sequence": raw["sequence"], "frame": int(raw["frame"]), "modelMs": typed_number(raw["modelMs"], "modelMs")}
    for method in SR_METHODS:
        for metric in ("psnr", "ssim"):
            row[f"{metric}_{method}"] = typed_number(raw[f"{metric}_{method}"], f"{metric}_{method}")
    if raw["flickerFrom"] == "":
        if any(raw[field] != "" for field in ("flickerCut", *[f"flicker_{method}" for method in SR_METHODS])):
            raise SystemExit(f"{raw['sequence']} frame {raw['frame']}: flicker values without a source frame")
        return row
    if raw["flickerCut"] not in ("true", "false"):
        raise SystemExit("bad flickerCut flag")
    row["flickerFrom"] = int(raw["flickerFrom"])
    row["flickerCut"] = raw["flickerCut"] == "true"
    for method in SR_METHODS:
        row[f"flicker_{method}"] = typed_number(raw[f"flicker_{method}"], f"flicker_{method}")
    return row


def _finish_group(order, typed, current, bucket):
    order.append(current)
    typed.extend(bucket)
    return []


def validate_fg_lines(lines: list[str], candidate: str, profile: str, precision: str, cut_frame: int):
    """Complete sequences only. A short trailing sequence is an error, not a row to drop."""
    grid = fg_grid()
    order, typed, current, bucket = [], [], None, []
    for line in lines:
        raw = parse_line(FG_COLUMNS, line)
        if (raw["candidate"], raw["profile"], raw["precision"]) != (candidate, profile, precision):
            raise SystemExit(f"unexpected FG row {raw['candidate']} {raw['profile']} {raw['precision']}")
        row = typed_fg_row(raw)
        if row["cut"] != (row["sequence"] == "cut" and row["first"] < cut_frame <= row["last"]):
            raise SystemExit(f"{row['sequence']} f={row['first']}: cut flag does not match frame {cut_frame}")
        if row["sequence"] != current:
            if current is not None:
                if len(bucket) != len(grid):
                    raise SystemExit(f"{current}: {len(bucket)} rows, expected {len(grid)}; refusing a partial sequence")
                if [(r["regime"], r["k"], r["first"], r["last"], r["truth"]) for r in bucket] != grid:
                    raise SystemExit(f"{current}: pair grid differs")
                if current in order:
                    raise SystemExit(f"duplicate sequence {current}")
                bucket = _finish_group(order, typed, current, bucket)
            current = row["sequence"]
        bucket.append(row)
    if current is not None:
        if current in order:
            raise SystemExit(f"duplicate sequence {current}")
        if len(bucket) != len(grid):
            raise SystemExit(f"{current}: {len(bucket)} rows, expected {len(grid)}; refusing a partial sequence")
        if [(r["regime"], r["k"], r["first"], r["last"], r["truth"]) for r in bucket] != grid:
            raise SystemExit(f"{current}: pair grid differs")
        _finish_group(order, typed, current, bucket)
    return order, typed


def validate_sr_lines(lines: list[str], candidate: str, profile: str, precision: str, cut_frame: int):
    expected = list(range(0, 61, SR_STEP))
    order, typed, current, bucket = [], [], None, []

    def finish():
        nonlocal bucket
        frames = [row["frame"] for row in bucket]
        if frames != expected:
            raise SystemExit(f"{current}: frame list is not the even frames 0..60")
        if "flickerFrom" in bucket[0]:
            raise SystemExit(f"{current}: first frame records flicker")
        for previous, row in zip(bucket, bucket[1:]):
            if row.get("flickerFrom") != previous["frame"]:
                raise SystemExit(f"{current}: flicker does not link consecutive 60 fps frames")
            if row["flickerCut"] != (current == "cut" and previous["frame"] < cut_frame <= row["frame"]):
                raise SystemExit(f"{current}: flicker cut flag differs")
        bucket = _finish_group(order, typed, current, bucket)

    for line in lines:
        raw = parse_line(SR_COLUMNS, line)
        if (raw["candidate"], raw["profile"], raw["precision"]) != (candidate, profile, precision):
            raise SystemExit("unexpected SR row")
        row = typed_sr_row(raw)
        if row["sequence"] != current:
            if current is not None:
                if current in order:
                    raise SystemExit(f"duplicate sequence {current}")
                finish()
            current = row["sequence"]
        bucket.append(row)
    if current is not None:
        if current in order:
            raise SystemExit(f"duplicate sequence {current}")
        finish()
    return order, typed


def assert_medians(rows, stored, label, methods, count_key):
    if len(rows) != stored[count_key]:
        raise SystemExit(f"{label}: {len(rows)} rows != stored {stored[count_key]}")
    for metric in ("psnr", "ssim"):
        for method in methods:
            field = f"{metric}_{method}"
            close_to(statistics.median(row[field] for row in rows), stored["medians"][field], 1.1e-6, f"{label}/{field}")


def assert_fg_summary(typed, summary, label):
    for regime, part in summary.items():
        if not isinstance(part, dict) or "sequences" not in part:
            continue
        selected = [row for row in typed if row["regime"] == regime and not row["cut"]]
        for sequence, stored in part["sequences"].items():
            assert_medians([row for row in selected if row["sequence"] == sequence], stored, f"{label}/{regime}/{sequence}", FG_METHODS, "pairs")
        assert_medians(selected, part["pooled"], f"{label}/{regime}/pooled", FG_METHODS, "pairs")


def assert_flicker(rows, stored, label):
    transitions = [row for row in rows if "flickerFrom" in row and not row["flickerCut"]]
    if len(transitions) != stored["transitions"]:
        raise SystemExit(f"{label}: {len(transitions)} transitions != {stored['transitions']}")
    means = {method: statistics.mean(row[f"flicker_{method}"] for row in transitions) for method in SR_METHODS}
    for method, value in means.items():
        close_to(value, stored["flicker"][method], 1.1e-8, f"{label}/flicker/{method}")
    if means["bicubic"]:
        close_to(means["model"] / means["bicubic"], stored["flickerRatioToBicubic"], 1.1e-6, f"{label}/flicker-ratio")


def assert_sr_summary(typed, summary, label):
    for sequence, stored in summary["sequences"].items():
        rows = [row for row in typed if row["sequence"] == sequence]
        assert_medians(rows, stored, f"{label}/{sequence}", SR_METHODS, "frames")
        assert_flicker(rows, stored, f"{label}/{sequence}")
    assert_medians(typed, summary["pooled"], f"{label}/pooled", SR_METHODS, "frames")
    assert_flicker(typed, summary["pooled"], f"{label}/pooled")


def group_lines(lines: list[str], columns: list[str]):
    groups, order = {}, []
    for line in lines:
        raw = parse_line(columns, line)
        key = (raw["candidate"], raw["profile"], raw["precision"])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(line)
    return order, groups


def command_value(command: str, flag: str, default: str) -> str:
    for part in command.split():
        if part == flag:
            return "true"
        if part.startswith(flag + "="):
            return part.split("=", 1)[1]
    return default


def resume_directory(text: str) -> Path:
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    path = Path(os.path.abspath(path))
    parent = common.BUILD.joinpath(*common.AREA, "quality")
    if path.resolve() != path or not common._inside(path, parent) or path == parent:
        raise SystemExit(f"--resume must be a real quality run directory inside {parent}")
    if not (path / "results" / "quality.json").is_file():
        raise SystemExit(f"{path}: missing results/quality.json")
    return path


def cut_frame_of(results: dict) -> int:
    cuts = [seq.get("cuts") for seq in results["replay"]["sequences"] if seq.get("sequence") == "cut"]
    if cuts != [[30]]:
        raise SystemExit(f"cut frames {cuts} differ from the registered cut at frame 30")
    return 30


def memory_pressure() -> int:
    out = subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        raise SystemExit(f"cannot read memory pressure: {out.stderr.strip()}")
    return int(out.stdout.strip())


def read_thermal(work: Path) -> dict:
    binary = work / "bin" / "thermal"
    if not binary.is_file():
        return {"unavailable": "thermal helper missing"}
    out = subprocess.run([str(binary)], capture_output=True, text=True, timeout=15)
    if out.returncode != 0 or not out.stdout.strip():
        return {"unavailable": (out.stderr or out.stdout).strip()}
    return json.loads(out.stdout)


def assert_original_stop(run: Path, progress: dict | None, partial_path: Path | None):
    """The first resume must still be the stopped bytes. Later resumes may have grown a checkpoint."""
    if (run / "preserved-before-resume").exists():
        return
    stopped_path = run / "results" / "stopped.json"
    if not stopped_path.is_file():
        raise SystemExit("first resume requires results/stopped.json")
    stopped = json.loads(stopped_path.read_text(encoding="utf-8"))
    if common.sha256_file(run / "results" / "quality.json") != stopped["officialQuality"]["sha256"]:
        raise SystemExit("quality.json hash differs from stopped.json")
    checkpoint = stopped.get("lastCheckpoint") or {}
    if not progress or not partial_path:
        return
    same = (progress.get("candidate"), progress.get("profile"), progress.get("precision")) == (
        checkpoint.get("candidate"), checkpoint.get("profile"), checkpoint.get("precision"))
    if not same or progress.get("completedSequences") != checkpoint.get("completedSequences") or progress.get("rows") != checkpoint.get("rows"):
        return
    kind = "partialFgCsv" if progress["candidate"] == RIFE else "partialSrCsv"
    recorded = stopped.get(kind)
    if not recorded or common.sha256_file(partial_path) != recorded["sha256"]:
        raise SystemExit(f"{partial_path.name} hash differs from stopped.json")
    if common.sha256_file(run / "results" / "quality-progress.json") != stopped["checkpointReceipt"]["sha256"]:
        raise SystemExit("quality-progress.json hash differs from stopped.json")


def inspect_resume(args, work: Path) -> dict:
    """Validate an incomplete final run. Does not write."""
    if args.trials:
        raise SystemExit("--resume cannot be combined with --trial-model")
    run = resume_directory(args.resume)
    results = json.loads((run / "results" / "quality.json").read_text(encoding="utf-8"))
    if results.get("mode") != "final" or results.get("completedAt"):
        raise SystemExit("resume only continues an incomplete final screen")
    if not results.get("screenCoverage", {}).get("complete"):
        raise SystemExit("refusing a run that was not started as the full six-sequence suite")
    command = results["command"]
    checks = (("--candidates", ",".join(CANDIDATES), args.candidates), ("--profiles", ",".join(PROFILES), args.profiles),
              ("--precisions", "fp32,fp16", args.precisions))
    for flag, default, actual in checks:
        if command_value(command, flag, default) != ",".join(actual):
            raise SystemExit(f"{flag} must match the interrupted command")
    if args.sequences != "all" or command_value(command, "--sequences", "all") != "all":
        raise SystemExit("final resume uses every sequence")
    if args.threads != int(command_value(command, "--threads", "4")) or args.threads != results["runtime"]["intraOpThreads"]:
        raise SystemExit("--threads must match the interrupted run")
    if args.no_sr_diagnostic != ("--no-sr-diagnostic" in command.split()):
        raise SystemExit("--no-sr-diagnostic must match the interrupted run")
    if args.no_sheets != ("--no-sheets" in command.split()):
        raise SystemExit("--no-sheets must match the interrupted run")
    cut = cut_frame_of(results)
    names = results["screenCoverage"]["sequences"]
    fg_lines = load_table(run / "results" / "quality-fg.csv", FG_COLUMNS)
    sr_lines = load_table(run / "results" / "quality-sr.csv", SR_COLUMNS)
    fg_order, fg_groups = group_lines(fg_lines, FG_COLUMNS)
    sr_order, sr_groups = group_lines(sr_lines, SR_COLUMNS)
    fg_done = [(m["candidate"], m["profile"], m["precision"]) for m in results["models"] if m.get("status") == "run" and m["candidate"] == RIFE]
    sr_done = [(m["candidate"], m["profile"], m["precision"]) for m in results["models"] if m.get("status") == "run" and m["candidate"] == RT4KSR]
    adopted = {}

    def adopt(order, done, groups, kind):
        extra = [key for key in order if key not in done]
        missing = [key for key in done if key not in order]
        if missing or len(extra) > 1:
            raise SystemExit(f"official {kind} CSV models {order} differ from quality.json {done}; restore preserved-consistent, not an older partial CSV")
        if not extra:
            return
        key = extra[0]
        sequences, typed = (validate_fg_lines if kind == "fg" else validate_sr_lines)(groups[key], *key, cut)
        if sequences != names:
            raise SystemExit(f"{key} is in the official CSV without a finished six-sequence result")
        adopted[key] = {"kind": kind, "typed": typed, "sha256": None, "output_non_finite": None}

    adopt(fg_order, fg_done, fg_groups, "fg")
    adopt(sr_order, sr_done, sr_groups, "sr")
    for key in fg_done:
        order, typed = validate_fg_lines(fg_groups[key], *key, cut)
        if order != names:
            raise SystemExit(f"{key}: official sequences {order} differ from the run {names}")
        assert_fg_summary(typed, results["fg"][key[0]][key[1]][key[2]], "/".join(key))
    for key in sr_done:
        order, typed = validate_sr_lines(sr_groups[key], *key, cut)
        if order != names:
            raise SystemExit(f"{key}: official sequences {order} differ from the run")
        assert_sr_summary(typed, results["sr"][key[0]][key[1]][key[2]], "/".join(key))
    for model in results["models"]:
        if model.get("status") != "run":
            continue
        graph = work / "models" / model["candidate"] / model["profile"] / f"{model['precision']}.onnx"
        if common.sha256_file(graph) != model["sha256"]:
            raise SystemExit(f"{graph} hash changed since its official quality result")
    progress_path = run / "results" / "quality-progress.json"
    partial = None
    if progress_path.is_file():
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        key = (progress.get("candidate"), progress.get("profile"), progress.get("precision"))
        if key in adopted:
            graph = work / "models" / key[0] / key[1] / f"{key[2]}.onnx"
            if common.sha256_file(graph) != progress.get("sha256"):
                raise SystemExit("adopted CSV model does not match the checkpoint graph")
            sequences = []
            for row in adopted[key]["typed"]:
                if row["sequence"] not in sequences:
                    sequences.append(row["sequence"])
            outputs = progress.get("nonFiniteOutputValues", 0) - progress.get("zeroProbeNonFiniteOutputValues", 0)
            if outputs < 0 or set(progress.get("completedSequences") or []) != set(sequences) or progress.get("rows") != len(adopted[key]["typed"]):
                raise SystemExit("official CSV is ahead of quality.json but the checkpoint does not cover those rows")
            adopted[key]["sha256"] = progress["sha256"]
            adopted[key]["output_non_finite"] = outputs
            partial = {"stale": True, "key": key}
            assert_original_stop(run, progress, run / "results" / ("quality-fg.partial.csv" if key[0] == RIFE else "quality-sr.partial.csv"))
        elif progress.get("complete") is True or key in set(fg_done + sr_done):
            partial = {"stale": True, "key": key}
            assert_original_stop(run, None, None)
        else:
            kind = "fg" if key[0] == RIFE else "sr"
            partial_path = run / "results" / f"quality-{kind}.partial.csv"
            columns = FG_COLUMNS if kind == "fg" else SR_COLUMNS
            lines = load_table(partial_path, columns)
            order, typed = (validate_fg_lines if kind == "fg" else validate_sr_lines)(lines, *key, cut)
            if set(order) != set(progress.get("completedSequences") or []) or progress.get("rows") != len(lines) or progress.get("lastCompletedSequence") != (order[-1] if order else None):
                raise SystemExit("quality-progress.json does not match the partial CSV")
            if any(name not in names for name in order):
                raise SystemExit(f"partial sequences {order} are outside the run")
            graph = work / "models" / key[0] / key[1] / f"{key[2]}.onnx"
            if common.sha256_file(graph) != progress.get("sha256"):
                raise SystemExit("partial checkpoint graph hash differs from the onnx file")
            outputs = progress.get("nonFiniteOutputValues", 0) - progress.get("zeroProbeNonFiniteOutputValues", 0)
            if outputs < 0:
                raise SystemExit("checkpoint non-finite counts are inconsistent")
            assert_original_stop(run, progress, partial_path)
            partial = {"stale": False, "key": key, "kind": kind, "sequences": order, "typed": typed, "lines": lines,
                       "output_non_finite": outputs, "sha256": progress["sha256"]}
    else:
        assert_original_stop(run, None, None)
    if any(item["sha256"] is None for item in adopted.values()):
        raise SystemExit("official CSV has a model that quality.json lacks, without a matching non-finite checkpoint")
    return {"run": run, "results": results, "fg_lines": fg_lines, "sr_lines": sr_lines,
            "completed": set(fg_done + sr_done), "adopted": adopted, "partial": partial, "names": names}


def begin_resume(info: dict, work: Path) -> dict:
    pressure = memory_pressure()
    if pressure != 1:
        raise SystemExit(f"memory pressure is {pressure}; refusing the multi-GB quality resume")
    run = info["run"]
    snapshot = run / "preserved-before-resume"
    if not snapshot.exists():
        snapshot.mkdir()
        for name in ("quality.json", "quality-fg.csv", "quality-sr.csv", "quality-fg.partial.csv",
                     "quality-progress.json", "stopped.json", "power-changes.json"):
            source = run / "results" / name
            if source.is_file():
                (snapshot / name).write_bytes(source.read_bytes())
        common.write_json(snapshot / "manifest.json", {"createdAt": common.now_iso(),
                          "files": {path.name: common.sha256_file(path) for path in sorted(snapshot.iterdir()) if path.name != "manifest.json"}})
    partial = info["partial"] if info["partial"] and not info["partial"].get("stale") else None
    record = {"resumedAt": common.now_iso(), "script": common.script_receipt(Path(__file__).resolve()),
              "common": common.script_receipt(common.EXPORT / "common.py"), "replay": common.script_receipt(common.EXPORT / "replay.py"),
              "memoryPressure": pressure, "thermal": read_thermal(work),
              "reusedModels": [list(key) for key in sorted(info["completed"])],
              "reusedSequences": None if partial is None else partial["sequences"],
              "partialModel": None if partial is None else list(partial["key"]),
              "priorMetricExecution": info["results"].get("metricExecution"),
              "rowPolicy": "Official CSV lines and complete checkpoint sequences are preserved byte-for-byte. New rows use the same formatter. A short sequence is refused. Metric functions, inputs and gates are unchanged.",
              "note": "Power settings were not changed. CPU wall time that crosses the earlier Low Power Mode change stays unqualified."}
    info["results"].setdefault("resumes", []).append(record)
    common.write_json(run / "results" / "resume-started.json", record)
    return record


def save_consistent(run: Path):
    dest = run / "preserved-consistent"
    dest.mkdir(exist_ok=True)
    for name in ("quality.json", "quality-fg.csv", "quality-sr.csv", "quality-progress.json"):
        source = run / "results" / name
        if source.is_file():
            (dest / name).write_bytes(source.read_bytes())


def resume_checkpoint(run: Path, kind: str, columns: list[str], model: Model, raw_lines: list[str], prefix_count: int, cut_frame: int = 30):
    """Rewrite the partial CSV from preserved lines plus newly completed sequences."""

    def checkpoint(rows, sequence_name):
        if len(rows) < prefix_count:
            raise SystemExit("checkpoint lost reused rows")
        stamped = [{"candidate": model.candidate, "profile": model.profile, "precision": model.precision, **row} for row in rows[prefix_count:]]
        body = list(raw_lines) + [format_csv_line(columns, row) for row in stamped]
        if kind == "fg":
            order, _ = validate_fg_lines(body, model.candidate, model.profile, model.precision, cut_frame)
        else:
            order, _ = validate_sr_lines(body, model.candidate, model.profile, model.precision, cut_frame)
        if not order or order[-1] != sequence_name:
            raise SystemExit(f"checkpoint for {sequence_name} did not end on a complete sequence")
        common.write_bytes(run / "results" / f"quality-{kind}.partial.csv",
                           (",".join(columns) + "\n" + "".join(f"{line}\n" for line in body)).encode())
        common.write_json(run / "results" / "quality-progress.json", {
            "schema": 1, "complete": False, **model.describe(), "lastCompletedSequence": sequence_name,
            "completedSequences": order, "rows": len(body), "updatedAt": common.now_iso(),
            "reusedCheckpointRows": prefix_count, "note": "Partial rows only; no completed model H verdict."})

    return checkpoint


# ─── Main ───────────────────────────────────────────────────────────────

def plan_models(args, work: Path):
    """[(candidate, profile, precision, path, receipt path or None, skip reason or None)]."""
    plan = []
    if args.trials:
        for (candidate, profile), path in args.trials.items():
            plan.append((candidate, profile, "fp32", path, None, None if path.exists() else f"missing {path}"))
        return plan
    # Precision outermost: every fp32 (gate) result is written before the supplementary fp16 runs.
    for precision in sorted(args.precisions, key=common.PRECISIONS.index):
        for candidate in args.candidates:
            for profile in args.profiles:
                if profile not in common.PROFILES[candidate]:
                    continue
                folder = work / "models" / candidate / profile
                path, receipt = folder / f"{precision}.onnx", folder / f"{precision}.receipt.json"
                reason = None
                if not path.exists() or not receipt.exists():
                    reason = f"missing {common.repo_relative(path)} or its receipt"
                else:
                    gate_a = json.loads(receipt.read_text(encoding="utf-8")).get("gateA")
                    if isinstance(gate_a, dict) and gate_a.get("status") == "not-runnable":
                        reason = f"receipt says not runnable on ORT CPU: {gate_a.get('reason')}"
                plan.append((candidate, profile, precision, path, receipt, reason))
    return plan


def main(argv=None):
    args = parse_arguments(argv)
    work = common.work_dir(args.work)
    common.apply_scratch_env(work)
    common.limit_threads(args.threads)
    resume = inspect_resume(args, work) if args.resume else None
    if resume:
        begin_resume(resume, work)
    import gc

    import onnxruntime
    import skimage
    import torch

    development = bool(args.trials)
    label = "DEVELOPMENT-ONLY (trial graph, no receipt)" if development else "screen"
    if resume:
        run = resume["run"]
        results = resume["results"]
        names = list(resume["names"])
    else:
        run = common.new_output_directory("quality-dev" if development else "quality")
        names = None
        results = None
    log = Log(run / "logs" / "quality.log")
    command = common.python_command(Path(__file__).resolve(), *(argv if argv is not None else sys.argv[1:]))
    log(f"quality run {common.repo_relative(run)} ({'resume' if resume else 'development' if development else 'final'})")
    replay = work / "replay"
    discovered = sorted(p.name for p in replay.iterdir() if (p / "sequence.json").exists()) if replay.exists() else []
    import replay as replay_protocol

    if resume:
        if any(name not in discovered for name in names) or set(names) != set(replay_protocol.SEQUENCES):
            raise SystemExit(f"resume sequences {names} are not the six replay sequences on disk")
    else:
        names = discovered
        if not development and args.sequences == "all" and set(names) != set(replay_protocol.SEQUENCES):
            raise SystemExit(f"final screen requires all six replay sequences, got {names} (run replay.py)")
        if args.sequences != "all":
            wanted = [s for s in args.sequences.split(",") if s]
            missing = [s for s in wanted if s not in names]
            if missing:
                raise SystemExit(f"replay sequences not found in {replay}: {missing} (run replay.py)")
            names = wanted
    if not names:
        raise SystemExit(f"no replay sequences in {replay} (run replay.py)")
    sequences = {name: Sequence(replay / name) for name in names}
    complete_suite = set(names) == set(replay_protocol.SEQUENCES)
    if results is None:
        results = {
        "schema": 1,
        "mode": "development" if development else "final",
        "screenCoverage": {"complete": complete_suite, "sequences": names,
                           "expectedSequences": list(replay_protocol.SEQUENCES)},
        "note": ("Development-only: trial graphs without export receipts; not gate H evidence." if development
                 else "Automated screen; contact sheets need human review before any admission beyond Stage 2."),
        "createdAt": common.now_iso(),
        "command": command,
        "scripts": [common.script_receipt(Path(__file__).resolve()), common.script_receipt(common.EXPORT / "common.py"),
                    common.script_receipt(common.EXPORT / "replay.py")],
        "environment": common.environment(),
        "runtime": {"onnxruntime": onnxruntime.__version__, "provider": "CPUExecutionProvider", "intraOpThreads": args.threads,
                    "graphOptimizationLevel": "ORT_ENABLE_ALL (default)", "torch": torch.__version__, "torchThreads": torch.get_num_threads()},
        "replay": {"root": common.repo_relative(replay), "sequences": [s.receipt() for s in sequences.values()]},
        "definitions": {
            "quantization": "round(clip(x, 0, 1) * 255) per channel (np.rint, half to even), RGB",
            "metrics": f"skimage {skimage.__version__} peak_signal_noise_ratio and structural_similarity(data_range=1, channel_axis=2, "
                       "7x7 uniform window) on u8/255 float64",
            "fgPairs": "k=4 (30->60): endpoints f, f+4, truth f+2; k=2 (60->120): endpoints f, f+2, truth f+1; every f with f+k <= 60; native-size frames",
            "fgControls": {"repeat": "earlier endpoint", "blend": "round((A + B) / 2), half to even"},
            "fgModelInput": "u8/255 float32 NCHW, zero pad right/bottom to the graph shape (multiple of 128), output cropped top-left",
            "srFrames": "even frames 0..60 (60 fps); model input = half-size frame u8/255; controls torch interpolate bilinear/bicubic align_corners=False antialias=False on the same input",
            "flicker": "mean over consecutive 60 fps pairs (t, t+2), pixels and RGB of |(X[t+1]-X[t]) - (N[t+1]-N[t])| in [0,1] units; cut transitions excluded and listed",
            "cut": "a pair or transition straddles a cut when first < cut frame <= last",
            "srDiagnostic": "informational, never a verdict input: per sequence medians of the fp32 model and torch bicubic upscaling of "
                            "the native frame downsampled by PIL Image.reduce(2) ('area', 2x2 box) and by PIL resize BICUBIC ('bicubic-aa', "
                            "antialiased, a = -0.5), against the native frame; separates the model's response to the low-resolution "
                            "degradation from the rendered half-size input rule H uses",
            "verdict": "rule H: model median > each control median, strictly, for PSNR and SSIM; SR flicker <= 1.10 x bicubic. "
                       "FG regime passes when every sequence passes (rule H says per sequence; pooled medians are information only). "
                       "SR (the rule names no unit) passes when every sequence passes and the pooled medians pass; both readings are recorded. "
                       "Verdicts from fp32 graphs; fp16 supplementary; gateA copied from the export receipt",
        },
        "models": [],
        "fg": {},
        "sr": {},
        "srDiagnostic": {},
        "verdicts": [],
        "sheets": [],
    }
    completed = resume["completed"] if resume else set()
    adopted = resume["adopted"] if resume else {}
    partial = resume["partial"] if resume and resume.get("partial") and not resume["partial"].get("stale") else None
    if resume and resume.get("partial") and resume["partial"].get("stale"):
        log(f"ignore stale checkpoint {resume['partial'].get('key')}")
    if partial:
        log(f"reuse checkpoint {partial['key']} sequences {partial['sequences']}")
    fg_sink = RowSink(FG_COLUMNS, resume["fg_lines"] if resume else None)
    sr_sink = RowSink(SR_COLUMNS, resume["sr_lines"] if resume else None)
    metric_runner = MetricRunner(args.threads)
    plan = plan_models(args, work)
    for candidate, profile, precision, path, receipt, reason in plan:
        key = (candidate, profile, precision)
        entry = {"candidate": candidate, "profile": profile, "precision": precision, "file": common.repo_relative(path)}
        remembered = [m for m in results["models"] if (m["candidate"], m["profile"], m["precision"]) == key]
        if key in completed:
            log(f"reuse official {candidate} {profile} {precision}")
            continue
        if reason:
            if not remembered:
                log(f"skip {candidate} {profile} {precision}: {reason}")
                results["models"].append({**entry, "status": "skipped", "reason": reason})
                common.write_json(run / "results" / "quality.json", results)
            continue
        try:
            model = Model(candidate, profile, precision, path, receipt, args.threads)
        except Exception as error:  # an fp16 graph ORT CPU refuses is recorded, not fatal
            if precision == "fp32":
                raise
            if not remembered:
                log(f"skip {candidate} {profile} {precision}: ORT CPU session failed: {error}")
                results["models"].append({**entry, "status": "skipped", "reason": f"ORT CPU session failed: {error}"})
                common.write_json(run / "results" / "quality.json", results)
            continue
        selected = [s for s in sequences.values() if s.has_size(NATIVE[profile])
                    and (candidate == RIFE or s.has_size(HALF[profile]))]
        if len(selected) != len(sequences):
            raise SystemExit(f"replay frames for {profile} missing in {[s.name for s in sequences.values() if s not in selected]} (run replay.py --profiles={profile})")
        log(f"run {candidate} {profile} {precision} {common.repo_relative(path)} sha256 {model.sha256[:16]} input {model.padded}")
        started = time.perf_counter()
        sheet_folder = run / "sheets" / candidate / f"{profile}-{precision}"
        status = "supplementary" if precision != "fp32" else ("development-only" if development
                 else "gate" if complete_suite else "partial-screen")
        adoption = adopted.get(key)
        use_partial = partial is not None and tuple(partial["key"]) == key
        if adoption:
            if model.sha256 != adoption["sha256"]:
                raise SystemExit("adopted official rows do not match this graph")
            model.non_finite = model.zero_probe_non_finite + adoption["output_non_finite"]
        elif use_partial:
            if model.sha256 != partial["sha256"]:
                raise SystemExit("checkpoint rows do not match this graph")
            model.non_finite = model.zero_probe_non_finite + partial["output_non_finite"]
        kind = "fg" if candidate == RIFE else "sr"
        columns = FG_COLUMNS if candidate == RIFE else SR_COLUMNS

        def checkpoint(rows, sequence_name, kind=kind, columns=columns, use_partial=use_partial):
            # Completed sequences only. A short sequence is not written and is not an H result.
            if use_partial:
                resume_checkpoint(run, kind, columns, model, partial["lines"], len(partial["typed"]))(rows, sequence_name)
                return
            stamped = [{"candidate": candidate, "profile": profile, "precision": precision, **row} for row in rows]
            body = [format_csv_line(columns, row) for row in stamped]
            if kind == "fg":
                order, _ = validate_fg_lines(body, candidate, profile, precision, 30)
            else:
                order, _ = validate_sr_lines(body, candidate, profile, precision, 30)
            if not order or order[-1] != sequence_name:
                raise SystemExit(f"checkpoint for {sequence_name} is not a complete sequence")
            common.write_bytes(run / "results" / f"quality-{kind}.partial.csv",
                               (",".join(columns) + "\n" + "".join(f"{line}\n" for line in body)).encode())
            common.write_json(run / "results" / "quality-progress.json", {
                "schema": 1, "complete": False, **model.describe(), "lastCompletedSequence": sequence_name,
                "completedSequences": order, "rows": len(body), "updatedAt": common.now_iso(),
                "note": "Partial rows only; no completed model H verdict."})

        resume_rows = partial["typed"] if use_partial else None
        resume_skip = partial["sequences"] if use_partial else ()
        if adoption:
            rows = adoption["typed"]
            box = fg_crop_box(model, NATIVE[profile], development) if candidate == RIFE else None
        elif candidate == RIFE:
            rows, box = run_fg(model, list(sequences.values()), profile, development, log, checkpoint, metric_runner, resume_rows, resume_skip)
        else:
            rows = run_sr(model, list(sequences.values()), profile, log, checkpoint, metric_runner, resume_rows, resume_skip)
            box = None
        if set(row["sequence"] for row in rows) != set(names):
            raise SystemExit(f"{candidate} {profile} {precision} does not contain every sequence; H was not written")
        stamped = [{"candidate": candidate, "profile": profile, "precision": precision, **row} for row in rows]
        sink = fg_sink if candidate == RIFE else sr_sink
        if not adoption:
            if use_partial:
                sink.add_raw(partial["lines"])
                sink.add(stamped[len(partial["typed"]):])
            else:
                sink.add(stamped)
        if candidate == RIFE:
            summary = summarize_fg(rows, names)
            if model.non_finite:
                for part in summary.values():
                    part.update({"verdict": "fail", "invalidOutput": f"{model.non_finite} non-finite model output values"})
            if box[2:] != NATIVE[profile]:
                summary["devCrop"] = {"y": box[0], "x": box[1], "height": box[2], "width": box[3]}
            if not args.no_sheets:
                for sheet in fg_sheets(model, sequences, rows, box, profile, sheet_folder, label):
                    if sheet not in results["sheets"]:
                        results["sheets"].append(sheet)
            for regime, part in summary.items():
                if regime == "devCrop":
                    continue
                results["verdicts"].append({"gate": "H", "candidate": candidate, "profile": profile, "precision": precision,
                                            "part": f"FG {regime}", "verdict": part["verdict"], "status": status,
                                            "failingSequences": part["failingSequences"], "gateA": model.gate_a()})
                log(f"  FG {regime}: {part['verdict']} pooled {part['pooled']['medians']} failing {part['failingSequences']}")
            results["fg"].setdefault(candidate, {}).setdefault(profile, {})[precision] = summary
        else:
            summary = summarize_sr(rows, names)
            if model.non_finite:
                summary.update({"verdict": "fail", "invalidOutput": f"{model.non_finite} non-finite model output values"})
            if not args.no_sheets:
                for sheet in sr_sheets(model, sequences, rows, profile, sheet_folder, label):
                    if sheet not in results["sheets"]:
                        results["sheets"].append(sheet)
            results["verdicts"].append({"gate": "H", "candidate": candidate, "profile": profile, "precision": precision,
                                        "part": "SR", "verdict": summary["verdict"], "status": status,
                                        "failingSequences": summary["failingSequences"], "readings": summary["readings"],
                                        "gateA": model.gate_a()})
            log(f"  SR: {summary['verdict']} {summary['readings']} pooled {summary['pooled']['medians']} flicker {summary['pooled']['flicker']} failing {summary['failingSequences']}")
            results["sr"].setdefault(candidate, {}).setdefault(profile, {})[precision] = summary
            if precision == "fp32" and not args.no_sr_diagnostic:
                results["srDiagnostic"].setdefault(candidate, {})[profile] = run_sr_diagnostic(model, list(sequences.values()), profile, log)
        ms = sorted(model.milliseconds)
        results["models"].append({**model.describe(), "status": "run", "seconds": round(time.perf_counter() - started, 1),
                                  "cpuModelMs": {"median": round(ms[len(ms) // 2], 2), "runs": len(ms),
                                                 "note": "ORT CPU wall time, informational only (not a gate G input)"}})
        results["metricExecution"] = metric_runner.describe()
        fg_sink.write(run / "results" / "quality-fg.csv")
        sr_sink.write(run / "results" / "quality-sr.csv")
        common.write_json(run / "results" / "quality.json", results)
        common.write_json(run / "results" / "quality-progress.json", {
            "schema": 1, "complete": True, **model.describe(), "rows": len(rows), "updatedAt": common.now_iso(),
            "note": "This model is committed in quality.json. It is not a partial H result."})
        if resume:
            save_consistent(run)
        del model  # release the session (1080p graphs hold large arenas) before the next one is created
        gc.collect()
    seen = {(m["candidate"], m["profile"], m["precision"]) for m in results["models"]}
    missing = [(c, p, pr) for c, p, pr, _, _, _ in plan if (c, p, pr) not in seen]
    if missing:
        raise SystemExit(f"screen incomplete {missing}; completedAt was not written")
    fg_sink.write(run / "results" / "quality-fg.csv")
    sr_sink.write(run / "results" / "quality-sr.csv")
    results["completedAt"] = common.now_iso()
    metric_runner.close()
    common.write_json(run / "results" / "quality.json", results)
    log(f"wrote {common.repo_relative(run / 'results')}")
    for verdict in results["verdicts"]:
        log(f"gate H {verdict['candidate']} {verdict['profile']} {verdict['precision']} {verdict['part']}: {verdict['verdict']} ({verdict['status']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
