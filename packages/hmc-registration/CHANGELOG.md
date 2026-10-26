# @neurodesk/hmc-registration

## 0.3.0

### Minor Changes

- 3226bb7: Add the full native antsApplyTransforms CLI and the pinned ImageMath Laplacian operation for SDC, with independent native parity for HDF5/MultiLabel/BSpline, transform ordering and restricted SyN. Keep the legacy HMC apply interface and the unresolved full-volume SDC accuracy gates unchanged. DenoiseImage remains a separate package.

## 0.2.1

### Patch Changes

- e2476e7: One kernel instance now serves many runs (200 in the tests): it no longer aborts on run 27 of NiFreeze's command lines (run 91 of the test pair). Emscripten's `callMain` left each run's argv on the 64 KiB stack; `run` now restores the stack pointer after each run (the rebuilt kernel exports `stackSave` and `stackRestore`) and gives `callMain` a copy of argv, which it changed. `main()` also registers ITK's IO factories once. The transforms are byte for byte the same, and the NiFreeze replay uses one instance for all 101 registrations.

## 0.2.0

### Minor Changes

- ed57be4: Add ANTs `AverageImages` and `AverageAffineTransform`, and an antsApplyTransforms-style `--apply` with Linear, NearestNeighbor, BSpline, HammingWindowedSinc and LanczosWindowedSinc interpolation. `argv[0]` selects the program in `run(argv)` and in the worker. Each program writes the same bytes as native ANTs 52bc0ab on the test set. The `antsRegistration` output does not change.

  Apply multiple transforms in ANTs command-line order, with the last transform acting first. Test noncommuting transforms and inverse composition.

## 0.1.1

### Patch Changes

- Reject absolute output paths and parent-directory traversal before running ANTs so every output stays inside its private run directory. A rejected run leaves the same kernel usable for the next registration.

## 0.1.0

### Minor Changes

- 7ed7289: Add `@neurodesk/hmc-registration`: ANTs `antsRegistration` (3D float only) in WebAssembly at ANTs 52bc0ab and the ITK-Wasm toolchain of `packages/registration`, with a generic `run(argv)` over a virtual file system, a SHA-256-checked Node entry and a module worker entry. `run` refuses argv without `--float 1` or an explicit `--random-seed`. The kernel uses one ITK thread and starts at 256 MiB. On the committed synthetic pair it recovers the known rigid shift and writes the same `.mat` as native `antsRegistration`, byte for byte, in Node and in a Chromium worker. `packages/registration` is unchanged.

### Patch Changes

- c288817: Reject malformed MATLAB transform headers before reading names or values, so invalid lengths and dimensions cannot stall the public reader. Preserve float and double transforms, including empty fixed-parameter matrices.
