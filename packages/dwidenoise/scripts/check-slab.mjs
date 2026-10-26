// Runs src/dwidenoise.wasm on a NIfTI-1 series, times the Gram and apply passes, and compares
// the result with a reference (the dataset's dwidenoise/validation oracle). With --app, it also
// runs the web app's worker schedule (denoiseChunks) and requires each given app output to equal
// it bit for bit.
//
//   node scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz [--app OUTPUT.nii[.gz] ...]

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { CHUNK_VOXELS, loadDwidenoise } from "../src/wasm.js";

const args = process.argv.slice(2);
const appAt = args.indexOf("--app");
const [input, bval, reference] = appAt < 0 ? args : args.slice(0, appAt);
const appOutputs = appAt < 0 ? [] : args.slice(appAt + 1);
if (!reference || (appAt >= 0 && appOutputs.length === 0)) {
  console.error("usage: node scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz [--app OUTPUT.nii[.gz] ...]");
  process.exit(2);
}

function readNifti(path, into) {
  const raw = readFileSync(path);
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== 348) throw new Error(`${path} is not little-endian NIfTI-1`);
  const dims = [1, 2, 3, 4].map((d) => Math.max(1, view.getInt16(40 + 2 * d, true)));
  const datatype = view.getInt16(70, true);
  const offset = Math.max(352, view.getFloat32(108, true));
  const slope = view.getFloat32(112, true);
  const inter = view.getFloat32(116, true);
  const count = dims.reduce((a, b) => a * b, 1);
  const out = into ?? new Float32Array(count);
  const read = { 4: (i) => view.getInt16(offset + 2 * i, true), 16: (i) => view.getFloat32(offset + 4 * i, true) }[datatype];
  if (!read) throw new Error(`unsupported datatype ${datatype}`);
  const scale = slope !== 0 && Number.isFinite(slope) && (slope !== 1 || inter !== 0);
  for (let i = 0; i < count; i++) out[i] = scale ? read(i) * slope + inter : read(i);
  return { dims, data: out };
}

/** Values whose f32 bits differ, and values more than one f32 ulp from `want`. */
function compare(ours, want) {
  if (ours.length !== want.length) throw new Error(`${ours.length} values, expected ${want.length}`);
  const a = new Uint32Array(ours.buffer, ours.byteOffset, ours.length);
  const b = new Uint32Array(want.buffer, want.byteOffset, want.length);
  let worst = 0;
  let beyond = 0;
  let bits = 0;
  for (let i = 0; i < want.length; i++) {
    if (a[i] !== b[i]) bits += 1;
    const diff = Math.abs(ours[i] - want[i]);
    worst = Math.max(worst, diff);
    const u = Math.fround(Math.abs(want[i]) * (1 + 2 ** -23)) - Math.abs(want[i]);
    if (diff > Math.max(u, 0)) beyond += 1;
  }
  return { max_abs_diff: worst, values_beyond_one_f32_ulp: beyond, values_with_other_bits: bits };
}

const p2s = await loadDwidenoise(readFileSync(new URL("../src/dwidenoise.wasm", import.meta.url)));
const bvals = readFileSync(bval, "utf8").trim().split(/\s+/).map(Number);
const header = readNifti(input);
const [nx, ny, nz, nt] = header.dims;
const nvox = nx * ny * nz;
const buffer = p2s.allocate(nvox * nt);
buffer.view().set(header.data);

let gramSeconds = 0;
let applySeconds = 0;
for (const group of p2s.fittedGroups(bvals)) {
  const gram = new Float64Array(p2s.gramLength(group.length));
  let t = performance.now();
  p2s.accumulate(buffer, nvox, group, gram);
  gramSeconds += (performance.now() - t) / 1000;
  const coefficients = p2s.solve(gram, group);
  t = performance.now();
  p2s.apply(buffer, nvox, group, coefficients);
  applySeconds += (performance.now() - t) / 1000;
}

const ours = buffer.view().slice();
buffer.free();
const { data: want } = readNifti(reference);
const onePass = compare(ours, want);
const result = {
  dims: header.dims,
  gram_seconds: +gramSeconds.toFixed(3),
  apply_seconds: +applySeconds.toFixed(3),
  gram_voxels_per_second: Math.round(nvox / gramSeconds),
  apply_voxels_per_second: Math.round(nvox / applySeconds),
  max_abs_diff: onePass.max_abs_diff,
  values_beyond_one_f32_ulp: onePass.values_beyond_one_f32_ulp,
};
let failed = onePass.values_beyond_one_f32_ulp > 0;

if (appOutputs.length) {
  const t = performance.now();
  const chunked = p2s.denoiseChunks(header.data, nvox, bvals, { chunk: CHUNK_VOXELS });
  result.chunked_seconds = +((performance.now() - t) / 1000).toFixed(3);
  result.chunked_vs_reference = compare(chunked, want);
  result.chunked_vs_one_pass = compare(chunked, ours);
  result.app_outputs = appOutputs.map((path) => {
    const { dims, data } = readNifti(path);
    if (dims.join() !== header.dims.join()) throw new Error(`${path} is ${dims.join("×")}, not ${header.dims.join("×")}`);
    const { values_with_other_bits } = compare(data, chunked);
    if (values_with_other_bits > 0) failed = true;
    return { path, values_with_other_bits };
  });
}

console.log(JSON.stringify(result));
if (failed) process.exit(1);
