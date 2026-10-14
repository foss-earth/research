"""Fixed-shape ONNX exports (fp32 and fp16) for every candidate/profile, with graph checks and gate A.

DESIGN.md section 5. For each candidate/profile in export order (small for both candidates, then
720p, 1080p, then RIFE 540p) one child process (fresh interpreter: per-job wall time and peak RSS
from wait4, no state shared between profiles):

  1. loads the stored reference cases (references.load_case: synthetic and natural; run
     references.py first) and the candidate (candidates.load);
  2. exports fp32 with the first variant of the fallback chain that passes every check
       rife-4.25-lite  dyn17 (dynamo, opset 17, backwarp grid cache cleared) -> ts17 (TorchScript,
                       opset 17) -> dyn17-warm (dynamo, grids cached by one eager run)
       rt4ksr-x2       clean-dyn20 (dynamo, opset 20, Gelu) -> clean-ts17 (TorchScript, opset 17, Erf)
     checks: onnx.checker full_check; fully static (every value has fixed dims after strict shape
     inference; no Shape/Size/ConstantOfShape/Range/NonZero/control flow; no runtime integer
     tensors; no foldable constant subgraphs; ai.onnx domain only, no functions); the static
     native-WebGPU-EP op-support check (WEBGPU_KERNELS, cited from the ORT v1.30.0 source); gate A.
     ORT offline basic optimization is applied only when the static check fails, then re-checked;
  3. converts the chosen fp32 graph to fp16 with onnxconverter-common
     convert_float_to_float16(keep_io_types=True, op_block_list=[]) (every op used has an fp16
     kernel in the native WebGPU EP, see WEBGPU_KERNELS) and restores Resize's roi/scales inputs to
     their original float32 tensors (the converter casts them to fp16, but ONNX Resize takes float
     scales only), then runs the same checks and gate A. The ops ORT CPU upcasts to fp32 (no CPU
     fp16 kernel; InsertCastTransformer) are recorded, so the CPU fp16 result is labelled for what
     it is;
  4. writes <work>/models/<candidate>/<profile>/<precision>.onnx + <precision>.receipt.json
     (previous files moved to <work>/models/superseded/<stamp>/). If no fp32 fallback passes
     gate A, retain the valid/static fallback with smallest maxAbs for diagnostic B-F only.
     Valid/static fp16 failures are likewise retained with status failed-gate-A; job exits 1.
     A failed export is never admitted by the browser/timing screen.

Gate A (acceptance-rules.md A): ORT 1.23.2 CPUExecutionProvider (default session options, ORT
graph optimization ENABLE_ALL, 4 intra-op threads) vs the stored PyTorch fp32 CPU reference
(out.f32) on the identical padded float32 input rebuilt from the stored .rgba8 files; valid
(cropped) region, all three channels, both clamped to [0, 1]; fp32 max <= 1e-3 and mean <= 1e-5,
fp16 max <= 5e-2 and mean <= 2e-3; must hold on both cases. Unclamped and ORT DISABLE_ALL numbers,
PSNR and the 8-bit comparison with out.rgba8 are recorded as diagnostics.

Outputs: the models and receipts in <work>/models, <work>/models/index.json, and a run folder
build/benchmarks/ai-framegen-upscale/export/<stamp>/ with jobs/<candidate>/<profile>/ (attempt
graphs, ORT CPU diagnostic graphs, job.json), logs/ and results/export.json.

Run (heavy CPU at 1080p; one job at a time; waits for normal memory pressure before each job):
  nice -n 10 <work>/venv/bin/python -I -B -X pycache_prefix=<work>/cache/pycache \\
    scripts/benchmarks/ai-framegen-upscale/export/export.py [--candidates=rife-4.25-lite,rt4ksr-x2] \\
    [--profiles=small,720p,1080p,540p] [--precisions=fp32,fp16] [--threads=4] [--work=<dir>]
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import resource
import shutil
import subprocess
import sys
import time
import traceback
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

GATE_A = {"fp32": {"maxAbs": 1e-3, "meanAbs": 1e-5}, "fp16": {"maxAbs": 5e-2, "meanAbs": 2e-3}}
GATE_A_RUNTIME = "onnxruntime 1.23.2 CPUExecutionProvider"
CASES = ("synthetic", "natural")

VARIANTS = {
    "rife-4.25-lite": [
        {"id": "dyn17", "exporter": "dynamo", "opset": 17, "warm": False,
         "description": "torch.onnx.export(dynamo=True, opset_version=17, optimize=True), backwarp grid cache cleared"},
        {"id": "ts17", "exporter": "torchscript", "opset": 17, "warm": False,
         "description": "torch.onnx.export(dynamo=False, opset_version=17, do_constant_folding=True), grid cache cleared"},
        {"id": "dyn17-warm", "exporter": "dynamo", "opset": 17, "warm": True,
         "description": "dynamo opset 17 after one eager forward (backwarp grids baked from the cache)"},
    ],
    "rt4ksr-x2": [
        {"id": "clean-dyn20", "exporter": "dynamo", "opset": 20, "warm": False,
         "description": "LivePath, torch.onnx.export(dynamo=True, opset_version=20, optimize=True) (Gelu op)"},
        {"id": "clean-ts17", "exporter": "torchscript", "opset": 17, "warm": False,
         "description": "LivePath, torch.onnx.export(dynamo=False, opset_version=17, do_constant_folding=True) (Erf form)"},
    ],
}

FP16_OPTIONS = {"function": "onnxconverter_common.float16.convert_float_to_float16", "keepIoTypes": True,
                "opBlockList": [], "nodeBlockList": [], "minPositiveVal": 1e-7, "maxFiniteVal": 1e4,
                "postprocess": "Resize roi/scales inputs restored to the original float32 tensors"}

# Native WebGPU EP kernel registrations in ONNX Runtime v1.30.0 (the onnxruntime-web build used by
# the harness), read from build/ai-framegen-upscale/upstream/onnxruntime-v1.30.0/onnxruntime/core/
# providers/webgpu/. op -> (registered ai.onnx since-version ranges (end None = open), type list,
# source). Every type list below contains MLFloat16 (webgpu_supported_types.h: SupportedNumberTypes
# = float, MLFloat16, int32, uint32; SupportedFloats = float, MLFloat16; GetOpTypeConstraints base =
# MLFloat16, float, int32, uint32), so no op needs an fp32 block for kernel availability.
_P = "webgpu_execution_provider.cc"
WEBGPU_KERNELS = {
    "Add": ([(7, 12), (13, 13), (14, None)], "GetOpTypeConstraints", "math/binary_elementwise_ops.cc:543"),
    "Sub": ([(7, 12), (13, 13), (14, None)], "GetOpTypeConstraints", "math/binary_elementwise_ops.cc:544"),
    "Mul": ([(7, 12), (13, 13), (14, None)], "GetOpTypeConstraints", "math/binary_elementwise_ops.cc:545"),
    "Div": ([(7, 12), (13, 13), (14, None)], "GetOpTypeConstraints", "math/binary_elementwise_ops.cc:546"),
    "Pow": ([(7, 11), (12, 12), (13, 14), (15, None)], "WebGpuSupportedNumberTypes (T, T1)",
            "math/binary_elementwise_ops.cc:554-555"),
    "Sqrt": ([(6, 12), (13, None)], "WebGpuSupportedFloatTypes", f"{_P}:121-122; math/unary_elementwise_ops.cc:96-97"),
    "Erf": ([(9, 12), (13, None)], "WebGpuSupportedFloatTypes", f"{_P}:125-126; math/unary_elementwise_ops.cc:104-105"),
    "Sigmoid": ([(6, 12), (13, None)], "WebGpuSupportedFloatTypes", f"{_P}:127-128; math/unary_elementwise_ops.cc:112-113"),
    "LeakyRelu": ([(6, 15), (16, None)], "WebGpuSupportedFloatTypes", f"{_P}:165-166; math/unary_elementwise_ops.cc:422-423"),
    "Gelu": ([(20, None)], "WebGpuSupportedFloatTypes", f"{_P}:168; math/unary_elementwise_ops.cc:414"),
    "ReduceMean": ([(1, 10), (11, 12), (13, 17), (18, None)], "WebGpuSupportedNumberTypes",
                   f"{_P}:208-211; reduction/reduction_ops.cc:22-46"),
    "Transpose": ([(1, 12), (13, 20), (21, 22), (23, 23), (24, None)], "WebGpuSupportedNumberTypes",
                  f"{_P}:254-258; tensor/transpose.cc"),
    "DepthToSpace": ([(11, 12), (13, None)], "WebGpuSupportedFloatTypes", f"{_P}:260-261; tensor/depth_to_space.cc:20,30"),
    "Conv": ([(1, 10), (11, 21), (22, None)], "WebGpuSupportedFloatTypes", f"{_P}:265-267; nn/conv.cc:429-454"),
    "ConvTranspose": ([(1, 10), (11, None)], "WebGpuSupportedFloatTypes", f"{_P}:272-273; nn/conv_transpose.cc:145-169"),
    "Resize": ([(10, 10), (11, 12), (13, 17), (18, 18), (19, None)], "WebGpuSupportedNumberTypes",
               f"{_P}:339-343 (NHWC Resize commented out, 344-348); tensor/resize.cc"),
    "Slice": ([(1, 9), (10, 10), (11, 12), (13, None)], "WebGpuSupportedFloatTypes", f"{_P}:350-353; tensor/slice.cc"),
    "GridSample": ([(16, 19)], "WebGpuSupportedFloatTypes (T1, T2)", f"{_P}:435; tensor/grid_sample.cc:251-258"),
    "Cast": ([(6, 8), (9, 12), (13, 18), (19, 20), (21, 22), (23, 23), (24, 24), (25, None)],
             "T1 GetOpTypeConstraints(+bool, uint8), T2 GetOpTypeConstraints(int64, bool)+uint8",
             f"{_P}:449-456; tensor/cast.cc:205-218"),
    "Reshape": ([(5, 12), (13, 13), (14, 18), (19, 20), (21, 22), (23, 24), (25, None)],
                "GetOpTypeConstraints(+bool)+uint8, shape int64 on CPU", f"{_P}:482-488; tensor/reshape.cc:14,39"),
    "Concat": ([(1, 3), (4, 10), (11, 12), (13, None)], "GetOpTypeConstraints", f"{_P}:491-494; tensor/concat.cc:21,40"),
}
WEBGPU_SOURCE = "onnxruntime v1.30.0 onnxruntime/core/providers/webgpu (build/ai-framegen-upscale/upstream/onnxruntime-v1.30.0)"

SHAPE_OPS = {"Shape", "Size", "ConstantOfShape", "Range", "NonZero", "If", "Loop", "Scan", "SequenceConstruct",
             "SplitToSequence", "SequenceAt", "Unique", "TopK"}
# Inputs that are shape-like (int64 allowed when they are initializers).
SHAPE_INPUTS = {"Reshape": {1}, "Slice": {1, 2, 3, 4}, "Resize": {1, 2, 3}, "Expand": {1}, "Tile": {1},
                "Pad": {1, 2, 3}, "Squeeze": {1}, "Unsqueeze": {1}, "ReduceMean": {1}, "Split": {1}}
FLOAT_TYPES = {1: "float32", 10: "float16", 11: "float64", 16: "bfloat16"}


# ─── Graph checks ───────────────────────────────────────────────────────

def _ranges_text(ranges) -> str:
    return ", ".join(f"{a}-{b}" if b is not None and b != a else (f"{a}+" if b is None else f"{a}") for a, b in ranges)


def webgpu_check(model) -> dict:
    """Static native-WebGPU-EP op-support check: every node's resolved schema version has a registered
    kernel whose type list includes the node's float type (fp16 and fp32 are in every list here)."""
    import onnx

    opset = {entry.domain or "": entry.version for entry in model.opset_import}
    ops, problems = {}, []
    for node in model.graph.node:
        domain = node.domain or ""
        if domain != "":
            problems.append(f"{node.op_type}: domain {domain!r} has no native WebGPU kernel")
            continue
        if node.op_type in ops:
            ops[node.op_type]["nodes"] += 1
            continue
        try:
            since = onnx.defs.get_schema(node.op_type, opset[""], "").since_version
        except Exception as error:  # noqa: BLE001
            problems.append(f"{node.op_type}: no schema at opset {opset['']}: {error}")
            continue
        entry = {"nodes": 1, "schemaSinceVersion": since}
        known = WEBGPU_KERNELS.get(node.op_type)
        if known is None:
            entry["registered"] = None
            problems.append(f"{node.op_type}: not in the cited registration table (unchecked)")
        else:
            ranges, types, source = known
            match = [r for r in ranges if since >= r[0] and (r[1] is None or since <= r[1])]
            entry.update({"registered": _ranges_text(match) if match else None, "allRanges": _ranges_text(ranges),
                          "types": types, "fp16": True, "source": source})
            if not match:
                problems.append(f"{node.op_type}: schema version {since} (opset {opset['']}) has no WebGPU kernel "
                                f"(registered {_ranges_text(ranges)})")
        ops[node.op_type] = entry
    return {"ok": not problems, "problems": problems, "opset": opset.get(""), "ops": ops, "source": WEBGPU_SOURCE}


def _tensor_bytes(tensor) -> int:
    from onnx import numpy_helper
    return int(numpy_helper.to_array(tensor).nbytes)


def graph_report(model) -> dict:
    """Checker, static-graph checks, op histogram, sizes, I/O (model: onnx.ModelProto)."""
    import onnx

    report = {}
    try:
        onnx.checker.check_model(model, full_check=True)
        report["checker"] = "ok"
    except Exception as error:  # noqa: BLE001
        report["checker"] = f"{type(error).__name__}: {str(error)[:1500]}"
    graph = model.graph
    initializers = {t.name: t for t in graph.initializer}
    constants = {}
    for node in graph.node:
        if node.op_type == "Constant":
            for output in node.output:
                constants[output] = node
    histogram = collections.Counter(node.op_type for node in graph.node)
    report.update({
        "irVersion": model.ir_version,
        "opsetImport": {entry.domain or "ai.onnx": entry.version for entry in model.opset_import},
        "producer": f"{model.producer_name} {model.producer_version}".strip(),
        "nodeCount": len(graph.node),
        "opHistogram": dict(sorted(histogram.items())),
        "initializerCount": len(initializers),
        "initializerBytes": sum(_tensor_bytes(t) for t in initializers.values()),
        "initializerTypes": dict(collections.Counter(onnx.TensorProto.DataType.Name(t.data_type)
                                                     for t in initializers.values())),
        "constantNodeBytes": sum(_tensor_bytes(n.attribute[0].t) for n in constants.values()
                                 if n.attribute and n.attribute[0].name == "value"),
        "functions": len(model.functions),
    })

    def io(values):
        out = []
        for value in values:
            tensor = value.type.tensor_type
            out.append({"name": value.name,
                        "dims": [d.dim_value if d.HasField("dim_value") else (d.dim_param or None) for d in tensor.shape.dim],
                        "type": FLOAT_TYPES.get(tensor.elem_type, onnx.TensorProto.DataType.Name(tensor.elem_type).lower())})
        return out

    report["inputs"] = io(graph.input)
    report["outputs"] = io(graph.output)

    static = {"problems": []}
    try:
        inferred = onnx.shape_inference.infer_shapes(model, check_type=True, strict_mode=True, data_prop=True)
        static["shapeInference"] = "ok (strict)"
    except Exception as error:  # noqa: BLE001
        inferred = model
        static["shapeInference"] = f"{type(error).__name__}: {str(error)[:600]}"
        static["problems"].append("strict shape inference failed")
    types = {}
    for value in list(inferred.graph.value_info) + list(inferred.graph.output) + list(inferred.graph.input):
        tensor = value.type.tensor_type
        dims = [d.dim_value if d.HasField("dim_value") else None for d in tensor.shape.dim] if tensor.HasField("shape") else None
        types[value.name] = (tensor.elem_type, dims)
    dynamic, unknown, runtime_ints = [], [], []
    for node in graph.node:
        if node.op_type == "Constant":
            continue
        for output in node.output:
            if not output:
                continue
            if output not in types:
                unknown.append(output)
                continue
            elem, dims = types[output]
            if dims is None or any(d is None or d <= 0 for d in dims):
                dynamic.append(output)
            if elem not in FLOAT_TYPES:
                runtime_ints.append(f"{node.op_type}:{output}:{onnx.TensorProto.DataType.Name(elem)}")
    for value in list(graph.input) + list(graph.output):
        dims = [d.dim_value if d.HasField("dim_value") else None for d in value.type.tensor_type.shape.dim]
        if not dims or any(d is None or d <= 0 for d in dims):
            dynamic.append(value.name)
    # Nodes computable at export time: every input is an initializer, a Constant output or another such node.
    constant_values = set(initializers) | set(constants)
    foldable = []
    for node in graph.node:  # graph.node is topologically sorted (checked by the checker)
        if node.op_type == "Constant":
            continue
        if all((not name) or name in constant_values for name in node.input):
            foldable.append(f"{node.op_type}:{node.name}")
            constant_values.update(node.output)
    forbidden = {op: n for op, n in histogram.items() if op in SHAPE_OPS}
    non_shape_ints = []
    for node in graph.node:
        for index, name in enumerate(node.input):
            tensor = initializers.get(name)
            if tensor is not None and tensor.data_type not in FLOAT_TYPES and index not in SHAPE_INPUTS.get(node.op_type, ()):
                non_shape_ints.append(f"{node.op_type}:{name}[{index}]")
    domains = sorted({entry.domain or "" for entry in model.opset_import} - {""})
    static.update({"dynamicValues": dynamic[:20], "dynamicCount": len(dynamic), "untypedValues": unknown[:20],
                   "untypedCount": len(unknown), "runtimeIntegerTensors": runtime_ints[:20],
                   "runtimeIntegerCount": len(runtime_ints), "foldableNodes": foldable[:20],
                   "foldableCount": len(foldable), "forbiddenOps": forbidden, "constantNodes": len(constants),
                   "integerInitializersOutsideShapeInputs": non_shape_ints[:20], "nonDefaultDomains": domains})
    for label, bad in (("dynamic dims", dynamic), ("untyped values", unknown), ("runtime integer tensors", runtime_ints),
                       ("foldable constant subgraphs", foldable), ("shape/control-flow ops", forbidden),
                       ("integer initializers outside shape inputs", non_shape_ints), ("non-default domains", domains),
                       ("functions", model.functions)):
        if bad:
            static["problems"].append(label)
    static["ok"] = not static["problems"]
    report["static"] = static
    report["webgpu"] = webgpu_check(model)
    report["attributes"] = _key_attributes(graph)
    return report


def _key_attributes(graph) -> dict:
    """Distinct attribute sets of the ops whose modes matter on WebGPU (GridSample, Resize)."""
    import onnx

    seen = collections.defaultdict(collections.Counter)
    for node in graph.node:
        if node.op_type in ("GridSample", "Resize", "DepthToSpace"):
            attributes = {a.name: onnx.helper.get_attribute_value(a) for a in node.attribute}
            attributes = {k: (v.decode() if isinstance(v, bytes) else v) for k, v in sorted(attributes.items())}
            seen[node.op_type][json.dumps(attributes, sort_keys=True)] += 1
    return {op: [{"attributes": json.loads(k), "nodes": n} for k, n in c.items()] for op, c in seen.items()}


# ─── ORT CPU (gate A) ───────────────────────────────────────────────────

def ort_session(path: Path, threads: int, level: str = "all", optimized: Path | None = None):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    options.graph_optimization_level = {"all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL,
                                        "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
                                        "disable": ort.GraphOptimizationLevel.ORT_DISABLE_ALL}[level]
    if optimized is not None:
        options.optimized_model_filepath = str(optimized)
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def compare(output, case: dict) -> dict:
    """Gate A metrics for one case: valid region, all channels, clamped to [0, 1] (+ diagnostics)."""
    import numpy as np

    reference = case["reference"].astype(np.float64)
    height, width = reference.shape[2:]
    got = np.asarray(output, np.float64)[:, :, :height, :width]
    if got.shape != reference.shape:
        raise SystemExit(f"output {output.shape} cannot be cropped to the reference {reference.shape}")
    clamped = np.abs(np.clip(got, 0, 1) - np.clip(reference, 0, 1))
    raw = np.abs(got - reference)
    mse = float(np.mean(clamped ** 2))
    meta = case["meta"]
    expected8 = np.frombuffer((case["directory"] / meta["output"]["expected8"]).read_bytes(), np.uint8)
    expected8 = expected8.reshape(height, width, 4)[..., :3].transpose(2, 0, 1).astype(np.int32)
    got8 = np.rint(np.clip(np.asarray(output, np.float32)[0, :, :height, :width], 0, 1) * np.float32(255)).astype(np.int32)
    codes = np.abs(got8 - expected8)
    return {"maxAbs": float(clamped.max()), "meanAbs": float(clamped.mean()),
            "psnr": None if mse == 0 else float(10 * np.log10(1.0 / mse)),
            "unclamped": {"maxAbs": float(raw.max()), "meanAbs": float(raw.mean())},
            "outputRange": [float(got.min()), float(got.max())], "nonFinite": int((~np.isfinite(got)).sum()),
            "codes8": {"within1": float((codes <= 1).mean()), "max": int(codes.max())}}


def gate_a(path: Path, precision: str, cases: dict, threads: int, diagnostics_dir: Path) -> dict:
    """ORT CPU vs the stored reference on every case; worst case per metric decides."""
    import numpy as np

    limits = GATE_A[precision]
    started = time.perf_counter()
    try:
        t0 = time.perf_counter()
        session = ort_session(path, threads, "all")
        create = time.perf_counter() - t0
    except Exception as error:  # noqa: BLE001
        return {"status": "not-runnable", "reason": f"{type(error).__name__}: {str(error)[:1000]}",
                "runtime": GATE_A_RUNTIME}
    names = [i.name for i in session.get_inputs()]
    per_case = {}
    try:
        for name, case in cases.items():
            feeds = dict(zip(names, case["inputs"]))
            t0 = time.perf_counter()
            output = session.run(["output"], feeds)[0]
            seconds = time.perf_counter() - t0
            per_case[name] = {**compare(output, case), "runSeconds": round(seconds, 3)}
    except Exception as error:  # noqa: BLE001
        return {"status": "not-runnable", "reason": f"run: {type(error).__name__}: {str(error)[:1000]}",
                "runtime": GATE_A_RUNTIME, "cases": per_case}
    del session
    # Diagnostic: the same graph without ORT graph optimizations (also records CPU fp16 upcasts).
    diagnostic = {}
    try:
        optimized = diagnostics_dir / f"{precision}.ort-cpu-disable-all.onnx"
        session = ort_session(path, threads, "disable", optimized)
        for name, case in cases.items():
            output = session.run(["output"], dict(zip(names, case["inputs"])))[0]
            metrics = compare(output, case)
            diagnostic[name] = {"maxAbs": metrics["maxAbs"], "meanAbs": metrics["meanAbs"]}
        del session
        diagnostic["cpuPlacement"] = cpu_upcasts(path, optimized)
    except Exception as error:  # noqa: BLE001
        diagnostic["error"] = f"{type(error).__name__}: {str(error)[:600]}"
    worst_max = max(per_case, key=lambda c: per_case[c]["maxAbs"])
    worst_mean = max(per_case, key=lambda c: per_case[c]["meanAbs"])
    max_abs = per_case[worst_max]["maxAbs"]
    mean_abs = per_case[worst_mean]["meanAbs"]
    finite = all(c["nonFinite"] == 0 for c in per_case.values())
    passed = bool(finite and max_abs <= limits["maxAbs"] and mean_abs <= limits["meanAbs"])
    return {"maxAbs": max_abs, "meanAbs": mean_abs, "pass": passed, "runtime": GATE_A_RUNTIME,
            "input": "+".join(per_case), "worstCase": {"maxAbs": worst_max, "meanAbs": worst_mean},
            "limits": limits,
            "comparison": "valid (cropped) region, all 3 channels, ORT output and stored PyTorch fp32 reference both "
                          "clamped to [0,1]; worst case per metric; non-finite values fail",
            "sessionOptions": "CPUExecutionProvider, ORT_ENABLE_ALL, intra_op_num_threads=%d" % threads,
            "sessionCreateSeconds": round(create, 3), "seconds": round(time.perf_counter() - started, 3),
            "cases": per_case, "ortDisableAll": diagnostic}


def cpu_upcasts(source: Path, optimized: Path) -> dict:
    """Casts ORT CPU inserted (InsertCastTransformer: ops without a CPU kernel for the graph's type)."""
    import onnx

    before = collections.Counter(node.op_type for node in onnx.load(str(source), load_external_data=False).graph.node)
    graph = onnx.load(str(optimized), load_external_data=False).graph
    after = collections.Counter(node.op_type for node in graph.node)
    inserted = [node for node in graph.node if node.op_type == "Cast" and "InsertedPrecisionFreeCast" in node.name]
    to_float = {o for node in inserted for o in node.output
                if any(a.name == "to" and a.i == onnx.TensorProto.FLOAT for a in node.attribute)}
    upcast = collections.Counter(node.op_type for node in graph.node if any(i in to_float for i in node.input))
    return {"insertedCasts": len(inserted), "castNodesBefore": before.get("Cast", 0), "castNodesAfter": after.get("Cast", 0),
            "nodesFedByInsertedFp32Casts": dict(sorted(upcast.items())),
            "note": "ORT_DISABLE_ALL session; inserted casts mean the CPU EP ran those nodes in float32"}


# ─── Export ─────────────────────────────────────────────────────────────

def export_variant(variant: dict, module, inputs, names: list[str], path: Path) -> dict:
    import torch

    caught = []
    started = time.perf_counter()
    with warnings.catch_warnings(record=True) as records:
        warnings.simplefilter("always")
        if variant["exporter"] == "dynamo":
            torch.onnx.export(module, tuple(inputs), str(path), dynamo=True, opset_version=variant["opset"],
                              external_data=False, optimize=True, input_names=names, output_names=["output"],
                              artifacts_dir=str(path.parent))
        else:
            torch.onnx.export(module, tuple(inputs), str(path), dynamo=False, opset_version=variant["opset"],
                              do_constant_folding=True, input_names=names, output_names=["output"])
        caught = [f"{r.category.__name__}: {str(r.message)[:300]}" for r in records]
    seconds = time.perf_counter() - started
    return {"seconds": round(seconds, 3),
            "warnings": [f"{n}x {m}" for m, n in collections.Counter(caught).items()][:20]}


def ort_basic_optimize(source: Path, target: Path, threads: int) -> None:
    ort_session(source, threads, "basic", target)
    # ORT serializes imports for all registered domains even when the optimized graph contains
    # only ai.onnx nodes. Remove those unused declarations; no graph nodes or tensors change.
    import onnx
    model = onnx.load(str(target))
    used = {node.domain or "" for node in model.graph.node} | {""}
    unused = [entry for entry in model.opset_import if (entry.domain or "") not in used]
    for entry in unused:
        model.opset_import.remove(entry)
    onnx.save(model, str(target))


def convert_fp16(model, op_block_list=None, node_block_list=None):
    """fp16 graph (FP16_OPTIONS) + Resize roi/scales restored to float32; returns (model, details)."""
    import numpy as np
    import onnx
    from onnx import numpy_helper
    from onnxconverter_common import float16

    original = {t.name: t for t in model.graph.initializer}
    for node in model.graph.node:
        if node.op_type == "Constant" and node.attribute and node.attribute[0].name == "value":
            original.setdefault(node.output[0], node.attribute[0].t)
    clamp = {"belowMinPositive": 0, "aboveMaxFinite": 0, "fp16Subnormal": 0, "elements": 0}
    for tensor in original.values():
        if tensor.data_type != onnx.TensorProto.FLOAT:
            continue
        array = np.abs(numpy_helper.to_array(tensor))
        clamp["elements"] += int(array.size)
        clamp["belowMinPositive"] += int(((array > 0) & (array < FP16_OPTIONS["minPositiveVal"])).sum())
        clamp["aboveMaxFinite"] += int((array > FP16_OPTIONS["maxFiniteVal"]).sum())
        clamp["fp16Subnormal"] += int(((array >= FP16_OPTIONS["minPositiveVal"]) & (array < 6.103515625e-05)).sum())
    op_blocks = list(FP16_OPTIONS["opBlockList"] if op_block_list is None else op_block_list)
    node_blocks = list(FP16_OPTIONS["nodeBlockList"] if node_block_list is None else node_block_list)
    started = time.perf_counter()
    with warnings.catch_warnings(record=True) as records:
        warnings.simplefilter("always")
        converted = float16.convert_float_to_float16(
            onnx.ModelProto.FromString(model.SerializeToString()), min_positive_val=FP16_OPTIONS["minPositiveVal"],
            max_finite_val=FP16_OPTIONS["maxFiniteVal"], keep_io_types=True,
            op_block_list=op_blocks, node_block_list=node_blocks)
    seconds = time.perf_counter() - started
    graph = converted.graph
    initializers = {t.name: t for t in graph.initializer}
    restored = []
    for node in graph.node:
        if node.op_type != "Resize":
            continue
        for index in (1, 2):  # roi, scales (sizes, index 3, is int64)
            if index >= len(node.input) or not node.input[index]:
                continue
            name = node.input[index]
            current = initializers.get(name)
            if current is None or current.data_type != onnx.TensorProto.FLOAT16:
                continue
            source = original.get(name)
            if source is None or source.data_type != onnx.TensorProto.FLOAT:
                raise SystemExit(f"Resize {node.name} input {name}: no float32 original to restore")
            fixed = f"{name}__fp32"
            if fixed not in initializers:
                tensor = numpy_helper.from_array(numpy_helper.to_array(source).astype(np.float32), fixed)
                graph.initializer.append(tensor)
                initializers[fixed] = tensor
                restored.append({"initializer": name, "as": fixed, "slot": "roi" if index == 1 else "scales",
                                 "values": numpy_helper.to_array(source).astype(float).tolist()[:8]})
            node.input[index] = fixed
    used = {name for node in graph.node for name in node.input} | {o.name for o in graph.output}
    orphans = [t for t in graph.initializer if t.name not in used]
    for tensor in orphans:
        graph.initializer.remove(tensor)
    kept = {t.name for t in graph.initializer}
    for value in [v for v in graph.value_info if v.name in {o.name for o in orphans} and v.name not in kept]:
        graph.value_info.remove(value)
    messages = collections.Counter(str(r.message)[:160] for r in records)
    details = {**FP16_OPTIONS, "opBlockList": op_blocks, "nodeBlockList": node_blocks,
               "converter": f"onnxconverter-common {_version('onnxconverter-common')}",
               "seconds": round(seconds, 3), "restoredFp32Initializers": restored,
               "removedOrphanInitializers": [t.name for t in orphans], "weightClamping": clamp,
               "converterWarnings": sum(messages.values()),
               "converterWarningSamples": [f"{n}x {m}" for m, n in messages.most_common(5)]}
    return converted, details


def _version(name: str) -> str | None:
    from importlib import metadata
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _rss() -> int:
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)  # bytes on macOS


def run_job(args, work: Path, run: Path) -> int:
    """Child: one candidate/profile, all requested precisions."""
    candidate, profile = args.job.split(":")
    common.apply_scratch_env(work)
    common.limit_threads(args.threads)
    import numpy as np
    import onnx
    import torch

    import candidates
    import references

    job_dir = common.ensure_build_directory(run / "jobs" / candidate / profile)
    precisions = [p for p in common.PRECISIONS if p in args.precisions.split(",")]
    result = {"candidate": candidate, "profile": profile, "status": "running", "precisions": {}, "attempts": [],
              "rssBytes": {}, "startedAt": common.now_iso()}
    started = time.perf_counter()

    def save():
        result["seconds"] = round(time.perf_counter() - started, 3)
        common.write_json(job_dir / "job.json", result)

    try:
        shape = common.PROFILES[candidate][profile]
        meta = candidates.CANDIDATES[candidate]
        scale = meta["outputScale"]
        padded = shape["padded"]
        input_dims = [1, 3, padded[0], padded[1]]
        output_dims = [1, 3, padded[0] * scale, padded[1] * scale]
        cases = {}
        for case in CASES:
            directory = references.case_dir(work, candidate, profile, case)
            if not (directory / "meta.json").exists():
                raise SystemExit(f"missing reference case {directory} (run references.py first)")
            loaded_case = references.load_case(directory)
            loaded_case["directory"] = directory
            if loaded_case["meta"]["output"]["dims"] != output_dims:
                raise SystemExit(f"{directory}: output dims {loaded_case['meta']['output']['dims']} != {output_dims}")
            cases[case] = loaded_case
        result["references"] = {case: {"path": common.repo_relative(c["directory"]),
                                       "outSha256": c["meta"]["output"]["sha256"],
                                       "inputSha256F32": [i["sha256F32"] for i in c["meta"]["inputs"]]}
                                for case, c in cases.items()}
        t0 = time.perf_counter()
        loaded = candidates.load(candidate, work)
        result["loadSeconds"] = round(time.perf_counter() - t0, 3)
        result["model"] = loaded["info"]
        result["rssBytes"]["afterLoad"] = _rss()
        module = loaded["export"]
        example = [torch.from_numpy(t.copy()) for t in cases["synthetic"]["inputs"]]
        chain = VARIANTS[candidate]
        if args.variants:
            wanted = args.variants.split(",")
            chain = [v for v in chain if v["id"] in wanted]
        chosen = best = None
        for variant in chain:
            attempt = {"variant": variant["id"], "description": variant["description"]}
            result["attempts"].append(attempt)
            attempt_dir = common.ensure_build_directory(job_dir / "attempts" / variant["id"])
            path = attempt_dir / "fp32.onnx"
            try:
                if candidate == "rife-4.25-lite":
                    attempt["gridCacheEntriesCleared"] = candidates.clear_rife_grid_cache(loaded)
                    if variant["warm"]:
                        with torch.no_grad():  # not inference_mode: cached grids must stay normal tensors
                            module(*example)
                        attempt["gridCacheEntriesAtExport"] = len(loaded["warplayer"].backwarp_tenGrid)
                with torch.no_grad():
                    attempt["export"] = export_variant(variant, module, example, meta["inputs"], path)
                result["rssBytes"][f"afterExport:{variant['id']}"] = _rss()
                model = onnx.load(str(path))
                report = graph_report(model)
                if not report["static"]["ok"] and report["checker"] == "ok":
                    attempt["staticBeforeOrtBasic"] = report["static"]
                    optimized = attempt_dir / "fp32.ort-basic.onnx"
                    ort_basic_optimize(path, optimized, args.threads)
                    path = optimized
                    model = onnx.load(str(path))
                    report = graph_report(model)
                    attempt["ortBasicOptimization"] = "applied (offline, ORT_ENABLE_BASIC, CPU)"
                attempt["graph"] = {k: report[k] for k in ("checker", "nodeCount", "opsetImport", "static")}
                attempt["webgpu"] = {"ok": report["webgpu"]["ok"], "problems": report["webgpu"]["problems"]}
                names_ok = ([i["name"] for i in report["inputs"]] == meta["inputs"]
                            and [o["name"] for o in report["outputs"]] == ["output"]
                            and all(i["dims"] == input_dims and i["type"] == "float32" for i in report["inputs"])
                            and report["outputs"][0]["dims"] == output_dims and report["outputs"][0]["type"] == "float32")
                attempt["ioContract"] = "ok" if names_ok else {"inputs": report["inputs"], "outputs": report["outputs"]}
                gate = gate_a(path, "fp32", cases, args.threads, attempt_dir)
                attempt["gateA"] = {k: gate.get(k) for k in ("maxAbs", "meanAbs", "pass", "status", "reason")}
                result["rssBytes"][f"afterGateA:{variant['id']}"] = _rss()
                ok = (report["checker"] == "ok" and report["static"]["ok"] and report["webgpu"]["ok"] and names_ok
                      and gate.get("pass") is True)
                attempt["ok"] = ok
                print(f"[{candidate} {profile}] {variant['id']}: nodes {report['nodeCount']}, checker {report['checker']}, "
                      f"static {report['static']['ok']}, webgpu {report['webgpu']['ok']}, gate A max "
                      f"{gate.get('maxAbs')} mean {gate.get('meanAbs')} pass {gate.get('pass')}", flush=True)
                if ok:
                    chosen = (variant, path, model, report, gate, attempt)
                    break
                if (report["checker"] == "ok" and report["static"]["ok"] and report["webgpu"]["ok"]
                        and names_ok and isinstance(gate.get("maxAbs"), float)) and (
                        best is None or gate["maxAbs"] < best[4]["maxAbs"]):
                    best = (variant, path, model, report, gate, attempt)
            except Exception as error:  # noqa: BLE001
                attempt["ok"] = False
                attempt["error"] = f"{type(error).__name__}: {str(error)[:1500]}"
                attempt["traceback"] = traceback.format_exc()[-2500:]
                print(f"[{candidate} {profile}] {variant['id']}: FAILED {attempt['error'][:300]}", flush=True)
        if chosen is None:
            if best is None:
                raise SystemExit("no export variant passed checker/static/WebGPU/I/O checks; attempts retained")
            chosen = best
            result["warning"] = "no variant passed gate A; retaining best valid/static graph for diagnostic B-F only"
        variant, fp32_path, fp32_model, fp32_report, fp32_gate, attempt = chosen
        result["variant"] = variant["id"]
        staged = {}
        environment = common.environment()
        scripts = [common.script_receipt(Path(__file__)), common.script_receipt(Path(candidates.__file__)),
                   common.script_receipt(Path(references.__file__)), common.script_receipt(Path(common.__file__))]
        exporter = {"function": "torch.onnx.export", "variant": variant["id"], "description": variant["description"],
                    "dynamo": variant["exporter"] == "dynamo", "opsetVersion": variant["opset"],
                    "torch": torch.__version__, "onnxscript": _version("onnxscript"), "onnx": onnx.__version__,
                    "ortBasicOptimization": attempt.get("ortBasicOptimization", "not applied")}
        base = {"candidate": candidate, "profile": profile, "variant": variant["id"], "attempts": result["attempts"],
                "exporter": exporter, "environment": environment, "scripts": scripts,
                "model": loaded["info"], "exportImplementation": loaded["exportImplementation"],
                "referenceImplementation": loaded["referenceImplementation"], "references": result["references"],
                "exportSeconds": attempt["export"]["seconds"]}
        if "fp32" in precisions:
            staged["fp32"] = (fp32_path, fp32_report, fp32_gate, None)
            result["precisions"]["fp32"] = {"gateA": _gate_summary(fp32_gate), "nodes": fp32_report["nodeCount"]}
        if "fp16" in precisions:
            try:
                fp16_model, fp16_details = convert_fp16(fp32_model)
                fp16_path = job_dir / "fp16.onnx"
                onnx.save(fp16_model, str(fp16_path))
                result["rssBytes"]["afterFp16Convert"] = _rss()
                fp16_report = graph_report(onnx.load(str(fp16_path)))
                fp16_gate = gate_a(fp16_path, "fp16", cases, args.threads, job_dir)
                result["rssBytes"]["afterGateA:fp16"] = _rss()
                fp16_io_ok = (fp16_report["inputs"] == fp32_report["inputs"]
                              and fp16_report["outputs"] == fp32_report["outputs"])
                fp16_graph_ok = (fp16_report["checker"] == "ok" and fp16_report["static"]["ok"]
                                 and fp16_report["webgpu"]["ok"] and fp16_io_ok)
                if fp16_graph_ok:
                    staged["fp16"] = (fp16_path, fp16_report, fp16_gate, fp16_details)
                result["precisions"]["fp16"] = {"gateA": _gate_summary(fp16_gate), "nodes": fp16_report["nodeCount"],
                                                "checker": fp16_report["checker"], "static": fp16_report["static"]["ok"],
                                                "webgpu": fp16_report["webgpu"]["ok"], "ioContract": fp16_io_ok}
                print(f"[{candidate} {profile}] fp16: nodes {fp16_report['nodeCount']}, checker {fp16_report['checker']}, "
                      f"static {fp16_report['static']['ok']}, webgpu {fp16_report['webgpu']['ok']}, gate A "
                      f"{_gate_summary(fp16_gate)}", flush=True)
            except Exception as error:  # noqa: BLE001
                result["precisions"]["fp16"] = {"error": f"{type(error).__name__}: {str(error)[:1500]}",
                                                "traceback": traceback.format_exc()[-2500:]}
                print(f"[{candidate} {profile}] fp16 FAILED {error}", flush=True)
        result["rssBytes"]["peak"] = _rss()
        install(work, run, candidate, profile, staged, base, args)
        result["installed"] = sorted(staged)
        failed = [p for p in precisions if p not in staged]
        result["status"] = "ok" if not failed and all(s[2].get("pass") for s in staged.values()) else "issues"
        save()
        return 0 if result["status"] == "ok" else 1
    except BaseException as error:  # noqa: BLE001
        result["status"] = "failed"
        result["error"] = f"{type(error).__name__}: {str(error)[:1500]}"
        result["traceback"] = traceback.format_exc()[-3000:]
        save()
        print(f"[{candidate} {profile}] job FAILED: {result['error']}", flush=True)
        return 1


def _gate_summary(gate: dict) -> dict:
    if gate.get("status") == "not-runnable":
        return {"status": "not-runnable", "reason": gate.get("reason")}
    return {"maxAbs": gate["maxAbs"], "meanAbs": gate["meanAbs"], "pass": gate["pass"],
            "cases": {c: {"maxAbs": v["maxAbs"], "meanAbs": v["meanAbs"], "psnr": v["psnr"]} for c, v in gate["cases"].items()}}


def install(work: Path, run: Path, candidate: str, profile: str, staged: dict, base: dict, args) -> None:
    """Write the receipts and move the staged graphs into <work>/models (old files -> superseded)."""
    target = common.ensure_build_directory(Path(work) / "models" / candidate / profile)
    superseded = None
    for precision, (path, report, gate, fp16) in staged.items():
        destination = target / f"{precision}.onnx"
        receipt_path = target / f"{precision}.receipt.json"
        for old in (destination, receipt_path):
            if old.exists():
                if superseded is None:
                    superseded = common.ensure_build_directory(Path(work) / "models" / "superseded" / run.name / candidate / profile)
                shutil.move(str(old), str(superseded / old.name))
        data = Path(path).read_bytes()
        gate_record = gate if gate.get("status") == "not-runnable" else {
            "maxAbs": gate["maxAbs"], "meanAbs": gate["meanAbs"], "pass": gate["pass"], "runtime": gate["runtime"],
            "input": gate["input"], **{k: gate[k] for k in ("worstCase", "limits", "comparison", "sessionOptions",
                                                           "sessionCreateSeconds", "seconds", "cases", "ortDisableAll")}}
        receipt = {
            "schema": 1, "candidate": candidate, "profile": profile, "precision": precision,
            "file": f"{precision}.onnx", "path": common.repo_relative(destination),
            "sha256": common.sha256_bytes(data), "bytes": len(data),
            "opset": report["opsetImport"].get("ai.onnx"), "irVersion": report["irVersion"],
            "exporter": f"torch.onnx.export {'dynamo' if base['exporter']['dynamo'] else 'TorchScript'} opset "
                        f"{base['exporter']['opsetVersion']} (torch {base['exporter']['torch']}, onnxscript "
                        f"{base['exporter']['onnxscript']}, onnx {base['exporter']['onnx']}), variant {base['variant']}"
                        + (", fp16 by onnxconverter-common" if precision == "fp16" else ""),
            "nodeCount": report["nodeCount"], "opHistogram": report["opHistogram"],
            "initializerBytes": report["initializerBytes"], "inputs": report["inputs"], "outputs": report["outputs"],
            "gateA": gate_record,
            "status": "pass" if gate.get("pass") is True else (
                "gate-A-not-runnable" if gate.get("status") == "not-runnable" else "failed-gate-A"),
        }
        if fp16 is not None:
            receipt["fp16"] = {"opBlockList": fp16["opBlockList"], "keepIoTypes": True, **fp16}
        receipt.update({
            "command": args.recorded_command, "environment": {
                "python": base["environment"]["python"], "packages": base["environment"]["packages"],
                "lockSha256": base["environment"]["lock"]["sha256"],
                "lockMatchesInstalled": base["environment"]["lock"]["matchesInstalled"],
                "platform": base["environment"]["platform"], "cpu": base["environment"]["cpu"],
                "research": base["environment"]["research"]},
            "script": base["scripts"][0], "modules": base["scripts"][1:],
            "createdAt": common.now_iso(),
            "graph": {k: report[k] for k in ("checker", "opsetImport", "producer", "initializerCount", "initializerTypes",
                                             "constantNodeBytes", "functions", "static", "attributes")},
            "webgpuStaticCheck": report["webgpu"],
            "exportVariant": {"id": base["variant"], "exporter": base["exporter"], "attempts": base["attempts"]},
            "exportSeconds": base["exportSeconds"],
            "model": base["model"], "exportImplementation": base["exportImplementation"],
            "referenceImplementation": base["referenceImplementation"], "references": base["references"],
            "run": common.repo_relative(run),
        })
        common.write_bytes(destination, data)
        common.write_json(receipt_path, receipt)


def write_index(work: Path) -> Path:
    models = Path(work) / "models"
    entries = []
    for receipt_path in sorted(models.glob("*/*/*.receipt.json")):
        if receipt_path.parts[-4] == "superseded" or "superseded" in receipt_path.relative_to(models).parts:
            continue
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        gate = receipt["gateA"]
        entries.append({"candidate": receipt["candidate"], "profile": receipt["profile"], "precision": receipt["precision"],
                        "path": receipt["path"], "sha256": receipt["sha256"], "bytes": receipt["bytes"],
                        "nodeCount": receipt["nodeCount"], "variant": receipt["exportVariant"]["id"],
                        "gateA": ({"status": gate["status"]} if gate.get("status") else
                                  {"maxAbs": gate["maxAbs"], "meanAbs": gate["meanAbs"], "pass": gate["pass"]}),
                        "createdAt": receipt["createdAt"]})
    index = models / "index.json"
    common.write_json(index, {"schema": 1, "updatedAt": common.now_iso(), "models": entries})
    return index


def memory_pressure() -> str | None:
    try:
        return subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], check=True,
                              capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def wait_for_normal_pressure(limit_seconds: int = 60) -> str | None:
    deadline = time.monotonic() + limit_seconds
    level = memory_pressure()
    while level not in ("1", None) and time.monotonic() < deadline:
        print(f"memory pressure level {level}; waiting", flush=True)
        time.sleep(30)
        level = memory_pressure()
    return level


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", help="work folder (default build/benchmarks/ai-framegen-upscale/work)")
    parser.add_argument("--candidates", default=",".join(common.PROFILES))
    parser.add_argument("--profiles", default="small,720p,1080p,540p")
    parser.add_argument("--precisions", default=",".join(common.PRECISIONS))
    parser.add_argument("--variants", help="restrict the fallback chain to these variant ids (diagnostics)")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--job", help=argparse.SUPPRESS)
    parser.add_argument("--run", help=argparse.SUPPRESS)
    parser.add_argument("--recorded-command", help=argparse.SUPPRESS)
    args = parser.parse_args()
    work = common.work_dir(args.work)
    for name in args.precisions.split(","):
        if name not in common.PRECISIONS:
            raise SystemExit(f"unknown precision {name}")
    if args.job:
        run = common.ensure_build_directory(Path(args.run))
        return run_job(args, work, run)

    wanted_candidates = [c for c in args.candidates.split(",") if c]
    wanted_profiles = [p for p in args.profiles.split(",") if p]
    if args.threads < 1 or args.threads > 4:
        raise SystemExit("--threads must be between 1 and 4 on this shared machine")
    for c in wanted_candidates:
        if c not in common.PROFILES:
            raise SystemExit(f"unknown candidate {c}")
    jobs = [(c, p) for c, p in common.ORDER if c in wanted_candidates and p in wanted_profiles]
    unknown = set(wanted_profiles) - {p for profiles in common.PROFILES.values() for p in profiles}
    if unknown or not jobs:
        raise SystemExit(f"unknown or empty profile selection: {wanted_profiles}")
    run = common.new_output_directory("export")
    logs = common.ensure_build_directory(run / "logs")
    command = common.python_command(Path(__file__), *sys.argv[1:])
    summary = {"schema": 1, "kind": "export", "createdAt": common.now_iso(), "command": command,
               "script": common.script_receipt(Path(__file__)), "environment": common.environment(),
               "threads": args.threads, "niceness": os.nice(0), "jobs": []}
    print(f"run folder {common.repo_relative(run)}", flush=True)
    for candidate, profile in jobs:
        level = wait_for_normal_pressure()
        if level != "1":
            summary["jobs"].append({"candidate": candidate, "profile": profile, "exitCode": 1,
                                    "status": "not-run", "memoryPressureBefore": level,
                                    "error": "normal memory pressure could not be confirmed within 60 s"})
            common.write_json(run / "results" / "export.json", summary)
            continue
        child = [sys.executable, "-I", "-B", "-X", f"pycache_prefix={work / 'cache' / 'pycache'}", str(Path(__file__).resolve()),
                 f"--work={work}", f"--job={candidate}:{profile}", f"--run={run}", f"--precisions={args.precisions}",
                 f"--threads={args.threads}", f"--recorded-command={command}"]
        if args.variants:
            child.append(f"--variants={args.variants}")
        env = common.child_env(work)
        for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
            env[key] = str(args.threads)
        log_path = logs / f"{candidate}-{profile}.log"
        print(f"== {candidate} {profile} (memory pressure level {level})", flush=True)
        started = time.perf_counter()
        with open(log_path, "w", encoding="utf-8") as log:
            process = subprocess.Popen(child, env=env, cwd=str(common.ensure_build_directory(run / "jobs")),
                                       stdout=log, stderr=subprocess.STDOUT)
            _, status, usage = os.wait4(process.pid, 0)
            process.returncode = os.waitstatus_to_exitcode(status)
        wall = time.perf_counter() - started
        job_path = run / "jobs" / candidate / profile / "job.json"
        job = json.loads(job_path.read_text(encoding="utf-8")) if job_path.exists() else {"status": "no job.json"}
        record = {"candidate": candidate, "profile": profile, "exitCode": process.returncode, "status": job.get("status"),
                  "variant": job.get("variant"), "wallSeconds": round(wall, 3), "peakRssBytes": int(usage.ru_maxrss),
                  "userSeconds": round(usage.ru_utime, 2), "systemSeconds": round(usage.ru_stime, 2),
                  "memoryPressureBefore": level, "precisions": job.get("precisions"), "error": job.get("error"),
                  "job": common.repo_relative(job_path), "log": common.repo_relative(log_path)}
        summary["jobs"].append(record)
        job["wallSeconds"] = record["wallSeconds"]
        job["peakRssBytes"] = record["peakRssBytes"]
        if job_path.exists():
            common.write_json(job_path, job)
        for precision in ("fp32", "fp16"):
            receipt_path = Path(work) / "models" / candidate / profile / f"{precision}.receipt.json"
            if receipt_path.exists() and precision in (job.get("installed") or []):
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if receipt.get("run") == common.repo_relative(run):
                    receipt["job"] = {"wallSeconds": record["wallSeconds"], "peakRssBytes": record["peakRssBytes"],
                                      "note": "whole child process (both precisions, gate A included); wait4 ru_maxrss",
                                      "stageRssBytes": job.get("rssBytes")}
                    common.write_json(receipt_path, receipt)
        print(f"   {job.get('status')} exit {process.returncode} variant {job.get('variant')} "
              f"{wall:.1f} s, peak RSS {usage.ru_maxrss / 2**30:.2f} GiB", flush=True)
        for precision, value in (job.get("precisions") or {}).items():
            print(f"   {precision}: {json.dumps(value.get('gateA', value))[:400]}", flush=True)
        common.write_json(run / "results" / "export.json", summary)
    index = write_index(work)
    summary["index"] = common.repo_relative(index)
    summary["finishedAt"] = common.now_iso()
    common.write_json(run / "results" / "export.json", summary)
    print(f"summary {common.repo_relative(run / 'results' / 'export.json')}", flush=True)
    return 0 if all(j["exitCode"] == 0 for j in summary["jobs"]) else 1


if __name__ == "__main__":
    sys.exit(main())
