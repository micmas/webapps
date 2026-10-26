// Module worker entry: runs antsRegistration, antsApplyTransforms, ImageMath Laplacian, AverageImages, AverageAffineTransform and --apply
// off the main thread (argv[0] selects the program, as for run(argv)).
//
//   const worker = new Worker(new URL("@neurodesk/hmc-registration/worker", import.meta.url), { type: "module" });
//   worker.postMessage({ id, argv, inputs });  // inputs: { "fixed.nii": Uint8Array, ... }
//   worker.onmessage = ({ data }) => ...;      // { id, outputs, log } or { id, error, log }
//
// A message may carry `kernel: { module, wasm }` URLs when a bundler moved the kernel files. The
// kernel is loaded once, after its SHA-256 matches the pinned build, and serves every later run.
// After a run aborts the kernel, the next message loads a new one.
import { createHmcRegistration } from "./index.js";
import { HMC_REGISTRATION_WASM_SHA256 } from "./pin.js";

const DEFAULT_KERNEL = {
  module: new URL("../wasm/hmc-registration.mjs", import.meta.url).href,
  wasm: new URL("../wasm/hmc-registration.wasm", import.meta.url).href,
};

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function loadKernel({ module, wasm }) {
  const response = await fetch(wasm);
  if (!response.ok) throw new Error(`Registration WebAssembly did not load (HTTP ${response.status}).`);
  const wasmBinary = new Uint8Array(await response.arrayBuffer());
  if (hex(await crypto.subtle.digest("SHA-256", wasmBinary)) !== HMC_REGISTRATION_WASM_SHA256) throw new Error("Registration WebAssembly checksum mismatch.");
  const { default: createModule } = await import(/* @vite-ignore */ module);
  if (typeof createModule !== "function") throw new Error("Registration module did not load.");
  return createHmcRegistration({ createModule, wasmBinary });
}

let kernel = null;

self.onmessage = async ({ data }) => {
  const { id, argv, inputs = {} } = data;
  try {
    kernel ??= loadKernel({ ...DEFAULT_KERNEL, ...data.kernel }).catch((error) => {
      kernel = null;
      throw error;
    });
    const { outputs, log } = (await kernel).run(argv, inputs);
    const buffers = new Set(Object.values(outputs).map((bytes) => bytes.buffer));
    self.postMessage({ id, outputs, log }, [...buffers]);
  } catch (error) {
    if (error?.aborted) kernel = null;
    self.postMessage({ id, error: error?.message ?? String(error), log: Array.isArray(error?.log) ? error.log : [] });
  }
};
