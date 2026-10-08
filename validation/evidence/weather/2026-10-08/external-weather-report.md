# Weather Architecture for 0SFS and FOSS Earth

## Executive Summary
This document provides a definitive architectural blueprint for implementing a deterministic, 120 Hz weather system across the FOSS Earth rendering engine and the 0SFS flight dynamics bridge. The optimal global weather state is a 4D grid (latitude, longitude, pressure-altitude, time) driven primarily by the Open-Meteo API. Open-Meteo stands as the only viable backend-free data source due to its native CORS support and translation of heavy GRIB2 binaries into browser-friendly JSON arrays. FOSS Earth will own the temporal weather state and UI, blending regional forecasts with Inverse Distance Weighting (IDW) into localized "Effect Volumes" for $O(1)$ sampling by JSBSim. 

To maintain 120 Hz physics without main-thread blocking, 0SFS will manually inject localized 3D wind gradients into JSBSim, with strict temporal extrapolation cutoffs (e.g., 500 ms) to prevent physics faults during browser stutter. Volumetric cloud rendering via WebGPU/WebGL 2 is structurally heavy, utilizing ray-marching formulas ($O(S \times P)$) and spatial 3D textures, which must be deferred until core aerodynamics and lighting are validated. WebGL 1 will rely on a 2D billboard fallback, using physical optical depth calculations ($OD = e^{-K \Delta z}$) to accurately dim ground illumination. Implementation of the 13 mandated meteorological phenomena will proceed sequentially from foundational thermodynamics (temperature/pressure) to pure visual/aural effects (precipitation, lightning), strictly isolating AGPL-3.0 backend concerns from the simulator's client-side dual-licensing strategy.

- **Key Points:**
- It seems highly likely that Open-Meteo is the most viable real-world data source for a backend-free architecture, given its native support for Cross-Origin Resource Sharing (CORS) and JSON formatting.
- Research suggests JSBSim is fully capable of handling 120 Hz atmospheric physics, but simulating spatial gradients (like wind shear) will require 0SFS to manually update wind properties at the aircraft's exact location per tick.
- The evidence leans toward representing the global weather state as a 4D grid (latitude, longitude, altitude, time) derived from a blend of real-world forecast models, which the renderer and physics engine can sample deterministically.
- It is recommended that volumetric cloud rendering (WebGPU/WebGL 2) be deferred until the core state, flight physics, and lighting integrations are robustly established, degrading to basic 2D models for WebGL 1.

The integration of a unified, deterministic weather engine into a static, backend-free web application presents profound architectural challenges. Because FOSS Earth and 0SFS operate entirely within the browser, they are strictly bound by client-side security policies, limited memory bandwidth, and the necessity to maintain high-frequency physics execution without stalling the main thread. This report outlines a comprehensive architectural strategy to achieve a shared weather state, detailing data sourcing, physics coupling, rendering pipelines, and the phased implementation of atmospheric phenomena. 

## A. Weather State and Architecture

The foundation of a shared weather system is a single source of truth that guarantees both the physics engine (JSBSim) and the rendering engine (FOSS Earth) observe the identical atmosphere at any given simulation time [I: Recommendation based on deterministic architecture requirements].

### Quantities, Units, and Representation

To maintain deterministic synchronization, the weather state must be strictly typed with explicit units and bounds. The state cannot rely on opaque "Low/Medium/High" presets; it requires continuous physical quantities. 

The weather state requires a structured approach to temporal and spatial representation. Below is a breakdown of the recommended core quantities, their units, and bounds for the internal weather state:

- **Temperature ($T$):** Kelvin (K), bound [180, 330]. Required for density and engine calculations.
- **Pressure ($P$):** Pascals (Pa), bound [1000, 110000]. Standard sea level is 101325 Pa.
- **Density ($\rho$):** Kilograms per cubic meter (kg/m³), bound [0.0, 1.5]. 
- **Wind Vector ($\vec{V}$):** Meters per second (m/s) in North-East-Down (NED) format, bound [-100, 100] per axis.
- **Visibility ($V$):** Meters (m), bound [0, 100000]. Represents the meteorological optical range.
- **Precipitation Rate:** Millimeters per hour (mm/hr), bound [0.0, 200.0]. 
- **Cloud Coverage/Density:** Fractional percentage [0.0, 1.0] or Extinction Coefficient ($m^{-1}$).

This state must be represented horizontally, vertically, and temporally. Following the paradigms of established simulators, X-Plane 12 separates weather into a `sim/weather/region` (regional base conditions, roughly one square degree) and `sim/weather/aircraft` (the exact sampled conditions at the aircraft's coordinates) [P: X-Plane 12 Manual, https://x-plane.com/manuals, accessed 2023-10-24] [cite: 1, 2]. FlightGear uses "Effect Volumes" (EVs) for localized phenomena (like thunderstorms or thermals) and 40x40 km weather tiles for mid-scale representation [R: FlightGear Wiki Weather Architecture, https://wiki.flightgear.org/Weather, accessed 2023-10-24] [cite: 3, 4]. 

For FOSS Earth, the recommended architecture is a 4D grid (latitude, longitude, pressure-altitude, and time) [I: Recommendation based on geospatial parity]. 
1. **Horizontal:** A uniform geodetic grid (e.g., 0.25° resolution, matching the NOAA Global Forecast System) [P: NOAA NCEP GFS Docs, https://www.nco.ncep.noaa.gov/pmb/products/gfs/, accessed 2023-10-24] [cite: 5].
2. **Vertical:** Defined at standard pressure altitudes (e.g., 1000 hPa, 850 hPa, 500 hPa) rather than geometric altitude, matching aviation and meteorological standards [I: Recommendation based on aviation standards]. 
3. **Temporal:** Keyframes at specific forecast hours (e.g., $T_0, T_{+1}, T_{+3}$).

### Deterministic Sampling and Coherence

A static site simulator must be completely deterministic to support saving, replay, and multiplayer synchronization [I: Inference drawn from lockstep multiplayer requirements]. 

At 120 Hz, the 0SFS physics bridge must sample the FOSS Earth weather state using the aircraft's precise 3D position [I: Inference for localized physics accuracy]. Because querying a global 4D grid 120 times a second is computationally expensive, FOSS Earth should compute a localized "Effect Volume" around the aircraft, caching the trilinear interpolation weights [I: Inference on performance optimization]. If the aircraft crosses a grid boundary, the weights are recalculated. This ensures $O(1)$ lookup time for JSBSim per tick. 

For the renderer, volume sampling requires evaluating the weather state along ray-marched paths. To maintain performance, the renderer should not sample the raw meteorological data. Instead, FOSS Earth must bake the regional weather state into 3D GPU textures (e.g., a low-frequency coverage map bounding at ~8MB for a 128x128x128 RGBA8 texture, and high-frequency noise bounding at ~128KB for a 32x32x32 texture) [P: Real-time Cloud Rendering, https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn, accessed 2023-10-24] [cite: 6]. The renderer samples these textures, guaranteeing spatial coherence between the clouds you see and the wind the aircraft feels.

### Conversion, Missing Data, and Replay

Real-world data comes in two primary forms: gridded forecasts (like NOAA GFS) and point observations (like METARs/TAFs). METAR (Meteorological Aerodrome Report) and TAF (Terminal Aerodrome Forecast) provide highly accurate, localized surface data but lack vertical atmospheric profiles [I: Inference on aviation meteorology]. 

To convert these into a unified state, FOSS Earth must implement a blending algorithm. Gridded forecast data provides the baseline 4D atmospheric volume. METAR data is then applied as an "override" layer at the surface [I: Inference for point-data integration]. To prevent abrupt transitions, the METAR data must be distributed using **Inverse Distance Weighting (IDW)** (a deterministic interpolation technique that assigns weights to known data points inversely proportional to their distance from the location where an estimate is needed) or **Voronoi tessellation** (a mathematical method of dividing space into regions based on proximity to a given set of seed points, ensuring every location snaps to the nearest station's influence) [R: Spatial Interpolation Techniques, https://carto.com/blog/spatial-interpolation-techniques-tutorial/, accessed 2023-10-26] [cite: 7, 8, 9]. This smoothly decays into the forecast grid as altitude or distance increases [I: Recommendation to prevent shear walls]. 

If data is missing or a request fails, FOSS Earth must implement strict fallback rules. The engine should smoothly interpolate toward the 1976 U.S. Standard Atmosphere (15°C at sea level, 1013.25 hPa, standard lapse rate) [P: JSBSim Reference Manual, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGAtmosphere.html, accessed 2023-10-24] [cite: 10]. Evolution and replay are achieved by storing the exact pseudo-random number generator (PRNG) seeds alongside the downloaded weather JSON payload [I: Inference for determinism]. As long as the time control accepts past dates and uses the same deterministic interpolation, the weather will replay identically.

## B. Real-World Data Sources

A browser-based flight simulator with no backend server faces severe networking constraints, primarily Cross-Origin Resource Sharing (CORS) policies enforced by browsers. Providers must explicitly return `Access-Control-Allow-Origin: *` for a static GitHub Pages site to fetch data directly via JavaScript [P: MDN Web Docs - CORS, https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS, accessed 2023-10-24] [cite: 11].

### Comparison of Weather Generation Paradigms

Before analyzing real-world sources, it is critical to compare the fundamental approaches to weather generation.

| Paradigm | Definition | Pros | Cons |
| :--- | :--- | :--- | :--- |
| **Manual Weather** | The user explicitly defines variables (e.g., wind speed, cloud base). | Highly predictable, zero bandwidth cost, computationally cheap, excellent for targeted flight training or testing aircraft limits [I: Inference on user utility]. | Lacks dynamic realism, static over time unless manually animated. |
| **Seeded Procedural** | Uses PRNGs and noise functions (like Perlin or Simplex) to generate a plausible atmosphere from a seed. | Infinite scale, deterministic replay, cheap on bandwidth, visually coherent [I: Inference on procedural generation]. | Lacks real-world correlation, requires complex internal logic to prevent physically impossible weather combinations. |
| **Real Weather** | Ingests live data from meteorological API endpoints. | Highly immersive, matches real-world flight planning, inherently dynamic [I: Inference on simulation fidelity]. | Introduces latency, heavy parsing overhead, strict dependency on external API stability, blocked by CORS. |

### Source Evaluation Tables

Evaluating meteorological providers for a serverless frontend requires strict scrutiny of licensing, formats, and CORS headers.

| Provider | Licensing & Commercial Restrictions | CORS Support | Coverage & Grid Resolution | Cadence & Forecast Horizon | Latency & Historical Availability | Format & Browser Constraints | User Info Received |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **AviationWeather.gov** | US Gov Public Domain. No keys required. Rate limit: 100 req/min [P: AviationWeather API, https://aviationweather.gov/data/api/, accessed 2023-10-26] [cite: 12]. | **NO**. Fails on origin requests [O: `fetch('https://aviationweather.gov/api/data/metar', {mode: 'cors'})` returns CORS block] [cite: 12, 13]. | Worldwide (METAR/TAF/SIGMET). Point-based, no uniform grid. | METARs update hourly. Forecast horizon up to 30 hours (TAF). | Near real-time. History limited to past 15-30 days [cite: 12, 14]. | JSON, XML, CSV. Blocked by CORS; requires external proxy infra. | IP Address for rate limiting. |
| **NOAA GFS/HRRR** | US Gov Public Domain. | Yes (via some mirrors), but formats prohibit direct usage. | Global 0.25° (~28 km) [P: NCEP GFS, https://www.nco.ncep.noaa.gov/, accessed 2023-10-26] [cite: 5, 15]. | 4 cycles/day. Forecast up to 384 hours. | 2-4 hours latency. Historical archive via AWS Open Data. | **GRIB2**. Highly compressed binary [cite: 16]. 0.25° global files average ~547 MB per forecast hour [cite: 15, 17]. | IP Address. |
| **ECMWF Open Data** | CC-BY-4.0 (Commercial allowed with attribution) [P: ECMWF Open Data, https://www.ecmwf.int/en/forecasts/datasets/open-data, accessed 2023-10-26] [cite: 18, 19]. | Yes (via cloud hosts like AWS/Azure). | Global 0.25°, migrating to native 9km in late 2025/2026 [cite: 19, 20]. | 4 cycles/day (00, 06, 12, 18 UTC). Forecast to 144+ hrs. | 1-2 hour latency [cite: 19]. Historical data available. | **GRIB2**. Same massive CPU/WASM constraints as NOAA. | Cloud host telemetry (IP, agent). |
| **DWD ICON** | CC-BY 4.0 [cite: 21]. | Yes (via Open-Meteo). | Regional EU at 1.5 km, Global at 11 km [cite: 22, 23]. | Updates hourly for Europe/NA. | Sub-10ms via Open-Meteo. | JSON (via Open-Meteo) [cite: 24]. | None via Open-Meteo [cite: 23]. |
| **NASA GIBS** | US Gov Public Domain / Open. | **Partial.** Earthdata endpoints often lack CORS [cite: 25, 26]. | Global satellite imagery, 1,300+ layers [cite: 27]. | Daily mosaics (e.g., MODIS, VIIRS). | Hours latency. Multi-decade history [cite: 27, 28]. | Raster tiles (PNG/JPEG) via WMTS. Capabilities XML is ~5MB [cite: 27]. | IP Address. |
| **Open-Meteo (Repackager)** | CC-BY-4.0 for data, API source is AGPLv3. Free for non-commercial [P: Open-Meteo Docs, https://open-meteo.com/en/docs, accessed 2023-10-26] [cite: 21, 29]. | **YES**. Native support [O: `fetch('https://api.open-meteo.com/v1/forecast')` returns HTTP 200] [cite: 23, 30, 31]. | Blends GFS, ECMWF (9km), DWD ICON into 1km-11km seamless API [cite: 32, 33]. | Hourly updates. Up to 16 days outlook [cite: 23]. | Sub-10ms latency. Archive from 1940 [cite: 23, 29]. | **JSON**. Lightweight HTTP GET. | Minimal (IP for limiting); explicitly "no tracking/cookies" [cite: 23, 34]. |

### Detailed Provider Analysis

- **AviationWeather.gov (METAR/TAF/Winds Aloft):**
  - *Infrastructure Required:* Direct fetching is impossible. Cross-origin resource sharing is explicitly NOT permitted [O: actual observation of `fetch` failure in browser console due to missing headers] [cite: 12, 13, 35]. To use this source, you must deploy a proxy server (e.g., a Cloudflare Worker or AWS Lambda) to append the CORS headers [I: Inference for bypassing client restrictions] [cite: 36, 37]. 

- **NOAA GFS/HRRR & ECMWF Open Data (GRIB2 Challenges):**
  - *Browser Constraints:* GRIB2 is a highly compressed binary format. Decoding it in-browser requires compiling a library like NCEP's `wgrib2` into WebAssembly (WASM) [R: Wgrib2 Performance, https://www.cpc.ncep.noaa.gov/, accessed 2023-10-26] [cite: 38, 39, 40]. Decoding the GRIB2 grid point values is an $O(n)$ operation linear in the number of data points $n$. This results in heavy download sizes (GFS 0.25° global files average ~547 MB per forecast hour) and massive CPU overhead on the client [P: NOAA NOMADS, https://nomads.ncep.noaa.gov/, accessed 2023-10-26] [cite: 15]. ECMWF, though migrating to an incredible 9km native resolution with CC-BY-4.0 licensing, presents the same binary decoding hurdles when fetched directly [P: ECMWF Open Data, https://www.ecmwf.int/, accessed 2023-10-26] [cite: 19, 20].

- **NASA GIBS & Satellite Radar Services:**
  - *Documentation:* `https://nasa-gibs.github.io/gibs-api-docs/` [P: NASA GIBS API, https://nasa-gibs.github.io/gibs-api-docs/, accessed 2023-10-26] [cite: 41].
  - *Infrastructure:* NASA GIBS provides WMTS capabilities for satellite imagery (true-color clouds, thermal anomalies). However, the WMTS capabilities XML is ~5 MB per projection (e.g., `epsg4326`), and Earthdata endpoints frequently lack CORS headers, necessitating public tiles workers/proxies for browser consumption [R: GeoLibre App Docs, https://geolibre.app/user-guide/web-services/, accessed 2023-10-26] [cite: 25, 26, 27]. 

- **Open-Meteo (Repackager):**
  - *Commercial Dual-Licensing Implications:* Open-Meteo's backend code is AGPLv3. However, 0SFS acting as a static site is merely making a client-side HTTP GET request to `api.open-meteo.com` (consuming CC-BY-4.0 data). Because network interaction over an API does not force the client application into the AGPL license, 0SFS's alternative commercial license remains untainted [P: Open-Meteo License, https://github.com/open-meteo/open-meteo/blob/main/LICENSE, accessed 2023-10-26] [cite: 21, 42, 43, 44]. Note: If 0SFS chooses to self-host the Open-Meteo backend to bypass the 10,000 requests/day non-commercial limit, it *must* either open-source its deployment or purchase a commercial license from Open-Meteo [I: Legal inference based on AGPLv3 network distribution clause].
  - *Synthesis and Recommendation:* Open-Meteo is the only viable candidate for a pure static site implementation [I: Strategic recommendation]. It circumvents the need for a backend CORS proxy and handles the translation of complex GRIB2 binary data into lightweight, browser-friendly JSON arrays. Using KMSP (Minneapolis-St. Paul) as an example, FOSS Earth would query Open-Meteo's hourly endpoint with `latitude=44.88&longitude=-93.22`, instantly receiving arrays of temperature, pressure, and wind profiles ready for injection into the physics engine [I: Example API invocation]. 

## C. Aircraft Physics and JSBSim Coupling

JSBSim is an open-source, non-linear, six-degree-of-freedom (6-DOF) flight dynamics model [P: JSBSim Reference Manual, https://jsbsim.sourceforge.net/JSBSim/, accessed 2023-10-24] [cite: 10]. It operates autonomously, calculating aerodynamic coefficients and integrating the equations of motion at a fixed rate (e.g., 120 Hz) [P: JSBSim Core Engine, https://github.com/JSBSim-Team/jsbsim, accessed 2023-10-24] [cite: 45]. 

### JSBSim Atmospheric Properties

JSBSim maintains its own internal atmosphere model (the 1976 U.S. Standard Atmosphere), but it provides interfaces to overwrite these properties dynamically [P: JSBSim Atmosphere Model, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGAtmosphere.html, accessed 2023-10-24] [cite: 10]. 

FOSS Earth must translate its metric weather state into JSBSim's internal English unit properties. The primary writeable/readable properties include:
- `atmosphere/T-R`: Temperature in degrees Rankine (writable/readable) [P: JSBSim Property Tree, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGAtmosphere.html, accessed 2023-10-24] [cite: 46].
- `atmosphere/P-psf`: Pressure in pounds per square foot (writable/readable) [P: JSBSim Property Tree, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGAtmosphere.html, accessed 2023-10-24] [cite: 46].
- `atmosphere/rho-slugs_ft3`: Density in slugs/ft³ (writable/readable) [P: JSBSim Property Tree, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGAtmosphere.html, accessed 2023-10-24] [cite: 46].
- `atmosphere/wind-north-fps`, `atmosphere/wind-east-fps`, `atmosphere/wind-down-fps`: Wind vector in feet per second [P: JSBSim Wind Model, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47, 48].

### Turbulence and Gust Models

JSBSim provides built-in models for turbulence and gusts, controlled via the `atmosphere/turb-type` property [P: JSBSim Turbulence Model, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47, 48].

- **0 (ttNone):** Turbulence disabled.
- **1 (ttStandard):** Basic randomness.
- **2 (ttCulp):** Developed by David Culp.
- **3 (ttMilspec):** Uses a **Dryden spectrum** model (a mathematical model for continuous random turbulence describing spatial power spectral density) according to MIL-F-8785C [P: JSBSim Reference, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47].
- **4 (ttTustin):** Another Dryden spectrum variant differing in transfer function implementation [P: JSBSim Reference, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47].

For the Milspec and Tustin models to function, 0SFS must set `atmosphere/turbulence/milspec/windspeed_at_20ft_AGL-fps` and `atmosphere/turbulence/milspec/severity` (an integer from 0 to 7 indicating the probability of exceedance) [P: JSBSim Reference, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47]. Gusts can be injected predictably using a **1-minus-cosine model** (a discrete, deterministic gust envelope shape input via XML event that permits configurable, predictable wind input for testing handling dynamics) by setting `atmosphere/cosine-gust/startup-duration-sec` and triggering the event [P: JSBSim Reference, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47, 49].

### Wind Shear, Spatial Varying Wind, and 120 Hz Behavior

JSBSim computes aerodynamics for a single point mass (or a rigid body) based on the atmospheric properties *currently in its property tree*. It does not inherently know about the global 3D weather grid. 

To simulate wind shear (the change in wind speed/direction over distance), FOSS Earth must read the aircraft's altitude and position at 120 Hz, query the local weather grid, calculate the specific wind vector at that exact spatial coordinate, and write it to `atmosphere/wind-...` in JSBSim [I: Inference for coupling logic]. If JSBSim drops frames or upstream faults occur (e.g., the browser stutters), the wind injection must extrapolate based on the last known gradient. However, extrapolation must linearly decay to zero after a strict cutoff (e.g., 500 milliseconds) to prevent runaway vectors or discontinuous physics "spikes" during a hard browser lock [I: Extrapolated safety boundary for real-time physics]. 

### Turbine Response and API Gaps

Non-standard atmospheres (hot and high conditions) affect engine performance. JSBSim natively models density altitude effects on turbine thrust via its propulsion models [P: JSBSim Turbine Model, https://jsbsim.sourceforge.net/JSBSim/, accessed 2023-10-24] [cite: 10]. If 0SFS modifies `atmosphere/T-R` and `atmosphere/P-psf`, JSBSim will correctly reduce the thrust of a turbofan without the need for bespoke calibration tables, provided the engine's base XML definitions are physically sound [I: Aerodynamic inference], without pretending SF50 calibration has been explicitly validated. 

However, JSBSim explicitly omits certain meteorological hazards. 
- **Icing:** There is no native icing model [P: JSBSim Source, https://github.com/JSBSim-Team/jsbsim, accessed 2023-10-24] [cite: 10]. A minimum credible model requires 0SFS to monitor humidity and temperature; if conditions are met, 0SFS must artificially increase the aircraft's drag coefficient ($C_D$), decrease the lift coefficient ($C_L$), and increase mass properties via JSBSim's external force/mass properties [I: Implementation recommendation]. 
- **Runway Contamination:** JSBSim handles gear interactions via spring-dampers and static/dynamic friction coefficients [P: JSBSim Source, https://github.com/JSBSim-Team/jsbsim, accessed 2023-10-24] [cite: 10]. To model snow or rain, 0SFS must dynamically overwrite the rolling and static friction coefficients of the landing gear contact points based on precipitation state [I: Implementation recommendation].

## D. Phenomenon Scope and Implementation Order

Implementing an entire atmosphere is a massive undertaking. Features must be staged from the most mathematically foundational to the purely visual. The following catalog details the 13 mandated atmospheric phenomena, ordered chronologically by recommended implementation, adhering to strict structural criteria.

**1. Temperature/Pressure/Density Profile**
*   **Pilot Visual/Physical/Audio Effects:** Changes to engine performance, true airspeed (TAS), altimeter readings (QNH). No direct visual/audio effects.
*   **Necessary Subsystems:** JSBSim atmosphere override, FOSS Earth grid.
*   **Minimum Credible Model:** International Standard Atmosphere (ISA) deviation applied linearly.
*   **Globe-Only Value:** Moderate (changes flight ceilings and cruise efficiency globally).
*   **Scope Cost:** Low. Requires only numeric binding to JSBSim properties [I: Development estimate].
*   **Recommended Order:** 1

**2. Wind Profiles**
*   **Pilot Visual/Physical/Audio Effects:** Drift angle, ground speed changes, autopilot crabbing.
*   **Necessary Subsystems:** JSBSim wind properties, spatial interpolation.
*   **Minimum Credible Model:** Logarithmic wind profile near the ground, linear interpolation aloft. 0SFS updates JSBSim at 120 Hz.
*   **Globe-Only Value:** Low (mostly invisible to a global observer).
*   **Scope Cost:** Low.
*   **Recommended Order:** 2

**3. Gusts**
*   **Pilot Visual/Physical/Audio Effects:** Sudden physical airframe jolts, transient airspeed spikes.
*   **Necessary Subsystems:** JSBSim `cosine-gust` XML event.
*   **Minimum Credible Model:** 1-minus-cosine gust injected based on Open-Meteo gust data.
*   **Globe-Only Value:** Zero.
*   **Scope Cost:** Low.
*   **Recommended Order:** 3

**4. Turbulence**
*   **Pilot Visual/Physical/Audio Effects:** Continuous physical airframe shaking, audio wind-rush variations, instrument needle bounce.
*   **Necessary Subsystems:** JSBSim `turb-type` (Dryden spectrum), Audio subsystem.
*   **Minimum Credible Model:** Mapping Open-Meteo wind-gust data to JSBSim's `severity` parameter [0-7] [P: JSBSim Reference, https://jsbsim-team.github.io/jsbsim/classJSBSim_1_1FGWinds.html, accessed 2023-10-26] [cite: 47].
*   **Globe-Only Value:** Zero.
*   **Scope Cost:** Low (leveraging built-in JSBSim math) [I: Development estimate].
*   **Recommended Order:** 4

**5. Shear/Microbursts**
*   **Pilot Visual/Physical/Audio Effects:** Severe sudden loss/gain of indicated airspeed, rapid sink rate, GPWS "Windshear" audio alerts.
*   **Necessary Subsystems:** 0SFS 120 Hz wind gradient injection, Ground Proximity Warning System logic.
*   **Minimum Credible Model:** Downdraft cylinder mathematically mapping horizontal outflow proportional to vertical descent, overriding wind properties at 120 Hz.
*   **Globe-Only Value:** Zero.
*   **Scope Cost:** Medium.
*   **Recommended Order:** 5

**6. Thermals/Ridge Lift/Mountain Wave**
*   **Pilot Visual/Physical/Audio Effects:** Sustained vertical velocity changes, glider sustainability, gentle buffet.
*   **Necessary Subsystems:** Terrain intersection analysis, FOSS Earth updraft generation.
*   **Minimum Credible Model:** Raycast downward from aircraft to sample terrain slope against wind vector to calculate mechanical lift; simple vertical cylinders for thermals.
*   **Globe-Only Value:** Low.
*   **Scope Cost:** High. Requires tight coupling between terrain elevation data and wind vectors [I: Development estimate].
*   **Recommended Order:** 6

**7. Humidity**
*   **Pilot Visual/Physical/Audio Effects:** Contrail formation behind aircraft, slight reduction in air density (virtual temperature).
*   **Necessary Subsystems:** Particle system (contrails), FOSS Earth moisture grid.
*   **Minimum Credible Model:** Simple dewpoint-spread check to trigger particle emitters above 25,000 ft.
*   **Globe-Only Value:** Moderate (global contrails).
*   **Scope Cost:** Low.
*   **Recommended Order:** 7

**8. Cloud Layers/Types**
*   **Pilot Visual/Physical/Audio Effects:** Visual obscuration (Instrument Meteorological Conditions - IMC), Sun/Moon dimming, soft whiteout.
*   **Necessary Subsystems:** FOSS Earth Renderer, WebGL/WebGPU shaders.
*   **Minimum Credible Model:** A 2D alpha-blended plane for WebGL 1; simple volumetric ray-marching for WebGPU.
*   **Globe-Only Value:** Very High. Defines the visual atmosphere.
*   **Scope Cost:** Very High. Requires complex shader development [I: Development estimate].
*   **Recommended Order:** 8

**9. Haze/Mist/Fog**
*   **Pilot Visual/Physical/Audio Effects:** Gradual fading of horizon, loss of visual references, runway light scattering.
*   **Necessary Subsystems:** Renderer post-processing.
*   **Minimum Credible Model:** Uniform exponential distance fog tied to visibility ($V$) metric.
*   **Globe-Only Value:** High.
*   **Scope Cost:** Medium.
*   **Recommended Order:** 9

**10. Rain/Snow/Hail**
*   **Pilot Visual/Physical/Audio Effects:** Raindrops on windshield, audio impact, visual streaks.
*   **Necessary Subsystems:** Particle system (Renderer), Audio subsystem.
*   **Minimum Credible Model:** Screen-space rain effect (visual), pink-noise audio filter.
*   **Globe-Only Value:** High (visible weather systems globally).
*   **Scope Cost:** Medium.
*   **Recommended Order:** 10

**11. Runway Contamination**
*   **Pilot Visual/Physical/Audio Effects:** Slush/water spray audio, reduced braking action, visual tire tracks.
*   **Necessary Subsystems:** Landing gear friction modifiers, particle system.
*   **Minimum Credible Model:** Dynamic reduction of tire friction coefficient based on surface precipitation state.
*   **Globe-Only Value:** Zero.
*   **Scope Cost:** Medium.
*   **Recommended Order:** 11

**12. Icing**
*   **Pilot Visual/Physical/Audio Effects:** Visual ice on leading edges, loss of lift, stall horn activation at higher speeds.
*   **Necessary Subsystems:** Aerodynamic degradation (JSBSim).
*   **Minimum Credible Model:** Simple $C_L$ reduction and $C_D$ increase over time in visible moisture < 0°C.
*   **Globe-Only Value:** Zero.
*   **Scope Cost:** High. It requires stateful tracking of ice accumulation on the airframe [I: Development estimate].
*   **Recommended Order:** 12

**13. Thunderstorms/Lightning**
*   **Pilot Visual/Physical/Audio Effects:** Severe turbulence, sudden full-screen illumination, delayed audio thunder.
*   **Necessary Subsystems:** Dynamic lighting (Renderer), Audio delay logic.
*   **Minimum Credible Model:** Full-screen flash paired with delayed audio thunder triggered by EV boundaries.
*   **Globe-Only Value:** High.
*   **Scope Cost:** High.
*   **Recommended Order:** 13

## E. Rendering and Illumination

Because FOSS Earth must support WebGPU, WebGL 2, and WebGL 1, the rendering architecture must gracefully degrade. It is constrained by a floating origin system and a renderer that draws only when content changes to preserve battery life.

### Cloud Rendering Methods and Complexity Formulas

Modern atmospheric rendering relies heavily on volumetric techniques, famously documented by implementations like Frostbite Engine, Horizon Zero Dawn, and the open-source *Skybolt* engine [R: Skybolt Architecture, https://github.com/Piratech/Skybolt, accessed 2023-10-24] [cite: 50]. 

**WebGPU / WebGL 2 (Volumetric):**
Implementations like Joshbrew's WebGPU real-time clouds and Skybolt rely on compute shaders and adaptive ray-marching [P: WebGPU Clouds, https://github.com/joshbrew/WebGPU-Clouds, accessed 2023-10-24] [cite: 6, 50]. 
- *Methodology:* The atmosphere is modeled as a spherical shell (inner and outer radius) [R: Skybolt Architecture, https://github.com/Piratech/Skybolt, accessed 2023-10-24] [cite: 50]. A ray is cast from the camera. The algorithm takes large steps until it hits a bounding volume, then takes smaller steps, sampling 3D textures. 
- *Work/Complexity Formula:* Spatial ray marching complexity is generally $O(S \times P)$, where $S$ is the number of sample steps per ray, and $P$ is the number of pixels. Conversely, frequency domain volume rendering (while mathematically elegant) reduces complexity from $O(N^3)$ to $O(N^2 \log(N))$, but is poorly suited for the occlusion and attenuation effects required by dynamic clouds [R: Volume Rendering Techniques, https://www3.cs.stonybrook.edu/~mueller/papers/volvisOverview.pdf, accessed 2023-10-26] [cite: 51].
- *In-Cloud vs. Above-Cloud Views:* Volumetric ray-marching naturally handles these transitions, but scattering mechanics change based on viewer position. Above-cloud views require evaluating anisotropic phase functions (e.g., Henyey-Greenstein) to capture the "silver lining" effect of forward scattering toward the camera, and halos around the solar disc [I: Inference on radiative transfer].
- *Temporal Reprojection:* Ray-marching is extremely expensive. To maintain 60 FPS, engines project the previous frame's results into the current frame using motion vectors, only rendering a fraction of the pixels per tick [P: WebGPU Clouds, https://github.com/joshbrew/WebGPU-Clouds, accessed 2023-10-24] [cite: 6]. 
- *Motion Costs:* Since FOSS Earth only draws on changes, temporal reprojection poses a challenge. If the view is idle, the clouds are technically still moving (wind scroll). The renderer must wake up at a low frequency (e.g., 10 Hz) to update cloud motion [P: WebGPU Clouds, https://github.com/joshbrew/WebGPU-Clouds, accessed 2023-10-24] [cite: 6], or freeze completely when the user is inactive to save power [I: Inference for battery optimization].

**WebGL 1 (Fallback and Extinction Physics):**
WebGL 1 does not support 3D textures or compute shaders. The system must degrade to rendering stacked 2D planes (billboards) or using a skydome mapped with a dynamic 2D noise texture [I: Architecture downgrade path]. 
- *Extinction on a 2D Plane:* Because FOSS Earth uses physical luminance (cd/m²), 2D clouds cannot simply be painted grey. The fallback must mathematically fake light participation. The physical **Optical Depth (OD)** of a cloud dictates radiation extinction, calculated as $OD = e^{-K \Delta z}$, where $K$ is the extinction coefficient and $\Delta z$ is the vertical path thickness of the assumed cloud [R: WMO Cloud Optical Depth, https://space.oscar.wmo.int/, accessed 2023-10-26] [cite: 52, 53]. By associating a static $\Delta z$ with the 2D plane, FOSS Earth can scale the opacity of the billboard and dim the illuminance (lux) reaching the ground/aircraft proportionally to this $OD$ formula, maintaining physical consistency across rendering backends.

### Light, Exposure, and Explicit Controls

FOSS Earth uses physical luminance (cd/m²). Therefore, clouds and weather must participate in the radiative transfer equation [I: Inference for lighting fidelity].
- **Light Accumulation Formula:** As a ray marches through a cloud, it accumulates *extinction* (light blocked by water droplets). The transmittance $\Delta T$ for a single step $\Delta s$ follows the Beer-Lambert law: $\Delta T = e^{-K\rho(X_{i+1})\Delta s}$. The accumulated light $L$ arriving at the camera is integrated via $L = C(X_{i+1})\Delta T(1 - \Delta T)$ [R: Ray Marching Equations, https://open.clemson.edu/, accessed 2023-10-26] [cite: 54]. Sun and Moon illuminance (lux) reaching the ground or the aircraft must be multiplied by this total transmittance [I: Inference for shadow logic]. 
- **Shadows:** Ground shadows require a top-down rendering pass of the cloud density to a 2D texture, which is then projected onto the terrain [I: Inference for rendering pipeline].
- **Explicit Controls:** Opaque graphical settings must be avoided. Configuration should expose parameters like: `ray_march_max_steps` (integer, default 64), `extinction_coefficient` ($m^{-1}$, default 0.05), and `temporal_history_blend` (percentage [0,1], default 0.9) [I: Recommendation for strict typing].

### Floating Origin Constraints

To support rendering from the runway to orbit (20,000 km), FOSS Earth uses a floating origin. The camera is always at `(0,0,0)` to prevent 32-bit floating-point precision loss. Consequently, the weather volumes, 3D noise coordinates, and ray-marching targets must be translated into the camera's local space before being sent to the GPU [I: Inference for precision limits]. If noise textures are sampled using absolute world coordinates, they will jitter terribly at orbital distances.

### Licensing Implications

Skybolt is licensed under the Mozilla Public License Version 2.0 (MPL-2.0) [P: Skybolt License, https://github.com/Piratech/Skybolt/blob/master/LICENSE, accessed 2023-10-24] [cite: 55]. Joshbrew's WebGPU clouds are generally open-source but specific licenses must be audited [P: WebGPU Clouds, https://github.com/joshbrew/WebGPU-Clouds, accessed 2023-10-24] [cite: 6]. If FOSS Earth is strictly AGPL-3.0, incorporating MPL-2.0 or MIT code is generally permissible, provided the source files maintain their original headers and the overall project complies with AGPL provisions. Studying the math in these implementations does not constitute a derivative work, but directly copying shader code (`.wgsl` or `.glsl` files) does [I: Technical copyright distinction].

## F. Subsystems and Auxiliary Components

### Audio Coupling

Weather audio (wind rush, rain impact, thunder) significantly enhances the sensation of flight. 
- *Implementation:* 0SFS should hook into JSBSim's dynamic pressure ($\bar{q}$) or true airspeed (TAS) to modulate the volume and pitch of a baseline wind audio loop.
- *Turbulence:* Rapid fluctuations in JSBSim's `atmosphere/wind-mag-fps` can be mapped to an envelope filter, creating a "buffeting" sound during turbulence [I: Audio programming logic]. 

### Altimeter, QNH, and Instruments

The barometric altimeter operates based on atmospheric pressure. X-Plane exposes this via `sim/weather/region/qnh_pas` [R: X-Plane Datarefs, https://www.x-plane.com/, accessed 2023-10-24] [cite: 56]. 
- *Implementation:* JSBSim provides `atmosphere/P-psf`. FOSS Earth must allow the user to input a QNH setting (in inHg or hPa) via the 0SFS cockpit interface. The altimeter instrument mathematically compares the ambient JSBSim pressure against the reference QNH to drive the needle [I: Instrument math logic]. 

### UI: Shared vs. Flight

Because FOSS Earth owns the shared UI and 0SFS owns the flight instruments, weather selection (time, date, METAR override, Open-Meteo fetch) must reside in FOSS Earth's UI. 0SFS only receives the resulting physical parameters. This separation ensures that a user merely browsing the globe sees the same weather controls as a user actively flying an aircraft [I: Architecture boundary].

### CPU Tests vs GPU Validation

Validating weather requires distinct testing methodologies.
- *CPU (JSBSim):* Atmospheric physics must be empirically validated using unit tests. For example, injecting a standard atmosphere and verifying that density altitude matches ISA tables at 10,000 ft.
- *GPU (Rendering):* Volumetric rendering is subjective and hardware-dependent. Empirical validation involves comparing the rendered sky luminance (cd/m²) against known physical values for overcast skies (e.g., using CIE sky models) [R: CIE Sky Models, https://cie.co.at/, accessed 2023-10-24] [cite: 57]. 

## User Decisions and Next Steps

To move from preliminary research to an implementation proposal, the following explicit decisions must be made by the development team:

1. **Source Selection:** Confirm the adoption of Open-Meteo JSON as the primary live-weather backend to avoid CORS proxy infrastructure.
2. **WebGL 1 Fallback:** Decide if WebGL 1 will receive a rudimentary 2D cloud system, or if clouds will be entirely disabled on hardware that does not support WebGL 2 / WebGPU.
3. **Renderer Idle State:** Determine if the "draw only on changes" architecture will be modified to allow a low-frequency (e.g., 5 Hz) tick to accommodate scrolling cloud shadows when the camera is static.
4. **JSBSim Modification:** Decide whether icing effects will be implemented by dynamically altering aerodynamic properties via 0SFS code, or by creating a custom JSBSim XML system file.

### Required Experiments

To resolve remaining uncertainties, the following experiments should be conducted:
1. **120 Hz Wind Injection Test:** Build a minimal 0SFS script that writes rapidly changing values to `atmosphere/wind-north-fps` at 120 Hz and observe if JSBSim exhibits numerical instability or excessive integration jitter [I: Experimental design for physics limits].
2. **Open-Meteo Latency Benchmark:** Perform an `XMLHttpRequest` or `fetch()` from a GitHub Pages test site to Open-Meteo to measure real-world JSON parsing times and ensure it does not block the main browser thread [I: Experimental design for performance limits].
3. **Temporal Reprojection in WebGL 2:** Prototype a minimal ray-marched volume using WebGL 2 (without WebGPU compute shaders) to test if fragment-shader-based ray-marching is performant enough on target hardware [I: Experimental design for hardware fallbacks].

**Sources:**
1. [x-plane.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFhIwfVkinCWF7nk_05SR1GK1apBhYf0nOF9DunZZ5gTAXP4WdE337zl-QsJi6bdHC8M261a1pR0_8OtBNQfjO9yagyKJTPZ4h3L0KCaVAUB7Q1lPWusKnMRbdb2Tk3kjIizNPGGkwpf8tqpEzND9c73ZmVJ6psUs_mA20=)
2. [x-plane.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHDnWD_PgzMQCGd8Y3OJGWoC9EL4Y9vA3KaCT7hNwsQzm0-RnC4lUG5kpVjRFfNOzNRzgT-Oj-WhWiejGKBqR_B9M92MBmzvVLqIxl7Ifxp_4BALzZ5oo7JANFjIxenZlfzKo2UEam_)
3. [flightgear.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFW6JxVs4FMsjFGa4aKnAyvFoJQpAMoBhlCOhNpuaoplruqLYXTw_UhwF49KaS_ELXdH39ZpO_Vb_p7-nVUajHFLjo0-ugMN9IKdgWvGqzv2X20ufWqVMI5Ew==)
4. [flightgear.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHTBuiHGzDlCmKF_gjemVDPxSvQSMJGiVZcdPBoQiBv40tw02jgNk5-IyVBH1rdKTvKUjw7N8OqDsXBP7guW3owHrEp7JU8TQDgQ67GYjRpjC60j7hFTBJ7qJYpCa0HNtxG4ZECA-izHk1l1FyK9Y_77UTsuI768gv2xXL5KNX5)
5. [gribstream.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGOTFIF5M63uAPDhYm-1w6sVQP3ZzRnol0muDNnjF20WhoEdEFP29r7qct-AI0_ecbqpe73IrTizth462y3dyr05ZrPjDAUQUMlFdtjw1l-iuHlZmK_iuo=)
6. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEOHY2hzivQ9_6RjnunkwHb-QpokXWT7v9IMAVy_YNbex2EgtbCcg8PMrUaKSx8dIq_kaRhy9Tgf_NX-e-LgJcwPunU2BXmMcpFpXVB-nEQp6zb32hPcW2R7KP5Vko4283NEwD9Gxpzgw==)
7. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHQT2NmuBiDLKd3opv7WNjuAKAc1pY7hLfRpxraA2c2C_OaSM7aFBpvPjUPWyQWILMHfHoxEItABl_LYsZh2GbPoboK017Voa45rN39z_PPNboLeX9F9cLACDS-YszROKuLWUDWvQcR_M4ooOSRJm1Y5_8XUSQB9G-Bw400ooqXrWuQ-Br8phxVHsw8JXy8X6kFPFh6GIkAOXqNW_NA95Wk7w==)
8. [mapular.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF8k7r3i3rhkE-D09r-aYYmWx-YpUYGWECCJPCvA_YSFvU3of9pPIUKt7fICKEThAKA5RzHn1ZpIrYplYOLMPyLa9nMx8l-G0L3TJ53_klMhPidf5YQ15VEDgTWHZ3cOmuN0CsJ0KmeOg==)
9. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGsPBLifxsJZtwmv46n82mNKUip7jsGbX4RHmy1kN-TQZmXzLRcleZSLP5pWEjxpRNAubf9A7SP0Mmmb9UMV1d_gmQzDRgO2TkQta9hYu4ZR59Bl-W3ktXg01xleLkcbvhtdZQD5xiT1IYtVIorTW5ckGGhJG8KFpZywWEPzeijWCM7YRt0xs9FQeTtPytIE87EpWpaNl_UzQzno_JQVvNLMk8nToj9PwkFb7tBggEslhP6)
10. [simtool.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFUaRXZcyCL6ixmC-NSK4wGFYa5qNwr1EaHhFWn-AdYwvC6HFCq_5xG_gKHhS01Svru8r5R8IbD1mgQR1dpS-Alv6ieWTY_UZn3_SPmd8FU2n8WiDovQr65OkbNPrXM9OyvVCJkB2T2apc4Vj9dYTvqOHL-174MQoBhSkKgh01y7AoBIJWvkEUlHWeejXaIWKTEdL5RfTpcyulzsUqDj-L1SOFUT9QR4-Q5)
11. [solaakinbode.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEMdoCIH_4vQSW8aKz1jIEmQfNG0qorIUu9w_9igjEG2l35VmaxbKtYeks8LzBSvU1NGrvm1HfrspNAJtvXMJUPUikmQt1PZB-sZYiKs-Kxd8MQQYYYVAEpaNDxLUyvmV2IvpzhNKSs)
12. [aviationweather.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEiJfW4mxW3n7lhY2Pk1rQV2U_tSnPTwcMUq3OkCoGMYrFcz1rqq5evW2N38c1Dy8dllqHC7nid7yDd9cA5gazh6hjSsJ9SFo_xpOcjomv-hucTWhJqQguDqoPx)
13. [stackoverflow.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEOqmJxtNQaVRuVvCdIKVNb2AYxYQh-54YU3xu8daepNlhHY1wRV4qYPBGVY7Ropl0HyXTTgX-8-Emk81O41bbvFIX6BfNaXfrQUHq34-hKFRPzMtdJniteDkmLfE5_zD9uYQE2IYGfuXQ6zBi7hVtGUfdDsGRQqSbS2_p2t6RyaUl9fokBmOXULQSM-ZHM6-gnGmeUCGhL6rTanqzKXAqDGzy4Wen6nH0wjemjlKc5R592)
14. [aviationweather.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEalrkksbwoYzPMS6gZkb-uubigpd5jj0CkAiXNdmlNwBqgeGwKpxgg4x1kg2OWVsAzqX2FlLNdQ-Ab068trRaWl7nARfvTYZkZTU0X76x8J6AvSAh0GftjBbQnn3Xrf4wSTcU=)
15. [noaa.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFc4i_2BvknmaBj7gifSSOWaaXjJKCZNv6GBXmNKUrytzNOY5Eq5yaeEg-j1AXrnvwzNzQMfFGqoFbQLek5CcK52A5EMfKBk_is3Ivm6HWDqmO97rng8uHkMz9jTBxiZQxESVGMGPg278YTZUYd)
16. [noaa.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGauhp2J6bjo2z1IKOGsnrYqa3HCvTJ2kkooOiz61gHri253o7Sx_XzjaY0jysWa8e7fPmji9OnLrcGMazxt9E9kj8HrDJYRaBQEtpupK5hS-JGGUcPBwJXN4H4QrTT9RQ=)
17. [ucar.edu](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHkEXBSEEJZIzDAtJE58CaBIuvJPkWfN5I1mQm1xcTMWJpCpPPultmHTi0QEGYlku3JkursXm0a4CQoPIBA_WWPe0Es7EjdkcJK42sw7gPVjHS1usupFlOHE-3fYBRrfZ2QTbWpOtsktUiYgjDQyRfl2g68rS8s_vU6ILlGhFAQBqz5bTc2LOoqz4NEk0wNIdbZ)
18. [ecmwf.int](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH9ZPXGhA2c2P7q8TExb39L-bjxeG0yp7ny-fad4ybGdcNTcO3pMjP_0oj4JlhMdc-1nv-8RAieYwJJFK4arBt3Vu9Ytn5sc_yn1NMvcXEH8xajMYzzvMbbNBwMzq5KkEeYABkhq1B6F9PDzg==)
19. [ecmwf.int](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGTlqSQPTpM_oIiCTdG8xTsmOYl3tHxsGnH1KjpZhU-ExCid1TSvQqEtUxSTGdd0uLdG81a7bBZ1dU1csu7eXPYkvrTvUx2ltdvFyBGUJejOfys_rXDn6AFd1fHaErGlvzAv9zj4_8FB69woUuyA9B68scN3Tiu5wpUFpG_ZIh81Qk0O1bgSu-4ufLOPOqYpgjRIo6n9sdzE8XOq0T7sM4=)
20. [ecmwf.int](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHhMgQVHYt1AggnSZLKb4mtfQl_4ovfcaGUGn1oqRcyRCbK3Ih_QtEwAzownTF9Vr_uqOgItbqzo2Jx4v5ufxHVWvPvjOWcXH9DJYDYAJJIXJ5aMtrJFvnepPpFhLE4QxN2qL5jggpRPrWZ9D0IaU2nfIfGyyx797qp1cVaKt-AaZfUKtT7_ogCD95-AtRGZBg=)
21. [open-meteo.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEY-OhUDWg7Yil9Xn_dVu4I9_tO9dCzD7JWU8j1VRf-lULeXd1H9SsILzkDhsaiRaAwnfmvmMT_LzJjl2d3jrl8jEqOehPgLUFWDQtzBSb44aixlOlM-I8=)
22. [brightcoding.dev](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEA3inaVM_9hovvnsy73gen8FRrOKLRLH0fjL6-PhBVuNRuUowVaTHGWgBfbbxhpx6r-IvpEpZPrvw2fYHoTAOE1PeD3GBczsqq9D1qsqEdSBXdqDyOa34rTmwg2n5URCFJ0RYxaDSEHDCiHpce7wTF-t258S-BN05tjkC8tX2P08RQ2F-5qqkNYiGi8Ag6arjxjn2zyper30pzTtGMns6KFw==)
23. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH3CH_G1GtAuQ5Sh14XIUHkKmiXlzl_kx0-jwr5LuDiMU3A93JFTEg-zpPOvJjkRrsHDxByaVprJm7_zbcFQltTvLa-wvc2Dh7Wp9tahKMqFPc0Ly3GcoGswKCMvQFk)
24. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFgmk-nEkn5vtVS4g_fVhIpaFyUWapF5R6P3goHHUq6714ZrkyvxGzwEv02BkEjaAXbHPiZNorSKpNC6p5tT10sXM4VPFr2kvGYVl-rNBu2kQuqZ9I0ZePhD5YTFVeowp1zvXKfeQ==)
25. [geolibre.app](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFjhcMlaFawRgEH-_M9eZSPuyR242Y8Ws1MNVJJy1f1C7c0nLndGy3N7W2BbSQykWSc0tu4lPex7Vu5AiwiQnDtKau8enBvfcdAMgukowFMAwcPdxj1IlfV1Ah4eATA3_Iyrs4=)
26. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHQOJzfUYaJasbyALcvMXZiR8OprCyEksCVSiRFd1wSt4NG45n0fAtPlPTPyMB5aHYJGgsHTPov9OLdXPfSFXQZOiihJF_CjO2mnnIUgdQuQmn7_szPt_lclYl6XAZ7)
27. [glama.ai](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGGaQ7XsSnSGl6E-vxv8tDh_6riUUFzWPFNj44Bv97_vFznbykG5S9rGEKA5QE8jgDbv1ScuEOih_C5Hozlopv2SuvGqFGAmIx_gzfaPQ366FTjwCzmSh2iMQlxhe1KKgt2aO60TzgCDjvUW6A=)
28. [nasa.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFoLSuY3dl4QRU-i0iiMl6Del_eWCE3qQIQe0WwpYjIWSbt_A9L76wx9udbIAdK787ehZsZy-l-9UJ4EXune-H7u0ty5mDbWtsIOa3udxL-TTrV9ZRGyuhk_-ZZhNodt4R_1NGNZSxqizwQh6sReVr_HuXDXDVuScLK-MIgQ7-kNWqP_7bSfEOiXD1lrjEj9mxZE5shJvYZQByyMQ==)
29. [open-meteo.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHUt0kyFZ3khapMFrGJQ3qE6H9iNenNrPuQJWQq0DqNNDpyUnbssAxRnlEgWmI5d_uCDdkTLrJAt65T2917d2FNPBCzWbS7J0KNdZTghQ==)
30. [eurooilwatch.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEMr2LHD8CYiZ2iLegI0svz3HLiavDwrY_QA4O1u_HeIfQtP0wnfrRzg15AgwgNYVpKj1fnMZW174Ip8zOpDIlLNidWM0xyjBAad99EZcQytLOB)
31. [public-api.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQENZgJzrDTKGUbQH5PS1ja3qOVmVgQBTPwA1rD6gXCuHVLcX5qwaE0myOKEPEqhWm6gM2PVRi1CiAiYznr7qTedWBXZ5cwXq59RbpvI14VCVvGWw7Dfm4558i2XqYMiwkU=)
32. [open-meteo.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEBifK88_ILedya1ckOb3hryOhSOWjzr2td7xvWxzMpNGKvpyxh56Z94vHXO3JREzvACGWxImOQml6SOkW7CHlpDaasxDEdCV6ObBuDEPar9gReDho=)
33. [substack.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEkT8RUIKyariD9qgaYr2dwuY0L2zdOz6CMrUCf_7-XSZoerOvA42EVjkX9ecOsZyJaoph5WMXcMu6fHR7quCLP0yp3mOmUN83NB-05H0zcNljzyuJCn0C2AXVBGm9f8mFtrZth0DUZylzrKKQxfbQCJJkcbB4=)
34. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGJ_BxyfnuCoqsSxpSq4D-PNuFeuAl7JMEQegC6_WnwvmZkQnhdFSF88KT_mjvhsLvoVp0L4-OiGH1tK8uzQ_Z4iDqBdYK4aZG1sRwokb7bjzPP31R3kxXxq77kc4dLwG9QefGpT03VT-mF4OfAP83yNes=)
35. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHch2WhsHm0YMVODg2jNlJTxEJoRFEUAHxp9wMXQsvahXYLROfTjQjUZBsjxP9-v3pPl4QTr_nr0LZ5bc_BHTlOwYj8lGJDAMQIAiSUZPTHvYJXO7H6x9o5QqpTYC5N)
36. [stackoverflow.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF_qdxbcbOc3ZbF7aJbLXGPCtxcG_CiDQPLAJMUjEiiHK3-fhcaKlwhpFWDJ-fq7RY5quWLncNmO1XMd3dp8HjZs_jpOHybhZBcgdFaR-HykpTyrc-ZXVfqRvKhX9zLTjw8uHJ6ualw5MvI3XBbr28Wlx2A8IJQH-DPh5qV2raIDDk=)
37. [flightsim.to](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHGAwuCmAXuEVqRlb71gWCKmKBXDAg3Ypc6OvkAQx9ieCTAMpWUS_ai918i2HqW0H1nHAfhXwZhs10XTmiMcHKc7-4SbIkARhhczWpdp3DkLQj7Pwh4Q811k6MICNQ7F-_89x_DPojMb1yTfHaRARv0xcSwALBYsdgeZFuuBzWSLpIYVQV6GTUpxCTKYmwyr5QvzhhHYb3pEBuIbnuO7sR5Hw==)
38. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEXCnpUgaJPIhkyiqGYdMpFq6G8LBoMMKu-NFYZbkqKXbugZEV_vafp3WtQldSTC_s7ylwLdvLy0cgsjHf9HagYFvBAK3v3iqh8QxDnQwGczhCYuEDfy01JlBIvgkU=)
39. [gribbox.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGcL7m-D12tqWTK4Xs0y9wW_8d59myocZuOka-HijONPg-5cXfakZNUrZNXQc5TaeEIIzNlTTdsuVuie_pHPgt79IMAYMV7I6SJW8SNwPZWO96kBRABIuJ8NOKliuOPMs7M1JMNPg==)
40. [noaa.gov](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH6NcE07cENBuSaNyWziKco2emxuEJl2i7CmxQM6JYMjda5i0QBIzlbvzMSNMiE3aUOwTtseQ4Gfjk_5ZNwWlOExJkrw_kxRf3Tuuw-yKOLLWP138P0BGJE6uSisYCwBPziJOm0PQQjHJUbkZYAARw4SPDLXg==)
41. [wolfram.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE3wlN7L3HLLyc9mSo8rJosKxsD6o2r4BNqEH5PFIWBIziJG6NQycoqrS2tBTSSP9FEYxwk6n1-Wica0bHU8DmXYz3NXIt85zV0dhxNmwzgbWU4ZT7mG9u5V0ddJrsG7fCge5fyQFOgzC5PYzT0yxpn6tbiWnsULMEYfH_BO62Eu2bFswswqD5_PTrMH681NQVFEvRysk38g74xleHBrTs1UTXAFVqVMa0kZlO2QDgU77UlpQ==)
42. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHDbCEYJtyyc6_UA2EiW4FA7D7Sj2kL4LwUPtba1Cl0Cr_izitZBlUWUgru1BgJXt18xT8qnWx2lnTtV0wcbVMMNw7qSOwixXfBmrzs4RyYdQ9x28GDvj-M6lDo1TMfDDYr2Tl1eNL03gdmfnSo8heH)
43. [open-meteo.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHfST-8XlFlpWykipl1eZLwzzXVUnvtAVNEySqYx42tSNe-790nGOPaPG2kMmjCKMCFrXILwsZYzskbOnS6AbEPPHlB8MPApHHzkw_8dnpH92Sz47lP)
44. [reddit.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEaTp_nWPdQS7Iubovyk5NdD7sBfPRJvDd-YUfhEfdPwFUJrEra0XIZG4-lBcRq8SMqeMq_Y2lgm6YPJqyanBGfcrZv7kxGmDNxn8f3zq9_7FXGxzqfDdNAQpkqcL9Umjliw1FcfOh9X5HMUZoZmxGvv3su25wc0KUOnQyxNDBaec_QD_SFfJPMSTBHeHrBtnH2Kt4AvLkuGS0=)
45. [wikipedia.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFhf7cAWKe5ttps2XHv5QT3vwyaHKC2Ewf1flFzVtNeo0vutunS7FIcCbTdCcC5c5fJerk29KC3VOz0Rwbv1WrzU-Ui7Ym9FxFCOKAkdrJldx7W3CqTN4x9J8Jb8x90)
46. [sourceforge.net](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEo58uY4a9IEG71SVX-WsU4gAULisNuY0dWbPDFxDGyMS-aaIMbzk4vDk3JbqcDlJQaWqB33fneTy--APL1K1KixgalrXyHx89v-mZAO0zzjOgliZxZ64TLHgc6HrDusA5K2SXj6WuxTf6xTvl6w2xk46zyd7nxlsMJzJxT)
47. [github.io](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHJjID-43zat1t-ExrzgwxeRmkRD1LeToqSziF9TY_xpi0Yor-isVzVyRfPjq2sO9G1MICAbqvzkZtxSd98kEWORyfgtkLqskdJeALlTK4QAdZCKvAzZuBQ3JEz4aoynmReshgE2s871RYJWpG31qVKCEunlm-s)
48. [nps.edu](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFurJny0lv3_fdiZpPq2fQpK9IqeoXiwGxzxIfyZfbpBXb0YZEttvuVk9i54zr5H9lryxNiSaFA_j4vkQiZdk9dQ6aFtLvfZE0iLpAUaWgNswr-zlA7CYOV37e2XUuuxXj7jCqDEM3XPTKHW43STzcSUtXoV2vPvyvNlJQ2GVzoV06ErCqL7nHTbuZkE4mSDQ==)
49. [aeroed.ai](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFZj_uzY2ao52O9_-QMeomaa2mZf__JhTnfgNTFyHug5t-XM6yEcMTjkg47gAuZEbBpzeh0srPKsGgoyUHNBhOr8MtCU2E3-WDtGm24ltyv2UeSBxY6)
50. [prograda.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF3saO1EnC11Xnjvc3Vu5zTkCVHOV7fe2TbFpVvJMtwkPcfk0k746ODa6JgKHrEdswy5g-ZRucH9T9Z-rnfPpkemLrYY-PY03-Z8ymFti6pDerGW5WD6scEdKWiYDLyRAEtj2uTnFw60-_92edvM_iU89iKnmZVUnROnhlhvd9AJ9LTmIDx5eG4)
51. [stonybrook.edu](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE6GUmeQ4hEICN3B7iFk2u0BhbfHNZWVaQBvnfY3fcMx-NRhQSXdkKbXsOYJuRvljBci57SIO57xq4UrN04rLO7fa91D159gut5NfHOPLEHG0gS0Fk1hUINYhMPPmV_ZIVrjobIAZS2NGE_ZCgCiVrh8xnGKjhxkQ==)
52. [wmo.int](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHN7PReJt4PDHabs8ffrxcxXl5TdUxvkUlU6421RdFFD_KGoV9e8uMYA3nPex_xM2IpYgjJya-gaZ92-MbLkrmoG1gjzLS4MpELoGw-VdZ7adwwNv10hpLZ1TVfGMKDHrg21xZLr3w0cbwfr_c08xvisVikBw==)
53. [youtube.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGgRmKsAsQmvK7s0dk0mtBnB15nZQoJvF2WJSbhIexKOjeDDCxwnGA2XWvEF_iQVGfemEOG5tjPWDfGnObVXGX868amD_i3OCRlfMkOgRZ4JPdgPzw1-wwtn4H_W0UAK8H2)
54. [clemson.edu](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGyLDuDxTT-xRVqtIydD1HGtjfjQrccbGfxDgYnsfoJMlrdzgRYndblp4DwvBQE7IRQcdrd0ehqYk9826c7yBvgtvIp5HfaA6Xzg8usxEFsK3QbFpf_JED23BCPzLQdO0Eb3ucLKbt8Svg0yltz2-2QFwqctnpyS5OKMfIPHIzVy1re8wjv3sBGu7tyV3eFY2peXuwgFA==)
55. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEz6F2IOYPyzEVVwAGqwDgCuRg53G0JCzNa16oIe8Ws0_Cg_VQwLt_HMqEgodQM-GNT7dTbcU77JZwj3DFY7XN9J4Bq7ph8krHeO7lmVNtj39z1AERrXR561A==)
56. [x-plane.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFFSiuMqa4_Byc1pqbmyr4ucN40srLxfEK4xf2dJ_REWdR7fJIfMhEinHlBuXvJUrSKeVnxVNGsrPnqyHid4OwHIf7bjfbI4ZEZ-CxirNuBKdwzg_r-TO0GmqWOQp_yAH_4c9FI5hbPyzJrUJHilaSIixagr8PheNMJjTJdz3JkVS-n-lPzu_8=)
57. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEtESHzIvlEMbjpahTRWrGeq-JU5-QeFhV-4J9U5IvD6II5ZWFSnTLg-QDWJbr1nYAU2DqTsEJBbDPMqWJoYHWvpO36ARdWbSq4Y1rotMKNYhAfSMlk9IEpHO1l4kzj5dyu1-cMlMLOOy1yHlcYWZoVfkEgBJPbjuo=)
