import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// The published package ships TS under node_modules, which Node cannot strip.
// Load the owned vendored writer with its actual installed ZIP dependency.
const require = createRequire(import.meta.url);
const entry = require.resolve('@dipy/gpu-streamlines');
const zipUrl = pathToFileURL(require.resolve('fflate', { paths: [dirname(entry)] })).href;
const source = stripTypeScriptTypes(await readFile(new URL('../vendor/gpu-streamlines/src/trx.ts', import.meta.url), 'utf8'))
  .replace("'fflate'", JSON.stringify(zipUrl));
const { writeTrx } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { unzipSync } = await import(zipUrl);

const affine = [[2, 0, 0, 10], [0, 3, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]];

test('TRX bytes are deterministic across wall-clock times and time zones', () => {
  const clock = Date.now;
  const zone = process.env.TZ;
  const lines = [new Float32Array([0, 0, 0, 1, 2, 3])];
  let first;
  let second;
  try {
    process.env.TZ = 'UTC';
    Date.now = () => 1700000000000;
    first = writeTrx(lines, affine, [5, 6, 7]);
    process.env.TZ = 'America/Los_Angeles';
    Date.now = () => 1800000000000;
    second = writeTrx(lines, affine, [5, 6, 7]);
  } finally {
    Date.now = clock;
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.deepEqual(first, second);
  const members = unzipSync(first);
  assert.deepEqual(Object.keys(members).sort(), ['header.json', 'offsets.uint32', 'positions.3.float32']);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(members['header.json'])), {
    DIMENSIONS: [5, 6, 7], VOXEL_TO_RASMM: affine, NB_VERTICES: 2, NB_STREAMLINES: 1,
  });
  const positions = members['positions.3.float32'];
  const view = new DataView(positions.buffer, positions.byteOffset, positions.byteLength);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => view.getFloat32(index * 4, true)), [10, 20, 30, 12, 26, 42]);
  const offsets = members['offsets.uint32'];
  const offsetView = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  assert.deepEqual([offsetView.getUint32(0, true), offsetView.getUint32(4, true)], [0, 2]);
  assert.notDeepEqual(first, writeTrx([new Float32Array([0, 0, 0, 1, 2, 4])], affine, [5, 6, 7]));
});
