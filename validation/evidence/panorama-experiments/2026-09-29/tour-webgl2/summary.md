# Scene A/B benchmark

Generated 2026-09-29T23:50:08.619Z. Chrome/154.0.8037.58; webgl2 WebGL 2 on ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version).
Page /tour/twin-cities/ from ../UMN-VR/UMN-VR.github.io/dist-app and ../UMN-VR/UMN-VR.github.io/public; viewport 412×915 CSS px at DPR 2.625 (1081×2401 px drawn); tiles cache; cross-origin isolated: true.
Stops northrop-mall, rarig-theater; 5 rounds of 5 s per condition, in a new random order each round.
Each stretch waited for 10 s without keyboard or mouse input; 0 were run again after input or other load during them, and 0 stayed disturbed and are left out.

This is one Mac, not a phone. Milliseconds are per frame. `Render` is Babylon's scene render on the main thread, by the clock; `main thread` is Chrome's count of the main thread's CPU time, everything in the frame included (input, the HUD, garbage collection), without time spent waiting for a core; `GPU` is the GPU's frame from the timer query. Meshes examined and draw calls do not depend on load. `baseline-again` is the baseline measured a second time each round: changes no larger than its own are noise.

## Equivalence

| Workload | Condition | Pixels differing | Largest difference (0–255) | Differing by more than 2 |
| --- | --- | ---: | ---: | ---: |
| look:northrop-mall | baseline (again) | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | panoramaBookkeeping | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | opaqueImmersion | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | panoramaShaders | 7097 (0.2734%) | 1 | 0 |
| look:northrop-mall | presentationCandidates | 0 (0.0000%) | 0 | 0 |
| look:northrop-mall | all | 7097 (0.2734%) | 1 | 0 |
| look:rarig-theater | baseline (again) | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | panoramaBookkeeping | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | opaqueImmersion | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | panoramaShaders | 685 (0.0264%) | 1 | 0 |
| look:rarig-theater | presentationCandidates | 0 (0.0000%) | 0 | 0 |
| look:rarig-theater | all | 685 (0.0264%) | 1 | 0 |
| overview | baseline (again) | 0 (0.0000%) | 0 | 0 |
| overview | panoramaBookkeeping | 0 (0.0000%) | 0 | 0 |
| overview | opaqueImmersion | 0 (0.0000%) | 0 | 0 |
| overview | panoramaShaders | 16 (0.0006%) | 1 | 0 |
| overview | presentationCandidates | 0 (0.0000%) | 0 | 0 |
| overview | all | 16 (0.0006%) | 1 | 0 |

## Timing

Median per condition; in brackets, the median change from the same round's baseline as a share of it, and in how many rounds it was lower.

| Workload | Condition | Render ms | Main thread ms | Active meshes ms | GPU ms | Meshes examined | Draw calls | Stretches kept (disturbed) |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| look:northrop-mall | baseline | 1.465 | 2.677 | 0.410 | 1.289 | 289 | 1 | 5 (0) |
| look:northrop-mall | baseline-again | 1.485 (-0.0%, 3/5 lower) | 2.682 (+0.3%, 1/5 lower) | 0.410 (+0.0%, 2/5 lower) | 1.267 (-1.7%, 5/5 lower) | 289 | 1 | 5 (0) |
| look:northrop-mall | panoramaBookkeeping | 1.475 (+0.7%, 1/5 lower) | 2.703 (+1.4%, 1/5 lower) | 0.410 (+0.0%, 1/5 lower) | 1.278 (-0.7%, 4/5 lower) | 289 | 1 | 5 (0) |
| look:northrop-mall | all | 1.095 (-27.3%, 5/5 lower) | 2.220 (-14.9%, 5/5 lower) | 0.030 (-92.7%, 5/5 lower) | 1.258 (-1.6%, 5/5 lower) | 1 | 1 | 5 (0) |
| look:northrop-mall | presentationCandidates | 1.105 (-23.9%, 5/5 lower) | 2.248 (-13.8%, 5/5 lower) | 0.030 (-92.7%, 5/5 lower) | 1.275 (-1.7%, 4/5 lower) | 1 | 1 | 5 (0) |
| look:northrop-mall | panoramaShaders | 1.490 (-0.0%, 3/5 lower) | 2.702 (-0.4%, 3/5 lower) | 0.410 (+0.0%, 2/5 lower) | 1.269 (-1.4%, 5/5 lower) | 289 | 1 | 5 (0) |
| look:northrop-mall | opaqueImmersion | 1.475 (-1.4%, 3/5 lower) | 2.641 (-0.1%, 3/5 lower) | 0.415 (+1.2%, 1/5 lower) | 1.261 (-2.2%, 5/5 lower) | 289 | 1 | 5 (0) |
| look:rarig-theater | baseline | 1.455 | 2.676 | 0.405 | 1.268 | 289 | 1 | 5 (0) |
| look:rarig-theater | baseline-again | 1.460 (-0.7%, 4/5 lower) | 2.660 (-0.7%, 3/5 lower) | 0.405 (-0.0%, 4/5 lower) | 1.269 (-0.0%, 3/5 lower) | 289 | 1 | 5 (0) |
| look:rarig-theater | all | 1.075 (-26.5%, 5/5 lower) | 2.253 (-15.8%, 5/5 lower) | 0.030 (-92.6%, 5/5 lower) | 1.249 (-1.5%, 5/5 lower) | 1 | 1 | 5 (0) |
| look:rarig-theater | presentationCandidates | 1.110 (-25.8%, 5/5 lower) | 2.275 (-15.4%, 5/5 lower) | 0.030 (-92.6%, 5/5 lower) | 1.271 (+0.2%, 1/5 lower) | 1 | 1 | 5 (0) |
| look:rarig-theater | opaqueImmersion | 1.475 (+0.3%, 1/5 lower) | 2.685 (+0.3%, 2/5 lower) | 0.405 (+0.0%, 0/5 lower) | 1.247 (-1.6%, 5/5 lower) | 289 | 1 | 5 (0) |
| look:rarig-theater | panoramaBookkeeping | 1.480 (+0.0%, 2/5 lower) | 2.691 (-0.3%, 4/5 lower) | 0.405 (+0.0%, 1/5 lower) | 1.275 (+1.1%, 1/5 lower) | 289 | 1 | 5 (0) |
| look:rarig-theater | panoramaShaders | 1.490 (+1.7%, 1/5 lower) | 2.724 (+2.7%, 0/5 lower) | 0.405 (+0.0%, 2/5 lower) | 1.264 (-0.2%, 3/5 lower) | 289 | 1 | 5 (0) |
| overview | baseline | 1.065 | 4.519 | 0.150 | 2.438 | 289 | 107 | 5 (0) |
| overview | baseline-again | 1.060 (+0.5%, 2/5 lower) | 4.596 (+0.8%, 2/5 lower) | 0.155 (+6.7%, 2/5 lower) | 2.423 (-1.1%, 5/5 lower) | 289 | 107 | 5 (0) |
| overview | all | 1.035 (-1.9%, 3/5 lower) | 4.216 (-4.1%, 5/5 lower) | 0.160 (+6.7%, 1/5 lower) | 2.422 (-2.4%, 4/5 lower) | 289 | 107 | 5 (0) |
| overview | presentationCandidates | 1.015 (-5.2%, 3/5 lower) | 4.414 (-2.4%, 3/5 lower) | 0.145 (+0.0%, 2/5 lower) | 2.446 (-0.4%, 3/5 lower) | 289 | 108 | 5 (0) |
| overview | opaqueImmersion | 1.040 (-2.8%, 3/5 lower) | 4.563 (+0.6%, 2/5 lower) | 0.150 (-3.3%, 3/5 lower) | 2.424 (-0.2%, 3/5 lower) | 289 | 107 | 5 (0) |
| overview | panoramaBookkeeping | 1.025 (-4.2%, 5/5 lower) | 4.287 (-5.1%, 5/5 lower) | 0.160 (+3.3%, 2/5 lower) | 2.413 (-1.4%, 3/5 lower) | 289 | 107 | 5 (0) |
| overview | panoramaShaders | 1.055 (+0.5%, 2/5 lower) | 4.335 (-3.1%, 4/5 lower) | 0.155 (+3.3%, 2/5 lower) | 2.431 (-2.5%, 3/5 lower) | 289 | 107 | 5 (0) |

## Run

Requests: {"own":64,"content":723,"cacheHits":1560,"fetched":48,"failed":0,"hosts":{"api.github.com":1,"tiles.mapterhorn.com":1288,"basemap.nationalmap.gov":319}}.
Exceptions: none. Console errors: 0.
