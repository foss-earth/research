# Scene A/B benchmark

Generated 2026-09-30T00:01:35.415Z. Chrome/154.0.8037.58; webgl WebGL 1 on ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version).
Page /tour/twin-cities/ from ../UMN-VR/UMN-VR.github.io/dist-app and ../UMN-VR/UMN-VR.github.io/public; viewport 412×915 CSS px at DPR 2.625 (1081×2401 px drawn); tiles cache; cross-origin isolated: true.
Stops northrop-mall, rarig-theater; 5 rounds of 5 s per condition, in a new random order each round.
Each stretch waited for 10 s without keyboard or mouse input; 1 were run again after input or other load during them, and 0 stayed disturbed and are left out.

This is one Mac, not a phone. Milliseconds are per frame. `Render` is Babylon's scene render on the main thread, by the clock; `main thread` is Chrome's count of the main thread's CPU time, everything in the frame included (input, the HUD, garbage collection), without time spent waiting for a core; `GPU` is the GPU's frame from the timer query. Meshes examined and draw calls do not depend on load. `baseline-again` is the baseline measured a second time each round: changes no larger than its own are noise.

## Equivalence

| Workload | Condition | Pixels differing | Largest difference (0–255) | Differing by more than 2 |
| --- | --- | ---: | ---: | ---: |
| look:northrop-mall | baseline (again) | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | panoramaBookkeeping | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | opaqueImmersion | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | panoramaShaders | 4724 (0.1820%) | 1 | 0 |
| look:northrop-mall | presentationCandidates | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | all | 4724 (0.1820%) | 1 | 0 |
| look:rarig-theater | baseline (again) | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | panoramaBookkeeping | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | opaqueImmersion | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | panoramaShaders | 669 (0.0258%) | 1 | 0 |
| look:rarig-theater | presentationCandidates | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | all | 669 (0.0258%) | 1 | 0 |
| overview | baseline (again) | 0 (0.0000%) | 0 | 0 |
| overview | panoramaBookkeeping | 0 (0.0000%) | 0 | 0 |
| overview | opaqueImmersion | 0 (0.0000%) | 0 | 0 |
| overview | panoramaShaders | 22 (0.0008%) | 1 | 0 |
| overview | presentationCandidates | 0 (0.0000%) | 0 | 0 |
| overview | all | 22 (0.0008%) | 1 | 0 |

## Timing

Median per condition; in brackets, the median change from the same round's baseline as a share of it, and in how many rounds it was lower.

| Workload | Condition | Render ms | Main thread ms | Active meshes ms | GPU ms | Meshes examined | Draw calls | Stretches kept (disturbed) |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| look:northrop-mall | baseline | 1.490 | 2.668 | 0.425 | stale | 289 | 1 | 5 (0) |
| look:northrop-mall | baseline-again | 1.530 (+3.0%, 1/5 lower) | 2.708 (+1.6%, 1/5 lower) | 0.425 (+0.0%, 2/5 lower) | stale | 289 | 1 | 5 (0) |
| look:northrop-mall | opaqueImmersion | 1.510 (+2.0%, 2/5 lower) | 2.679 (-0.5%, 3/5 lower) | 0.425 (+0.0%, 0/5 lower) | stale | 289 | 1 | 5 (0) |
| look:northrop-mall | all | 1.085 (-27.5%, 5/5 lower) | 2.255 (-15.6%, 4/5 lower) | 0.035 (-92.9%, 5/5 lower) | stale | 1 | 1 | 5 (0) |
| look:northrop-mall | panoramaBookkeeping | 1.500 (+0.0%, 2/5 lower) | 2.656 (-0.4%, 3/5 lower) | 0.425 (-1.2%, 3/5 lower) | stale | 289 | 1 | 5 (0) |
| look:northrop-mall | presentationCandidates | 1.125 (-25.8%, 5/5 lower) | 2.248 (-16.9%, 4/5 lower) | 0.030 (-92.9%, 5/5 lower) | stale | 1 | 1 | 5 (0) |
| look:northrop-mall | panoramaShaders | 1.535 (+2.3%, 0/5 lower) | 2.663 (+1.7%, 2/5 lower) | 0.425 (+0.0%, 2/5 lower) | stale | 289 | 1 | 5 (0) |
| look:rarig-theater | baseline | 1.470 | 2.626 | 0.430 | stale | 289 | 1 | 5 (0) |
| look:rarig-theater | baseline-again | 1.440 (-2.0%, 5/5 lower) | 2.577 (-2.3%, 4/5 lower) | 0.430 (+0.0%, 0/5 lower) | stale | 289 | 1 | 5 (0) |
| look:rarig-theater | panoramaBookkeeping | 1.455 (-0.7%, 4/5 lower) | 2.624 (-0.1%, 3/5 lower) | 0.430 (+0.0%, 1/5 lower) | stale | 289 | 1 | 5 (0) |
| look:rarig-theater | opaqueImmersion | 1.460 (-1.4%, 4/5 lower) | 2.615 (-1.1%, 3/5 lower) | 0.425 (-1.2%, 4/5 lower) | stale | 289 | 1 | 5 (0) |
| look:rarig-theater | presentationCandidates | 1.075 (-26.9%, 5/5 lower) | 2.209 (-14.5%, 5/5 lower) | 0.030 (-93.0%, 5/5 lower) | stale | 1 | 1 | 5 (0) |
| look:rarig-theater | all | 1.070 (-27.9%, 5/5 lower) | 2.198 (-16.6%, 5/5 lower) | 0.030 (-91.9%, 5/5 lower) | stale | 1 | 1 | 5 (0) |
| look:rarig-theater | panoramaShaders | 1.490 (+0.3%, 2/5 lower) | 2.632 (+0.2%, 2/5 lower) | 0.425 (-0.0%, 3/5 lower) | stale | 289 | 1 | 5 (0) |
| overview | baseline | 0.975 | 3.844 | 0.140 | stale | 289 | 107 | 5 (0) |
| overview | baseline-again | 0.995 (+2.6%, 1/5 lower) | 3.994 (+7.8%, 1/5 lower) | 0.150 (+7.1%, 0/5 lower) | stale | 289 | 107 | 5 (0) |
| overview | panoramaBookkeeping | 0.945 (-4.1%, 3/5 lower) | 4.087 (+4.0%, 1/5 lower) | 0.145 (+3.6%, 0/5 lower) | stale | 289 | 107 | 5 (0) |
| overview | opaqueImmersion | 0.990 (+0.0%, 2/5 lower) | 4.034 (+3.6%, 2/5 lower) | 0.145 (+7.1%, 1/5 lower) | stale | 289 | 107 | 5 (0) |
| overview | all | 0.990 (+2.1%, 2/5 lower) | 4.011 (+4.6%, 1/5 lower) | 0.155 (+10.7%, 1/5 lower) | stale | 289 | 107 | 5 (0) |
| overview | presentationCandidates | 0.975 (+5.6%, 1/5 lower) | 4.111 (+7.1%, 1/5 lower) | 0.140 (+3.6%, 1/5 lower) | stale | 289 | 107 | 5 (0) |
| overview | panoramaShaders | 0.990 (+3.6%, 2/5 lower) | 4.130 (+2.4%, 1/5 lower) | 0.140 (+0.0%, 1/5 lower) | stale | 289 | 107 | 5 (0) |

`stale`: the GPU timer gave one reading and never another, so the same value stood for every stretch; the GPU was not measured there.

## Run

Requests: {"own":64,"content":723,"cacheHits":6658,"fetched":5,"failed":0,"hosts":{"api.github.com":1,"tiles.mapterhorn.com":1104,"basemap.nationalmap.gov":5558}}.
Exceptions: none. Console errors: 0.
