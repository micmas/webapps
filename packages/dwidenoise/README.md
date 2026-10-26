# @neurodesk/dwidenoise

Patch2Self denoising of diffusion MRI (Fadnavis et al. 2020) for the `dwidenoise` web app and its command line.
The numerical code is the Rust crate [`exes/dwi/denoise`](../../exes/dwi/denoise), a port of DIPY 1.12.1 `patch2self` version 1 (patch radius 0, `model="ols"`), compiled to `src/dwidenoise.wasm`.
The port does not copy DIPY 1.12.1's `copy_X=False` defect in version 1 ([dipy/dipy#3967](https://github.com/dipy/dipy/issues/3967), fixed by [dipy/dipy#3976](https://github.com/dipy/dipy/pull/3976) and not yet released); see the crate's README.
It is BSD-3-Clause, as the DIPY source is.
The crate's README gives the method, the choices and why version 1 is used.

## Use

```js
import { loadDwidenoise } from '@neurodesk/dwidenoise';

const p2s = await loadDwidenoise(fetch(new URL('@neurodesk/dwidenoise/wasm', import.meta.url)));
const buffer = p2s.allocate(nvox * bvals.length);
buffer.view().set(volumes); // or decode the NIfTI straight into buffer.view()
p2s.denoise(buffer, nvox, bvals, { onProgress: (done, total) => {} });
const denoised = buffer.view();
buffer.free();
```

Data is volume-major Float32, as in NIfTI.
`allocate` puts it in the module's memory, and `denoise` works there in place, so the page holds one copy.
Call `view()` again after other calls: when the module's memory grows, earlier views detach.
`denoiseArray(data, nvox, bvals)` returns a denoised copy instead.

For workers, `accumulate(buffer, nvox, group, gram, first, count)` adds a voxel range to a group's Float64 Gram matrix, and the Gram matrices of separate ranges add element by element.
`solve(gram, group)` makes the coefficients, and `apply(buffer, nvox, group, coefficients, first, count)` replaces a range with its predictions.
`solveVolume(gram, group, j)` makes row `j` of `solve` (the same values, bit for bit): one Cholesky solve, so a worker can solve one volume per message and the page can stop or report progress between volumes.
`denoiseChunks(data, nvox, bvals, { chunk })` is the web app's worker schedule in one thread: chunks of `CHUNK_VOXELS` voxels, partial Gram sums added in chunk order, one `solveVolume` per volume, then the predictions of each chunk.
The app's output equals it bit for bit.
`fittedGroups(bvals)` gives the groups to fit: the b0 volumes (b < 50 s/mm², `B0_THRESHOLD` from the module) when there are two or more, and the diffusion-weighted volumes.

## Workers

`@neurodesk/dwidenoise/pool` (`denoiseSeries`) spreads a series over workers in three passes: the Gram sums of each 16384-voxel chunk (`CHUNK_VOXELS`), one `solveVolume` per volume, then the predictions of each chunk.
It adds the partial Gram sums in chunk order, so the result is the same for any number of workers, and it equals `denoiseChunks` bit for bit.
A cancel stops a run between two messages, also between two volume solves.
It writes the predictions into the `output` array it is given (for example the voxels of `allocateNifti` from `@neurodesk/webapp-components/file-io`) and returns their largest finite value, found by the workers, for `cal_max`.
`@neurodesk/dwidenoise/worker` holds the worker's message handler (`denoiseWorkerHandler`, and `createWorkerTasks` on a loaded module).
The web app runs it in Web Workers, the command line in worker threads.
`@neurodesk/dwidenoise/gzip` (`gzipInWorker`, `gzipWorkerHandler`) compresses the output in a worker that loads no WebAssembly; the web app uses it, and the command line uses Node's zlib.
`@neurodesk/dwidenoise/pipeline` holds the chunk helpers and the BIDS output names (from the DWI apps' shared `bids-derivatives` module) that both use.
Both read the .bval with `parseBval` from `@neurodesk/webapp-components/file-io/gradients`.

## Command line

```bash
dwidenoise sub-01_dwi.nii.gz results
```

The command line writes the web app's four downloads:

- `<name>_desc-denoised_<suffix>.nii.gz`: the denoised image.
- `.bval` and `.bvec`: the gradient files, unchanged.
- `.json`: the sidecar, with the step's `Description`.

It reads the `.bval` (required), `.bvec` and `.json` with the image's stem (FSL `.bvals` and `.bvecs` too).
When the image is the only image in its directory, a sole gradient file there pairs whatever its name (FSL `data.nii.gz` with `bvals` and `bvecs`), as the web app pairs a one-image selection.
`--bval`, `--bvec` and `--json` name other files.
`--threads N` sets the worker threads (default: one per core). The output is the same for any number.
The output directory must be new or empty.
The command prints the directory to standard output, and progress and the run's settings (JSON) to standard error.
`dwidenoise self-check` denoises a phantom on one and on three threads and requires the same bits.
Input is NIfTI only: convert DICOM with dcm2niix first.

Its release check, `validation/cli-check.mjs`, runs each pinned example of the web app (`apps/dwidenoise/examples.json`) and compares each output with `validation/browser-reference.json`.
It compares the image by its decompressed bytes, and the other files byte for byte.
It also runs the first example on one thread.
`apps/dwidenoise/e2e/reference.spec.js` records the reference from the built app's `denoise` automation (`DWIDENOISE_BROWSER_REFERENCE=write`) and checks it (`check`).
Record it again when the module, the pool or the examples change.
Chromium and Node use different zlib builds, so the compressed bytes can differ.

Cite Fadnavis S, Batson J, Garyfallidis E. Patch2Self: Denoising Diffusion MRI with Self-Supervised Learning. NeurIPS 2020, and DIPY (Garyfallidis et al. 2014, Front Neuroinform 8:8).

## Parity

The WASM output of the ds005134 slab (67 × 92 × 10 × 137) equals the stage 1 DIPY reference (`dwidenoise/validation` in the dataset, float32) bit for bit.
`scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz` repeats the check and times the two passes.
`--app OUTPUT.nii.gz ...` also runs `denoiseChunks` and fails unless each downloaded app output has the same float32 bits.
On the slab, the outputs of the app before and after the worker solve (#428) both pass, and `denoiseChunks` also equals the DIPY reference bit for bit.
In Node 22 on the development host, the Gram pass did about 0.5 million voxels per second and the apply pass about 0.24 million voxels per second (both groups, 137 volumes).

## Memory and responsiveness of the app

The app (#428) solves each volume in a worker, writes the workers' results straight into the output NIfTI (`allocateNifti` from `@neurodesk/webapp-components/file-io`), finds `cal_max` in the workers, and compresses the output in a worker (without the WebAssembly) that receives the buffer without a copy.
Before, the page solved each group on its own thread, held the result and a second copy for the NIfTI writer, wrote 127 M values one at a time, and compressed through a `Blob` copy on its own thread.

Measured on the full-brain ds005134 sub-01 DWI (`sub-01_dir-AP_run-001_dwi`, 116 × 116 × 69 × 137, int16, 81 MB gzipped, 509 MB as Float32), from the Denoise click to "Denoised", in Playwright's headless Chromium (1.64) on the 8-core Linux development host, two runs of each build, alternating:

| | Before | After |
| --- | --- | --- |
| Peak RSS of the page's renderer process (workers included) | 3076, 3011 MB | 2550, 2665 MB |
| Peak sum of RSS of all browser processes (sampled every 25 ms) | 3794, 3786 MB | 3257, 3253 MB |
| Longest main-thread task | 15326, 14713 ms | 413, 258 ms |
| Time | 37.5, 31.6 s | 50.6, 29.7 s |

`apps/dwidenoise/validation/measure-run.mjs DIST OUTDIR IMAGE.nii.gz IMAGE.bval IMAGE.bvec IMAGE.json` makes the measurement on a production build (`DIST`) of each commit.
Each browser is started with Playwright's `launchServer`; the renderer peak is `VmHWM` in `/proc/<pid>/status`, read after the run, with `clear_refs` reset to 5 when the image was loaded, and the sum is the largest total of `VmRSS` over the browser's processes, sampled every 25 ms.
Other jobs ran on the host (load average 8 to 12), so the times and task lengths change much from run to run; an earlier pair of runs on a quieter host gave 19.5 s and 9.0 s before, 17.6 s and 0.17 s after.
The output NIfTI was the same in all runs (sha256 `2127198e4f66a1c6eff7342a35a2214aa668dde6d97cd7cd6676e0615e98ddbd`).
The peak now comes when the viewer reads the denoised image, while the page still holds the input (509 MB) for another run.
Before, most of the longest task was gzip on the page's thread.

## Build

The module is committed. After a change to `exes/dwi/denoise` or `exes/dwi/denoise-wasm`, run `pnpm --filter @neurodesk/dwidenoise build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).
