import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { registerAppAutomation, createNiivueAdapter } from '../src/automation/index.js';
import { createAgentControl } from '../src/ui/agentControl.js';

const contract = { schemaVersion: 2, app: 'test', appVersion: '0.1.20260928', defaultOperation: 'run', operations: {
  run: { mode: 'viewer', inputs: {}, parameters: {}, artifacts: {}, engines: ['browser'] },
} };

// Stands in for the browser's WebSocket so the test sees what the page sends and can play the server.
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static sockets = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeSocket.sockets.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  receive(message) {
    const event = new Event('message');
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }
}

function fixture(t) {
  const dom = new JSDOM('<body></body>', { url: 'https://webapps.neurodesk.org/test/' });
  t.after(() => dom.window.close());
  FakeSocket.sockets = [];
  const registration = registerAppAutomation({ app: 'test', contract, operations: { run: async () => ({}) },
    document: dom.window.document, target: dom.window });
  const nv = {
    volumes: [{ name: 'T1.nii.gz', colormap: 'gray', calMin: 0, calMax: 900, opacity: 1, dims: [3, 4, 5, 6] }],
    sliceType: 3,
    getCrosshairPos: () => [0.5, 0.5, 0.5],
    setCrosshairPos() {},
    getClipPlaneDepthAziElev: () => [2, 0, 0],
    drawScene() {},
    async setVolume() {},
  };
  return { dom, registration, nv };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('an agent connection answers nv-mcp requests from the main viewer only after the person connects', async t => {
  const { registration, nv } = fixture(t);
  const connection = registration.agentConnection({ WebSocket: FakeSocket, storage: null, port: 4300 });
  await assert.rejects(connection.connect(), /Open an image first/);
  registration.registerViewer('other', createNiivueAdapter({ ...nv, volumes: [] }));
  registration.registerViewer('main', createNiivueAdapter(nv));
  const seen = [];
  connection.watch(status => seen.push(status));
  assert.equal(FakeSocket.sockets.length, 0, 'nothing connects before connect()');
  await connection.connect();
  const [socket] = FakeSocket.sockets;
  assert.equal(socket.url, 'ws://127.0.0.1:4300/app');
  assert.deepEqual(connection.status, { active: true, connected: false, id: connection.status.id });
  socket.open();
  assert.equal(connection.status.connected, true);
  assert.equal(socket.sent[0].hello.state.volume, 'T1.nii.gz', 'the hello carries the main viewer, not the first registered');
  socket.receive({ welcome: { id: socket.sent[0].hello.id } });
  socket.receive({ id: 1, method: 'set_view', params: { slice: 'axial' } });
  await settle();
  assert.equal(nv.sliceType, 0);
  assert.equal(socket.sent[1].id, 1);
  assert.equal(socket.sent[1].state.volume, 'T1.nii.gz');
  connection.disconnect();
  assert.equal(socket.readyState, 3);
  assert.deepEqual(connection.status, { active: false, connected: false, id: null });
  assert.deepEqual(seen.map(({ active, connected }) => [active, connected]), [[true, false], [true, false], [true, true], [false, false], [false, false]],
    'a deliberate disconnect never reads as waiting to reconnect');
  assert.equal(FakeSocket.sockets.length, 1, 'a disconnected page does not retry');
});

test('the agent control reports its connection through the app status and keeps only its action and help', async t => {
  const { dom, registration, nv } = fixture(t);
  const connection = registration.agentConnection({ WebSocket: FakeSocket, storage: null });
  const reported = [];
  const control = createAgentControl(connection, { document: dom.window.document, onStatus: (message, error = false) => reported.push([message, error]) });
  const button = control.querySelector('button');
  const help = control.querySelector('.nd-viewer-label').textContent;
  assert.equal(button.textContent, 'Connect an agent');
  assert.ok(help.length <= 90, help);
  assert.match(control.querySelector('.nd-info-icon .nd-info-tooltip').textContent, /port 4242.*Chrome.*local network.*Safari cannot connect/);
  assert.equal(control.querySelector('[role="status"], [aria-live]'), null, 'live status belongs to the status bar');
  assert.deepEqual(reported, [], 'nothing is reported before the person acts');
  button.click();
  await settle();
  assert.deepEqual(reported, [['Open an image first. There is no viewer for an agent yet.', true]]);
  assert.equal(FakeSocket.sockets.length, 0);
  registration.registerViewer('main', createNiivueAdapter(nv));
  button.click();
  await settle();
  await settle();
  assert.equal(button.textContent, 'Disconnect agent');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  FakeSocket.sockets[0].open();
  button.click();
  assert.equal(button.textContent, 'Connect an agent');
  assert.equal(FakeSocket.sockets[0].readyState, 3);
  assert.deepEqual(reported.slice(1).map(([message, error]) => [message.replace(/tab \S+\./, 'tab <id>.'), error]), [
    ['Waiting for neurodesk-mcp on port 4242, or for Chrome\'s local network prompt.', false],
    ['Agent connected. This viewer is tab <id>.', false],
    ['Agent disconnected.', false],
  ]);
  for (const [message] of reported) assert.ok(message.length <= 90, message);
  assert.equal(control.querySelector('.nd-viewer-label').textContent, help, 'the toolbar help never changes');
});
