// The brain mask a user gives the DWI apps (noddi, n4) in place of MindGrab's: decoded, checked
// against the image grid and binarised. DOM-free, so the command lines read masks the same way.

import { decodeNiftiBuffer, readNiftiFrames, sameNiftiGrid } from "./NiftiUtils.js";

/** One byte per voxel: 1 where the value is above 0, else 0. */
export function binaryMask(data) {
  return Uint8Array.from(data, (value) => (value > 0 ? 1 : 0));
}

/**
 * Reads a brain mask for an image. Refuses a mask on another grid and a mask with more than one
 * volume. `name` names the mask and `grid` the image in the messages ("not on the DWI grid").
 * @param bytes the mask file, NIfTI-1, gzip or not
 * @param reference the decoded NIfTI of the image
 * @returns {Promise<Uint8Array>} the binary mask
 */
export async function readBrainMask(bytes, reference, { name = "The mask", grid = "image", signal } = {}) {
  const buffer = await decodeNiftiBuffer(bytes);
  signal?.throwIfAborted();
  if (!sameNiftiGrid(buffer, reference)) throw new Error(`${name} is not on the ${grid} grid.`);
  const volume = readNiftiFrames(buffer);
  if (volume.frames !== 1) throw new Error("The brain mask must be a single 3D image.");
  return binaryMask(volume.data);
}
