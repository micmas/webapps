import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { originAllowed, startAgentServer } from '../src/server.js';

let server;
const lines = [];

before(async () => {
  server = startAgentServer({ port: 0, log: line => lines.push(line) });
  await server.listening;
});
after(() => server.close());

/** Opens the app socket as a page on `origin` would; resolves with the socket, or rejects with the refusal's status. */
function openPage(origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.appUrl, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

function get(path, host) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.port, path, headers: { host } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

test('pages on the hosted site and on loopback may connect; others may not', async () => {
  assert.equal(originAllowed(undefined, '127.0.0.1', []), true);
  assert.equal(originAllowed('http://localhost:5173', '127.0.0.1', []), true);
  assert.equal(originAllowed('https://evil.example', '127.0.0.1', []), false);
  assert.equal(originAllowed('not a url', '127.0.0.1', []), false);

  (await openPage('https://webapps.neurodesk.org')).close();
  await assert.rejects(openPage('https://evil.example'), { status: 403 });
  assert.ok(lines.includes('refused a socket from https://evil.example'));
});

test('an agent reaches a connected page through /mcp', async () => {
  const page = await openPage('https://webapps.neurodesk.org');
  page.on('message', data => {
    const { id, method, params } = JSON.parse(data.toString());
    if (method === 'set_view') page.send(JSON.stringify({ id, result: { slice: params.slice } }));
  });
  page.send(JSON.stringify({ hello: { id: 'brain', title: 'Brain Extraction', url: 'https://webapps.neurodesk.org/brain-extraction/', state: null } }));

  const agent = new Client({ name: 'test', version: '0.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  try {
    const { tools } = await agent.listTools();
    assert.ok(tools.some(tool => tool.name === 'set_view'));
    const listing = await agent.callTool({ name: 'list_tabs', arguments: {} });
    assert.match(JSON.stringify(listing.content), /Brain Extraction/);
    const view = await agent.callTool({ name: 'set_view', arguments: { slice: 'axial' } });
    assert.notEqual(view.isError, true, JSON.stringify(view.content));
  } finally {
    await agent.close();
    page.close();
  }
  assert.ok(lines.some(line => line.startsWith('tab connected: brain')));
});

test('the status page and /mcp answer only to this server’s own host names', async () => {
  const own = await get('/', `127.0.0.1:${server.port}`);
  assert.equal(own.status, 200);
  assert.match(own.body, /mcp endpoint: http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.equal((await get('/', 'rebound.example')).status, 403);
  assert.equal((await get('/mcp', 'rebound.example')).status, 403);
});

/** Writes `text` to the server as it is, resolves with the status line it answers, then closes or resets the connection. */
function raw(text, { reset = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, '127.0.0.1', () => socket.write(text));
    socket.once('data', data => {
      resolve(data.toString().split('\r\n')[0]);
      if (reset) socket.resetAndDestroy();
      else socket.destroy();
    });
    socket.once('error', reject);
  });
}

const upgrade = 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n';

test('a malformed request or frame is refused without stopping the server', { timeout: 5000 }, async () => {
  const host = `127.0.0.1:${server.port}`;
  assert.equal(await raw(`GET http://[ HTTP/1.1\r\nHost: ${host}\r\n\r\n`), 'HTTP/1.1 404 Not Found');
  assert.equal(await raw(`GET http://[ HTTP/1.1\r\nHost: ${host}\r\n${upgrade}\r\n`), 'HTTP/1.1 404 Not Found');
  const page = await openPage('https://webapps.neurodesk.org');
  const closed = new Promise(resolve => page.once('close', resolve));
  page.send(Buffer.from([0xff, 0xfe]), { binary: false });
  assert.equal(await closed, 1007, 'a text frame that is not UTF-8 closes that socket');
  assert.equal((await get('/', host)).status, 200);
});

test('a client that resets a refused socket does not stop the server', { timeout: 5000 }, async () => {
  const host = `127.0.0.1:${server.port}`;
  for (const [request, status] of [
    [`GET /elsewhere HTTP/1.1\r\nHost: ${host}\r\n${upgrade}\r\n`, 'HTTP/1.1 404 Not Found'],
    [`GET /app HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://evil.example\r\n${upgrade}\r\n`, 'HTTP/1.1 403 Forbidden'],
    [`GET http://[ HTTP/1.1\r\nHost: ${host}\r\n${upgrade}\r\n`, 'HTTP/1.1 404 Not Found'],
  ]) assert.equal(await raw(request, { reset: true }), status);
  assert.equal((await get('/', host)).status, 200);
});

test('a client that keeps a refused socket half open does not hold up shutdown', { timeout: 10000 }, async () => {
  const cli = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise(resolve => cli.once('exit', (code, signal) => resolve({ code, signal })));
  let held;
  try {
    let stderr = '';
    const port = await new Promise((resolve, reject) => {
      cli.stderr.on('data', chunk => {
        stderr += chunk;
        const listening = /on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
        if (listening) resolve(Number(listening[1]));
      });
      exited.then(status => reject(new Error(`neurodesk-mcp exited ${JSON.stringify(status)}: ${stderr}`)));
    });
    const answer = await new Promise((resolve, reject) => {
      held = connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => {
        held.write(`GET /app HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: https://evil.example\r\n${upgrade}\r\n`);
      });
      held.once('data', data => resolve(data.toString().split('\r\n')[0]));
      held.once('error', reject);
    });
    assert.equal(answer, 'HTTP/1.1 403 Forbidden');
    cli.kill('SIGTERM');
    const status = await Promise.race([exited, delay(3000, 'still running')]);
    assert.deepEqual(status, { code: 0, signal: null }, 'neurodesk-mcp exits while the client still holds its side open');
  } finally {
    held?.destroy();
    cli.kill('SIGKILL');
  }
});
