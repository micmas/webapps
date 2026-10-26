import { makeTestPair } from "../scripts/make-test-data.mjs";
import { transformOrderInputs } from "./transform-order-fixture.mjs";

/** Small deterministic images on the existing 32-cubed fixture grid. */
export function sdcInputs() {
  const { fixed, moving } = makeTestPair();
  const labels = fixed.slice();
  const mask = fixed.slice();
  const movingMask = fixed.slice();
  const labelView = new DataView(labels.buffer);
  const maskView = new DataView(mask.buffer);
  const movingMaskView = new DataView(movingMask.buffer);
  // Copy the fixture header, disable its identity qform, and give labels an oblique sform.
  labelView.setInt16(252, 0, true);
  const c = Math.cos(0.2), s = Math.sin(0.2);
  const axes = [[2 * c, -2 * s, 0], [2 * s, 2 * c, 0], [0, 0, 2]];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) labelView.setFloat32(280 + row * 16 + column * 4, axes[row][column], true);
  for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const voxel = x + 32 * (y + 32 * z);
    const inside = (x - 16) ** 2 + (y - 16) ** 2 + (z - 16) ** 2 < 12 ** 2;
    labelView.setInt16(352 + voxel * 2, inside ? (x < 16 ? 2 : 5) : 0, true);
    maskView.setInt16(352 + voxel * 2, inside ? 1 : 0, true);
    movingMaskView.setInt16(352 + voxel * 2, (x - 17) ** 2 + (y - 15) ** 2 + (z - 16) ** 2 < 12 ** 2 ? 1 : 0, true);
  }
  // An isolated label distinguishes Gaussian label voting from nearest-neighbor interpolation.
  labelView.setInt16(352 + (16 + 32 * (16 + 32 * 16)) * 2, 9, true);
  return { ...transformOrderInputs(fixed), "moving.nii": moving, "labels.nii": labels, "mask.nii": mask, "moving-mask.nii": movingMask };
}

/** ANTs-native argv, including the SDC weights and both stage masks. */
export async function runSdcSteps(run, initial = sdcInputs()) {
  const inputs = { ...initial }, outputs = {};
  const step = async argv => {
    const result = await run(argv, inputs);
    Object.assign(inputs, result);
    Object.assign(outputs, result);
  };
  for (const [name, sigma, normalize] of [["laplacian", "1.5", "1"], ["laplacian-ignored-flag", "1.5", "0"], ["laplacian-small-sigma", "0.5", "1"]]) {
    await step(["ImageMath", "3", `${name}.nii`, "Laplacian", "fixed.nii", sigma, normalize]);
  }
  await step(["antsApplyTransforms", "-d", "3", "-r", "fixed.nii", "-o", "CompositeTransform[composite.h5]", "-t", "rot.mat", "-t", "trans.mat"]);
  for (const interpolation of ["MultiLabel", "NearestNeighbor", "BSpline"]) {
    await step(["antsApplyTransforms", "-d", "3", "--float", "0", "-i", "labels.nii", "-r", "fixed.nii", "-o", `${interpolation}.nii`, "-n", interpolation, "-u", "float", "-t", "composite.h5", "-t", "[trans.mat,1]", "-t", "rot.mat"]);
  }
  for (const [name, transforms] of [["full-rot-trans", ["rot.mat", "trans.mat"]], ["full-trans-rot", ["trans.mat", "rot.mat"]], ["full-rt-single", ["rt.mat"]], ["full-tr-single", ["tr.mat"]]]) {
    await step(["antsApplyTransforms", "-d", "3", "--float", "0", "-i", "fixed.nii", "-r", "fixed.nii", "-o", `${name}.nii`, "-n", "Linear", "-u", "float", ...transforms.flatMap(name => ["-t", name])]);
  }
  const registration = ["--dimensionality", "3", "--float", "1", "--random-seed", "1234"];
  for (const [convergence, masks] of [["[5x2,1e-7,2]", "[mask.nii,moving-mask.nii]"], ["[3x1,1e-7,2]", "[moving-mask.nii,mask.nii]"]]) {
    registration.push("--transform", "SyN[0.1,3,0]", "--restrict-deformation", "0.1x1.0x0.1",
      "--metric", "CC[fixed.nii,moving.nii,1,2]", "--masks", masks,
      "--convergence", convergence, "--shrink-factors", "2x1", "--smoothing-sigmas", "1x0vox");
  }
  await step([...registration, "--output", "[syn,syn-warped.nii]"]);
  return outputs;
}
