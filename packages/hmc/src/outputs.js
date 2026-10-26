// BIDS-derivative names and the sidecar of the head-motion correction outputs, in the form of
// the other DWI apps (`<source entities>_desc-<step>_<suffix>`), from their shared module.
// Two rules are hmc's own: a path keeps only its file name, and a name without a suffix is a dwi.

import {
  derivativeSidecar as stepSidecar,
  outputNames as stepNames,
  splitName as splitBaseName,
  sourceStem,
} from "@neurodesk/webapp-components/file-io/bids-derivatives";

export { sidecarText } from "@neurodesk/webapp-components/file-io/bids-derivatives";

/** The registration and resampling this package runs, for the sidecar. */
export const SOFTWARE = Object.freeze({
  registration: "ANTs antsRegistration 52bc0ab (2.6.2) --float 1, WebAssembly (@neurodesk/hmc-registration)",
  resampling: "ANTs 52bc0ab antsApplyTransforms-style --apply, WebAssembly (@neurodesk/hmc-registration)",
});

/** The interpolator of the one resampling: cubic B-spline, the nearest to NiFreeze's SciPy order-3 spline. */
export const INTERPOLATION = "BSpline";

const METHOD_DESCRIPTIONS = Object.freeze({
  nifreeze: "NiFreeze 3bcfb00 rules (b0 volumes b <= 50 not registered; b-vectors rotated by inv(A) inv(M) A, %.6f)",
  shoreline: "QSIPrep 26.1.1 SHORELine rules (b0 volumes b < 100; b-vectors rotated by the inverse affine, renormalised, %.8f)",
});

/** Splits "sub-01_dwi.nii.gz" into ["sub-01", "dwi"]; a name without a suffix gives [name, ""]. */
export function splitName(fileName) {
  return splitBaseName(baseName(fileName));
}

function baseName(fileName) {
  return String(fileName).replace(/^.*\//, "");
}

/**
 * The derivative names of one corrected series. `transform(volume)` is the ITK .mat of a
 * volume (0-based index, four digits): `<source>_vol-0003_desc-hmc_xfm.mat`.
 */
export function outputNames(fileName) {
  const base = baseName(fileName);
  const source = sourceStem(base);
  return {
    ...stepNames(base, "hmc", { defaultSuffix: "dwi" }),
    motion: `${source}_desc-hmc_motion.tsv`,
    transform: (volume) => `${source}_vol-${String(volume).padStart(4, "0")}_desc-hmc_xfm.mat`,
  };
}

/**
 * The sidecar of the corrected series: the input's, with the step recorded. It holds no time
 * or host, so two runs on the same input write the same bytes.
 */
export function derivativeSidecar(sidecar, { method, interpolation = INTERPOLATION, registered, volumes }) {
  return {
    ...stepSidecar(sidecar, "Head-motion correction: one rigid or affine ITK transform per volume, applied in one resampling; b0 volumes kept"),
    HeadMotionCorrection: {
      Method: METHOD_DESCRIPTIONS[method] ?? method,
      Registration: SOFTWARE.registration,
      Resampling: `${SOFTWARE.resampling}, ${interpolation}`,
      Volumes: volumes,
      RegisteredVolumes: registered,
    },
  };
}
