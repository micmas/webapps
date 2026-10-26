import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerSessions } from '../src/viewer-sessions.js';
import { createSourceGrants } from '../src/source-grants.js';

test('retained viewers serialize commands and release capacity when closed', async () => {
  const sessions = createViewerSessions({ maximum: 1 });
  const calls = [];
  let closed = 0;
  const session = sessions.add({ app: 'viewer', runId: 'run', adapter: {
    async command(name) {
      calls.push(`start:${name}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      calls.push(`end:${name}`);
      return name;
    },
    close() { closed++; },
  } });
  assert.throws(() => sessions.assertCapacity(), /limit/);
  assert.deepEqual(await Promise.all([
    sessions.command(session.id, 'viewers.state'), sessions.command(session.id, 'viewers.regions'),
  ]), ['viewers.state', 'viewers.regions']);
  assert.deepEqual(calls, ['start:viewers.state', 'end:viewers.state', 'start:viewers.regions', 'end:viewers.regions']);
  await sessions.close(session.id);
  await sessions.close(session.id);
  assert.equal(closed, 1);
  sessions.assertCapacity();
  assert.throws(() => sessions.command(session.id, 'viewers.state'), /closed/);
});

test('a stalled viewer command closes the session and rejects queued commands', async () => {
  const sessions = createViewerSessions({ timeoutMs: 20 });
  let closed = 0;
  const session = sessions.add({ app: 'viewer', runId: 'run', adapter: {
    command: () => new Promise(() => {}), close() { closed++; },
  } });
  // Keep the test alive while the unreferenced AbortSignal timer expires.
  const alive = setInterval(() => {}, 100);
  try {
    await assert.rejects(sessions.command(session.id, 'viewers.state'), /timeout/i);
    assert.equal(closed, 1);
    assert.deepEqual(sessions.list(), []);
  } finally { clearInterval(alive); }
});

test('closing a retained window removes its session and cancels pending commands', async () => {
  const sessions = createViewerSessions({ maximum: 1 });
  const windowClosed = new AbortController();
  let calls = 0;
  let started;
  const starting = new Promise(resolve => { started = resolve; });
  const session = sessions.add({ app: 'viewer', runId: 'run', adapter: {
    closedSignal: windowClosed.signal,
    command() { calls++; started(); return new Promise(() => {}); },
    close() { assert.fail('The window has already closed'); },
  } });
  const pending = sessions.command(session.id, 'viewers.state');
  const queued = sessions.command(session.id, 'viewers.regions');
  await starting;
  windowClosed.abort();
  assert.deepEqual(sessions.list(), []);
  sessions.assertCapacity();
  await assert.rejects(pending, /Viewer session closed/);
  await assert.rejects(queued, /closed viewer session/);
  assert.equal(calls, 1);
  assert.throws(() => sessions.command(session.id, 'viewers.state'), /closed viewer session/);
  await sessions.close(session.id);
});

test('a window closed before retention cannot occupy a session slot', () => {
  const sessions = createViewerSessions({ maximum: 1 });
  const windowClosed = new AbortController();
  windowClosed.abort();
  assert.throws(() => sessions.add({ app: 'viewer', runId: 'run', adapter: {
    closedSignal: windowClosed.signal, close() {}, command() {},
  } }), /Viewer window is closed/);
  assert.deepEqual(sessions.list(), []);
  sessions.assertCapacity();
});

test('pending completion occupies capacity but hides its viewer and rejects commands', async () => {
  const sessions = createViewerSessions({ maximum: 1 });
  let ready = false;
  let calls = 0;
  let closed = 0;
  const session = sessions.add({ app: 'viewer', runId: 'run', isReady: () => ready, adapter: {
    command() { calls++; return 'state'; }, close() { closed++; },
  } });
  assert.deepEqual(sessions.list(), []);
  assert.throws(() => sessions.assertCapacity(), /limit/);
  assert.throws(() => sessions.command(session.id, 'viewers.state'), /Unknown or closed/);
  ready = true;
  assert.deepEqual(sessions.list(), [session]);
  const queued = sessions.command(session.id, 'viewers.state');
  ready = false;
  await assert.rejects(queued, /Unknown or closed/);
  assert.equal(calls, 0);
  await sessions.close(session.id);
  assert.equal(closed, 1);
  sessions.assertCapacity();
});

test('invalid viewer actions preserve a usable session, while connection close releases it', async () => {
  const sessions = createViewerSessions();
  let closed = 0;
  const session = sessions.add({ app: 'viewer', runId: 'run', adapter: {
    command: async command => { if (command === 'viewers.tab') throw new Error('Unknown tab'); return { position: [1, 2, 3] }; },
    close() { closed++; },
  } });
  assert.throws(() => sessions.command(session.id, 'eval', {}), /Unsupported/);
  await assert.rejects(sessions.command(session.id, 'viewers.tab'), /Unknown tab/);
  assert.deepEqual(await sessions.command(session.id, 'viewers.state'), { position: [1, 2, 3] });
  await sessions.closeAll();
  assert.equal(closed, 1);
});

test('remote grants cover the supplied source tree and sources approved later, nothing else', () => {
  const grants = createSourceGrants();
  grants.add(['https://data.example/scan.zarr']);
  assert.equal(grants.permits('https://data.example/scan.zarr/0/1/2'), true);
  for (const url of ['https://data.example/scan.zarr-other/0', 'https://other.example/scan.zarr/0',
    'https://data.example/scan.zarr/../secret', 'https://user:secret@data.example/scan.zarr/0']) {
    assert.equal(grants.permits(url), false, url);
  }
  grants.add(['http://127.0.0.1:4517/T2.nii.gz']);
  assert.equal(grants.permits('http://127.0.0.1:4517/T2.nii.gz'), true);
  assert.equal(grants.permits('https://data.example/scan.zarr/0'), true, 'a later grant keeps the earlier ones');
  for (const source of ['file:///etc/passwd', 'https://user:secret@data.example/T1.nii.gz']) {
    assert.throws(() => grants.add([source]), /Invalid remote input URL/, source);
  }
});

test('source approval goes to the session window outside the command queue', async () => {
  const sessions = createViewerSessions();
  let release;
  const adapter = {
    command: () => new Promise(resolve => { release = resolve; }),
    async grantSource(source, { signal }) { return { url: source.url, aborted: signal.aborted }; },
    close() {},
  };
  const session = sessions.add({ app: 'viewer', runId: 'run', adapter });
  const pending = sessions.command(session.id, 'viewers.state');
  assert.deepEqual(await sessions.grantSource(session.id, { url: 'https://data.example/T2.nii.gz' }),
    { url: 'https://data.example/T2.nii.gz', aborted: false });
  release('done');
  assert.equal(await pending, 'done');
  const plain = sessions.add({ app: 'viewer', runId: 'run', adapter: { command() {}, close() {} } });
  await assert.rejects(sessions.grantSource(plain.id, { path: '/data/T2.nii.gz' }), /cannot load sources/);
});
