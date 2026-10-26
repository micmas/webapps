// The examples both release checks run, and their comparison: validation/cli-check.mjs for the
// command line and apps/n4/e2e/reference.spec.js for the web app. browser-reference.json holds the
// MindGrab mask the command line computes on the CPU for each example (masks) and what the built
// web app downloaded for each example (browser).
//
// The app's three pinned examples cover a multi-shell DWI with its sidecar, a 3D T1-weighted image
// and a single-shell DWI without one. Each example's mask comes from the command line's CPU
// MindGrab and reaches the app through its mask input, since the app's own MindGrab prefers a GPU:
// this isolates the correction. @neurodesk/node-drivers holds that CPU MindGrab to the browser's.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";

export const REFERENCE = new URL("./browser-reference.json", import.meta.url);
// The automation's artifacts, in the order the web app lists them.
export const ROLES = Object.freeze(["image", "bias", "mask", "bval", "bvec", "sidecar"]);

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, "utf8"));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

const scratch = () => process.env.TMPDIR || tmpdir();

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split("/")[5];
  const path = join(scratch(), "neurodesk-n4-validation", revision, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === file.sha256) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin in examples.json`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

/**
 * Every example of apps/n4/examples.json, each file downloaded once and verified, by role:
 * `{ id, files: { image, bval?, bvec?, sidecar? } }` with `{ name, path, sha256 }` per file.
 */
export async function pinnedExamples() {
  const examples = JSON.parse(await readFile(new URL("../../../apps/n4/examples.json", import.meta.url), "utf8"));
  return Promise.all(examples.map(async (example) => ({
    id: example.id,
    files: Object.fromEntries(await Promise.all(example.files.map(async (file) => [file.role, { name: file.name, path: await pinnedFile(file), sha256: file.sha256 }]))),
  })));
}

/** Input checksums by example and file name, as the reference records them. */
export function inputChecksums(examples) {
  return Object.fromEntries(examples.map((example) => [
    example.id,
    Object.fromEntries(Object.values(example.files).map((file) => [file.name, file.sha256])),
  ]));
}

// What the checks compare about one download: its name, its bytes and, for a gzipped NIfTI, its
// decompressed bytes and the voxel statistics a reader of a failure needs. The browser and Node
// gzip with different zlib builds, so a NIfTI is held to its decompressed bytes (header and
// voxels) and every other file to its bytes.
export function summarize(name, stored) {
  const summary = { name, bytes: stored.length, sha256: sha256(stored) };
  if (stored[0] !== 0x1f || stored[1] !== 0x8b) return summary;
  const bytes = gunzipSync(stored);
  const { data } = readNiftiFrames(bytes, Float64Array);
  let nonzero = 0;
  let sum = 0;
  let finite = 0;
  for (const value of data) {
    if (!Number.isFinite(value)) continue;
    finite += 1;
    sum += value;
    if (value !== 0) nonzero += 1;
  }
  return { ...summary, decompressedSha256: sha256(bytes), nonFinite: data.length - finite, nonzero, mean: finite ? sum / finite : 0 };
}

/** The provenance fields the web app and the command line both report. */
export function sharedProvenance(provenance) {
  const { method, procedure, shrink, bspline, convergence } = provenance;
  return { method, procedure, shrink, bspline, convergence };
}

// Returns [passed, line] pairs comparing one example's downloads, keyed by artifact role, with the
// recorded ones. The web app and the command line run one WebAssembly module on the same bytes, so
// every NIfTI must be identical once decompressed and every other file byte for byte.
export function compareOutputs(label, actual, expected) {
  const checks = [];
  for (const role of [...new Set([...Object.keys(expected), ...Object.keys(actual)])]) {
    const [is, was] = [actual[role], expected[role]];
    if (!is || !was) {
      checks.push([false, `${label} ${role} ${is ? "is not in the reference" : "was not written"}`]);
      continue;
    }
    if (was.decompressedSha256) {
      checks.push([
        is.name === was.name && is.decompressedSha256 === was.decompressedSha256,
        `${label} ${role}: ${is.name} ${is.decompressedSha256?.slice(0, 12)} (mean ${is.mean?.toPrecision(6)}, ${is.nonzero} non-zero) identical to the web app's ${was.name} ${was.decompressedSha256.slice(0, 12)} (mean ${was.mean.toPrecision(6)})`,
      ]);
    } else {
      checks.push([
        is.name === was.name && is.sha256 === was.sha256,
        `${label} ${role}: ${is.name} ${is.sha256.slice(0, 12)} (${is.bytes} bytes) identical to the web app's ${was.name} ${was.sha256.slice(0, 12)} (${was.bytes} bytes)`,
      ]);
    }
  }
  return checks;
}
