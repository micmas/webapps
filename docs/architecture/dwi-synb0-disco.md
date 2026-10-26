# Synb0-DisCo front end for the sdc solver: feasibility and comparison

Record for [#508](https://github.com/neurodesk/webapps/issues/508), 24 October 2026.
The reverse-PE solver of `apps/sdc` comes from [the reverse-PE options document](dwi-reverse-pe-options.md).

## Question

Synb0-DisCo makes a synthetic undistorted b0 from a T1w image.
Its `--notopup` option stops before `topup` and gives that image.
Can the `apps/sdc` solver use the synthetic b0 as its second image, for data without a reverse-PE b0?
Issue #508 requires one comparison: the solver's field with the synthetic b0 against `topup` with the same synthetic b0 (Synb0-DisCo's own pipeline), with the metrics of the options document.
The browser part is in scope only if the model converts to ONNX and runs in ONNX Runtime Web inside the memory limit.

## Result

**The comparison is done on six subjects. The result is negative for a browser front end now.**

- The solver's field with the synthetic b0 differs from Synb0-DisCo's `topup` field by 6.11 Hz (demeaned median, mean of six subjects; r 0.87).
- Against `topup` with the real reverse-PE pair, the solver's field is no closer than a zero field: 11.0 Hz demeaned for both (median absolute difference after the median offset is removed).
  Synb0-DisCo's own `topup` gets 8.99 Hz.
- The solver fits the synthetic image more closely than `topup` does, and it gets better AP-PA agreement than Synb0-DisCo's `topup` on all six subjects.
  But its T1w alignment (BBR cost) is worse than Synb0-DisCo's `topup` on all six subjects, and worse than no correction on three (ds005134 sub-01, ds004146 sub-0001 and sub-0005).
  PyHySCO showed the same pattern on real reverse-PE pairs in the options document: better AP-PA, worse BBR.
- No method with a synthetic b0 passes the image gate of issue #471 (AP-PA at most 1.1 x and BBR at most 1.0 x `topup` with the real pair).
  This is expected: the synthetic image is a prediction, not a measurement.
- The model converts. Five ONNX folds run in ONNX Runtime Web 1.29.0 (WebAssembly) in 10 to 12 s each with 8 threads, with a process peak of 1.79 GB.
  The ONNX output agrees with Synb0-DisCo's own inference to 0.66 % of the b0 99th percentile.

The browser part is not implemented, for three reasons, each measured below:

1. The end-to-end field with the current solver is not better than no correction in the primary field metric, and it makes T1w alignment worse on three of six subjects.
2. Three preprocessing steps have no shared-package equivalent yet (see "Plan for the browser front end").
3. The weights come from 488 HCP, 424 BLSA and 38 Vanderbilt subjects. The options document requires a data-use check before FD-Net's HCP-derived weights ship; the same rule applies here.

Issue #508 stays open for the solver change and the browser work.

## Synb0-DisCo

| Item | Value |
| --- | --- |
| Source | [MASILab/Synb0-DISCO](https://github.com/MASILab/Synb0-DISCO) `d813f94` (31 July 2025); tag v3.1 is `1a5ee6f` |
| Licence | MIT (`synb0-license-MIT.txt`) since `bf8586e`, 31 July 2025; CC-BY-4.0 before. The weights are in the repository (`src/train_lin`) |
| Container | `leonyichencai/synb0-disco:v3.1`, `sha256:98ba3915316f5adda1f23f3531f49f307d9a49fc0e8fcb26e34d7506bc297c0c`; SIF sha256 `931f0299c8101ac4c90773e68bef811a34b0c250f4c5b27ebf5d6f7f02e919fc` (Apptainer pull) |
| Tools in the container | FreeSurfer 6.0.0, FSL 6.0.1, ANTs 3.0.0.0.dev21 (February 2019), PyTorch 1.1.0 on the CPU, c3d_affine_tool |
| Neurodesk | not on CVMFS. `deepdisco` there is a different tool (disconnectome maps) |
| Papers | Schilling et al. 2019, [doi:10.1016/j.mri.2019.05.008](https://doi.org/10.1016/j.mri.2019.05.008); Schilling et al. 2020, [doi:10.1371/journal.pone.0236418](https://doi.org/10.1371/journal.pone.0236418) |
| Training data | 950 subjects in `src/learning_subjects.txt` and `src/test_subjects.txt`: HCP 488, BLSA 424, Vanderbilt studies 38 |

### Pipeline (`src/pipeline.sh`, `data_processing/*.sh`)

1. T1w intensity normalization: FreeSurfer `mri_nu_correct.mni --n 2` (N3), then `mri_normalize -g 1 -mprage` (white matter to 110).
2. Brain mask: FSL `bet -R`, unless `--stripped` says that the T1w is already a brain.
3. `epi_reg` of the distorted b0 to the T1w (BBR), converted to ITK with `c3d_affine_tool`.
4. `antsRegistrationSyNQuick.sh` of the T1w to MNI152 2009c (1 mm).
   The network inputs use only the affine. The SyN warp is computed and written but not used.
5. `antsApplyTransforms` (B-spline) of the normalized T1w and the b0 to the MNI 2.5 mm grid (77 x 91 x 77).
6. Five network folds; the mean of their outputs.
7. The inverse affine transforms (B-spline) take the mean back to the b0 grid: `b0_u.nii.gz`.
8. The distorted b0 is smoothed (`fslmaths -s 1.15`): `b0_d_smooth.nii.gz`.
9. Without `--notopup`: `topup` on `b0_d_smooth` and `b0_u` with `synb0.cnf` (movement estimated in the first five levels), where the second `acqparams` row has readout time 0.

FreeSurfer needs a licence file. The image has an empty one.
The runs here bind the licence file that Neurodesk's `freesurfer_8.2.0_20261019` container ships. It is not in the repository or on Hugging Face.
The issue owner must confirm that this use is acceptable. If not, rerun `synb0.sh` with the owner's own licence file and record that file here.

### Network

A 3D U-Net (`src/model.py`): 2 input channels (b0, T1w), 1 output, 32 to 512 channels, Conv3d and ConvTranspose3d with InstanceNorm3d and LeakyReLU, about 19.3 million parameters (77.3 MB per fold in float32).
`src/inference.py` pads 77 x 91 x 77 to 80 x 96 x 80, puts the axes in the order (z, x, y), scales the T1w from [0, 150] and the b0 from [0, its 99th percentile] to [-1, 1], and reverses that on the output.

## Measurement

### Data and runs

The six subjects and the prepared inputs of the options document (`dwi-reverse-pe-options/prep.sh`).
ds005134 sub-01 has an MPRAGE T1w. The five ds004146 subjects have an MP2RAGE UNIT1 T1w, which is not the contrast Synb0-DisCo was trained on.
sub-01 gives the same pattern as the other five, so the contrast does not explain the result.

`dwi-synb0-disco/synb0.sh` runs Synb0-DisCo with these inputs:

- `b0.nii.gz`: the mean AP b0 (`prep/ap_mean.nii.gz`), on the grid of every field in the options document.
- `T1.nii.gz`: the MindGrab brain (`prep/t1w_brain.nii.gz`) with `--stripped`, so the pipeline does not run `bet`.
- `acqparams.txt`: the AP row, then the same row with readout time 0.

Then it runs `topup` with the pipeline's own command and `--fout` added (`synb0-topup`).
FSL 6.0.1 `topup` has no `--nthr`, so it runs on one thread.

`dwi-synb0-disco/solve.sh` runs the `sdc` command line (`exes/sdc`, the code of `apps/sdc`) with the synthetic b0 as image 2:

- `synb0-sdc`: image 1 is `b0_d_smooth`, the image that Synb0-DisCo's `topup` gets. This is the comparison that the issue asks for.
- `synb0-sdc-raw`: image 1 is the unsmoothed AP mean, as the app reads it.
- `uncorrected`: a zero field, as a baseline.

The solver assumes equal and opposite displacements, so it gets the opposite PE direction and the same readout time for image 2.
Its field then lives on the midpoint grid and has half the size.
The symmetric model is exact for this case: with y = m + b and z = m - b, D(m + b)(1 + b') = U(m - b)(1 - b') is D(y) = U(z) dz/dy.
`fields.py` (`full_from_midpoint`) solves m = z + b(m) along the PE axis and gives F(z) = 2 b(m), the displacement in the frame of the synthetic image.
A check confirms the conversion: corrected with F, the distorted b0 matches the synthetic b0 as well as Synb0-DisCo's `topup` correction does (sub-01: 0.0606 against 0.0611), and better than with 2 b(z) (0.0711) or b(z) (0.0826).
Before that, the command line's field on the real pair of sub-01 was checked against the options document's PyHySCO field: median difference 4.3 x 10⁻⁶ Hz.

`dwi-reverse-pe-options/post.sh` then scores every field with the options document's metrics, and `dwi-synb0-disco/compare.py` adds the comparison with `synb0-topup`.
AP-PA agreement uses the real PA b0 of these subjects. A real Synb0-DisCo user has no PA b0 and cannot make this check.

### Times and memory (native, `epic`)

| Step | Wall time | Peak RSS |
| --- | --- | --- |
| Synb0-DisCo `--notopup` (8 threads requested) | 5:58 to 6:54 | 18.8 GB (PyTorch 1.1 inference on the CPU) |
| `topup`, `synb0.cnf`, one thread | 108 to 121 s | 0.33 GB |
| `sdc` command line | 1.3 to 1.6 s | 0.38 GB |

### Field difference from `topup` with the same synthetic b0

| Subject | Method | Δfield | Offset | Δfield demeaned | r | Synthetic fit |
| --- | --- | --- | --- | --- | --- | --- |
| ds004146-sub-0001 | synb0-sdc | 6.25 | -5.25 | 5.27 | 0.871 | 0.0427 |
| ds004146-sub-0001 | synb0-sdc-raw | 7.23 | -6.76 | 4.88 | 0.879 | 0.0543 |
| ds004146-sub-0001 | uncorrected | 18.6 | -16.6 | 10.3 | n/a | 0.0883 |
| ds004146-sub-0002 | synb0-sdc | 5.83 | -1.57 | 5.89 | 0.909 | 0.0423 |
| ds004146-sub-0002 | synb0-sdc-raw | 5.54 | -2.17 | 5.37 | 0.91 | 0.0541 |
| ds004146-sub-0002 | uncorrected | 15 | -7.4 | 11.6 | n/a | 0.0907 |
| ds004146-sub-0003 | synb0-sdc | 9.24 | -8.76 | 5.55 | 0.931 | 0.0429 |
| ds004146-sub-0003 | synb0-sdc-raw | 9.85 | -9.48 | 5.35 | 0.932 | 0.0556 |
| ds004146-sub-0003 | uncorrected | 21.9 | -18.5 | 14 | n/a | 0.102 |
| ds004146-sub-0004 | synb0-sdc | 6.58 | -1.87 | 6.44 | 0.848 | 0.0407 |
| ds004146-sub-0004 | synb0-sdc-raw | 6.1 | -3.22 | 5.71 | 0.865 | 0.0531 |
| ds004146-sub-0004 | uncorrected | 16.8 | -14.1 | 11 | n/a | 0.0959 |
| ds004146-sub-0005 | synb0-sdc | 7.17 | -4.21 | 6.71 | 0.803 | 0.0396 |
| ds004146-sub-0005 | synb0-sdc-raw | 6.98 | -5.1 | 6.1 | 0.818 | 0.051 |
| ds004146-sub-0005 | uncorrected | 16.1 | -13.6 | 10.3 | n/a | 0.0849 |
| ds005134-sub-01 | synb0-sdc | 7.19 | -5.33 | 6.81 | 0.852 | 0.0606 |
| ds005134-sub-01 | synb0-sdc-raw | 6.91 | -4.46 | 6.43 | 0.853 | 0.0807 |
| ds005134-sub-01 | uncorrected | 13.6 | 8.19 | 12.1 | n/a | 0.118 |

"Synthetic fit" is the mean absolute difference of the corrected b0 and the synthetic b0 in the brain, divided by the synthetic mean, after the corrected b0 is scaled to that mean.
Synb0-DisCo's `topup` gets 0.048 to 0.061 on it; the solver gets 0.040 to 0.061.

### The options document's metrics

Reference: `topup` with the real reverse-PE pair. AP-PA and BBR are ratios to its values.

| Subject | Method | AP-PA ratio | BBR ratio | Δfield demeaned (Hz) | r | Δ GRE demeaned (Hz) |
| --- | --- | --- | --- | --- | --- | --- |
| ds004146-sub-0001 | uncorrected | 2.71 | 1.105 | 6.77 | n/a | n/a |
| ds004146-sub-0001 | synb0-topup | 2.82 | 1.079 | 8.69 | 0.751 | n/a |
| ds004146-sub-0001 | synb0-sdc | 2.51 | 1.114 | 11.2 | 0.645 | n/a |
| ds004146-sub-0001 | synb0-sdc-raw | 2.36 | 1.097 | 10.3 | 0.648 | n/a |
| ds004146-sub-0002 | uncorrected | 2.48 | 1.136 | 9.81 | n/a | n/a |
| ds004146-sub-0002 | synb0-topup | 2.37 | 1.044 | 8.78 | 0.802 | n/a |
| ds004146-sub-0002 | synb0-sdc | 2.08 | 1.092 | 11.3 | 0.738 | n/a |
| ds004146-sub-0002 | synb0-sdc-raw | 1.95 | 1.08 | 10.1 | 0.746 | n/a |
| ds004146-sub-0003 | uncorrected | 2.81 | 1.335 | 17.8 | n/a | n/a |
| ds004146-sub-0003 | synb0-topup | 2.36 | 1.082 | 12.2 | 0.83 | n/a |
| ds004146-sub-0003 | synb0-sdc | 2.14 | 1.098 | 12.2 | 0.801 | n/a |
| ds004146-sub-0003 | synb0-sdc-raw | 2.09 | 1.092 | 12 | 0.808 | n/a |
| ds004146-sub-0004 | uncorrected | 2.06 | 1.076 | 12.7 | n/a | n/a |
| ds004146-sub-0004 | synb0-topup | 1.84 | 1.01 | 8.16 | 0.781 | n/a |
| ds004146-sub-0004 | synb0-sdc | 1.7 | 1.06 | 10.5 | 0.678 | n/a |
| ds004146-sub-0004 | synb0-sdc-raw | 1.57 | 1.045 | 9.31 | 0.697 | n/a |
| ds004146-sub-0005 | uncorrected | 2.77 | 1.104 | 7.93 | n/a | n/a |
| ds004146-sub-0005 | synb0-topup | 2.97 | 1.081 | 8.51 | 0.739 | n/a |
| ds004146-sub-0005 | synb0-sdc | 2.75 | 1.169 | 11.4 | 0.607 | n/a |
| ds004146-sub-0005 | synb0-sdc-raw | 2.64 | 1.146 | 10.5 | 0.623 | n/a |
| ds005134-sub-01 | uncorrected | 2.43 | 1.1 | 10.8 | n/a | 10.5 |
| ds005134-sub-01 | synb0-topup | 2.24 | 1.082 | 7.55 | 0.773 | 6.34 |
| ds005134-sub-01 | synb0-sdc | 2.1 | 1.192 | 9.1 | 0.628 | 7.45 |
| ds005134-sub-01 | synb0-sdc-raw | 1.9 | 1.147 | 7.8 | 0.631 | 6.21 |

### Means over the six subjects

| Method | Δfield demeaned from synb0-topup (Hz) | r with synb0-topup | AP-PA ratio | BBR ratio | Δfield demeaned from topup (Hz) | Δfield from topup (Hz) | Absolute offset from topup (Hz) | Time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| uncorrected | 11.5 | n/a | 2.54 | 1.143 | 11 | 11.1 | 1.81 | n/a |
| synb0-topup | 0 | 1 | 2.43 | 1.063 | 8.99 | 13.7 | 11.3 | 118 |
| synb0-sdc | 6.11 | 0.869 | 2.21 | 1.121 | 11 | 14 | 8.87 | 1.54 |
| synb0-sdc-raw | 5.64 | 0.876 | 2.08 | 1.101 | 10 | 12.7 | 7.8 | 1.45 |

"Δfield from topup" is the median absolute difference before demeaning; the offset is the median difference, as an absolute value per subject.
Without demeaning, every field from the synthetic b0 is farther from `topup` with the real pair than a zero field is (`synb0-topup` 13.7 Hz, `synb0-sdc` 14.0 Hz, `synb0-sdc-raw` 12.7 Hz, against 11.1 Hz), because each has a constant offset of 4 to 16 Hz.
On sub-01 the solver's offset is -11.7 Hz (13.4 Hz before demeaning, against 11.1 Hz for the zero field).
A constant offset only moves the whole image along the PE axis, so the demeaned columns are the main metric, as in the options document. The raw columns do not change the result.

### Diagnostic: the regularization weight

The symmetric solver regularizes the half field, so α = 300 smooths the full field four times less than PyHySCO's default smooths a reverse-PE field (see "Plan", step 1).
`run_alpha.py` runs PyHySCO 0.0.4 itself on the `synb0-sdc` pair.
With α = 300 it gives the `sdc` command line's numbers on every subject, which also checks the conversion of PyHySCO's staggered field.
With α = 1200:

| Subject | Δfield demeaned from `synb0-topup` (Hz) | r with `synb0-topup` | AP-PA ratio | BBR ratio | BBR ratio, uncorrected |
| --- | --- | --- | --- | --- | --- |
| ds005134 sub-01 | 7.86 | 0.739 | 2.06 | 1.177 | 1.100 |
| ds004146 sub-0001 | 5.74 | 0.810 | 2.28 | 1.093 | 1.105 |
| ds004146 sub-0002 | 5.47 | 0.858 | 1.98 | 1.087 | 1.136 |
| ds004146 sub-0003 | 6.27 | 0.869 | 2.07 | 1.114 | 1.335 |
| ds004146 sub-0004 | 6.08 | 0.806 | 1.60 | 1.041 | 1.076 |
| ds004146 sub-0005 | 6.34 | 0.755 | 2.54 | 1.141 | 1.104 |
| Mean | 6.29 | 0.806 | 2.09 | 1.109 | 1.143 |

A smoother field moves closer to `topup` with the real pair (9.74 Hz against 11.0 Hz with α = 300), but not closer to `synb0-topup`.
BBR is still worse than `synb0-topup` on every subject and worse than no correction on two (sub-01 and sub-0005).
A larger α alone does not make the solver usable with a synthetic b0. This is a diagnostic, not a pass.

## Model conversion and ONNX Runtime Web

`dwi-synb0-disco/export_onnx.py` exports each fold with PyTorch 2.8.0 (opset 17).
ONNX Runtime's CPU ConvTranspose builds a column buffer of output channels x kernel volume x voxels.
For `dc2` (192 to 64 channels, 3 x 3 x 3, at 80 x 96 x 80) that is about 4.2 GB in float32.
The export as it is fails in ONNX Runtime Web 1.29.0 with `std::bad_alloc`.
So the script writes every stride-1 ConvTranspose3d as the equal Conv3d (kernel flipped, channels swapped, padding k - 1 - p).
The two forms differ by at most 1.5 x 10⁻⁵ on a random input. The stride-2 layers stay ConvTranspose3d.

| Check | Result |
| --- | --- |
| ONNX Runtime 1.31.0 (Python, CPU) against the native folds, sub-01 | at most 0.26 intensity units per fold (0.095 % of the b0 99th percentile, 271); the five-fold mean at most 0.056 |
| ONNX Runtime Web 1.29.0 (WebAssembly, Node 26.11.1) against the native folds | at most 0.0132 network units, that is 1.8 intensity units or 0.66 % of the 99th percentile |
| Time per fold, ONNX Runtime Web | 10.3 to 12.3 s with 8 threads, 14.3 s with 4, 46.2 s with 1 (8-core host) |
| Process peak RSS | 1.79 GB for one fold (the model, the Node runtime and the WebAssembly heap) |
| Download | 5 x 77.4 MB in float32 |

The memory limit is the WebAssembly 4 GiB address space; the repository has no other written budget than the 2 GB typed-array note in [examples verification](examples-verification.md).
The RSS includes more than the WebAssembly heap, so the heap is smaller than 1.79 GB.
The number comes from Node, which runs the same `ort-wasm-simd-threaded` binary as a browser. A headless Chromium number was not taken.
Five folds take about 1 minute with 8 threads, and about 4 minutes without cross-origin isolation (one thread).
Float16 weights would halve the download. They were not tested.

`model_check.py` repeats Synb0-DisCo's input scaling and runs the five ONNX folds on the native run's atlas-space inputs. `ort_web_check.mjs` runs one fold in ONNX Runtime Web. The ONNX files are not published (see "Pinned results").

## Plan for the browser front end

Do these in this order. Each step has a measurement before the next one starts.

1. **Solver.** The symmetric solver regularizes the half field b = F / 2, so α |∇b|² is (α / 4) |∇F|²: with the default α = 300, the full field is four times less smooth than PyHySCO's default gives a reverse-PE pair. That agrees with the closer fit to the synthetic image and the worse T1w alignment. The diagnostic above measures α = 1200 with PyHySCO itself. Then try a one-sided data term (only image 1 is resampled; the synthetic image stays fixed), which is a change to `exes/sdc/core`. `topup` also estimates movement between the two images (`--estmov` in the first five levels); the solver has no movement model. Accept a change only if the field gets closer to `synb0-topup` and BBR is not worse than no correction on any of the six subjects.
2. **Weights.** Check the data-use terms of HCP and BLSA for publishing derived weights, as for FD-Net. Until then, do not publish the ONNX files.
3. **Preprocessing**, in shared packages:
   - N3 and `mri_normalize`: N4 (`packages/n4`) and a white-matter scaling to 110, with the white matter from MindGrab's tissue model. The network scales the T1w from [0, 150], so the scale is important.
   - Brain mask: MindGrab, as here.
   - `epi_reg`: a rigid b0-to-T1w registration. The design document names EdgeReg after niimath `-allineate` gives a matrix, and greedy before that.
   - T1w to MNI: an affine only (`packages/registration` or greedy). The SyN step is not necessary.
   - Resampling to and from the 2.5 mm grid: cubic B-spline, as `antsApplyTransforms -n BSpline`, or a measured simpler kernel.
   - Smoothing: a Gaussian with σ = 1.15 mm.
4. **Model.** The five ONNX folds through `fetchModel` with a pinned manifest, in ONNX Runtime Web; WebGPU only after the CPU path agrees with `model_check.py`.
5. **Gate.** The browser synthetic b0 against the native `b0_u` of sub-01, then the browser field against the native field of the accepted solver (the options document's port gate: < 0.1 Hz median in the brain).

Outputs are expected to be close to the native pipeline, not equal: FreeSurfer N3 and `mri_normalize`, `epi_reg` and the ANTs version have no exact browser equivalents.

## Reproduce

The scripts are in [`dwi-synb0-disco/`](dwi-synb0-disco/). They extend the options document's scripts and use its `ROOT`.

```bash
export ROOT=/path/to/scratch/reverse-pe   # with the prepared subjects of dwi-reverse-pe-options
export SYNB0_IMAGE=$ROOT/containers/synb0-disco_v3.1.sif
apptainer pull "$SYNB0_IMAGE" docker://leonyichencai/synb0-disco@sha256:98ba3915316f5adda1f23f3531f49f307d9a49fc0e8fcb26e34d7506bc297c0c
export FS_LICENSE_FILE=/path/to/freesurfer/license.txt
export SDC=/path/to/exes/sdc/target/release/sdc   # make -C exes/sdc build
ALPHA=1 bash docs/architecture/dwi-synb0-disco/run_all.sh   # synb0.sh, solve.sh, run_alpha.py, post.sh, compare.py per subject
python3 docs/architecture/dwi-synb0-disco/report.py "$ROOT/runs"
```

`ALPHA=1` adds the diagnostic rows (`run_alpha.py`, PyHySCO 0.0.4 in the options document's `venv-main`).
`report.py` prints the tables of this document. `report.py --alpha` also prints the `synb0-pyhysco-a300` and `synb0-pyhysco-a1200` rows in each table; the numbers in the α = 1200 table above come from those rows.
The model checks need PyTorch, ONNX and ONNX Runtime in a Python environment, and `onnxruntime-web@1.29.0` in a scratch Node project:

```bash
python export_onnx.py <Synb0-DISCO checkout> <fold> fold<fold>.onnx [--sample] [--keep-transpose]
python model_check.py <synb0 OUTPUTS> <dir with fold1-5.onnx> model_check.json
node ort_web_check.mjs fold1.onnx 8 fold1.real
```

The script checks need no imaging tools.
The check of the midpoint-to-full conversion (`MidpointTests`) needs numpy, scipy and nibabel, and is skipped without them.
`SYNB0_REQUIRE_NUMERICS=1` makes that skip a failure:

```bash
uv venv /var/tmp/synb0-test-venv
uv pip install --python /var/tmp/synb0-test-venv numpy scipy nibabel
SYNB0_REQUIRE_NUMERICS=1 /var/tmp/synb0-test-venv/bin/python -m unittest discover -s docs/architecture/dwi-synb0-disco -p 'test_*.py'
```

### Pinned results

The synthetic b0 images, the network inputs and the five fold outputs on the 2.5 mm grid, every field, every `metrics.json` and `synb0-compare.json`, and sub-01's `model_check.json` are on the Hugging Face dataset `neurodeskorg/webapps`, `sdc/synb0-disco/`, at commit `0820b48a` (165 files, 336 MB, CC0 sources).
[`results.manifest.json`](dwi-synb0-disco/results.manifest.json) pins each file's size and SHA-256, and the folder's `README.md` describes each file.
The ONNX exports are not published, because of the data-use check in "Plan", step 2.
For α = 300 only the rows in `synb0-compare.json` are pinned, not `synb0-pyhysco-a300/field_hz.nii.gz` or its `metrics.json`. Those rows agree with `synb0-sdc` to within 0.002 Hz and 0.001 in the BBR ratio on every subject, so `synb0-sdc/field_hz.nii.gz` is the pinned field for α = 300.
The tables above come back without OpenNeuro, the containers or `epic`:

```bash
python3 docs/architecture/dwi-synb0-disco/fetch_results.py /path/to/results
python3 docs/architecture/dwi-synb0-disco/report.py /path/to/results
```

The runs used `epic` (32 cores, 123 GB). Synb0-DisCo ran with 8 threads (`OMP_NUM_THREADS`, `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS`); `topup` in its image is single-threaded.
