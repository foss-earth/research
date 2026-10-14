# RIFE and RT4KSR on ONNX Runtime Web: established facts

Recorded **2026-10-13** while building Stage 1 of the
[AI upscaling and frame generation proposal](proposals/ai-framegen-upscale.md): the
export and replay harness in `scripts/benchmarks/ai-framegen-upscale/`. Each fact
below was checked by running code against the pinned files or by reading the
pinned sources. Source readings not yet confirmed in a browser are labelled as such.
Benchmark results and candidate recommendations belong in
`benchmarks/ai-framegen-upscale/`; runtime findings below cite that evidence.

## Pinned sources

| Item | Pin | Terms |
| --- | --- | --- |
| Practical-RIFE code | [hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE) commit `bbfd2ea90910789a860ea3e2b32a240cd577b75e` (2026-08-27) | MIT |
| RIFE 4.25.lite model code and weights | `RIFEv4.25lite_1018.zip`, 22,765,148 B, sha256 `e84366c23e0eb1a637a55aad2e4f3442ec2bf4c388043b4aabbf590be289e6e8`, Google Drive id `1zlKblGuKNatulJNFf5jdB-emp9AqGK05` (README line 19 of the pinned commit) | The README says the linked content is under the project's MIT license |
| RT4KSR code and weights | [eduardzamfir/RT4KSR](https://github.com/eduardzamfir/RT4KSR) commit `fd6627a48d789adf5d9aad29f02ab2a3d2a25296` (2023-08-08); `rt4ksr_x2.pth`, 1,699,164 B, sha256 `9ec7500092848a480e058a9c703e4b2254bc0cc97928c076bba272177752124f` (in the repository since commit `f8b80dd`, 2023-04-20) | Apache-2.0 (LICENSE added 2023-08-08) |
| ONNX Runtime Web | `onnxruntime-web` 1.30.0, integrity `sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==`; source tag v1.30.0 = `f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7` | MIT |

The RIFE archive ships a stale `__pycache__` and a `__MACOSX` folder; extract without
them and run anything that imports the upstream code with `python -I -B`. Both
upstream repositories use a top-level package named `model`, so code that loads both
must isolate their imports. On this Mac's case-insensitive APFS, `sources/rt4ksr`
and `sources/RT4KSR` are the same folder; name sibling folders so they differ by
more than case.

## RIFE 4.25.lite: input contract and export

- The network is IFNet with 5,622,700 parameters. The checkpoint also holds
  `caltime` and `teacher` entries (40 keys) that IFNet does not use, so it loads
  with `strict=False`; the loaded weights were checked against the official path.
- The official midpoint is `flownet(cat(img0, img1), timestep=0.5, scale_list)`,
  taking the last merged output, with `scale_list = [32, 16, 8, 4, 1]` at scale 1.0.
  A wrapper with fixed inputs matches the official `Model.inference` bitwise.
- Inputs are RGB with no channel flip (`inference_video.py:205`), `u8 / 255` as
  float32, NCHW, zero-padded right and bottom to multiples of 128
  (`inference_video.py:193-196`); the output is cropped from the top left. Padding is
  required: unpadded 192 × 192 and 320 × 320 inputs fail at scale 1.0.
  Fixed shapes used: 256², 960 × 540 padded to 1024 × 640, 1280 × 720 padded to
  1280 × 768, and 1920 × 1080 padded to 1920 × 1152.
- **Export at opset 16 to 19.** ONNX Runtime's native WebGPU execution provider
  registers GridSample only for opsets 16–19
  (`onnxruntime/core/providers/webgpu/webgpu_execution_provider.cc:435`), NCHW only.
  A graph exported at opset 20 would put GridSample on the CPU. The torch dynamo
  exporter at opset 17 gives a 363-node, 23,088,268-byte graph at 256²; on ORT CPU
  it differs from PyTorch by at most 5.14e-4 (mean 1.31e-6). The TorchScript exporter at
  opset 17 also works. A variant with the backward-warp grids baked in as constants
  differs by at most 5.3e-5 but is 9.4 MB larger.
- Outputs of the reference cases stayed within [0, 1].

## RT4KSR x2: inference form and export

- Configuration `rt4ksr_rep`: 24 feature channels, 4 blocks, GELU, ×2,
  `rgb_range` 1.0. The training form loads strictly through `DataParallel`
  (152,233 parameters).
- The upstream `reparameterize` mutates the model in place and calls `.cuda()`, and
  the upstream inference model keeps a dead high-frequency (Gaussian blur) branch
  that breaks the dynamo exporter. A clean reparameterization from the training
  state dict, into PixelUnshuffle(2) → head → body → tail → PixelShuffle with a plain
  LayerNorm2d, gives 39,312 parameters (the upstream reparameterized form has
  44,521) and matches the training form within 3.3e-6 to 4.5e-6.
- Dynamo export at opset 20 gives 60 nodes and 247,910 bytes with a native Gelu op;
  TorchScript at opset 17 (Gelu as Erf) is the fallback. ORT CPU parity is about 6e-6.
- **Clamp the output.** It exceeds [0, 1] on real content, for example −0.30 to 1.37
  on a 1080p natural crop.

## Half precision

- Convert with `onnxconverter_common.float16.convert_float_to_float16(model,
  keep_io_types=True)` so that inputs and outputs stay float32 for both precisions.
- In the v1.30.0 sources, every op in these graphs has a float16 kernel in the native
  WebGPU provider (Add, Sub, Mul, Div, Pow, Conv, ConvTranspose, DepthToSpace, Slice,
  GridSample 16–19, LeakyRelu, Sigmoid, Sqrt, Erf, Gelu, Resize, Transpose,
  ReduceMean, Concat, Reshape, Cast). No op has to stay in float32 for want of a kernel.
- onnxconverter-common 1.16.0's default op block list keeps Resize in float32, which
  adds 45 Cast nodes to the RIFE graph. With an empty block list it converts Resize's
  float-only `scales` initializer to float16, and the graph becomes invalid; the
  `roi` and `scales` initializers have to be restored to float32.
- ORT 1.23.2 on the CPU ran the trial float16 graphs, so CPU parity can be measured
  for both precisions. One RT4KSR replay check gave
  38.7644 dB in float16 against 38.7646 dB in float32.

## Reference tensors in the browser

`float32(v) / float32(255)` in NumPy equals `Math.fround(v / 255)` in JavaScript for
all 256 byte values. A page can therefore rebuild the exact model input from 8-bit
RGBA and check it against a hash computed in Python, instead of transferring float
tensors.

## ONNX Runtime Web 1.30.0 and its native WebGPU provider

- `dist/ort.webgpu.min.mjs` (66,349 B) loads `ort-wasm-simd-threaded.asyncify.mjs`
  (53,057 B) and `.asyncify.wasm` (26,781,914 B): the C++ WebGPU provider compiled to
  WebAssembly. The JavaScript provider (JSEP) path is compiled out of this bundle
  (`dist/ort.webgpu.mjs`, module selection near line 1499).
- An application-owned `GPUDevice` is passed as the provider option
  `{ name: "webgpu", device }`; ORT registers it with `webgpuRegisterDevice` and passes
  the device id and handles as provider options (`dist/ort.webgpu.mjs` near line 2033).
- *Source reading, not yet confirmed at runtime:* `ort.env.webgpu.device` is assigned
  only for the default device (id 0), and injected devices get ids from 1, so
  that property cannot prove that ORT uses an injected device. Prove it instead with a
  pass that consumes ORT's output buffer without validation errors.
- When ORT creates its own device it requests every one of these features that the
  adapter has: `chromium-experimental-subgroup-matrix`, `timestamp-query`,
  `shader-f16`, `subgroups` and `subgroup-size-control`. It also raises limits to the
  adapter maxima: bind groups, workgroup storage size, workgroups per dimension,
  storage buffers per stage, storage buffer binding size, buffer size, invocations per
  workgroup, and workgroup size X/Y/Z (`webgpu_context.cc:791-836`). An injected device
  should request the same features and limits, or kernels lose those paths (float16
  needs `shader-f16`).
- Node placement appears in ORT's own log at verbose severity
  (`onnxruntime/core/framework/session_state.cc`, near line 1377): `Node placements`,
  then ` All nodes placed on [<provider>]. Number of nodes: <n>` or one
  ` Node(s) placed on [<provider>]. Number of nodes: <n>` line per provider, followed
  by the nodes. A fallback also logs a WARNING beginning `Some nodes were not assigned to
  the preferred execution providers`. Set `ort.env.logLevel = "verbose"` and session
  `logSeverityLevel: 0` to see them; no parseable statement means placement is unverified.
- ORT submits its command buffer after every 16 dispatches (`max_num_pending_dispatches`,
  `webgpu_context.h:150`) and at the end of a run. A GPU timestamp span around
  `session.run` therefore includes GPU idle time while the CPU encodes, and is an upper
  bound on the model's GPU time.
- *Source reading, not yet confirmed at runtime:* the WebAssembly glue has no file
  system, so session profiling (`enableProfiling` / `endProfiling`) cannot produce a
  kernel profile that JavaScript can read.

## Headless Chrome and WebGPU on this machine

Chrome 155.0.8059.40, headless, Apple M5 (Metal), 2026-10-12:

- By default WebGPU timestamp queries are quantized to 65,536 ns: every measured
  offset and duration was a multiple of it, and short passes read 0 or 65,536 ns. With
  `--enable-unsafe-webgpu` the granularity was 1 ns, and a pass that read 0 to 65,536 ns
  measured about 6 µs. Adding `--enable-webgpu-developer-features` also fills in the
  adapter description, driver and backend (`Apple M5`, Metal); without it they are empty.
- WebGPU needs a secure context. Serving the page through CDP `Fetch` interception
  at an `https://` origin, with COOP/COEP headers, provides one. The same isolation
  stops Chrome rounding `performance.now()` to 100 µs.
- Each CDP command in `scripts/lib/headlessChrome.mjs` has a 15-second timeout, so page
  work longer than that has to start a job and be polled.
- The `requestAnimationFrame` interval median was 16.665 ms (60 Hz), so the browser
  cannot present 120 Hz frame generation here. A 60 → 120 budget has to be computed
  from measured stage costs with a 16.67 ms source interval.

## What existing evidence says about the render being saved

Frame generation and upscaling pay off only when they replace render work that costs
more than inference. For the panorama viewer that work is small: the
[spherical image representation benchmark](../benchmarks/spherical-image-representation/REPORT.md)
measured 0.4 to 0.8 ms of GPU time per whole 1080 × 2400 frame for every
representation on this machine (WebGPU within 0.07 ms of WebGL 2). There is no usable
GPU frame time for the globe: the only [globe comparison run](../benchmarks/globe-compare/results.json)
is marked discarded because the machine was in use.

## Early quality observations (development run, not the acceptance screen)

On 2026-10-13 the replay screen ran on the research-phase trial exports: RT4KSR at the
720p and 1080p input sizes, and RIFE at a fixed 256 × 256 on centred crops. The
sequences were the six camera paths rendered from the corpus panoramas. These are
development results; the acceptance screen runs on the final exports.

- **Whether RT4KSR beats bicubic depends on how the low-resolution frame was made.**
  Median PSNR of RT4KSR minus bicubic at 720p, in dB, for the same native frames:

  | Sequence | Rendered directly at half size | Box-downsampled (PIL `reduce(2)`) | Bicubic-downsampled, antialiased |
  | --- | ---: | ---: | ---: |
  | cut | −0.27 | +0.31 | +1.43 |
  | diagonal | +0.93 | +1.65 | +3.03 |
  | inertia | −0.36 | +0.22 | +1.32 |
  | pan-fast | −0.24 | +0.32 | +1.24 |
  | pan-slow | −0.24 | +0.31 | +1.33 |
  | zoom | +0.24 | +0.78 | +1.94 |

  An application that renders at reduced resolution produces the first column: point
  samples at the native pixel centres, more aliased than a downsample. On those frames
  the model loses to bicubic in four of six sequences, although its SSIM beats both
  bilinear and bicubic everywhere and its temporal flicker stays within 3.4 % of bicubic's.
- **RIFE midpoints beat repeating or blending frames by a wide margin on continuous
  motion,** for example at 720p from 30 to 60 fps 31.4 dB against 15.8 dB (repeat) and
  18.1 dB (blend), and from 60 to 120 fps 36.3 dB against 18.1 and 20.0 dB. **Across a
  scene cut it is worse than blending** (11.4 against 13.8 dB), so cuts must bypass it.

## Final graph checks on the native WebGPU build

The final Stage 1 screen on 2026-10-13 ran all 14 exported graph/profile/precision
combinations and both stored reference cases. These runtime findings are distinct
from the development quality observations above. The
[benchmark report](../benchmarks/ai-framegen-upscale/REPORT.md) and
[registered parity evidence](../benchmarks/ai-framegen-upscale/results/parity-summary.json)
retain the individual gate values and source hashes.

- The injected-device path is now confirmed at runtime. ORT requests the pinned
  native asyncify glue/WASM and reports version 1.30.0; no JSEP file is requested.
  Only one adapter/device is requested, actual GPU input-buffer readbacks reproduce
  the Python padded float32 hashes, and ORT's preallocated output buffer is consumed
  by harness WGSL on that device with validation/out-of-memory/internal scopes,
  uncaptured errors and device-loss checks clear. `ort.env.webgpu.device` remains
  undefined for this custom-device path, so it is not the injection proof.
- ORT's placement logs assign zero graph nodes to CPU at all tested shapes and
  precisions. That establishes placement, not numerical parity: the final RIFE
  fp32 GPU graph differs severely from its reference even at 256² (synthetic max
  0.68420, mean 0.049974, 22.171 dB; natural max 0.78458, mean 0.092190, 17.168 dB).
  An independent run of the same hashed graph on ORT CPU still matches the stored
  reference (max 0.00051445/0.00014615). Exact input/upload hashes and 8-bit
  conversion self-tests pass. This evidence does not identify an erroneous kernel.
- A separate unchanged-small-RIFE diagnostic produces exactly the same B/C values
  with graph optimization disabled and with `all`. Placement changes from 320 to
  336 native nodes, showing that the option took effect, but it does not repair the
  output. The inference is limited to that optimization-level comparison; it does
  not locate the faulty operation. See the
  [optimizer diagnostic](../benchmarks/ai-framegen-upscale/results/optimizer-diagnostic.json)
  and [report's parity analysis](../benchmarks/ai-framegen-upscale/REPORT.md#export-and-device-parity).
- RT4KSR fp32 does establish numerical parity on small, 720p and 1080p: max absolute
  GPU error ≤ 4.30e-6, mean ≤ 5.4e-7, PSNR ≥ 123.36 dB, 100% of output RGB codes
  within one code. The fp16 graph passes CPU export parity, but GPU 8-bit parity
  fails at every profile (only 73.03–79.00% within one code versus the registered
  98% requirement). The 1080p synthetic fp16 case also exceeds device mean-error
  tolerance (0.00414621 versus 0.004). A half-precision kernel being available
  therefore does not establish that this precision is usable.
- Explicit `enableGraphCapture:true` on the same final RT4KSR fp32 graphs preserves
  both-case B/C/D/E, input/upload hashes and preallocated output identity at all
  three shapes; values match normal execution. This permits a separately labelled
  captured-session cost experiment on those exact hashes. It does not establish
  cost, deadline or physical-presentation qualification. See
  [capture parity evidence](../benchmarks/ai-framegen-upscale/results/capture-parity.json).
- Incremental live GPU allocation accounting includes ORT pools and steady
  reconstruction resources. Large RIFE profiles exceed 256 MiB in both precisions
  (for example 720p: 780.58/429.07 MiB); RT4KSR remains below the limit (1080p:
  130.72/113.14 MiB). Graph file size is not a memory bound. Detailed allocation
  numbers and exclusions are in the
  [report's memory screen](../benchmarks/ai-framegen-upscale/REPORT.md#accounted-memory).

## Full-frame replay quality on the final graphs

The completed final screen (2026-10-13, `quality/2026-10-13_014220`) measured all
six sequences for RIFE at 720p, 1080p and 540p and for RT4KSR at 720p and 1080p,
fp32 and supplementary fp16. An independent CSV recomputation agreed with the
stored verdicts. The
[720p checkpoint](../benchmarks/ai-framegen-upscale/results/quality-720p-checkpoint.json)
is the earlier provenance for that one RIFE profile. The
[benchmark report](../benchmarks/ai-framegen-upscale/REPORT.md) has the recommendation.

- RIFE fp32 CPU H passes at every screened profile and both frame-rate regimes.
  Pooled 720p PSNR is 29.9566 dB (30→60) and 32.4017 dB (60→120), against repeat
  15.9186/17.9246 and blend 17.9948/19.8712. 1080p and 540p also beat both
  controls. 1080p's export still fails gate A, and every RIFE GPU result still
  fails B and C, so the CPU pass does not admit a profile. fp16 is supplementary
  and fails A.
- RT4KSR fp32 does not beat bicubic on directly rendered half-resolution frames.
  At 720p, pooled model PSNR is 28.028 dB versus bicubic 28.376 dB; four sequences
  fail. At 1080p the pool passes, and pan-fast does not (29.521 versus 29.667 dB).
  SSIM beats bilinear and bicubic, and flicker stays within 1.10× bicubic. This
  matches the development observation that a reduced-resolution render, rather
  than an antialiased downsample, is the case the model loses. fp16 fails the
  same sequences. Small was not in this full-frame screen.
- Contact sheets received agent inspection only. Human review remains open and
  is outside Stage 2 admission.

## Captured cost screen

On the same day, captured-session timing of the final RT4KSR fp32 small, 720p and
1080p graphs ran for the registered 120 s bound with Low Power Mode on. The GPU
timer validated and no kernel lower bound was available. Idle device utilization
before the blocks stayed above the 10% limit (medians about 49–53%), so no round
qualified and gate G was not evaluated. No cost bound is relied on. RIFE was not
timed because device parity fails. RT4KSR fp16 was not timed because 8-bit capture
parity fails. Globe `R_native` remains unknown, so an SR cost screen would be
"no evidence" even with qualified stage times. Sustained runs were not started.
