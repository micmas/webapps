#!/usr/bin/env node
// Runs a dwidenoise command line on every pinned example and compares each output with the web
// app's download, recorded in browser-reference.json by apps/dwidenoise/e2e/reference.spec.js.
// The first example also runs on one worker thread, which must give the same bits.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROLES, compareWithBrowser, pinnedExamples, readReference, summarize } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/dwidenoise.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const reference = await readReference();
const examples = await pinnedExamples();
check(
  JSON.stringify(reference.inputs) === JSON.stringify(Object.fromEntries(examples.map((e) => [e.id, Object.fromEntries(e.files.map((f) => [f.name, f.sha256]))]))),
  'reference was recorded from the pinned example inputs',
);

const self = spawnSync(command[0], [...command.slice(1), 'self-check'], { encoding: 'utf8' });
check(self.status === 0, `self-check passes: ${(self.stdout || self.stderr).trim().slice(0, 240)}`);

function run(image, output, extra = []) {
  const started = performance.now();
  const result = spawnSync(command[0], [...command.slice(1), image, output, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { ...result, seconds: (performance.now() - started) / 1000 };
}

const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'dwidenoise-cli-check-'));
try {
  for (const [index, example] of examples.entries()) {
    const was = reference.browser.outputs[example.id];
    const image = example.files.find((file) => file.role === 'image');
    // The example's .bval, .bvec and .json share the image's stem, so the command line pairs them itself.
    const output = join(work, example.id);
    const result = run(image.path, output);
    if (result.status !== 0) {
      check(false, `${example.id}: exited with ${result.status}: ${result.stderr.slice(-2000)}`);
      continue;
    }
    const expected = ROLES.filter((role) => was?.[role]).map((role) => was[role].name).sort();
    check(
      result.stdout.trim() === output && JSON.stringify((await readdir(output)).sort()) === JSON.stringify(expected),
      `${example.id}: writes ${expected.join(', ')} and prints the directory (${result.seconds.toFixed(1)} s)`,
    );
    const provenance = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));
    const browser = reference.browser.provenance[example.id];
    check(
      JSON.stringify(provenance.groups) === JSON.stringify(browser.groups) && provenance.b0Threshold === browser.b0Threshold && provenance.method === browser.method,
      `${example.id}: fits ${provenance.groups.map((group) => group.length).join(' and ')} volumes in the groups the web app fitted (${provenance.threads} threads)`,
    );
    const summaries = {};
    for (const role of ROLES.filter((role) => was?.[role])) {
      const bytes = await readFile(join(output, was[role].name)).catch(() => null);
      if (!bytes) {
        check(false, `${example.id} ${role}: ${was[role].name} was not written`);
        continue;
      }
      summaries[role] = summarize(was[role].name, bytes);
      for (const [passed, line] of compareWithBrowser(`${example.id} ${role}`, summaries[role], was[role])) check(passed, line);
    }
    if (index === 0 && summaries.image) {
      const single = join(work, `${example.id}-one-thread`);
      const one = run(image.path, single, ['--threads', '1']);
      const bytes = one.status === 0 ? await readFile(join(single, was.image.name)).catch(() => null) : null;
      check(
        bytes !== null && summarize(was.image.name, bytes).decompressedSha256 === summaries.image.decompressedSha256,
        `${example.id} image on one worker thread identical to the run on ${provenance.threads} (${one.seconds.toFixed(1)} s)`,
      );
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length
  ? `FAIL ${failures.length} dwidenoise command-line checks`
  : `PASS dwidenoise command line reproduces the web app's downloads on ${examples.length} example${examples.length === 1 ? '' : 's'}`);
process.exitCode = failures.length ? 1 : 0;
