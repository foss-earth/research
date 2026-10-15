# Hosted access to Google Photorealistic 3D Tiles

Status: implementation specification. Runtime changes are not implemented by this document.
Date: 2026-10-14.

## Intended result

A student can open the campus tour, and a person with an invite can open a hosted
copy of 0SFS, and both can see Google Photorealistic 3D Tiles. Neither person
receives the Google Maps key, and neither can spend the key outside the limit
set for them.

The public 0SFS build stays as it is: someone who has their own key passes it
once with `?key=`, it is saved on that device, and it is removed from the
address bar. A hosted visit does not use that setting.

The first university test can ship with a class invite. Sign-in with a
`umn.edu` Google account is the same grant afterwards, not a different tiles
path.

## What this is asking Google to do

Google bills and quotas Photorealistic 3D Tiles on the Cloud project that owns
the key. The [Maps Platform FAQ](https://developers.google.com/maps/faq) lists
Map Tiles API as an API key restricted by IP address. A referrer-restricted key
is rejected by that class of API. There is no per-student key, and a student's
Google login does not move the bill onto their account.

The [3D Tiles guide](https://developers.google.com/maps/documentation/tile/3d-tiles)
loads tiles by giving a renderer

`https://tile.googleapis.com/v1/3dtiles/root.json?key=YOUR_API_KEY`

and the renderer then requests every child with that same key. One successful
root request covers about three hours of tile downloads. Those later downloads
do not count against the daily root quota. The default project cap is 10,000
root requests a day, and the cap can be set lower. Opening or reloading the
page starts a new root request.

The [Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies)
allow a private or password-protected app. They require the Google Maps logo
and the aggregated `asset.copyright` line. They forbid storing the tile
content. A pass-through proxy respects that. A cache of the meshes does not.

So the Google key lives only on a server whose public IP is the key's
application restriction. People authenticate to that server. The server adds
the key when it forwards `/v1/3dtiles/…` to `tile.googleapis.com`.

## Scope

This specifies:

- the proxy that holds the key and forwards tile requests;
- grants, class invites, and `umn.edu` sign-in, as three ways to mint the same grant;
- the FOSS Earth credential that can talk to that proxy without a Google key;
- what the campus tour and a hosted 0SFS build do with it;
- the Cloud Console steps that make a leaked client useless.

FOSS Earth owns the client credential and the hosted fetch plugin. The proxy
is a new process with its own store. The campus tour owns the class-invite and
`umn.edu` gates. 0SFS owns friend invites on the hosted build. The public
0SFS build owns nothing new.

CARTO keys, raster basemaps, and a person's own Google key are unchanged.

## Current implementation

Observed in the working copies on 2026-10-14:

- `engine/src/babylon/createTilesRuntime.ts` always builds the renderer with
  `https://tile.googleapis.com/v1/3dtiles/root.json` and requires a non-empty
  `apiKey`. It registers `GoogleCloudAuthPlugin` with that string as
  `apiToken`.
- `GoogleCloudAuth.fetch` in `3d-tiles-renderer` 0.4.24 writes `key` onto
  every request URL. Child tileset URIs from Google are root-relative and
  already carry `session`. The plugin also copies `session` onto later
  requests. The key is therefore present on the root request and on every
  mesh request.
- `engine/src/settings/catalogue/map.ts` stores that secret as
  `map.source.googleKey` (`sensitive: true`). The description says it is kept
  on the device and sent to Google.
- `getGoogleApiKeyFromSearchParams` in `engine/src/settings/mapRuntimeConfig.ts`
  reads `key` or `googleKey`. A saved key or a host-supplied key makes Google
  tiles the default basemap. The address-bar value is removed after it is
  saved; the saved value remains in the device settings.
- `redactTileUrl` in `engine/src/browser/describeGoogleTileFailure.ts` already
  redacts `key`, `session`, `token`, and `api_key` in failure reports.
- The auth plugin also sets the renderer's recommended `errorTarget` of 20
  and aggregates copyright strings for attribution. Hosted mode has to keep
  both of those behaviors.
- 0SFS documents the device key in `fly/README.md` and `fly/docs/development.md`.
  The public site can fly on raster basemaps with no Google key.

`GoogleCloudAuthPlugin` cannot be pointed at the proxy with the real key, and
it cannot be pointed at the proxy with a stand-in `apiToken`. In both cases
it puts that token in the query string of every tile URL. The hosted path
does not register it.

## Decisions

1. Two credential kinds. `device-key` is today's path. `hosted` is a proxy
   root URL plus a grant. A page uses one of them for a given tiles runtime.
2. The grant is a bearer token in the `Authorization` header. It is not a
   query parameter, not `map.source.googleKey`, and not written into the
   settings registry or an export.
3. The proxy root is an absolute URL ending in `/v1/3dtiles/root.json` on the
   proxy's origin. Google's child URIs start with `/v1/3dtiles/`, so the
   renderer resolves them back to that origin. The proxy does not rewrite
   tileset JSON.
4. Each successful forward of `root.json` spends one root request. Mesh and
   child-tileset forwards do not. A reload spends another root request. The
   proxy does not try to share one Google session across people.
5. A class invite, a friend invite, and a verified `umn.edu` account all mint
   a grant with the same fields. The tiles client does not care which gate
   produced it.
6. The public 0SFS build has no proxy origin and no grant. A compiled-in
   proxy origin belongs only to a hosted build.
7. The Cloud project's daily root quota is the spending backstop. A budget
   alert is email only and is not treated as a cap. Per-grant and per-invite
   counts are the product limits, set lower than that quota.
8. The proxy streams responses and does not store tile bodies. It forwards
   `Cache-Control` and `ETag` so the browser can follow them.
9. Version one has a server CLI for invites. It does not have a web admin.

## Proxy

One process, one stable public egress IP. The Google key is an environment
variable on that process. The key's application restriction is that IP, and
its API restriction is Map Tiles API only. It is a different key from any key
people use with `?key=` in development.

The process allows browser calls only from an explicit list of origins (the
campus tour origin, and the hosted 0SFS origin when that build exists).

### Forwarding

`GET /v1/3dtiles/*` with `Authorization: Bearer <grant>`:

1. Resolve the grant. Missing, unknown, expired, or revoked: `401`, and do
   not call Google.
2. Take the path and query from the incoming request. Refuse anything that
   is not under `/v1/3dtiles/`. Refuse a request that tries to choose a
   different upstream host.
3. Delete a client-supplied `key` parameter if one is present.
4. If the path is the root tileset (`/v1/3dtiles/root.json`), reserve one
   root request against the grant and its invite before calling Google.
   The store is the source of truth for that count. When the remaining count
   is already zero, return `402` and do not call Google.
5. Forward to `https://tile.googleapis.com` with the same path and the
   remaining query, and set `key` to the server's key. Stream the response
   back, including status and the caching headers.
6. A non-success from Google does not spend the reserved root request.
   Spend it when Google returns a successful root response.
7. Child tileset and mesh requests check that the grant is still valid and
   then forward. They do not change the root count.

Validate grants from an in-memory cache that is refreshed from the store at
least every minute, and always from the store on a root request. Revoking an
invite therefore stops further tile requests within a minute, including
meshes already inside a three-hour Google session.

Log the path, status, grant id, and byte count. Do not log the Google key,
the grant secret, the `Authorization` header, or a URL that still contains
`key`.

### Minting a grant

`POST /grants` accepts one of:

- `{ "audience": "tour", "invite": "<code>" }`
- `{ "audience": "fly", "invite": "<code>" }`
- `{ "audience": "tour", "idToken": "<Google ID token>" }`

It returns:

```json
{
  "grant": "<secret>",
  "expiresAt": "<ISO time>",
  "remainingRootRequests": 30,
  "rootUrl": "https://<proxy>/v1/3dtiles/root.json"
}
```

The secret is stored only as a hash. The response is the only time the
process shows it. `rootUrl` is the hosted tiles root for this proxy. The
client keeps the secret in `sessionStorage` for the tab, so a reload can
reuse the grant. A reload still spends a new root request.

`audience` must match the invite or the sign-in policy. A tour invite cannot
mint a fly grant.

### Store

One store the process can reopen after a restart. A single SQLite file is
enough for the pilot. Tables:

| Record | Fields that matter |
| --- | --- |
| Invite | id, label, audience (`tour` or `fly`), code hash, total root budget, roots spent, per-grant root budget, expiry, revoked |
| Grant | id, secret hash, invite id or account id, audience, roots spent, root budget, expiry, revoked |
| Account | email, hosted domain, roots spent, root budget, expiry, revoked |

An invite's total and a grant's own budget both apply. The request is
refused when either is exhausted. An account used through Google sign-in has
no invite row; its budget is the account row.

## Invites

The CLI on the proxy host creates and revokes invites. Creating an invite
prints the code once.

```
tiles-access invite create --audience tour --label "UMN pilot" \
  --total-roots 400 --per-grant-roots 40 --expires 2026-12-01
tiles-access invite revoke <id>
```

A class code is meant to be shared with the course. It is a bearer secret
with a cap, which is why it is acceptable to email and why it is not the
Google key. Losing it costs at most the invite's remaining roots, and
revocation stops new grants and, within a minute, grants already issued.

A friend invite is the same command with `--audience fly` and a smaller
budget.

The tour may accept the class code in `?invite=` so a single link is enough
for the course. The page sends it to `POST /grants`, then removes it from
the address bar the way `?key=` is removed today. After that the page holds
the grant, not the invite.

## Google sign-in

Sign in with Google is a second way to call `POST /grants`. The browser
obtains an ID token. The proxy verifies it against Google's published
certificates and checks `iss`, `aud` (this app's client id), `exp`,
`email_verified`, and `hd`. `hd` must be `umn.edu`. The button's hosted-domain
hint is not that check.

A matching account gets a grant bound to the email. The first sign-in creates
the account row with the tour's per-person root budget. Later sign-ins reuse
the row and its remaining count.

This gate is campus-only. The fly audience does not accept an ID token in
version one.

## Client contract

`createGoogleTilesRuntime` takes a credential in place of a bare `apiKey`:

```ts
type GoogleTilesCredential =
  | { kind: "device-key"; apiKey: string }
  | { kind: "hosted"; rootUrl: string; grant: string };
```

`device-key` keeps today's behavior: the fixed Google root URL,
`GoogleCloudAuthPlugin` with `apiToken` set to that key, `autoRefreshToken`,
and `useRecommendedSettings`. An empty key still fails before any request.

`hosted`:

- Builds the renderer with `rootUrl`.
- Does not register `GoogleCloudAuthPlugin`.
- Registers a FOSS Earth plugin that fetches with
  `Authorization: Bearer <grant>` and does not add `key`.
- Sets `errorTarget` to 20 when the plugin would have, and leaves the
  existing settings override able to replace it afterwards.
- Listens for `tile-visibility-change` and aggregates `asset.copyright` the
  way `GoogleAttributionsManager` does, so the logo and data line stay.

`fetchOptions.mode` stays `cors`. The hosted plugin does not send cookies.

A `401` or `402` from the proxy is a hosted-access failure, with a message
the host can show: the visit is no longer allowed to load 3D Tiles. It is
not reported as a bad Google key. `redactTileUrl` still applies to anything
that does contain a secret query parameter.

The grant is not a settings parameter. Nothing in the settings export, the
URL writer, or `map.source.googleKey` reads or writes it.

A saved device key and a hosted grant can both exist on one browser. The
device key is that person's own Google credential and is used as today when
they have chosen to supply one. The university and hosted-0SFS builds do not
prompt for it. When both are present, the device key wins, so local testing
with `?key=` does not silently spend the hosted budget.

## Campus tour

The tour build that students open has the proxy origin compiled in, and no
Google key. Before the globe asks for Google tiles, the page needs a grant:

1. If `sessionStorage` already has an unexpired grant for this origin, use it.
2. Else if `?invite=` is present, redeem it, strip it, and store the grant.
3. Else show a small gate: a class-code field, and later a "Sign in with
   your UMN Google account" button. Either one calls `POST /grants`.

Raster basemaps remain available when the person has no grant, so a failed
or exhausted grant does not blank the page. The Google basemap is the one
that waits for the grant.

The first student test ships step 2 and the class-code field. The Google
button is the next step on the same `POST /grants` call.

## Hosted 0SFS

The public build is unchanged: no proxy origin, `?key=` and Map → Source
still save a device key, raster basemaps still work with no key.

A hosted build is the same application with a proxy origin compiled in and
`--audience fly`. Its gate is the invite field only. There is no `umn.edu`
button on it. The device-key path still works when someone passes `?key=`,
and that path still talks to Google directly with their key.

## Operator setup

Before the first student visit:

1. Create a Cloud project key used only by the proxy. Restrict the API to
   Map Tiles API. Restrict the application to the proxy's egress IP.
2. On that key's quota, set the daily root-request limit to a number that
   is acceptable if it is fully used. For a class pilot, a few hundred a day
   is the right order of magnitude: each open or reload is one request, and
   the free monthly amount on the Photorealistic 3D Tiles SKU should be
   confirmed in the billing console before raising the cap.
3. Create a billing budget alert. Treat it as a notification. The quota in
   step 2 is what stops spend.
4. Create the class invite with a total root budget inside that daily cap,
   and a per-person budget large enough for a session of reloads.
5. Confirm the tour origin is on the proxy's allowlist, and that a request
   from any other origin is refused before Google is called.

The proxy's own bandwidth is a separate bill. Every mesh is streamed through
it. A campus walk is the expected pilot cost. A long 0SFS flight moves more
data; friend invites stay small until that cost is known.

## Phases

| Phase | Ships | Students or friends can |
| --- | --- | --- |
| 1 | Proxy, CLI invites, hosted credential, tour class-code gate | Open the tour with the class link and see 3D Tiles, without a Google key |
| 2 | `umn.edu` ID-token grant on the same proxy | Sign in with a university Google account instead of the class code |
| 3 | Hosted 0SFS build, fly invites | Try the simulator on your key, up to the invite's root budget |

Phase 1 is enough to tell the university that testing can start. Phases 2
and 3 do not change the forwarding rules or the client credential.

## Acceptance

Phase 1 is done when all of these hold:

- A page loaded with the class invite requests `tile.googleapis.com` only
  from the proxy's IP. The browser's tile requests go to the proxy origin
  and carry `Authorization`, not `key`.
- The Google key does not appear in the tour bundle, the page URL, the
  settings export, session storage, or a failure log.
- Spending the grant's root budget, or revoking the invite, stops a further
  root request. Revocation stops mesh requests within a minute.
- A child-tile request does not change the root count.
- A request outside `/v1/3dtiles/`, or from an origin that is not allowed,
  does not call Google.
- The device-key path still loads tiles when `?key=` is supplied, and that
  request still goes to Google with that person's key.
- The Google Maps logo and the copyright line are still shown.
- With no grant and no device key, the tour still opens on a raster basemap.
- Tests cover the proxy rules and the hosted fetch plugin with stand-in
  HTTP. They do not call Google.

## Out of scope

- Sharing one Google root session across several people.
- Storing or rehosting tile meshes.
- A web UI for creating invites.
- Letting a fly visitor sign in with Google.
- Putting a grant or a proxy origin into the public 0SFS build.
- Metering bytes, or capping a session by flight time. The metered unit is
  the root request.
- Changing CARTO, or changing how a device key is saved.
