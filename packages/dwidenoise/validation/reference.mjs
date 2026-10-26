// The web app's example and its recorded downloads, shared by both release checks:
// validation/cli-check.mjs for the command line and apps/dwidenoise/e2e/reference.spec.js for the
// web app. browser-reference.json holds what the built web app downloaded.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const REFERENCE = new URL('./browser-reference.json', import.meta.url);
// The automation's artifacts, in the order the web app lists them.
export const ROLES = Object.freeze(['image', 'bval', 'bvec', 'sidecar']);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

/** The pinned example files, by role, as apps/dwidenoise/examples.json declares them. */
export async function exampleFiles() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/dwidenoise/examples.json', import.meta.url), 'utf8'));
  return examples.map((example) => ({ id: example.id, files: example.files }));
}

/** Downloads (once) and verifies every file of every example; each file gains its local path. */
export async function pinnedExamples() {
  return Promise.all((await exampleFiles()).map(async (example) => ({
    ...example,
    files: await Promise.all(example.files.map(async (file) => ({ ...file, path: await pinnedFile(file) }))),
  })));
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(process.env.TMPDIR || tmpdir(), 'neurodesk-dwidenoise-validation', revision, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === file.sha256) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin in examples.json`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

// What the checks compare about one download: its name, size and bytes, and for a gzipped image
// the decompressed bytes. The browser and Node compress with different zlib builds, so the
// denoised image is held to its decompressed bytes and every other file to its bytes.
export function summarize(name, bytes) {
  const summary = { name, bytes: bytes.length, sha256: sha256(bytes) };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) summary.decompressedSha256 = sha256(gunzipSync(bytes));
  return summary;
}

// Returns [passed, line] pairs comparing one download with the browser reference's.
export function compareWithBrowser(label, is, was) {
  if (!was) return [[false, `${label}: the reference holds no such download`]];
  const checks = [[is.name === was.name, `${label} is named ${is.name}, as the web app names it (${was.name})`]];
  if (was.decompressedSha256) {
    checks.push([is.decompressedSha256 === was.decompressedSha256, `${label} decompressed ${is.decompressedSha256?.slice(0, 12)} identical to the browser's ${was.decompressedSha256.slice(0, 12)}`]);
  } else {
    checks.push([is.sha256 === was.sha256, `${label} ${is.sha256.slice(0, 12)} (${is.bytes} bytes) identical to the browser's ${was.sha256.slice(0, 12)} (${was.bytes} bytes)`]);
  }
  return checks;
}
