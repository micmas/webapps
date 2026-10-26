// The compression Web Worker: @neurodesk/dwidenoise's shared gzip handler. It loads no WebAssembly.
import { gzipWorkerHandler } from "@neurodesk/dwidenoise/gzip";

const handle = gzipWorkerHandler((message, transfer) => self.postMessage(message, transfer));

self.onmessage = ({ data }) => handle(data);
