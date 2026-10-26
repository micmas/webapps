import assert from "node:assert/strict";
import { test } from "node:test";
import { outputNames } from "../src/pipeline.js";

test("derivative names keep the BIDS suffix", () => {
  assert.deepEqual(outputNames("sub-01_dir-AP_dwi.nii.gz"), {
    image: "sub-01_dir-AP_desc-n4_dwi.nii.gz",
    bias: "sub-01_dir-AP_desc-n4_biasfield.nii.gz",
    mask: "sub-01_dir-AP_desc-brain_mask.nii.gz",
    bval: "sub-01_dir-AP_desc-n4_dwi.bval",
    bvec: "sub-01_dir-AP_desc-n4_dwi.bvec",
    sidecar: "sub-01_dir-AP_desc-n4_dwi.json",
  });
  assert.equal(outputNames("t1.nii").image, "t1_desc-n4.nii.gz");
});


test("derivative names replace a previous description entity", () => {
  assert.deepEqual(outputNames("sub-01_desc-denoise_dwi.nii.gz"), {
    image: "sub-01_desc-n4_dwi.nii.gz",
    bias: "sub-01_desc-n4_biasfield.nii.gz",
    mask: "sub-01_desc-brain_mask.nii.gz",
    bval: "sub-01_desc-n4_dwi.bval",
    bvec: "sub-01_desc-n4_dwi.bvec",
    sidecar: "sub-01_desc-n4_dwi.json",
  });
});
