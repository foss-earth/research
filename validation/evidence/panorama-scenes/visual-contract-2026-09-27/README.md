# Panorama visual-contract evidence

CPU reference only, 2026-09-27 UTC, Node v26.9.0. Interpretation and equations:
[visual contract](../../../../docs/validation/panorama-visual-contract.md).
No GPU, browser, network timing or interactive-usability qualification is implied.

- `fixture.json`, `photo.json`: complete configurations, source/script SHA-256,
  per-covered-ray metrics, FOV rejection and radial/boundary assertions.
- `fixture.png`, `photo.png`: columns are flat, continuous fisheye blend, immersive
  reference. Row descriptions are in each JSON's `figure.rows`.
- `photo-input.png`: retained 512 × 256 photographic input, so the compact run is
  reproducible offline. The synthetic N/E/S/W text fixture is generated in code.

From the FOSS Earth root, output stays in a new scratch folder; preserve logs:

```sh
panorama_run="build/research/panorama-contract/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
mkdir "$panorama_run"
node scripts/render-orb-appearances.mjs --contract --out "$panorama_run/fixture" > "$panorama_run/fixture.log" 2>&1
node scripts/render-orb-appearances.mjs --contract --panorama validation/evidence/panorama-scenes/visual-contract-2026-09-27/photo-input.png --out "$panorama_run/photo" > "$panorama_run/photo.log" 2>&1
```

Create the parent `build/research/panorama-contract/` once if needed. Run a fresh
timestamp each time; stop if `mkdir` reports an existing directory. The retained
records were generated in `2026-09-27T01-48-26Z`; prior scratch runs were preserved.
Omit `--out` to use the script's dated `build/research/panorama-orbs/` default.
Every assertion must pass; compare summary numbers and PNG pixels. Input basename
and output location are incidental. PNG compression can differ across zlib versions.
The script deliberately retains the historical `orthographic` appearance to
reproduce old figures, while `orthographic-blend` is the separately checked entry
mapping. Running without `--contract` exercises the old appearance-strip mode.

The photograph is Greg Zaal's
[Buikslotermeerplein](https://polyhaven.com/a/buikslotermeerplein), distributed by
Poly Haven under [CC0](https://polyhaven.com/license) (pages checked 2026-09-27).
It is the same photographic scene used by the prior research. That research's
tonemapped JPEG was converted to 2048 × 1024 PNG; this retained input was made with:

```sh
sips -s format png --resampleWidth 512 build/research/sources/buikslotermeerplein-2048.png --out build/research/panorama-contract/2026-09-27/photo-input.png
```

The preexisting 2048-pixel input SHA-256 was
`8bacd4ebbc7de0d1d736afa08a2487abfd7fe201115f39d24f75b2b09d239036`;
the retained input SHA-256 is
`9185f03a29993ebfdc989b76404352700b0ec3e2055ec2a6c13538c2c174983a`.
This downsample is for compact mapping evidence, not source-detail qualification.
Image-error metrics cannot replace the texture-independent ray errors.
