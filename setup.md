# Independent checkout and release preparation

`foss-earth/research` is an independent repository. It needs no application source,
archive checkout, or sibling `node_modules` directory. A clone lives at
`<workspace>/foss-earth/research`; the organization directory groups checkouts and
is not a Git repository. The globe application lives separately at
`<workspace>/foss-earth/foss-earth.github.io`; Flight at
`<workspace>/0sfs/simulator`; Campus at `<workspace>/UMN-VR/tour`.

The [developer installer](https://github.com/foss-earth/dev_installer) owns setup
orchestration. Applications own their manifests; Docs and Research do not create
an alternative installer. Its public `foss-earth-workspace` contract supports
source, exact-package and hybrid selections, with one actual provider checkout
and public package exports. The source/hybrid increment still needs its own
checked release. Use only an accepted installer descriptor and exact source or
archive pins; a package name/version by itself does not identify release bytes.
Keep developer-link output qualification separate from immutable archive proof.

## This owner

Research owns runnable optional experiments under `scripts/`, original sources,
hypotheses and retained evidence. It supplies no globe application runtime.
Historical drivers that require an unpublished Flight adapter, a private baseline
algorithm or source photographs report those missing prerequisites explicitly.
No old application checkout is used as their fallback dependency.

After a granted slot, install the exact reviewed common CI and public owner
archives required by this checkout. Then prepare a flat immutable consumer
closure JSON for `RESEARCH_CONSUMER_ARCHIVES`: `version: 1`, with `packages` rows
containing `name`, `version`, `archive`, `sha256` and `bytes`. Include the resealed
Research archive, TypeScript 5.9.3, Node declarations 24.12.4 and their complete
transitive closure. Paths are relative to the JSON, not to a monolith checkout.

```sh
npm run check:source
npm run check:public-ports
npm run check:conformance
RESEARCH_CONSUMER_ARCHIVES=build/reviewed-consumer-closure.json npm run test:consumer
npm run check:attribution
```

The public-port check compiles declared injected contracts without constructing a
device, scene or frame loop. The consumer fixture installs reviewed archives
offline with scripts disabled and tests public helper import/declaration and
owner-local output behavior; it starts no browser, server, experiment or native
build. `check:attribution` requires the primary-prepared complete intended heads
and tags at `build/repository-split/intended-publication-refs.json`.

Optional experiment entrypoints under `scripts/benchmarks/` are excluded from
these commands. Browser/GPU, timing, benchmark, network/provider, native and media
runs need their separate explicit task, prerequisite receipts and check-slot
scope. Old timings retain the machine, algorithm and conditions that produced
them. Adapting imports does not update those measurements.

## Release evidence and recovery

Current source preparation ran none of the commands above. Preserve every prior
log, archive and receipt with its original paths and byte seals. Relocation did
not make those receipts current-layout checks. The primary must bind the next
source commit, full packaged file map, export or document URLs, exact shared
policy/caller, installed-consumer result and remaining rights limitations before
release. The coordinator separately verifies remote admission and publication.

The original app archives are read-only recovery inputs. Restore a reviewed
source input from its recorded original revision/blob if necessary; do not reset
or clean an archive, overwrite dirty source, or discard ignored evidence.

- [Migration state](migration.md)
- [Contributing](CONTRIBUTING.md)
- [Public owner navigation](navigation.md)
