import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readNiftiFrames } from "../../components/src/file-io/NiftiUtils.js";
import { loadHmcRegistration } from "../src/node.js";
import { TRANSFORM_ORDER_CASES, transformOrderInputs } from "./transform-order-fixture.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("--apply reverses native ANTs argument order while the last sampling transform acts first", async () => {
  const reference = JSON.parse(await readFile(new URL("../validation/transform-order-reference.json", import.meta.url)));
  const image = await readFile(new URL("./data/fixed.nii", import.meta.url));
  assert.equal(sha256(image), reference.imageSha256);
  const inputs = transformOrderInputs(image);
  const ants = await loadHmcRegistration();
  const actual = {};
  for (const [name, chain] of Object.entries(TRANSFORM_ORDER_CASES)) {
    const { outputs } = ants.run(["--apply", "fixed.nii", "fixed.nii", "out.nii", "Linear", "0", ...chain], inputs);
    const values = readNiftiFrames(outputs["out.nii"]).data;
    assert.ok(values.every(Number.isFinite));
    actual[name] = sha256(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  for (const [chain, reversed, analytic] of [
    ["rot-trans", "trans-rot", "rt-single"],
    ["trans-rot", "rot-trans", "tr-single"],
    ["rot-inverse-trans", "inverse-trans-rot", "rinvt-single"],
  ]) {
    assert.equal(actual[chain], reference.nativeVoxelSha256[reversed], `${chain}: reverse the native -t list`);
    assert.notEqual(actual[chain], reference.nativeVoxelSha256[chain], `${chain}: the opposite order differs`);
    assert.equal(actual[chain], actual[analytic], `${chain}: analytical output-to-input sampling composition`);
    assert.equal(actual[analytic], reference.nativeVoxelSha256[analytic], `${analytic}: native single-transform control`);
  }
});
