import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBval, parseNumbers } from '@neurodesk/webapp-components/file-io/gradients';

test('parseNumbers splits on any whitespace', () => {
  assert.deepEqual(parseNumbers(' 0 1000\t1000\n2000\n'), [0, 1000, 1000, 2000]);
  assert.deepEqual(parseNumbers('   '), []);
});

test('parseBval refuses empty, non-finite, negative and mismatched b-values', () => {
  assert.deepEqual(parseBval('0 1000\t1000\n2000\n', 4), [0, 1000, 1000, 2000]);
  assert.deepEqual(parseBval('0 1000'), [0, 1000]);
  assert.throws(() => parseBval('  ', 1), /empty/);
  assert.throws(() => parseBval('0 abc', 2), /non-numeric/);
  assert.throws(() => parseBval('0 Infinity', 2), /non-finite/);
  assert.throws(() => parseBval('0 -5', 2), /negative/);
  assert.throws(() => parseBval('0 1000', 3), /The image has 3 volumes but the bval file lists 2\./);
});
