//! C ABI for the sdc app. JavaScript copies two Float64 volumes in and reads the field in Hz and
//! the two corrected images back.
//!
//! `pyhysco` runs every stage here. `pyhysco_webgpu` runs the same input checks, initialization,
//! Gauss-Newton control flow and conversion to Hz here, but sends the objective, its
//! linearization and the preconditioned CG solve to the `sdc_gpu` imports, which
//! `packages/sdc/src/webgpu.js` implements with WebGPU. Those imports return promises, so
//! JavaScript calls `pyhysco_webgpu` through `WebAssembly.promising` (JSPI).

use sdc_core::hysco::{self, Backend, Grid, Solution};
use sdc_core::{Correction, Pair};

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a matching `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// Runs PyHySCO on two `nx` × `ny` × `nz` volumes (first index fastest) with opposite
/// phase-encoding directions along axis `pe` (0 or 1). `pe_sign` is image 1's direction (+1 or
/// -1), `trt` its TotalReadoutTime in seconds and `vx`, `vy`, `vz` the voxel sizes in mm.
/// Returns the number of Gauss-Newton iterations, or 0 for invalid input.
///
/// # Safety
/// `image1`, `image2`, `field`, `corrected1` and `corrected2` must each address
/// `nx * ny * nz` f64 values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn pyhysco(
    image1: *const f64,
    image2: *const f64,
    nx: usize,
    ny: usize,
    nz: usize,
    vx: f64,
    vy: f64,
    vz: f64,
    pe: usize,
    pe_sign: f64,
    trt: f64,
    field: *mut f64,
    corrected1: *mut f64,
    corrected2: *mut f64,
) -> u32 {
    let pair = unsafe { pair(image1, image2, [nx, ny, nz], [vx, vy, vz], pe, pe_sign, trt) };
    let out = sdc_core::pyhysco(&pair, &hysco::Options::default());
    unsafe { write(out, nx * ny * nz, field, corrected1, corrected2) }
}

/// [`pyhysco`] with the Gauss-Newton evaluations and the CG solves on the `sdc_gpu` imports.
/// The arguments and the result are those of [`pyhysco`].
///
/// # Safety
/// As for [`pyhysco`]. JavaScript must call it through `WebAssembly.promising`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn pyhysco_webgpu(
    image1: *const f64,
    image2: *const f64,
    nx: usize,
    ny: usize,
    nz: usize,
    vx: f64,
    vy: f64,
    vz: f64,
    pe: usize,
    pe_sign: f64,
    trt: f64,
    field: *mut f64,
    corrected1: *mut f64,
    corrected2: *mut f64,
) -> u32 {
    let pair = unsafe { pair(image1, image2, [nx, ny, nz], [vx, vy, vz], pe, pe_sign, trt) };
    let out = sdc_core::pyhysco_with(&pair, &hysco::Options::default(), solve_on_gpu);
    unsafe { write(out, nx * ny * nz, field, corrected1, corrected2) }
}

unsafe fn pair<'a>(
    image1: *const f64,
    image2: *const f64,
    dims: [usize; 3],
    voxel: [f64; 3],
    pe: usize,
    pe_sign: f64,
    total_readout_time: f64,
) -> Pair<'a> {
    let n = dims.iter().product();
    Pair {
        image1: unsafe { std::slice::from_raw_parts(image1, n) },
        image2: unsafe { std::slice::from_raw_parts(image2, n) },
        dims,
        voxel,
        pe,
        pe_sign,
        total_readout_time,
    }
}

unsafe fn write(
    out: Result<Correction, String>,
    n: usize,
    field: *mut f64,
    corrected1: *mut f64,
    corrected2: *mut f64,
) -> u32 {
    let Ok(out) = out else {
        return 0;
    };
    unsafe { std::slice::from_raw_parts_mut(field, n) }.copy_from_slice(&out.field_hz);
    unsafe { std::slice::from_raw_parts_mut(corrected1, n) }.copy_from_slice(&out.corrected1);
    unsafe { std::slice::from_raw_parts_mut(corrected2, n) }.copy_from_slice(&out.corrected2);
    (out.loss.len() - 1).max(1) as u32
}

#[link(wasm_import_module = "sdc_gpu")]
unsafe extern "C" {
    /// Uploads the permuted, normalized images: `m` cells (PE axis last), cell size `h` in mm,
    /// the PE cell centres (`m2` values), and the weights of the smoothness and barrier terms.
    #[link_name = "setup"]
    fn gpu_setup(
        i1: *const f64,
        i2: *const f64,
        m0: usize,
        m1: usize,
        m2: usize,
        h0: f64,
        h1: f64,
        h2: f64,
        centres: *const f64,
        alpha: f64,
        beta: f64,
    );
    /// The objective at `b` (`m0 * m1 * (m2 + 1)` nodes). With `linearize` it also writes the
    /// gradient to `grad` and keeps the Gauss-Newton terms for `pcg`.
    #[link_name = "eval"]
    fn gpu_eval(b: *const f64, linearize: u32, grad: *mut f64) -> f64;
    /// Jacobi-preconditioned CG from x = 0 with the last linearization; writes x to `out`.
    #[link_name = "pcg"]
    fn gpu_pcg(rhs: *const f64, out: *mut f64);
    /// The two corrected images of the last evaluation (`m0 * m1 * m2` cells each).
    #[link_name = "corrected"]
    fn gpu_corrected(corr1: *mut f64, corr2: *mut f64);
}

/// The `sdc_gpu` imports as a Gauss-Newton backend.
struct Gpu {
    nodes: usize,
    cells: usize,
}

impl Backend for Gpu {
    fn eval(&mut self, b: &[f64], linearize: bool) -> (f64, Option<Vec<f64>>) {
        assert_eq!(b.len(), self.nodes);
        if linearize {
            let mut grad = vec![0.0; self.nodes];
            let j = unsafe { gpu_eval(b.as_ptr(), 1, grad.as_mut_ptr()) };
            (j, Some(grad))
        } else {
            (
                unsafe { gpu_eval(b.as_ptr(), 0, std::ptr::null_mut()) },
                None,
            )
        }
    }
    fn pcg(&mut self, rhs: &[f64]) -> Vec<f64> {
        assert_eq!(rhs.len(), self.nodes);
        let mut x = vec![0.0; self.nodes];
        unsafe { gpu_pcg(rhs.as_ptr(), x.as_mut_ptr()) };
        x
    }
    fn corrected(self) -> (Vec<f64>, Vec<f64>) {
        let (mut c1, mut c2) = (vec![0.0; self.cells], vec![0.0; self.cells]);
        unsafe { gpu_corrected(c1.as_mut_ptr(), c2.as_mut_ptr()) };
        (c1, c2)
    }
}

/// The initialization runs here, as on the CPU path; Gauss-Newton runs on the imports.
fn solve_on_gpu(g: Grid, i1: &[f64], i2: &[f64], options: &hysco::Options) -> Solution {
    let (_, b0) = hysco::initialize(g, i1, i2);
    let centres = hysco::cell_centres(&g);
    unsafe {
        gpu_setup(
            i1.as_ptr(),
            i2.as_ptr(),
            g.m[0],
            g.m[1],
            g.m[2],
            g.h[0],
            g.h[1],
            g.h[2],
            centres.as_ptr(),
            options.alpha,
            options.beta,
        );
    }
    let cells = g.m[0] * g.m[1] * g.m[2];
    let nodes = g.m[0] * g.m[1] * (g.m[2] + 1);
    hysco::gauss_newton_with(Gpu { nodes, cells }, b0, options)
}
