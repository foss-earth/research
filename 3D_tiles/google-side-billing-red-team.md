# Red team: Google-side billing

Research date: 2026-11-04. Owner: FOSS Earth.

This attacks [How Google bills Photorealistic 3D Tiles](google-side-billing.md) and the quota rule in the [tiles session grant](https://github.com/foss-earth/docs/blob/main/docs/proposals/tiles-session-grant.md). It is an attack on those controls, not a design to build.

Labels: **[P]** is a Google page. **[O]** is the working tree read on this date. **[I]** is the attack.

## Result

[I] Do not sell a session, and do not set the daily root quota to the sum of `sessionsRemaining`. That sum is the size of the copied-key attack, and midnight Pacific refills it. The wallet never sees the copy. The shipping renderer will also spend new roots by itself.

The requirement that a balance hits zero and Google stops the same moment is not available. A root session, once the key is in the page, is an open pipe until the project quota or a person rotating the key stops it.

## The expensive reading has no cap

[P] The [SKU page](https://developers.google.com/maps/billing-and-pricing/sku-details/maps) bills "a request that returns a 3D tile." The [usage page](https://developers.google.com/maps/documentation/tile/usage-and-billing) says renderer tile requests do not touch the daily root quota and are unlimited per day, aside from 12,000 renderer queries per minute for the whole project.

[I] If the SKU sentence is the invoice, one flight is thousands of billed tiles and the root quota never moves. Two cents against that is a loss on the first minute. The only hard cap the billing note trusts does not apply to the thing being billed. There is no second cap behind it.

[P] [Section 2.2 of the Maps Platform Terms](https://cloud.google.com/maps-platform/terms) says Google's measurement of use is final, and the duty to pay the fees is non-cancellable except where law requires otherwise. A dispute becomes a service credit only if Google decides the invoice was their inaccuracy. An export after the fact cannot unwind a week of mesh traffic.

[I] Credits stay unpriced until one `root.json` and the `.glb` files that followed have been compared with the `C6E1-98B2-DBD0` count. The billing note already says this and then still recommends a retail price and a quota. The quota recommendation assumes the cheap reading. The attack is to refuse both until the export exists.

## The quota refills

[P] Daily quotas reset at midnight Pacific. The root quota is one number for every key in the project.

[I] A copied key calls `root.json` without `createTilesSession`. Balances do not move. Google bills the project. The next Pacific day the counter is zero again and the balances are still there, so the same copy spends the sum again. Loss is the sum times the number of days until the key is rotated, not the sum.

A page that compares "today's roots" with "today's grants" only helps if a person sees it and rotates the key before the next midnight. The billing note names that comparison and does not make it a page. An unread report is not a control.

Lowering the quota when the sum falls has the same hole in the other direction. Quota enforcement lags, so a burst around the cap overshoots. A sum of three or four sessions, which is the honest early total, is also small enough that a double root fetch takes the site down. The usual repair is to raise the quota. That is how the cap stops being the sum.

Setting the quota to one account's balance would throttle every other account and would still refill. One project per person refills too, and it is a project farm under a single billing account. Neither one is a wallet.

## The browser is handed the key, and the renderer spends it

[P] The [renderer guide](https://developers.google.com/maps/documentation/tile/create-renderer) requires the API key on every child request. The [FAQ](https://developers.google.com/maps/faq) lists Map Tiles as an IP-restricted web service, and a referrer restriction fails on that class of API. An IP allow-list rejects the visitor. The key that can draw the mesh has no application restriction.

[P] [Section 1.2](https://cloud.google.com/maps-platform/terms) makes the customer responsible for any use of its API keys, and for ensuring that only authorized domains and applications use the Services. [Section 4.1](https://cloud.google.com/maps-platform/terms) requires the customer to prevent and terminate unauthorized use and to notify Google when it learns of it. [Section 5.2](https://cloud.google.com/maps-platform/terms) lets Google suspend the project immediately on suspected unauthorized access, or on a breach of the license restrictions.

[I] One copied key is a project-wide outage, not a single user's empty wallet. Rotation kills every in-flight session, because they all hold the same key. The grant records in Firestore store that key inside `rootUrl`, so a rules mistake or an export leaks it again after rotation if the old key was not deleted.

[O] The engine does not wait for a grant to refresh. `createTilesRuntime` builds `GoogleCloudAuthPlugin` with `autoRefreshToken: true`. On a response from 400 through 499 the plugin calls `refreshToken`, and for 3D tiles that URL is `root.json` with the key. The engine then forces that refresh to `cache: "reload"`, so it does not stop at a 304. Root loads on the tileset itself use `cache: "no-cache"`. A 4xx tile is a new root request, billed or not, with no debit. The proposal's "turn automatic refresh off" is not what this tree does.

## A rejected tile spends another session

[I] The proposal debits a new session when a Google tile is rejected. The plugin, left on, also fetches a new root for the same rejection. One failure can bill Google twice and debit the wallet once. A 429 from the shared 12,000-per-minute renderer cap, a quota failure, and an expired session are all rejections. A busy minute, or a loop of failures, empties a balance that was supposed to be three hours of flying. The client cannot tell those statuses apart from the rule as written.

A reload is a new root if the page asks for one. The signup grant is one session. Opening Earth and then flight is two, and a tour that mounts Earth can make it two on one visit. The person who bought "a session" did not buy that.

## Terms that can take the project down

These are the clauses a suspension would cite. They are not a legal opinion.

[P] [Section 3.1](https://cloud.google.com/maps-platform/terms) is a non-sublicensable license to use the Services in the customer's own applications. [Section 3.2.1(b)](https://cloud.google.com/maps-platform/terms) forbids selling, reselling, sublicensing, transferring, or distributing the Services, and "Customer will not" includes not permitting a third party to do it. [Section 3.2.1(c)](https://cloud.google.com/maps-platform/terms) forbids use intended to avoid fees. [Section 3.2.3(d)](https://cloud.google.com/maps-platform/terms) forbids redistributing the Google Maps Core Services or passing them off as the customer's services, and forbids a substitute for those services. The product has to carry substantial, independent value beyond Google's.

[I] A wallet whose product is "buy 3D Tiles credits" is the resale the license names. Earth, the tour, and the flight simulator are applications that display tiles. Those are different products. Selling the credit as the thing itself is the framing that matches 3.2.1(b) and 3.2.3(d). Cesium ion's key-in-the-URL pattern is not permission.

[P] [Section 3.2.3(e)](https://cloud.google.com/maps-platform/terms) says the customer will not use the Google Maps Core Services with or near a non-Google map. The examples are Places content on a non-Google map, Street View beside a non-Google map, and linking a Google map to non-Google map content. The session grant keeps flat maps on when the balance is empty. The app already has non-Google basemaps.

[P] [Section 3.2.3(a)](https://cloud.google.com/maps-platform/terms) forbids bulk download of Google Maps tiles. [Section 4.1](https://cloud.google.com/maps-platform/terms) makes end-user use the customer's duty. A signed-in browser that walks a city and saves meshes is the customer's breach, and the key cannot be limited to one signed-in browser.

## What would have to be true

[I] The design is a metered tile service only if all of these hold:

1. A billing export shows one `C6E1-98B2-DBD0` count for one root and none for the meshes. Until then the price is unknown and the root quota may be irrelevant.
2. The daily root quota is a loss limit in dollars that can be lost every Pacific day, small enough to notice, and paired with a same-day key rotation. It is not the sum of unused balances.
3. `autoRefreshToken` is off, and a 4xx does not both refresh the root and debit a session. Debit when a new root is actually granted, and do not treat a rate limit as an expiry.
4. The thing being sold is the application. The credit is an internal meter for that application. The terms questions above are answered before anyone pays.
5. One shared key is accepted as a shared fate: one copier, or one bulk download, can suspend every user, and rotating the key ends every session in flight.
