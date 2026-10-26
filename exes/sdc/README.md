# sdc

Reverse phase-encoding susceptibility distortion correction for the [`sdc` app](../../apps/sdc) and its `sdc` command line.
The method was chosen in [the reverse-PE options document](../../docs/architecture/dwi-reverse-pe-options.md).

| Crate | Content |
| --- | --- |
| `core` (`sdc-core`) | `hysco`: a port of PyHySCO 0.0.4; the permutation and the conversion of the field to Hz |
| `cli` (`sdc`) | `sdc pyhysco <image1> <image2> <prefix>`: reads NIfTI and BIDS sidecars, writes the field in Hz |
| `wasm` (`sdc-wasm`) | the C ABI that [`packages/sdc`](../../packages/sdc) compiles to `src/sdc.wasm`, with the WebGPU imports of `pyhysco_webgpu` |

The workspace is GPL-3.0-or-later, because PyHySCO is GPL-3.0 (`LICENSE`, `NOTICE`).

```bash
make build test lint
target/release/sdc pyhysco sub-01_dir-AP_epi.nii.gz sub-01_dir-PA_epi.nii.gz sub-01
```

## PyHySCO port

`core/src/hysco.rs` follows PyHySCO 0.0.4 (PyPI; the git commit `bff6655` only names the initialization `InitializeCF` instead of `InitializeOT`) with the defaults of its `pyhysco` command:

- the optimal-transport initialization, blurred with `(−Δ + 1)⁻¹` on a periodic grid;
- the objective: sum of squared differences of the two corrected images, α = 300 times the 3D Laplacian smoothness term, β = 10⁻⁴ times the intensity barrier;
- Gauss-Newton with an Armijo line search and Jacobi-preconditioned CG (10 iterations, tolerance 0.1), at most 50 iterations, with PyHySCO's stopping rules in its order.

The port keeps PyHySCO's quirks: the barrier gives 0 where |∂b| ≥ 1 (its `nan_to_num`), the line search keeps the positive descent value after it flips an ascent direction, PCG returns its last iterate, and the gradient uses PyHySCO's interpolation derivative also where the interpolation clamps.

### Inputs

The app and the command line average each input's b = 0 volumes (b ≤ 50 when a bval is given) without motion correction, and do not align image 2 to image 1: both must be in one space, as two series of one session usually are.
Both inputs need a phase-encoding direction and the same finite positive `TotalReadoutTime`: this PyHySCO model assumes equal and opposite displacements.
The shared core refuses nonfinite intensities and a zero or unrepresentable common intensity range before normalization, rather than returning NaN field maps.
The command line's `--pe1` and `--pe2` override the individual directions; `--trt` supplies a common readout time for both images.
The options document gave every method a prepared pair instead: each direction's b = 0 volumes aligned with `mcflirt`, averaged, and the PA mean aligned rigidly to the AP mean with ANTs.
On its six subjects that preparation does not bring PyHySCO closer to topup:

| Subject | Prepared pair | Plain means | Raw difference between the two fields |
| --- | --- | --- | --- |
| ds005134 sub-01 | 2.74 | 2.09 | 2.93 |
| ds004146 sub-0001 | 1.55 | 1.57 | 4.62 |
| ds004146 sub-0002 | 1.90 | 1.70 | 5.11 |
| ds004146 sub-0003 | 3.31 | 3.81 | 3.44 |
| ds004146 sub-0004 | 1.87 | 1.72 | 8.03 |
| ds004146 sub-0005 | 1.74 | 1.64 | 2.11 |
| Mean | 2.18 | 2.09 | |

Values are median absolute differences in Hz in the options document's brain mask (MindGrab on topup's corrected mean b0); the first two columns are the demeaned difference from topup.
The raw difference between the two fields is mostly a constant: the rigid PA-to-AP alignment absorbs part of the distortion as a translation along the phase-encoding axis.

### Deliberate divergence

PyHySCO's `interp_parallel` and `init_OT` allocate float32 buffers (`torch.empty` without a dtype), so a float64 PyHySCO run rounds its initialization to float32.
The port computes in float64 throughout.

### Parity

On ds005134 sub-01 (116 × 116 × 68, 2 mm, PE j-; the prepared pair of the options document):

| Stage | Max difference from PyHySCO float64 |
| --- | --- |
| initialization, PyHySCO with float64 buffers | 1.4e-13 relative |
| initialization, PyHySCO as released | 1.6e-6 relative (its float32 buffers) |
| objective and gradient at the same start | 1.1e-14 relative, gradient identical |
| one Gauss-Newton step, and the full run from the same start | 1.9e-14 relative |
| full run, field | 5.9e-6 mm |

The field in Hz differs from the float32 PyHySCO run of the options document by a median of 5.0e-6 Hz in the brain (maximum 0.026 Hz).
The WebAssembly module in Node gives the native field to 3.8e-6 Hz on this volume (the CLI writes float32).
In Chromium on the CPU path, the app's field for the slab example equals the CLI's float32 output in all 44,696 brain voxels (`apps/sdc/e2e/smoke.spec.js`, the port gate). On the WebGPU path (Intel Arc), it differs from that output by a median of 2.4e-6 Hz and a maximum of 0.0089 Hz (`apps/sdc/e2e/webgpu.spec.js`).
One run takes 1.3 s natively on one thread and 1.7 s in Node.

### WebGPU

`pyhysco_webgpu` in the `wasm` crate runs the same input checks, initialization, Gauss-Newton loop, line search, stopping rules and conversion to Hz as `pyhysco`, through `hysco::gauss_newton_with` and the `hysco::Backend` trait.
Its backend sends three operations to the `sdc_gpu` imports, which [`packages/sdc/src/webgpu.js`](../../packages/sdc/src/webgpu.js) runs as WebGPU compute kernels in float32:

- `eval`: the objective, and for a linearizing evaluation also the gradient and the Jacobi preconditioner (`JacobiCG.getM`);
- `pcg`: the 10-iteration Jacobi-preconditioned CG solve with the Gauss-Newton Hessian;
- `corrected`: the two corrected images of the last evaluation.

The optimal-transport initialization and its FFT blur stay on the CPU.
Each sum on the GPU ends as one float32 value per workgroup of 256; JavaScript adds these partial sums in float64.
The CG step, the CG stopping tests and all Gauss-Newton decisions use float64, in PyHySCO's order.
The imports return promises, so JavaScript calls `pyhysco_webgpu` through JSPI (`WebAssembly.promising`).
The CPU instance never calls them.

The refactor into `Backend` does not change the CPU numbers: the command line gives the same bytes as before on ds005134 sub-01.

On the six prepared pairs of the options document (Intel Arc, Xe2 LPG, Mesa Vulkan, Chromium 156; `apps/sdc/e2e/webgpu.spec.js` with `NEURODESK_HARDWARE_GPU=1`):

| Subject | Gauss-Newton iterations (CPU, WebGPU) | Median \|WebGPU − native PyHySCO\| (Hz) | Maximum (Hz) | WebAssembly CPU (s) | WebGPU (s) |
| --- | --- | --- | --- | --- | --- |
| ds005134 sub-01 | 5, 5 | 1.9e-5 | 0.066 | 1.56 | 0.64 |
| ds004146 sub-0001 | 5, 5 | 1.1e-5 | 0.0006 | 1.79 | 0.82 |
| ds004146 sub-0002 | 5, 5 | 9.9e-6 | 0.0035 | 1.80 | 0.76 |
| ds004146 sub-0003 | 6, 6 | 2.4e-5 | 0.063 | 2.12 | 0.88 |
| ds004146 sub-0004 | 6, 6 | 2.9e-5 | 0.21 | 2.10 | 0.85 |
| ds004146 sub-0005 | 5, 5 | 8.8e-6 | 0.0004 | 1.81 | 0.76 |

"Native PyHySCO" is the float32 CPU run of the options document (`<subject>/pyhysco/field_hz.nii.gz` at the pinned revision of `results.manifest.json`).
The values are absolute differences, not demeaned, in its brain mask (`mask/b0_mask.nii.gz`, MindGrab).
On ds005134 sub-01 the median difference from the CUDA float32 run (`pyhysco-gpu`) is 1.3e-5 Hz, and from the WebAssembly CPU field 2.0e-5 Hz.
Two WebGPU runs on one device give the same field.
The gate of issue #506 is a median below 0.1 Hz on ds005134 sub-01; the field passes it by more than three orders of magnitude.
The times include the CPU initialization and the copies between WebAssembly and the GPU; they are from one run on a host that was not idle.

Second vendor, ds005134 sub-01 (AMD Radeon RDNA 2 integrated GPU of a Ryzen 9 9950X, Mesa RADV, `VK_DRIVER_FILES` set to the RADV driver, same spec and Chromium build): 5 and 5 Gauss-Newton iterations, a median of 1.8e-5 Hz from the native PyHySCO field (maximum 0.066 Hz), 1.3e-5 Hz from the CUDA field, 0.50 s on WebGPU and 1.10 s on the CPU path. Two WebGPU runs give the same field. The app's example on WebGPU differs from the native command line by a median of 2.4e-6 Hz (maximum 0.0089 Hz).
On the same host, Chromium gave only a fallback adapter with the NVIDIA Vulkan driver (RTX 5080, driver 615.78.08, no display), so the spec refused the run and NVIDIA is not validated.
Apple Metal, 25 October 2026: Chromium on GitHub's `macos-15` runner, using a hardware Apple adapter, passes all 25 browser tests in [the SDC Metal job](https://github.com/neurodesk/webapps/actions/runs/40177274663/job/121142517985) at source `b74db0fca`.
On ds005134 sub-01, CPU and WebGPU both take five Gauss-Newton iterations. The raw median difference from native PyHySCO's float32 CPU field is 1.8521e-5 Hz and the maximum is 0.06639 Hz over 199,566 brain voxels.
Within that brain mask, the two WebGPU runs give identical fields. The app's example runs on WebGPU and differs from the native command line by a median of 2.3842e-6 Hz and a maximum of 0.008884 Hz over 134,560 voxels.
These are correctness results from one hosted run; they do not establish a performance comparison.

`estimate` in `packages/sdc` picks WebGPU only on a hardware adapter and when the engine has JSPI.
It does not pick software adapters (SwiftShader, llvmpipe, WARP), because they are slower than the CPU path.
It uses the software-adapter check of `@neurodesk/runtime-support/mindgrab/backend`, which MindGrab's backend choice and `test-utils/hardware-gpu.mjs` also use.
When the WebGPU run fails, it runs the CPU path.
After a failure the same instance stays on the CPU path, but when the browser lost the device, the next run opens a new device.

### Limits

- The app reads each 4D input whole as float32 before it averages the b = 0 volumes: a 130-volume DWI series of 116 × 116 × 69 voxels takes about 480 MB in the tab. Give the app only the b = 0 volumes when memory is short.
- The phase-encoding direction must be i or j (PyHySCO's restriction).

To repeat it: run `validation/pyhysco_reference.py` with PyHySCO 0.0.4 and PyTorch, then `cargo run --release --example parity -- <its output directory>`.
