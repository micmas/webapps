# HMC browser and command-line integration

The browser workspace and `hmc` command line run the shared `correctNiFreeze`
pipeline, with GP as the default and a b0-template option. Registration uses one
worker by default. The worker-count benchmark remains a separate gate; these
workflow runs do not establish performance, memory limits or through-plane
accuracy on a full acquisition.

## Completed checks

The production Chromium build completed both methods on the immutable ds005134
example: 67×92×10 voxels, all 137 volumes, automatic MindGrab CPU masking. Each run
downloaded the corrected float32 NIfTI, b-values, rotated b-vectors, motion TSV,
sidecar and a ZIP containing all 137 ITK transforms. The corrected images were
finite and retained every frame. The input pins and output hashes are in
`packages/hmc/validation/browser-reference.json`. Image hashes cover decompressed
NIfTI bytes; transform hashes cover each extracted file rather than ZIP metadata.

The sidecar records the effective estimator mask after GP eligibility reduction:
SHA-256, byte count and included-voxel count. It also identifies a supplied mask
or the default MindGrab model, version and actual backend. It contains no local
input paths. The dedicated mask worker terminates before registration starts;
the earlier masking peak and the viewer remain outside the supplied-mask pipeline benchmark.

On a separate synthetic 32³, ten-frame series, both command-line modes wrote
every file byte for byte as an independent invocation of the low-level Node
pipeline. Both production-browser modes also matched that Node invocation:
decompressed image, gradients, motion, sidecar and every transform.

Browser recovery coverage checks a failed pinned-example download followed by a
successful retry, supplied-mask selection, cancellation while registration is
queued, and a successful retry using the retained input and supplied mask. The
downloaded sidecar confirms that the supplied mask was used. Clearing it returns
to automatic masking. This caught and fixed an integration defect: shared
`createFileField` consumers must use `onFiles`, because the component consumes
and clears its native input's file list.

A malformed BIDS run selection also retains the previous successful run, its mask, completed outputs and downloaded provenance. A production regression caught and fixed the selector changing even when the new load failed.

The fresh production reference/parity run passed five tests. The final recovery,
mask-clear and retry run passed two tests. The shared source, catalog, version,
workflow-trigger and immutable-pin checks passed 96 tests. These are correctness
results; wall times observed during concurrent work are not benchmark evidence.

## Slab axes and software equality

The pinned ds005134 sub-01 example has 137 frames: 13 b0 frames are retained and
124 DWI frames are registered. Its 67×92×10 grid has 2 mm spacing. The compressed
image SHA-256 is
`1e7c8461d9bfc3c80633f930dc1df16d892a6bfd5e15db4c5a2be9d021e48d00`,
at Hugging Face commit `ce028ecca10e9abe7988f965e03ad51627ca9c52`.
Header parsing of those checksummed bytes gives the voxel-to-RAS affine used by
`readSeries`:

```text
[-2  0  0    66               ]
[ 0  2  0  -104.377685546875  ]
[ 0  0  2    11.728813171386719]
[ 0  0  0     1               ]
```

This saved slab is axis-aligned in that affine. Its unit voxel-axis columns are
(−1,0,0), (0,1,0), (0,0,1). The normalized cross product of the first two,
oriented toward increasing voxel k, is n=(0,0,1). Thus RAS x/right and y/anterior
translations lie in-plane; RAS z/superior translation is through-plane. An oblique
slab requires deriving its own normal from its affine, rather than assuming these
anatomical axes.

Both browser methods and their Node/portable paths match every transform and
motion-table byte. The recorded motion TSV hashes are:

| Method | SHA-256 |
| --- | --- |
| Trivial | `39434347bec5bc74cc7ea5d34945a2385f6fa78750a7c70f96772d6f44cd7c30` |
| GP | `dba7b514260b03b8aa1624f3377fb08838f8665e606ba749416934d1cb6ab8ec` |

That equality implies the following maximum absolute **Node/browser differences**;
these are not motion magnitudes or errors relative to ground truth.

| Method | In-plane R/x translation, mm | In-plane A/y translation, mm | Through-plane S/z translation, mm | R/x rotation vector, rad | A/y rotation vector, rad | S/z rotation vector, rad |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Trivial | 0 | 0 | 0 | 0 | 0 | 0 |
| GP | 0 | 0 | 0 | 0 | 0 | 0 |

The TSV rotations are RAS rotation vectors, not Euler angles
(`exes/dwi/hmc/src/motion.rs`). Components about the in-plane R/A axes contribute
to out-of-plane tilt; the normal-axis component describes in-plane spin. For a
finite rotation matrix R, exact slice tilt is `acos(clamp(n·R n,−1,1))`.
Translation projects as `d_through=n·d` and `d_in=d−n(n·d)`.
Equal transforms and equal affine therefore also imply equal projected quantities.

The TSV translations use QSIPrep's pivot `A[:3,:3]c`, where `c=(shape−1)/2`,
rather than the world grid centre `Ac`. Physical centre displacement would require
computing `M(Ac)−Ac` with the correctly converted RAS transform before projection.
The temporary slab downloads were removed after verification, so no uncomputed
motion-magnitude distribution or tilt magnitude is inferred from their hashes.

This ten-slice example has no motion ground truth. Identical software outputs do
not establish through-plane estimation accuracy, and the separate full-volume
native-float acceptance gate is not a slab per-axis accuracy test.

## Reproduce

```bash
pnpm --filter hmc build
pnpm --filter hmc test:e2e
node --test packages/hmc/test/node-files.test.js packages/hmc/test/nifreeze.test.js
node packages/hmc/validation/cli-check.mjs
```

The example browser tests obtain checksummed bytes from the offline asset lock
and route those exact bytes to the example URLs. Playwright blocks service
workers so the COI fallback worker does not bypass its routes; the production
preview supplies the actual COOP/COEP headers. CPU masking and registration run
normally. No simulated scientific output is used.

`HMC_BROWSER_REFERENCE=write` intentionally rerecords the browser reference.
Preserve exported screenshots outside Playwright's default results directory
when running additional tests, since a later invocation clears that directory.

## Portable verification

`packages/hmc/release.json` declares Linux x64, Windows x64 and macOS arm64
packages. `hmc-native.yml` verifies the production browser reference before the
shared portable workflow builds its target matrix. The command's self-check
executes the pinned registration resampler and verifies an identity phantom.

The lifecycle-fixed `0.4.20261024` archives passed the completed
[portable run 40110827691](https://github.com/neurodesk/webapps/actions/runs/40110827691)
at `c8074fbd863b6deb4e3d7a119cb8d6ec9d218a7f`. Its production-browser reference
job and the extracted-archive verification steps passed on Linux x64, Windows x64
and macOS arm64. These steps run the archive's self-check and compare both GP and
trivial derivatives with the recorded browser reference. The release job was
skipped: this is archive validation evidence, not evidence of published downloads.
No final archive checksum is asserted here; the earlier local Linux checksum
referred to the kernel before the lifecycle fix.

The later production HMC suite passed all 11 tests, including both pinned GP and
trivial references, independent low-level Node comparisons, import synchronization,
cancellation/retry, supplied-mask handling and BIDS rollback. Desktop and phone
screenshots were reviewed under `$TMPDIR/review-integrated-hmc-interface` and
`$TMPDIR/review-integrated-hmc-e2e`: completed output controls remain accessible,
and the corrected slab is visible in the viewer.

The final catalog interface audits and
whole-app automatic-mask memory observations are reported separately. The
supplied-mask pipeline benchmark excludes automatic masking and the viewer, so it
cannot establish a whole-app input-size limit.

## Repeated full-volume lifecycle

The first whole-app observations completed and verified the full ds005577
acquisition with one and two registration workers. Automatic CPU masking produced
the same effective mask as the pinned reference (161,668 eligible voxels), and
all scientific outputs matched the accepted full-GP result. These pre-fix fresh
observations are retained in validation storage; they do not establish rerun safety.

The four-worker direct rerun exposed a trap before its first registration. Dropping
the model left small owned text/transform result buffers inside the freed arena;
the next full-series split could not obtain a contiguous allocation under the
unchanged 1 GiB core heap limit. Releasing those scratch buffers at model teardown
allows the arena to be reused. JavaScript has already copied their results.

A test reduces only the module's declared maximum to 32 MiB and runs the unchanged
model code on a proportionally smaller synthetic series. It reproduced the
second-run trap before the fix and now completes three model/prediction/output
cycles with the original first-prediction hash. The actual production 1 GiB module
also completed three consecutive full-size initialization, prediction and result
serialization cycles. Its rebuilt SHA-256 is
`9ab321e70b7533264e80b5a5fbd4343fd0cfa19e232c56d550cbb2243f3c8f22`.

Full production GP and both portable methods passed again after this lifecycle
fix, as recorded above. Retained-output/replacement whole-app observations and
the separate worker-count benchmark remain separate evidence.
