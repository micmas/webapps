/**
 * The voxel-wise mean of the given volumes of a volume-major series, summed in Float32 in the
 * order given, then divided. The DWI apps take their mean b0 this way.
 */
export function meanVolumes(data, voxels, volumes) {
  const mean = new Float32Array(voxels);
  for (const v of volumes) {
    const offset = v * voxels;
    for (let i = 0; i < voxels; i++) mean[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) mean[i] /= volumes.length;
  return mean;
}
