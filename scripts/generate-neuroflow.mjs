#!/usr/bin/env node
import { mkdir, readFile, writeFile, rmdir, readdir, rename, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalogContracts, neuroflowBundleFiles } from './lib/neuroflow-bundle.mjs';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, contract: { type: 'string' }, version: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node scripts/generate-neuroflow.mjs --out DIRECTORY [--contract automation.json --version MAJOR.MINOR.YYYYMMDD]\nOmit --contract to generate the entire catalog. The destination must be empty or an identical generated bundle.');
} else {
  if (!values.out) throw new Error('--out is required');
  if (values.version && !values.contract) throw new Error('--version requires --contract');
  let contracts;
  if (values.contract) {
    const contract = JSON.parse(await readFile(resolve(values.contract), 'utf8'));
    if (values.version) contract.appVersion = values.version;
    contracts = [contract];
  } else {
    contracts = await loadCatalogContracts();
  }
  const { tools, files } = await neuroflowBundleFiles(contracts);
  const out = resolve(values.out);
  let existing;
  try { existing = await readdir(out, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.length) {
    const actual = existing.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
    if (actual.length !== files.size || existing.some(entry => !entry.isFile() && !entry.isDirectory())) {
      throw new Error('Destination is not an identical generated bundle; choose a new directory');
    }
    for (const [name, bytes] of files) {
      if (!(await readFile(join(out, name))).equals(bytes)) throw new Error('Destination differs; choose a new directory');
    }
  } else {
    await mkdir(dirname(out), { recursive: true });
    const stage = await mkdtemp(join(dirname(out), '.neuroflow-'));
    try {
      for (const [name, bytes] of files) {
        await mkdir(dirname(join(stage, name)), { recursive: true });
        await writeFile(join(stage, name), bytes);
      }
      if (existing) await rmdir(out);
      await rename(stage, out);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  console.log(`Generated ${tools.length} NeuroFlow tools from ${contracts.length} contracts in ${out}`);
}
