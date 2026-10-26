import assert from "node:assert/strict";
import test from "node:test";
import { checkArguments, programOf } from "../src/index.js";

test("the SDC entry points dispatch independently of registration seed and precision flags", () => {
  for (const argv of [
    ["ImageMath", "3", "laplacian.nii", "Laplacian", "input.nii", "1.5", "1"],
    ["antsApplyTransforms", "-d", "3", "--float", "0", "-i", "labels.nii", "-r", "fixed.nii", "-o", "warped.nii", "-n", "MultiLabel", "-t", "[affine.mat,1]", "-t", "composite.h5"],
  ]) {
    assert.equal(programOf(argv), argv[0]);
    assert.deepEqual(checkArguments(argv), argv);
  }
});

test("the small ImageMath entry refuses other operations, dimensions and invalid sigma before calling ITK", () => {
  for (const argv of [
    ["ImageMath", "2", "out.nii", "Laplacian", "in.nii"],
    ["ImageMath", "3", "out.nii", "Grad", "in.nii"],
    ["ImageMath", "3", "out.nii", "Laplacian"],
    ...["NaN", "Infinity", "1e100", ".5", "2147483648"].map(sigma => ["ImageMath", "3", "out.nii", "Laplacian", "in.nii", sigma]),
  ]) assert.throws(() => checkArguments(argv), /ImageMath|sigma/);
});

test("SDC file arguments stay inside the private run directory", () => {
  assert.throws(() => checkArguments(["ImageMath", "3", "out.nii", "Laplacian", "../in.nii", "1.5"]), /plain file names/);
  assert.throws(() => checkArguments(["antsApplyTransforms", "-i", "in.nii", "-t", "[../affine.mat,1]"]), /plain file names/);
});
