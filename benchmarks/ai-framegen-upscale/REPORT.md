# RIFE and RT4KSR: Stage 1 and Stage 2 screen

Recorded 2026-10-13 on this Apple M5 Mac, 16 GiB, headless Chrome 155.0.8059.40, Metal,
ONNX Runtime Web 1.30.0 native WebGPU provider. Stage 1 covers every registered fixed shape
and both precisions. The final quality screen completed at 03:35 CDT. Captured RT4KSR fp32
timing ran at 03:38–03:44 CDT with Low Power Mode on. No renderer or application profile
is admitted.

**RIFE stops.** GPU output fails device parity at every shape and precision (B and C).
720p, 1080p and 540p also exceed the 256 MiB memory limit (F). 1080p also fails export
parity (A). CPU replay quality passes and does not repair those gates. No gate G bound
was measured or relied on.

**RT4KSR fp16 stops on capture parity (C)** at small, 720p and 1080p. The 1080p synthetic
case also fails device mean error (B).

**RT4KSR fp32 stops.** It passes A–F at small, 720p and 1080p, including captured-session
parity. Full-frame H fails at 720p and 1080p against bicubic on directly rendered
half-resolution frames. The small shape has no full-frame H screen. Captured timing
produced no accepted round, so G is not evaluated and no cost bound is relied on.

The [manifests](README.md) pin source/weight/export provenance and graph contracts.
[tables.md](tables.md) records individual cases, precisions and gates.
Selected [parity](results/parity-summary.json), [exports](results/export-summary.json),
[cold starts](results/cold-loads.json), [quality](results/quality-summary.json),
[timing](results/timing-summary.json) and [provenance](results/provenance.json) preserve the
numbers and source hashes. Raw run folders remain in `build/benchmarks/ai-framegen-upscale/`.

## Export and device parity

Fourteen fixed ONNX graphs and fourteen PyTorch fp32 reference cases were prepared and
verified. Small shapes ran first, followed by 720p, 1080p and RIFE's 540p combined-screen shape.
Every installed graph has fixed float32 I/O and passes ONNX checking, static-shape and native
operator-registration checks. Failed numerical exports retain explicit failed-A status.

| Candidate/profile | Final fp32 exporter | A max / mean absolute error | fp32 A | fp16 A |
| --- | --- | --- | --- | --- |
| RIFE small | dynamo 17, basic constant fold | 0.00051445 / 0.00000144 | pass | fail |
| RIFE 720p | TorchScript 17, basic constant fold | 0.00086862 / 0.00000387 | pass | fail |
| RIFE 1080p | dynamo 17, cached grids | 0.00177777 / 0.00000296 | fail | fail |
| RIFE 540p | TorchScript 17, basic constant fold | 0.00047165 / 0.00000253 | pass | fail |
| RT4KSR small/720p/1080p | clean dynamo 20 | max ≤ 0.00000364; mean ≤ 0.00000051 | pass | pass |

RIFE's primary 720p graph narrowly failed A, so the declared TorchScript fallback was used.
At 1080p all three declared variants failed A: max error 0.00210959 (primary), 0.00272793
(TorchScript) and 0.00177777 (cached grids), above 0.001. All-half conversion with float32
I/O fails A at every RIFE profile (max 0.388–0.679, mean 0.0042–0.0122). Small diagnostic
conversions retaining Resize, then GridSample, then grid arithmetic in float32 did not repair
that failure and were not adopted. RT4KSR fp16 export errors stayed below max 0.00277 and
mean 0.000399, within A's max 0.05 and mean 0.002 limits.

Actual WebGPU execution distinguishes operator availability from correctness. RIFE fp32 B
max errors were 0.684–0.961, means 0.039–0.068 except the small natural case at 0.092, and
PSNR 17.17–22.81 dB. These exceed B's max 0.02/mean 0.001 limits and miss its 50 dB floor.
Only 9.63–32.43% of RGB values were within one 8-bit code, against C's 99.5% requirement;
max code error reached 245, against 8. RIFE fp16 likewise fails B/C.

An independent CPU recheck of the final small RIFE graph reproduced both stored references
(synthetic max 0.00051445; natural max 0.00014615; 100% of codes within one). Browser input
buffer readbacks match the stored padded float32 hashes, and WGSL pack/unpack self-tests are
exact in 8-bit codes. The GPU discrepancy therefore remains a native runtime/model execution
problem to investigate; this screen does not identify the faulty operator.
Disabling browser graph optimization on the unchanged small graph yields exactly the same
B/C values as `all`, despite placement changing from 320 to 336 native nodes. That diagnostic
does not resolve the discrepancy or identify its cause. The unchanged graph, option and
numeric records are retained in [optimizer-diagnostic.json](results/optimizer-diagnostic.json).

RT4KSR fp32 B passes at every size: max ≤ 0.00000430, mean ≤ 0.00000054, PSNR ≥ 123.36 dB;
C has 100% within one code and max one. Its fp16 C fails everywhere: only 73.03–79.00% within
one code versus 98%, despite max code errors of 6–8 staying below the separate limit of 16.
The 1080p synthetic fp16 B mean, 0.00414621, also exceeds 0.004; the other fp16 cases pass B.

ORT's own placement diagnostics assign zero graph nodes to CPU at every tested profile (D).
GPU-buffer input/output and same-device WGSL consumption pass all validation scopes (E).
The actual requested files are the pinned native asyncify bundle/glue/WASM, with no JSEP path.
A separate [capture-parity diagnostic](results/capture-parity.json) enables graph capture on
the final RT4KSR fp32 small/720p/1080p graphs. Both cases pass B/C/D/E with unchanged numerical
values, verified upload hashes and output-buffer identity. Captured-session timings can use
these exact graphs with explicit capture labels; the diagnostic itself supplies no G result.

## Accounted memory

F counts live GPU buffers, textures and query sets allocated after the baseline, including
ORT pools/weights/intermediates and steady reconstruction resources. Readback/self-test and
existing renderer resources are separate; dropped undestroyed objects remain counted.

| Candidate/profile | fp32 peak MiB | fp16 peak MiB | F (256 MiB) |
| --- | ---: | ---: | --- |
| RIFE small | 69.32 | 36.16 | pass |
| RIFE 720p | 780.58 | 429.07 | fail |
| RIFE 1080p | 2040.08 | 993.47 | fail |
| RIFE 540p | 791.81 | 379.72 | fail |
| RT4KSR small | 4.95 | 4.10 | pass |
| RT4KSR 720p | 66.25 | 57.91 | pass |
| RT4KSR 1080p | 130.72 | 113.14 | pass |

## Quality and full-path cost

The final screen is `build/benchmarks/ai-framegen-upscale/quality/2026-10-13_014220/results/quality.json`,
completed 2026-10-13T03:35:30-05:00. An independent recomputation from the rounded CSV
agreed with all 16 stored verdicts (96 sequence groups). fp32 rows are the gate. fp16 is
supplementary. The earlier
[720p checkpoint](results/quality-720p-checkpoint.json) remains the provenance for that
profile; it is not a substitute for this screen. Continuous FG compares midpoints with
rendered truth, repeat and blend. Cut-straddling pairs are excluded from H and reported
separately. SR compares directly rendered half-resolution frames with native output,
bilinear and bicubic, plus the flicker ratio.

CPU H passes for RIFE fp32 at 720p, 1080p and 540p in both regimes. Pooled PSNR:

| Profile | 30→60 model / repeat / blend | 60→120 model / repeat / blend | Export A |
| --- | --- | --- | --- |
| 720p | 29.957 / 15.919 / 17.995 | 32.402 / 17.925 / 19.871 | pass |
| 1080p | 30.923 / 15.769 / 17.836 | 35.234 / 17.668 / 19.622 | fail |
| 540p | 28.462 / 16.134 / 18.128 | 29.532 / 18.212 / 20.184 | pass |

1080p's CPU pass is not an admission: gate A is false. An excluded cut pair on the 720p
sheet is a double exposure and loses to blend (12.80 dB versus 14.19 dB); that pair is
outside H. fp16 CPU results are close to these and stay supplementary. RIFE fp16 also
fails A.

RT4KSR fp32 H fails. At 720p the pooled model PSNR is 28.028 dB against bicubic 28.376 dB.
Cut, inertia, pan-fast and pan-slow each lose to bicubic on PSNR; diagonal and zoom do not.
SSIM beats both interpolators, and flicker is 1.018× bicubic, inside the 1.10 limit.
At 1080p the pooled readings pass, but pan-fast does not: model PSNR 29.521 dB versus
bicubic 29.667 dB. The other five sequences pass. fp16 fails the same sequences and is
not an admission. Small has no six-sequence H screen.

Agent inspection of contact sheets, not a human review, matches those numbers. The 720p
pan-fast worst frame shows high-frequency grass error with the model slightly behind
bicubic. The 1080p pan-fast worst frame shows the same on seating and field texture.
Sheets stay in `build/` for human review. That review has not happened and cannot admit
a profile past this screen.

Captured RT4KSR fp32 timing is `build/benchmarks/ai-framegen-upscale/timing/2026-10-13_033847/results`.
Low Power Mode was on, AC power, thermal state nominal, memory pressure 1. The GPU timer
validated. Each comparison stopped at 120 s. Idle device utilization before blocks had
medians 53%, 49% and 49% (small, 720p, 1080p), above the 10% rule I limit. No round was
fully undisturbed, so each screen has zero accepted rounds. G is **not evaluated**. No
upper or lower bound was produced, and none is relied on. There is still no kernel lower
bound and no representative globe `R_native`; the SR decision would have been "no
evidence" even with a qualified cost. Sustained 3×60 s and the five-minute combined run
did not run.

RIFE was not timed: B and C fail. RT4KSR fp16 was not timed: C fails. RIFE's stop does
not use a G bound. RT4KSR fp32's stop is H, where H exists, plus an unevaluated G.

The model timestamp span includes GPU idle while ORT encodes/submits, so G_span/U_span is an
upper bound on model GPU work. A conservative advance may use that upper bound; a cost-only
stop without a kernel lower bound is labelled “stop at upper bound.” CPU-cost claims cannot
qualify because effective frequency and performance/efficiency-cluster residency are not
observable unprivileged. GPU timestamps can qualify only as conditional observations under
the registered interference, timer and A/A rules.

The browser presents at approximately 60 Hz. A 60→120 FG budget would be computed from stage
costs at a 16.67 ms source interval; this machine cannot demonstrate 120 Hz presentation.
There is **no usable measured globe render cost**: its previous comparison was discarded
because the machine was in use. Earlier panorama measurements (0.4–0.8 ms for 1080×2400)
describe that existing benchmark, not an integrated AI renderer measurement.

## Remaining limits and checks

Eighty-four separate starts cover three fresh and three cache-warm browser profiles per
graph. Fetch/import/session creation and first/second output retirement are recorded
separately; their wall times remain unqualified shared-machine observations. They do not
replace matched G timing blocks.

Sustained 3 × 60 s and the five-minute combined workload require a profile to pass the complete
screen. They have not run. The combined FG→SR cost screen has no usable RIFE stage cost and is
not computed. Human contact-sheet review, integrated capture/lifecycle, presentation deadlines,
picture age, picking, HDR, XR and other devices remain outside this Stage 1/2 research result.

`npm run check:tools` passes for 126 inventoried sources. `npm run test:source`
passes 54/54. This report, its tables, the model note and the timing note resolve
their own links. Repository-wide `npm run check:links` still fails on the unrelated
missing `validation/evidence/weather/2026-10-08/source-manifest.json`, which is left
unchanged.
