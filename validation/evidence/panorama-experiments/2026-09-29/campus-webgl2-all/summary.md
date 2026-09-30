# Panorama campus check

**automated check passed on apple metal-3 (Apple M5), Chrome/154.0.8037.58, webgl2 (ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)), 1440×900 at DPR 1, 60 fps cap, usgs-imagery-topo imagery with mapterhorn elevation; manual acceptance pending.**

Generated 2026-09-29T23:47:07.200Z from commit 5900583d6cf555f9945de03ba1d0c4b097cacc39 with 20 uncommitted files.

## Configuration

- Browser: Chrome/154.0.8037.58; renderer webgl2; GPU timing available.
- Adapter: {"vendor":"apple","architecture":"metal-3","device":"0x0000","description":"Apple M5","isFallbackAdapter":false}; hardware verified: yes.
- Map: {"mode":"raster-basemap","basemap":"usgs-imagery-topo","basemapProvider":"USGS The National Map","elevation":"mapterhorn"}.
- Viewports 1440×900 and 720×1280 at DPR 1; 60 fps cap; flat window 90°; direct rendering, no cache.

## Cold load

App 414 ms, scene 465 ms, marker placed 825 ms, preview ready 465 ms after navigation.

## Directions

67 of 67 probes saw the orb, each reading back one frame's rays and sampled image directions.

- Mapping: the CPU window and pose applied to each pixel's GPU ray differ from the direction the GPU sampled by at most **4.834e-4°** (tolerance 0.01°), in near-far at 45.6 s.
- Rays: each pixel's GPU ray is within 1.281e-4° of the CPU's pixel-centre ray (tolerance 0.002°).
- End to end: the CPU mapping of the CPU ray differs by at most 6.831e-3°. The flat window magnifies ray differences by 53.8 there, and that is 0.24% of the panorama one pixel shows (limit 10%).

Coverage, reported apart: 22981 edge pixels, 0 drawn where the reference has no orb, 0 missing where it has, 214 outside the orb's square.
Draws: 2172 frames drew the orb, 0 with an earlier camera; largest eye difference between a draw and the live camera 7.03e-6 m.

Negative control (uniforms one frame late): interior difference up to 51.1460°, rejected; 144 stale frames seen.

## Colour and orientation

| Source | View | Orientation | Samples | Error | Mirrored: pixels, error as drawn / as mirrored | Result |
| --- | --- | --- | --- | --- | --- | --- |
| photograph | north | landscape | 6657 | 4.6 | 2178, 6.8 / 60.1 | pass |
| photograph | east | landscape | 6657 | 4.9 | 5003, 5.1 / 66.7 | pass |
| photograph | north | portrait | 6641 | 4.6 | 2168, 6.8 / 60.1 | pass |
| photograph | east | portrait | 6641 | 4.9 | 4991, 5.1 / 66.7 | pass |
| cardinal | north | landscape | 4276 | 3.6 | 56, 13.6 / 65.2 | pass |
| cardinal | east | landscape | 4276 | 3.6 | 127, 18.6 / 59.6 | pass |
| cardinal | north | portrait | 6641 | 3.7 | 74, 12.7 / 74.6 | pass |
| cardinal | east | portrait | 6641 | 3.9 | 193, 19.7 / 60.2 | pass |

Error is the mean absolute difference, 0–255, between the screenshot and the source sampled at the CPU direction. Each wrong orientation (mirrored, turned 90°, 180°, 270°) is judged only on the pixels where it predicts a colour more than 24 levels from the correct one, and must fit them less than half as well.

## Entering, links, Back and Exit

- The entered photograph's immersion differs from the CPU rays by up to 7.357e-6°; after Exit the globe camera faces 359.99999879214874°, as the view did, within pitch 0.0e+0 rad, distance 0.0e+0 m and field of view 0.0e+0 rad of the view it was entered from.
- The pair: A entered 6.174e-6°, B after the link 6.174e-6°; Back returned to A: yes; after Exit the camera faces 1.8701484805205837e-11°, within pitch 0.0e+0 rad, distance 0.0e+0 m and field of view 0.0e+0 rad of the view it was entered from.
- The panorama's tab, as laid out: hidden in the overview yes, shown while entered yes, hidden after Exit yes; credits while entered: 1.
