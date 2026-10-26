import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { startOfflineServer } from '../src/server.js';
import { createSourceGrants } from '../src/source-grants.js';
import { addressesIn, createSourceGranter, grantSources, parseApprovedSources, refuseCredentials, sourceOf } from '../src/source-approval.js';

test('Windows namespace and WebDAV paths with @ are files only on Windows', () => {
  for (const value of [String.raw`C:\data\a@b.nii.gz`, String.raw`\\server\share\a@b.nii.gz`, String.raw`\\.\C:\data\a@b.nii.gz`]) {
    for (const platform of ['win32', 'linux', 'darwin']) assert.doesNotThrow(() => refuseCredentials(value, platform));
  }
  for (const value of [
    String.raw`\\?\C:\data\a@b.nii.gz`,
    String.raw`\\?\UNC\server\share\a@b.nii.gz`,
    String.raw`\\server@SSL\DavWWWRoot\scan.nii.gz`,
    String.raw`\\server@SSL@8443\DavWWWRoot\a@b.nii.gz`,
    String.raw`\\server@8080\DavWWWRoot\scan.nii.gz`,
    String.raw`\\server@ssl\DavWWWRoot\scan.nii.gz`,
    String.raw`\\?\UNC\server@SSL\DavWWWRoot\scan.nii.gz`,
  ]) {
    assert.doesNotThrow(() => refuseCredentials(value, 'win32'), value);
    for (const platform of ['linux', 'darwin']) assert.throws(() => refuseCredentials(value, platform), /must not contain credentials/, `${platform}: ${value}`);
  }
});

test('Windows file recognition cannot bypass credential refusal for nested source addresses', () => {
  for (const value of [
    'https://reader:secret@example.org/scan.nii.gz',
    '//reader:secret@example.org/scan.nii.gz',
    String.raw`\\reader:secret@example.org\scan.nii.gz`,
    String.raw`/\reader:secret@example.org/scan.nii.gz`,
    String.raw`\/reader:secret@example.org/scan.nii.gz`,
    ' //reader:secret@example.org/scan.nii.gz',
    '//reader:secret@[example.org/scan.nii.gz',
    'http://reader:secret@example.org:99999/scan.nii.gz',
    String.raw`\\?\UNC\reader:secret@example.org\share\scan.nii.gz`,
    String.raw`\\?\C:/data/a@b.nii.gz`,
    String.raw`\\server@SSL/DavWWWRoot/scan.nii.gz`,
    String.raw`\\reader@example.org\share\scan.nii.gz`,
    String.raw`\\server@SSL@0\DavWWWRoot\scan.nii.gz`,
    String.raw`\\server@65536\DavWWWRoot\scan.nii.gz`,
  ]) {
    const sources = addressesIn({ layers: [{ url: value }], labels: value, font: { atlas: value, metrics: value } });
    assert.equal(sources.length, 4);
    for (const platform of ['win32', 'linux', 'darwin']) {
      for (const source of sources) assert.throws(() => refuseCredentials(source, platform), /^Error: Source URLs must not contain credentials$/);
    }
  }
});

test('a Windows extended path with @ approves and mounts the actual local file', { skip: process.platform !== 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'viewer-native-path-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'scan@session.nii.gz');
  await writeFile(file, 'native file bytes');
  const extended = toNamespacedPath(file);
  assert.ok(extended.startsWith('\\\\?\\'), extended);
  refuseCredentials(extended);
  assert.deepEqual(sourceOf(extended), { path: extended });
  const site = await startOfflineServer(root);
  t.after(() => site.close());
  const grant = createSourceGranter({ site, grants: createSourceGrants(), approved: parseApprovedSources(root),
    ask() { assert.fail('a pre-approved local file must not ask for permission'); },
  });
  const mounted = await grant(sourceOf(extended), { base: `${site.origin}/dicomview/`, signal: new AbortController().signal });
  assert.equal(mounted.approval, 'configured');
  assert.equal(await (await fetch(mounted.url)).text(), 'native file bytes');
});

test('sources are local files, remote addresses or nothing to approve', () => {
  const file = join(tmpdir(), 'T2.nii.gz');
  assert.deepEqual(sourceOf(file), { path: file });
  assert.deepEqual(sourceOf(pathToFileURL(file).href), { path: file });
  assert.deepEqual(sourceOf('https://example.org/data/T2.nii.gz'), { url: 'https://example.org/data/T2.nii.gz' });
  assert.deepEqual(sourceOf('http://127.0.0.1:4517/T2.nii.gz'), { url: 'http://127.0.0.1:4517/T2.nii.gz' });
  for (const value of ['T1.nii.gz', './sample/T1.nii.gz', '../brain-extraction/T1.nii.gz', 'data:application/octet-stream;base64,AA==', 'blob:http://127.0.0.1/x']) {
    assert.equal(sourceOf(value), null, value);
  }
  // A relative address that climbs into the local server's mounts names a granted file, not part of the app.
  for (const value of ['../_local/token/T2.nii.gz', '../../_local/token/T2.nii.gz', 'x/../../_local/token/T2.nii.gz', '%2e%2e/_local/token/T2.nii.gz', '../%5Flocal/token/T2.nii.gz']) {
    assert.deepEqual(sourceOf(value), { url: value }, value);
  }
});

test('a viewer loads its own files and approved sources, and nothing granted to another viewer', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'viewer-sources-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs'));
  await writeFile(join(root, 'runs', 'mask.nii.gz'), 'mask');
  await writeFile(join(root, 'T2.nii.gz'), 'volume');
  const own = await startOfflineServer(root);
  const other = await startOfflineServer(root);
  t.after(() => { own.close(); other.close(); });
  const asked = [];
  let answer = 'deny';
  const grants = createSourceGrants();
  const grant = createSourceGranter({
    site: own, grants, approved: parseApprovedSources(`${join(root, 'runs')},https://example.org/open/`),
    async ask(source) {
      asked.push(source);
      if (answer === 'deny') throw new Error(`Loading ${source} was denied.`);
    },
  });
  const base = `${own.origin}/brain-extraction/`;
  const load = source => grant(source, { base, signal: new AbortController().signal });

  const mask = await load({ path: join(root, 'runs', 'mask.nii.gz') });
  assert.equal(mask.approval, 'configured');
  assert.ok(own.owns(mask.url), mask.url);
  assert.deepEqual(await load({ path: join(root, 'runs', 'mask.nii.gz') }), { ...mask, approval: 'existing' });
  assert.deepEqual(await load({ url: mask.url }), { url: mask.url, approval: 'existing' });
  const relativeMask = `../_local/${new URL(mask.url).pathname.split('/').slice(2).join('/')}`;
  assert.deepEqual(await load({ url: relativeMask }), { url: relativeMask, approval: 'existing' });
  assert.deepEqual(await load({ url: 'T1.nii.gz' }), { url: 'T1.nii.gz', approval: 'existing' });

  const foreign = await other.mountFile(join(root, 'T2.nii.gz'));
  await assert.rejects(load({ url: foreign }), /was denied/, 'another viewer\'s address needs approval like any URL');
  const foreignRelative = `../_local/${new URL(foreign).pathname.split('/').slice(2).join('/')}`;
  await assert.rejects(load({ url: foreignRelative }), /not granted to this viewer/);
  assert.deepEqual(asked, [foreign], 'a relative address is refused without asking');
  assert.equal(grants.permits(foreign), false);

  assert.deepEqual(await load({ url: 'https://example.org/open/T1.nii.gz' }), { url: 'https://example.org/open/T1.nii.gz', approval: 'configured' });
  answer = 'allow';
  assert.deepEqual(await load({ url: 'http://127.0.0.1:4517/T2.nii.gz' }), { url: 'http://127.0.0.1:4517/T2.nii.gz', approval: 'person' });
  assert.ok(grants.permits('http://127.0.0.1:4517/T2.nii.gz'), 'an approved URL joins this viewer\'s grants');
  assert.deepEqual(await load({ url: 'http://127.0.0.1:4517/T2.nii.gz' }), { url: 'http://127.0.0.1:4517/T2.nii.gz', approval: 'existing' });
  const person = await load({ path: join(root, 'T2.nii.gz') });
  assert.equal(person.approval, 'person');
  assert.equal(await (await fetch(person.url)).text(), 'volume');
  await assert.rejects(load({ path: join(root, 'missing.nii.gz') }), /No such file/);
});

test('every url in tool arguments is granted in order, at any depth', async () => {
  const asked = [];
  const params = { url: 'a', name: 'url', layers: [{ url: 'b', opacity: 1 }, { url: 'c' }], args: { url: 'd', meta: { url: 7 } } };
  const granted = await grantSources(params, async value => { asked.push(value); return `granted:${value}`; });
  assert.deepEqual(asked, ['a', 'b', 'c', 'd']);
  assert.deepEqual(granted, { url: 'granted:a', name: 'url', layers: [{ url: 'granted:b', opacity: 1 }, { url: 'granted:c' }],
    args: { url: 'granted:d', meta: { url: 7 } } });
  await assert.rejects(grantSources({ layers: [{ url: 'x' }] }, async () => { throw new Error('denied'); }), /denied/);
});

test('label tables and font files receive source approval before loading', async () => {
  const asked = [];
  const params = {
    url: 'https://example.org/overlay.nii.gz',
    labels: 'https://example.org/labels.json',
    font: { atlas: 'https://example.org/font.png', metrics: 'https://example.org/font.json' },
  };
  const granted = await grantSources(params, async value => {
    asked.push(value);
    return `granted:${value}`;
  });
  assert.deepEqual(asked, [
    'https://example.org/overlay.nii.gz',
    'https://example.org/labels.json',
    'https://example.org/font.png',
    'https://example.org/font.json',
  ]);
  assert.deepEqual(granted, {
    url: 'granted:https://example.org/overlay.nii.gz',
    labels: 'granted:https://example.org/labels.json',
    font: { atlas: 'granted:https://example.org/font.png', metrics: 'granted:https://example.org/font.json' },
  });
  for (const key of ['labels', 'atlas', 'metrics']) {
    await assert.rejects(grantSources({ [key]: 'https://example.org/denied' }, async () => {
      throw new Error('denied');
    }), /denied/);
  }
});

test('pre-approved sources cover files inside a directory and URLs under a prefix', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-sources-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs'));
  await writeFile(join(root, 'runs', 'mask.nii.gz'), '');
  const approved = parseApprovedSources(`${join(root, 'runs')}, ${join(root, 'later')}, https://example.org/open/`);
  assert.equal(await approved.permits({ file: join(root, 'runs', 'mask.nii.gz') }), true);
  assert.equal(await approved.permits({ file: join(root, 'runs') }), false);
  assert.equal(await approved.permits({ file: join(root, 'runs-private', 'x.nii') }), false);
  assert.equal(await approved.permits({ file: join(root, 'later', 'x.nii') }), false);
  await mkdir(join(root, 'later'));
  assert.equal(await approved.permits({ file: join(root, 'later', 'x.nii') }), true, 'a directory created after startup counts');
  assert.equal(await approved.permits({ url: 'https://example.org/open/T1.nii.gz' }), true);
  assert.equal(await approved.permits({ url: 'https://example.org/closed/T1.nii.gz' }), false);
  assert.equal(await parseApprovedSources(undefined).permits({ url: 'https://example.org/open/T1.nii.gz' }), false);
  assert.throws(() => parseApprovedSources('relative/dir'), /absolute directories or http\(s\) URLs/);
});
