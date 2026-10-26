import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { N4_MODULE_SHA256 } from '../packages/n4/src/pin.js';

test('a Windows-style Git checkout preserves the checksum-pinned N4 factory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'n4-wasm-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const factory = 'packages/n4/wasm/n4-bias.mjs';
  const original = await readFile(new URL(`../${factory}`, import.meta.url));
  await mkdir(join(root, 'packages/n4/wasm'), { recursive: true });
  for (const path of ['.gitattributes', factory]) {
    await cp(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  function git(...args) {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  git('init');
  git('config', 'user.name', 'Checkout test');
  git('config', 'user.email', 'checkout@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '--no-gpg-sign', '-m', 'Seed pinned N4 factory');
  git('config', 'core.autocrlf', 'true');
  await rm(join(root, factory));
  git('checkout', '--', factory);
  const checkedOut = await readFile(join(root, factory));
  assert.equal(createHash('sha256').update(checkedOut).digest('hex'), N4_MODULE_SHA256);
  assert.deepEqual(checkedOut, original);
});
