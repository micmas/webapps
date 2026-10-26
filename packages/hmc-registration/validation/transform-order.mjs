// Reproduce #566 with the committed WASM and an independently installed native ANTs entry.
// node .../transform-order.mjs NEW_OUTPUT_DIRECTORY ANTSPYX_PYTHON
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readNiftiFrames } from "../../components/src/file-io/NiftiUtils.js";
import { loadHmcRegistration } from "../src/node.js";
import { TRANSFORM_ORDER_CASES, transformOrderInputs } from "../test/transform-order-fixture.mjs";

const [directory, python] = process.argv.slice(2);
assert.ok(directory && python, "Pass a new output directory and the antspyx Python executable.");
const out = resolve(directory);
await mkdir(out);
const image = await readFile(new URL("../test/data/fixed.nii", import.meta.url));
const inputs = transformOrderInputs(image);
for (const [name, bytes] of Object.entries(inputs)) await writeFile(join(out, name), bytes);
await writeFile(join(out, "cases.json"), JSON.stringify(TRANSFORM_ORDER_CASES, null, 2));
const ants = await loadHmcRegistration();
const images = {};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [name, chain] of Object.entries(TRANSFORM_ORDER_CASES)) {
  const { outputs } = ants.run(["--apply", "fixed.nii", "fixed.nii", "out.nii", "Linear", "0", ...chain], inputs);
  await writeFile(join(out, `wasm-${name}.nii`), outputs["out.nii"]);
  images[`wasm-${name}`] = readNiftiFrames(outputs["out.nii"]).data;
}
execFileSync(python, [fileURLToPath(new URL("./transform-order-native.py", import.meta.url)), out], {
  env: { ...process.env, ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS: "1" }, stdio: "inherit", timeout: 60000,
});
const native = JSON.parse(await readFile(join(out, "native.json")));
const nativeVoxelSha256 = {};
for (const name of Object.keys(TRANSFORM_ORDER_CASES)) {
  const data = readNiftiFrames(await readFile(join(out, `native-${name}.nii`))).data;
  images[`native-${name}`] = data;
  nativeVoxelSha256[name] = sha256(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}
const compare = (left, right) => {
  const a = images[left];
  const b = images[right];
  assert.equal(a.length, b.length);
  let maxAbsoluteDifference = 0;
  let differingVoxels = 0;
  for (let i = 0; i < a.length; i++) {
    assert.ok(Number.isFinite(a[i]) && Number.isFinite(b[i]));
    const difference = Math.abs(a[i] - b[i]);
    if (difference !== 0) differingVoxels++;
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
  }
  return { maxAbsoluteDifference, differingVoxels };
};
const checks = {};
for (const [chain, reversed, analytic] of [
  ["rot-trans", "trans-rot", "rt-single"],
  ["trans-rot", "rot-trans", "tr-single"],
  ["rot-inverse-trans", "inverse-trans-rot", "rinvt-single"],
]) {
  checks[chain] = {
    sameNativeOrder: compare(`wasm-${chain}`, `native-${chain}`),
    reversedNativeOrder: compare(`wasm-${chain}`, `native-${reversed}`),
    analyticalComposite: compare(`wasm-${chain}`, `wasm-${analytic}`),
    nativeSingleComposite: compare(`wasm-${analytic}`, `native-${analytic}`),
  };
  assert.equal(checks[chain].reversedNativeOrder.differingVoxels, 0);
  assert.equal(checks[chain].analyticalComposite.differingVoxels, 0);
  assert.equal(checks[chain].nativeSingleComposite.differingVoxels, 0);
  assert.ok(checks[chain].sameNativeOrder.maxAbsoluteDifference > 1);
}
const report = {
  imageSha256: sha256(image),
  wasmSha256: sha256(await readFile(new URL("../wasm/hmc-registration.wasm", import.meta.url))),
  native, nativeVoxelSha256, checks,
};
await writeFile(join(out, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(checks, null, 2));
