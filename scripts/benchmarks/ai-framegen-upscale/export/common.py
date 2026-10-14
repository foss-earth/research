"""Shared helpers for the ai-framegen-upscale Python scripts (export, references, manifests, replay).

Paths, the scratch environment, hashing, stamped output folders, JSON output, the environment
record, the pinned sources (sources.json), corpus panoramas and the model-input tensor rule.
Importing this module has no side effects; numpy, PIL and torch are imported only by the
functions that need them.

Scripts import it by putting this folder first on sys.path and run with
  <work>/venv/bin/python -I -B -X pycache_prefix=<work>/cache/pycache <script> ...
(-I: no user site, no PYTHON* variables, no script folder on sys.path; -B: no .pyc next to
upstream sources).
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

EXPORT = Path(__file__).resolve().parent
RESEARCH = EXPORT.parents[3]
BUILD = RESEARCH / "build"
AREA = ("benchmarks", "ai-framegen-upscale")
SOURCES_JSON = EXPORT / "sources.json"
LOCK = EXPORT / "requirements.lock"
WORK_ENV = "FOSS_EARTH_AI_FRAMEGEN_WORK"
CORPUS_ENV = "FOSS_EARTH_RESEARCH_CORPUS"
DEFAULT_CORPUS = BUILD / "datasets" / "panoramas-requires-explicit-rights-receipt"

# Fixed export shapes (DESIGN.md section 5). valid = model input (and output for RIFE) size before
# padding; padded = the tensor the graph takes; output = the cropped output the harness presents.
PROFILES = {
    "rife-4.25-lite": {
        "small": {"valid": (256, 256), "padded": (256, 256), "output": (256, 256)},
        "540p": {"valid": (540, 960), "padded": (640, 1024), "output": (540, 960)},
        "720p": {"valid": (720, 1280), "padded": (768, 1280), "output": (720, 1280)},
        "1080p": {"valid": (1080, 1920), "padded": (1152, 1920), "output": (1080, 1920)},
    },
    "rt4ksr-x2": {
        "small": {"valid": (128, 128), "padded": (128, 128), "output": (256, 256)},
        "720p": {"valid": (360, 640), "padded": (360, 640), "output": (720, 1280)},
        "1080p": {"valid": (540, 960), "padded": (540, 960), "output": (1080, 1920)},
    },
}
# Export and reference order: small for both candidates first, then 720p, 1080p, then RIFE 540p.
ORDER = [("rife-4.25-lite", "small"), ("rt4ksr-x2", "small"), ("rife-4.25-lite", "720p"),
         ("rt4ksr-x2", "720p"), ("rife-4.25-lite", "1080p"), ("rt4ksr-x2", "1080p"),
         ("rife-4.25-lite", "540p")]
PRECISIONS = ("fp32", "fp16")


def _inside(path: Path, parent: Path) -> bool:
    return path == parent or str(path).startswith(str(parent) + os.sep)


def ensure_build_directory(path) -> Path:
    """Create `path` (inside research/build/) one component at a time, refusing symlinks.

    Recursive mkdir would follow a pre-existing symlinked component before it could be rejected
    (same rule as scripts/lib/outputDirectory.mjs).
    """
    build = BUILD.resolve()
    path = Path(os.path.abspath(path))
    if not _inside(path, build) or path == build:
        raise SystemExit(f"output must stay inside {build}: {path}")
    current = build
    for part in path.relative_to(build).parts:
        current = current / part
        if current.is_symlink():
            raise SystemExit(f"refusing a symlinked directory: {current}")
        if current.exists():
            if not current.is_dir():
                raise SystemExit(f"not a directory: {current}")
        else:
            current.mkdir()
        if current.resolve() != current:
            raise SystemExit(f"refusing a redirected directory: {current}")
    return path


def work_dir(override: str | None = None) -> Path:
    """--work, else $FOSS_EARTH_AI_FRAMEGEN_WORK, else build/benchmarks/ai-framegen-upscale/work."""
    chosen = override or os.environ.get(WORK_ENV) or str(BUILD.joinpath(*AREA, "work"))
    return ensure_build_directory(Path(chosen).expanduser())


def scratch_env(work: Path) -> dict[str, str]:
    """Only the overrides (TMPDIR and tool caches under <work>/cache); merge with os.environ.

    Contains no inherited values, so it is safe to record in results.
    """
    cache = Path(work) / "cache"
    return {
        "TMPDIR": str(cache / "tmp"),
        "XDG_CACHE_HOME": str(cache / "xdg"),
        "TORCH_HOME": str(cache / "torch"),
        "HF_HOME": str(cache / "hf"),
        "MPLCONFIGDIR": str(cache / "mpl"),
        "npm_config_cache": str(cache / "npm"),
        "UV_CACHE_DIR": str(cache / "uv"),
        "PIP_CACHE_DIR": str(cache / "pip"),
        "CLANG_MODULE_CACHE_PATH": str(cache / "clang-modules"),
        "SWIFT_MODULE_CACHE_PATH": str(cache / "swift-modules"),
        "PYTHONPYCACHEPREFIX": str(cache / "pycache"),
    }


def child_env(work: Path) -> dict[str, str]:
    """os.environ plus scratch_env(work), for subprocess(env=...). Do not record it."""
    return {**os.environ, **scratch_env(work)}


def apply_scratch_env(work: Path) -> None:
    """Create the scratch folders and set them in os.environ (call before importing torch)."""
    for key, value in scratch_env(work).items():
        ensure_build_directory(value)
        os.environ[key] = value
    import tempfile
    tempfile.tempdir = None  # re-read TMPDIR on next use


def new_output_directory(kind: str) -> Path:
    """build/benchmarks/ai-framegen-upscale/<kind>/<YYYY-MM-DD_HHMMSS>[-N]/ (local time), new each run."""
    if not kind or os.path.isabs(kind) or ".." in Path(kind).parts:
        raise SystemExit(f"bad output kind: {kind!r}")
    parent = ensure_build_directory(BUILD.joinpath(*AREA, kind))
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    attempt = 1
    while True:
        directory = parent / (stamp if attempt == 1 else f"{stamp}-{attempt}")
        try:
            directory.mkdir()
        except FileExistsError:
            attempt += 1
            continue
        if directory.resolve() != directory:
            raise SystemExit(f"refusing a redirected directory: {directory}")
        return directory


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path, obj) -> None:
    """Indent 2, UTF-8, trailing newline, parents created; written to a sibling then renamed."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def write_bytes(path, data: bytes) -> None:
    """Binary twin of write_json (sibling then rename)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def repo_relative(path) -> str:
    """Path relative to research/ when inside it, else the absolute path."""
    path = Path(os.path.abspath(path))
    return str(path.relative_to(RESEARCH)) if _inside(path, RESEARCH) else str(path)


def script_receipt(path) -> dict:
    return {"path": repo_relative(path), "sha256": sha256_file(path)}


def lock_pins(lock: Path = LOCK) -> dict[str, str]:
    """name -> version from a uv-compiled requirements.lock ("name==version \\" lines)."""
    pins = {}
    if not Path(lock).exists():
        return pins
    for line in Path(lock).read_text(encoding="utf-8").splitlines():
        line = line.strip().rstrip("\\").strip()
        if line and not line.startswith(("#", "--")) and "==" in line:
            name, version = line.split("==", 1)
            pins[name.strip().lower()] = version.split(";")[0].strip()
    return pins


def _run(args: list[str]) -> str | None:
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def environment() -> dict:
    """Python, platform, installed versions of every locked package, lock hash, research commit."""
    from importlib import metadata

    pins = lock_pins()
    packages, mismatches = {}, {}
    for name in sorted(pins or ["torch", "torchvision", "numpy", "onnx", "onnxruntime", "onnxscript",
                                "onnxconverter-common", "pillow", "scikit-image"]):
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
        if pins and packages[name] != pins[name]:
            mismatches[name] = {"locked": pins[name], "installed": packages[name]}
    status = _run(["git", "-C", str(RESEARCH), "status", "--porcelain"])
    return {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "executable": repo_relative(sys.executable),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu": _run(["sysctl", "-n", "machdep.cpu.brand_string"]),
        "memoryBytes": int(_run(["sysctl", "-n", "hw.memsize"]) or 0) or None,
        "packages": packages,
        "lock": {"path": repo_relative(LOCK), "sha256": sha256_file(LOCK) if LOCK.exists() else None,
                 "matchesInstalled": bool(pins) and not mismatches, "mismatches": mismatches},
        "research": {"commit": _run(["git", "-C", str(RESEARCH), "rev-parse", "HEAD"]),
                     "dirty": None if status is None else bool(status),
                     "dirtyEntries": None if status is None else len(status.splitlines())},
    }


def load_sources() -> dict:
    """Parsed export/sources.json (pins, hashes, origins, terms, corpus)."""
    return json.loads(SOURCES_JSON.read_text(encoding="utf-8"))


def limit_threads(n: int = 4) -> None:
    """Cap OpenMP/BLAS threads (before numpy/torch spin up pools) and torch's intra/inter-op threads."""
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ[key] = str(n)
    if "torch" in sys.modules or _importable("torch"):
        import torch
        torch.set_num_threads(n)
        try:
            torch.set_num_interop_threads(min(n, 2))
        except RuntimeError:
            pass  # already set once in this process


def _importable(name: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(name) is not None


# ─── Corpus ─────────────────────────────────────────────────────────────

def corpus_root(override: str | None = None) -> Path:
    """--corpus-root, else $FOSS_EARTH_RESEARCH_CORPUS, else the spherical benchmark's default."""
    return Path(override or os.environ.get(CORPUS_ENV) or DEFAULT_CORPUS)


def corpus_entry(panorama_id: str) -> tuple[str, dict]:
    """(name, entry) for a corpus name ("northrop-mall") or YouVisit panorama id ("363729")."""
    corpus = load_sources()["corpus"]
    for name, entry in corpus.items():
        if panorama_id in (name, entry["panorama"]):
            return name, entry
    raise SystemExit(f"unknown corpus panorama: {panorama_id}")


def corpus_image(corpus_root, panorama_id):
    """Verified (sha256 from sources.json) 6144x3072 RGB uint8 array, decoded with PIL.

    The bytes are hashed and decoded from the same read, so a file swapped mid-way cannot pass.
    """
    import numpy as np
    from PIL import Image

    name, entry = corpus_entry(panorama_id)
    path = Path(corpus_root) / entry["panorama"] / entry.get("file", "6144.jpg")
    if not path.exists():
        raise SystemExit(f"corpus panorama {name} not found at {path} (pass --corpus-root=<folder holding <panorama>/6144.jpg>)")
    data = path.read_bytes()
    got = sha256_bytes(data)
    if got != entry["sha256"]:
        raise SystemExit(f"corpus panorama {name}: sha256 {got} != pinned {entry['sha256']} ({path})")
    with Image.open(io.BytesIO(data)) as image:
        rgb = np.asarray(image.convert("RGB"))
    if rgb.shape != (entry.get("height", 3072), entry.get("width", 6144), 3) or rgb.dtype != np.uint8:
        raise SystemExit(f"corpus panorama {name}: unexpected decoded shape {rgb.shape} {rgb.dtype}")
    return rgb


# ─── Tensors ────────────────────────────────────────────────────────────

def to_rgba8(rgb) -> bytes:
    """HxWx3 uint8 -> row-major RGBA bytes, alpha 255."""
    import numpy as np

    rgb = np.asarray(rgb)
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError(f"expected HxWx3 uint8, got {rgb.shape} {rgb.dtype}")
    out = np.full((rgb.shape[0], rgb.shape[1], 4), 255, np.uint8)
    out[..., :3] = rgb
    return out.tobytes()


def to_model_input(rgb, padded_hw: tuple[int, int]):
    """HxWx3 uint8 -> float32 NCHW [1,3,PH,PW]: float32(u8) / float32(255), zero pad right/bottom.

    Bitwise equal to the page's Math.fround(v / 255) for every byte value, and to the official
    RIFE/RT4KSR loaders (uint8 tensor .float() / 255).
    """
    import numpy as np

    rgb = np.asarray(rgb)
    height, width = rgb.shape[:2]
    padded_h, padded_w = padded_hw
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3 or height > padded_h or width > padded_w:
        raise ValueError(f"cannot pad {rgb.shape} {rgb.dtype} to {padded_hw}")
    out = np.zeros((1, 3, padded_h, padded_w), np.float32)
    out[0, :, :height, :width] = np.transpose(rgb, (2, 0, 1)).astype(np.float32) / np.float32(255)
    return out


def sha256_array(array) -> str:
    """sha256 of an array's C-order little-endian bytes (float32 inputs, references)."""
    import numpy as np

    array = np.ascontiguousarray(array)
    if array.dtype.byteorder == ">":
        array = array.byteswap().view(array.dtype.newbyteorder("<"))
    return sha256_bytes(array.tobytes())


def now_iso() -> str:
    """Local time with offset, seconds precision (createdAt fields)."""
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def python_command(script: Path, *args: str) -> str:
    """The command line recorded in receipts (venv python, -I -B, repo-relative script)."""
    return " ".join(["<work>/venv/bin/python", "-I", "-B", "-X", "pycache_prefix=<work>/cache/pycache",
                     repo_relative(script), *args])
