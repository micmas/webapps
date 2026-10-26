import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { build } from 'esbuild';

// An import-map app cannot resolve npm packages, so a vendored component module that imports one is bundled with it.
async function bundleComponentModule({ repoRoot, componentsSrc, module }) {
  await build({
    entryPoints: [join(repoRoot, 'packages', 'components', 'src', module)],
    outfile: join(componentsSrc, module),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    legalComments: 'eof',
  });
}

export async function stageOperationParameters({ repoRoot, componentsSrc }) {
  await bundleComponentModule({ repoRoot, componentsSrc, module: 'automation/parameters.js' });
}

async function registersNiivueViewer(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['dist', 'node_modules', 'vendor'].includes(entry.name) && await registersNiivueViewer(path)) return true;
    } else if (['.html', '.js', '.mjs'].includes(extname(entry.name)) && (await readFile(path, 'utf8')).includes('createNiivueAdapter')) {
      return true;
    }
  }
  return false;
}

// As a bundler would, give nv-mcp's client only to an app whose own scripts register a NiiVue viewer.
export async function stageNvMcp({ repoRoot, componentsSrc, appRoot }) {
  if (await registersNiivueViewer(appRoot)) await bundleComponentModule({ repoRoot, componentsSrc, module: 'automation/nv-mcp.js' });
}
