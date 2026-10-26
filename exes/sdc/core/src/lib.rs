//! Reverse phase-encoding susceptibility distortion correction for the `sdc` app.
//!
//! `hysco` is the PyHySCO solver. This module holds what every solver shares: the permutation
//! that puts the phase-encoding axis last, and the conversion of a solver's field to Hz.

pub mod hysco;

/// The order in which `load_data` permutes NIfTI axes (i, j, k): slice axis k first, the other
/// in-plane axis second, the phase-encoding axis `pe` (0 for i, 1 for j) last.
pub fn permutation(pe: usize) -> Result<[usize; 3], String> {
    match pe {
        0 => Ok([2, 1, 0]),
        1 => Ok([2, 0, 1]),
        _ => Err("PyHySCO needs the phase-encoding direction along i or j".into()),
    }
}

/// Copies a NIfTI-order volume (i fastest) into C order over the permuted axes `perm`.
pub fn permute(data: &[f64], dims: [usize; 3], perm: [usize; 3]) -> Vec<f64> {
    let m = perm.map(|a| dims[a]);
    let mut out = vec![0.0; data.len()];
    let stride = [1, dims[0], dims[0] * dims[1]];
    let s = perm.map(|a| stride[a]);
    let mut o = 0;
    for a in 0..m[0] {
        for b in 0..m[1] {
            for c in 0..m[2] {
                out[o] = data[a * s[0] + b * s[1] + c * s[2]];
                o += 1;
            }
        }
    }
    out
}

/// The inverse of [`permute`] for an array of shape `m` in C order.
pub fn unpermute(data: &[f64], m: [usize; 3], perm: [usize; 3]) -> Vec<f64> {
    let mut dims = [0; 3];
    for (k, &a) in perm.iter().enumerate() {
        dims[a] = m[k];
    }
    let stride = [1, dims[0], dims[0] * dims[1]];
    let s = perm.map(|a| stride[a]);
    let mut out = vec![0.0; data.len()];
    let mut o = 0;
    for a in 0..m[0] {
        for b in 0..m[1] {
            for c in 0..m[2] {
                out[a * s[0] + b * s[1] + c * s[2]] = data[o];
                o += 1;
            }
        }
    }
    out
}

/// Inputs to a run: two volumes in NIfTI order with opposite phase-encoding directions.
pub struct Pair<'a> {
    pub image1: &'a [f64],
    pub image2: &'a [f64],
    pub dims: [usize; 3],
    /// Voxel sizes in mm: the lengths of the affine's columns, as nibabel gives them.
    pub voxel: [f64; 3],
    /// The phase-encoding axis (0 for i, 1 for j).
    pub pe: usize,
    /// +1 when image 1's phase-encoding direction is positive ("j"), -1 when negative ("j-").
    pub pe_sign: f64,
    /// TotalReadoutTime of image 1, in seconds.
    pub total_readout_time: f64,
}

/// Outputs in NIfTI order on the image grid.
pub struct Correction {
    /// The field in Hz with topup's sign convention: image 1 corrected is image1(x + u(x)) with
    /// u = field · TotalReadoutTime · pe_sign voxels along the phase-encoding axis.
    pub field_hz: Vec<f64>,
    /// The two corrected images (PyHySCO's normalized intensities), for quality control.
    pub corrected1: Vec<f64>,
    pub corrected2: Vec<f64>,
    /// The objective at the start and after each Gauss-Newton iteration.
    pub loss: Vec<f64>,
}

/// Runs PyHySCO with its command-line defaults and converts its field to Hz.
pub fn pyhysco(pair: &Pair, options: &hysco::Options) -> Result<Correction, String> {
    pyhysco_with(pair, options, hysco::solve)
}

/// [`pyhysco`] with another solver for the permuted, normalized images, for example
/// `hysco::initialize` followed by `hysco::gauss_newton_with` on a GPU backend. The input
/// checks, the permutation and the conversion to Hz stay the same for every solver.
pub fn pyhysco_with<F>(
    pair: &Pair,
    options: &hysco::Options,
    solver: F,
) -> Result<Correction, String>
where
    F: FnOnce(hysco::Grid, &[f64], &[f64], &hysco::Options) -> hysco::Solution,
{
    let n = pair.dims.iter().product::<usize>();
    if pair.image1.len() != n || pair.image2.len() != n {
        return Err(format!("expected {n} voxels in each image"));
    }
    if !pair.total_readout_time.is_finite() || pair.total_readout_time <= 0.0 {
        return Err("TotalReadoutTime must be positive".into());
    }
    if pair.pe_sign.abs() != 1.0 {
        return Err("the phase-encoding sign must be +1 or -1".into());
    }
    if pair.voxel.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return Err("voxel sizes must be positive".into());
    }
    let perm = permutation(pair.pe)?;
    let m = perm.map(|a| pair.dims[a]);
    if m.iter().any(|&k| k < 3) {
        return Err("each image axis needs at least 3 voxels".into());
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &value in pair.image1.iter().chain(pair.image2.iter()) {
        if !value.is_finite() {
            return Err("images must contain only finite intensities".into());
        }
        min = min.min(value);
        max = max.max(value);
    }
    let range = max - min;
    if range <= 0.0 || !range.is_finite() || !(256.0 / range).is_finite() {
        return Err("images need a finite, nonzero common intensity range".into());
    }
    let grid = hysco::Grid::new(m, perm.map(|a| pair.voxel[a]));
    let mut i1 = permute(pair.image1, pair.dims, perm);
    let mut i2 = permute(pair.image2, pair.dims, perm);
    hysco::normalize(&mut i1, &mut i2);
    let solution = solver(grid, &i1, &i2, options);
    // Staggered nodes to cell centres, mm to voxels, voxels to Hz.
    let rows = m[0] * m[1];
    let mut cells = vec![0.0; n];
    let scale = 1.0 / (grid.h[2] * pair.total_readout_time * pair.pe_sign);
    for r in 0..rows {
        for i in 0..m[2] {
            let b = &solution.b[r * (m[2] + 1)..];
            cells[r * m[2] + i] = 0.5 * (b[i] + b[i + 1]) * scale;
        }
    }
    Ok(Correction {
        field_hz: unpermute(&cells, m, perm),
        corrected1: unpermute(&solution.corr1, m, perm),
        corrected2: unpermute(&solution.corr2, m, perm),
        loss: solution.loss,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permute_round_trips() {
        let dims = [4, 3, 2];
        let data: Vec<f64> = (0..24).map(f64::from).collect();
        for pe in [0, 1] {
            let perm = permutation(pe).unwrap();
            let p = permute(&data, dims, perm);
            assert_eq!(unpermute(&p, perm.map(|a| dims[a]), perm), data);
            // The PE axis runs fastest after the permutation.
            assert_eq!(p[1] - p[0], if pe == 0 { 1.0 } else { 4.0 });
        }
        assert!(permutation(2).is_err());
    }

    #[test]
    fn invalid_pairs_are_refused() {
        let image = vec![1.0; 27];
        let pair = |trt: f64, sign: f64| Pair {
            image1: &image,
            image2: &image,
            dims: [3, 3, 3],
            voxel: [2.0; 3],
            pe: 1,
            pe_sign: sign,
            total_readout_time: trt,
        };
        let options = hysco::Options::default();
        assert!(pyhysco(&pair(0.0, 1.0), &options).is_err());
        assert!(pyhysco(&pair(f64::NAN, 1.0), &options).is_err());
        assert!(pyhysco(&pair(0.04, 0.5), &options).is_err());
    }

    #[test]
    fn nonfinite_and_zero_range_images_are_refused() {
        let image: Vec<f64> = (0..27).map(f64::from).collect();
        let options = hysco::Options::default();
        fn pair<'a>(first: &'a [f64], second: &'a [f64]) -> Pair<'a> {
            Pair {
                image1: first,
                image2: second,
                dims: [3, 3, 3],
                voxel: [2.0; 3],
                pe: 1,
                pe_sign: 1.0,
                total_readout_time: 0.05,
            }
        }
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut corrupted = image.clone();
            corrupted[13] = invalid;
            for inputs in [pair(&corrupted, &image), pair(&image, &corrupted)] {
                assert_eq!(
                    pyhysco(&inputs, &options).err().as_deref(),
                    Some("images must contain only finite intensities")
                );
            }
        }
        for value in [0.0, 1.0] {
            let constant = vec![value; 27];
            assert_eq!(
                pyhysco(&pair(&constant, &constant), &options)
                    .err()
                    .as_deref(),
                Some("images need a finite, nonzero common intensity range")
            );
        }
    }
}
