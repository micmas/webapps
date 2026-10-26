// The degibbs command line: the web app's workflow on a NIfTI file, with the same WebAssembly
// module, the same NIfTI writer and the same output names, so each output is the app's download.
import { randomUUID } from 'node:crypto';
import { access, link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createNiftiFromData, createNiftiHeaderFromVolume, decodeNiftiBuffer, readNiftiFrames } from '@neurodesk/webapp-components/file-io/nifti';
import packageJson from '../package.json' with { type: 'json' };
import { sidecarText } from '@neurodesk/webapp-components/file-io/bids-derivatives';
import { derivativeSidecar, outputNames } from './outputs.js';
import { DEFAULTS, loadDegibbs, sliceAxes } from './wasm.js';

// The web app's slice-axes choices (automation.json `sliceAxes`).
export const AXES = Object.freeze(['0,1', '0,2', '1,2']);

const degibbsModule = loadDegibbs(readFile(new URL('./degibbs.wasm', import.meta.url)));

/** `--axes 0,2` as the two in-plane axes; the sidecar's SliceEncodingDirection when absent. */
export function parseAxes(text, sidecar) {
  if (text === undefined) return sliceAxes(sidecar?.SliceEncodingDirection);
  if (!AXES.includes(text)) throw new Error(`--axes must be one of ${AXES.join(', ')}; got ${text}.`);
  return text.split(',').map(Number);
}

/** `--nshifts`, `--min-w` and `--max-w` as numbers, with the mrdegibbs defaults. */
export function parseSettings({ nshifts, minW, maxW } = {}) {
  const number = (value, name, fallback, integer) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < (integer ? 1 : 0)) {
      throw new Error(`--${name} must be ${integer ? 'a positive whole number' : 'a non-negative number'}; got ${value}.`);
    }
    return parsed;
  };
  const settings = {
    nshifts: number(nshifts, 'nshifts', DEFAULTS.nshifts, true),
    minW: number(minW, 'min-w', DEFAULTS.minW, true),
    maxW: number(maxW, 'max-w', DEFAULTS.maxW, true),
  };
  if (settings.minW >= settings.maxW) throw new Error(`--min-w (${settings.minW}) must be below --max-w (${settings.maxW}).`);
  return settings;
}

// The stem the web app pairs gradient files and sidecars by (readDiffusionSeries).
const stem = (name) => name.replace(/\.(nii\.gz|[^.]*)$/i, '');

const exists = (path) => access(path).then(() => true, () => false);

/**
 * The input's .bval, .bvec and .json: those given, else the files of the same stem beside it,
 * as the web app pairs a dropped selection.
 */
export async function companions(input, { bval, bvec, json } = {}) {
  const base = join(dirname(input), stem(basename(input)));
  const pick = async (given, extension) => {
    if (given !== undefined) {
      if (!await exists(given)) throw new Error(`${given} does not exist.`);
      return given;
    }
    return await exists(`${base}${extension}`) ? `${base}${extension}` : null;
  };
  return { bval: await pick(bval, '.bval'), bvec: await pick(bvec, '.bvec'), json: await pick(json, '.json') };
}

async function readSidecar(path) {
  if (!path) return null;
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await link(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Corrects every volume in turn, as the web app's workers do, one volume per call. */
async function correct(frames, axes, settings, onProgress) {
  const { degibbs } = await degibbsModule;
  const voxels = frames.dims[0] * frames.dims[1] * frames.dims[2];
  const out = new Float32Array(frames.data.length);
  for (let volume = 0; volume < frames.frames; volume++) {
    const data = frames.data.subarray(volume * voxels, (volume + 1) * voxels);
    out.set(degibbs(data, frames.dims, 1, { axes, ...settings }), volume * voxels);
    onProgress(volume + 1, frames.frames);
  }
  return out;
}

/**
 * Removes Gibbs ringing from `input` and writes the web app's downloads into the new or empty
 * directory `output`: the corrected image, the passed-through .bval and .bvec, and the sidecar.
 */
export async function removeRinging({ input, output, bval, bvec, json, axes, nshifts, minW, maxW, onProgress = () => {} } = {}) {
  if (!input || !output) throw new Error('Give a NIfTI image and a new output directory.');
  if (!/\.nii(\.gz)?$/i.test(input)) throw new Error(`${input} is not a NIfTI image (.nii or .nii.gz). Convert DICOM with dcm2niix first.`);
  if (!await exists(input)) throw new Error(`${input} does not exist.`);
  const settings = parseSettings({ nshifts, minW, maxW });
  const destination = resolve(output);
  await assertNewOutput(destination);
  const paired = await companions(input, { bval, bvec, json });
  const sidecar = await readSidecar(paired.json);
  const sliceAxesUsed = parseAxes(axes, sidecar);
  const buffer = await decodeNiftiBuffer(await readFile(input));
  const frames = readNiftiFrames(buffer);
  const started = performance.now();
  const corrected = await correct(frames, sliceAxesUsed, settings, onProgress);
  const names = outputNames(basename(input));
  const dims = frames.frames > 1 ? [...frames.dims, frames.frames] : frames.dims;
  const written = [{ role: 'image', name: names.image, bytes: gzipSync(Buffer.from(createNiftiFromData(corrected, buffer, { dims }))) }];
  for (const role of ['bval', 'bvec']) {
    if (paired[role]) written.push({ role, name: names[role], bytes: await readFile(paired[role]) });
  }
  written.push({ role: 'sidecar', name: names.sidecar, bytes: Buffer.from(sidecarText(derivativeSidecar(sidecar))) });
  await mkdir(destination, { recursive: true });
  for (const file of written) await writeAtomically(join(destination, file.name), file.bytes);
  return {
    output: destination,
    files: written.map(({ role, name }) => ({ role, name })),
    provenance: {
      app: `degibbs command line ${packageJson.version}`,
      method: 'mrdegibbs-3.0.8-port',
      sliceAxes: sliceAxesUsed,
      ...settings,
      volumes: frames.frames,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}

// An 8 x 8 x 2 image whose every slice holds a 4 x 4 square of 100 on 0: the sharp edges ring.
function squarePhantom() {
  const [nx, ny, nz] = [8, 8, 2];
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) data[x + nx * (y + ny * z)] = 100;
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, nx, ny, nz, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] } });
  return new Uint8Array(createNiftiFromData(data, header, { dims: [nx, ny, nz] }));
}

/**
 * Runs the module on a square phantom inside this runtime: a flat image must come back flat and
 * the square's edges must change, as removing ringing changes them.
 */
export async function checkInstallation() {
  const { degibbs } = await degibbsModule;
  const frames = readNiftiFrames(squarePhantom().buffer);
  const flat = degibbs(new Float32Array(frames.data.length).fill(7), frames.dims);
  if (flat.some((value) => Math.abs(value - 7) > 1e-4)) throw new Error('degibbs failed its phantom check: a flat image changed.');
  const square = degibbs(frames.data, frames.dims);
  const changed = square.reduce((count, value, i) => count + (Math.abs(value - frames.data[i]) > 1e-3 ? 1 : 0), 0);
  if (!changed || square.some((value) => !Number.isFinite(value))) throw new Error('degibbs failed its phantom check: the square was not corrected.');
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    degibbs: packageJson.version,
    phantom: `flat image unchanged; ${changed} of ${square.length} square voxels corrected`,
  };
}
