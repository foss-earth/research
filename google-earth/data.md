# What Earth streams, and what we stream

Part of [Google Earth runtime](README.md). Labels are defined there.

The client chapter has the serving model Mears stated in 2019: a precomputed pyramid, altitude mapped to a level, protocol-buffer metadata, and imagery bytes in a native compression he would not assert. This chapter keeps two concrete formats apart. One is a third-party reading of the Earth client's 3D mode. The other is the Map Tiles API payload our renderer actually parses.

## The 3D mode read from the outside

[R] The [earth-reverse-engineering](https://github.com/retroplasma/earth-reverse-engineering) README, as it stood when read on 4 November 2026, says its focus is the 3D satellite mode. In that reading:

- the geometry lives in an octree;
- a planetoid record points at the first bulk-metadata record;
- bulk metadata points at further bulk metadata and at node data, and carries an oriented bounding box per node;
- node data holds the meshes and the textures;
- bulk metadata and node data are versioned by an epoch, and the current epoch is found by walking those records;
- a mesh is packed positions, UVs, an octant mask, and normals;
- a texture is JPEG or CRN-DXT1;
- a bounding-volume hierarchy is listed among "other optimizations."

The README does not date the responses it was written from. This organization has not fetched those resources again. The request templates and the vertex unpacking live in that repository. They are omitted here on purpose: this note is about cost, and a second client for that endpoint is out of scope.

[I] An octree of meshes with oriented boxes can sit beside the quadtree Mears described. He was talking about the pyramid of imagery, 3D, and map data as the thing the camera's altitude indexes. The README is talking about the mesh nodes of one mode. Both sentences can be true. Merging them into "Earth's tiles are an octree of DXT meshes" drops his uncertainty and the README's scope.

[I] DXT1 is 8 bytes for each 4×4 block, half a byte per pixel, against 4 bytes per pixel for RGBA8. Crunch stores that DXT payload in a smaller file; the GPU sample, where the API exposes BC1, is the DXT block after the Crunch package is expanded. A JPEG has to be expanded to a full bitmap before a GPU that has no JPEG texture format can sample it. The memory ratio applies to a tile that arrives as CRN-DXT1 and is uploaded as BC1. The README is the witness that some node, in the mode they studied, was that kind of tile. Mears is the witness that phone, web, and desktop encodings were allowed to differ, and that he was unsure of the name.

## Photorealistic 3D Tiles, sampled

[O] On 16 October 2026 the WebAssembly plan's step 7 recorded a survey of live tiles from `tile.googleapis.com`. The write-up is [step 7](https://github.com/foss-earth/docs/blob/main/docs/proposals/webassembly.md#7-google-tiles-off-the-main-thread). In that survey:

- every content tile is a glb, and it requires `KHR_materials_unlit`;
- there is no Draco, and there are no normals;
- `POSITION` and `TEXCOORD_0` are float32;
- indices are uint16, or uint8 on a tiny tile;
- a tile has one or two primitives, each with a JPEG, and one node with a matrix;
- the sampler clamps;
- the response is gzipped, with `Cache-Control: private, max-age=14400`;
- `Access-Control-Allow-Origin` echoes the page's origin, and there is no `Cross-Origin-Resource-Policy` header.

[I] "Google decodes Draco on its side" means the files in that survey contain expanded float32, so a Draco worker on our side has nothing to do. The survey does not identify the tool that produced the file. A packed int16 vertex, which our T7 contemplates, would be a change we make to those float32 arrays after download.

[I] Each JPEG becomes an uncompressed texture unless our renderer compresses it after decode. Backlog B3 is that later compression, aimed at BC or ASTC, and its "four to eight times" is an estimate of RGBA against those GPU formats. It is an estimate about our upload of this glTF. It becomes a statement about Earth only for a tile that Earth's client uploads as a block format. The surveyed tiles are the glTF.

[O] The same tileset, drawn by 3d-tiles-renderer, has overlapping octree boxes. The [performance audit](https://github.com/foss-earth/docs/blob/main/docs/performance-audit.md) of 20 October 2026 records one depth-3 tile with a geometric error of 263 km, centred in the Yukon, whose box still contains a camera at Minneapolis. Its mesh sits 6.5 to 6.8 km above the campus. The ground sample hit that mesh first, the eye contact pushed the camera up, and a higher eye selected coarser tiles. Before the fix the eye rose from 276 m to 435 m across 14 pushes. Engine `5d1b132` is the fix on our side: the sample yields to a finer tile inside the coarser error, and a coarse stand-in whose error exceeds both its distance and 16 times the eye height is hidden.

[I] Overlapping ancestor boxes are a property of this tileset as that renderer walks it. They explain a wrong stand-in in our scene. They say nothing about which box the Earth client would have drawn, because the Earth client is not the program that produced this trace.

[U] Whether `earth.google.com` ever requests `tile.googleapis.com`. No source gathered here shows the web client's tile host.

## Billing is a constraint on our tiles, and a separate subject

[O] How a root request, a session, and a daily quota are billed is [How Google bills Photorealistic 3D Tiles](../3D_tiles/google-side-billing.md), researched 3 November 2026. A renderer that refetches `root.json` can open another billable root. The Map Tiles policies, as quoted there, forbid prefetching and caching beyond the narrow cases in the terms.

[I] Those rules bound how aggressively our client may pipeline this API. They do not describe the Earth client's cache. Mears's 2019 account of aggressive issue and cancel is about the Earth client's own protocol, on ordinary HTTP, against a store he believed was precomputed on disk.

## Timelapse, as a second tileset inside the same renderer

[G] Anderson's content slides, for completeness of what that renderer has been shown to draw: Voyager shipped with Earth web in 2017. In 2018, Earth Engine could export tiles directly into Earth. Timelapse, launched in Voyager in 2021, is a global video tileset whose frames are years of Landsat, almost forty years of them. From 2018 to 2021 the 3D renderer was extended to play tiled geospatial video in step with the camera and with time, with animated clouds and polar ice given as examples.

[I] The renderer can treat time as another axis of a tiled video and keep it aligned with the camera. That is a content feature with a streaming cost. The slides give no byte size, no frame budget, and no claim that this path is why a still city is fast.
