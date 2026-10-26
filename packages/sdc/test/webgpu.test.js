// Backend choice of `estimate`. The kernels themselves run in Chromium:
// apps/sdc/e2e/webgpu.spec.js (SwiftShader on CI, the sub-01 gate on a hardware adapter).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeGpuDevice, installGpuConstants } from "../../../test-utils/gpu-device.mjs";
import { loadSdc } from "../src/wasm.js";
import { requestHardwareAdapter, shaders } from "../src/webgpu.js";

const bytes = readFileSync(new URL("../src/sdc.wasm", import.meta.url));

function bumps([nx, ny, nz], shift) {
  const out = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const position = (y + 0.5) * 2 - shift;
        out[x + nx * (y + ny * z)] = 100 * Math.exp(-(((position - ny - z) / 6) ** 2)) + 5;
      }
    }
  }
  return out;
}

const dims = [6, 32, 4];
const pair = [bumps(dims, 2), bumps(dims, -2), dims, [2, 2, 2]];
const options = { phaseEncodingDirection: "j-", totalReadoutTime: 0.05 };

test("the cpu backend gives the numbers of pyhysco", async () => {
  const sdc = await loadSdc(bytes);
  const direct = sdc.pyhysco(...pair, options);
  const out = await sdc.estimate(...pair, { ...options, backend: "cpu" });
  assert.equal(out.backend, "cpu");
  assert.deepEqual(out.field, direct.field);
  assert.deepEqual(out.corrected1, direct.corrected1);
});

test("auto uses the CPU without a WebGPU adapter, and webgpu refuses to run without one", async () => {
  assert.equal(globalThis.navigator?.gpu, undefined, "Node has no WebGPU");
  const sdc = await loadSdc(bytes);
  const out = await sdc.estimate(...pair, options);
  assert.equal(out.backend, "cpu");
  assert.equal(out.gpuError, undefined);
  assert.deepEqual(out.field, sdc.pyhysco(...pair, options).field);
  await assert.rejects(sdc.estimate(...pair, { ...options, backend: "webgpu" }), /No WebGPU adapter|JSPI/);
  await assert.rejects(sdc.estimate(...pair, { ...options, backend: "metal" }), /backend must be auto, webgpu or cpu/);
});

test("a failing WebGPU run falls back to the CPU under auto and fails under webgpu", { skip: typeof WebAssembly.Suspending !== "function" && "needs JSPI" }, async () => {
  installGpuConstants();
  const sdc = await loadSdc(bytes);
  // The fake device has no compute passes: the first evaluation throws inside the WebAssembly.
  const device = fakeGpuDevice();
  const out = await sdc.estimate(...pair, { ...options, device });
  assert.equal(out.backend, "cpu");
  assert.match(out.gpuError, /beginComputePass/);
  assert.deepEqual(out.field, sdc.pyhysco(...pair, options).field, "the CPU instance is not poisoned");
  const again = await sdc.estimate(...pair, { ...options, device });
  assert.equal(again.backend, "cpu");
  await assert.rejects(sdc.estimate(...pair, { ...options, backend: "webgpu", device: fakeGpuDevice() }), /beginComputePass/);
  // Invalid input fails with the CPU path's message, not as a GPU failure.
  const constant = new Float64Array(pair[0].length).fill(1);
  await assert.rejects(sdc.estimate(constant, constant, dims, [2, 2, 2], { ...options, device: fakeGpuDevice() }), /refused the input/);
  await assert.rejects(sdc.estimate(...pair, { phaseEncodingDirection: "k", totalReadoutTime: 0.05, device: fakeGpuDevice() }), /must be i, i-, j or j-/);
});

// A navigator.gpu whose adapter reports `info` and opens fake devices; `lost` resolves each
// device's lost promise at once.
function fakeGpu(info, { lost = false, isFallbackAdapter } = {}) {
  const gpu = { adapters: 0 };
  gpu.requestAdapter = async () => {
    gpu.adapters++;
    return {
      info,
      isFallbackAdapter,
      limits: {},
      requestDevice: async () => ({ ...fakeGpuDevice(), lost: lost ? Promise.resolve({ reason: "destroyed" }) : new Promise(() => {}) }),
    };
  };
  return gpu;
}

test("auto does not pick a software adapter (the shared runtime-support check)", async () => {
  assert.equal(await requestHardwareAdapter(fakeGpu({ vendor: "google", architecture: "swiftshader" })), null);
  assert.equal(await requestHardwareAdapter(fakeGpu({ vendor: "intel", architecture: "xe-2lpg", isFallbackAdapter: true })), null);
  assert.equal(await requestHardwareAdapter(fakeGpu({ vendor: "microsoft", architecture: "warp" })), null);
  assert.ok(await requestHardwareAdapter(fakeGpu({ vendor: "intel", architecture: "xe-2lpg" })));
});

test("auto honors the browser's fallback flag when adapter info has no name", async () => {
  assert.equal(await requestHardwareAdapter(fakeGpu({}, { isFallbackAdapter: true })), null);
  assert.equal(await requestHardwareAdapter(fakeGpu({ isFallbackAdapter: true }, { isFallbackAdapter: false })), null);
  assert.equal(await requestHardwareAdapter(fakeGpu({ isFallbackAdapter: false }, { isFallbackAdapter: true })), null);
  assert.ok(await requestHardwareAdapter(fakeGpu({}, { isFallbackAdapter: false })));
});

test("auto opens a new device after the browser loses one, and stays on the CPU after other failures", { skip: typeof WebAssembly.Suspending !== "function" && "needs JSPI" }, async () => {
  installGpuConstants();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const [lost, adapters] of [[true, 3], [false, 1]]) {
      const gpu = fakeGpu({ vendor: "intel", architecture: "xe-2lpg" }, { lost });
      Object.defineProperty(globalThis, "navigator", { value: { gpu }, configurable: true });
      const sdc = await loadSdc(bytes);
      for (let run = 0; run < 3; run++) {
        const out = await sdc.estimate(...pair, options);
        assert.equal(out.backend, "cpu");
      }
      assert.equal(gpu.adapters, adapters, lost ? "each run opens a new device" : "one failure keeps auto on the CPU");
    }
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
});

test("every kernel binds its uniforms first and reduces only where it declares partials", () => {
  for (const [name, code] of Object.entries(shaders)) {
    assert.match(code, /@group\(0\) @binding\(0\) var<uniform> P: Params;/, name);
    assert.equal(/reduceTwo\(lid/.test(code), /var<storage, read_write> partials/.test(code), name);
  }
});
