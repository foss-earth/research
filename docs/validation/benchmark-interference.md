# Benchmarks while the machine is shared

Status: required policy; shared helper and harness migration are pending.

The user uses this Mac while agents work. A benchmark must attribute its own
work and account for concurrent activity before its timings qualify. Prefer
bounded parallel preparation, correctness checks, geometry and quality analysis,
and documentation. If the requested timing cannot be separated reliably from
other activity, defer that timing until the user offers exclusive access. Do not
wait indefinitely for keyboard inactivity or require an idle Mac by default.

This Mac has performance and efficiency cores and no fan. Core placement and
thermal state are part of attribution, even with exclusive access. Aggregate
utilization cannot establish isolated CPU cost on this machine.

FOSS Earth owns this policy and its future shared helper: it applies to globe
benchmarks and consuming applications alike. [Timing on this machine](timing.md)
records earlier observations and existing guards. An input-idle check or low
average CPU load alone does not satisfy this policy. The helper is not built;
existing harnesses do not become qualified merely by linking this document.

## Define what the number means

Each metric declares its measured interval, unit, relevant resources and claim.

| Metric | Attribution and permitted conclusion |
| --- | --- |
| Own CPU work | Use a supported clock or trace for the benchmark's threads/process tree, with setup and measurement overhead identified. Whole-process CPU time includes other work in that process. It excludes time descheduled, but remains affected by frequency, cache and memory contention. Report work in the observed shared-machine state. |
| Elapsed latency or throughput | Wall time includes scheduling, waits, own GC and shared-resource delays. Own CPU time cannot replace it. Separate attribution needs evidence for those intervals; otherwise report the observation as unqualified for isolated performance. |
| GPU work | Verify the real GPU and the timer's semantics, validity/disjoint state and measured command range. Observe submission/queue delays and shared GPU activity when relevant. A GPU timestamp alone does not establish exclusive GPU service. |
| Frames and audio deadlines | Measure actual completion/deadline misses and callback timing. Kernel throughput or averaged blocks cannot establish frame latency, audio underruns, or device qualification. |
| Counts, bytes and correctness | Geometry coverage, output sizes and deterministic correctness can proceed without timing qualification. Bound workers and memory so the experiment still respects the shared machine. |

Do not subtract a guessed cost of other apps from elapsed time, divide by idle
CPU percentage, or treat a process CPU/wall ratio as a correction. Contention can
change the benchmark's own execution cost. A conditional A/B result under
observed load and an isolated absolute performance claim are different claims.

## Observe each comparison, not just the run's ends

Record observations before, during and after each measured block at a declared
cadence. Sampling itself has a measured cost. At minimum identify the benchmark's
own workers and CPU time, aggregate system CPU activity, process-tree memory,
memory pressure, and compression/swap deltas. Do not collect other apps' names,
command lines, documents or URLs; aggregate interference is sufficient.

Also record what the metric needs: warm/cold cache and JIT/shader compilation;
own GC/allocation events; power mode and observable thermal/frequency changes;
GPU activity, queue/disjoint/device state for GPU work; audio callback load and
underruns for audio deadlines; and network/disk competition for I/O latency.
Keyboard input is a diagnostic signal, not proof of contention or an automatic
reason to demand that the user stop working. A busy core can change the
processor's idle behavior even without slowing a timing; [the existing
measurements](timing.md#a-frames-work-is-not-a-loops-work) demonstrate this.

For CPU cost, observe the benchmark threads' performance/efficiency cluster
residency, scheduling and migration, and effective frequency over each block
when the runtime exposes them. `hw.perflevel` topology describes available core
classes; it does not show where a thread ran or its active speed. Process CPU
time and aggregate utilization also do not establish that residency. Match
observed cluster/frequency conditions for paired CPU-cost claims, or describe
the measured scheduling mixture as part of a narrower metric. Do not convert
between core classes using a guessed speed factor.

On a fanless machine, warmup and sustained work can change the state during the
comparison. Record observable OS thermal pressure and effective frequency;
check drift through the short randomized blocks and recurring controls. Bound
warmup, frequency/state drift and any cooling interval as named parameters.
Do not warm continuously until a convenient result appears, or manufacture a
stable state with unrecorded background load. If enough core/thermal telemetry
is unavailable to attribute the requested timing, stop or defer that timing;
geometry and correctness remain useful. Exclusive access does not itself fix
heterogeneous scheduling, establish thermal stability, or replace observability.

Mark each observation supported, missing or invalid. Missing signals are not
zero. When a material source of interference cannot be observed or separated,
the affected performance claim is unqualified. Keep its samples, state why, and
continue untimed work. Exclusive access can remove concurrent user activity,
but does not replace timer validation or checks for background services,
thermal changes, memory pressure and the benchmark's own disturbances.

## Compare candidates in paired, randomized blocks

Prepare identical inputs and complete correctness gates first. Warm every
candidate according to the declared cache/JIT policy. Interleave short A/B or
balanced multi-candidate blocks in seeded randomized order, pairing nearby
measurements. Include repeated A/A controls and reversed orders to reveal drift,
timer noise, order effects and uneven interference. Do not run all of A, then
all of B, and attribute the difference to the algorithms.

Define acceptance rules before reading winners. Evaluate the entire pair/block
when its conditions change, rather than retaining only its faster member. Keep
all raw samples and rejection reasons. Report paired differences/ratios and
uncertainty with the accepted pair count; a stable median alone cannot qualify
a comparison. Never remove the algorithm's own allocations, GC, waits or memory
pressure from an end-to-end metric. A separately declared allocation-free kernel
measurement can answer a narrower question.

Retries and observation time are bounded. On exhaustion or missing required
telemetry, stop qualifying that metric and retain the failure. Do useful work
in parallel within the resource budgets; suspend competing agent workloads
only for measurement intervals that require it. Do not launch more timed runs
to chase clean-looking samples or keep an invisible benchmark waiting for the
user to leave.

## Parameters and retained evidence

Every harness exposes its budgets and acceptance thresholds as named numeric
parameters, with units, bounds, defaults and a reason. The shared helper starts
with these defaults; a harness must record explicit overrides and additional
metric-specific gates.

| Parameter | Unit and bounds | Default and reason |
| --- | --- | --- |
| `maximumWorkers` | workers, 1 to half the logical cores, rounded down (minimum 1) | The upper bound; leaves compute for the user's work. Actual native worker pools must be verified. |
| `maximumResidentMiB` | MiB, positive and no more than half physical RAM | Half RAM; fewer workers when measured peak usage would exceed it. |
| `measurementBlockMs` | ms, 1 to 1000 | 20 ms for hot CPU loops; amortizes timer/observation overhead. Frame/audio metrics use their actual scheduling cadence. |
| `minimumPairs` | pairs, 3 to 1000 | 11; enough repetitions to expose unstable comparisons without an open-ended run. |
| `maximumPairs` | pairs, at least `minimumPairs`, up to 1000 | 33; bounds retries as well as accepted pairs. |
| `maximumRunSeconds` | s, 1 to 3600 | 120 per comparison; exhaustion preserves evidence and ends qualification. |
| `orderSeed` | unsigned 32-bit integer | 0; reproduces pairing and ordering. |
| `maximumWarmupSeconds` | s, 0 to 120 | 5; bounds premeasurement work and its thermal effect. Warmup convergence criteria are declared separately. |
| `maximumClusterResidencyMismatchPercent` | percentage points, 0 to 100 | 0 for an isolated CPU-cost claim; pair blocks with the same observed core-class mixture. A scheduling-mixture experiment declares a different scope. |
| `maximumEffectiveFrequencyDriftPercent` | %, 0 to 100 | 5 across a pair/control interval; rejects material frequency drift rather than correcting it away. |
| `maximumThermalPressure` | native OS thermal-pressure level, bounds are the API's valid values | The least-pressure state for an isolated-cost claim; record the API/value mapping and reject missing required observations. |
| `cooldownSeconds` | s, 0 to 600 | 0; no cooling wait by default. A thermal experiment can request and record a bounded interval. |

Warmup length/stability limits, observation cadence, maximum A/A variation,
minimum resolvable effect and permitted resource-state changes depend on the
metric. Declare their units, bounds and defaults before measuring; calibrate
them against the timer and controls, rather than choosing them after seeing a
result. Any intentional background load or requested cooling interval is also
a named parameter and part of the experiment's claim.

Retain source/input hashes, tool/runtime versions, backend and timer semantics,
all parameters, warmup policy, block order, instrumentation overhead, supported
and missing signals, per-block telemetry, raw measurements and qualification
reasons. Record only task-relevant machine facts, without account names, serials,
hostnames or environment dumps. Scratch uses dated `build/` directories;
distributed evidence follows the repository's validation layout. Reports lead
with which claims qualified and which timings are deferred. Earlier elapsed
timings lacking this attribution remain historical observations, and can still
be useful correctness evidence, but cannot silently become qualified results.
