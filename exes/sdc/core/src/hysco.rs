//! PyHySCO 0.0.4 (Julian and Ruthotto 2024): hyperelastic susceptibility artifact correction of a
//! reverse phase-encoding pair, with the defaults of its `pyhysco` command. The structure follows
//! `EPI_MRI` and `optimization` of that release; the names in comments are its names.
//!
//! The images are permuted as `load_data` does: slice axis first, the other in-plane axis second,
//! the phase-encoding (PE) axis last. The field `b` lives on the staggered grid `m_plus(m)`, with
//! m + 1 nodes along the PE axis, in mm.

use rustfft::FftPlanner;
use rustfft::num_complex::Complex;

/// The `pyhysco` command's defaults.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub alpha: f64,
    pub beta: f64,
    pub max_iter: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            alpha: 300.0,
            beta: 1e-4,
            max_iter: 50,
        }
    }
}

/// The permuted grid: `m` cells, domain `omega = [0, extent]` and cell size `h` (mm) per
/// axis, PE axis last.
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub m: [usize; 3],
    pub extent: [f64; 3],
    pub h: [f64; 3],
}

impl Grid {
    /// `load_data`: the domain is `voxel size × m` on each axis and `h = omega / m`.
    pub fn new(m: [usize; 3], voxel: [f64; 3]) -> Self {
        let extent = std::array::from_fn(|a| voxel[a] * m[a] as f64);
        Self {
            m,
            extent,
            h: std::array::from_fn(|a| extent[a] / m[a] as f64),
        }
    }
    fn length(&self) -> f64 {
        self.extent[2]
    }
    fn rows(&self) -> usize {
        self.m[0] * self.m[1]
    }
    fn cells(&self) -> usize {
        self.rows() * self.m[2]
    }
    fn nodes(&self) -> usize {
        self.rows() * (self.m[2] + 1)
    }
    fn hd(&self) -> f64 {
        self.h[0] * self.h[1] * self.h[2]
    }
}

/// What a run returns, on the permuted grid.
pub struct Solution {
    /// The field on `m_plus(m)` nodes, in mm.
    pub b: Vec<f64>,
    /// The two corrected images, `I1(x + b)(1 + ∂b)` and `I2(x − b)(1 − ∂b)`, normalized.
    pub corr1: Vec<f64>,
    pub corr2: Vec<f64>,
    /// The objective at the start and after each Gauss-Newton iteration.
    pub loss: Vec<f64>,
}

/// `normalize`: shift both images by their common minimum and scale the common maximum to 256.
pub fn normalize(i1: &mut [f64], i2: &mut [f64]) {
    let min = i1
        .iter()
        .chain(i2.iter())
        .copied()
        .fold(f64::INFINITY, f64::min);
    i1.iter_mut().chain(i2.iter_mut()).for_each(|v| *v -= min);
    let max = i1
        .iter()
        .chain(i2.iter())
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let scale = 256.0 / max;
    i1.iter_mut().chain(i2.iter_mut()).for_each(|v| *v *= scale);
}

/// `Conv1D.mat_mul` with a two-tap kernel: nodes to cells, `out[i] = k0 x[i] + k1 x[i + 1]`.
fn conv(g: &Grid, k: [f64; 2], x: &[f64], out: &mut [f64]) {
    let n = g.m[2];
    for r in 0..g.rows() {
        let x = &x[r * (n + 1)..(r + 1) * (n + 1)];
        let o = &mut out[r * n..(r + 1) * n];
        for i in 0..n {
            o[i] = k[0] * x[i] + k[1] * x[i + 1];
        }
    }
}

/// `Conv1D.transp_mat_mul`: cells to nodes, `out[j] = k0 c[j] + k1 c[j − 1]`.
fn conv_t(g: &Grid, k: [f64; 2], c: &[f64], out: &mut [f64]) {
    let n = g.m[2];
    for r in 0..g.rows() {
        let c = &c[r * n..(r + 1) * n];
        let o = &mut out[r * (n + 1)..(r + 1) * (n + 1)];
        o[0] = k[0] * c[0];
        for j in 1..n {
            o[j] = k[0] * c[j] + k[1] * c[j - 1];
        }
        o[n] = k[1] * c[n - 1];
    }
}

/// `myLaplacian3D`: the 7-point negative Laplacian on the node grid, zero padded.
fn laplacian(g: &Grid, x: &[f64], out: &mut [f64]) {
    let [n0, n1, n2] = [g.m[0], g.m[1], g.m[2] + 1];
    let w = [
        1.0 / (g.h[0] * g.h[0]),
        1.0 / (g.h[1] * g.h[1]),
        1.0 / (g.h[2] * g.h[2]),
    ];
    let centre = 2.0 * (w[0] + w[1] + w[2]);
    for a in 0..n0 {
        for b in 0..n1 {
            for c in 0..n2 {
                let i = (a * n1 + b) * n2 + c;
                // conv3d sums the kernel taps in (depth, height, width) order.
                let mut s = 0.0;
                if a > 0 {
                    s += -w[0] * x[i - n1 * n2];
                }
                if b > 0 {
                    s += -w[1] * x[i - n2];
                }
                if c > 0 {
                    s += -w[2] * x[i - 1];
                }
                s += centre * x[i];
                if c + 1 < n2 {
                    s += -w[2] * x[i + 1];
                }
                if b + 1 < n1 {
                    s += -w[1] * x[i + n2];
                }
                if a + 1 < n0 {
                    s += -w[0] * x[i + n1 * n2];
                }
                out[i] = s;
            }
        }
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn norm(a: &[f64]) -> f64 {
    dot(a, a).sqrt()
}

/// torch.linspace(a, b, n): the first half steps up from a, the second half down from b.
fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![a];
    }
    let step = (b - a) / (n - 1) as f64;
    let half = n / 2;
    (0..n)
        .map(|i| {
            if i < half {
                a + step * i as f64
            } else {
                b - step * (n - 1 - i) as f64
            }
        })
        .collect()
}

/// `interp_parallel` for one row: piecewise-linear y(x) at xs, x increasing with x[last] ≥ xs.
fn interp_row(x: &[f64], y: &[f64], xs: &[f64], out: &mut [f64]) {
    let tail = &x[1..];
    for (o, &s) in out.iter_mut().zip(xs) {
        // torch.searchsorted (left) on x[1:]
        let i = tail.partition_point(|&v| v < s);
        let i = i.min(tail.len() - 1);
        let t = (s - x[i]) / (x[i + 1] - x[i]);
        *o = y[i] * (1.0 - t) + y[i + 1] * t;
    }
}

/// `InitializeOT.init_OT`: per PE line, the 1D optimal-transport map between the two
/// intensity profiles (Chang and Fitzpatrick), as a field on the nodes.
fn init_ot(g: &Grid, i1: &[f64], i2: &[f64], length: f64) -> Vec<f64> {
    let n = g.m[2];
    let t = linspace(0.0, 1.0, n + 1);
    let mut out = vec![0.0; g.nodes()];
    let cumulative = |row: &[f64]| {
        let shifted: Vec<f64> = row.iter().map(|v| v + 2.0).collect();
        let total: f64 = shifted.iter().sum();
        let mut c = vec![0.0; n + 1];
        let mut acc = 0.0;
        for (k, v) in shifted.iter().enumerate() {
            acc += v / total;
            c[k + 1] = acc;
        }
        c[n] = 1.0;
        c
    };
    let (mut ic0, mut ic1) = (vec![0.0; n + 1], vec![0.0; n + 1]);
    let (mut t0, mut t1) = (vec![0.0; n + 1], vec![0.0; n + 1]);
    let (mut s0, mut s1) = (vec![0.0; n + 1], vec![0.0; n + 1]);
    for r in 0..g.rows() {
        let c0 = cumulative(&i1[r * n..(r + 1) * n]);
        let c1 = cumulative(&i2[r * n..(r + 1) * n]);
        interp_row(&c0, &t, &t, &mut ic0);
        interp_row(&c1, &t, &t, &mut ic1);
        let ichf: Vec<f64> = ic0.iter().zip(&ic1).map(|(a, b)| (a + b) / 2.0).collect();
        interp_row(&t, &ichf, &c0, &mut t0);
        interp_row(&t, &ichf, &c1, &mut t1);
        // invert the mapping
        interp_row(&t0, &t, &t, &mut s0);
        interp_row(&t1, &t, &t, &mut s1);
        let o = &mut out[r * (n + 1)..(r + 1) * (n + 1)];
        for k in 0..=n {
            let a = -length * (s0[k] - t[k]);
            let b = -length * (s1[k] - t[k]);
            o[k] = -(0.5 * (a - b));
        }
    }
    out
}

/// `InitializeOT.blur`: `real(ifftn(fftn(b) / (eig + 1)))`, with `eig` the moduli of the
/// Laplacian stencil's periodic eigenvalues on the node grid (`FFT3D.compute_eigs`).
fn blur(g: &Grid, b: &[f64]) -> Vec<f64> {
    let dims = [g.m[0], g.m[1], g.m[2] + 1];
    let mut data: Vec<Complex<f64>> = b.iter().map(|&v| Complex::new(v, 0.0)).collect();
    fft3(&mut data, dims, false);
    let w = [
        1.0 / (g.h[0] * g.h[0]),
        1.0 / (g.h[1] * g.h[1]),
        1.0 / (g.h[2] * g.h[2]),
    ];
    let tau = std::f64::consts::TAU;
    let eig =
        |axis: usize, k: usize| 2.0 * w[axis] * (1.0 - (tau * k as f64 / dims[axis] as f64).cos());
    for a in 0..dims[0] {
        for c in 0..dims[1] {
            for d in 0..dims[2] {
                let e = (eig(0, a) + eig(1, c) + eig(2, d)).abs();
                data[(a * dims[1] + c) * dims[2] + d] /= e + 1.0;
            }
        }
    }
    fft3(&mut data, dims, true);
    let scale = 1.0 / (dims[0] * dims[1] * dims[2]) as f64;
    data.iter().map(|v| v.re * scale).collect()
}

/// An unnormalized 3D FFT, C order, in place.
fn fft3(data: &mut [Complex<f64>], dims: [usize; 3], inverse: bool) {
    let mut planner = FftPlanner::new();
    let mut line = Vec::new();
    for axis in 0..3 {
        let n = dims[axis];
        let fft = if inverse {
            planner.plan_fft_inverse(n)
        } else {
            planner.plan_fft_forward(n)
        };
        let stride: usize = dims[axis + 1..].iter().product();
        let outer: usize = dims[..axis].iter().product();
        line.resize(n, Complex::new(0.0, 0.0));
        for o in 0..outer {
            for s in 0..stride {
                let base = o * n * stride + s;
                for k in 0..n {
                    line[k] = data[base + k * stride];
                }
                fft.process(&mut line);
                for k in 0..n {
                    data[base + k * stride] = line[k];
                }
            }
        }
    }
}

/// The loss terms that one evaluation leaves behind for the Hessian.
struct Linearization {
    geom: Vec<f64>,
    intensity: Vec<f64>,
    d2g: Vec<f64>,
    /// `JacobiCG.getM`
    diag: Vec<f64>,
}

/// `EPIMRIDistortionCorrection` with `myAvg1D`, `myDiff1D`, `myLaplacian3D`, rho = 0 and `JacobiCG`.
struct Problem<'a> {
    g: Grid,
    i1: &'a [f64],
    i2: &'a [f64],
    xc: Vec<f64>,
    alpha: f64,
    beta: f64,
    avg: [f64; 2],
    diff: [f64; 2],
    corr1: Vec<f64>,
    corr2: Vec<f64>,
}

/// `Interp1D.eval` of one image at the points `x` (one per cell), with the derivative.
fn interp(g: &Grid, image: &[f64], x: &[f64], fi: &mut [f64], dfi: &mut [f64]) {
    let n = g.m[2];
    let last = (n - 1) as f64;
    for r in 0..g.rows() {
        let row = &image[r * n..(r + 1) * n];
        for i in 0..n {
            let k = r * n + i;
            let s = (x[k] / g.h[2] - 0.5).clamp(0.0, last);
            let p = s.floor();
            let f = s - p;
            let pl = p as usize;
            let pr = (pl + 1).min(n - 1);
            fi[k] = row[pl] * (1.0 - f) + row[pr] * f;
            dfi[k] = (row[pr] - row[pl]) / g.h[2];
        }
    }
}

/// `phi_EPI`: the barrier -x⁴/(x² − 1) and its derivatives. `nan_to_num` turns the
/// infinities that PyHySCO sets for |x| ≥ 1 into NaN and then 0, so those voxels add nothing.
fn phi(x: f64) -> (f64, f64, f64) {
    if x.abs() >= 1.0 {
        return (0.0, 0.0, 0.0);
    }
    let x2 = x * x;
    let q = x2 - 1.0;
    let g = -(x2 * x2) / q;
    let dg = -2.0 * (x * x2) * (x2 - 2.0) / (q * q);
    let d2g = -2.0 * x2 * (x2 * x2 - 3.0 * x2 + 6.0) / (q * q * q);
    (g, dg, d2g)
}

impl<'a> Problem<'a> {
    fn new(g: Grid, i1: &'a [f64], i2: &'a [f64], options: &Options) -> Self {
        let centres = cell_centres(&g);
        let xc = (0..g.rows())
            .flat_map(|_| centres.iter().copied())
            .collect();
        Self {
            g,
            i1,
            i2,
            xc,
            alpha: options.alpha,
            beta: options.beta,
            avg: [0.5, 0.5],
            diff: [-1.0 / g.h[2], 1.0 / g.h[2]],
            corr1: vec![0.0; g.cells()],
            corr2: vec![0.0; g.cells()],
        }
    }

    /// `eval`: the objective, and with `linearize` also its gradient and the Gauss-Newton terms.
    fn eval(&mut self, b: &[f64], linearize: bool) -> (f64, Option<(Vec<f64>, Linearization)>) {
        let g = self.g;
        let cells = g.cells();
        let hd = g.hd();
        let mut bc = vec![0.0; cells];
        let mut dbc = vec![0.0; cells];
        conv(&g, self.avg, b, &mut bc);
        conv(&g, self.diff, b, &mut dbc);
        let mut x1 = vec![0.0; cells];
        let mut x2 = vec![0.0; cells];
        for k in 0..cells {
            x1[k] = self.xc[k] + bc[k];
            x2[k] = self.xc[k] - bc[k];
        }
        let (mut fi1, mut dfi1) = (vec![0.0; cells], vec![0.0; cells]);
        let (mut fi2, mut dfi2) = (vec![0.0; cells], vec![0.0; cells]);
        interp(&g, self.i1, &x1, &mut fi1, &mut dfi1);
        interp(&g, self.i2, &x2, &mut fi2, &mut dfi2);
        let mut rc = vec![0.0; cells];
        let mut pc = 0.0;
        let mut dgv = vec![0.0; cells];
        let mut d2g = vec![0.0; cells];
        for k in 0..cells {
            let jac1 = 1.0 + dbc[k];
            let jac2 = 1.0 - dbc[k];
            self.corr1[k] = fi1[k] * jac1;
            self.corr2[k] = fi2[k] * jac2;
            rc[k] = self.corr1[k] - self.corr2[k];
            let (gk, dgk, d2gk) = phi(jac1 - 1.0);
            pc += gk;
            dgv[k] = dgk;
            d2g[k] = d2gk;
        }
        let dc = 0.5 * hd * dot(&rc, &rc);
        let mut lb = vec![0.0; g.nodes()];
        laplacian(&g, b, &mut lb);
        let sc = 0.5 * dot(b, &lb);
        let jc = dc + hd * self.alpha * sc + hd * self.beta * pc;
        if !linearize {
            return (jc, None);
        }
        let mut geom = vec![0.0; cells];
        let mut intensity = vec![0.0; cells];
        let mut t1 = vec![0.0; cells];
        let mut t2 = vec![0.0; cells];
        for k in 0..cells {
            geom[k] = fi1[k] + fi2[k];
            intensity[k] = (1.0 + dbc[k]) * dfi1[k] + (1.0 - dbc[k]) * dfi2[k];
            let ddc = rc[k] * hd;
            t1[k] = ddc * geom[k];
            t2[k] = ddc * intensity[k];
        }
        let nodes = g.nodes();
        let mut dd = vec![0.0; nodes];
        let mut tmp = vec![0.0; nodes];
        conv_t(&g, self.diff, &t1, &mut dd);
        conv_t(&g, self.avg, &t2, &mut tmp);
        let mut dp = vec![0.0; nodes];
        conv_t(&g, self.diff, &dgv, &mut dp);
        let mut dj = vec![0.0; nodes];
        for j in 0..nodes {
            dj[j] = (dd[j] + tmp[j]) + hd * self.alpha * lb[j] + hd * self.beta * dp[j];
        }
        // JacobiCG.getM: the diagonal of the Gauss-Newton Hessian.
        let ad = [self.avg[0] * self.diff[0], self.avg[1] * self.diff[1]];
        let d2 = [self.diff[0] * self.diff[0], self.diff[1] * self.diff[1]];
        let a2 = [self.avg[0] * self.avg[0], self.avg[1] * self.avg[1]];
        let w = [
            1.0 / (g.h[0] * g.h[0]),
            1.0 / (g.h[1] * g.h[1]),
            1.0 / (g.h[2] * g.h[2]),
        ];
        let centre = 2.0 * (w[0] + w[1] + w[2]);
        let gi: Vec<f64> = (0..cells).map(|k| geom[k] * intensity[k]).collect();
        let ii: Vec<f64> = intensity.iter().map(|v| v * v).collect();
        let gg: Vec<f64> = geom.iter().map(|v| v * v).collect();
        let (mut p1, mut p2, mut p3, mut p4) = (
            vec![0.0; nodes],
            vec![0.0; nodes],
            vec![0.0; nodes],
            vec![0.0; nodes],
        );
        conv_t(&g, ad, &gi, &mut p1);
        conv_t(&g, a2, &ii, &mut p2);
        conv_t(&g, d2, &gg, &mut p3);
        conv_t(&g, d2, &d2g, &mut p4);
        let diag = (0..nodes)
            .map(|j| {
                let diag_d = 2.0 * p1[j] + p2[j] + p3[j];
                hd * diag_d + hd * self.beta * p4[j] + hd * self.alpha * centre
            })
            .collect();
        let lin = Linearization {
            geom,
            intensity,
            d2g,
            diag,
        };
        (jc, Some((dj, lin)))
    }

    /// `H(x)`: the Gauss-Newton Hessian times x.
    fn hessian(&self, lin: &Linearization, x: &[f64], out: &mut [f64]) {
        let g = self.g;
        let cells = g.cells();
        let hd = g.hd();
        let mut dx = vec![0.0; cells];
        let mut ax = vec![0.0; cells];
        conv(&g, self.diff, x, &mut dx);
        conv(&g, self.avg, x, &mut ax);
        let mut u = vec![0.0; cells];
        let mut v = vec![0.0; cells];
        for k in 0..cells {
            let dr = lin.geom[k] * dx[k] + lin.intensity[k] * ax[k];
            let drd = dr * hd;
            u[k] = drd * lin.geom[k] + hd * self.beta * lin.d2g[k] * dx[k];
            v[k] = drd * lin.intensity[k];
        }
        let nodes = g.nodes();
        let mut a = vec![0.0; nodes];
        let mut c = vec![0.0; nodes];
        let mut l = vec![0.0; nodes];
        conv_t(&g, self.diff, &u, &mut a);
        conv_t(&g, self.avg, &v, &mut c);
        laplacian(&g, x, &mut l);
        for j in 0..nodes {
            out[j] = (a[j] + c[j]) + hd * self.alpha * l[j];
        }
    }
}

/// `PCG(max_iter=10, tol=0.1)` from x = 0, Jacobi preconditioned. Returns the last iterate.
fn pcg(problem: &Problem, lin: &Linearization, b: &[f64]) -> Vec<f64> {
    let n = b.len();
    let mut x = vec![0.0; n];
    let mut r = b.to_vec();
    let mut z: Vec<f64> = r.iter().zip(&lin.diag).map(|(r, m)| r / m).collect();
    let mut p = z.clone();
    let res0 = norm(&r);
    let mut ap = vec![0.0; n];
    for _ in 0..10 {
        problem.hessian(lin, &p, &mut ap);
        let gamma = dot(&r, &z);
        let curv = dot(&p, &ap);
        let alpha = gamma / curv;
        if alpha == f64::INFINITY || alpha.is_nan() || alpha < 0.0 {
            break;
        }
        for k in 0..n {
            x[k] += alpha * p[k];
            r[k] += -alpha * ap[k];
        }
        if norm(&r) / res0 < 0.1 {
            break;
        }
        z = r.iter().zip(&lin.diag).map(|(r, m)| r / m).collect();
        let beta = dot(&z, &r) / gamma;
        for k in 0..n {
            p[k] = z[k] + beta * p[k];
        }
    }
    x
}

/// Runs PyHySCO on two permuted images that are already normalized: `InitializeOT` with the
/// blur, then Gauss-Newton on the CPU.
pub fn solve(g: Grid, i1: &[f64], i2: &[f64], options: &Options) -> Solution {
    let b0 = blur(&g, &init_ot(&g, i1, i2, g.length()));
    gauss_newton(g, i1, i2, b0, options)
}

/// The initial field: `InitializeOT.init_OT`, then the blur.
pub fn initialize(g: Grid, i1: &[f64], i2: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let cf = init_ot(&g, i1, i2, g.length());
    let b0 = blur(&g, &cf);
    (cf, b0)
}

/// The cell centres along the PE axis (`xc` of `EPIMRIDistortionCorrection`), in mm.
pub fn cell_centres(g: &Grid) -> Vec<f64> {
    linspace(g.h[2] / 2.0, g.length() - g.h[2] / 2.0, g.m[2])
}

/// What the Gauss-Newton loop needs from a device: the objective with its linearization, and
/// the Jacobi-preconditioned CG solve with the Hessian of the last linearization.
pub trait Backend {
    /// `eval`: the objective at `b`, and with `linearize` also its gradient. A linearizing
    /// evaluation replaces the Hessian that [`Backend::pcg`] uses.
    fn eval(&mut self, b: &[f64], linearize: bool) -> (f64, Option<Vec<f64>>);
    /// `PCG(max_iter=10, tol=0.1)` from x = 0 for the right-hand side `rhs`.
    fn pcg(&mut self, rhs: &[f64]) -> Vec<f64>;
    /// The two corrected images of the last evaluation.
    fn corrected(self) -> (Vec<f64>, Vec<f64>);
}

/// The CPU backend: the port's own `eval`, `H(x)` and `PCG` in float64.
pub struct Cpu<'a> {
    problem: Problem<'a>,
    lin: Option<Linearization>,
}

impl<'a> Cpu<'a> {
    pub fn new(g: Grid, i1: &'a [f64], i2: &'a [f64], options: &Options) -> Self {
        Self {
            problem: Problem::new(g, i1, i2, options),
            lin: None,
        }
    }
}

impl Backend for Cpu<'_> {
    fn eval(&mut self, b: &[f64], linearize: bool) -> (f64, Option<Vec<f64>>) {
        let (j, l) = self.problem.eval(b, linearize);
        match l {
            Some((dj, lin)) => {
                self.lin = Some(lin);
                (j, Some(dj))
            }
            None => (j, None),
        }
    }
    fn pcg(&mut self, rhs: &[f64]) -> Vec<f64> {
        let lin = self
            .lin
            .as_ref()
            .expect("pcg needs a linearizing eval first");
        pcg(&self.problem, lin, rhs)
    }
    fn corrected(self) -> (Vec<f64>, Vec<f64>) {
        (self.problem.corr1, self.problem.corr2)
    }
}

/// `GaussNewton.run_correction` on the CPU.
pub fn gauss_newton(g: Grid, i1: &[f64], i2: &[f64], b0: Vec<f64>, options: &Options) -> Solution {
    gauss_newton_with(Cpu::new(g, i1, i2, options), b0, options)
}

/// `GaussNewton.run_correction` with the Armijo line search (25 halvings, reduction 1e-6), on
/// any backend. The control flow and the stopping rules run here, in float64, for every device.
pub fn gauss_newton_with<B: Backend>(mut backend: B, b0: Vec<f64>, options: &Options) -> Solution {
    let (tol_g, tol_j, tol_y) = (1e-4, 1e-3, 1e-2);
    let mut bc = b0.clone();
    let (mut jc, grad) = backend.eval(&bc, true);
    let mut dj = grad.expect("a linearizing eval returns the gradient");
    let jstop = jc.abs();
    let b0_norm = norm(&b0);
    let mut loss = vec![jc];
    for i in 1..=options.max_iter {
        let rhs: Vec<f64> = dj.iter().map(|v| -1.0 * v).collect();
        let mut dy = backend.pcg(&rhs);
        // Armijo
        // PyHySCO flips a direction that ascends but keeps the positive `descent` value.
        let descent = dot(&dj, &dy);
        if descent > 0.0 {
            dy.iter_mut().for_each(|v| *v = -*v);
        }
        let mut t = 1.0;
        let mut accepted = None;
        for _ in 0..25 {
            let yt: Vec<f64> = bc.iter().zip(&dy).map(|(y, d)| y + t * d).collect();
            let (jt, _) = backend.eval(&yt, false);
            if jt < jc + t * 1e-6 * descent {
                accepted = Some(yt);
                break;
            }
            t /= 2.0;
        }
        let Some(yt) = accepted else {
            break;
        };
        let change: Vec<f64> = bc.iter().zip(&yt).map(|(a, b)| a - b).collect();
        let stop_fmap_change = i > 1 && norm(&change) <= tol_y * (1.0 + b0_norm);
        bc = yt;
        let (j, d) = backend.eval(&bc, true);
        jc = j;
        dj = d.expect("a linearizing eval returns the gradient");
        let previous = *loss.last().unwrap();
        loss.push(jc);
        let grad = norm(&dj);
        let stop_grad = grad <= tol_g;
        let stop_func_change = i > 1 && (jc - previous).abs() <= tol_j * (1.0 + jstop);
        let stop_grad_relative = grad <= tol_g * (1.0 + jstop);
        if stop_grad || stop_grad_relative || stop_func_change || stop_fmap_change {
            break;
        }
    }
    let (corr1, corr2) = backend.corrected();
    Solution {
        b: bc,
        corr1,
        corr2,
        loss,
    }
}

/// The objective and its gradient at `b`, for parity checks against PyHySCO's `eval`.
pub fn objective(g: Grid, i1: &[f64], i2: &[f64], b: &[f64], options: &Options) -> (f64, Vec<f64>) {
    let mut problem = Problem::new(g, i1, i2, options);
    let (j, lin) = problem.eval(b, true);
    (j, lin.unwrap().0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bumps(g: &Grid, shift: f64) -> Vec<f64> {
        let mut out = vec![0.0; g.cells()];
        for a in 0..g.m[0] {
            for b in 0..g.m[1] {
                for c in 0..g.m[2] {
                    let y = (c as f64 + 0.5) * g.h[2] - shift;
                    let centre = 0.5 * g.extent[2] + 2.0 * (b as f64 - 4.0).sin() + a as f64;
                    out[(a * g.m[1] + b) * g.m[2] + c] =
                        100.0 * (-((y - centre) / 6.0).powi(2)).exp() + 5.0;
                }
            }
        }
        out
    }

    #[test]
    fn gradient_matches_finite_differences() {
        let g = Grid::new([3, 5, 12], [2.0, 2.0, 2.5]);
        let (mut i1, mut i2) = (bumps(&g, 1.5), bumps(&g, -1.5));
        normalize(&mut i1, &mut i2);
        let b: Vec<f64> = (0..g.nodes())
            .map(|k| 0.3 * ((k as f64) * 0.37).sin())
            .collect();
        let options = Options::default();
        let (_, dj) = objective(g, &i1, &i2, &b, &options);
        let mut problem = Problem::new(g, &i1, &i2, &options);
        // Interior nodes: at the line ends PyHySCO's interpolation clamps and its derivative
        // is not the derivative of the clamped image.
        let n = g.m[2] + 1;
        for k in [6, n + 4, 7 * n + 8, 14 * n + 6] {
            let eps = 1e-6;
            let (mut up, mut down) = (b.clone(), b.clone());
            up[k] += eps;
            down[k] -= eps;
            let fd = (problem.eval(&up, false).0 - problem.eval(&down, false).0) / (2.0 * eps);
            assert!(
                (fd - dj[k]).abs() <= 1e-5 * fd.abs().max(1.0),
                "node {k}: {fd} vs {}",
                dj[k]
            );
        }
    }

    #[test]
    fn hessian_is_symmetric() {
        let g = Grid::new([3, 4, 10], [2.0, 2.0, 2.0]);
        let (mut i1, mut i2) = (bumps(&g, 1.0), bumps(&g, -1.0));
        normalize(&mut i1, &mut i2);
        let options = Options::default();
        let mut problem = Problem::new(g, &i1, &i2, &options);
        let b = vec![0.1; g.nodes()];
        let lin = problem.eval(&b, true).1.unwrap().1;
        let x: Vec<f64> = (0..g.nodes()).map(|k| (k as f64 * 0.7).cos()).collect();
        let y: Vec<f64> = (0..g.nodes()).map(|k| (k as f64 * 1.3).sin()).collect();
        let (mut hx, mut hy) = (vec![0.0; g.nodes()], vec![0.0; g.nodes()]);
        problem.hessian(&lin, &x, &mut hx);
        problem.hessian(&lin, &y, &mut hy);
        let (a, b) = (dot(&y, &hx), dot(&x, &hy));
        assert!((a - b).abs() <= 1e-10 * a.abs(), "{a} vs {b}");
    }

    #[test]
    fn a_constant_shift_is_recovered() {
        let g = Grid::new([4, 8, 40], [2.0, 2.0, 2.0]);
        let shift = 3.0;
        let (mut i1, mut i2) = (bumps(&g, shift), bumps(&g, -shift));
        normalize(&mut i1, &mut i2);
        let solution = solve(g, &i1, &i2, &Options::default());
        let n = g.m[2] + 1;
        let mut middle: Vec<f64> = (0..g.rows()).map(|r| solution.b[r * n + n / 2]).collect();
        middle.sort_by(f64::total_cmp);
        let median = middle[middle.len() / 2];
        assert!(
            (median - shift).abs() < 0.3,
            "median field {median} mm, expected {shift}"
        );
        assert!(solution.loss.last().unwrap() < &solution.loss[0]);
    }
}
