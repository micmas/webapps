// The shared worker schedule (pool.js) in Node: fake workers run the real message handlers
// (worker.js's createWorkerTasks) and answer out of order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadDwidenoise } from "../src/wasm.js";
import { CHUNK_VOXELS, denoiseSeries as denoiseShared, passCosts } from "../src/pool.js";
import { createWorkerTasks } from "../src/worker.js";

const p2s = await loadDwidenoise(readFileSync(new URL("../src/dwidenoise.wasm", import.meta.url)));

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const workers = [];

class FakeWorker {
  constructor() {
    this.handle = createWorkerTasks(p2s);
    this.queue = Promise.resolve();
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message, transfer = []) {
    const copy = structuredClone(message, { transfer });
    // One message at a time per worker, as a real worker; random delays reorder the workers.
    this.queue = this.queue.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, random() * 3));
      if (this.terminated) return;
      const reply = this.handle(copy);
      if (reply) this.onmessage?.({ data: structuredClone(reply[0], { transfer: reply[1] }) });
    });
  }
  terminate() {
    this.terminated = true;
  }
}
// The web app's four workers, as its adapter starts them on a 5-core or larger host.
const denoiseSeries = (options) => denoiseShared({ ...options, spawn: () => new FakeWorker(), workers: 4 });

function series(nvox, bvals) {
  const frames = bvals.length;
  const data = new Float32Array(nvox * frames);
  for (let t = 0; t < frames; t++) {
    for (let v = 0; v < nvox; v++) {
      data[t * nvox + v] = 100 + 20 * Math.sin(v * (0.01 + 0.007 * t)) + ((v * 7919 + t * 104729) % 13);
    }
  }
  return data;
}

test("the workers' result equals the serial chunked schedule bit for bit, with progress to 1", async () => {
  const bvals = [0, 1000, 1000, 1000, 5, 2000, 1000];
  const nvox = 2 * CHUNK_VOXELS + 1234;
  const data = series(nvox, bvals);
  const seen = [];
  const { data: out, max } = await denoiseSeries({
    data,
    nvox,
    frames: bvals.length,
    groups: p2s.fittedGroups(bvals),
    onProgress: (fraction, text) => seen.push([fraction, text]),
  });
  const expected = p2s.denoiseChunks(data, nvox, bvals);
  assert.deepEqual(out, expected);
  assert.equal(max, expected.reduce((a, b) => Math.max(a, b), -Infinity));
  assert.ok(seen.every(([fraction], i) => i === 0 || fraction >= seen[i - 1][0]), "progress only rises");
  assert.ok(Math.abs(seen.at(-1)[0] - 1) < 1e-12);
  assert.ok(seen.some(([, text]) => text === "Solving volume 7 of 7…"));
  assert.ok(workers.every((worker) => worker.terminated));
});

test("the result goes into the given output array", async () => {
  const bvals = [0, 1000, 1000, 1000];
  const data = series(500, bvals);
  const output = new Float32Array(data.length);
  const { data: out } = await denoiseSeries({ data, nvox: 500, frames: 4, groups: p2s.fittedGroups(bvals), output });
  assert.equal(out, output);
  assert.deepEqual(output, p2s.denoiseChunks(data, 500, bvals));
  await assert.rejects(
    denoiseSeries({ data, nvox: 500, frames: 4, groups: p2s.fittedGroups(bvals), output: new Float32Array(3) }),
    /holds 3 values/,
  );
});

test("a cancel between volume solves stops the run and the workers", async () => {
  const bvals = [0, 1000, 1000, 1000, 1000, 1000];
  const data = series(3000, bvals);
  const controller = new AbortController();
  workers.length = 0;
  let solves = 0;
  const run = denoiseSeries({
    data,
    nvox: 3000,
    frames: bvals.length,
    groups: p2s.fittedGroups(bvals),
    signal: controller.signal,
    onProgress: (_fraction, text) => {
      if (text.startsWith("Solving") && ++solves === 2) controller.abort();
      assert.ok(!text.startsWith("Predicting"), "no chunk is predicted after the cancel");
    },
  });
  await assert.rejects(run, { name: "AbortError" });
  assert.equal(solves, 2);
  assert.ok(workers.length > 0 && workers.every((worker) => worker.terminated));
});

test("a dependent volume is named as one serial solve names it", async () => {
  const nvox = 64;
  const data = new Float32Array(nvox * 4);
  for (let v = 0; v < nvox; v++) {
    data[v] = 100 + Math.sin(v * 0.37);
    data[nvox + v] = data[2 * nvox + v] = 50 + Math.cos(v * 1.3) * 7 + v;
    data[3 * nvox + v] = 20 + Math.sin(v * 0.11) * 3 + 0.5 * v;
  }
  const bvals = [0, 1000, 1000, 1000];
  await assert.rejects(
    denoiseSeries({ data, nvox, frames: 4, groups: p2s.fittedGroups(bvals) }),
    /^Error: Volume 2 \(counting from 0\) is a linear combination/,
  );
  assert.throws(() => p2s.denoiseArray(data, nvox, bvals), /^Error: Volume 2 \(counting from 0\)/);
});

test("pass costs weigh the solves by volume and the chunks by voxel", () => {
  const costs = passCosts([[0, 1], [2, 3, 4, 5]], 100);
  assert.equal(costs.gram, (6 + 15) * 100);
  assert.deepEqual(costs.solve, [1 / 3 + 4, 9 + 16]);
  assert.equal(costs.apply, (4 + 16) * 100);
  assert.equal(costs.total, costs.gram + 2 * costs.solve[0] + 4 * costs.solve[1] + costs.apply);
});
