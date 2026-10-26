import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startOfflineServer } from '../src/server.js';

test('local datasets require an explicit grant and cannot escape through symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'scan.zarr');
  await mkdir(folder);
  await writeFile(join(folder, '.zattrs'), '{"multiscales":[]}');
  await writeFile(join(root, 'private.txt'), 'not a dataset');
  if (process.platform !== 'win32') await symlink(join(root, 'private.txt'), join(folder, 'outside'));
  const server = await startOfflineServer(root);
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  assert.equal((await fetch(`${server.origin}/_local/not-granted/.zattrs`)).status, 404);
  const url = await server.mountDirectory(folder);
  assert.deepEqual(await (await fetch(`${url}/.zattrs`)).json(), { multiscales: [] });
  assert.equal((await fetch(`${url}/%2e%2e%2fprivate.txt`)).status, 404);
  if (process.platform !== 'win32') assert.equal((await fetch(`${url}/outside`)).status, 404);
  assert.equal((await fetch(`${url}/.zattrs`, { method: 'PUT', body: '{}' })).status, 405);
});

test('a granted file is served alone under its own name, by its viewer\'s server only, until that server closes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site'));
  await writeFile(join(root, 'site', 'index.html'), '<html></html>');
  await writeFile(join(root, 'T2.nii.gz'), 'volume');
  await writeFile(join(root, 'private.txt'), 'not granted');
  const server = await startOfflineServer(root);
  const other = await startOfflineServer(root);
  t.after(() => { server.close(); other.close(); });
  assert.notEqual(server.origin, other.origin, 'each viewer has its own address');
  const url = await server.mountFile(join(root, 'T2.nii.gz'));
  assert.match(url, /\/_local\/[0-9a-f-]+\/T2\.nii\.gz$/);
  assert.equal(await (await fetch(url)).text(), 'volume');
  assert.equal((await fetch(url.replace('T2.nii.gz', 'private.txt'))).status, 404);
  assert.equal((await fetch(url.replace('/T2.nii.gz', ''))).status, 404);
  const borrowed = url.replace(server.origin, other.origin);
  assert.equal((await fetch(borrowed)).status, 404, 'another viewer\'s server does not serve the file');
  assert.equal((await fetch(`${other.origin}/`)).status, 200, 'both serve the shared bundle');
  assert.deepEqual([url, `${server.origin}/app/`, borrowed, `${server.origin}/_local/other/T2.nii.gz`].map(server.owns),
    [true, true, false, false]);
  await assert.rejects(server.mountFile(root), /Choose a file/);
  server.close();
  assert.equal(await fetch(url).then(response => response.ok, () => false), false, 'a closed server serves nothing');
  assert.equal(server.owns(url), false);
});
