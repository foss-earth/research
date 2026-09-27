# Panorama campus check

**automated check FAILED on apple metal-3 (Apple M5), Chrome/153.0.8010.53, WebGPU, 1440×900 at DPR 1, 60 fps cap, usgs-imagery-topo imagery with mapterhorn elevation: 2 failure(s).**

Generated 2026-09-27T05:50:36.346Z from commit 47f2d61e07784d05c2910454f2dce48219acc31b.

## Configuration

- Browser: Chrome/153.0.8010.53; renderer webgpu; GPU timing available.
- Adapter: {"vendor":"apple","architecture":"metal-3","device":"0x0000","description":"Apple M5","isFallbackAdapter":false}; hardware verified: yes.
- Map: {"mode":"raster-basemap","basemap":"usgs-imagery-topo","basemapProvider":"USGS The National Map","elevation":"mapterhorn"}.
- Viewports 1440×900 and 720×1280 at DPR 1; 60 fps cap; flat window 90°; direct rendering, no cache.

## Cold load

App 820 ms, scene 875 ms, marker placed 2084 ms, preview ready 875 ms after navigation.

## Directions

67 of 67 probes saw the orb, each reading back one frame's rays and sampled image directions.

- Mapping: the CPU window and pose applied to each pixel's GPU ray differ from the direction the GPU sampled by at most **3.643e-4°** (tolerance 0.01°), in orbit-clockwise at 15.5 s.
- Rays: each pixel's GPU ray is within 1.306e-4° of the CPU's pixel-centre ray (tolerance 0.002°).
- End to end: the CPU mapping of the CPU ray differs by at most 2.803e-3°. The flat window magnifies ray differences by 25.5 there, and that is 0.15% of the panorama one pixel shows (limit 10%).

Coverage, reported apart: 16878 edge pixels, 0 drawn where the reference has no orb, 0 missing where it has, 65 outside the orb's square.
Draws: 3881 frames drew the orb, 0 with an earlier camera; largest eye difference between a draw and the live camera 7.03e-6 m.

Negative control (uniforms one frame late): interior difference up to 18.2333°, rejected; 240 stale frames seen.

## Colour and orientation

| Source | View | Orientation | Samples | Error | Mirrored: pixels, error as drawn / as mirrored | Result |
| --- | --- | --- | --- | --- | --- | --- |
| photograph | north | landscape | 4276 | 4.1 | 1424, 6.2 / 57.6 | pass |
| photograph | east | landscape | 4276 | 4.3 | 3224, 4.5 / 66.0 | pass |
| photograph | north | portrait | 6641 | 4.7 | 2172, 6.9 / 59.9 | pass |
| photograph | east | portrait | 6641 | 4.8 | 4991, 5.0 / 66.4 | pass |
| cardinal | north | landscape | 4276 | 3.7 | 56, 14.7 / 65.5 | pass |
| cardinal | east | landscape | 4276 | 3.6 | 127, 18.5 / 59.1 | pass |
| cardinal | north | portrait | 6641 | 3.9 | 74, 13.1 / 74.5 | pass |
| cardinal | east | portrait | 6641 | 3.8 | 193, 19.4 / 59.7 | pass |

Error is the mean absolute difference, 0–255, between the screenshot and the source sampled at the CPU direction. Each wrong orientation (mirrored, turned 90°, 180°, 270°) is judged only on the pixels where it predicts a colour more than 24 levels from the correct one, and must fit them less than half as well.

## Frame intervals during motion

| Run | Frames | p50 ms | p95 ms | p99 ms | Max ms | >100 ms |
| --- | --- | --- | --- | --- | --- | --- |
| orb shown | 2863 | 16.70 | 66.60 | 83.40 | 133.3 | 4 |
| orb hidden | 2838 | 16.70 | 66.70 | 83.40 | 150.1 | 2 |
| shown, profiling off | 2835 | 16.70 | 66.70 | 83.40 | 133.3 | 8 |

Every run drew the map at the detail asked for, with automatic adjustment off; before timing, the slow screenshot frames had led it to coarsen the map 1.75 levels, which it does not undo while frames are held at the cap. Each run started once the map had stopped streaming.

Budget: p95 ≤ 20 ms, p99 ≤ 33.3 ms, none over 100 ms. First frames after the stop: 16.6 ms (excluded from motion).

## Entering, links, Back and Exit

- The entered photograph's immersion differs from the CPU rays by up to 1.200e-5°; after Exit the globe camera is back within centre 0.0e+0 m, yaw 0.0e+0 rad, pitch 0.0e+0 rad.
- The pair: A entered 1.182e-5°, B after the link 1.130e-5°; Back returned to A: yes; after Exit the camera is back within centre 0.0e+0 m, yaw 0.0e+0 rad, pitch 0.0e+0 rad.
- The Exit chip, as laid out: hidden in the overview yes, shown while entered yes, hidden after Exit yes; credits while entered: 1.

## Failures

- The globe alone, with no orb, misses the frame budget on this trace (reported separately from the orb).
- With the orb shown, the frame interval misses the budget.
