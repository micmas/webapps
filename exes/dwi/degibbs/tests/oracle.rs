// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of
// the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Compares the port with MRtrix 3.0.8 `mrdegibbs -nshifts 20 -minW 1 -maxW 3 -axes 0,1` on the
//! OpenNeuro ds005577 sub-107 AP slab (120 × 120 × 8 × 101, int16, full Fourier). DEGIBBS_ORACLE
//! names the dataset's `degibbs/validation` directory; the input is read from `../examples` next to
//! it. Without DEGIBBS_ORACLE the test is skipped, or fails when DWI_REQUIRE_ORACLE=1 (CI).
//! `validation/fetch_oracle.py` fetches the pinned files (Hugging Face neurodeskorg/webapps commit
//! d950cc4c, issue #432).

use std::io::Read;
use std::path::{Path, PathBuf};

const ORACLE: &str = "sub-107_dir-AP_desc-mrdegibbs_dwi.nii.gz";
const INPUT: &str = "../examples/sub-107_dir-AP_desc-slab_dwi.nii.gz";
const DIMS: [usize; 4] = [120, 120, 8, 101];

struct Nifti {
    dims: [usize; 4],
    sform: Vec<u8>,
    data: Vec<f64>,
}

fn i16_at(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}

fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// A little-endian NIfTI-1 `.nii.gz` with int16 or float32 voxels.
fn read_nifti(path: &Path) -> Nifti {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(
        i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        348
    );
    let ndim = i16_at(&bytes, 40) as usize;
    let mut dims = [1usize; 4];
    for (d, dim) in dims.iter_mut().enumerate().take(ndim.min(4)) {
        *dim = i16_at(&bytes, 42 + 2 * d) as usize;
    }
    let offset = (f32_at(&bytes, 108) as usize).max(352);
    let (slope, inter) = (f32_at(&bytes, 112), f32_at(&bytes, 116));
    let count: usize = dims.iter().product();
    let raw = &bytes[offset..];
    let data: Vec<f64> = match i16_at(&bytes, 70) {
        4 => raw
            .chunks_exact(2)
            .take(count)
            .map(|c| f64::from(i16::from_le_bytes([c[0], c[1]])))
            .collect(),
        16 => raw
            .chunks_exact(4)
            .take(count)
            .map(|c| f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]])))
            .collect(),
        other => panic!("unsupported NIfTI datatype {other}"),
    };
    assert_eq!(data.len(), count);
    let data = if slope != 0.0 && slope.is_finite() && (slope != 1.0 || inter != 0.0) {
        data.iter()
            .map(|v| v * f64::from(slope) + f64::from(inter))
            .collect()
    } else {
        data
    };
    Nifti {
        dims,
        sform: bytes[280..328].to_vec(),
        data,
    }
}

#[test]
fn matches_mrtrix_mrdegibbs_on_the_ds005577_slab() {
    let Ok(dir) = std::env::var("DEGIBBS_ORACLE") else {
        assert!(
            std::env::var("DWI_REQUIRE_ORACLE").as_deref() != Ok("1"),
            "DWI_REQUIRE_ORACLE=1 but DEGIBBS_ORACLE is not set"
        );
        eprintln!("DEGIBBS_ORACLE is not set; skipping");
        return;
    };
    let dir = PathBuf::from(dir);
    let input = read_nifti(&dir.join(INPUT));
    let oracle = read_nifti(&dir.join(ORACLE));
    assert_eq!(input.dims, DIMS);
    assert_eq!(oracle.dims, DIMS);
    // mrdegibbs keeps the transform and the voxel order, so the two grids are the same.
    assert_eq!(input.sform, oracle.sform);

    let start = std::time::Instant::now();
    let data: Vec<f32> = input.data.iter().map(|&v| v as f32).collect();
    let ours = dwi_degibbs::unring_volume(
        &data,
        [DIMS[0], DIMS[1], DIMS[2]],
        DIMS[3],
        [0, 1],
        dwi_degibbs::Options::default(),
    );
    eprintln!("{} slices in {:?}", DIMS[2] * DIMS[3], start.elapsed());

    let (mut err, mut norm, mut worst, mut differ) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    for (&got, &want) in ours.iter().zip(&oracle.data) {
        let d = f64::from(got) - want;
        err += d * d;
        norm += want * want;
        worst = worst.max(d.abs());
        if f64::from(got) != want {
            differ += 1;
        }
    }
    let nrmse = (err / norm).sqrt();
    let max = oracle.data.iter().copied().fold(f64::MIN, f64::max);
    eprintln!(
        "NRMSE {nrmse:.3e}, max |port - mrdegibbs| {worst:.3e} (oracle max {max:.1}), \
         {differ} of {} voxels differ",
        ours.len()
    );
    // Measured on x86-64 (Rust 1.98.0, rustfft 6.4.1): NRMSE 5.3e-20, 2 of 11635200 voxels differ,
    // both background values below 3e-14 (max difference 1.6e-14). The issue's starting gate was
    // NRMSE < 1 %; these gates leave room for another FFT kernel's rounding only.
    assert!(nrmse < 1e-15, "NRMSE {nrmse:.3e} is not below 1e-15");
    assert!(
        worst < 1e-10,
        "max difference {worst:.3e} is not below 1e-10"
    );
}
