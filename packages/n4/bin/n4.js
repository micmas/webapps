#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULTS } from "../src/index.js";
import { checkInstallation, correct } from "../src/node.js";

const HELP = `Usage: n4 IMAGE.nii[.gz] OUTPUT_DIR [options]
       n4 self-check

Corrects the intensity bias field with ANTs N4BiasFieldCorrection (Tustison
et al. 2010), the WebAssembly module the N4 web app runs, and writes the app's
downloads:

  <name>_desc-n4_<suffix>.nii.gz      the corrected image
  <name>_desc-n4_biasfield.nii.gz     the bias field
  <name>_desc-brain_mask.nii.gz       the brain mask the fit used
  <name>_desc-n4_<suffix>.bval/.bvec  the gradients, unchanged (when given)
  <name>_desc-n4_<suffix>.json        the sidecar, with the step's Description
                                      (when given)

A 3D image is corrected directly. For a series, the field is fitted to the
mean of the b0 volumes (b < 50 s/mm²; every volume without a .bval), rescaled
to keep the brain's integral and divided out of every volume, as MRtrix
dwibiascorrect ants does. N4 runs with its options: -s ${DEFAULTS.shrink} -b [${DEFAULTS.bspline.join(",")}]
-c [${DEFAULTS.convergence[0]},${DEFAULTS.convergence[1].toFixed(1)}].

The fit is weighted by a MindGrab brain mask of that mean b0 (or the image),
on the CPU: it needs about 2.6 GB of memory. --mask FILE gives your own mask.
The .bval (or .bvals), .bvec (or .bvecs) and .json beside IMAGE with the same
name are used unless another file is given. For a series, a sole gradient file
that no other image owns (FSL's bvals and bvecs) is used too. OUTPUT_DIR must
be new or empty.

Options:
  --mask FILE      brain mask on the image grid, in place of MindGrab's
  --bval FILE      b-values: the field is fitted to the mean b0
  --bvec FILE      b-vectors to pass through
  --json FILE      BIDS sidecar to pass through
  -h, --help       show this help

The output directory goes to standard output; progress and the run's
settings, as JSON, go to standard error. NIfTI input only: convert DICOM
with dcm2niix first, or use the web app. Cite Tustison NJ, Avants BB, Cook
PA, et al. N4ITK: improved N3 bias correction. IEEE Trans Med Imaging
2010;29(6):1310-1320.

n4 has no model files to download: MindGrab's weights are part of its
modules. "download-models [--cache-dir DIR]" exists for the portable
packager and installs nothing.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "cache-dir": { type: "string" },
      mask: { type: "string" },
      bval: { type: "string" },
      bvec: { type: "string" },
      json: { type: "string" },
    },
  });
  const [command] = positionals;
  if (values["cache-dir"] !== undefined && command !== "download-models") throw new Error("--cache-dir only applies to download-models.");
  if (values.help) {
    console.log(HELP);
  } else if (command === "self-check") {
    if (positionals.length !== 1) throw new Error("self-check does not accept arguments.");
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === "download-models") {
    if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
    console.log(`0 model files: n4 has nothing to install in ${resolve(values["cache-dir"] ?? ".")}`);
  } else {
    if (positionals.length !== 2) throw new Error("Give a NIfTI image and a new output directory. Use --help for options.");
    const result = await correct({
      input: positionals[0],
      output: positionals[1],
      mask: values.mask,
      bval: values.bval,
      bvec: values.bvec,
      json: values.json,
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
