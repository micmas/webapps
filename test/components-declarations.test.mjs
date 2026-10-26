import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const execFileAsync = promisify(execFile);
const components = join(repoRoot, 'packages', 'components');
const typescript = createRequire(import.meta.url).resolve('typescript/package.json');
const tsc = join(dirname(typescript), JSON.parse(await readFile(typescript, 'utf8')).bin.tsc);
const exists = path => access(path).then(() => true, () => false);

test('the components\' public declarations compile with only their production dependencies installed', async t => {
  const manifest = JSON.parse(await readFile(join(components, 'package.json'), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'components-declarations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, 'node_modules', manifest.name);
  await mkdir(installed, { recursive: true });
  await cp(join(components, 'package.json'), join(installed, 'package.json'));
  await cp(join(components, 'src'), join(installed, 'src'), { recursive: true });
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const target = join(root, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(components, 'node_modules', name)), target, 'dir');
  }

  const imports = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const declared = typeof target === 'object'
      ? Boolean(target.types)
      : target.endsWith('.js') && await exists(join(components, target.replace(/\.js$/, '.d.ts')));
    if (!declared) continue;
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    imports.push(`import type * as entry${imports.length} from '${specifier}';`);
  }
  assert.ok(imports.some(line => line.endsWith("/automation';")), 'the automation declarations must be among those compiled');
  await writeFile(join(root, 'consumer.ts'), `${imports.join('\n')}\n`);
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));

  const diagnostics = {};
  for (const [module, moduleResolution] of [['ESNext', 'Bundler'], ['NodeNext', 'NodeNext']]) {
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true, skipLibCheck: false, noEmit: true, target: 'ES2022', module, moduleResolution,
        lib: ['ES2022', 'DOM'], types: [],
      },
      files: ['consumer.ts'],
    }));
    diagnostics[moduleResolution] = await execFileAsync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json'), '--pretty', 'false'])
      .then(() => '', error => `${error.stdout}${error.stderr}`.replaceAll(root, ''));
  }
  assert.deepEqual(diagnostics, { Bundler: '', NodeNext: '' },
    'a consumer without the components\' development dependencies must type-check their public API');
});
