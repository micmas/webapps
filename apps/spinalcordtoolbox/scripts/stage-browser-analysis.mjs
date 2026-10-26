import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserAssetPath } from './browser-asset-cache.mjs';

const app = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(app, 'browser-runtime.json'), 'utf8'));
const destination = join(app, 'web/python');
const cache = join(tmpdir(), 'sct-browser-assets');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await mkdir(cache, { recursive: true });
const pending = [...manifest.assets, ...manifest.pureWheels];
async function stage(entry) {
    const path = await browserAssetPath(entry, cache);
    if (entry.file === 'pyodide.mjs' || manifest.pureWheels.some(wheel => wheel.file === entry.file)) {
        await copyFile(path, join(destination, entry.file));
    }
}
await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) await stage(pending.shift());
}));
execFileSync('python3', [join(app, 'scripts/pack-browser-source.py'), join(destination, 'sct.zip')]);
await writeFile(join(destination, 'package.json'), '{"type":"commonjs"}');
await copyFile(join(app, 'scripts/browser-bootstrap.py'), join(destination, 'bootstrap.py'));
await writeFile(join(destination, 'runtime.json'), JSON.stringify({
    sctVersion: manifest.sctVersion,
    indexURL: `https://cdn.jsdelivr.net/pyodide/v${manifest.pyodideVersion}/full/`,
    loadPackages: manifest.loadPackages,
    wheels: manifest.pureWheels.map(entry => entry.file),
}));
console.log(`Staged SCT ${manifest.sctVersion} for browser analysis with verified runtime assets`);
