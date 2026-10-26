import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { assembleRuntimeAssetStore } from '../scripts/lib/runtime-assets.mjs';

const execute = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

async function checkRuntime(t, componentsSrc) {
  const module = await import(pathToFileURL(join(componentsSrc, 'automation/parameters.js')));
  assert.deepEqual(Object.keys(module).sort(), ['operationParameterSchema', 'operationParametersSchema']);
  const fields = {
    threshold: { type: 'number', multipleOf: 0.01, default: 0.15 },
    iterations: { type: 'integer' },
  };
  const schema = module.operationParametersSchema(fields);
  assert.deepEqual(schema.parse(undefined), { threshold: 0.15 });
  assert.deepEqual(schema.parse({ threshold: undefined }), { threshold: 0.15 });
  assert.equal(schema.safeParse({ threshold: 0.150000000001 }).success, false);
  assert.equal(schema.safeParse({ iterations: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(schema.safeParse({ invented: undefined }).success, false);
  assert.equal(module.operationParameterSchema(fields.threshold).safeParse(undefined).success, false);

  const { registerAppAutomation } = await import(pathToFileURL(join(componentsSrc, 'automation/index.js')));
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/qsmbly/' });
  t.after(() => dom.window.close());
  const calls = [];
  const { dispatch } = registerAppAutomation({
    app: 'test', document: dom.window.document, target: dom.window,
    contract: { schemaVersion: 2, app: 'test', appVersion: '0.1.20261003', defaultOperation: 'run', operations: {
      run: { mode: 'batch', inputs: {}, parameters: fields, artifacts: {}, engines: ['browser'] },
    } },
    operations: { run: async ({ parameters }) => { calls.push(parameters); return { artifacts: [] }; } },
  });
  await assert.rejects(dispatch('start', { parameters: { threshold: 0.150000000001 } }));
  assert.deepEqual(calls, []);
  await dispatch('start', { parameters: { threshold: undefined } });
  for (let index = 0; index < 100; index++) {
    const snapshot = await dispatch('snapshot');
    if (snapshot.state === 'succeeded') {
      assert.deepEqual(snapshot.report.parameters, { threshold: 0.15 });
      assert.deepEqual(calls, [{ threshold: 0.15 }]);
      return;
    }
    assert.notEqual(snapshot.state, 'failed', JSON.stringify(snapshot.error));
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Staged operation did not settle');
}

// Two import-map apps, one registering a NiiVue viewer, each vendored, built and assembled into a composite site.
let fixtureRoot;
before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'operation-parameters-runtime-'));
  await mkdir(join(fixtureRoot, 'runtime-assets'), { recursive: true });
  await cp(join(repoRoot, 'packages/components/src'), join(fixtureRoot, 'packages/components/src'), { recursive: true });
  await symlink(join(repoRoot, 'packages/components/node_modules'), join(fixtureRoot, 'packages/components/node_modules'), 'dir');
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  const apps = {
    qsmbly: "import { createNiivueAdapter } from '@neurodesk/webapp-components/automation';\nexport const adapter = nv => createNiivueAdapter(nv);\n",
    mri2vid: "import { registerAppAutomation } from '@neurodesk/webapp-components/automation';\nexport { registerAppAutomation };\n",
  };
  for (const [id, script] of Object.entries(apps)) {
    const appDir = join(fixtureRoot, 'apps', id);
    await mkdir(join(appDir, 'web/js'), { recursive: true });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: id, version: '0.29.20260930', type: 'module' }));
    await writeFile(join(appDir, 'examples.json'), JSON.stringify({ schemaVersion: 1, examples: [] }));
    await writeFile(join(appDir, 'web/index.html'), '<body><script type="module" src="js/automation.js"></script></body>');
    await writeFile(join(appDir, 'web/js/automation.js'), script);
    await execute(process.execPath, [join(repoRoot, 'scripts/vendor-components.mjs')], { cwd: appDir });
    await cp(join(appDir, 'web/vendor'), join(fixtureRoot, 'vendored', id), { recursive: true });
    await execute(process.execPath, [join(repoRoot, 'scripts/build-static.mjs')], { cwd: appDir });
  }
  // The composite serves nv-mcp's client from its runtime store; a staged client stands in for the bundled apps' chunk.
  const client = 'vendor/webapp-components/src/automation/nv-mcp.js';
  const sha256 = createHash('sha256').update(await readFile(join(fixtureRoot, 'apps/qsmbly/dist', client))).digest('hex');
  await writeFile(join(fixtureRoot, 'runtime-assets/manifest.json'), JSON.stringify({ schema_version: 1, families: [{
    id: 'nv-mcp', version: '1', target: 'nv-mcp/1', deduplicate: true,
    files: [{ name: 'nv-mcp.js', source_app: 'qsmbly', source: client, sha256 }],
  }] }));
  const siteDist = join(fixtureRoot, 'site');
  for (const id of Object.keys(apps)) await cp(join(fixtureRoot, 'apps', id, 'dist'), join(siteDist, id), { recursive: true });
  await assembleRuntimeAssetStore({ repoRoot: fixtureRoot, siteDist, registry: { apps: Object.keys(apps).map(id => ({ id, path: id })) } });
});
after(() => rm(fixtureRoot, { recursive: true, force: true }));

test('native vendor, standalone and composite staging execute the shared parameter module', async t => {
  await checkRuntime(t, join(fixtureRoot, 'vendored/qsmbly/webapp-components/src'));
  await checkRuntime(t, join(fixtureRoot, 'apps/qsmbly/dist/vendor/webapp-components/src'));
  await checkRuntime(t, join(fixtureRoot, 'site/_runtime/webapp-components/0.1.2/src'));
});

async function checkNvMcp(componentsSrc) {
  const { AgentClient, coreHandlers, sceneState } = await import(pathToFileURL(join(componentsSrc, 'automation/nv-mcp.js')));
  assert.equal(typeof AgentClient, 'function');
  assert.equal(typeof sceneState, 'function');
  assert.equal(typeof coreHandlers({ view: {} }).go_to_point, 'function');
}

test('an import-map app with a NiiVue viewer loads nv-mcp\'s client from vendor, standalone and composite staging', async () => {
  await checkNvMcp(join(fixtureRoot, 'vendored/qsmbly/webapp-components/src'));
  await checkNvMcp(join(fixtureRoot, 'apps/qsmbly/dist/vendor/webapp-components/src'));
  await checkNvMcp(join(fixtureRoot, 'site/_runtime/webapp-components/0.1.2/src'));
});

test('an import-map app without a NiiVue viewer carries no nv-mcp client', async () => {
  const source = await readFile(join(repoRoot, 'packages/components/src/automation/nv-mcp.js'), 'utf8');
  assert.equal(await readFile(join(fixtureRoot, 'vendored/mri2vid/webapp-components/src/automation/nv-mcp.js'), 'utf8'), source);
  assert.equal(await readFile(join(fixtureRoot, 'apps/mri2vid/dist/vendor/webapp-components/src/automation/nv-mcp.js'), 'utf8'), source);
});
