// The shared gzip worker in Node: a fake worker runs the real handler.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { gzipInWorker, gzipWorkerHandler } from "../src/gzip.js";

function fakeSpawn(spawned) {
  return () => {
    const worker = {
      terminated: false,
      postMessage(message, transfer = []) {
        const copy = structuredClone(message, { transfer });
        handle(copy);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    const handle = gzipWorkerHandler((reply, transfer = []) => {
      if (!worker.terminated) worker.onmessage?.({ data: structuredClone(reply, { transfer }) });
    });
    spawned.push(worker);
    return worker;
  };
}

test("the gzip worker compresses more than one slice and moves the buffer", async () => {
  const spawned = [];
  const bytes = Uint8Array.from({ length: (1 << 24) + 1000 }, (_, i) => (i * 31) % 251);
  const buffer = bytes.slice().buffer;
  const gzipped = await gzipInWorker(buffer, { spawn: fakeSpawn(spawned) });
  assert.equal(buffer.byteLength, 0, "the buffer is transferred, not copied");
  assert.deepEqual(new Uint8Array(gunzipSync(new Uint8Array(gzipped))), bytes);
  assert.ok(spawned.every((worker) => worker.terminated));
});

test("a cancel stops the gzip worker", async () => {
  const spawned = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gzipInWorker(new ArrayBuffer(8), { signal: controller.signal, spawn: fakeSpawn(spawned) }), { name: "AbortError" });
  assert.ok(spawned.every((worker) => worker.terminated));
});
