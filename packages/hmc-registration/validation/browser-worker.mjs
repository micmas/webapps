// Runs the module worker (src/worker.js) in Chromium on the committed test pair: run(argv) must
// recover the known rigid shift and write native ANTs's bytes, as it does in Node, and
// AverageImages, AverageAffineTransform and --apply must write native ANTs's bytes too.
//
//   pnpm --filter @neurodesk/hmc-registration test:browser
//
// It needs a Playwright Chromium (node node_modules/@playwright/test/cli.js install chromium), so
// it is not one of test/*.test.js; .github/workflows/hmc-registration.yml runs it in CI.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readMatTransform } from "../src/mat.js";
import { ARGV, NATIVE_MAT_SEED_4321_SHA256, NATIVE_MAT_SHA256, NATIVE_SHA256, assertRecoversShift, runNativeReferenceSteps } from "../test/expected.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };

// The kernel is linked with -pthread, so its memory is a SharedArrayBuffer: the page must be
// cross-origin isolated.
const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>hmc-registration worker</title>");
    return;
  }
  let body;
  if (path === "/tampered.wasm") {
    body = await readFile(join(root, "wasm", "hmc-registration.wasm"));
    body[body.length - 1] ^= 1;
  } else {
    const file = normalize(join(root, decodeURIComponent(path)));
    if (file.startsWith(root) && !file.slice(root.length).split(sep).includes("node_modules")) body = await readFile(file).catch(() => undefined);
  }
  if (!body) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
  response.end(body);
});

let browser;
let page;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), true);
});

after(async () => {
  await browser?.close();
  server.close();
});

// Starts a new worker, sends one run, and returns the reply with outputs as plain arrays.
function runInWorker(argv, kernel) {
  return page.evaluate(async ({ argv, kernel }) => {
    const inputs = {};
    for (const name of ["fixed.nii", "moving.nii"]) inputs[name] = new Uint8Array(await (await fetch(`/test/data/${name}`)).arrayBuffer());
    const worker = new Worker("/src/worker.js", { type: "module" });
    try {
      const reply = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ id: 1, argv, inputs, kernel });
      });
      const outputs = Object.fromEntries(Object.entries(reply.outputs ?? {}).map(([name, bytes]) => [name, Array.from(bytes)]));
      return { ...reply, outputs };
    } finally {
      worker.terminate();
    }
  }, { argv, kernel });
}

test("the worker recovers the known rigid shift and writes native ANTs's bytes", async () => {
  const reply = await runInWorker([...ARGV]);
  assert.equal(reply.error, undefined);
  assert.equal(reply.id, 1);
  assert.deepEqual(Object.keys(reply.outputs), ["out0GenericAffine.mat"]);
  const mat = Uint8Array.from(reply.outputs["out0GenericAffine.mat"]);
  assertRecoversShift(readMatTransform(mat));
  assert.equal(createHash("sha256").update(mat).digest("hex"), NATIVE_MAT_SHA256);
});

test("the worker refuses argv without --float 1", async () => {
  const reply = await runInWorker(ARGV.filter((token, i) => token !== "--float" && ARGV[i - 1] !== "--float"));
  assert.match(reply.error, /--float 1/);
});

test("the worker refuses a kernel whose bytes differ from the pinned build", async () => {
  const reply = await runInWorker([...ARGV], { wasm: "/tampered.wasm" });
  assert.match(reply.error, /checksum mismatch/);
});

test("after an aborted run the worker loads a new kernel and runs again", async () => {
  const missing = ARGV.map((token) => token.replace("moving.nii,", "missing.nii,"));
  const replies = await page.evaluate(async ({ argvs }) => {
    const inputs = {};
    for (const name of ["fixed.nii", "moving.nii"]) inputs[name] = new Uint8Array(await (await fetch(`/test/data/${name}`)).arrayBuffer());
    const worker = new Worker("/src/worker.js", { type: "module" });
    try {
      const replies = [];
      for (const [id, argv] of argvs.entries()) {
        const reply = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ id, argv, inputs: { ...inputs } });
        });
        replies.push({ id: reply.id, error: reply.error, log: reply.log, outputs: Object.keys(reply.outputs ?? {}) });
      }
      return replies;
    } finally {
      worker.terminate();
    }
  }, { argvs: [missing, [...ARGV]] });
  assert.match(replies[0].error, /aborted.*missing\.nii does not exist/s);
  assert.ok(replies[0].log.some((line) => line.includes("missing.nii does not exist")), replies[0].log.join("\n"));
  assert.equal(replies[1].error, undefined);
  assert.deepEqual(replies[1].outputs, ["out0GenericAffine.mat"]);
});

// Tolerance 0, as in test/programs.test.js: every file must be native ANTs's bytes.
test("in one worker, AverageAffineTransform, --apply and AverageImages write native ANTs's bytes", async () => {
  await page.evaluate(() => {
    self.hmcWorker = new Worker("/src/worker.js", { type: "module" });
    self.hmcNext = 0;
  });
  try {
    // Each run goes to the same worker; bytes cross the page boundary as plain arrays.
    const run = async (argv, inputs) => {
      const plain = Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, Array.from(bytes)]));
      const reply = await page.evaluate(({ argv, plain }) => new Promise((resolve, reject) => {
        const inputs = Object.fromEntries(Object.entries(plain).map(([name, values]) => [name, Uint8Array.from(values)]));
        self.hmcWorker.onmessage = ({ data }) => {
          const outputs = Object.fromEntries(Object.entries(data.outputs ?? {}).map(([name, bytes]) => [name, Array.from(bytes)]));
          resolve({ ...data, outputs });
        };
        self.hmcWorker.onerror = (event) => reject(new Error(event.message));
        self.hmcWorker.postMessage({ id: self.hmcNext++, argv, inputs });
      }), { argv, plain });
      if (reply.error) throw new Error(reply.error);
      return Object.fromEntries(Object.entries(reply.outputs).map(([name, values]) => [name, Uint8Array.from(values)]));
    };
    const pair = { fixed: await readFile(join(root, "test/data/fixed.nii")), moving: await readFile(join(root, "test/data/moving.nii")) };
    const files = await runNativeReferenceSteps(run, pair);
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256(files["seed12340GenericAffine.mat"]), NATIVE_MAT_SHA256);
    assert.equal(sha256(files["seed43210GenericAffine.mat"]), NATIVE_MAT_SEED_4321_SHA256);
    for (const [name, expected] of Object.entries(NATIVE_SHA256)) assert.equal(sha256(files[name]), expected, name);
  } finally {
    await page.evaluate(() => self.hmcWorker.terminate());
  }
});

// Before run() restored the kernel's stack pointer, one instance aborted on run 91 of this pair
// (#537). The worker now serves 200 runs with one kernel: no run aborts, so none loads a new one.
test("one worker completes 200 runs with native ANTs's bytes", async () => {
  const hashes = await page.evaluate(async ({ argv, runs }) => {
    const inputs = {};
    for (const name of ["fixed.nii", "moving.nii"]) inputs[name] = new Uint8Array(await (await fetch(`/test/data/${name}`)).arrayBuffer());
    const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const worker = new Worker("/src/worker.js", { type: "module" });
    try {
      const hashes = [];
      for (let id = 0; id < runs; id++) {
        const reply = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ id, argv, inputs: { ...inputs } });
        });
        if (reply.error) return [...hashes, `run ${id}: ${reply.error}`];
        hashes.push(hex(await crypto.subtle.digest("SHA-256", reply.outputs["out0GenericAffine.mat"])));
      }
      return hashes;
    } finally {
      worker.terminate();
    }
  }, { argv: [...ARGV], runs: 200 });
  assert.deepEqual(hashes, Array(200).fill(NATIVE_MAT_SHA256));
});
