// DOM-free steps of the noddi workflow, shared by the web app and the noddi command line: the
// mean b0, voxel chunks for the workers, and the written maps with their BIDS derivative names
// (BEP016 dwimap).

import { B0_THRESHOLD } from "@neurodesk/dwi2trx/gradients";
import { maskName } from "@neurodesk/webapp-components/file-io/bids-derivatives";

/** Volumes with a b-value below this are b0 volumes, as in the WebAssembly fit and dtifit. */
export { B0_THRESHOLD };
export { maskName };
export { meanVolumes } from "@neurodesk/webapp-components/volume/mean";

/** The maps each model writes: BEP016 parameter label, worker output key, row label. */
export const MAPS = Object.freeze({
  tensor: [
    { param: "fa", key: "FA", label: "FA" },
    { param: "md", key: "MD", label: "MD" },
    { param: "ad", key: "AD", label: "AD" },
    { param: "rd", key: "RD", label: "RD" },
    { param: "s0", key: "S0", label: "S0" },
    { param: "direction", keys: ["V1x", "V1y", "V1z"], label: "Tensor direction" },
  ],
  noddi: [
    { param: "icvf", key: "ICVF", label: "ICVF" },
    { param: "isovf", key: "ISOVF", label: "ISOVF" },
    { param: "odi", key: "OD", label: "ODI" },
    { param: "direction", keys: ["dirx", "diry", "dirz"], label: "NODDI direction" },
  ],
});

/** The BIDS stem of a DWI file: its name without extension and without a trailing _dwi. */
export function bidsStem(fileName) {
  return fileName.replace(/\.nii(\.gz)?$/i, "").replace(/_dwi$/i, "");
}

/** BEP016 name of one parameter map: <stem>_model-<model>_param-<param>_dwimap.nii.gz. */
export function mapName(stem, model, param) {
  return `${stem}_model-${model}_param-${param}_dwimap.nii.gz`;
}

/** Indices of the non-zero voxels of a mask. */
export function maskIndices(mask) {
  const indices = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) indices.push(i);
  return Uint32Array.from(indices);
}

/** Voxels per fitting job, in the browser's workers and the command line's threads alike. */
export const CHUNK_VOXELS = 2048;

/** Splits voxel indices into chunks of at most `size`. */
export function chunks(indices, size) {
  const out = [];
  for (let start = 0; start < indices.length; start += size) out.push(indices.subarray(start, start + size));
  return out;
}

/** The chunk's samples, volume-major over its voxels, as the WebAssembly fit takes them. */
export function gatherChunk(data, voxels, volumes, indices) {
  const out = new Float32Array(indices.length * volumes);
  for (let v = 0; v < volumes; v++) {
    const offset = v * voxels;
    const row = v * indices.length;
    for (let k = 0; k < indices.length; k++) out[row + k] = data[offset + indices[k]];
  }
  return out;
}

/** Full-size maps, zero outside the mask, for the outputs of one model. */
export function emptyMaps(model, voxels) {
  const maps = {};
  for (const map of MAPS[model]) {
    for (const key of map.keys ?? [map.key]) maps[key] = new Float32Array(voxels);
  }
  return maps;
}

/** Writes a chunk's outputs back to the voxel positions it came from. */
export function scatterChunk(maps, outputs, indices) {
  for (const [key, values] of Object.entries(outputs)) {
    const target = maps[key];
    if (!target) continue;
    for (let k = 0; k < indices.length; k++) target[indices[k]] = values[k];
  }
}

/** The values of the tensor-fit select control, as the automation schema and provenance name them. */
export const TENSOR_FITS = Object.freeze(["wls", "ols", "niimath-dtifit"]);

/** The niimath dtifit maps that the tensor maps come from (see dtifitMaps). */
export const DTIFIT_INPUTS = Object.freeze(["FA", "MD", "L1", "L2", "L3", "S0", "V1"]);

/** True when `volumes` is every volume of an `n`-volume series, in order. */
export function isEveryVolume(volumes, n) {
  return volumes.length === n && volumes.every((volume, i) => volume === i);
}

/** The given volumes of a volume-major series, in their order, as one volume-major array. */
export function selectVolumes(data, voxels, volumes) {
  const out = new Float32Array(voxels * volumes.length);
  volumes.forEach((volume, i) => out.set(data.subarray(volume * voxels, (volume + 1) * voxels), i * voxels));
  return out;
}

/**
 * FSL bval and bvec text for the given volumes. Each bvec is a unit vector and each b0 volume has
 * a zero vector, as in the WebAssembly fit's gradient table: niimath dtifit uses the bvec length
 * as given, so a bvec of length 0.9 would change the diffusivities.
 */
export function gradientText(bvals, bvecs, volumes) {
  const bval = volumes.map((volume) => bvals[volume]).join(" ");
  const units = volumes.map((volume) => {
    if (bvals[volume] < B0_THRESHOLD) return [0, 0, 0];
    const g = [0, 1, 2].map((axis) => bvecs[axis][volume]);
    const norm = Math.hypot(...g);
    return g.map((component) => component / norm);
  });
  const bvec = [0, 1, 2].map((axis) => units.map((unit) => unit[axis]).join(" ")).join("\n");
  return { bval: `${bval}\n`, bvec: `${bvec}\n` };
}

/**
 * The tensor maps from niimath dtifit's outputs, with the keys that the WebAssembly fit uses.
 * dtifit writes no AD or RD: AD is L1 and RD is the mean of L2 and L3. Where dtifit sets MD to
 * zero (a fit with a negative eigenvalue), AD and RD are zero too, so the four maps agree. V1
 * comes from dtifit with -xflip 0, in the bvec frame; each vector gets the WebAssembly fit's
 * sign (largest-magnitude component positive). dtifit's V2, V3, MO and tensor maps are not used.
 * @param {Record<string, Float32Array>} maps one array per name in DTIFIT_INPUTS
 */
export function dtifitMaps(maps, voxels) {
  for (const name of DTIFIT_INPUTS) {
    const expected = name === "V1" ? 3 * voxels : voxels;
    if (maps[name]?.length !== expected) throw new Error(`niimath dtifit wrote no ${name} map on the DWI grid.`);
  }
  const { FA, MD, L1, L2, L3, S0, V1 } = maps;
  const AD = new Float32Array(voxels);
  const RD = new Float32Array(voxels);
  const V1x = new Float32Array(voxels);
  const V1y = new Float32Array(voxels);
  const V1z = new Float32Array(voxels);
  for (let i = 0; i < voxels; i++) {
    if (MD[i] !== 0) {
      AD[i] = L1[i];
      RD[i] = (L2[i] + L3[i]) / 2;
    }
    const [x, y, z] = [V1[i], V1[voxels + i], V1[2 * voxels + i]];
    // On a tie the later component decides, as Rust's max_by in the WebAssembly fit.
    let largest = x;
    if (Math.abs(y) >= Math.abs(largest)) largest = y;
    if (Math.abs(z) >= Math.abs(largest)) largest = z;
    const sign = largest < 0 ? -1 : 1;
    // Adding 0 writes -0 as 0.
    V1x[i] = sign * x + 0;
    V1y[i] = sign * y + 0;
    V1z[i] = sign * z + 0;
  }
  return { FA, MD, AD, RD, S0, V1x, V1y, V1z };
}

/** A direction map as three frames (x, y, z) after one another, as a 4D NIfTI holds them. */
export function stackFrames(maps, keys) {
  const voxels = maps[keys[0]].length;
  const out = new Float32Array(voxels * keys.length);
  keys.forEach((key, frame) => out.set(maps[key], frame * voxels));
  return out;
}

/**
 * Every file a fit writes, in the order the web app lists them: each model's maps, then the brain
 * mask. Each entry gives its automation role, row label, BIDS file name, voxel data and frame
 * count (3 for a direction, 1 otherwise).
 * @param fit.tensor tensor maps keyed by DTI output name
 * @param fit.noddi NODDI maps keyed by NODDI output name, or null for a tensor-only fit
 * @param mask the brain mask used, one value per voxel
 */
export function outputEntries({ tensor, noddi }, mask, stem) {
  const entries = [];
  for (const [model, maps] of [["tensor", tensor], ["noddi", noddi]]) {
    if (!maps) continue;
    for (const map of MAPS[model]) {
      entries.push({
        role: `${model}-${map.param}`,
        model,
        param: map.param,
        label: map.label,
        name: mapName(stem, model, map.param),
        data: map.keys ? stackFrames(maps, map.keys) : maps[map.key],
        frames: map.keys ? map.keys.length : 1,
      });
    }
  }
  entries.push({ role: "mask", model: null, param: "mask", label: "Brain mask", name: maskName(stem), data: mask, frames: 1 });
  return entries;
}
