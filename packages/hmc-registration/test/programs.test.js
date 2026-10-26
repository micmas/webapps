// AverageImages, AverageAffineTransform and --apply against native ANTs 52bc0ab.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkArguments, createHmcRegistration, programOf, readMatTransform } from "../src/index.js";
import { loadHmcRegistration } from "../src/node.js";
import {
  ARGV,
  INTERPOLATIONS,
  NATIVE_MAT_SEED_4321_SHA256,
  NATIVE_MAT_SHA256,
  NATIVE_SHA256,
  assertRecoversShift,
  centralRelativeError,
  niftiVoxels,
  runNativeReferenceSteps,
} from "./expected.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const data = (name) => readFile(new URL(`./data/${name}`, import.meta.url));
const pair = async () => ({ fixed: await data("fixed.nii"), moving: await data("moving.nii") });

test("argv[0] selects the program, and only antsRegistration needs --float 1 and a seed", () => {
  assert.equal(programOf([...ARGV]), "antsRegistration");
  assert.equal(programOf(["AverageImages", "3", "a.nii", "0", "b.nii"]), "AverageImages");
  assert.equal(programOf(["AverageAffineTransform", "3", "a.mat", "b.mat"]), "AverageAffineTransform");
  assert.equal(programOf(["--apply", "f.nii", "m.nii", "o.nii", "Linear", "0", "t.mat"]), "--apply");
  assert.doesNotThrow(() => checkArguments(["AverageImages", "3", "a.nii", "0", "b.nii"]));
  assert.doesNotThrow(() => checkArguments(["--apply", "f.nii", "m.nii", "o.nii", "Linear", "0", "inverse:t.mat"]));
});

test("arguments of AverageImages, AverageAffineTransform and --apply cannot name a directory", () => {
  const refused = [
    ["AverageImages", "3", "../a.nii", "0", "b.nii"],
    ["AverageImages", "3", "/a.nii", "0", "b.nii"],
    ["AverageAffineTransform", "3", "sub/a.mat", "b.mat"],
    ["--apply", "f.nii", "m.nii", "o.nii", "Linear", "0", "inverse:../t.mat"],
    ["--apply", "f.nii", "m.nii", "..", "Linear", "0", "t.mat"],
  ];
  for (const argv of refused) assert.throws(() => checkArguments(argv), /plain file names/, argv.join(" "));
});

// Tolerance 0: every file must be native ANTs's bytes (NATIVE_SHA256).
test("the SHORELine steps write native ANTs's bytes", async () => {
  const ants = await loadHmcRegistration();
  const files = await runNativeReferenceSteps((argv, inputs) => ants.run(argv, inputs).outputs, await pair());
  assert.equal(sha256(files["seed12340GenericAffine.mat"]), NATIVE_MAT_SHA256);
  assert.equal(sha256(files["seed43210GenericAffine.mat"]), NATIVE_MAT_SEED_4321_SHA256);
  for (const [name, expected] of Object.entries(NATIVE_SHA256)) assert.equal(sha256(files[name]), expected, name);

  // The average of two estimates of one shift is that shift, as a double MatrixOffsetTransformBase.
  const average = readMatTransform(files["average.mat"]);
  assert.equal(average.transform, "MatrixOffsetTransformBase_double_3_3");
  assertRecoversShift({ ...average, transform: "AffineTransform_float_3_3" });

  // Each interpolator brings the moving image onto the fixed one: over the central 16^3 voxels the
  // moving image is 0.38 of the fixed maximum away; Linear 0.013, the B-splines 0.003, the sincs
  // at most 0.0064, nearest neighbour 0.075.
  const { fixed, moving } = await pair();
  const fixedVoxels = niftiVoxels(fixed);
  assert.ok(centralRelativeError(niftiVoxels(moving), fixedVoxels) > 0.3);
  for (const interpolation of INTERPOLATIONS) {
    const error = centralRelativeError(niftiVoxels(files[`apply-${interpolation.replace(/[[\]]/g, "")}.nii`]), fixedVoxels);
    assert.ok(error < (interpolation === "NearestNeighbor" ? 0.1 : 0.02), `${interpolation}: ${error}`);
  }
  // The interpolators differ from each other.
  assert.equal(new Set(INTERPOLATIONS.map((interpolation) => NATIVE_SHA256[`apply-${interpolation.replace(/[[\]]/g, "")}.nii`])).size, INTERPOLATIONS.length);

  // AverageImages without normalization is the voxel mean, to float precision (2^-23 relative).
  const mean = niftiVoxels(files["average-0.nii"]);
  const linear = niftiVoxels(files["apply-Linear.nii"]);
  mean.forEach((value, i) => {
    const expected = (fixedVoxels[i] + linear[i]) / 2;
    assert.ok(Math.abs(value - expected) <= 2 ** -23 * Math.max(1, Math.abs(expected)) * 2, `voxel ${i}: ${value} != ${expected}`);
  });
});

test("--apply refuses an unknown interpolation and keeps the kernel usable", async () => {
  const ants = await loadHmcRegistration();
  const { fixed, moving } = await pair();
  // The interpolation is checked before any file is read, so t.mat can be empty.
  const inputs = { "fixed.nii": fixed, "moving.nii": moving, "t.mat": new Uint8Array(0) };
  for (const interpolation of ["Cubic", "BSpline[6]", "Gaussian"]) {
    assert.throws(() => ants.run(["--apply", "fixed.nii", "moving.nii", "o.nii", interpolation, "0", "t.mat"], inputs), /--apply failed \(exit 1\).*Unknown interpolation/s, interpolation);
  }
  assert.throws(() => ants.run(["--apply", "fixed.nii", "moving.nii", "o.nii", "Linear", "zero", "t.mat"], inputs), /exit 1.*fill value is not a number/s);
  assert.throws(() => ants.run(["--apply", "fixed.nii", "moving.nii", "o.nii", "Linear", "0"], inputs), /exit 1.*at least one transform/s);
  assertRecoversShift(readMatTransform(ants.run([...ARGV], { "fixed.nii": fixed, "moving.nii": moving }).outputs["out0GenericAffine.mat"]));
});

test("--apply composes noncommuting transforms with the last argument acting first", async () => {
  const ants = await loadHmcRegistration();
  const fixed = await data("fixed.nii");
  const matrix = (name, values) => {
    const label = new TextEncoder().encode(`${name}\0`);
    const bytes = new Uint8Array(20 + label.length + 8 * values.length);
    const view = new DataView(bytes.buffer);
    [0, values.length, 1, 0, label.length].forEach((value, i) => view.setInt32(4 * i, value, true));
    bytes.set(label, 20);
    values.forEach((value, i) => view.setFloat64(20 + label.length + 8 * i, value, true));
    return bytes;
  };
  const affine = (scale, shift) => {
    const parameters = matrix("AffineTransform_double_3_3", [scale, 0, 0, 0, 1, 0, 0, 0, 1, shift, 0, 0]);
    const centre = matrix("fixed", [0, 0, 0]);
    const bytes = new Uint8Array(parameters.length + centre.length);
    bytes.set(parameters);
    bytes.set(centre, parameters.length);
    return bytes;
  };
  const inputs = {
    "fixed.nii": fixed,
    "moving.nii": fixed,
    "scale.mat": affine(2, 0),
    "shift.mat": affine(1, 1),
    "scale-after-shift.mat": affine(2, 2),
    "shift-after-scale.mat": affine(2, 1),
    "scale-after-inverse-shift.mat": affine(2, -2),
  };
  const apply = (transforms) => ants.run(["--apply", "fixed.nii", "moving.nii", "out.nii", "Linear", "0", ...transforms], inputs).outputs["out.nii"];
  const scaleAfterShift = sha256(apply(["scale-after-shift.mat"]));
  const shiftAfterScale = sha256(apply(["shift-after-scale.mat"]));
  assert.notEqual(scaleAfterShift, shiftAfterScale, "the image distinguishes the two compositions");
  assert.equal(sha256(apply(["scale.mat", "shift.mat"])), scaleAfterShift, "scale(shift(x)) = 2*x + 2");
  assert.equal(sha256(apply(["shift.mat", "scale.mat"])), shiftAfterScale, "shift(scale(x)) = 2*x + 1");
  assert.equal(sha256(apply(["scale.mat", "inverse:shift.mat"])), sha256(apply(["scale-after-inverse-shift.mat"])), "scale(inverseShift(x)) = 2*x - 2");
});

test("an input that argv names but inputs does not hold is refused before the kernel runs", async () => {
  const createModule = async () => ({ callMain: () => assert.fail("the kernel must not run"), stackSave: () => 0, stackRestore() {}, FS: { mkdir() {}, writeFile() {}, chdir() {}, readdir: () => [], rmdir() {} } });
  const ants = await createHmcRegistration({ createModule });
  const bytes = new Uint8Array(1);
  const refused = [
    [["AverageImages", "3", "a.nii", "0", "b.nii", "missing.nii"], { "b.nii": bytes }],
    [["AverageAffineTransform", "3", "a.mat", "-R", "missing.mat", "b.mat"], { "b.mat": bytes }],
    [["AverageAffineTransform", "3", "a.mat", "b.mat", "2", "-i", "missing.mat"], { "b.mat": bytes }],
    [["--apply", "f.nii", "missing.nii", "o.nii", "Linear", "0", "t.mat"], { "f.nii": bytes, "t.mat": bytes }],
    [["--apply", "f.nii", "m.nii", "o.nii", "Linear", "0", "inverse:missing.mat"], { "f.nii": bytes, "m.nii": bytes }],
  ];
  for (const [argv, inputs] of refused) assert.throws(() => ants.run(argv, inputs), /reads "missing\.(nii|mat)", which is not among the inputs/, argv.join(" "));
});
