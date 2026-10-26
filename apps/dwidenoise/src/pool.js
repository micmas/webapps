// The web app's denoising pool: the shared three-pass pool of @neurodesk/dwidenoise on a few Web
// Workers, and the shared gzip on a worker that loads no WebAssembly.
import { denoiseSeries as denoiseShared } from "@neurodesk/dwidenoise/pool";
import { gzipInWorker as gzipShared } from "@neurodesk/dwidenoise/gzip";

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

const spawn = () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const spawnGzip = () => new Worker(new URL("./gzip-worker.js", import.meta.url), { type: "module" });

/** Denoises a series on the browser's workers; see @neurodesk/dwidenoise/pool. */
export function denoiseSeries(options) {
  return denoiseShared({ ...options, spawn, workers: workerCount() });
}

/** Gzips `buffer` in a worker; the buffer is moved there. See @neurodesk/dwidenoise/gzip. */
export function gzipInWorker(buffer, signal) {
  return gzipShared(buffer, { signal, spawn: spawnGzip });
}
