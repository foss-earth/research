# Timing a benchmark on this machine

The current [shared-machine benchmark policy](benchmark-interference.md) governs
qualification. The observations and older guards below remain useful evidence;
input idleness and aggregate load alone do not attribute CPU cost on the fanless
Mac's performance/efficiency cores or establish thermal stability. Defer affected
timings when the required attribution is unavailable, and continue untimed work.

What the [spherical image representation benchmark](../../benchmarks/spherical-image-representation/REPORT.md)
learned about timing, on 2026-10-01 and 02, by getting it wrong first. It applies to any
benchmark here that reports milliseconds. Results that are computed and not timed (bytes,
PSNR, counts) do not depend on any of it.

The machine was an Apple M5 with 10 cores and 16 GiB, on macOS 27.0, with Chrome 154.

## Four things changed a timing

| What | How it showed | What catches it |
| --- | --- | --- |
| A person using the machine | Slower rounds, at random | Seconds since the last keyboard, mouse or trackpad input |
| Other processes | The same | Cores busy across the round, every process counted |
| The machine short of memory | Everything slower, with no input and no busy cores | The kernel's pressure level, and pages compressed and swapped during the round |
| The processor idling between frames | Work done once a frame 5 to 20 times slower than the same work in a loop | Nothing: it is a condition to state, not a disturbance |

`quietRound` in
[benchmarks/spherical-image-representation/lib/quiet.mjs](../../benchmarks/spherical-image-representation/lib/quiet.mjs)
has the first three: it waits for ten seconds without input and for normal memory pressure,
runs the round, and runs it again if any of the three happened during it. A round still
disturbed after three more tries is kept and marked. [scene-ab](../../benchmarks/scene-ab/README.md)
has its own copy of the first two and not the third.

## Memory

A machine that is compressing or swapping memory slows everything on it, and neither the
input guard nor the load guard sees it.

- **During a run.** `sysctl -n kern.memorystatus_vm_pressure_level` gives the kernel's level:
  1 normal, 2 warning, 4 critical. `vm_stat` gives running counts, in pages since boot, of
  `Compressions`, `Swapouts` and `Swapins`; the difference across a round is what happened
  during it. The guard rejects a round if the level was not 1 at either end, if anything was
  swapped out, or if more than 16 MiB was compressed.
- **Afterwards.** The kernel logs what it did:

  ```sh
  /usr/bin/log show --start "2026-10-01 20:00:00" --end "2026-10-02 00:00:00" --style compact \
    --predicate 'process == "kernel" AND eventMessage CONTAINS[c] "memorystatus"'
  ```

  `log` alone is a builtin in zsh, so give the path. Bursts of `killing_idle_process` lines,
  with `compressor_size` in each, mark the minutes the machine was short.
- **Several processes at once must fit.** Half the cores is not a memory budget. Five
  workers at once, at up to 3.4 GiB each in the network experiment, made the 16 GiB machine
  swap, in bursts over two hours. Measure what one worker needs before starting several: `process.resourceUsage().maxRSS`
  is the peak in kibibytes. [lib/pool.mjs](../../benchmarks/spherical-image-representation/lib/pool.mjs)
  starts half the cores or as many workers as fit in half the memory, whichever is fewer,
  and prints each worker's peak.
- **To show that a result was not affected, reproduce it.** The experiments that swapped
  were deterministic, so one panorama was run through each of them again on a machine that
  was not swapping, and the 6,833 rows compared character for character with the published
  ones. That is stronger than arguing that timing cannot matter.

## A frame's work is not a loop's work

Two clean runs of the same page, both passing every guard, disagreed by 5 to 20 times on the
main thread's work per frame. The difference was whether anything else on the machine was
running. WebGL 2, milliseconds per frame, median (worst of 240):

| Each frame | Nothing else running | One other core kept busy |
| --- | ---: | ---: |
| Only the render call | 0.18 (0.27) | 0.015 (0.06) |
| One 256 × 256 residual tile decoded in JavaScript and uploaded | 2.94 (8.65) | 0.45 (2.46) |
| One JPEG tile decoded by the browser and uploaded | 2.25 (3.87) | 0.44 (0.70) |

The decode alone took 0.6 ms in a loop in either state, and GPU times did not change. A
frame's work is a short burst after 16 ms of idleness; presumably the processor slows or
sleeps in between, and a busy neighbour keeps it awake. The effect was measured and the
mechanism was not examined.

- A timing loop measures the awake state. A viewer that is the only thing running lives in
  the other one. Neither is what a phone does.
- Report which state a per-frame CPU figure was measured in, or measure both.
  `run-gpu.mjs --keep-busy=1` spins one other core for the whole run.
- An A/B comparison inside one state still holds. An absolute figure, or a comparison
  between runs made in different states, does not. `scene-ab`'s CPU milliseconds per frame
  have not been checked for this.

## Frame intervals

The timestamp `requestAnimationFrame` passes to its callback stayed on the display's 16.67 ms
grid even when the callback ran late: frames with 18 to 21 ms of work still showed intervals
of 16.67 ms. To see a late frame, read `performance.now()` at the start of the callback and
difference those.

`performance.now()` is itself rounded to 100 µs unless the page is cross-origin isolated;
see [Checks on a real GPU](README.md).
