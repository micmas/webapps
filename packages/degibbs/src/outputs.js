// The BIDS-derivative names and the sidecar of the degibbs outputs, shared by the web app and the
// command line so both write the same files. The naming rules are the DWI apps' shared module.

import { derivativeSidecar as stepSidecar, outputNames as stepNames } from "@neurodesk/webapp-components/file-io/bids-derivatives";

export { splitName } from "@neurodesk/webapp-components/file-io/bids-derivatives";

/** The derivative name of the corrected image and of its passed-through gradient files. */
export function outputNames(fileName) {
  return stepNames(fileName, "degibbs");
}

/** The sidecar of a corrected image: the input's, with the step recorded as BIDS derivatives do. */
export function derivativeSidecar(sidecar) {
  return stepSidecar(sidecar, "Gibbs-ringing removal by local subvoxel shifts (MRtrix mrdegibbs 3.0.8 port)");
}
