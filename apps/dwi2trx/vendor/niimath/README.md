# Shared dtifit runtime

Version `1.2.0-dtifit.1` builds niimath commit
[`cc26582a250c411b5c3c3c05c91dfd58f66be089`](https://github.com/rordenlab/niimath/commit/cc26582a250c411b5c3c3c05c91dfd58f66be089)
with Emscripten `6.0.13`. That upstream commit repairs the symmetric tensor
eigensolver: a repeated minor eigenvalue must not corrupt the unique principal
direction. No JavaScript tensor fit or eigensolver replaces it.

The build contains the float32 image calculator (including crop), gzip I/O,
tensor decomposition and dtifit. It omits mesh, bitmap, registration, QC,
N4, conform, motion, phase and GPL features. It exports the raw module factory,
filesystem operations, `callMain`, `_malloc` and `_free` used by both runners.
Its `package.json` is exported as `./package.json`, as upstream does from
rordenlab/niimath#82, so `@neurodesk/dwi2trx/niimath-version` can read the version.
Its memory limit remains 2 GiB. `dist/provenance.json` records all source files,
compiler flags and generated hashes; `dist/LICENSE` and `dist/NOTICE` retain
the niimath, connected-component, zlib and Emscripten notices.

To rebuild, check out the pinned niimath commit above and emsdk commit
`35659964bc2762fffec0d257997fb61475f765b7` (tag `6.0.13`), then install and
activate SDK `6.0.13` inside that checkout:

```sh
"$SDK/emsdk" install 6.0.13
"$SDK/emsdk" activate 6.0.13 --embedded
node apps/dwi2trx/scripts/rebuild-niimath.mjs \
  --source "$NIIMATH_SOURCE" --emsdk "$SDK" --output "$BUILD_OUTPUT"
```

The script checks both checkout revisions and tracked-source cleanliness.
Build output stays in the supplied directory until copied into `dist/`.
It applies upstream's two glue transformations for `callMain` arguments and
classic ArrayBuffer views. Two builds from separate temporary directories
produced identical JS and WASM hashes with this toolchain.

The preceding `1.2.0-dtifit.0` binary first appeared in webapps commit
`f7d59ae6a04000f65914d5c197223433ab1525ae`. Its source revision and compiler
were not recorded; this rebuild does not claim to reproduce that baseline.
