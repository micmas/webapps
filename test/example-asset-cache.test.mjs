import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadVerifiedExampleCache } from '../scripts/lib/example-asset-cache.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const url = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/1234567890123456789012345678901234567890/scan.nii';
const body = Buffer.from([0, 1, 127, 255]);
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = { [url]: { sha256: hash(body), bytes: body.length, contentType: 'application/octet-stream' } };

test('cache mode returns the exact locked bytes for their original URL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verified-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, hash(url)), body);
  const result = await loadVerifiedExampleCache([{ url }, { url }], { directory, assets });
  assert.equal(result.size, 1);
  assert.deepEqual(result.get(url).body, Buffer.from([0, 1, 127, 255]));
});

test('cache mode rejects missing, corrupt, or incorrectly sized assets without fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verified-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const load = locked => loadVerifiedExampleCache([{ url }], { directory, assets: locked });
  await assert.rejects(load(assets), /does not fall back to the network/);
  await writeFile(join(directory, hash(url)), Buffer.from([255, 127, 1, 0]));
  await assert.rejects(load(assets), /checksum or size mismatch/);
  await writeFile(join(directory, hash(url)), body);
  await assert.rejects(load({ [url]: { ...assets[url], bytes: 3 } }), /checksum or size mismatch/);
  await assert.rejects(load({}), /Missing locked SHA-256/);
});

test('verified cache files stream over HTTP with their locked type and CORS headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'streamed-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, hash(url));
  await writeFile(path, body);
  const locked = { [url]: { ...assets[url], contentType: 'application/gzip' } };
  const cache = await loadVerifiedExampleCache([{ url }], { directory, assets: locked });
  const site = await serveSite(directory, { files: new Map([
    ['/verified-scan', cache.get(url)],
    ['/legacy-scan', path],
  ]) });
  t.after(site.close);
  const response = await fetch(`${site.origin}/verified-scan`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  const head = await fetch(`${site.origin}/verified-scan`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const legacy = await fetch(`${site.origin}/legacy-scan`);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), body);
});
