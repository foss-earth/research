# Finite collision ray benchmark

Run from the foss-earth repository root with installed dependencies:

```sh
node benchmarks/collision/run.mjs
```

No server, browser or downloads are needed. Vite compiles the current production
query alongside its unmodified version from commit
`cd84c60998cb4be4c71cce3f5a60f56292ac20dd` (that Git object must be available).
Temporary compilation output stays in ignored `.cache/`. The command writes
`results.json`; pass an output path to retain another run.

Both implementations receive the same 5 m rays and Babylon NullEngine meshes.
The first two fixtures contain eight visible grids, each with 32,768 triangles,
100–800 m beyond the ray origin. The second adds a real collision 3 m away. The
control contains one dense grid within reach, so the exact triangle scan remains
necessary. Hit and miss results are checked before timing. Each path warms for
100 queries, then 21 rounds alternate path order and average 10 queries per round.

Measured on Apple M5, Node 26.0.0, Babylon 8.56.2, macOS arm64:

| Scenario | Baseline median/query | Current median/query |
|---|---:|---:|
| Dense distant geometry; no reachable hit | 4.122 ms | 0.00229 ms |
| Dense distant geometry plus nearby collision | 3.623 ms | 0.00437 ms |
| Dense nearby geometry control | 0.44705 ms | 0.44776 ms |

The JSON includes environment versions, source hashes, timing method and results.
This synthetic CPU measurement isolates work avoided by finite bounding tests.
It measures no GPU rendering, streaming, browser frame pacing, power or game FPS.
The control illustrates the remaining cost of scanning triangles inside a nearby
mesh; this change preserves Babylon's exact triangle picker.

## CPU / hardware GPU algorithm comparison

The separate comparison uses **headless Chromium controlled through the terminal**.
It creates a temporary browser profile and loads an offline HTML file. It does not
open a visible window, connect to the user's browser, or control the cursor.

Run from this repository with dependencies installed. Playwright can live in a
separate directory; it is not required by the game:

```sh
npm install --prefix /private/tmp/collision-browser-tools --no-audit --no-fund playwright
PLAYWRIGHT_MODULE=/private/tmp/collision-browser-tools/node_modules/playwright/index.mjs \
  node benchmarks/collision/run-gpu-headless.mjs
```

If Playwright is installed in this repository, omit `PLAYWRIGHT_MODULE`. On macOS
the runner uses `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
set `CHROME_PATH` to select another compatible Chromium executable. On other
platforms it defaults to Playwright's installed Chromium. An optional positional
argument selects a different output JSON file. There is no server, application
deployment, or network request in the benchmark. A restricted execution sandbox
may require permission to spawn the isolated headless browser.

The runner rejects software adapters, records WebGPU adapter information and
Chromium GPU diagnostics, and verifies Metal hardware rendering on macOS. A
missing hardware adapter is a failed benchmark, not a CPU/GPU result.

Five backends query the same 32,768-triangle mesh with identical finite rays:

- Production CPU: the current Babylon picker including surface-query metadata.
- CPU brute: one mesh bounds check followed by a linear triangle scan.
- CPU BVH: a median-split bounding-volume hierarchy, eight triangles per leaf.
- GPU brute: the same linear scan in WebGPU, with one invocation per ray.
- GPU BVH: the same hierarchy and traversal in WebGPU.

The GPU variants include ray upload, command encoding, dispatch, result copy,
awaited `mapAsync`, and copying the results into CPU-owned memory. Timing just the
shader would not represent the latency paid by a CPU physics step. Geometry is
built and uploaded beforehand; these preparation costs are recorded separately.

Each case has 12 warmup batches and 15 timed batches with alternating backend
order. Cheap CPU queries use calibrated repetition counts so browser timer
rounding does not produce zero measurements; these are hot-cache averages per
batch. GPU measurements are individual, sequential, end-to-end batches and remain
subject to browser timer rounding. The raw JSON contains every sample, median,
p95, repetition count, environment details, and source hashes. Every warmup and
timed ray is checked against the production picker: hit/miss must match, distance
must agree within 3 mm, and normal direction must agree up to orientation with
absolute dot product at least 0.999.

### Measured results

Measured 2026-09-10 on Apple M5, macOS arm64, headless Chrome 153.0.8010.37.
WebGPU reported vendor `apple`, architecture `metal-3`, and
`isFallbackAdapter: false`; Chromium separately reported
`ANGLE Metal Renderer: Apple M5`. The 42-second run checked 62,532 rays against
all four prototypes. See [the complete raw report](results-gpu.json).

All values below are **median milliseconds per entire ray batch**, including
GPU readback. The distant-miss case has geometry beyond the ray's finite reach;
all backends can reject it using bounds alone.

| Scenario | Rays | Production CPU | CPU brute | CPU BVH | GPU brute + readback | GPU BVH + readback |
|---|---:|---:|---:|---:|---:|---:|
| Dense nearby hit | 1 | 0.444 | 0.0953 | 0.000168 | 8.1 | 0.3 |
| Dense nearby hit | 5 | 2.25 | 0.500 | 0.000806 | 9.0 | 0.4 |
| Dense nearby hit | 128 | 56.2 | 12.3 | 0.0215 | 11.4 | 0.4 |
| Dense nearby hit | 1,024 | 465.8 | 98.3 | 0.2125 | 17.8 | 0.5 |
| Distant miss | 1 | 0.000198 | 0.0000166 | 0.0000168 | 0.4 | 0.4 |
| Distant miss | 5 | 0.000977 | 0.0000656 | 0.0000656 | 0.6 | 0.6 |
| Distant miss | 128 | 0.0250 | 0.00159 | 0.00159 | 0.6 | 0.6 |
| Distant miss | 1,024 | 0.200 | 0.0127 | 0.0127 | 0.5 | 0.6 |

The CPU BVH prototype beat GPU BVH for every tested batch size. GPU brute force
outperformed CPU brute force for larger batches, but CPU BVH was faster still.
For five nearby rays, GPU BVH took 0.4 ms at the median and 2.1 ms at p95, compared
with CPU BVH's repeated-batch average of 0.000806 ms and p95 of 0.000940 ms.
For distant misses, the CPU prototypes have essentially the same bounds-only
cost. These results favor a CPU spatial index for the current small synchronous
ray workload; they do not establish a universal CPU/GPU crossover threshold.

Building this BVH on the CPU took 60.7 ms, and its packed node/triangle data used
1,966,032 bytes. GPU pipeline creation took 2.2 ms; per-case allocation and upload
costs are in the raw report. These startup costs must be considered when geometry
streams or changes. None of them is included in the steady-query table.

This is a practical comparison of implemented query kernels, not every possible
algorithm/hardware combination. Both custom kernels omit production transforms
and geodetic metadata. The synthetic geometry is static, uses local float32
coordinates, and has no rendering or streaming load. BVH construction for changing
terrain, worker/WASM implementations, parallel triangle-reduction shaders, direct
heightfield lookup, and GPU-resident physics remain separate experiments. A
heightfield lookup also cannot represent arbitrary building walls or overhangs.
These measurements do not establish game FPS, power consumption, battery life,
or a change to JSBSim's CPU contact solver. Neither GPU prototype is a production
collision backend.

### Portability and backend selection

This is one Apple M5 running one Chromium build, not a hardware-independent
ranking. Its CPU, GPU, memory system and browser all affect the result. The
benchmark does not establish the M5's single-thread ranking against other CPUs.

For the nearby-hit fixture, CPU BVH's measured advantage over GPU BVH is about
497 times at five rays but only 2.35 times at 1,024 rays. Those are prototype
query-latency ratios, not game speedups. CPU measurements use repeated hot-cache
batches; the GPU measurements include asynchronous readback. A different device,
larger workload, colder cache or different kernel can change the crossover.
WebGPU CPU readback must await the buffer becoming available regardless of CPU
brand ([mapAsync documentation](https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync)).

Use the CPU as the present default and reliable fallback. Keep room for validated
CPU and GPU backends behind the same query contract; these results do not justify
making the architecture permanently CPU-only. An eventual Auto mode should
measure representative batches on the actual device, including readback, build
and upload costs, p95 latency, and contention from normal rendering/streaming.
It should switch only on a sustained meaningful improvement and retain the
planned user override. A late or stale result must never be applied to physics.
There is no automatic gameplay backend selector in this patch.

Before generalizing, repeat the terminal/headless harness on older/lower-power
CPUs, mobile devices where headless hardware testing is supported, integrated
GPUs, and discrete GPUs, then validate the candidates under game load. CPU
throttling on the M5 is a sensitivity experiment, not a substitute for those
devices. Energy efficiency remains unmeasured and needs its own measurements.
