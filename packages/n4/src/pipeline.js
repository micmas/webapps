// DOM-free steps of the n4 workflow: its BIDS derivative names and sidecar, from the DWI apps'
// shared module. The web app and the n4 command line both import them, so both write the same
// files. The b0 selection is dwi2trx's rule (./gradients.js) and the mean b0 the shared meanVolumes.

import { derivativeSidecar, maskName, outputNames as stepNames, sourceStem } from "@neurodesk/webapp-components/file-io/bids-derivatives";

export { b0Volumes, parseBval } from "./gradients.js";

/** The method the provenance of both the app and the command line records. */
export const METHOD = "ants-n4-2.6.2-wasm";

/** The step the sidecar of a corrected image records as its Description. */
export const DESCRIPTION = "Bias-field correction with ANTs N4 (MRtrix dwibiascorrect ants procedure)";

/** The sidecar of a corrected image: the input's, with the step recorded as BIDS derivatives do. */
export function n4Sidecar(sidecar) {
  return derivativeSidecar(sidecar, DESCRIPTION);
}

/** Derivative names for the corrected image, the bias field, the mask and passed-through files. */
export function outputNames(fileName) {
  const stem = sourceStem(fileName);
  const { image, bval, bvec, sidecar } = stepNames(fileName, "n4");
  return { image, bias: `${stem}_desc-n4_biasfield.nii.gz`, mask: maskName(stem), bval, bvec, sidecar };
}
