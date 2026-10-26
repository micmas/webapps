// The n4 command line on small phantoms with a supplied mask (MindGrab's CPU run on real data is
// validation/cli-check.mjs's), its refusals, and the executable's commands.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { checkInstallation, companions, correct } from "../src/node.js";

const bin = fileURLToPath(new URL("../bin/n4.js", import.meta.url));
const scratch = () => mkdtemp(join(process.env.TMPDIR || tmpdir(), "n4-node-"));

// A block of tissue that a ramp from 0.6 to 1.4 across x shades, in a zero background, as the
// app's e2e fixture: b0 volumes at 100, diffusion-weighted ones at 40.
function series({ nx = 24, ny = 20, nz = 16, bvals = [0, 1000, 0] } = {}) {
  const voxels = nx * ny * nz;
  const frames = bvals.length;
  const data = new Float32Array(voxels * frames);
  const mask = new Uint8Array(voxels);
  for (let z = 3; z < nz - 3; z++) {
    for (let y = 3; y < ny - 3; y++) {
      for (let x = 3; x < nx - 3; x++) {
        const i = x + nx * (y + ny * z);
        mask[i] = 1;
        for (let f = 0; f < frames; f++) data[f * voxels + i] = (bvals[f] > 50 ? 40 : 100) * (0.6 + (0.8 * x) / (nx - 1));
      }
    }
  }
  const dims = frames > 1 ? [4, nx, ny, nz, frames, 1, 1, 1] : [3, nx, ny, nz, 1, 1, 1, 1];
  const header = createNiftiHeaderFromVolume({ hdr: { dims, pixDims: [1, 4, 4, 4, 1, 1, 1, 1] } });
  const maskHeader = createNiftiHeaderFromVolume({ hdr: { dims: [3, nx, ny, nz, 1, 1, 1, 1], pixDims: [1, 4, 4, 4, 1, 1, 1, 1] } });
  return {
    nifti: Buffer.from(createNiftiFromData(data, header, { dims: frames > 1 ? [nx, ny, nz, frames] : [nx, ny, nz] })),
    maskNifti: Buffer.from(createNiftiFromData(mask, maskHeader, { dims: [nx, ny, nz] })),
    data,
    mask,
    voxels,
  };
}

function variation(data, mask) {
  const values = Array.from(mask.keys()).filter((i) => mask[i]).map((i) => data[i]);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean;
}

async function writeSeries(dir, options) {
  const input = series(options);
  const image = join(dir, "sub-01_dwi.nii.gz");
  await writeFile(image, gzipSync(input.nifti));
  const mask = join(dir, "brain.nii.gz");
  await writeFile(mask, gzipSync(input.maskNifti));
  return { ...input, image, maskPath: mask };
}

const read = async (path) => readNiftiFrames(gunzipSync(await readFile(path)));

test("a DWI is corrected by one field fitted to its mean b0, with every companion passed through", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    await writeFile(join(dir, "sub-01_dwi.bval"), "0 1000 0\n");
    await writeFile(join(dir, "sub-01_dwi.bvec"), "0 1 0\n0 0 0\n0 0 0\n");
    await writeFile(join(dir, "sub-01_dwi.json"), JSON.stringify({ RepetitionTime: 3 }));
    const out = join(dir, "out");
    const result = await correct({ input: input.image, output: out, mask: input.maskPath });
    assert.deepEqual((await readdir(out)).sort(), [
      "sub-01_desc-brain_mask.nii.gz",
      "sub-01_desc-n4_biasfield.nii.gz",
      "sub-01_desc-n4_dwi.bval",
      "sub-01_desc-n4_dwi.bvec",
      "sub-01_desc-n4_dwi.json",
      "sub-01_desc-n4_dwi.nii.gz",
    ]);
    assert.equal(result.provenance.procedure, "mrtrix-dwibiascorrect-ants");
    assert.equal(result.provenance.mask, "supplied");
    assert.equal(result.provenance.referenceVolumes, 2);
    assert.equal(await readFile(join(out, "sub-01_desc-n4_dwi.bval"), "utf8"), "0 1000 0\n");
    assert.deepEqual(JSON.parse(await readFile(join(out, "sub-01_desc-n4_dwi.json"), "utf8")), {
      RepetitionTime: 3,
      Description: "Bias-field correction with ANTs N4 (MRtrix dwibiascorrect ants procedure)",
    });
    const image = await read(join(out, "sub-01_desc-n4_dwi.nii.gz"));
    assert.equal(image.frames, 3);
    assert.ok(variation(image.data, input.mask) < variation(input.data, input.mask) / 2);
    // The b = 1000 volume keeps its ratio to the b0 volumes: one field corrects all of them.
    const centre = Array.from(input.mask.keys()).filter((i) => input.mask[i])[100];
    assert.ok(Math.abs(image.data[input.voxels + centre] / image.data[centre] - 0.4) < 1e-4);
    assert.deepEqual(Array.from((await read(join(out, "sub-01_desc-brain_mask.nii.gz"))).data), Array.from(input.mask));
    assert.equal((await read(join(out, "sub-01_desc-n4_biasfield.nii.gz"))).frames, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 3D image is corrected directly and writes no companions it was not given", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir, { bvals: [0] });
    const out = join(dir, "out");
    const result = await correct({ input: input.image, output: out, mask: input.maskPath });
    assert.deepEqual((await readdir(out)).sort(), ["sub-01_desc-brain_mask.nii.gz", "sub-01_desc-n4_biasfield.nii.gz", "sub-01_desc-n4_dwi.nii.gz"]);
    assert.equal(result.provenance.procedure, "n4");
    assert.equal(result.provenance.multiplier, null);
    assert.ok(variation((await read(join(out, "sub-01_desc-n4_dwi.nii.gz"))).data, input.mask) < variation(input.data, input.mask) / 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("200 consecutive corrections preserve the corrected image bytes", async () => {
  const dir = await scratch();
  try {
    const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, 2, 2, 2, 1, 1, 1, 1], pixDims: [1, 4, 4, 4, 1, 1, 1, 1] } });
    const input = join(dir, "tiny.nii");
    const mask = join(dir, "mask.nii");
    await writeFile(input, new Uint8Array(createNiftiFromData(Float32Array.from({ length: 8 }, (_, i) => 100 + 10 * i), header, { dims: [2, 2, 2] })));
    await writeFile(mask, new Uint8Array(createNiftiFromData(new Uint8Array(8).fill(1), header, { dims: [2, 2, 2] })));
    let expected;
    for (let run = 0; run < 200; run++) {
      const output = join(dir, `out-${run}`);
      await correct({ input, output, mask });
      const bytes = gunzipSync(await readFile(join(output, "tiny_desc-n4.nii.gz")));
      expected ??= bytes;
      assert.deepEqual(bytes, expected, `correction ${run + 1}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("companions pair by stem unless named, and a named file must exist", async () => {
  const dir = await scratch();
  try {
    await writeFile(join(dir, "a_dwi.bval"), "0");
    await writeFile(join(dir, "other.bvec"), "0\n0\n0");
    await writeFile(join(dir, "other.nii.gz"), "");
    assert.deepEqual(await companions(join(dir, "a_dwi.nii.gz")), { bval: join(dir, "a_dwi.bval"), bvec: null, json: null });
    assert.deepEqual(await companions(join(dir, "a_dwi.nii.gz"), { bvec: join(dir, "other.bvec") }), { bval: join(dir, "a_dwi.bval"), bvec: join(dir, "other.bvec"), json: null });
    await assert.rejects(companions(join(dir, "a_dwi.nii.gz"), { json: join(dir, "missing.json") }), /does not exist/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("companions pair .bvals and .bvecs by stem and FSL's bvals and bvecs beside a series", async () => {
  const dir = await scratch();
  try {
    await writeFile(join(dir, "a_dwi.bvals"), "0");
    await writeFile(join(dir, "a_dwi.bvecs"), "0\n0\n0");
    assert.deepEqual(await companions(join(dir, "a_dwi.nii.gz")), { bval: join(dir, "a_dwi.bvals"), bvec: join(dir, "a_dwi.bvecs"), json: null });
    await rm(join(dir, "a_dwi.bvals"));
    await rm(join(dir, "a_dwi.bvecs"));
    await writeFile(join(dir, "bvals"), "0");
    await writeFile(join(dir, "bvecs"), "0\n0\n0");
    await writeFile(join(dir, "T1w.nii.gz"), "");
    assert.deepEqual(await companions(join(dir, "data.nii.gz")), { bval: join(dir, "bvals"), bvec: join(dir, "bvecs"), json: null });
    // A 3D image takes no gradient file it does not name, and gradient files of another image stay theirs.
    assert.deepEqual(await companions(join(dir, "T1w.nii.gz"), {}, { volumes: 1 }), { bval: null, bvec: null, json: null });
    await writeFile(join(dir, "b.nii.gz"), "");
    await writeFile(join(dir, "b.bval"), "0");
    assert.equal((await companions(join(dir, "data.nii.gz"))).bval, join(dir, "bvals"));
    await writeFile(join(dir, "orphan.bvals"), "0");
    await assert.rejects(companions(join(dir, "data.nii.gz")), /holds 2 bval files \(bvals, orphan\.bvals\).*--bval/);
    assert.equal((await companions(join(dir, "data.nii.gz"), { bval: join(dir, "bvals") })).bval, join(dir, "bvals"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an FSL layout fits the field to the mean b0 and passes bvals and bvecs through", async () => {
  const dir = await scratch();
  try {
    const input = series();
    const image = join(dir, "data.nii.gz");
    await writeFile(image, gzipSync(input.nifti));
    await writeFile(join(dir, "nodif_brain_mask.nii.gz"), gzipSync(input.maskNifti));
    await writeFile(join(dir, "bvals"), "0 1000 0\n");
    await writeFile(join(dir, "bvecs"), "0 1 0\n0 0 0\n0 0 0\n");
    const out = join(dir, "out");
    const result = await correct({ input: image, output: out, mask: join(dir, "nodif_brain_mask.nii.gz") });
    assert.equal(result.provenance.referenceVolumes, 2);
    const files = await readdir(out);
    assert.equal(await readFile(join(out, files.find((name) => name.endsWith(".bval"))), "utf8"), "0 1000 0\n");
    assert.equal(await readFile(join(out, files.find((name) => name.endsWith(".bvec"))), "utf8"), "0 1 0\n0 0 0\n0 0 0\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sidecar named with --json must parse to an object; one beside the image is left out", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir, { bvals: [0] });
    for (const [file, content, error] of [["bad.json", "{ not json", /is not valid JSON/], ["array.json", "[1, 2]", /must hold a JSON object/], ["scalar.json", "3", /must hold a JSON object/]]) {
      await writeFile(join(dir, file), content);
      await assert.rejects(correct({ input: input.image, output: join(dir, `out-${file}`), mask: input.maskPath, json: join(dir, file) }), error);
    }
    await writeFile(join(dir, "sub-01_dwi.json"), "{ not json");
    const result = await correct({ input: input.image, output: join(dir, "out"), mask: input.maskPath });
    assert.ok(!result.files.some(({ role }) => role === "sidecar"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses what the web app refuses", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    const out = (name) => join(dir, name);
    await assert.rejects(correct({ input: join(dir, "scan.dcm"), output: out("a") }), /not a NIfTI image/);
    await assert.rejects(correct({ input: join(dir, "missing.nii.gz"), output: out("b") }), /does not exist/);
    await writeFile(join(dir, "sub-01_dwi.bval"), "0 1000\n");
    await assert.rejects(correct({ input: input.image, output: out("c"), mask: input.maskPath }), /has 3 volumes but the bval file lists 2/);
    await writeFile(join(dir, "sub-01_dwi.bval"), "1000 2000 1000\n");
    await assert.rejects(correct({ input: input.image, output: out("d"), mask: input.maskPath }), /no b0 volume/);
    await rm(join(dir, "sub-01_dwi.bval"));
    const other = series({ nx: 12, bvals: [0] });
    await writeFile(join(dir, "small.nii"), other.maskNifti);
    await assert.rejects(correct({ input: input.image, output: out("e"), mask: join(dir, "small.nii") }), /not on the image grid/);
    await writeFile(join(dir, "four-d.nii"), input.nifti);
    await assert.rejects(correct({ input: input.image, output: out("f"), mask: join(dir, "four-d.nii") }), /single 3D image/);
    await writeFile(join(dir, "empty.nii"), series({ bvals: [0] }).maskNifti.fill(0, 352));
    await assert.rejects(correct({ input: input.image, output: out("g"), mask: join(dir, "empty.nii") }), /no voxels/);
    await writeFile(join(dir, "used"), "");
    await assert.rejects(correct({ input: input.image, output: dir, mask: input.maskPath }), /is not empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-check corrects the phantom in this runtime", async () => {
  const report = await checkInstallation();
  assert.ok(report.phantomVariation.after < report.phantomVariation.before / 2);
  assert.match(report.mindgrab, /^\d+\.\d+\.\d+$/);
});

test("the executable prints help, runs self-check and download-models, and exits 1 on a usage error", () => {
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: n4 IMAGE/);
  assert.match(help.stdout, /Tustison/);
  const self = run("self-check");
  assert.equal(self.status, 0, self.stderr);
  assert.equal(JSON.parse(self.stdout).n4, JSON.parse(spawnSync(process.execPath, ["-p", "JSON.stringify(require('./package.json'))"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).stdout).version);
  const models = run("download-models", "--cache-dir", "somewhere");
  assert.equal(models.status, 0);
  assert.match(models.stdout, /^0 model files/);
  const usage = run("only-one.nii.gz");
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Give a NIfTI image and a new output directory/);
  assert.equal(run("x.nii", "out", "--cache-dir", "d").status, 1);
});
