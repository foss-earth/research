# AI frame generation and upscaling: registered gate results

Generated from the selected numeric evidence in [results/](results/). All errors compare cropped RGB; A/B clamp to [0,1]. Failed and unverified gates remain visible. Cold and CPU wall times are unqualified observations. See [REPORT.md](REPORT.md) for recommendations and limits.

## Export and browser parity

| Candidate | Profile | Precision | Case | A | B max / mean | B PSNR dB | B | C within ±1 / max codes | C | D | E | F MiB / gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rife-4.25-lite | small | fp32 | synthetic | pass | 0.684200 / 0.049974 | 22.17 | fail | 27.93% / 174 | fail | pass | pass | 69.32 / pass |
| rife-4.25-lite | small | fp32 | natural | pass | 0.784577 / 0.092190 | 17.17 | fail | 9.63% / 200 | fail | pass | pass | 69.32 / pass |
| rife-4.25-lite | small | fp16 | synthetic | fail/not run | 0.683995 / 0.050010 | 22.18 | fail | 27.91% / 174 | fail | pass | pass | 36.16 / pass |
| rife-4.25-lite | small | fp16 | natural | fail/not run | 0.881475 / 0.093217 | 17.09 | fail | 9.50% / 224 | fail | pass | pass | 36.16 / pass |
| rt4ksr-x2 | small | fp32 | synthetic | pass | 0.000004 / 0.000001 | 123.53 | pass | 100.00% / 1 | pass | pass | pass | 4.95 / pass |
| rt4ksr-x2 | small | fp32 | natural | pass | 0.000004 / 0.000001 | 123.37 | pass | 100.00% / 1 | pass | pass | pass | 4.95 / pass |
| rt4ksr-x2 | small | fp16 | synthetic | pass | 0.023432 / 0.003698 | 46.53 | pass | 78.16% / 6 | fail | pass | pass | 4.10 / pass |
| rt4ksr-x2 | small | fp16 | natural | pass | 0.026291 / 0.003602 | 46.67 | pass | 79.00% / 7 | fail | pass | pass | 4.10 / pass |
| rife-4.25-lite | 720p | fp32 | synthetic | pass | 0.736918 / 0.049939 | 22.45 | fail | 22.53% / 188 | fail | pass | pass | 780.58 / fail |
| rife-4.25-lite | 720p | fp32 | natural | pass | 0.945995 / 0.043788 | 22.30 | fail | 24.30% / 241 | fail | pass | pass | 780.58 / fail |
| rife-4.25-lite | 720p | fp16 | synthetic | fail/not run | 0.736918 / 0.049844 | 22.48 | fail | 22.34% / 188 | fail | pass | pass | 429.07 / fail |
| rife-4.25-lite | 720p | fp16 | natural | fail/not run | 0.947688 / 0.043535 | 22.43 | fail | 23.22% / 241 | fail | pass | pass | 429.07 / fail |
| rt4ksr-x2 | 720p | fp32 | synthetic | pass | 0.000004 / 0.000001 | 123.85 | pass | 100.00% / 1 | pass | pass | pass | 66.25 / pass |
| rt4ksr-x2 | 720p | fp32 | natural | pass | 0.000004 / 0.000001 | 123.40 | pass | 100.00% / 1 | pass | pass | pass | 66.25 / pass |
| rt4ksr-x2 | 720p | fp16 | synthetic | pass | 0.030162 / 0.003706 | 46.55 | pass | 77.86% / 8 | fail | pass | pass | 57.91 / pass |
| rt4ksr-x2 | 720p | fp16 | natural | pass | 0.026485 / 0.003644 | 46.60 | pass | 78.24% / 7 | fail | pass | pass | 57.91 / pass |
| rife-4.25-lite | 1080p | fp32 | synthetic | fail/not run | 0.752018 / 0.055615 | 21.69 | fail | 25.06% / 192 | fail | pass | pass | 2040.08 / fail |
| rife-4.25-lite | 1080p | fp32 | natural | fail/not run | 0.941491 / 0.038740 | 22.81 | fail | 32.43% / 240 | fail | pass | pass | 2040.08 / fail |
| rife-4.25-lite | 1080p | fp16 | synthetic | fail/not run | 0.760375 / 0.055273 | 21.75 | fail | 24.88% / 194 | fail | pass | pass | 993.47 / fail |
| rife-4.25-lite | 1080p | fp16 | natural | fail/not run | 0.941690 / 0.039359 | 22.89 | fail | 28.78% / 240 | fail | pass | pass | 993.47 / fail |
| rt4ksr-x2 | 1080p | fp32 | synthetic | pass | 0.000004 / 0.000001 | 123.53 | pass | 100.00% / 1 | pass | pass | pass | 130.72 / pass |
| rt4ksr-x2 | 1080p | fp32 | natural | pass | 0.000004 / 0.000001 | 123.52 | pass | 100.00% / 1 | pass | pass | pass | 130.72 / pass |
| rt4ksr-x2 | 1080p | fp16 | synthetic | pass | 0.027811 / 0.004146 | 45.67 | fail | 73.03% / 7 | fail | pass | pass | 113.14 / pass |
| rt4ksr-x2 | 1080p | fp16 | natural | pass | 0.029060 / 0.003665 | 46.57 | pass | 78.11% / 8 | fail | pass | pass | 113.14 / pass |
| rife-4.25-lite | 540p | fp32 | synthetic | pass | 0.960784 / 0.067704 | 19.72 | fail | 25.62% / 245 | fail | pass | pass | 791.81 / fail |
| rife-4.25-lite | 540p | fp32 | natural | pass | 0.879377 / 0.044118 | 22.69 | fail | 23.75% / 224 | fail | pass | pass | 791.81 / fail |
| rife-4.25-lite | 540p | fp16 | synthetic | fail/not run | 0.960784 / 0.067498 | 19.75 | fail | 25.51% / 245 | fail | pass | pass | 379.72 / fail |
| rife-4.25-lite | 540p | fp16 | natural | fail/not run | 0.879377 / 0.044154 | 22.74 | fail | 22.49% / 224 | fail | pass | pass | 379.72 / fail |


## Final replay quality (gate H)

All six sequences; cut-straddling FG pairs excluded and recorded separately. Status `gate` is the fp32 screen; fp16 stays `supplementary`. CPU H is yes only for a complete final fp32 gate row that passed export parity and H. It does not admit the profile: failed device parity, capture parity or memory still stop it. Human inspection remains required beyond Stage 2.

| Candidate | Profile | Precision | Part | Status | H | Failing sequences | CPU H |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rife-4.25-lite | 720p | fp32 | FG 30->60 | gate | pass | — | yes |
| rife-4.25-lite | 720p | fp32 | FG 60->120 | gate | pass | — | yes |
| rife-4.25-lite | 1080p | fp32 | FG 30->60 | gate | pass | — | no |
| rife-4.25-lite | 1080p | fp32 | FG 60->120 | gate | pass | — | no |
| rife-4.25-lite | 540p | fp32 | FG 30->60 | gate | pass | — | yes |
| rife-4.25-lite | 540p | fp32 | FG 60->120 | gate | pass | — | yes |
| rt4ksr-x2 | 720p | fp32 | SR | gate | fail | cut, inertia, pan-fast, pan-slow | no |
| rt4ksr-x2 | 1080p | fp32 | SR | gate | fail | pan-fast | no |
| rife-4.25-lite | 720p | fp16 | FG 30->60 | supplementary | pass | — | no |
| rife-4.25-lite | 720p | fp16 | FG 60->120 | supplementary | pass | — | no |
| rife-4.25-lite | 1080p | fp16 | FG 30->60 | supplementary | pass | — | no |
| rife-4.25-lite | 1080p | fp16 | FG 60->120 | supplementary | pass | — | no |
| rife-4.25-lite | 540p | fp16 | FG 30->60 | supplementary | pass | — | no |
| rife-4.25-lite | 540p | fp16 | FG 60->120 | supplementary | pass | — | no |
| rt4ksr-x2 | 720p | fp16 | SR | supplementary | fail | cut, inertia, pan-fast, pan-slow | no |
| rt4ksr-x2 | 1080p | fp16 | SR | supplementary | fail | pan-fast | no |


## Full-path GPU observations and gate G

Milliseconds. Medians are medians of block medians; G uses the conservative sum of per-stage p95 values over accepted candidate/A-A rounds. Model spans include GPU idle while the CPU submits commands. No lower kernel bound was measured. R for the globe is unknown.

| Candidate/profile | Variant | Capture | Cin | Model span | Cout | P total | Reconstruction | R + reconstruction | Accepted / A-A % | Qualified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rt4ksr-x2/1080p | model-fp32 | true | — | — | — | — | — | — | 0 / — | false |
| rt4ksr-x2/720p | model-fp32 | true | — | — | — | — | — | — | 0 / — | false |
| rt4ksr-x2/small | model-fp32 | true | — | — | — | — | — | — | 0 / — | false |


| Profile/variant | Screen | p95 W | FG R budget / SR R_native_min rho=.25,.5 | G decision | Bound |
| --- | --- | --- | --- | --- | --- |
| 1080p/model-fp32 captured | SR | — | —, — | not evaluated (unqualified) | no admission bound |
| 720p/model-fp32 captured | SR | — | —, — | not evaluated (unqualified) | no admission bound |
| small/model-fp32 captured | SR | — | —, — | not evaluated (unqualified) | no admission bound |


Disqualified profiles were not timed. The combined FG→SR screen is not computed without admitted RIFE stage costs. Sustained 3 × 60 s and five-minute combined runs are not run when no profile passes the complete screen.

## Separate cold/cache-warm starts

Three starts per graph and cache state. Fetch, ORT import, session create and first/second output retirement are separate; these wall times include browser/CDP/setup interference and do not qualify as isolated cost.

| Candidate/profile | Precision | Cache | Rep | Fetch | Import | Create | First available | Second available | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rife-4.25-lite/small | fp32 | cold | 1 | 178.3 | 2.9 | 471.5 | 203.3 | 25.0 | completed |
| rife-4.25-lite/small | fp32 | cold | 2 | 177.3 | 2.9 | 476.9 | 210.9 | 27.7 | completed |
| rife-4.25-lite/small | fp32 | cold | 3 | 188.6 | 3.0 | 530.0 | 199.2 | 20.6 | completed |
| rife-4.25-lite/small | fp32 | cache-warm | 1 | 192.8 | 3.3 | 474.5 | 199.1 | 26.1 | completed |
| rife-4.25-lite/small | fp32 | cache-warm | 2 | 199.3 | 3.0 | 472.0 | 180.4 | 19.8 | completed |
| rife-4.25-lite/small | fp32 | cache-warm | 3 | 206.9 | 3.4 | 468.0 | 183.2 | 19.8 | completed |
| rife-4.25-lite/small | fp16 | cold | 1 | 89.0 | 2.9 | 519.5 | 204.5 | 19.1 | completed |
| rife-4.25-lite/small | fp16 | cold | 2 | 84.7 | 3.0 | 491.7 | 220.5 | 19.1 | completed |
| rife-4.25-lite/small | fp16 | cold | 3 | 84.8 | 2.8 | 472.4 | 210.6 | 19.2 | completed |
| rife-4.25-lite/small | fp16 | cache-warm | 1 | 89.9 | 3.1 | 477.1 | 199.1 | 20.8 | completed |
| rife-4.25-lite/small | fp16 | cache-warm | 2 | 97.4 | 3.3 | 471.8 | 196.4 | 19.3 | completed |
| rife-4.25-lite/small | fp16 | cache-warm | 3 | 96.1 | 3.2 | 489.8 | 198.1 | 19.0 | completed |
| rt4ksr-x2/small | fp32 | cold | 1 | 3.2 | 3.3 | 442.3 | 69.3 | 4.0 | completed |
| rt4ksr-x2/small | fp32 | cold | 2 | 3.5 | 3.7 | 456.3 | 67.3 | 4.0 | completed |
| rt4ksr-x2/small | fp32 | cold | 3 | 2.4 | 2.9 | 456.8 | 67.3 | 4.2 | completed |
| rt4ksr-x2/small | fp32 | cache-warm | 1 | 2.7 | 3.7 | 441.8 | 63.8 | 4.1 | completed |
| rt4ksr-x2/small | fp32 | cache-warm | 2 | 2.4 | 3.1 | 446.7 | 64.3 | 4.2 | completed |
| rt4ksr-x2/small | fp32 | cache-warm | 3 | 2.3 | 3.1 | 430.3 | 64.9 | 4.0 | completed |
| rt4ksr-x2/small | fp16 | cold | 1 | 1.8 | 3.0 | 453.6 | 72.7 | 4.0 | completed |
| rt4ksr-x2/small | fp16 | cold | 2 | 1.8 | 3.4 | 434.1 | 76.5 | 3.8 | completed |
| rt4ksr-x2/small | fp16 | cold | 3 | 1.8 | 3.3 | 456.2 | 76.3 | 5.7 | completed |
| rt4ksr-x2/small | fp16 | cache-warm | 1 | 1.8 | 3.1 | 445.5 | 67.0 | 3.8 | completed |
| rt4ksr-x2/small | fp16 | cache-warm | 2 | 1.8 | 3.6 | 440.2 | 70.7 | 3.8 | completed |
| rt4ksr-x2/small | fp16 | cache-warm | 3 | 2.6 | 3.5 | 453.7 | 67.9 | 3.7 | completed |
| rife-4.25-lite/720p | fp32 | cold | 1 | 265.2 | 3.2 | 476.2 | 231.8 | 114.3 | completed |
| rife-4.25-lite/720p | fp32 | cold | 2 | 263.0 | 3.2 | 497.0 | 242.9 | 113.9 | completed |
| rife-4.25-lite/720p | fp32 | cold | 3 | 256.4 | 3.4 | 489.3 | 232.8 | 116.6 | completed |
| rife-4.25-lite/720p | fp32 | cache-warm | 1 | 251.2 | 4.7 | 499.1 | 217.4 | 114.8 | completed |
| rife-4.25-lite/720p | fp32 | cache-warm | 2 | 260.9 | 3.3 | 480.6 | 214.8 | 115.4 | completed |
| rife-4.25-lite/720p | fp32 | cache-warm | 3 | 256.5 | 3.5 | 508.2 | 219.6 | 114.3 | completed |
| rife-4.25-lite/720p | fp16 | cold | 1 | 132.0 | 3.3 | 486.3 | 228.2 | 97.7 | completed |
| rife-4.25-lite/720p | fp16 | cold | 2 | 140.7 | 4.3 | 487.1 | 224.1 | 98.9 | completed |
| rife-4.25-lite/720p | fp16 | cold | 3 | 156.5 | 3.7 | 477.0 | 228.8 | 97.5 | completed |
| rife-4.25-lite/720p | fp16 | cache-warm | 1 | 126.0 | 3.3 | 498.5 | 221.9 | 97.5 | completed |
| rife-4.25-lite/720p | fp16 | cache-warm | 2 | 128.5 | 3.4 | 510.0 | 209.0 | 97.7 | completed |
| rife-4.25-lite/720p | fp16 | cache-warm | 3 | 128.5 | 3.4 | 492.6 | 204.8 | 100.3 | completed |
| rt4ksr-x2/720p | fp32 | cold | 1 | 2.9 | 3.4 | 476.2 | 79.1 | 9.2 | completed |
| rt4ksr-x2/720p | fp32 | cold | 2 | 2.6 | 3.5 | 448.3 | 80.0 | 10.9 | completed |
| rt4ksr-x2/720p | fp32 | cold | 3 | 2.4 | 3.5 | 468.9 | 78.2 | 9.1 | completed |
| rt4ksr-x2/720p | fp32 | cache-warm | 1 | 2.6 | 3.4 | 424.5 | 78.0 | 9.2 | completed |
| rt4ksr-x2/720p | fp32 | cache-warm | 2 | 4.2 | 3.7 | 435.0 | 76.5 | 9.3 | completed |
| rt4ksr-x2/720p | fp32 | cache-warm | 3 | 2.4 | 3.6 | 441.6 | 77.6 | 9.2 | completed |
| rt4ksr-x2/720p | fp16 | cold | 1 | 1.9 | 4.0 | 426.4 | 85.0 | 8.1 | completed |
| rt4ksr-x2/720p | fp16 | cold | 2 | 2.2 | 3.3 | 423.8 | 83.3 | 8.2 | completed |
| rt4ksr-x2/720p | fp16 | cold | 3 | 1.9 | 7.2 | 448.6 | 83.8 | 8.3 | completed |
| rt4ksr-x2/720p | fp16 | cache-warm | 1 | 2.1 | 3.1 | 458.7 | 74.7 | 8.3 | completed |
| rt4ksr-x2/720p | fp16 | cache-warm | 2 | 1.8 | 3.3 | 441.1 | 77.1 | 8.3 | completed |
| rt4ksr-x2/720p | fp16 | cache-warm | 3 | 2.0 | 3.4 | 434.4 | 79.6 | 8.4 | completed |
| rife-4.25-lite/1080p | fp32 | cold | 1 | 349.4 | 3.6 | 509.5 | 347.0 | 263.7 | completed |
| rife-4.25-lite/1080p | fp32 | cold | 2 | 388.2 | 4.0 | 507.6 | 351.8 | 274.5 | completed |
| rife-4.25-lite/1080p | fp32 | cold | 3 | 341.1 | 3.4 | 515.5 | 351.8 | 271.7 | completed |
| rife-4.25-lite/1080p | fp32 | cache-warm | 1 | 336.7 | 3.6 | 525.3 | 346.2 | 270.8 | completed |
| rife-4.25-lite/1080p | fp32 | cache-warm | 2 | 353.9 | 3.6 | 511.4 | 344.6 | 267.5 | completed |
| rife-4.25-lite/1080p | fp32 | cache-warm | 3 | 342.3 | 4.1 | 532.0 | 346.8 | 274.3 | completed |
| rife-4.25-lite/1080p | fp16 | cold | 1 | 175.0 | 3.4 | 497.5 | 317.0 | 216.5 | completed |
| rife-4.25-lite/1080p | fp16 | cold | 2 | 175.0 | 3.6 | 509.6 | 318.6 | 215.4 | completed |
| rife-4.25-lite/1080p | fp16 | cold | 3 | 173.3 | 3.4 | 520.0 | 319.1 | 217.4 | completed |
| rife-4.25-lite/1080p | fp16 | cache-warm | 1 | 162.3 | 3.4 | 511.0 | 303.5 | 216.4 | completed |
| rife-4.25-lite/1080p | fp16 | cache-warm | 2 | 171.4 | 3.5 | 526.2 | 306.5 | 217.1 | completed |
| rife-4.25-lite/1080p | fp16 | cache-warm | 3 | 181.0 | 3.5 | 526.1 | 313.1 | 217.6 | completed |
| rt4ksr-x2/1080p | fp32 | cold | 1 | 2.7 | 3.5 | 473.9 | 95.0 | 21.7 | completed |
| rt4ksr-x2/1080p | fp32 | cold | 2 | 2.5 | 3.5 | 481.6 | 93.4 | 21.9 | completed |
| rt4ksr-x2/1080p | fp32 | cold | 3 | 2.6 | 3.8 | 451.0 | 91.0 | 26.0 | completed |
| rt4ksr-x2/1080p | fp32 | cache-warm | 1 | 2.9 | 3.5 | 446.2 | 89.6 | 24.4 | completed |
| rt4ksr-x2/1080p | fp32 | cache-warm | 2 | 2.9 | 3.8 | 442.3 | 90.0 | 23.9 | completed |
| rt4ksr-x2/1080p | fp32 | cache-warm | 3 | 2.3 | 3.5 | 446.7 | 90.4 | 24.5 | completed |
| rt4ksr-x2/1080p | fp16 | cold | 1 | 2.6 | 3.7 | 457.3 | 97.5 | 17.7 | completed |
| rt4ksr-x2/1080p | fp16 | cold | 2 | 2.7 | 3.3 | 441.7 | 93.4 | 17.4 | completed |
| rt4ksr-x2/1080p | fp16 | cold | 3 | 2.7 | 3.6 | 445.4 | 92.4 | 17.7 | completed |
| rt4ksr-x2/1080p | fp16 | cache-warm | 1 | 2.0 | 3.5 | 448.5 | 88.1 | 17.6 | completed |
| rt4ksr-x2/1080p | fp16 | cache-warm | 2 | 2.6 | 3.3 | 468.0 | 87.8 | 17.5 | completed |
| rt4ksr-x2/1080p | fp16 | cache-warm | 3 | 2.1 | 3.8 | 460.6 | 88.6 | 17.7 | completed |
| rife-4.25-lite/540p | fp32 | cold | 1 | 235.2 | 6.7 | 523.1 | 229.4 | 81.2 | completed |
| rife-4.25-lite/540p | fp32 | cold | 2 | 262.3 | 4.2 | 523.1 | 236.1 | 84.9 | completed |
| rife-4.25-lite/540p | fp32 | cold | 3 | 279.5 | 3.4 | 530.3 | 225.9 | 80.9 | completed |
| rife-4.25-lite/540p | fp32 | cache-warm | 1 | 233.9 | 3.4 | 528.0 | 215.0 | 79.7 | completed |
| rife-4.25-lite/540p | fp32 | cache-warm | 2 | 266.3 | 4.0 | 496.4 | 209.1 | 82.1 | completed |
| rife-4.25-lite/540p | fp32 | cache-warm | 3 | 283.4 | 3.2 | 489.8 | 219.9 | 80.8 | completed |
| rife-4.25-lite/540p | fp16 | cold | 1 | 160.9 | 3.3 | 485.8 | 218.4 | 68.7 | completed |
| rife-4.25-lite/540p | fp16 | cold | 2 | 140.9 | 3.3 | 502.3 | 219.2 | 70.0 | completed |
| rife-4.25-lite/540p | fp16 | cold | 3 | 129.3 | 3.3 | 508.5 | 216.2 | 69.1 | completed |
| rife-4.25-lite/540p | fp16 | cache-warm | 1 | 118.8 | 3.6 | 523.8 | 207.2 | 69.2 | completed |
| rife-4.25-lite/540p | fp16 | cache-warm | 2 | 114.8 | 3.5 | 524.1 | 203.6 | 69.6 | completed |
| rife-4.25-lite/540p | fp16 | cache-warm | 3 | 110.3 | 4.2 | 523.9 | 203.6 | 69.2 | completed |

