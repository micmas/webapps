import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppContract } from '../scripts/lib/app-automation.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const { origin, close } = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args: process.platform === 'linux' ? [
  '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader',
  '--enable-features=Vulkan', '--disable-vulkan-surface',
] : [] });
const entries = [];
try {
  for (const app of (await loadAppsRegistry()).apps) {
    const page = await browser.newPage();
    try {
      await page.context().route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
      await page.goto(`${origin}/${app.path}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation), null, { timeout: 60000 });
      const actual = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('describe'));
      const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
      const expected = await loadAppContract(app, version);
      assert.deepEqual(actual, expected, `${app.id}: published contract differs from source`);
      // An agent's first NiiVue tool call imports nv-mcp's client into the page, from wherever this layout serves it.
      const niivue = await page.evaluate(async () => {
        const viewers = await globalThis.neurodeskAutomation.dispatch('viewers.list');
        const answered = [];
        for (const { id } of viewers.filter(viewer => viewer.capabilities.niivue)) {
          const { state } = await globalThis.neurodeskAutomation.dispatch('viewers.niivue', { viewerId: id });
          if (state && typeof state === 'object') answered.push(id);
        }
        return answered;
      });
      entries.push({ app: app.id, version, operations: Object.keys(actual.operations), niivue, passed: true });
      console.log(`PASS ${app.id}: ${Object.keys(actual.operations).join(', ')}${niivue.length ? `; nv-mcp ${niivue.join(', ')}` : ''}`);
    } catch (error) {
      entries.push({ app: app.id, passed: false, error: error.message });
      console.error(`FAIL ${app.id}: ${error.message}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await close();
}
if (process.env.AUTOMATION_CATALOG_REPORT) {
  await writeFile(process.env.AUTOMATION_CATALOG_REPORT, JSON.stringify({
    scope: 'Production contract publication, operation registration and nv-mcp loading for each viewer that offers it; scientific execution is checked by app tests.',
    entries,
  }, null, 2));
}
assert.ok(entries.every(entry => entry.passed), 'Catalog automation registration failed');
assert.ok(entries.some(entry => entry.niivue?.length), 'No viewer loaded nv-mcp');
