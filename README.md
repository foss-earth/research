# foss-earth/research

Research notes, benchmarks, experiment scripts and proposals for FOSS Earth. This repository is not a runtime dependency of the application. Nothing in the app imports it, and historical citations point at the versions of the documents they were written against.

## Layout

- `docs/`: research write-ups, reviews and design notes, with proposals under `docs/proposals/`.
- `benchmarks/`: benchmark pages, inputs and recorded results (collision, EAC progressive prototype, globe comparison, map detail, scene A/B, spherical image representation, terrain, wheels).
- `scripts/`: the runnable experiment sources. `scripts/benchmarks/` has one directory per benchmark, and `scripts/lib/` holds shared helpers.
- `fixtures/`: tests and fixtures for the helpers and for the document links.
- [tools-manifest.json](tools-manifest.json): for each experiment tool, the public `@foss-earth/*` imports it uses and the host, data or native prerequisites it needs.

Results and asset files under `benchmarks/` are recorded as they were produced. Some benchmark and experiment documents refer to local data that is not in this repository, such as private photos or ignored build output.

## Helper exports

Two development helpers are exported for experiment scripts. They are not application dependencies.

- `@foss-earth/research/headless-chrome`: `openHeadlessChrome`, `connectHeadlessChrome`, `evaluate` and `waitForExpression`, for driving Chrome over pipes.
- `@foss-earth/research/output-directory`: `newOutputDirectory`, which creates dated output directories under this repository's `build/` and keeps earlier output.

Importing a helper starts no browser, server, capture or benchmark. See [tool contracts](docs/tool-contracts.md).

## Documents

Benchmarks:

- [benchmarks/ai-framegen-upscale/README.md](benchmarks/ai-framegen-upscale/README.md)
- [benchmarks/collision/README.md](benchmarks/collision/README.md)
- [benchmarks/earth-compare/README.md](benchmarks/earth-compare/README.md)
- [benchmarks/eac-progressive-prototype/INVENTORY.md](benchmarks/eac-progressive-prototype/INVENTORY.md)
- [benchmarks/eac-progressive-prototype/README.md](benchmarks/eac-progressive-prototype/README.md)
- [benchmarks/eac-progressive-prototype/REPORT.md](benchmarks/eac-progressive-prototype/REPORT.md)
- [benchmarks/eac-progressive-prototype/results/tables.md](benchmarks/eac-progressive-prototype/results/tables.md)
- [benchmarks/globe-compare/pages/cesium.html](benchmarks/globe-compare/pages/cesium.html)
- [benchmarks/globe-compare/pages/maplibre.html](benchmarks/globe-compare/pages/maplibre.html)
- [benchmarks/globe-compare/pages/worldwind.html](benchmarks/globe-compare/pages/worldwind.html)
- [benchmarks/map-detail/README.md](benchmarks/map-detail/README.md)
- [benchmarks/map-detail/sweep.html](benchmarks/map-detail/sweep.html)
- [benchmarks/scene-ab/README.md](benchmarks/scene-ab/README.md)
- [benchmarks/spherical-image-representation/INVENTORY.md](benchmarks/spherical-image-representation/INVENTORY.md)
- [benchmarks/spherical-image-representation/README.md](benchmarks/spherical-image-representation/README.md)
- [benchmarks/spherical-image-representation/REPORT.md](benchmarks/spherical-image-representation/REPORT.md)
- [benchmarks/spherical-image-representation/results/tables.md](benchmarks/spherical-image-representation/results/tables.md)
- [benchmarks/terrain/README.md](benchmarks/terrain/README.md)
- [benchmarks/wheels/README.md](benchmarks/wheels/README.md)
- [benchmarks/wheels/README.reference-kernels.md](benchmarks/wheels/README.reference-kernels.md)

Documents and proposals:

- [Shared AI upscaling and frame generation proposal](docs/proposals/ai-framegen-upscale.md) —
  staged implementation, shared contracts, opt-in controls and acceptance gates
  for FOSS Earth applications, including the UMN tour.
- [Shared AI frame generation and upscaling review](docs/ai-framegen-upscale.md) —
  opt-in reconstruction for FOSS Earth apps, including the UMN tour; source
  corrections, shared ownership and an experiment plan. The
  [original report](docs/sources/ai-framegen-upscale-original.md) is preserved as
  reviewed evidence, not an implementation guide.
- [RIFE and RT4KSR on ONNX Runtime Web](docs/ai-framegen-upscale-models.md) — pinned
  sources, input contracts, export choices, WebGPU runtime behavior and early quality
  observations from building the Stage 1 harness.
- [docs/360-images-virtual-tour-research.md](docs/360-images-virtual-tour-research.md)
- [docs/360-images-virtual-tour-review.md](docs/360-images-virtual-tour-review.md)
- [docs/camera-pivot-and-zoom-prompt.md](docs/camera-pivot-and-zoom-prompt.md)
- [docs/globe-comparison.md](docs/globe-comparison.md)
- [docs/performance-pass.md](docs/performance-pass.md)
- [docs/proposals/navigation-anchors.md](docs/proposals/navigation-anchors.md)
- [docs/proposals/raster-terrain-performance.md](docs/proposals/raster-terrain-performance.md)
- [docs/proposals/research/gamepad-studio-agent-prompt.md](docs/proposals/research/gamepad-studio-agent-prompt.md)
- [docs/proposals/research/gamepad-studio-research.md](docs/proposals/research/gamepad-studio-research.md)
- [docs/proposals/research/gamepad-tools-agent-prompt.md](docs/proposals/research/gamepad-tools-agent-prompt.md)
- [docs/proposals/research/gamepad-tools-research.md](docs/proposals/research/gamepad-tools-research.md)
- [docs/proposals/research/gamepad.md](docs/proposals/research/gamepad.md)
- [docs/proposals/research/panorama-scenes-proposal-prompt.md](docs/proposals/research/panorama-scenes-proposal-prompt.md)
- [docs/proposals/research/panorama-scenes-research-review.md](docs/proposals/research/panorama-scenes-research-review.md)
- [docs/proposals/research/panorama-scenes-research.md](docs/proposals/research/panorama-scenes-research.md)
- [docs/proposals/research/weather-research-prompt.md](docs/proposals/research/weather-research-prompt.md)
- [docs/proposals/research/weather-research.md](docs/proposals/research/weather-research.md)
- [docs/proposals/wheel-roadmap-handoff.md](docs/proposals/wheel-roadmap-handoff.md)
- [docs/proposals/wheel-simulation-options.md](docs/proposals/wheel-simulation-options.md)
- [docs/validation/benchmark-interference.md](docs/validation/benchmark-interference.md)
- [docs/validation/timing.md](docs/validation/timing.md)
- [docs/webgl-panorama-performance-review.md](docs/webgl-panorama-performance-review.md)

Also present: [docs/tool-contracts.md](docs/tool-contracts.md) (helper contracts).

## Development

This package lists several `@foss-earth/*` libraries as dev dependencies (`images`, `engine`, `renderer`, `ui`, `cubemap`, `equirectangular`) by versions that are not published yet. Its own `npm install` and checks therefore do not work on their own. Libraries that use these helpers, such as [sky](https://github.com/foss-earth/sky), reach them through the app, which uses libraries straight from their checkouts: see [Local source](https://github.com/foss-earth/app#local-source).

Scripts in `package.json`: `check:links`, `check:tools`, `test:source`, `check:source`, `check:public-ports`, `test:consumer`, `check:implementation` and `ci`.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
