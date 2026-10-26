import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createNiftiFromData, createNiftiHeaderFromVolume } from '../src/file-io/NiftiUtils.js';
import { binaryMask, readBrainMask } from '@neurodesk/webapp-components/file-io/brain-mask';
import { meanVolumes } from '@neurodesk/webapp-components/volume/mean';

const AFFINE = [
  [2, 0, 0, -10],
  [0, 2, 0, -12],
  [0, 0, 2, -8]
];

/** A Float32 NIfTI of `dims` (3D, or 4D with the volume count last) on the given affine. */
function nifti(data, dims, affine = AFFINE) {
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [dims.length, ...dims], pixDims: [1, 2, 2, 2], affine } });
  return new Uint8Array(createNiftiFromData(Float32Array.from(data), header, { dims }));
}

const DIMS = [2, 2, 2];
const reference = nifti(new Float32Array(8), DIMS);

test('a mask on the image grid is binarised: 1 above 0, else 0', async () => {
  const mask = await readBrainMask(nifti([0, 0.2, -1, 3, 0, 1, 0, 2], DIMS), reference);
  assert.ok(mask instanceof Uint8Array);
  assert.deepEqual(Array.from(mask), [0, 1, 0, 1, 0, 1, 0, 1]);
});

test('a gzipped mask reads as the same mask', async () => {
  const bytes = nifti([1, 0, 1, 0, 1, 0, 1, 0], DIMS);
  assert.deepEqual(await readBrainMask(gzipSync(bytes), reference), await readBrainMask(bytes, reference));
});

test('a mask on a different grid is refused', async () => {
  const shifted = AFFINE.map((row, i) => (i === 0 ? [2, 0, 0, -9] : row));
  await assert.rejects(readBrainMask(nifti(new Float32Array(8).fill(1), DIMS, shifted), reference, { name: 'mask.nii', grid: 'DWI' }), {
    message: 'mask.nii is not on the DWI grid.'
  });
  await assert.rejects(readBrainMask(nifti(new Float32Array(27).fill(1), [3, 3, 3]), reference, { name: 'mask.nii' }), {
    message: 'mask.nii is not on the image grid.'
  });
});

test('a 4D mask is refused', async () => {
  await assert.rejects(readBrainMask(nifti(new Float32Array(16).fill(1), [2, 2, 2, 2]), reference), {
    message: 'The brain mask must be a single 3D image.'
  });
});

test('an aborted signal stops the read', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBrainMask(nifti(new Float32Array(8), DIMS), reference, { signal: controller.signal }), { name: 'AbortError' });
});

test('binaryMask takes any numeric array', () => {
  assert.deepEqual(Array.from(binaryMask([0, 5, -2, 0.5])), [0, 1, 0, 1]);
  assert.deepEqual(Array.from(binaryMask(new Int16Array([0, 1]))), [0, 1]);
});

test('meanVolumes is the voxel-wise mean of the chosen volumes of a volume-major series', () => {
  const data = Float32Array.from([0, 2, 100, 100, 2, 0, 100, 102, 9, 9, 9, 9]);
  assert.deepEqual(Array.from(meanVolumes(data, 4, [0, 1])), [1, 1, 100, 101]);
  assert.deepEqual(Array.from(meanVolumes(data, 4, [2])), [9, 9, 9, 9]);
  const mean = meanVolumes(data, 4, [0, 1, 2]);
  assert.ok(mean instanceof Float32Array);
  // Float32 sums in the order given, then one division: (0 + 2 + 9) / 3.
  assert.equal(mean[0], Math.fround(Math.fround(Math.fround(0 + 2) + 9) / 3));
});
