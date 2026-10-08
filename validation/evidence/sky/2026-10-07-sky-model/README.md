# Sky model on the CPU, 2026-10-07

`sky-model.json` is one run of `node scripts/validation/sky-model.mjs` at the
sources its `sources` field hashes. CPU only: no browser, GPU, network or server.
What it records and what the numbers mean: [docs/proposals/sky.md](../../../../docs/proposals/sky.md).

- `solar`: the Solar Position Algorithm against its report's worked example
  (NREL/TP-560-34302, Table A5.1).
- `light`: the Sun's, the sky's and level ground's light at the equator on an
  equinox, from the Sun overhead to 30° below the horizon, with the American
  Meteorological Society's twilight values beside the model's at 6°, 12° and 18°.
- `moon`: the Moon's place against Meeus's worked example (47.a); its light above
  the air by phase at its mean distance; and three nights over Minneapolis, a full
  Moon high, a quarter Moon at dusk and no Moon up, with the Moon's light, the sky
  it lights, level ground's light and the exposure at the default settings.
- `stars`: the catalogue's size, how many stars each limiting magnitude draws,
  the brightest star's light, all their light to magnitude 6.5, and precession
  against Meeus's worked example (21.b).
- `starsByHeight`: by day with the Sun 60° up, the sky's mean luminance from the
  ground to 400 km, the scene's exposure, what a reflected-light meter pointed at
  the sky would give, and the exposure the stars are shown at with the default
  heights of `sky.stars.daylightAltitude`.
- `accuracy`: the transmittance table against brute force; steps along a line of
  sight against 512; and the table of light on level ground that the imagery
  shader reads, against the model it samples, over its fine steps and its wide ones.
- `exposure`: through a day with no Moon, the meter's reading, what the default
  adaptation makes of it, white, and where ground of reflectance 0.3, the sky's
  mean and an emitter of 1 cd/m² fall against white; and the ground and the sky
  with exposure following the meter all of the way, for comparison.
- `cost`: build and fill times on the development Mac while in use. Not qualified
  measurements (`qualified: false`); read them as orders of magnitude.

Nothing here shows a rendered frame. This run replaces the day's earlier one, from
before the Moon, the stars, the ground's table and adaptation.
