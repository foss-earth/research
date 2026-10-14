"""Model builders for the two candidates, from the verified upstream copies in <work>/sources.

  rife-4.25-lite  Practical-RIFE 4.25.lite. The official Model (train_log/RIFE_HDv3.py) is the
                  PyTorch reference (Model.inference(img0, img1, 0.5, 1.0)); RifeMidpoint wraps its
                  IFNet with t = 0.5 and scale 1.0 baked in and is what gets exported. Weights are
                  loaded like load_model(rank=-1) (strip "module.", non-strict) but with
                  torch.load(weights_only=True), and the load is verified tensor by tensor.
  rt4ksr-x2       RT4KSR x2 (arch rt4ksr_rep, 24 channels, 4 blocks, GELU). The training form wrapped
                  in DataParallel with a strict checkpoint load (code/test.py:101-111) is the PyTorch
                  reference; clean_reparameterize() is a side-effect-free CPU port of test.py:32-83
                  (upstream mutates the training weights in place and calls .cuda()), and LivePath
                  is the exported inference form without the dead high-frequency branch, with
                  PlainLayerNorm2d (the formula of modules.py LayerNormFunction.forward as plain ops).

Upstream code is imported only from <work>/sources (fetch.py verifies it). Both repositories use a
top-level package named "model", so each import runs in upstream_imports(), which hides other
"model"/"train_log" modules, appends the verified roots to sys.path (stdlib and site-packages keep
precedence), checks every imported upstream module's file is inside those roots, and restores
sys.path and sys.modules afterwards. Run scripts that import this with python -I -B (no .pyc is
written next to the sources, and the stale __pycache__ shipped in the RIFE archive is never read).

Library module: imported by export.py and references.py (after common.apply_scratch_env(), since it
imports torch); it has no command line.
"""
from __future__ import annotations

import contextlib
import copy
import sys
import types
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

import common

UPSTREAM_PACKAGES = ("model", "train_log")

CANDIDATES = {
    "rife-4.25-lite": {
        "name": "Practical-RIFE 4.25.lite, midpoint (t = 0.5, scale 1.0)",
        "task": "frame-interpolation",
        "inputs": ["img0", "img1"],
        "output": "output",
        "timestep": 0.5,
        "scale": 1.0,
        "outputScale": 1,
        "padMultiple": 128,
        "code": "practical-rife",
        "weights": "rife-4.25-lite",
    },
    "rt4ksr-x2": {
        "name": "RT4KSR x2 (rt4ksr_rep, reparameterized inference form)",
        "task": "super-resolution-x2",
        "inputs": ["input"],
        "output": "output",
        "outputScale": 2,
        "padMultiple": 2,
        "code": "rt4ksr",
        "weights": "rt4ksr-x2",
    },
}


def _upstream_module_names() -> list[str]:
    return [name for name in sys.modules if name.split(".")[0] in UPSTREAM_PACKAGES]


@contextlib.contextmanager
def upstream_imports(*roots: Path):
    """Import upstream packages from `roots` only, without leaking them into later imports."""
    roots = [Path(root).resolve() for root in roots]
    saved_path = list(sys.path)
    saved_modules = {name: sys.modules.pop(name) for name in _upstream_module_names()}
    sys.path.extend(str(root) for root in roots)
    try:
        yield
        for name in _upstream_module_names():
            origin = getattr(sys.modules[name], "__file__", None)
            locations = [origin] if origin else list(getattr(sys.modules[name], "__path__", []))
            for location in locations:
                resolved = Path(location).resolve()
                if not any(resolved == root or root in resolved.parents for root in roots):
                    raise SystemExit(f"upstream module {name} loaded from outside the verified sources: {resolved}")
    finally:
        for name in _upstream_module_names():
            del sys.modules[name]
        sys.modules.update(saved_modules)
        sys.path[:] = saved_path


def _code_root(work: Path, key: str) -> Path:
    spec = common.load_sources()["code"][key]
    root = Path(work) / spec["workPath"]
    for entry in spec["files"]:
        path = _verified(root / entry["path"], entry["sha256"])
        if path.stat().st_size != entry["bytes"]:
            raise SystemExit(f"{path}: size differs from the pinned source")
    return root


def _verified(path: Path, sha256: str) -> Path:
    if path.is_symlink() or not path.is_file() or common.sha256_file(path) != sha256:
        raise SystemExit(f"{path} missing or not the pinned file: run fetch.py first")
    return path


# ─── RIFE ───────────────────────────────────────────────────────────────

def load_rife(work: Path) -> dict:
    """Official Practical-RIFE 4.25.lite Model on CPU with verified weights.

    Returns {"model": Model, "flownet": IFNet, "warplayer": module, "info": {...}}.
    """
    sources = common.load_sources()
    weights = sources["weights"]["rife-4.25-lite"]
    clone = _code_root(work, "practical-rife")
    archive_root = Path(work) / weights["extractTo"]
    pinned = {entry["path"]: entry["sha256"] for entry in weights["extracted"]}
    for relative in ("train_log/IFNet_HDv3.py", "train_log/RIFE_HDv3.py", "train_log/flownet.pkl"):
        _verified(archive_root / relative, pinned[relative])

    torch.set_grad_enabled(False)
    with upstream_imports(clone, archive_root):
        import model.warplayer as warplayer  # noqa: F401  (Practical-RIFE model/warplayer.py)
        from train_log.RIFE_HDv3 import Model  # archive code: imports model.warplayer, model.loss
        official = Model()

    # load_model(path, rank=-1): {k.replace("module.", ""): v for k in state if "module." in k},
    # load_state_dict(..., False). Reproduced with weights_only=True and verified.
    raw = torch.load(archive_root / "train_log/flownet.pkl", map_location="cpu", weights_only=True)
    converted = {key.replace("module.", ""): value for key, value in raw.items() if "module." in key}
    result = official.flownet.load_state_dict(converted, strict=False)
    own = official.flownet.state_dict()
    mismatched = [key for key in own if key in converted and not torch.equal(own[key], converted[key])]
    if result.missing_keys or mismatched:
        raise SystemExit(f"RIFE load incomplete: missing {result.missing_keys[:5]}, mismatched {mismatched[:5]}")
    official.eval()
    official.device()  # Model.device(): flownet.to(cuda if available else cpu)
    device = next(official.flownet.parameters()).device
    if device.type != "cpu":
        raise SystemExit(f"RIFE flownet is on {device}, expected cpu")
    info = {
        "class": "train_log.RIFE_HDv3.Model (flownet: train_log.IFNet_HDv3.IFNet)",
        "version": getattr(official, "version", None),
        "stateDictKeys": len(own),
        "parameters": int(sum(value.numel() for value in own.values())),
        "ignoredCheckpointModules": sorted({key.split(".")[0] for key in result.unexpected_keys}),
        "ignoredCheckpointKeys": len(result.unexpected_keys),
        "load": "torch.load(weights_only=True); 'module.' keys stripped; load_state_dict(strict=False); "
                "no missing keys, every loaded tensor equal",
        "device": str(device),
    }
    return {"model": official, "flownet": official.flownet, "warplayer": warplayer, "info": info}


class RifeMidpoint(nn.Module):
    """forward(img0, img1) -> merged[-1]; identical to Model.inference (RIFE_HDv3.py:56-60).

    img0/img1: N x 3 x H x W float32 in [0, 1], RGB, H and W multiples of 128 at scale 1.0.
    timestep stays a Python float, so IFNet takes its non-tensor path (IFNet_HDv3.py:124-125).
    """

    def __init__(self, flownet, timestep: float = 0.5, scale: float = 1.0):
        super().__init__()
        self.flownet = flownet
        self.timestep = float(timestep)
        self.scale_list = [32 / scale, 16 / scale, 8 / scale, 4 / scale, 1 / scale]

    def forward(self, img0, img1):
        imgs = torch.cat((img0, img1), 1)
        flow, mask, merged = self.flownet(imgs, self.timestep, self.scale_list)
        return merged[-1]


# ─── RT4KSR ─────────────────────────────────────────────────────────────

def rt4ksr_config(is_train: bool) -> types.SimpleNamespace:
    """code/utils/parser.py defaults (x2) plus the README test flags (--is-train, --arch rt4ksr_rep)."""
    return types.SimpleNamespace(
        arch="rt4ksr_rep", feature_channels=24, num_blocks=4, act_type="gelu", is_train=is_train,
        rep=False, save_rep_checkpoint=False, scale=2, rgb_range=1.0, checkpoint_id="rt4ksr_x2")


def load_rt4ksr(work: Path) -> dict:
    """Training form (reference), clean reparameterized inference form, and the exported LivePath.

    Returns {"train": DataParallel(RT4KSR_Rep(is_train=True)), "rep": RT4KSR_Rep(is_train=False),
    "live": LivePath, "repStateDict": {...}, "info": {...}}.
    """
    sources = common.load_sources()
    weights = sources["weights"]["rt4ksr-x2"]
    code = _code_root(work, "rt4ksr") / "code"
    checkpoint = _verified(Path(work) / weights["workPath"], weights["sha256"])

    torch.set_grad_enabled(False)
    with upstream_imports(code):
        import model as upstream  # RT4KSR code/model/__init__.py -> model.arch (rt4ksr_rep)
        train = torch.nn.DataParallel(upstream.__dict__["rt4ksr_rep"](rt4ksr_config(True))).to("cpu")
        template = upstream.__dict__["rt4ksr_rep"](rt4ksr_config(False))
        rep = upstream.__dict__["rt4ksr_rep"](rt4ksr_config(False))

    state = torch.load(checkpoint, map_location="cpu", weights_only=True)["state_dict"]
    train.load_state_dict(state, strict=True)
    train.eval()
    rep_state = clean_reparameterize(state, template.state_dict())
    rep.load_state_dict(rep_state, strict=True)
    rep.eval()
    live = LivePath(rep).eval()

    def count(module, skip=()):
        return int(sum(p.numel() for name, p in module.named_parameters() if not name.startswith(skip)))

    info = {
        "class": "code/model/arch.py RT4KSR_Rep via rt4ksr_rep(config)",
        "config": vars(rt4ksr_config(True)),
        "trainForm": "torch.nn.DataParallel(rt4ksr_rep(is_train=True)), load_state_dict(checkpoint['state_dict'], strict=True)",
        "trainParameters": count(train.module),
        "repParameters": count(rep),
        "liveParameters": count(live),
        "deadBranch": "hfb, gamma and the GaussianBlur high-pass are computed by RT4KSR_Rep.forward but never reach "
                      "the output (forget=False); LivePath omits them",
        "layerNorm": "PlainLayerNorm2d: mean/var over channels, (x - mu) / sqrt(var + 1e-6) * w + b "
                     "(modules.py LayerNormFunction.forward as plain tensor ops)",
    }
    return {"train": train, "rep": rep, "live": live, "repStateDict": rep_state, "info": info}


def clean_reparameterize(train_state: dict, template: dict) -> dict:
    """Side-effect-free CPU port of RT4KSR code/test.py:38-77 (reparameterize).

    Merges each ResBlock (1x1 expand -> 3x3 with bias padding -> 1x1 reduce, plus the identities)
    into one 3x3 rep_conv. Inputs are cloned, nothing is moved to CUDA, the "module." prefix is
    dropped; `template` is RT4KSR_Rep(is_train=False).state_dict() (names and the keys to fill).
    """
    state = {key.removeprefix("module."): value.detach().clone().float() for key, value in train_state.items()}
    out = {}
    for key in template:
        if key.endswith("rep_conv.weight"):
            k0 = state[key.replace("rep", "expand")].clone()
            k1 = state[key.replace("rep", "fea")].clone()
            k2 = state[key.replace("rep", "reduce")].clone()
            bias = key.replace("weight", "bias")
            b0 = state[bias.replace("rep", "expand")]
            b1 = state[bias.replace("rep", "fea")]
            b2 = state[bias.replace("rep", "reduce")]
            mid_feats, n_feats = k0.shape[:2]
            for i in range(mid_feats):  # remove the middle identity
                k1[i, i, 1, 1] += 1.0
            merged_k0k1 = F.conv2d(input=k1, weight=k0.permute(1, 0, 2, 3))
            merged_b0b1 = b0.view(1, -1, 1, 1) * torch.ones(1, mid_feats, 3, 3)
            merged_b0b1 = F.conv2d(input=merged_b0b1, weight=k1, bias=b1)
            merged_k0k1k2 = F.conv2d(input=merged_k0k1.permute(1, 0, 2, 3), weight=k2).permute(1, 0, 2, 3)
            merged_b0b1b2 = F.conv2d(input=merged_b0b1, weight=k2, bias=b2).view(-1)
            for i in range(n_feats):  # remove the global identity
                merged_k0k1k2[i, i, 1, 1] += 1.0
            out[key] = merged_k0k1k2.contiguous()
            out[bias] = merged_b0b1b2.contiguous()
        elif key.endswith("rep_conv.bias"):
            continue
        else:
            out[key] = state[key]
    if set(out) != set(template):
        raise SystemExit(f"reparameterized keys differ from RT4KSR_Rep: {sorted(set(out) ^ set(template))[:5]}")
    return out


class PlainLayerNorm2d(nn.Module):
    """Same math as RT4KSR LayerNormFunction.forward (modules.py), as plain differentiable ops."""

    def __init__(self, source):
        super().__init__()
        self.weight = source.weight
        self.bias = source.bias
        self.eps = source.eps

    def forward(self, x):
        mu = x.mean(1, keepdim=True)
        var = (x - mu).pow(2).mean(1, keepdim=True)
        y = (x - mu) / (var + self.eps).sqrt()
        return self.weight.view(1, -1, 1, 1) * y + self.bias.view(1, -1, 1, 1)


class LivePath(nn.Module):
    """RT4KSR_Rep's live path: PixelUnshuffle(2) -> head -> body -> tail -> upsample (PixelShuffle(4)).

    Shares the reparameterized submodules; every upstream LayerNorm2d is replaced by PlainLayerNorm2d
    (the upstream autograd.Function blocks the dynamo exporter).
    """

    def __init__(self, rep):
        super().__init__()
        rep = copy.deepcopy(rep)  # the swap below must not alter the caller's RT4KSR_Rep
        self.down = rep.down
        self.head = rep.head
        self.body = rep.body
        self.tail = rep.tail
        self.upsample = rep.upsample
        for block in self.body:
            block.norm = PlainLayerNorm2d(block.norm)
        self.tail[0] = PlainLayerNorm2d(self.tail[0])

    def forward(self, x):
        return self.upsample(self.tail(self.body(self.head(self.down(x)))))


# ─── Common entry points ────────────────────────────────────────────────

def load(candidate: str, work: Path) -> dict:
    """{"reference": callable(*inputs) -> output, "export": nn.Module, "info": {...}, ...}."""
    if candidate == "rife-4.25-lite":
        loaded = load_rife(work)
        official = loaded["model"]
        meta = CANDIDATES[candidate]
        loaded["reference"] = lambda img0, img1: official.inference(img0, img1, meta["timestep"], meta["scale"])
        loaded["referenceImplementation"] = ("Practical-RIFE Model.inference(img0, img1, timestep=0.5, scale=1.0) "
                                             "(train_log/RIFE_HDv3.py), IFNet weights from train_log/flownet.pkl")
        loaded["export"] = RifeMidpoint(loaded["flownet"], meta["timestep"], meta["scale"]).eval()
        loaded["exportImplementation"] = "candidates.RifeMidpoint(IFNet, timestep=0.5, scale=1.0)"
        return loaded
    if candidate == "rt4ksr-x2":
        loaded = load_rt4ksr(work)
        train = loaded["train"]
        loaded["reference"] = lambda x: train(x)
        loaded["referenceImplementation"] = ("RT4KSR training form: DataParallel(rt4ksr_rep(is_train=True)) with the "
                                             "strict-loaded rt4ksr_x2.pth state_dict (code/test.py:101-111)")
        loaded["export"] = loaded["live"]
        loaded["exportImplementation"] = ("candidates.LivePath(RT4KSR_Rep(is_train=False) loaded with "
                                          "candidates.clean_reparameterize(training state_dict)), PlainLayerNorm2d")
        return loaded
    raise SystemExit(f"unknown candidate: {candidate}")


def clear_rife_grid_cache(loaded: dict) -> int:
    """Empty Practical-RIFE's module-level backwarp grid cache; returns how many entries it had.

    Export traces the grid construction (constant-folded by the exporter) rather than capturing grids
    cached by an earlier eager run (the "warm" variant, used only as the last fallback).
    """
    warplayer = loaded.get("warplayer")
    if warplayer is None:
        return 0
    count = len(warplayer.backwarp_tenGrid)
    warplayer.backwarp_tenGrid.clear()
    return count
