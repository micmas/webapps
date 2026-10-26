import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio.js', import.meta.url));

function connect(t, args = []) {
  const child = spawn(process.execPath, [fixture, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const messages = [];
  const invalidLines = [];
  let stderr = '';
  let nextId = 0;
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const { reject } of pending.values()) reject(new Error(`MCP fixture exited: ${code}, ${signal}, ${stderr}`));
    resolve({ code, signal });
  }));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      messages.push(message);
      if (pending.has(message.id)) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      }
    } catch (error) {
      invalidLines.push(line);
      for (const { reject } of pending.values()) reject(error);
    }
  });
  t.after(async () => {
    child.kill();
    await exited;
    assert.deepEqual(invalidLines, [], 'stdout must contain only JSON-RPC messages');
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}: ${stderr}`));
    }, 5000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    notify,
    tool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    messages,
    get stderr() { return stderr; },
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'neurodesk-mcp-test', version: '1.0.0' },
      });
      assert.equal(response.error, undefined);
      assert.equal(response.result.protocolVersion, '2025-11-25');
      notify('notifications/initialized');
      return response.result;
    },
    async end() {
      child.stdin.end();
      return exited;
    },
  };
}

async function inputFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.nii');
  await writeFile(path, gunzipSync(await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url))));
  return path;
}

function value(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
  return response.result.structuredContent;
}

test('stdio initializes and discovers strict contract-derived tools and resource templates', { timeout: 10000 }, async t => {
  const client = connect(t);
  const initialized = await client.initialize();
  assert.equal(initialized.serverInfo.version, '0.14.20260928');
  assert.ok(initialized.capabilities.tools);
  assert.ok(initialized.capabilities.resources);
  const listed = await client.request('tools/list');
  const tools = new Map(listed.result.tools.map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].filter(name => /^(apps|runs?|sessions|viewers)_/.test(name)).sort(), ['apps_describe', 'apps_list', 'apps_validate', 'run_brain_extraction', 'run_synthseg', 'runs_cancel', 'runs_get', 'runs_start', 'sessions_close', 'sessions_grant', 'sessions_list', 'viewers_crosshair', 'viewers_display', 'viewers_list', 'viewers_regions', 'viewers_screenshot', 'viewers_state', 'viewers_tab', 'viewers_volumes']);
  for (const name of ['list_tabs', 'use_tab', 'where_am_i', 'go_to_point', 'set_view', 'set_volume', 'screenshot']) assert.ok(tools.has(name), name);
  const synthseg = tools.get('run_synthseg').inputSchema;
  assert.equal(synthseg.additionalProperties, false);
  assert.equal(synthseg.properties.inputs.additionalProperties, false);
  assert.equal(synthseg.properties.parameters.additionalProperties, false);
  assert.deepEqual(synthseg.properties.parameters.properties.mode.enum, ['normal', 'fast']);
  assert.equal(synthseg.properties.parameters.properties.ct.type, 'boolean');
  assert.equal(synthseg.properties.parameters.properties.ct.default, undefined);
  assert.equal(tools.get('run_brain_extraction').inputSchema.properties.parameters.properties.threshold.maximum, 1);
  for (const name of tools.keys()) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(tools.get('runs_get').inputSchema.properties.runId.type, 'string');
  assert.equal(value(await client.tool('apps_list')).apps.length, 2);
  assert.equal(value(await client.tool('apps_describe', { app: 'synthseg' })).app, 'synthseg');
  const templates = await client.request('resources/templates/list');
  assert.deepEqual(templates.result.resourceTemplates.map(template => template.uriTemplate).sort(), [
    'neurodesk://runs/{runId}/artifacts/{artifactId}',
    'neurodesk://runs/{runId}/report',
  ]);
  assert.deepEqual((await client.request('resources/list')).result.resources, []);
  assert.equal((await client.end()).code, 0);
});

test('viewer tools return screenshots as image content and validate display updates', { timeout: 10000 }, async t => {
  const client = connect(t);
  await client.initialize();
  const tools = new Map((await client.request('tools/list')).result.tools.map(tool => [tool.name, tool]));
  assert.equal(tools.get('viewers_screenshot').annotations.readOnlyHint, true);
  assert.equal(tools.get('viewers_display').annotations.readOnlyHint, false);
  assert.deepEqual(tools.get('viewers_display').inputSchema.properties.sliceType.enum, ['axial', 'coronal', 'sagittal', 'multiplanar', 'render']);
  const shot = await client.tool('viewers_screenshot', { sessionId: 'session-1', viewerId: 'main' });
  assert.notEqual(shot.result.isError, true, JSON.stringify(shot.result));
  assert.deepEqual(shot.result.content[0], { type: 'image', mimeType: 'image/png', data: Buffer.from('fixture png').toString('base64') });
  assert.deepEqual(JSON.parse(shot.result.content[1].text), { width: 2, height: 1 });
  assert.deepEqual(shot.result.structuredContent, { width: 2, height: 1 });
  assert.equal(value(await client.tool('viewers_volumes', { sessionId: 'session-1', viewerId: 'main' })).volumes[0].name, 'T1.nii.gz');
  const display = { sliceType: 'axial', volumes: [{ index: 0, colormap: 'hot', calMin: 10, calMax: 200, opacity: 0.5 }] };
  assert.deepEqual(value(await client.tool('viewers_display', { sessionId: 'session-1', viewerId: 'main', ...display })),
    { command: 'viewers.display', args: { viewerId: 'main', ...display } });
  for (const invalid of [{ sliceType: 'oblique' }, { volumes: [{ index: -1 }] }, { volumes: [{ index: 0, opacity: 2 }] }, { volumes: [{ index: 0, gamma: 2 }] }]) {
    const response = await client.tool('viewers_display', { sessionId: 'session-1', viewerId: 'main', ...invalid });
    assert.ok(response.error || response.result.isError, JSON.stringify(invalid));
  }
  const closed = await client.tool('viewers_screenshot', { sessionId: 'missing', viewerId: 'main' });
  assert.equal(closed.result.isError, true);
  assert.match(closed.result.content[0].text, /closed viewer session/);
});

test('nv-mcp tools reach a retained NiiVue viewer through its session', { timeout: 10000 }, async t => {
  const client = connect(t);
  await client.initialize();
  const text = response => response.result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const tabs = await client.tool('list_tabs');
  assert.notEqual(tabs.result.isError, true, JSON.stringify(tabs.result));
  assert.match(text(tabs), /session-1/);
  const moved = await client.tool('go_to_point', { mm: [10, -20, 30] });
  assert.notEqual(moved.result.isError, true, JSON.stringify(moved.result));
  assert.deepEqual(JSON.parse(text(moved).slice(text(moved).indexOf('{'))), { viewerId: 'main', method: 'go_to_point', params: { mm: [10, -20, 30] } });
  const shot = await client.tool('screenshot', {});
  assert.notEqual(shot.result.isError, true, JSON.stringify(shot.result));
  assert.deepEqual(shot.result.content.find(part => part.type === 'image'),
    { type: 'image', mimeType: 'image/png', data: Buffer.from('fixture png').toString('base64') });
  const rejected = await client.tool('go_to_point', { bogus: 1 });
  assert.ok(rejected.error || rejected.result.isError);
  const forwarded = async args => {
    const response = await client.tool('load_volume', args);
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
    return JSON.parse(text(response).slice(text(response).indexOf('{'))).params.url;
  };
  assert.equal(await forwarded({ url: '/data/sub-01/T2.nii.gz' }), 'http://127.0.0.1:1/_local/token/T2.nii.gz');
  assert.equal(await forwarded({ url: 'https://example.org/T2.nii.gz' }), 'https://example.org/T2.nii.gz');
  assert.equal(await forwarded({ url: 'T1.nii.gz' }), 'T1.nii.gz');
  assert.equal(await forwarded({ url: 'http://127.0.0.1:4517/T2.nii.gz' }), 'http://127.0.0.1:4517/T2.nii.gz');
  const denied = await client.tool('load_volume', { url: 'https://example.org/denied.nii.gz' });
  assert.equal(denied.result.isError, true);
  assert.match(text(denied), /was denied/);
  const borrowed = await client.tool('load_volume', { url: '../_local/foreign/T2.nii.gz' });
  assert.equal(borrowed.result.isError, true, 'a relative address into the local mounts is put to the session');
  assert.match(text(borrowed), /not granted to this viewer/);
  // sessions_grant takes every http(s) URL a loading tool takes, loopback and IP addresses included.
  for (const url of ['http://127.0.0.1:4517/T2.nii.gz', 'http://localhost:4517/T2.nii.gz', 'http://[::1]:4517/T2.nii.gz']) {
    assert.deepEqual(value(await client.tool('sessions_grant', { sessionId: 'session-1', url })),
      { sessionId: 'session-1', url, grantedUrl: url, approval: 'person' });
  }
  assert.deepEqual(value(await client.tool('sessions_grant', { sessionId: 'session-1', path: '/data/sub-01/T2.nii.gz' })), {
    sessionId: 'session-1', path: '/data/sub-01/T2.nii.gz', grantedUrl: 'http://127.0.0.1:1/_local/token/T2.nii.gz', approval: 'person',
  });
  for (const args of [
    { sessionId: 'session-1' },
    { sessionId: 'session-1', path: 'relative.nii' },
    { sessionId: 'session-1', path: '/data/T2.nii', url: 'https://example.org/T2.nii' },
    { sessionId: 'session-1', url: 'ftp://example.org/T2.nii' },
    { sessionId: 'session-1', url: 'https://example.org/denied.nii.gz' },
  ]) {
    const response = await client.tool('sessions_grant', args);
    assert.ok(response.error || response.result.isError, JSON.stringify(args));
  }
  const refused = await client.tool('go_to_point', { mm: [666, 0, 0] });
  assert.equal(refused.result.isError, true);
  assert.match(text(refused), /The page refused/);
  await client.tool('sessions_close', { sessionId: 'session-1' });
  assert.doesNotMatch(text(await client.tool('list_tabs')), /session-1/);
});

test('an address with a user name or password is refused before approval, however it is written', { timeout: 10000 }, async t => {
  const client = connect(t);
  await client.initialize();
  const text = response => response.result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const forwarded = async (name, args) => {
    const response = await client.tool(name, args);
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
    return JSON.parse(text(response).slice(text(response).indexOf('{'))).params;
  };
  assert.equal((await forwarded('load_volume', { url: '/data/reader@lab/T2.nii.gz' })).url, 'http://127.0.0.1:1/_local/token/T2.nii.gz');
  for (const labels of ['freesurfer', 'https://example.org/atlas/labels.json']) {
    assert.equal((await forwarded('add_overlay', { url: 'https://example.org/T2.nii.gz', labels })).labels, labels);
  }
  const font = { atlas: 'https://example.org/font/atlas.png', metrics: 'https://example.org/font/metrics.json' };
  assert.deepEqual(await forwarded('set_font', font), font);
  for (const [name, args] of [
    ['add_overlay', { url: 'https://example.org/T2.nii.gz', labels: 'https://example.org/denied.nii.gz' }],
    ['set_font', { ...font, atlas: 'https://example.org/denied.nii.gz' }],
    ['set_font', { ...font, metrics: 'https://example.org/denied.nii.gz' }],
  ]) {
    const response = await client.tool(name, args);
    assert.equal(response.result.isError, true, JSON.stringify(args));
    assert.match(text(response), /was denied/);
  }
  for (const [name, args] of [
    ['load_volume', { url: '//reader:secret@example.org/T2.nii.gz' }],
    ['load_volume', { url: '\\\\reader:secret@example.org\\T2.nii.gz' }],
    ['load_volume', { url: '/\\reader:secret@example.org/T2.nii.gz' }],
    ['load_volume', { url: ' //reader:secret@example.org/T2.nii.gz' }],
    ['load_volume', { url: '//reader:secret@[example.org/T2.nii.gz' }],
    ['load_volume', { url: 'http://reader:secret@example.org:99999/T2.nii.gz' }],
    ['load_mesh', { url: 'https://example.org/lh.pial', layers: [{ url: '//reader:secret@example.org/lh.curv' }] }],
    ['add_overlay', { url: 'https://example.org/T2.nii.gz', labels: 'http://reader:secret@example.org/labels.json' }],
    ['add_overlay', { url: 'https://example.org/T2.nii.gz', labels: '//reader:secret@example.org/labels.json' }],
    ['set_volume', { labels: 'http://reader:secret@example.org/labels.json' }],
    ['add_data', { id: 'atlas', tool: 'add_overlay', args: { url: 'https://example.org/T2.nii.gz', labels: '//reader:secret@example.org/labels.json' } }],
    ['set_font', { atlas: '//reader:secret@example.org/font/atlas.png', metrics: 'https://example.org/font/metrics.json' }],
    ['set_font', { atlas: 'https://example.org/font/atlas.png', metrics: 'http://reader:secret@example.org/font/metrics.json' }],
    ['sessions_grant', { sessionId: 'session-1', path: '//reader:secret@example.org/T2.nii.gz' }],
    ['sessions_grant', { sessionId: 'session-1', path: 'http://reader:secret@example.org/T2.nii.gz' }],
  ]) {
    const response = await client.tool(name, args);
    assert.equal(response.result?.isError, true, `${name} ${JSON.stringify(args)}: ${JSON.stringify(response)}`);
    assert.equal(text(response), 'Source URLs must not contain credentials', `${name} ${JSON.stringify(args)}`);
  }
});

test('validation rejects invalid metadata and missing files while preserving omitted CT', { timeout: 10000 }, async t => {
  const path = await inputFile(t);
  const client = connect(t);
  await client.initialize();
  const validated = value(await client.tool('apps_validate', { app: 'synthseg', inputs: { image: [path] } }));
  assert.deepEqual(validated.parameters, { mode: 'normal' });
  assert.equal(validated.engine, 'browser');
  for (const [tool, request] of [
    ['apps_validate', { app: 'synthseg', inputs: { image: [join(path, 'missing.nii')] } }],
    ['apps_validate', { app: 'synthseg', inputs: { image: ['relative.nii'] } }],
    ['runs_start', { app: 'synthseg', inputs: { image: [path] }, unexpected: true }],
    ['run_synthseg', { inputs: { image: [path] }, parameters: { ct: 'false' } }],
    ['run_synthseg', { inputs: { image: [path] }, parameters: { mode: 'unknown' } }],
    ['run_synthseg', { inputs: { image: [path] }, parameters: { invented: true } }],
    ['run_synthseg', { inputs: { image: [path] }, engine: 'native' }],
    ['run_brain_extraction', { inputs: { image: [path] }, parameters: { threshold: 1.1 } }],
    ['runs_get', { runId: 1 }],
  ]) {
    const response = await client.tool(tool, request);
    assert.ok(response.error || response.result?.isError, `${tool} must reject ${JSON.stringify(request)}`);
  }
  assert.equal(value(await client.tool('run_synthseg', { inputs: { image: [path] } })).id, 'run-1');
  assert.equal((await client.end()).code, 0);
  assert.match(client.stderr, /"states":\["cancelled"\]/);
});

test('asynchronous runs expose completion, cancellation and registered report/artifact resources', { timeout: 10000 }, async t => {
  const path = await inputFile(t);
  const client = connect(t);
  await client.initialize();
  const started = value(await client.tool('run_synthseg', { inputs: { image: [path] }, parameters: { mode: 'fast' } }));
  assert.equal(started.state, 'running');
  const complete = value(await client.tool('runs_get', { runId: started.id }));
  assert.equal(complete.state, 'succeeded');
  assert.equal(value(await client.tool('runs_cancel', { runId: started.id })).state, 'succeeded');
  const resources = (await client.request('resources/list')).result.resources;
  assert.equal(resources.length, 2);
  const report = await client.request('resources/read', { uri: complete.reportUri });
  assert.deepEqual(JSON.parse(report.result.contents[0].text).parameters, { mode: 'fast' });
  const artifact = await client.request('resources/read', { uri: complete.report.artifacts[0].uri });
  assert.equal(Buffer.from(artifact.result.contents[0].blob, 'base64').toString(), 'fixture output');
  for (const uri of ['file:///etc/passwd', 'neurodesk://runs/unknown/report', `neurodesk://runs/${started.id}/artifacts/missing`]) {
    assert.ok((await client.request('resources/read', { uri })).error, `Resource must be rejected: ${uri}`);
  }
  const running = value(await client.tool('runs_start', { app: 'brain-extraction', inputs: { image: [path] }, engine: 'native' }));
  assert.equal(running.engine, 'native');
  assert.equal(value(await client.tool('runs_cancel', { runId: running.id })).state, 'cancelled');
  assert.equal(value(await client.tool('runs_cancel', { runId: running.id })).state, 'cancelled');
  assert.equal(value(await client.tool('runs_get', { runId: running.id })).report, undefined);
  await client.tool('runs_start', { app: 'synthseg', inputs: { image: [path] } });
  assert.equal((await client.end()).code, 0);
  assert.match(client.stderr, /"closeCount":1/);
  assert.match(client.stderr, /"states":\["succeeded","cancelled","cancelled"\]/);
});

test('EOF before initialization and repeated explicit close release the service once', { timeout: 10000 }, async t => {
  for (const args of [[], ['--close-twice']]) {
    const client = connect(t, args);
    assert.equal((await client.end()).code, 0);
    assert.equal(client.messages.length, 0);
    assert.equal(client.stderr.trim(), '{"closeCount":1,"states":[]}');
  }
});


test('stdio tools/list publishes native recursive parameter constraints and active defaults', { timeout: 10000 }, async t => {
  const client = connect(t, ['--parameters']);
  await client.initialize();
  const listed = await client.request('tools/list');
  const tool = listed.result.tools.find(tool => tool.name === 'run_settings');
  const parameters = tool.inputSchema.properties.parameters;
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.default, {});
  assert.equal(parameters.required, undefined);
  const { method, threshold, iterations, numeric, flag, enabled, schedule } = parameters.properties;
  assert.deepEqual(method, { type: 'string', enum: ['fast', 'normal'], description: 'Scientific method', default: 'normal' });
  assert.deepEqual(threshold, { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.01, description: 'Intensity threshold', default: 0.15 });
  assert.deepEqual(numeric, { allOf: [{ type: 'number' }, { type: 'number', enum: [1, 2] }], description: 'Numeric choice' });
  assert.deepEqual(flag, { allOf: [{ type: 'boolean' }, { type: 'boolean', const: false }], description: 'Boolean choice' });
  assert.equal(iterations.type, 'integer');
  assert.equal(iterations.description, 'Iteration count');
  assert.equal(iterations.minimum, Number.MIN_SAFE_INTEGER);
  assert.equal(iterations.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(enabled.type, 'boolean');
  assert.equal(enabled.description, 'Enable processing');
  assert.equal(enabled.default, false);
  assert.equal(schedule.type, 'array');
  assert.equal(schedule.description, 'Resolution schedule');
  assert.equal(schedule.minItems, 1);
  assert.equal(schedule.maxItems, 2);
  assert.deepEqual(schedule.default, [[0.15]]);
  assert.equal(schedule.items.description, 'Resolution entries');
  assert.equal(schedule.items.minItems, 1);
  assert.equal(schedule.items.maxItems, 3);
  assert.deepEqual(schedule.items.items, { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.01, description: 'Resolution weight' });
  assert.deepEqual(value(await client.tool('apps_validate', { app: 'settings' })).parameters, {
    method: 'normal', threshold: 0.15, enabled: false, schedule: [[0.15]],
  });
  assert.equal((await client.end()).code, 0);
});
