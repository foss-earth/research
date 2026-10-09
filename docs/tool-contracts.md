# Optional experiment tools

Current source and declarations are UNRUN. These entries are developer/experiment dependencies, never Earth application runtime dependencies. Actual archive/export/declaration/shared-attribution qualification is pending. Importing a helper starts no browser, server, capture, benchmark or native build.

`@foss-earth/research/headless-chrome` exposes the retained `openHeadlessChrome`, `connectHeadlessChrome`, `evaluate` and `waitForExpression` pipe-control helpers. Callers provide an owner-local profile directory; an optional existing binary path, arguments and child/timer/access ports preserve the existing API. A supplied child requires the actual stderr and pipe descriptors the helper uses. Commands return unvalidated protocol data, typed unknown. Close awaits natural process exit and sends no signal; a nonexiting foreign process is not falsely reported as cleaned up.

`@foss-earth/research/output-directory` exposes `newOutputDirectory` for this Research owner's scripts. It writes only this owner's dated build tree and retains prior outputs. Consumers such as Sky own their output-directory adaptation and do not use it to write inside an installed dependency.

A caller must use an exact accepted installed archive/module digest rather than an old/private source path. No such final artifact is accepted yet. Browser/GPU/benchmark execution needs its separate task and shared-slot scope; helper publication is not authorization to execute an experiment. Existing per-file notices, hypotheses, inputs and unqualified evidence are retained.

`npm run test:consumer` requires `RESEARCH_CONSUMER_ARCHIVES`, a JSON file with
`version: 1` and a complete flat `packages` array. Each record supplies `name`,
`version`, `archive` (relative to that JSON), `sha256` and `bytes`. It must contain
Research 0.1.0, TypeScript 5.9.3, Node declarations 24.12.4 and their actual
transitive closure. The harness validates byte pins, installs only those archives
offline with scripts disabled in a fresh retained owner-local workspace, and
rejects undeclared/nested/bundled packages and escaped runtime/declaration paths.
It prepares outside-runtime, outside-declaration and synthetic feature-path
negative controls. Helper imports run with process/output creation blocked; no
browser helper is invoked. Strict declarations and every advertised export file
are checked there. This harness and its new CI wiring remain UNRUN.

Archive identity is bound to each requested physical package name, including scoped names. Equal-version archives with swapped names cannot satisfy the prepared installed-consumer receipt. This source assertion remains UNRUN.

The prepared import fixture blocks process launch and filesystem mutation APIs, including synchronous and promise variants, with causal poison controls. The declaration-only functions exercise the actual positional helper APIs without invocation. Output creation walks and verifies every existing path component before creating children, refusing ordinary build/subpath symlink redirects while retaining dated collision suffixes. Concurrent external filesystem replacement is not qualified by these source fixtures. All cases remain UNRUN.

The qualifying consumer installs retained copies of the exact bytes just hashed, and verifies each copied archive manifest before installation. It does not install from a mutable original archive path or accept dependency source aliases. This source guard remains UNRUN.
