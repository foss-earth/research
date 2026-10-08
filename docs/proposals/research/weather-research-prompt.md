# Next task: research how to implement weather

Copy the prompt below into the next agent conversation.

---

Work in `/Users/felg/gh/foss-earth`, with 0sfs at `/Users/felg/gh/0sfs` and the
JSBSim checkout at `/Users/felg/gh/Felipegalind0/jsbsim` beside it. Read FOSS
Earth's `AGENTS.md` and 0sfs's `AGENTS.md` first. Both apply to this task.

This is research, and it needs the web: to read primary sources and to see what
data services return. If you cannot reach it, say so and stop. A survey written
from memory is what this task replaces.

## What this is for

The user wants weather in 0SFS, a flight simulator that runs in a browser, and in
FOSS Earth, the globe it is built on. Today weather is two sliders, wind direction
and wind speed. The step after yours is an implementation proposal of the kind
`docs/proposals/sky.md` is. A review on 2026-10-08 of everything written so far
found that such a proposal cannot be drafted yet. The research covers one corner of
the problem, how to draw clouds, and the one document on it cannot be relied on.

Your task is the research that makes the proposal draftable. You are not writing
the proposal, and you are not building anything.

It is finished when every question below has one of three kinds of answer:

- a recommendation, with its evidence;
- a decision that is the user's, with the options and what each costs;
- an experiment the proposal must run, with what its result would settle.

Someone who has read only your document should be able to draft the proposal.

## What exists

Checked on 2026-10-08 by reading the three checkouts. Check again before you rely
on any of it: other sessions are changing these trees.

**In the flight.** The Weather tab is `WeatherPanel` in
`0sfs/src/flight/hud/FlightControlPanel.tsx`: wind direction, wind speed and Clear
wind. `applyWeather` in `0sfs/src/flight/createFlightSimApp.ts` writes them to
`atmosphere/wind-north-fps` and `atmosphere/wind-east-fps`. That is one steady wind
for the whole atmosphere, the same at every height and place. The two sliders are
not parameters in the settings registry. The tab starts calm every session, and a
saved flight leaves out `atmosphere/*` on purpose
(`0sfs/src/flight/jsbsim/savedFlight.ts`).

**In JSBSim, unused.** The engine models much more than the application asks of it,
all of it reachable through the SDK's `setPropertyValue`:

- `FGWinds` (`src/models/atmosphere/FGWinds.cpp`): a vertical wind, gusts, a
  one-minus-cosine gust, a random seed, and four turbulence models chosen by
  `atmosphere/turb-type`: standard, Culp, and two Dryden spectra, Milspec and
  Tustin, with their inputs under `atmosphere/turbulence/milspec/`.
- `FGStandardAtmosphere`: a temperature offset (`atmosphere/delta-T`,
  `atmosphere/SL-graded-delta-T`), sea-level pressure (`atmosphere/P-sl-psf`) and
  humidity (`atmosphere/RH`, `atmosphere/dew-point-R`).
- Up- and down-burst cells are in `FGWinds`, but only their count is bound to a
  property. The rest are commented out.

No document lists these. Beyond the wind, the application uses none of them: its
flight model driver writes the temperature offset and the vertical wind as zero
when a flight starts, and only the SF50 calibration scripts, which run native
JSBSim, set a temperature. Nothing has run gusts, turbulence, pressure or humidity
in the WASM build.

0sfs installs the tarball named in its `package.json` (`fork.16` today), not the
checkout, which is on a feature branch. The installed package's `buildIdentity`
names the commit it was built from, and `0sfs/docs/jsbsim.md` explains the rest.

**The sky.** `docs/proposals/sky.md` is the spec, and the model for how a proposal
here reads. Its rungs 0 to 2 are built: the Sun, the Moon, the stars, a clear
atmosphere, one scale of luminance in lux and cd/m², metered exposure, and the Sky
and Date and time tabs that the globe and the flight share. What matters to
weather:

- The air is clear everywhere. Haze is one number for the planet,
  `sky.atmosphere.aerosolOpticalDepth`. The spec's own list of what is not
  modelled starts with clouds and water vapour.
- Rung 3, planned, is the sky per pixel, and aerial perspective. Rung 4, planned,
  is volumetric clouds on WebGPU, and the spec says it "needs weather input and
  clouds that cast light, which nothing here has yet".
- The time can be set to any instant, so the view can be of last June.
- None of it is committed. `src/sky/`, the spec and its checks are untracked files
  in FOSS Earth, and the flight's side is uncommitted in 0sfs. No automated check
  has drawn it on a real GPU. The user has flown it once.

**The earlier research.** `0sfs/docs/proposals/skies.md`, from September. Take
leads from it and no facts:

- It stops in the middle of its fourth section. Its summary promises weather
  driven by METAR reports and clouds reconstructed over frames. The body reaches
  neither.
- Its `[cite: n]` markers point at a list of references that is not in the file.
- It builds on Babylon 9's atmosphere addon. This checkout has `@babylonjs/core`
  8.56.2 and no `@babylonjs/addons`.
- Its timings name no device or resolution, and their sources cannot be followed.

**Specs that already say something about weather.**

- `0sfs/docs/proposals/sf50-flight-model-v2.md`: a flight's export records its
  weather and seed, weather obeys the driver's generation boundary, and changing
  aircraft keeps the world's weather.
- `0sfs/docs/proposals/ardupilot-sitl.md`: JSBSim owns wind, and the autopilot
  gets its air data from it.
- `0sfs/docs/sound.md`: airframe wind noise from airspeed. Nothing for rain,
  thunder or wind on the ground.
- FOSS Earth's `TODO.md`, under night lights: a second data provider learns which
  area is viewed, so whether it is on by default is the user's to decide. Live
  weather raises the same question.

**Source on this machine**, under `0sfs/build/`. Never delete from it.

- `competitors/src/Prograda_Skybolt`: volumetric clouds with temporal upscaling,
  cloud shadows, and Bruneton's atmosphere with clouds in it. MPL-2.0.
- `research/simgear`: FlightGear's METAR parser, precipitation and cloud layers,
  in `simgear/environment` and `simgear/scene/sky`. Its `COPYING` gives the
  licence.
- The two FlightGear snapshots are partial, and neither has its weather code:
  `src/Environment`, and the local weather in its data package.

**Nothing has been written on:** where weather data would come from; how weather
is represented; turbulence, shear or thermals; temperature and pressure;
visibility, fog, precipitation, icing or lightning; weather on the instruments or
in the sound; how any of it is saved, replayed or tested.

## The questions

These are the ones the review could see. If the work shows a more important one is
missing, answer it and say why. They are in the order the proposal needs them. The
first four block it, and no document here touches them, so most of the effort
belongs there. Drawing clouds comes fifth because it is the one part with leads
already.

### 1. What weather is, here

For each phenomenon, say what a pilot sees, feels and hears; which parts it
touches (JSBSim, the sky and its light, the terrain, sound, instruments,
settings); what a credible version needs; and whether a globe with no aircraft
wants it. At least: wind and how it changes with height; gusts and turbulence;
shear and microbursts; thermals, ridge lift and mountain wave; temperature,
pressure and density; humidity; clouds by layer and kind; haze, mist and fog;
rain, snow and hail; icing; thunderstorms and lightning; wet and contaminated
runways.

Recommend an order to build them in, with the reason for each one's place. Which
of them 0SFS has at all is the user's decision. Give them the table to make it
with.

### 2. One state of the weather

The rest hangs on this question. It is also why this is one task, and not one for
the renderer and another for the flight model. What is seen and what the aircraft
feels have to come from the same state. The aircraft enters cloud at the height
the cloud is drawn at. The wind that drifts the cloud is the wind on the wing.
Rain falls from the cloud that is there. The runway appears at the distance the
reported visibility says.

Propose that state: its quantities and units, and its resolution in place, height
and time. Say how it is read at a point (the aircraft's, 120 times a second,
cheaply, and the same every time for the same seed) and over a volume (what the
renderer draws). Say how a sparse report, a few numbers at one airport, and a
forecast grid, a field over heights and hours, both become it, and what fills the
gaps between them. Say how it changes over time, and what a saved flight would
have to keep to reproduce it.

Read how FlightGear (its basic and its advanced weather), X-Plane and Microsoft
Flight Simulator represent weather, from their own documentation, and from source
where there is any. Say what each got right and what it cost them.

### 3. Where the weather comes from

Compare three sources: set by hand, generated from a seed, and the real world's.

For real weather, check the candidates yourself. None has been checked. They
include aviation reports (METAR, TAF, winds aloft), forecast models (GFS, ICON,
HRRR, ECMWF's open data) and the services that repackage them, and satellite and
radar imagery. NASA GIBS is one lead: the night-lights entry found it to need no
key and to allow cross-origin requests, and it lists cloud and precipitation
layers, which nobody here has looked at. For each candidate:

- its licence and the credit it asks for;
- whether it needs a key or an account;
- whether a page can fetch it directly. Make the request with an `Origin` header
  and record the response, as `docs/airport-locations.md` did for airports;
- its limits and terms for an application like this one;
- its coverage, resolution, how often it updates and how late it runs;
- the size and format of a response, and what decoding it costs in a browser,
  GRIB2 especially;
- what the provider learns about the person using the application;
- whether it has the past as well as the present, for a time set on the Date and
  time tab.

Both applications are static files on GitHub Pages, published by hand from the
user's machine. The project runs no server. A source the page cannot fetch by
itself is not ruled out, but say exactly what it would need.

### 4. What the aircraft feels

List what JSBSim's atmosphere and winds can do, from the source at the version
0sfs installs: each property, its unit, what it does, where it is valid, and
whether you ran it. Run the installed WASM package for anything that rests on
behaviour. `0sfs/scripts/check-jsbsim-runtime-parity.mjs` shows how to load it
from Node.

Then the gaps:

- JSBSim has one wind. How does the application give it one that changes with
  height and place? If it writes the wind each step from the weather state, what
  does that cost? Does a changing wind produce the forces a real shear would, or
  false ones?
- Which turbulence model is credible, and for what? What are their inputs, how do
  they behave at a 120 Hz step, and what faults are known upstream?
- What do a temperature and a pressure off standard do to the turbine models, and
  to the SF50's calibrated performance?
- JSBSim has no rain, icing or runway contamination. What is the least model that
  is honest, and is leaving one out the better answer?

For each gap, say whether it is application work in 0sfs or an engine change. An
engine change goes upstream, under
`0sfs/docs/jsbsim-upstream-contribution-policy.md`.

### 5. What is seen

The sky is a ladder. Every rung shares one model and one scale of luminance, the
user chooses the rung, and the runtime draws through WebGPU, WebGL 2 and WebGL 1.
Weather has to join that. So the question is not which cloud renderer is best. It
is what each rung and each backend can hold.

Cover clouds, visibility (aerial perspective, haze layers, fog), precipitation,
lightning, and the shadows clouds cast. For each option give:

- what it draws;
- the work each frame, and each time the weather changes;
- the GPU memory;
- what it needs from the weather state;
- how it joins the scale of luminance. Clouds are lit by the same Sun, Moon and
  sky, in cd/m². An overcast changes the lux on the ground, what the meter reads
  and so the exposure. The spec's light from the ground has to see it too.

The usual sources skip three things that this project cannot:

- One view goes from a runway to orbit. A method that works only from below the
  cloud is not enough. Say how each option holds on the ground, in cloud, above it
  and from 20,000 km, and what the floating origin does to it.
- The globe draws a frame only when what it shows has changed
  (`docs/render-on-demand.md`). Clouds drift and rain falls. Say what each option
  costs a view that is otherwise still, and what would let the user decide how
  much motion to pay for.
- Every value that decides what is computed, kept or downloaded is a named
  parameter with a unit (`docs/proposals/settings.md`). Say what each option's
  parameters would be. A quality level is not one.

Read the published methods first-hand. Read the open implementations with their
licences: Skybolt's on this machine, and Babylon's own atmosphere addon with
whatever it has for clouds, in the installed version and in the current one. Do
not benchmark. Give costs from sources that name their device and resolution, and
list the numbers the proposal will have to measure for itself.

### 6. The rest, briefly

- Sound: what weather adds, against `0sfs/docs/sound.md`.
- Instruments: altimeter setting, outside air temperature, wind.
- The tab: Weather is the flight's today. Sky and Date and time became shared
  tabs that take a host's sections. Say which sections of Weather a globe wants
  and which are the flight's.
- Saving and replay: wind is left out of a saved flight today. What should be
  kept?
- Testing: what can be checked on the CPU, as the sky's model was, and what
  cannot.

### 7. Who owns what

Place each piece by the two questions in `0sfs/AGENTS.md`: is it still correct
with no aircraft in the scene, and would a globe application want it. The likely
answer is that the weather state, its sources, what is drawn and the shared tab
are FOSS Earth's, what the aircraft feels is 0sfs's, and the atmosphere and wind
models are JSBSim's. Check each piece, and say where it is not clear.

## Where this goes wrong

- The easy research is another survey of cloud rendering. `skies.md` was one, and
  it left the proposal no nearer. The state, the source of the data and the
  coupling to the flight model are what block it.
- Writing on this subject is full of frame times and memory figures with no
  device, resolution or method behind them. Such a number is not a finding. Leave
  it out, or give it as a claim with its source's name on it.
- A technique described for one renderer and one camera height is not shown to
  work across three backends and from the ground to orbit. Say what is shown and
  what is your inference.
- The sky this builds on is uncommitted, and no check has drawn it on a GPU. Say
  which of your findings depend on a part of it that may still change.

## Evidence

Mark each claim as one of four kinds:

- read in a primary source: a paper, a specification, a source file at a commit,
  or a service's own documentation, with the link and the date you read it;
- observed by you, with the command and its output kept;
- reported by someone else, and by whom;
- your own inference.

Go through the claims in `skies.md` that a proposal might lean on, and give each a
status: confirmed, corrected or not checkable. Leave the file as it is.

FOSS Earth and 0sfs are AGPL-3.0-only, and each offers other terms beside that
(`COMMERCIAL_LICENSE.md`). For each implementation you study, say whether its code
could be included or only learned from. Copy none of it into the research.

## Limits

- Research only. Change no application code, settings or existing document.
  Scripts that check a claim are welcome. Each repository's `AGENTS.md` says where
  scripts, their output and retained evidence go.
- Start no dev, preview or watch server, run no GPU benchmark and open no visible
  browser. Fetching a response from the terminal is fine.
- In requests to outside services, identify yourself as `foss-earth-check/1.0` and
  send nothing personal. For a place, use a public airport such as KMSP, never
  this machine's location. Create no account and give no contact details. Where a
  service wants a key, record that and ask the user.
- Other sessions have uncommitted work in all three checkouts. Touch only files
  you create. Do not stage, revert or tidy anything else.
- Do not commit or push. The user reads the research first.

## What to deliver

Write `docs/proposals/research/weather-research.md` in FOSS Earth, shaped like
`docs/proposals/research/panorama-scenes-research.md`: the date and the owner;
what was verified and what was not; the findings in brief; a section for each
question; the decisions for the user; references. Its readers are the user and
whoever drafts the proposal. Write plain statements with units, and no praise of
a technique.

Ask the user only what changes what you research, such as whether real-world
weather is wanted at all. Carry on with whatever does not wait on the answer.

End your last message with four things: whether a proposal can now be drafted;
the decisions the user has to make first; the experiments its first stage should
run; and what you could not establish, with the reason.
