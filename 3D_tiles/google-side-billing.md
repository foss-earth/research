# How Google bills Photorealistic 3D Tiles

Research date: 2026-11-03. Owner: FOSS Earth.

This is the billing source for the [tiles session grant](https://github.com/foss-earth/docs/blob/main/docs/proposals/tiles-session-grant.md). The attack on these controls is [the red team](google-side-billing-red-team.md). It is research, not an implementation. The pages below were read on this date. No request was sent to `tile.googleapis.com`, and no Cloud billing export was available, so the invoice count per root is not yet observed.

Labels: **[P]** is a Google page read that day. **[I]** is a conclusion drawn from those pages.

## What to set the quota to

[I] Set the project's Photorealistic 3D Tiles daily root quota to the sum of `sessionsRemaining` across accounts. Lower it when that sum falls. Leave it there only while that sum is the number of roots we are willing to have billed today.

[P] A quota is one number for the Cloud project. Every API key in the project shares it. Daily quotas reset at midnight Pacific time. Lowering the per-day quota is how Maps Platform puts a hard cap on a bill. When the project reaches the limit, further requests fail until the reset. See [Manage Google Maps Platform costs](https://developers.google.com/maps/billing-and-pricing/manage-costs) and [Map Tiles API usage and billing](https://developers.google.com/maps/documentation/tile/usage-and-billing).

[P] The published default for this product is 10,000 root tileset queries per day per project. At the first paid tier that is $60 of list-price roots every Pacific day. Held for a 30-day month it is 300,000 roots, about $1,614 on the global price list below. That default is a capacity number from Google, not a balance.

[I] Google does not offer a quota equal to one person's remaining balance. The dimensions published for Photorealistic 3D Tiles are roots per project per day, and 12,000 renderer queries per project per minute. There is no per-key spend cap and no per-person lifetime cap on this SKU. A daily quota set to one account's balance would be the cap for every account in that project, and the counter would fill again at midnight even if the wallet had not.

[I] One Cloud project per person, with that project's daily quota edited to that person's `sessionsRemaining`, is the closest Google-side approximation. It is still a rate: the same key can spend that many roots again the next Pacific day. It also means a project, a key, and a quota edit per account, under a single billing account. The [Maps Platform FAQ](https://developers.google.com/maps/faq) treats multiple billing accounts as a violation, so the free tier and the volume price do not multiply by splitting projects. That shape fights a small build. The grant function remains the per-person stop. The project quota is the stop for roots that never ask the function.

[P] Quota enforcement lags the moment a limit is crossed, so a cap can overshoot. [Capping API usage](https://docs.cloud.google.com/apis/docs/capping-api-usage) says to leave a buffer when a quota is standing in for a dollar limit. A few extra roots at $0.006 is the buffer that matters at current balances. [P] On the [reporting page](https://developers.google.com/maps/documentation/tile/report-monitor), successful requests and requests that cause server errors count against quota. Requests that fail authentication do not.

## What is billed

[P] The SKU is **Map Tiles API: Photorealistic 3D Tiles**, id `C6E1-98B2-DBD0` globally and `592E-920B-C911` for an India billing address. Category: Enterprise. The [SKU page](https://developers.google.com/maps/billing-and-pricing/sku-details/maps), updated 2026-11-02, names the billable event as "Request that returns a 3D tile" and the trigger as "3D Tiles."

[P] The [global price list](https://developers.google.com/maps/billing-and-pricing/pricing), also updated 2026-11-02, prices that SKU per 1,000 monthly events. Volume for the tier is the sum of every project on the customer billing account for the month. The free cap for an Enterprise SKU is 1,000 events a month. The bands are marginal, in the same way the price list's worked example charges each band only for the events inside it.

| Monthly events | USD per 1,000 |
| --- | --- |
| 1–1,000 | 0 |
| 1,001–100,000 | 6.00 |
| 100,001–500,000 | 5.10 |
| 500,001–1,000,000 | 4.20 |
| 1,000,001–5,000,000 | 3.30 |
| 5,000,001 and above | 2.40 |

One root in the first paid band costs $0.006. Two cents of wallet price is a bit over three times that cost. The first 1,000 roots on the billing account each month are free, so early signup grants can land inside that cap. Above 100,000 roots in a month the marginal root falls to $0.0051, then $0.0042 above 500,000. Revisit the two-cent price at those volumes.

[P] An India billing address uses the other SKU: 7,000 free events a month, then $3.30 per 1,000 through 5,000,000 and $2.40 after that, on the [India price list](https://developers.google.com/maps/billing-and-pricing/pricing-india). This note assumes the global SKU until the billing account says otherwise.

[P] The usage page's quota section is more specific than the SKU sentence. Root tileset queries count against the daily quota. Renderer tile requests for Photorealistic 3D Tiles do not, and they are unlimited per day aside from the 12,000-per-minute renderer rate. Session-token and viewport calls on the 2D tile API are a different product and are not billed there either. Google's May preview post said the root tileset request would become the unit of billing for this API: [Photorealistic 3D Tiles now in Preview with updated daily quotas](https://mapsplatform.google.com/resources/blog/photorealistic-3d-tiles-now-preview-updated-daily-quotas/).

[I] Those two Google wordings disagree. "A request that returns a 3D tile" is the same shape of sentence the 2D SKU uses for a charge on every tile. The quota page and the preview post say the root is the unit. Until a billing export for `C6E1-98B2-DBD0` shows one count for one `root.json` and no count for the `.glb` files that followed, the retail price stays provisional. The export is the measurement at the end of this note.

[P] This SKU is not Immersive Maps. Immersive Maps (`4816-83A2-9059`, and the per-user SKU `0DD1-CAD3-606B`) bills a 3D map load or a monthly active user of the Maps 3D SDK and the JavaScript 3D map. It does not sell a root session with a balance.

[P] The usage page still mentions a $200 monthly Maps credit that ran through 28 February 2025. That date has passed. It is not a current allowance.

## What a session buys

[P] A client starts with:

`https://tile.googleapis.com/v1/3dtiles/root.json?key=KEY`

The [3D Tiles guide](https://developers.google.com/maps/documentation/tile/3d-tiles), updated 2026-11-02, says one root request allows at least three hours of tile requests, and after that limit another root request is required. The [usage page](https://developers.google.com/maps/documentation/tile/usage-and-billing) says the timed session token allows up to three hours of renderer tile requests from a single root request. Both sentences are current and they do not match. Product copy can say three hours. The client should keep using a session that Google is still serving, and request a new root when a tile request is rejected. A timer that fetches `root.json` at three hours pays for a root the session may still cover, or pays late if the session ended earlier.

[P] Child URIs in the root response are path-and-query only. They carry `session` and do not carry the key. The [renderer guide](https://developers.google.com/maps/documentation/tile/create-renderer) says the key has to be attached to every later tileset and `.glb` request, next to `session`. A sample tile URL is:

`https://tile.googleapis.com/v1/3dtiles/datasets/CgA/files/UlRPVEYubm9k.glb?session=SESSION&key=KEY`

[I] Fetching the root on a server does not keep the key off the device. The browser still needs the key for every mesh, and that same key can request `root.json` again. The meshes can go straight from the device to Google. The ability to open a new billable root goes with them.

[I] Each successful `root.json` is the thing to spend a wallet unit on. A second tileset on the same page, a health check that hits `root.json`, a reload that requests the root URL again, and an automatic token refresh are each another billable root if Google returns it. Holding one tileset for the life of the page, and asking for a new grant only after Google rejects a tile, is the saving the API actually offers.

[P] The [Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies) forbid prefetching, indexing, storing, or caching Content, except for the narrow cases in the terms, and they tell the client to honor `Cache-Control`. A mesh cache is out. Keeping the tileset the page has already loaded is ordinary rendering. Writing the root document to disk to skip a later bill is the kind of storage those policies forbid. The `Cache-Control` value Google puts on `root.json` was not observed. If a conforming refetch returns a new root, that refetch is another candidate billable event, and the billing export should count it.

## What the key can restrict

[P] The [FAQ credential table](https://developers.google.com/maps/faq) lists Map Tiles API as an API key with an IP-address application restriction. Footnote 1 says application restrictions are optional. The same FAQ says a web-service key with an HTTP referrer restriction fails: "API keys with referer restrictions cannot be used with this API." IP restriction is the restriction Google names for this API. The address Google sees on a browser request is the visitor's, so an IP allow-list of a server would reject the direct mesh path.

[I] A key that the browser can use for meshes is unrestricted by application. Restrict it to the Map Tiles API so it cannot call other Google products. That API restriction does not cap how many roots the key can open. Referrer allow-lists in the session-grant draft do not survive this page. Cesium's published sample puts the key on the root URL in the page, which is the unrestricted shape.

[P] The usage page also allows an OAuth token in place of a key. That token still belongs to the Cloud project that pays. It is not a balance, and it can open a root for as long as it is valid.

## What the grant should do with this

[I] These are the billing consequences for the session grant:

1. Debit one wallet unit when a grant is issued, and make that grant the only path that is supposed to call `root.json`.
2. Set the daily root quota to the sum of outstanding sessions, and lower the quota as that sum drops. Do not leave 10,000 in place. A leaked key can still repeat that sum every Pacific day until the key is replaced, so compare the day's root count with the day's grants and rotate the key when Google's count runs ahead.
3. Keep `autoRefreshToken` off. Renew on a rejected tile request, not on a three-hour clock.
4. One tileset per page. Do not request `root.json` to test the key.
5. API-restrict the key to Map Tiles API. Do not add a referrer restriction. Do not add an IP restriction on the key the browser uses.
6. Treat two cents per session as provisional until the billing export below agrees that one root is one SKU count.

## Measurement still open

[I] With a billing-enabled project whose daily quota is already small, request `root.json` once, load tiles for a minute, and record the number of `root.json` responses and the number of `.glb` responses. The next billing export for `C6E1-98B2-DBD0` should be compared with those two counts. One count matching the root, and a zero matching the meshes, confirms the session price. A count matching the meshes means the wallet unit is wrong and this note has to be revised before any credit is sold. The same export shows whether a reload, and whether a cache revalidation of `root.json`, adds a second count.
