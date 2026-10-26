import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { checkInstallation, companions, denoise, phantomSeries, spawnThread, threadCount } from "../src/node.js";
import { denoiseSeries } from "../src/pool.js";
import { loadDwidenoise } from "../src/wasm.js";

const bin = fileURLToPath(new URL("../bin/dwidenoise.js", import.meta.url));
const scratch = () => mkdtemp(join(process.env.TMPDIR || tmpdir(), "dwidenoise-node-"));
const p2s = await loadDwidenoise(readFile(new URL("../src/dwidenoise.wasm", import.meta.url)));

async function writeSeries(dir, name = "sub-01_dwi", { bval = ".bval", bvec = ".bvec" } = {}) {
  const input = phantomSeries();
  await writeFile(join(dir, `${name}.nii.gz`), gzipSync(input.nifti));
  if (bval) await writeFile(join(dir, `${name}${bval}`), `${input.bvals.join(" ")}\n`);
  if (bvec) await writeFile(join(dir, `${name}${bvec}`), "0 1 0 0 1 0\n0 0 1 0 0 1\n0 0 0 1 0 0\n");
  return { ...input, image: join(dir, `${name}.nii.gz`) };
}

const decoded = async (path) => {
  const bytes = gunzipSync(await readFile(path));
  return { bytes, frames: readNiftiFrames(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) };
};

test("writes the web app's four downloads, with the b0 kept and the group denoised", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    await writeFile(join(dir, "sub-01_dwi.json"), JSON.stringify({ PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05 }));
    const out = join(dir, "out");
    const result = await denoise({ input: input.image, output: out, threads: 2 });
    assert.deepEqual((await readdir(out)).sort(), [
      "sub-01_desc-denoised_dwi.bval",
      "sub-01_desc-denoised_dwi.bvec",
      "sub-01_desc-denoised_dwi.json",
      "sub-01_desc-denoised_dwi.nii.gz",
    ]);
    assert.equal(await readFile(join(out, "sub-01_desc-denoised_dwi.bval"), "utf8"), await readFile(join(dir, "sub-01_dwi.bval"), "utf8"));
    assert.equal(await readFile(join(out, "sub-01_desc-denoised_dwi.bvec"), "utf8"), await readFile(join(dir, "sub-01_dwi.bvec"), "utf8"));
    const sidecarText = await readFile(join(out, "sub-01_desc-denoised_dwi.json"), "utf8");
    assert.ok(sidecarText.endsWith("}\n"));
    const sidecar = JSON.parse(sidecarText);
    assert.equal(sidecar.PhaseEncodingDirection, "j-");
    assert.match(sidecar.Description, /Patch2Self/);

    const { frames } = await decoded(join(out, "sub-01_desc-denoised_dwi.nii.gz"));
    assert.deepEqual(frames.dims, input.dims);
    assert.equal(frames.frames, input.frames);
    assert.deepEqual(frames.data.subarray(0, input.nvox), input.data.subarray(0, input.nvox));
    const whole = p2s.denoiseArray(input.data, input.nvox, input.bvals);
    let largest = 0;
    whole.forEach((value, i) => (largest = Math.max(largest, Math.abs(frames.data[i] - value))));
    assert.ok(largest < 1e-3, `largest difference ${largest}`);
    assert.equal(result.provenance.method, "patch2self-v1-dipy-1.12.1-port");
    assert.deepEqual(result.provenance.groups, [[1, 2, 3, 4, 5]]);
    assert.equal(result.provenance.threads, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one and four worker threads write the same image bytes", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    await denoise({ input: input.image, output: join(dir, "one"), threads: 1 });
    await denoise({ input: input.image, output: join(dir, "four"), threads: "4" });
    const one = await decoded(join(dir, "one", "sub-01_desc-denoised_dwi.nii.gz"));
    const four = await decoded(join(dir, "four", "sub-01_desc-denoised_dwi.nii.gz"));
    assert.ok(input.nvox > 16384, "the phantom spans more than one pool chunk");
    assert.equal(Buffer.compare(one.bytes, four.bytes), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FSL bvals and bvecs pair by stem, and --bval names another file", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir, "data", { bval: ".bvals", bvec: ".bvecs" });
    assert.deepEqual(await companions(input.image), { bval: join(dir, "data.bvals"), bvec: join(dir, "data.bvecs"), json: null });
    await mkdir(join(dir, "gradients"));
    await writeFile(join(dir, "gradients", "b.txt"), `${input.bvals.join(" ")}\n`);
    const paired = await companions(input.image, { bval: join(dir, "gradients", "b.txt") });
    assert.equal(paired.bval, join(dir, "gradients", "b.txt"));
    await assert.rejects(companions(input.image, { bvec: join(dir, "missing.bvec") }), /does not exist/);
    const result = await denoise({ input: input.image, output: join(dir, "out"), threads: 1 });
    assert.deepEqual(result.files.map((file) => file.name).sort(), ["data_desc-denoised.bval", "data_desc-denoised.bvec", "data_desc-denoised.json", "data_desc-denoised.nii.gz"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FSL's data.nii.gz with bvals and bvecs pairs as the web app pairs a one-image selection", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir, "data", { bval: null, bvec: null });
    await writeFile(join(dir, "bvals"), `${input.bvals.join(" ")}\n`);
    await writeFile(join(dir, "bvecs"), "0 1 0 0 1 0\n0 0 1 0 0 1\n0 0 0 1 0 0\n");
    await mkdir(join(dir, "nodif.bval"));
    assert.deepEqual(await companions(input.image), { bval: join(dir, "bvals"), bvec: join(dir, "bvecs"), json: null });
    const result = await denoise({ input: input.image, output: join(dir, "out"), threads: 1 });
    assert.equal(await readFile(join(dir, "out", "data_desc-denoised.bval"), "utf8"), await readFile(join(dir, "bvals"), "utf8"));
    assert.equal(result.files.length, 4);

    // A second image makes the unmatched files ambiguous: the app leaves them unpaired.
    await writeFile(join(dir, "other.nii.gz"), gzipSync(input.nifti));
    assert.deepEqual(await companions(input.image), { bval: null, bvec: null, json: null });
    await assert.rejects(denoise({ input: input.image, output: join(dir, "out2"), threads: 1 }), /--bval FILE/);
    // A file of the image's stem still pairs, and wins over a sole unmatched file.
    await writeFile(join(dir, "data.bval"), `${input.bvals.join(" ")}\n`);
    assert.equal((await companions(input.image)).bval, join(dir, "data.bval"));
    await rm(join(dir, "other.nii.gz"));
    assert.equal((await companions(input.image)).bval, join(dir, "data.bval"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a worker thread that stops before it replies fails the run instead of hanging it", async () => {
  const fixture = new URL("./fixtures/stopping-worker.js", import.meta.url);
  const phantom = phantomSeries({ nx: 8, ny: 8, nz: 4 });
  const groups = p2s.fittedGroups(phantom.bvals);
  for (const mode of ["exit-on-message", "exit-after-reply"]) {
    const run = denoiseSeries({
      data: phantom.data,
      nvox: phantom.nvox,
      frames: phantom.frames,
      groups,
      spawn: () => spawnThread(fixture, { workerData: mode }),
      workers: 1,
    });
    await assert.rejects(run, /worker thread stopped \(exit code [34]\)/, mode);
  }
});

test("refuses input the web app refuses, and a used output directory", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir, "sub-01_dwi", { bval: null, bvec: null });
    await assert.rejects(denoise({ input: input.image, output: join(dir, "a") }), /Give the \.bval file of sub-01_dwi\.nii\.gz/);
    await writeFile(join(dir, "short.bval"), "0 1000\n");
    await assert.rejects(denoise({ input: input.image, output: join(dir, "b"), bval: join(dir, "short.bval") }), /6 volumes but the bval file lists 2/);
    await writeFile(join(dir, "one-weighted.bval"), "0 0 0 0 0 1000\n");
    await assert.rejects(denoise({ input: input.image, output: join(dir, "c"), bval: join(dir, "one-weighted.bval") }), /at least 2 diffusion-weighted volumes/);
    await writeFile(join(dir, "image.mif"), "x");
    await assert.rejects(denoise({ input: join(dir, "image.mif"), output: join(dir, "d") }), /not a NIfTI image/);
    await mkdir(join(dir, "used"));
    await writeFile(join(dir, "used", "x"), "x");
    await writeFile(join(dir, "sub-01_dwi.bval"), `${input.bvals.join(" ")}\n`);
    await assert.rejects(denoise({ input: input.image, output: join(dir, "used") }), /not empty/);
    assert.throws(() => threadCount("0"), /--threads must be a positive whole number/);
    assert.throws(() => threadCount("two"), /--threads must be a positive whole number/);
    assert.equal(threadCount(3), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-check denoises the phantom in this runtime", async () => {
  const report = await checkInstallation();
  assert.match(report.phantom, /1 and 3 threads identical; b0 unchanged/);
});

test("the command line prints the output directory and its settings", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    const out = join(dir, "out");
    const run = spawnSync(process.execPath, [bin, input.image, out, "--threads", "2"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), out);
    const provenance = JSON.parse(run.stderr.trim().split("\n").at(-1));
    assert.equal(provenance.threads, 2);
    assert.match(run.stderr, /^100%$/m);
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    assert.match(help.stdout, /Fadnavis/);
    const models = spawnSync(process.execPath, [bin, "download-models", "--cache-dir", dir], { encoding: "utf8" });
    assert.equal(models.status, 0);
    assert.match(models.stdout, /^0 model files/);
    const wrong = spawnSync(process.execPath, [bin, input.image], { encoding: "utf8" });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /Give a NIfTI image and a new output directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
