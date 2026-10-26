// One denoising worker thread of the dwidenoise command line: the web app's worker handler on
// the package's own dwidenoise.wasm.
import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { denoiseWorkerHandler } from './worker.js';

const handle = denoiseWorkerHandler(
  readFile(new URL('./dwidenoise.wasm', import.meta.url)),
  (message, transfer) => parentPort.postMessage(message, transfer),
);

parentPort.on('message', (message) => handle(message));
