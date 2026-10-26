// Regenerate synthetic references using unmodified ANTs v2.6.2 release executables.
// node sdc-native-reference.mjs BIN_DIRECTORY OUTPUT_DIRECTORY
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { runSdcSteps, sdcInputs } from "../test/sdc-fixture.mjs";
const [bin, directory] = process.argv.slice(2).map(value => resolve(value));
assert.ok(bin && directory, "Usage: sdc-native-reference.mjs BIN_DIRECTORY OUTPUT_DIRECTORY");
await mkdir(directory, { recursive: true });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const version = execFileSync(join(bin, "antsRegistration"), ["--version"], { encoding: "utf8" });
assert.match(version, /2\.6\.2-g52bc0ab/);
const binaries = Object.fromEntries(await Promise.all(["antsRegistration", "antsApplyTransforms", "ImageMath"].map(async name => [name, sha(await readFile(join(bin, name)))])));
const pinned = JSON.parse(await readFile(new URL("./sdc-entry-reference.json", import.meta.url)));
assert.deepEqual(binaries, pinned.binaries, "Use the checksum-verified pinned release executables");
const inputs = sdcInputs();
const outputs = await runSdcSteps(async (argv, files) => {
  const work = join(directory, `step-${(await readdir(directory)).length}`);
  await mkdir(work);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(work, name), bytes);
  const program = argv[0].startsWith("--") ? "antsRegistration" : argv[0];
  const args = program === "antsRegistration" ? argv : argv.slice(1);
  const log = execFileSync(join(bin, program), args, { cwd: work, encoding: "utf8", env: { ...process.env, ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS: "1" } });
  await writeFile(join(work, "stdout.log"), log);
  return Object.fromEntries(await Promise.all((await readdir(work)).filter(name => name !== "stdout.log" && !Object.hasOwn(files, name)).map(async name => [name, await readFile(join(work, name))])));
}, inputs);
const digest = (name, bytes) => sha(name.endsWith(".gz") ? gunzipSync(bytes) : bytes);
const report = { nativeRelease: pinned.nativeRelease, antsCommit: "52bc0ab588102682587303d31c720de94e6ef6c1", version, binaries, inputs: Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, sha(bytes)])), outputs: Object.fromEntries(Object.entries(outputs).filter(([name]) => name !== "composite.h5").map(([name, bytes]) => [name, digest(name, bytes)])) };
await writeFile(join(directory, "reference.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
