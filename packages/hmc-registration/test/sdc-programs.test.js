import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { loadHmcRegistration } from "../src/node.js";
import { niftiVoxels } from "./expected.mjs";
import { runSdcSteps, sdcInputs } from "./sdc-fixture.mjs";

const reference = JSON.parse(await readFile(new URL("../validation/sdc-entry-reference.json", import.meta.url)));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("SDC Laplacian, full apply and restricted SyN reproduce pinned native ANTs", async () => {
  const inputs = sdcInputs();
  assert.deepEqual(Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, sha(bytes)])), reference.inputs);
  const ants = await loadHmcRegistration();
  const outputs = await runSdcSteps((argv, files) => ants.run(argv, files).outputs, inputs);
  for (const [name, expected] of Object.entries(reference.outputs)) {
    assert.ok(outputs[name]?.byteLength, name);
    assert.equal(sha(name.endsWith(".gz") ? gunzipSync(outputs[name]) : outputs[name]), expected, name);
  }
  // The final normalization flag is ignored by native ImageMath at the pinned commit.
  assert.deepEqual(outputs["laplacian.nii"], outputs["laplacian-ignored-flag.nii"]);
  assert.notDeepEqual(niftiVoxels(outputs["MultiLabel.nii"]), niftiVoxels(outputs["NearestNeighbor.nii"]));
  assert.ok(niftiVoxels(gunzipSync(outputs["syn0Warp.nii.gz"])).some(value => Math.abs(value) > 0.01), "restricted SyN must produce a nonidentity warp");
  // Full CLI order is native order, distinct from legacy --apply's reversed -t list.
  assert.deepEqual(outputs["full-rot-trans.nii"], outputs["full-tr-single.nii"]);
  assert.deepEqual(outputs["full-trans-rot.nii"], outputs["full-rt-single.nii"]);
  assert.notDeepEqual(outputs["full-rot-trans.nii"], outputs["full-trans-rot.nii"]);
});

test("missing SDC inputs fail before entering ITK and leave the kernel usable", async () => {
  const ants = await loadHmcRegistration();
  assert.throws(() => ants.run(["ImageMath", "3", "o.nii", "Laplacian", "absent.nii", "1.5"]), /not among the inputs/);
  assert.throws(() => ants.run(["antsApplyTransforms", "-i", "missing.nii", "-r", "fixed.nii", "-t", "identity"], { "fixed.nii": sdcInputs()["fixed.nii"] }), /not among the inputs/);
  const { outputs } = ants.run(["ImageMath", "3", "o.nii", "Laplacian", "fixed.nii", "1.5"], sdcInputs());
  assert.equal(sha(outputs["o.nii"]), reference.outputs["laplacian.nii"]);
});
