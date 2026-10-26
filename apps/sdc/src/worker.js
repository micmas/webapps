// The sdc worker: loads the WebAssembly once and runs one PyHySCO estimate per message. The page
// cancels a run by terminating the worker. `estimate` runs the Gauss-Newton evaluations and the CG
// solves on WebGPU when the browser has a hardware adapter and JSPI, and on the CPU otherwise.
import { loadSdc } from "@neurodesk/sdc";
import wasmUrl from "@neurodesk/sdc/wasm?url";

const ready = loadSdc(fetch(wasmUrl));

self.onmessage = async ({ data: message }) => {
  try {
    const { estimate } = await ready;
    const out = await estimate(message.image1, message.image2, message.dims, message.voxel, message.options);
    self.postMessage({ ok: true, ...out }, [out.field.buffer, out.corrected1.buffer, out.corrected2.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: error?.message ?? String(error) });
  }
};
