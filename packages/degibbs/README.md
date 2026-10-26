# @neurodesk/degibbs

Gibbs-ringing removal by local subvoxel shifts (Kellner et al. 2016) for the `degibbs` web app and its command line.
The numerical code is the Rust crate [`exes/dwi/degibbs`](../../exes/dwi/degibbs), a port of MRtrix3 3.0.8 `mrdegibbs`, compiled to `src/degibbs.wasm`.
It is MPL-2.0, as the MRtrix source is.

## Use

```js
import { loadDegibbs, sliceAxes } from '@neurodesk/degibbs';

const { degibbs } = await loadDegibbs(fetch(new URL('@neurodesk/degibbs/wasm', import.meta.url)));
const fixed = degibbs(volume, [nx, ny, nz], 1, { axes: sliceAxes(sidecar.SliceEncodingDirection) });
```

The options and their defaults are those of `mrdegibbs`: `nshifts` 20, `minW` 1, `maxW` 3, and in-plane axes `[0, 1]` unless the sidecar's `SliceEncodingDirection` names another slice axis.

## Parity

The web app's example is the OpenNeuro ds005577 sub-107 AP slab (120 × 120 × 8 × 101, full Fourier; Hugging Face `neurodeskorg/webapps` commit `d950cc4c`, `degibbs/examples/`). On it the port equals MRtrix 3.0.8 `mrdegibbs` (`degibbs/validation/`) to NRMSE 5.3e-20: 2 of 11 635 200 voxels differ, by at most 1.6e-14, both in the background. `mrdegibbs` changes the input by 6.4 % (NRMSE). `exes/dwi/degibbs/tests/oracle.rs` holds the port to NRMSE < 1e-15 and a maximum difference < 1e-10; the `oracle` job of `dwi-native.yml` runs it on the pinned files with `DWI_REQUIRE_ORACLE=1`, so missing data fails the job. Locally, `python3 exes/dwi/validation/fetch_oracle.py DEST` prints `DEGIBBS_ORACLE`; without it the test is skipped.

## Build

The module is committed. After a change to `exes/dwi/degibbs` or `exes/dwi/degibbs-wasm`, run `pnpm --filter @neurodesk/degibbs build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).

## Command line

`bin/degibbs.js` runs the web app's workflow on a NIfTI image with the committed module, and writes the app's downloads:

```bash
degibbs sub-01_dwi.nii.gz results
degibbs sub-01_dwi.nii.gz results --axes 0,2 --nshifts 20 --min-w 1 --max-w 3
degibbs self-check
```

The `.bval`, `.bvec` and `.json` beside the image with the same name are passed through under the output's name, as the app pairs a dropped selection; `--bval`, `--bvec` and `--json` name other files.
The sidecar's `SliceEncodingDirection` sets the in-plane axes unless `--axes` is given.
The output directory must be new or empty.
Volumes are corrected one at a time, one module call each, as the app's workers do; the output names and sidecar come from `src/outputs.js`, which the app imports too.
Input is NIfTI only: convert DICOM with dcm2niix first, or use the web app.
`self-check` runs the module on a phantom: a flat image must come back unchanged and a square's edges must change.

The portable archives are built by `exes/node-cli` (`release.json`) in `.github/workflows/degibbs-native.yml`.

### Accuracy

`validation/cli-check.mjs` is the release gate. It runs the command line on the pinned example in `apps/degibbs/examples.json`. The corrected image's decompressed bytes must equal the web app's download, and the `.bval`, `.bvec` and sidecar must equal it byte for byte.
The image is compared decompressed because Chromium and Node compress with different zlib builds; on Linux the compressed bytes are identical too.
`validation/browser-reference.json` holds the downloads, which `apps/degibbs/e2e/reference.spec.js` recorded through the built app's `degibbs` automation in Chromium.

```bash
node packages/degibbs/validation/cli-check.mjs
node packages/degibbs/validation/cli-check.mjs --executable path/to/degibbs
DEGIBBS_BROWSER_REFERENCE=write pnpm --filter degibbs exec playwright test e2e/reference.spec.js
```

Rerecord the reference after a change to the module, `src/outputs.js` or the app's NIfTI writing.
Cite Kellner et al. (2016) and MRtrix3 (Tournier et al. 2019), as the app's Cite dialog does.
