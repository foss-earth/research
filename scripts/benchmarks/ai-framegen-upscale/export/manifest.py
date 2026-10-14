"""Generate pinned candidate manifests from verified sources, export receipts and browser results.

Run with <work>/venv/bin/python -I -B .../export/manifest.py [--work=<folder>]
  [--browser-results=<parity run or results folder>] (repeatable).
Writes benchmarks/ai-framegen-upscale/manifests/{rife-4.25-lite,rt4ksr-x2}.json.
Only numbers, hashes and provenance are published; model/reference/media bytes stay in build/.
Every installed graph and referenced case is verified before its receipt is trusted. Browser
observations retain their source hash and the exported graph hash, and an unmatched hash fails.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

CANDIDATES = {
    "rife-4.25-lite": {"name": "Practical-RIFE 4.25.lite", "task": "midpoint-frame-interpolation",
                       "code": "practical-rife", "inputs": ["img0", "img1"], "outputScale": 1},
    "rt4ksr-x2": {"name": "RT4KSR x2 (clean reparameterized inference form)",
                  "task": "super-resolution-x2", "code": "rt4ksr", "inputs": ["input"], "outputScale": 2},
}


def browser_records(paths: list[str]) -> list[dict]:
    """Find per-profile parity records, preserving the exact supporting result file/hash."""
    records = []
    seen = set()
    for argument in paths:
        path = Path(argument).resolve()
        files = [path] if path.is_file() else sorted(path.rglob("*.json"))
        for file in files:
            if file in seen:
                continue
            seen.add(file)
            data = json.loads(file.read_text(encoding="utf-8"))
            # The browser runner writes one candidate/profile/precision file. Also accept a
            # summary container so the manifest can consume selected evidence copies.
            items = [data] if isinstance(data, dict) and data.get("candidate") else (
                data.get("profiles", data.get("results", [])) if isinstance(data, dict) else [])
            for item in items:
                if (not isinstance(item, dict) or item.get("candidate") not in CANDIDATES
                        or item.get("profile") not in common.PROFILES[item["candidate"]]
                        or item.get("precision") not in common.PRECISIONS):
                    continue
                records.append({"source": common.script_receipt(file), "record": item})
    return records


def verify_receipt(path: Path, work: Path) -> dict:
    receipt = json.loads(path.read_text(encoding="utf-8"))
    graph = path.parent / receipt["file"]
    if (graph.is_symlink() or not graph.is_file() or graph.stat().st_size != receipt["bytes"]
            or common.sha256_file(graph) != receipt["sha256"]):
        raise SystemExit(f"{graph}: does not match its export receipt")
    import references
    for case in receipt["references"]:
        loaded = references.load_case(work / "references" / receipt["candidate"] / receipt["profile"] / case)
        expected = receipt["references"][case]
        if (loaded["meta"]["output"]["sha256"] != expected["outSha256"]
                or [i["sha256F32"] for i in loaded["meta"]["inputs"]] != expected["inputSha256F32"]):
            raise SystemExit(f"{path}: reference case {case} differs from the export receipt")
    receipt["receipt"] = common.script_receipt(path)
    return receipt


def browser_observation(entry: dict, graph_hash: str) -> dict:
    """Compact numeric observation with a hash of the complete original evidence."""
    record = entry["record"]
    result = {"source": entry["source"], "graphSha256": graph_hash,
              **{key: record[key] for key in ("status", "gates", "gateB", "gateC", "gateD", "gateE", "gateF",
                  "memory", "placement", "gpu", "staticOpSupport", "runtimeBuild", "pass", "error") if key in record}}
    if "preparation" in record:
        result["preparation"] = {key: value for key, value in record["preparation"].items() if key != "gpu"}
    if "cases" in record:
        result["cases"] = []
        for case in record["cases"]:
            row = dict(case)
            if isinstance(row.get("fullPath"), dict):
                row["fullPath"] = {key: value for key, value in row["fullPath"].items() if key != "histogram"}
            result["cases"].append(row)
    if "coldLoad" in record:
        result["coldLoad"] = []
        for cold in record["coldLoad"]:
            values = cold.get("result") or {}
            result["coldLoad"].append({
                **{key: cold[key] for key in ("cacheState", "repeat", "status", "modelSha256", "cacheWarmClaim", "note", "error") if key in cold},
                **{key: values[key] for key in ("importMs", "fetchMs", "bytes", "createMs", "first", "second", "outputBinding", "errors") if key in values},
                "peakIncrementalBytes": values.get("memory", {}).get("incremental", {}).get("peakBytes"),
                "qualification": "unqualified shared-machine wall observation; full source record retained by source hash",
            })
    return result


def manifest(candidate: str, work: Path, browser: list[dict]) -> dict:
    sources = common.load_sources()
    specification = CANDIDATES[candidate]
    code = sources["code"][specification["code"]]
    weights = sources["weights"][candidate]
    dependency_path = Path(__file__).resolve().parents[1] / "browser-dependencies.json"
    dependencies = json.loads(dependency_path.read_text(encoding="utf-8"))
    exports = []
    for _, profile in [entry for entry in common.ORDER if entry[0] == candidate]:
        for precision in common.PRECISIONS:
            path = work / "models" / candidate / profile / f"{precision}.receipt.json"
            if not path.is_file():
                exports.append({"profile": profile, "precision": precision, "status": "not-exported"})
                continue
            receipt = verify_receipt(path, work)
            observations = []
            for entry in browser:
                record = entry["record"]
                if (record["candidate"], record["profile"], record["precision"]) != (candidate, profile, precision):
                    continue
                graph_hash = record.get("modelSha256", record.get("sha256"))
                if graph_hash is None and isinstance(record.get("model"), dict):
                    graph_hash = record["model"].get("sha256")
                if graph_hash != receipt["sha256"]:
                    raise SystemExit(f"{entry['source']['path']}: missing or unmatched graph sha256")
                observations.append(browser_observation(entry, graph_hash))
            exports.append({"profile": profile, "precision": precision,
                            "status": "exported" if receipt["gateA"].get("pass") else "exported-gate-A-unpassed",
                            **{key: receipt[key] for key in ("file", "path", "sha256", "bytes", "opset", "irVersion",
                                "exporter", "nodeCount", "opHistogram", "initializerBytes", "inputs", "outputs", "gateA",
                                "graph", "webgpuStaticCheck", "exportVariant", "references", "receipt", "run")},
                            "conversion": {key: receipt[key] for key in ("command", "environment", "script", "modules",
                                "createdAt", "fp16", "job") if key in receipt},
                            "browser": observations or {"status": "not-run"}})
    contract = {
        "layout": "NCHW", "channelOrder": "RGB", "ioType": "float32 for both graph precisions",
        "color": "SDR display-referred sRGB-encoded values; no linearization, gamma change or channel flip",
        "inputRange": [0, 1], "inputRule": "float32(uint8 RGB) / float32(255)",
        "outputClamp": [0, 1], "expected8Rule": "rint(clip(reference,0,1)*float32(255)), alpha 255",
        "padding": "zero pad right/bottom to multiples of 128; crop top-left valid output" if candidate.startswith("rife")
                   else "input width/height even; no additional padding; output exactly twice input dimensions",
        "outputName": "output", "inputNames": specification["inputs"], "outputScale": specification["outputScale"],
    }
    if candidate.startswith("rife"):
        contract.update({"timestep": 0.5, "scale": 1.0, "scaleList": [32, 16, 8, 4, 1]})
    return {
        "schema": 1, "candidate": candidate, "name": specification["name"], "task": specification["task"],
        "createdAt": common.now_iso(), "generator": common.script_receipt(__file__),
        "sourceManifest": common.script_receipt(common.SOURCES_JSON),
        "code": {key: code[key] for key in ("name", "repository", "commit", "commitDate", "tree", "license", "files")},
        "weights": {key: weights[key] for key in ("file", "sha256", "bytes", "origin", "terms", "extracted") if key in weights},
        "conversionLock": common.script_receipt(common.LOCK), "graphContract": contract,
        "supportedShapes": [{"profile": item["profile"], "precision": item["precision"], "inputs": item["inputs"],
                             "outputs": item["outputs"]} for item in exports if "inputs" in item],
        "runtime": {"dependencyManifest": common.script_receipt(dependency_path), **dependencies},
        "exports": exports,
        "artifactPolicy": "ONNX, weights, tensors and derived corpus imagery remain in gitignored build; hashes and selected results only are published",
        "admission": "This manifest records evidence. It does not admit any renderer/application profile; A-I and human contact-sheet review determine the screen.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work")
    parser.add_argument("--browser-results", action="append", default=[])
    args = parser.parse_args()
    work = common.work_dir(args.work)
    common.apply_scratch_env(work)
    browser = browser_records(args.browser_results)
    output = common.RESEARCH / "benchmarks" / "ai-framegen-upscale" / "manifests"
    for candidate in CANDIDATES:
        result = manifest(candidate, work, browser)
        path = output / f"{candidate}.json"
        common.write_json(path, result)
        print(f"{common.repo_relative(path)}: {sum('sha256' in e for e in result['exports'])} verified graphs, "
              f"{sum(isinstance(e.get('browser'), list) for e in result['exports'])} observed profiles", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
