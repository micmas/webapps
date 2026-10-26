// The dwidenoise command line: the web app's workflow on a NIfTI file, with the same WebAssembly
// module, the same three-pass pool (worker threads in place of Web Workers: one Cholesky solve per
// volume), the same NIfTI writer and the same output names, so each output is the app's download.
import { randomUUID } from 'node:crypto';
import { access, link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { parseBval } from '@neurodesk/webapp-components/file-io/gradients';
import {
  allocateNifti,
  createNiftiFromData,
  createNiftiHeaderFromVolume,
  decodeNiftiBuffer,
  extractNiftiHeader,
  isValidNifti1,
  readNiftiFrames,
} from '@neurodesk/webapp-components/file-io/nifti';
import packageJson from '../package.json' with { type: 'json' };
import { derivativeSidecar, outputNames } from './pipeline.js';
import { denoiseSeries } from './pool.js';
import { loadDwidenoise } from './wasm.js';

const patch2self = loadDwidenoise(readFile(new URL('./dwidenoise.wasm', import.meta.url)));

/**
 * Wraps a worker thread in the Web Worker interface the shared pool drives. A thread that stops
 * before terminate() (an exit, an error or a message it cannot read) reports onerror, also on a
 * later postMessage, so a pass never waits for a reply that cannot come.
 */
export function spawnThread(url = new URL('./node-worker.js', import.meta.url), options = {}) {
  const thread = new Worker(url, options);
  let terminated = false;
  let failure = null;
  const worker = {
    postMessage: (message, transfer) => {
      if (failure) setImmediate(() => worker.onerror?.({ message: failure }));
      else thread.postMessage(message, transfer);
    },
    terminate: () => {
      terminated = true;
      return thread.terminate();
    },
    onmessage: null,
    onerror: null,
  };
  const fail = (message) => {
    if (terminated || failure) return;
    failure = message;
    worker.onerror?.({ message });
  };
  thread.on('message', (data) => worker.onmessage?.({ data }));
  thread.on('error', (error) => fail(error.message));
  thread.on('messageerror', (error) => fail(`A denoising worker thread could not read a message: ${error.message}`));
  thread.on('exit', (code) => fail(`A denoising worker thread stopped (exit code ${code}) before the run finished.`));
  return worker;
}

/** Worker threads to denoise with: one per core unless `threads` says otherwise. */
export function threadCount(threads) {
  if (threads === undefined) return availableParallelism();
  const count = typeof threads === 'string' && /^\d+$/.test(threads) ? Number(threads) : threads;
  if (!Number.isInteger(count) || count < 1) throw new Error(`--threads must be a positive whole number; got ${threads}.`);
  return count;
}

// The stem the web app pairs gradient files and sidecars by (readDiffusionSeries).
const stem = (name) => name.replace(/\.(nii\.gz|[^.]*)$/i, '');

const exists = (path) => access(path).then(() => true, () => false);

// FSL gradient files, as the web app matches them: dwi.bval, dwi.bvals, or FSL's bvals.
const BVAL_FILE = /(^|\.)bvals?$/i;
const BVEC_FILE = /(^|\.)bvecs?$/i;
const NIFTI_FILE = /\.nii(\.gz)?$/i;

/**
 * The input's .bval, .bvec and .json: those given, else those beside it, paired as the web app
 * pairs a dropped selection (readDiffusionSeries) with the input's directory as the selection.
 * A gradient file pairs by the image's stem (FSL .bvals and .bvecs too); when the directory holds
 * one image, its sole gradient file pairs whatever its name (FSL data.nii.gz with bvals and
 * bvecs). The sidecar pairs by stem only.
 */
export async function companions(input, { bval, bvec, json } = {}) {
  const directory = dirname(input);
  const imageStem = stem(basename(input));
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const singleImage = entries.filter((name) => NIFTI_FILE.test(name)).length === 1;
  const beside = (pattern) => {
    const files = entries.filter((name) => pattern.test(name));
    const match = files.find((name) => stem(name) === imageStem) ?? (singleImage && files.length === 1 ? files[0] : null);
    return match === null ? null : join(directory, match);
  };
  const pick = async (given, found) => {
    if (given === undefined) return found();
    if (!await exists(given)) throw new Error(`${given} does not exist.`);
    return given;
  };
  return {
    bval: await pick(bval, () => beside(BVAL_FILE)),
    bvec: await pick(bvec, () => beside(BVEC_FILE)),
    json: await pick(json, () => (entries.includes(`${imageStem}.json`) ? join(directory, `${imageStem}.json`) : null)),
  };
}

// The web app's sidecar parse: an object, else no sidecar.
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

// Each file appears under its name complete, and never replaces one a concurrent run wrote there:
// link() fails when the name exists.
async function writeAtomically(path, bytes) {
  const partial = join(dirname(path), `.${randomUUID().slice(0, 8)}.partial`);
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await link(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * Runs the shared pool on `threads` worker threads, as the web app runs it on its Web Workers.
 * The result goes into `output` when given (the voxels of the output NIfTI); `max` is its largest
 * finite value, from the workers.
 */
async function denoiseVolumes({ data, nvox, frames, bvals, threads, output, onProgress }) {
  const p2s = await patch2self;
  const groups = p2s.fittedGroups(bvals);
  const { data: denoised, max } = await denoiseSeries({
    data,
    nvox,
    frames,
    groups,
    output,
    spawn: () => spawnThread(),
    workers: threads,
    onProgress,
  });
  return { denoised, max, groups, b0Threshold: p2s.B0_THRESHOLD };
}

/**
 * Denoises `input` with Patch2Self and writes the web app's downloads into the new or empty
 * directory `output`: the denoised image, the passed-through .bval and .bvec, and the sidecar.
 * @param options.threads worker threads, default one per core; the output is the same for any count
 */
export async function denoise({ input, output, bval, bvec, json, threads, onProgress = () => {} } = {}) {
  if (!input || !output) throw new Error('Give a NIfTI image and a new output directory.');
  if (!/\.nii(\.gz)?$/i.test(input)) throw new Error(`${input} is not a NIfTI image (.nii or .nii.gz). Convert DICOM with dcm2niix first.`);
  if (!await exists(input)) throw new Error(`${input} does not exist.`);
  const workers = threadCount(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const paired = await companions(input, { bval, bvec, json });
  const name = basename(input);
  if (!paired.bval) throw new Error(`Give the .bval file of ${name} (--bval FILE): Patch2Self groups volumes by b-value.`);
  const buffer = await decodeNiftiBuffer(new Uint8Array(await readFile(input)));
  if (!isValidNifti1(buffer)) throw new Error(`${name} is not NIfTI-1. Convert it with dcm2niix first.`);
  const frames = readNiftiFrames(buffer);
  const bvals = parseBval(await readFile(paired.bval, 'utf8'), frames.frames);
  const p2s = await patch2self;
  const split = p2s.groups(bvals);
  const sidecar = await readSidecar(paired.json);
  const nvox = frames.dims[0] * frames.dims[1] * frames.dims[2];
  const header = extractNiftiHeader(buffer);
  const dims = [...frames.dims, frames.frames];
  // The workers' results go straight into the output file's voxels, as in the web app.
  const file = allocateNifti(header, Float32Array, frames.data.length, { dims });
  const started = performance.now();
  const { denoised, max, groups, b0Threshold } = await denoiseVolumes({
    data: frames.data,
    nvox,
    frames: frames.frames,
    bvals,
    threads: workers,
    output: file?.data,
    onProgress,
  });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const names = outputNames(name);
  // The workers found the largest value, so cal_max needs no second read of the image.
  const niftiOptions = { dims, calMax: max };
  const nifti = file ? file.finish(niftiOptions) : createNiftiFromData(denoised, header, niftiOptions);
  const written = [{ role: 'image', name: names.image, bytes: gzipSync(new Uint8Array(nifti)) }];
  for (const role of ['bval', 'bvec']) {
    if (paired[role]) written.push({ role, name: names[role], bytes: await readFile(paired[role]) });
  }
  written.push({ role: 'sidecar', name: names.sidecar, bytes: Buffer.from(`${JSON.stringify(derivativeSidecar(sidecar), null, 2)}\n`) });
  await mkdir(destination, { recursive: true });
  for (const file of written) await writeAtomically(join(destination, file.name), file.bytes);
  return {
    output: destination,
    files: written.map(({ role, name: fileName }) => ({ role, name: fileName })),
    provenance: {
      app: `dwidenoise command line ${packageJson.version}`,
      method: 'patch2self-v1-dipy-1.12.1-port',
      model: 'ols',
      patchRadius: 0,
      b0Threshold,
      groups,
      b0Volumes: split.b0.length,
      weightedVolumes: split.dwi.length,
      threads: workers,
      seconds,
    },
  };
}

/**
 * A small 4D DWI, one b0 and five b = 1000 volumes, each a smooth field of its own plus
 * deterministic pseudo-noise, so the volumes of the group are linearly independent.
 */
export function phantomSeries({ nx = 40, ny = 32, nz = 16 } = {}) {
  const bvals = [0, 1000, 1000, 1000, 1000, 1000];
  const frames = bvals.length;
  const nvox = nx * ny * nz;
  const data = new Float32Array(nvox * frames);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let t = 0; t < frames; t++) {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const signal = t === 0 ? 400 : 150 + 60 * Math.sin((x + 3 * t) / 5) * Math.cos((y - t) / 4) + 10 * z;
          data[t * nvox + x + nx * (y + ny * z)] = signal + 20 * noise();
        }
      }
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, nx, ny, nz, frames, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] } });
  return { nifti: new Uint8Array(createNiftiFromData(data, header, { dims: [nx, ny, nz, frames] })), data, dims: [nx, ny, nz], nvox, frames, bvals };
}

/**
 * Denoises the phantom (more than one pool chunk) inside this runtime on one and on three worker
 * threads. Both must give the same bits, keep the single b0, agree with the module's one-pass
 * denoise to float32 rounding and change the weighted volumes.
 */
export async function checkInstallation() {
  const phantom = phantomSeries();
  const p2s = await patch2self;
  const run = (threads) => denoiseVolumes({ data: phantom.data, nvox: phantom.nvox, frames: phantom.frames, bvals: phantom.bvals, threads });
  const one = (await run(1)).denoised;
  const three = (await run(3)).denoised;
  if (Buffer.compare(Buffer.from(one.buffer), Buffer.from(three.buffer)) !== 0) {
    throw new Error('dwidenoise failed its phantom check: one and three worker threads gave different results.');
  }
  const { nvox } = phantom;
  for (let v = 0; v < nvox; v++) {
    if (one[v] !== phantom.data[v]) throw new Error('dwidenoise failed its phantom check: the single b0 changed.');
  }
  const whole = p2s.denoiseArray(phantom.data, nvox, phantom.bvals);
  let largest = 0;
  let changed = 0;
  for (let i = 0; i < whole.length; i++) {
    largest = Math.max(largest, Math.abs(one[i] - whole[i]));
    if (i >= nvox && Math.abs(one[i] - phantom.data[i]) > 0.5) changed++;
  }
  if (!(largest < 1e-3)) throw new Error(`dwidenoise failed its phantom check: the pool differs from the one-pass denoise by ${largest}.`);
  if (!changed) throw new Error('dwidenoise failed its phantom check: no weighted voxel changed.');
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    dwidenoise: packageJson.version,
    phantom: `1 and 3 threads identical; b0 unchanged; ${changed} of ${whole.length - nvox} weighted values changed; largest difference from one pass ${largest.toExponential(2)}`,
  };
}
