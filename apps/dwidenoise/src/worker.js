// One Patch2Self Web Worker: @neurodesk/dwidenoise's shared handler on the served WebAssembly module.
import { denoiseWorkerHandler } from "@neurodesk/dwidenoise/worker";
import wasmUrl from "@neurodesk/dwidenoise/wasm?url";

const handle = denoiseWorkerHandler(fetch(wasmUrl), (message, transfer) => self.postMessage(message, transfer));

self.onmessage = ({ data }) => handle(data);
