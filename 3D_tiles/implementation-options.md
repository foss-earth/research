# Ways to offer Photorealistic 3D Tiles

Status: options. Nothing here is chosen. More than one can ship.
Date: 2026-11-04.

Billing facts are in [How Google bills Photorealistic 3D Tiles](google-side-billing.md). The attack on the shared-key quota is in [the red team](google-side-billing-red-team.md). Two write-ups already exist and stay the detailed specs if that way is built: the [tiles session grant](https://github.com/foss-earth/docs/blob/main/docs/proposals/tiles-session-grant.md) and the [tile proxy](https://github.com/foss-earth/docs/blob/main/docs/proposals/accounts-and-hosted-basemaps.md).

## The job

A person opens Earth, the campus tour, or flight and sees Photorealistic 3D Tiles. Someone pays Google. Tiles stop when that someone's limit is reached. Mesh bytes are large. Flat maps already work with no Google key.

Every way below answers three questions: who pays Google, where the mesh bytes go, and what actually stops spend. Identity (none, Firebase, or a private account server) and card payment (none, or Stripe) attach to several ways. They are not separate tile architectures.

The SKU count is still unmeasured. Any way that charges a person a price per session waits on one billing export: one `root.json` and the `.glb` files that followed, compared with SKU `C6E1-98B2-DBD0`.

## Summary

| Way | Who pays Google | Mesh path | What stops spend | Ready to price |
| --- | --- | --- | --- | --- |
| Own key | That person | Device to Google | Their Cloud project | Yes, they pay Google |
| Session grant | foss-earth | Device to Google | The next grant, for a cooperative client | After the export |
| Session grant with a fixed daily cap | foss-earth | Device to Google | Project root quota, refilled nightly | After the export, cap is a loss limit |
| Project per account | foss-earth | Device to Google | That project's daily root quota | No, the quota refills |
| Pool of small projects | foss-earth | Device to Google | The slot's daily cap | Same refill |
| Full proxy | foss-earth | Device to our host to Google | The host refuses the next byte | After the export, and only with real bandwidth |
| Root fetched on the server | foss-earth | Device to Google | Does not keep the key off the device | No |
| OAuth token instead of a key | foss-earth | Device to Google | Token expiry, then a new root is still possible | No |
| Cesium ion or another partner | That account | Device to Google | Whatever the partner enforces | Their price list |
| Immersive Maps | foss-earth | Google's 3D map, not this tileset | Map load or monthly user | Different product |
| Closed group on a capable host | foss-earth or the school | Proxy or a dedicated project | The host, or that project's cap | For a known list of people |
| Hosted build has no Google tiles | Nobody | None | There is no Google bill | Yes |

## 1. The person's own key

Already built. `?gkey=` for one visit, and a key saved on the device.

The person creates a Cloud project, enables Map Tiles, and pays Google. The renderer calls `tile.googleapis.com` directly. foss-earth never sees the bill.

Pros: no shared key, no resale of the Service, no mesh host, no wallet to get wrong. Their quota and their invoice are the cutoff. Works for web, native, and a headset as long as the key's restriction matches that client.

Cons: the setup is the thing people will not do. A referrer restriction fails on this API, so their key is IP-restricted or unrestricted. An unrestricted personal key has the same copy problem, on their bill.

## 2. Session grant

The [session grant](https://github.com/foss-earth/docs/blob/main/docs/proposals/tiles-session-grant.md). Firebase sign-in, a balance in Firestore, one Cloud Function returns `root.json?key=SHARED`. The device downloads meshes from Google. Stripe sells whole-dollar top-ups. The function debits one unit per grant.

Pros: the person never creates a Cloud project. Mesh bytes skip our host. Sign-in, the database, and the function are managed. Flat maps stay up when the balance is empty. The own-key path can still win for that visit.

Cons: the key that draws meshes can open another root, and it cannot be referrer-restricted or IP-restricted. The wallet stops a client that asks for a grant. It does not stop a copied key. The daily quota refills at midnight Pacific, so a sum-of-balances quota is the size of that attack every day until the key is rotated. The shipping renderer has `autoRefreshToken` on and will fetch a new root on a 4xx by itself. A license review still has to clear selling access to the Service. One key is one fate: a copier or a bulk download can get the project suspended for everyone.

## 3. Session grant with a fixed daily loss cap

Same shape as the session grant. The project daily root quota is a number of dollars that can be lost every Pacific day, not the sum of unused balances. A billing alert pages a person, who rotates the key the same day. The wallet still meters cooperative clients.

Pros: keeps the direct mesh path and the small amount of server code. The cap stays small when many people have unused credits. Rotation is an explicit step, not an assumption that the quota is a wallet.

Cons: every copied key can spend that cap once per Pacific day. Paying users share the outage when the cap is hit or the key is rotated. Real-time denial of a session that has already started does not exist. Still needs the SKU export and the license reading. Still requires `autoRefreshToken` off, or the renderer spends roots the wallet did not debit.

## 4. One Google project per account

The grant function creates a Cloud project, a Map Tiles key, and a daily root quota equal to that account's remaining sessions. The browser uses that key directly.

Pros: a copied key spends that account's daily number, not every other customer's. The blast radius is one person.

Cons: the quota is a rate. It refills at midnight, so the key can spend the remaining balance once per day until someone lowers the quota or deletes the key. Quota edits lag and are a support request at the high end. Project count is limited. One billing account has to hold all of the projects; splitting billing accounts is a terms violation, and the free tier does not multiply. This is a lot of machinery for a cutoff that still refills. The key is still in the browser.

## 5. A pool of small projects

A handful of Cloud projects, each with a small daily root cap and its own key. A grant assigns the person to a slot. Slots are recycled when the Pacific day resets.

Pros: one copier burns one slot, not the whole product. Fewer projects than one-per-account. Direct mesh path stays.

Cons: everyone in a slot shares that cap and that key. Assignment, rotation, and "this slot is exhausted" are a scheduler we would own. A determined copier who collects several granted keys burns several slots. Same refill, same SKU question, same license question.

## 6. Full proxy

The [proxy spec](https://github.com/foss-earth/docs/blob/main/docs/proposals/accounts-and-hosted-basemaps.md). The key lives on a host and is IP-restricted. The browser asks our host for `/v1/3dtiles/…`. The host adds the key, forwards to Google, and streams the body back. A balance check runs on the root and can refuse further forwards when the account is empty.

Pros: the key never reaches the page, so a copied page cannot open a new root. This is the way that can refuse the next request when a balance hits zero, including mid-session. IP restriction matches the API. A known set of people on a capable network can use it.

Cons: every mesh byte crosses the host. A laptop on Wi-Fi cannot carry public traffic. Egress costs money and adds a round trip to every tile. The host is ours to run. The Maps terms forbid caching the meshes, so the host cannot keep them to save bandwidth. Google still bills the project for whatever the host requests. A stolen host credential spends the key until the host is shut off.

## 7. Fetch the root on the server

The function calls `root.json`, stores the session, and returns tileset JSON with the key removed.

Pros: looks like the key stays in Secret Manager, and exactly one root is billed per grant.

Cons: it does not work. Child URLs carry `session` and not the key, and the renderer guide requires the key on every later tileset and `.glb`. The browser still needs the key, and that key can request a new root. This way is recorded so it is not redesigned by accident.

## 8. An OAuth token instead of a key

The usage page allows an OAuth token on Map Tiles requests. The function mints a short-lived token and the renderer sends it.

Pros: the token expires, so a copy dies within an hour instead of living until rotation.

Cons: the token is still the project's credential. Until it expires it can open new roots. Mesh requests need a credential for the whole session, and a session is about three hours, so a one-hour token dies while the meshes are still loading. It is not a balance and it is not per person.

## 9. Cesium ion, or another partner account

The app asks a partner for a root URL. Ion's `GET /v1/assets/{id}/endpoint` already returns a root URL with a key. The device talks to Google. The Google bill lands on the partner account, and the partner bills foss-earth or the person.

Pros: the Google relationship, the invoice, and the key operations belong to a company that already ships this. Native and headset builds already use that pattern. foss-earth writes no tile host. Their account absorbs the SKU question.

Cons: their price, their outage, and their terms. The URL still contains a key unless their product says otherwise, which we have not measured. Per-person cutoff is whatever they enforce. A product whose pitch is "their tiles, but we bill you" may be the same resale question aimed at their contract. This does not, by itself, give a penny balance.

## 10. Immersive Maps instead of 3D Tiles

Google's 3D map in the Maps JavaScript API and the Maps 3D SDKs. Billed as a map load (`4816-83A2-9059`) or a monthly active user (`0DD1-CAD3-606B`), not as a 3D Tiles root.

Pros: the bill is a load or a person-month, which is closer to a membership than to a root. Google's SDK holds the credential. There is no shared Map Tiles key in the page.

Cons: it is not the tileset the engine loads. Flight, the tour, and Earth would take a different renderer, or a second one. The per-user SKU is a monthly active device, not a balance that hits zero mid-flight. Pricing and the three-hour mesh session do not transfer.

## 11. A closed group on a host that has bandwidth

A class, a lab, or a school. The set of people is known. The host is a machine on a wired network, not a laptop on Wi-Fi. Either the full proxy or a dedicated Cloud project with a small daily cap. Sign-in can be the school's Google accounts.

Pros: the dangerous public copy is out of scope. Bandwidth is sized to the group. A teacher can turn the key off. The own-key path still serves anyone outside the group.

Cons: it does not become the public product by adding users. The host is an operations job. A dedicated project still refills its daily cap if the key leaks onto the campus network.

## 12. The hosted build has no Google tiles

Published Earth, tour, and flight keep flat maps and any other basemap that is not Google. Photorealistic tiles appear only for a person who brings a key.

Pros: no Google bill, no key to leak, no license question, nothing to meter. The own-key path remains for people who want the mesh.

Cons: the hosted visit never shows 3D tiles. That drops the goal of a person signing in and seeing them.

## What can ship together

These stacks do not share a key.

Public web. Own key for anyone who has one. Flat maps for everyone else. A session grant, if it ships, uses way 3: a fixed daily loss cap, `autoRefreshToken` off, and a same-day rotation when roots run ahead of grants. Way 2's sum-of-balances quota stays off that stack.

Campus or a class. Way 11, proxy or a separate project, for that group only. Their key is not the public web key.

Headset or native. Own key, or way 9, on a credential that is not the website key. A binary cannot use a referrer, and the website key must not be copied into it.

Immersive Maps is a replacement for the tileset on a given screen, not a second source for the same renderer.

Way 4 and way 5 can sit beside the own-key path. They should not put their keys in the same Cloud project as each other or as way 3. Quotas are per project. One project means one shared cap and one shared fate.

## What each way still needs

The export comes before any price in ways 2, 3, 4, 5, 6, and 11. Way 1 and way 12 do not need it. Way 9 uses the partner's price. Way 10 uses a different SKU.

Ways 2 and 3 need the license reading in the red team before a person pays for access. Way 6 needs a host that can carry the meshes and must not store them. Way 7 and way 8 do not become the design.
