#!/usr/bin/env node
// Runs an n4 command line on every pinned example and compares each output with the web app's
// download, recorded in browser-reference.json by apps/n4/e2e/reference.spec.js. With its default
// MindGrab mask the command line must write the recorded mask and every recorded download; given
// that mask through --mask it must write the same files again.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { compareOutputs, inputChecksums, pinnedExamples, readReference, sharedProvenance, summarize } from "./reference.mjs";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/n4.js", import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? "PASS" : "FAIL"} ${line}`);
}

function run(args) {
  const started = performance.now();
  const result = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(" ")} ${args.join(" ")} exited with ${result.status}:\n${result.stderr.slice(-4000)}`);
  const provenance = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));
  return { stdout: result.stdout, provenance, seconds: (performance.now() - started) / 1000 };
}

// The written files, by the artifact role the web app gives each name.
async function outputs(directory, roles) {
  const byName = Object.fromEntries(Object.entries(roles).map(([role, summary]) => [summary.name, role]));
  const found = {};
  for (const name of await readdir(directory)) found[byName[name] ?? name] = summarize(name, await readFile(join(directory, name)));
  return found;
}

const reference = await readReference();
const examples = await pinnedExamples();
check(JSON.stringify(reference.inputs) === JSON.stringify(inputChecksums(examples)), "reference was recorded from the pinned example inputs");

const self = spawnSync(command[0], [...command.slice(1), "self-check"], { encoding: "utf8" });
check(self.status === 0, `self-check passes: ${(self.stdout || self.stderr).trim().slice(0, 300)}`);

const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "n4-cli-check-"));
try {
  for (const example of examples) {
    const was = reference.browser.cases[example.id];
    // The example's .bval, .bvec and .json share the image's stem, so the command line pairs them itself.
    const output = join(work, example.id);
    const cli = run([example.files.image.path, output]);
    check(cli.stdout.trim() === output, `${example.id}: prints the output directory (${cli.seconds.toFixed(1)} s)`);
    check(
      JSON.stringify(sharedProvenance(cli.provenance)) === JSON.stringify(sharedProvenance(was.provenance)),
      `${example.id}: ${cli.provenance.method}, ${cli.provenance.procedure}, -s ${cli.provenance.shrink} -b [${cli.provenance.bspline}] -c [${cli.provenance.convergence}], as the web app corrected`,
    );
    check(
      cli.provenance.mask === `mindgrab-${reference.masks.provenance.version}-cpu`,
      `${example.id}: provenance records the MindGrab ${reference.masks.provenance.version} CPU mask (${cli.provenance.mask})`,
    );
    const written = await outputs(output, was.outputs);
    const recordedMask = reference.masks.examples[example.id];
    check(
      written.mask?.decompressedSha256 === recordedMask.decompressedSha256,
      `${example.id}: MindGrab mask ${written.mask?.decompressedSha256?.slice(0, 12)} (${written.mask?.nonzero} brain voxels) identical to the recorded ${recordedMask.decompressedSha256.slice(0, 12)} (${recordedMask.nonzero})`,
    );
    for (const [passed, line] of compareOutputs(example.id, written, was.outputs)) check(passed, line);

    const provided = join(work, `${example.id}-mask`);
    const given = run([example.files.image.path, provided, "--mask", join(output, was.outputs.mask.name)]);
    check(given.provenance.mask === "supplied", `${example.id}: provenance records the supplied mask`);
    const differing = compareOutputs(`${example.id} --mask`, await outputs(provided, was.outputs), was.outputs).filter(([passed]) => !passed);
    check(differing.length === 0, `${example.id}: --mask with that mask writes the web app's files${differing.length ? `; ${differing.map(([, line]) => line).join("; ")}` : ""} (${given.seconds.toFixed(1)} s)`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length
  ? `FAIL ${failures.length} n4 command-line checks`
  : `PASS n4 command line reproduces the web app's downloads on ${examples.length} examples`);
process.exitCode = failures.length ? 1 : 0;
