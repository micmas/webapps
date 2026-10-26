#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInstallation, denoise } from '../src/node.js';

const HELP = `Usage: dwidenoise IMAGE.nii[.gz] OUTPUT_DIR [options]
       dwidenoise self-check

Denoises a diffusion MRI series with Patch2Self (Fadnavis et al. 2020), with
the port of DIPY 1.12.1 Patch2Self version 1 (patch radius 0, OLS) that the
Dwidenoise web app runs. Each volume is predicted from the other volumes of
its group: the b0 volumes (b < 50 s/mm2, when there are two or more) and the
diffusion-weighted volumes. A single b0 is left unchanged. It writes the
app's downloads:

  <name>_desc-denoised_<suffix>.nii.gz   the denoised image
  <name>_desc-denoised_<suffix>.bval     the b-values, unchanged
  <name>_desc-denoised_<suffix>.bvec     the b-vectors, unchanged (when given)
  <name>_desc-denoised_<suffix>.json     the sidecar, with the step's Description

The .bval (required), .bvec and .json beside IMAGE with the same name are
used unless another file is given. When IMAGE is the only image in its
directory, a sole bval(s) or bvec(s) file there is used whatever its name
(FSL data.nii.gz, bvals, bvecs). OUTPUT_DIR must be new or empty.

Options:
  --bval FILE      b-values (FSL); required when none is beside IMAGE
  --bvec FILE      b-vectors to pass through
  --json FILE      BIDS sidecar to pass through
  --threads N      worker threads (default: one per core); the output is
                   the same for any number
  -h, --help       show this help

The output directory goes to standard output; progress and the run's
settings, as JSON, go to standard error. NIfTI input only: convert DICOM
with dcm2niix first, or use the web app. Cite Fadnavis S, Batson J,
Garyfallidis E. Patch2Self: Denoising Diffusion MRI with Self-Supervised
Learning. NeurIPS 2020, and DIPY: Garyfallidis E et al. Front Neuroinform
2014;8:8.

dwidenoise has no model files. "download-models [--cache-dir DIR]" exists
for the portable packager and installs nothing.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'cache-dir': { type: 'string' },
      bval: { type: 'string' },
      bvec: { type: 'string' },
      json: { type: 'string' },
      threads: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log(`0 model files: dwidenoise has nothing to install in ${resolve(values['cache-dir'] ?? '.')}`);
  } else {
    if (positionals.length !== 2) throw new Error('Give a NIfTI image and a new output directory. Use --help for options.');
    let reported = 0;
    const result = await denoise({
      input: positionals[0],
      output: positionals[1],
      bval: values.bval,
      bvec: values.bvec,
      json: values.json,
      threads: values.threads,
      onProgress: (fraction) => {
        const percent = Math.floor(fraction * 10 + 1e-9) * 10;
        if (percent > reported) process.stderr.write(`${(reported = percent)}%\n`);
      },
    });
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
