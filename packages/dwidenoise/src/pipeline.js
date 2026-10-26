// DOM-free steps of the dwidenoise workflow, shared by the web app and the command line: voxel
// chunks and BIDS derivative names. The naming rules are the DWI apps' shared module.

import { derivativeSidecar as stepSidecar, outputNames as stepNames } from "@neurodesk/webapp-components/file-io/bids-derivatives";

export { splitName } from "@neurodesk/webapp-components/file-io/bids-derivatives";

/** The derivative name of the denoised image and of its passed-through gradient files. */
export function outputNames(fileName) {
  return stepNames(fileName, "denoised");
}

/** The sidecar of a denoised image: the input's, with the step recorded as BIDS derivatives do. */
export function derivativeSidecar(sidecar) {
  return stepSidecar(sidecar, "Patch2Self denoising (DIPY 1.12.1 version 1 port, patch radius 0, OLS)");
}

/** Splits nvox voxels into ranges of at most `size` voxels: [[first, count], …]. */
export function voxelRanges(nvox, size) {
  const ranges = [];
  for (let first = 0; first < nvox; first += size) ranges.push([first, Math.min(size, nvox - first)]);
  return ranges;
}

/** Copies voxels first..first + count of every volume into one volume-major chunk. */
export function gatherChunk(data, nvox, frames, first, count) {
  const chunk = new Float32Array(count * frames);
  for (let t = 0; t < frames; t++) chunk.set(data.subarray(t * nvox + first, t * nvox + first + count), t * count);
  return chunk;
}

/** Writes a chunk from gatherChunk back to voxels first..first + count of every volume. */
export function scatterChunk(out, chunk, nvox, frames, first, count) {
  for (let t = 0; t < frames; t++) out.set(chunk.subarray(t * count, (t + 1) * count), t * nvox + first);
}
