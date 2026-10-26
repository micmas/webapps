import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { makeTestPair } from "../scripts/make-test-data.mjs";
import { checkArguments, createHmcRegistration, readMatTransform } from "../src/index.js";
import { KERNEL, loadHmcRegistration, readHmcRegistrationWasm } from "../src/node.js";
import { ARGV, NATIVE_MAT_SHA256, assertRecoversShift } from "./expected.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const data = (name) => readFile(new URL(`./data/${name}`, import.meta.url));
const inputs = async () => ({ "fixed.nii": await data("fixed.nii"), "moving.nii": await data("moving.nii") });
const withSeed = (seed) => ARGV.map((token, i) => (ARGV[i - 1] === "--random-seed" ? seed : token));

test("the committed test pair is what the script writes", async () => {
  const { fixed, moving } = makeTestPair();
  assert.deepEqual(new Uint8Array(await data("fixed.nii")), fixed);
  assert.deepEqual(new Uint8Array(await data("moving.nii")), moving);
});

test("argv without --float 1 or an explicit seed is refused", () => {
  const without = (flag) => ARGV.filter((_, i) => ARGV[i] !== flag && ARGV[i - 1] !== flag);
  assert.equal(checkArguments([...ARGV]).length, ARGV.length);
  assert.throws(() => checkArguments(without("--float")), /--float 1/);
  assert.throws(() => checkArguments(ARGV.map((token, i) => (ARGV[i - 1] === "--float" ? "0" : token))), /--float 1/);
  assert.throws(() => checkArguments([...ARGV, "--float", "1"]), /--float 1/);
  assert.throws(() => checkArguments(without("--random-seed")), /--random-seed/);
  for (const seed of ["0", "-1", "1.5", "seed", "2147483648", "01"]) assert.throws(() => checkArguments(withSeed(seed)), /--random-seed/, seed);
  assert.equal(checkArguments(withSeed("2147483647")).length, ARGV.length);
  assert.throws(() => checkArguments("--float 1"), /array of strings/);
});

test("refused argv and unsafe input names never reach the kernel", async () => {
  const createModule = async () => ({ callMain: () => assert.fail("the kernel must not run"), stackSave: () => 0, stackRestore() {} });
  const ants = await createHmcRegistration({ createModule });
  assert.throws(() => ants.run(ARGV.filter((token) => token !== "--float" && token !== "1")), /--float 1/);
  for (const name of ["../fixed.nii", "a/b.nii", "..", ""]) assert.throws(() => ants.run([...ARGV], { [name]: new Uint8Array(1) }), /plain file names/);
});

test("a kernel whose bytes differ from the pinned build is refused before it is loaded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hmc-registration-kernel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wasm = join(root, "hmc-registration.wasm");
  const module = join(root, "hmc-registration.mjs");
  const bytes = await readFile(KERNEL.wasm);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(wasm, bytes);
  await copyFile(KERNEL.module, module);
  await assert.rejects(readHmcRegistrationWasm(pathToFileURL(wasm)), /checksum mismatch/);
  await assert.rejects(loadHmcRegistration({ module: pathToFileURL(module), wasm: pathToFileURL(wasm) }), /checksum mismatch/);
});

test("run(argv) recovers the known rigid shift and writes native ANTs's bytes", async () => {
  const ants = await loadHmcRegistration();
  assert.equal(ants.memoryBytes(), 256 * 2 ** 20);
  const { outputs } = ants.run([...ARGV], await inputs());
  assert.deepEqual(Object.keys(outputs), ["out0GenericAffine.mat"]);
  const mat = outputs["out0GenericAffine.mat"];
  assertRecoversShift(readMatTransform(mat));
  assert.equal(sha256(mat), NATIVE_MAT_SHA256);
  // The same kernel serves later runs, with the same result.
  const again = ants.run([...ARGV], await inputs());
  assert.deepEqual(again.outputs["out0GenericAffine.mat"], mat);
});

test("a .nii.gz input is read as gzipped NIfTI", async () => {
  const ants = await loadHmcRegistration();
  const argv = ARGV.map((token) => token.replace("fixed.nii,", "fixed.nii.gz,"));
  const { outputs } = ants.run(argv, { "fixed.nii.gz": gzipSync(await data("fixed.nii")), "moving.nii": await data("moving.nii") });
  assert.equal(sha256(outputs["out0GenericAffine.mat"]), NATIVE_MAT_SHA256);
});

test("the seed reaches the kernel", async () => {
  const ants = await loadHmcRegistration();
  const first = ants.run(withSeed("1234"), await inputs()).outputs["out0GenericAffine.mat"];
  const second = ants.run(withSeed("4321"), await inputs()).outputs["out0GenericAffine.mat"];
  assert.notDeepEqual(first, second);
  assertRecoversShift(readMatTransform(second));
});

test("the kernel refuses every mode but 3D float", async () => {
  const lines = [];
  const ants = await loadHmcRegistration({ onLog: (line) => lines.push(line) });
  const twoD = ARGV.map((token, i) => (ARGV[i - 1] === "--dimensionality" ? "2" : token));
  const pair = await inputs();
  assert.throws(() => ants.run(twoD, pair), /exit 1.*supports only 3D float/);
  assert.ok(lines.some((line) => line.includes("supports only 3D float")), lines.join("\n"));
  // A failed run leaves the kernel usable.
  assertRecoversShift(readMatTransform(ants.run([...ARGV], await inputs()).outputs["out0GenericAffine.mat"]));
});

test("an output prefix in a missing directory is refused before the kernel runs", async () => {
  const createModule = async () => {
    const files = new Set(["/"]);
    return {
      callMain: () => assert.fail("the kernel must not run"),
      stackSave: () => 0,
      stackRestore() {},
      FS: {
        mkdir: (path) => files.add(path),
        writeFile: () => {},
        chdir: () => {},
        readdir: () => [],
        rmdir: () => {},
        isDir: () => true,
        stat: (path) => {
          if (!files.has(path)) throw new Error("ENOENT");
          return { mode: 0 };
        },
      },
    };
  };
  const ants = await createHmcRegistration({ createModule });
  const argv = ARGV.map((token) => (token === "[out]" ? "[sub/out]" : token));
  const pair = await inputs();
  assert.throws(() => ants.run(argv, pair), /output directory "sub" does not exist/);
});

test("output paths cannot escape the private run directory", async () => {
  const ants = await loadHmcRegistration();
  const pair = await inputs();
  for (const output of ["[../out]", "[/out]", "[/tmp/out]", "[out,../warped.nii]", "[out,warped.nii,/inverse.nii]"]) {
    for (const flag of ["--output", "-o"]) {
      const argv = ARGV.map((token) => token === "[out]" ? output : token === "--output" ? flag : token);
      assert.throws(() => ants.run(argv, pair), /private run directory/, `${flag} ${output}`);
    }
  }
  const { outputs } = ants.run([...ARGV], pair);
  assert.deepEqual(Object.keys(outputs), ["out0GenericAffine.mat"]);
  assert.equal(sha256(outputs["out0GenericAffine.mat"]), NATIVE_MAT_SHA256);
});

test("an aborted run reports the log's cause and marks the kernel stopped", async () => {
  const ants = await loadHmcRegistration();
  const argv = ARGV.map((token) => token.replace("moving.nii,", "missing.nii,"));
  const pair = await inputs();
  let caught;
  assert.throws(() => ants.run(argv, pair), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.aborted, true);
  assert.match(caught.message, /aborted.*missing\.nii does not exist/s);
  assert.ok(caught.log.some((line) => line.includes("missing.nii does not exist")), caught.log.join("\n"));
  assert.throws(() => ants.run([...ARGV], {}), (later) => later.aborted === true && /load a new one/.test(later.message));
  // A new kernel runs normally.
  const fresh = await loadHmcRegistration();
  assertRecoversShift(readMatTransform(fresh.run([...ARGV], await inputs()).outputs["out0GenericAffine.mat"]));
});

// A fake kernel whose callMain and stackRestore can each throw. Its file system holds only the
// directories that run() makes.
function fakeKernel({ callMain, stackRestore }) {
  const files = new Set(["/"]);
  return async () => ({
    callMain,
    stackSave: () => 0,
    stackRestore,
    FS: {
      mkdir: (path) => files.add(path),
      writeFile: () => {},
      chdir: () => {},
      readdir: () => [],
      rmdir: () => {},
      isDir: () => true,
      stat: (path) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return { mode: 0 };
      },
    },
  });
}

test("a trap is reported even when stackRestore then fails, and the console comes back", async () => {
  const { log, error } = console;
  const createModule = fakeKernel({
    callMain: () => {
      throw new Error("memory access out of bounds");
    },
    stackRestore: () => {
      throw new Error("stackRestore failed");
    },
  });
  const ants = await createHmcRegistration({ createModule });
  const pair = await inputs();
  assert.throws(() => ants.run([...ARGV], pair), (caught) => caught.aborted === true && /memory access out of bounds/.test(caught.message) && !/stackRestore failed/.test(caught.message));
  assert.equal(console.log, log);
  assert.equal(console.error, error);
  assert.throws(() => ants.run([...ARGV], pair), (later) => later.aborted === true && /load a new one/.test(later.message));
});

test("a stackRestore that fails after a clean run stops the kernel", async () => {
  const { log, error } = console;
  const createModule = fakeKernel({
    callMain: () => 0,
    stackRestore: () => {
      throw new Error("stackRestore failed");
    },
  });
  const ants = await createHmcRegistration({ createModule });
  const pair = await inputs();
  assert.throws(() => ants.run([...ARGV], pair), (caught) => caught.aborted === true && /stackRestore failed/.test(caught.message));
  assert.equal(console.log, log);
  assert.equal(console.error, error);
});

test("a kernel without stackSave and stackRestore is refused", async () => {
  const createModule = async () => ({ callMain: () => assert.fail("the kernel must not run") });
  await assert.rejects(createHmcRegistration({ createModule }), /stackSave and stackRestore/);
});

// Emscripten's callMain leaves argv on the 64 KiB stack. Before run() restored the stack pointer,
// one instance aborted on run 91 of this pair and on run 27 of NiFreeze's longer command lines
// (#537). About 35 s in Node.
test("one kernel instance completes 200 runs with native ANTs's bytes", async () => {
  const ants = await loadHmcRegistration();
  const pair = await inputs();
  const stack = ants.stackPointer();
  for (let run = 0; run < 200; run++) {
    const { outputs } = ants.run([...ARGV], pair);
    assert.equal(sha256(outputs["out0GenericAffine.mat"]), NATIVE_MAT_SHA256, `run ${run}`);
    assert.equal(ants.stackPointer(), stack, `stack pointer after run ${run}`);
  }
  assert.equal(ants.memoryBytes(), 256 * 2 ** 20);
});

test("run(argv) leaves the caller's argv as it was, so it can be run again", async () => {
  const ants = await loadHmcRegistration();
  const pair = await inputs();
  const argv = [...ARGV];
  for (let run = 0; run < 3; run++) assert.equal(sha256(ants.run(argv, pair).outputs["out0GenericAffine.mat"]), NATIVE_MAT_SHA256);
  assert.deepEqual(argv, ARGV);
});

test("a truncated or foreign .mat file is refused", () => {
  assert.throws(() => readMatTransform(new Uint8Array(10)), /Truncated/);
  assert.throws(() => readMatTransform(new Uint8Array(0)), /Not an ITK transform/);
});
