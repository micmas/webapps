// Serves the built Brain Extraction app at its hosted address in each installed Playwright browser, connects its
// viewer to neurodesk-mcp with "Connect an agent", and drives it from an MCP client. A browser that cannot reach the
// local server is reported, not failed: Safari (WebKit) blocks it as mixed content. Build the app first:
//   pnpm --filter brain-extraction build && pnpm --filter @neurodesk/agent-server validate:browser
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, firefox, webkit } from 'playwright';
import { hostedOrigin, startAgentServer } from '../src/server.js';

const root = resolve(import.meta.dirname, '../../..');
const dist = join(root, 'apps/brain-extraction/dist');
const fixture = join(root, 'exes/synthseg/test/fixtures/small.nii.gz');
const shots = process.env.NEURODESK_SMOKE_SHOTS;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
assert.ok(existsSync(join(dist, 'index.html')), 'Build Brain Extraction first: pnpm --filter brain-extraction build');

const lines = [];
// Not nv-mcp's default port, which a NiiVue page's own server may hold.
const server = startAgentServer({ port: 4343, log: line => lines.push(line) });
await server.listening;
const results = [];

async function drive(name, type, options) {
  if (!existsSync(type.executablePath())) return results.push(`${name}: skipped, not installed`);
  const browser = await type.launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    // Chrome asks before a public page reaches loopback; a person allows it in the prompt.
    if (options.grant) await context.grantPermissions(['local-network-access'], { origin: hostedOrigin });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== hostedOrigin || !url.pathname.startsWith('/brain-extraction/')) return route.abort();
      const path = join(dist, url.pathname.slice('/brain-extraction/'.length) || 'index.html');
      if (!existsSync(path)) return route.fulfill({ status: 404 });
      await route.fulfill({
        body: await readFile(path),
        contentType: types[extname(path)] ?? 'application/octet-stream',
        headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' },
      });
    });
    const page = await context.newPage();
    await page.goto(`${hostedOrigin}/brain-extraction/?agent=${server.port}`);
    await page.locator('#imageInput').setInputFiles(fixture);
    // The connection reports in the status bar, so the image's own status must come first.
    const status = page.locator('#statusText');
    await status.filter({ hasText: 'ready to extract brain' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Connect an agent' }).click();
    try {
      await status.filter({ hasText: 'Agent connected' }).waitFor({ timeout: 10000 });
    } catch {
      return results.push(`${name} ${browser.version()}: did not connect: ${await status.textContent()}`);
    }
    const agent = new Client({ name: 'browser-smoke', version: '0.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    try {
      const call = async (tool, args = {}) => {
        const reply = await agent.callTool({ name: tool, arguments: args });
        assert.notEqual(reply.isError, true, `${tool}: ${JSON.stringify(reply.content)}`);
        return reply;
      };
      const tabs = JSON.stringify((await call('list_tabs')).content);
      assert.match(tabs, /Brain Extraction/i);
      await call('set_view', { slice: 'axial' });
      await call('go_to_point', { mm: [0, 0, 0] });
      const shot = (await call('screenshot')).content.find(item => item.type === 'image');
      assert.ok(shot, 'screenshot returns an image');
      if (shots) await writeFile(join(shots, `${name}.png`), Buffer.from(shot.data, 'base64'));
      results.push(`${name} ${browser.version()}: connected; list_tabs, set_view, go_to_point and screenshot answered`);
    } finally {
      await agent.close();
    }
    await page.getByRole('button', { name: 'Disconnect agent' }).click();
  } finally {
    await browser.close();
  }
}

try {
  await drive('chromium', chromium, { grant: true });
  await drive('firefox', firefox, {});
  await drive('webkit', webkit, {});
} finally {
  await server.close();
}
console.log(results.join('\n'));
console.log(`server saw:\n  ${lines.join('\n  ')}`);
assert.ok(results.some(result => result.includes('screenshot answered')), 'no browser reached the server');
