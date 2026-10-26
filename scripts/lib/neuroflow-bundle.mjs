import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateTools } from '../../packages/desktop/neuroflow/generator.mjs';
import { loadAppsRegistry, repoRoot } from './apps-registry.mjs';
import { loadAppContract } from './app-automation.mjs';

/** Every registered app's automation contract, at its package version. */
export async function loadCatalogContracts({ exclude = [] } = {}) {
  const contracts = [];
  for (const app of (await loadAppsRegistry()).apps) {
    if (exclude.includes(app.id)) continue;
    const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json')));
    const contract = await loadAppContract(app, version);
    if (!contract) throw new Error(`${app.id}: missing automation contract`);
    contracts.push(contract);
  }
  return contracts;
}

/**
 * The generated NeuroFlow bundle as relative path -> bytes: one tool per operation
 * under tools/, and the runtime its commands run under scripts/.
 */
export async function neuroflowBundleFiles(contracts) {
  const tools = contracts.flatMap(generateTools);
  const files = new Map();
  for (const tool of tools) {
    const binding = tool.extensions['neurodesk/automation'];
    files.set(`tools/${binding.contract.app}/${binding.operation}.tool.json`, Buffer.from(`${JSON.stringify(tool, null, 2)}\n`));
  }
  for (const name of ['neurodesk.mjs', 'contract.mjs', 'stdio.mjs']) {
    files.set(`scripts/${name}`, await readFile(join(repoRoot, 'packages/desktop/neuroflow/runtime', name)));
  }
  return { tools, files };
}

/** A NeuroFlow registry index listing the bundle's tool and workflow documents. */
export function neuroflowRegistryIndex(paths, { title, description } = {}) {
  const list = [...paths];
  const sorted = suffix => list.filter(path => path.endsWith(suffix)).sort();
  return {
    neuroflow: '0.1.1',
    kind: 'neuroflow/registry-index',
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    tools: sorted('.tool.json'),
    workflows: sorted('.workflow.json'),
  };
}
