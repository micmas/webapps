// A denoising worker thread that stops: with `exit-on-message` it exits as soon as a message
// arrives; with `exit-after-reply` it answers its first message with the real handler, then exits.
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { denoiseWorkerHandler } from '../../src/worker.js';

const handle = denoiseWorkerHandler(
  readFile(new URL('../../src/dwidenoise.wasm', import.meta.url)),
  (message, transfer) => {
    parentPort.postMessage(message, transfer);
    setImmediate(() => process.exit(4));
  },
);

parentPort.once('message', (message) => {
  if (workerData === 'exit-on-message') process.exit(3);
  handle(message);
});
