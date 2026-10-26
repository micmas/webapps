// Run one exported Synb0-DisCo fold in ONNX Runtime Web (WebAssembly backend) under Node.
// Usage: node ort_web_check.mjs <fold.onnx> [threads] [sample-prefix]
// Reads <prefix>.input.f32 and <prefix>.torch.f32 (default prefix <fold.onnx>, from
// export_onnx.py --sample; model_check.py writes real-data samples) and prints
// the wall time, the largest difference from PyTorch and the WebAssembly memory size.
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';

const [model, threads = '8', prefix = model] = process.argv.slice(2);
ort.env.wasm.numThreads = Number(threads);
const input = new Float32Array(readFileSync(`${prefix}.input.f32`).buffer.slice(0));
const expected = new Float32Array(readFileSync(`${prefix}.torch.f32`).buffer.slice(0));
const tensor = new ort.Tensor('float32', input, [1, 2, 80, 80, 96]);
const t0 = performance.now();
const session = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ['wasm'] });
const t1 = performance.now();
const { output } = await session.run({ input: tensor });
const t2 = performance.now();
let max = 0;
for (let i = 0; i < expected.length; i++) max = Math.max(max, Math.abs(Number(output.data[i]) - expected[i]));
const usage = process.memoryUsage();
console.log(JSON.stringify({
  model, sample: prefix, threads: Number(threads), load_s: (t1 - t0) / 1000, run_s: (t2 - t1) / 1000, max_abs_diff_vs_torch: max,
  array_buffers_gb: usage.arrayBuffers / 2 ** 30, max_rss_gb: process.resourceUsage().maxRSS / 2 ** 20,
}));
