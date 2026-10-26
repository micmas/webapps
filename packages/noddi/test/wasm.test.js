import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DTI_MAPS, NODDI_MAPS, loadNoddi } from '../src/wasm.js';

const noddi = await loadNoddi(readFileSync(new URL('../src/noddi.wasm', import.meta.url)));

/** Two b0 volumes and 30 directions on a spiral, at the given b-values in turn. */
function scheme(shells) {
  const bvals = [0, 0];
  const bvecs = [[0, 0], [0, 0], [0, 0]];
  for (let i = 0; i < 30; i++) {
    const z = 1 - (2 * (i + 0.5)) / 30;
    const r = Math.sqrt(1 - z * z);
    const phi = i * 2.399963229728653;
    bvals.push(shells[i % shells.length]);
    bvecs[0].push(r * Math.cos(phi));
    bvecs[1].push(r * Math.sin(phi));
    bvecs[2].push(z);
  }
  return { bvals, bvecs };
}

/** Signal of a tensor with eigenvalues l along x, y and z. */
function signal({ bvals, bvecs }, s0, [l1, l2, l3]) {
  return bvals.map((b, i) => s0 * Math.exp(-b * (l1 * bvecs[0][i] ** 2 + l2 * bvecs[1][i] ** 2 + l3 * bvecs[2][i] ** 2)));
}

test('describe applies the shell and NODDI rules', () => {
  const single = scheme([995, 1000, 1005]);
  const one = noddi.describe(single.bvals, single.bvecs);
  assert.deepEqual(one.shells, [1000]);
  assert.deepEqual(one.b0, [0, 1]);
  assert.equal(one.dtiError, null);
  assert.match(one.noddiError, /two or more non-zero b-value shells/);

  const multi = scheme([700, 1200, 2800]);
  const three = noddi.describe(multi.bvals, multi.bvecs);
  assert.deepEqual(three.shells, [700, 1200, 2800]);
  assert.deepEqual(three.shellCounts, [10, 10, 10]);
  assert.equal(three.noddiError, null);
  // b = 700 and 1200 are at or below 1200; b = 2800 is left out of the tensor fit.
  const tensorVolumes = [0, 1, ...Array.from({ length: 30 }, (_, k) => 2 + k).filter((v) => (v - 2) % 3 !== 2)];
  assert.deepEqual(three.dtiVolumes, tensorVolumes);
});

test('WLS and OLS zero FA for negative eigenvalues without changing diffusivities', () => {
  const g = scheme([1000]);
  for (const eigenvalues of [[1.7e-3, 0.4e-3, -0.3e-3], [1e-3, 1e-3, -0.01e-3]]) {
    const data = Float32Array.from(signal(g, 1000, eigenvalues));
    for (const weighted of [false, true]) {
      const maps = noddi.dtiFit(data, 1, g.bvals, g.bvecs, { weighted });
      assert.equal(maps.FA[0], 0);
      assert.ok(Math.abs(maps.AD[0] - eigenvalues[0]) < 1e-9);
      assert.ok(Math.abs(maps.RD[0] - (eigenvalues[1] + eigenvalues[2]) / 2) < 1e-9);
      assert.ok(Math.abs(maps.MD[0] - eigenvalues.reduce((a, b) => a + b) / 3) < 1e-9);
      assert.ok(Math.abs(maps.S0[0] - 1000) < 1e-3);
    }
  }
});

test('describe rejects a table it cannot use', () => {
  assert.throws(() => noddi.describe([0, 1000], [[0, 0], [0, 0], [0, 0]]), /bvec direction has length/);
  assert.throws(() => noddi.describe([0, 1000], [[0], [0], [0]]), /three rows/);
});

test('dtiFit recovers a tensor and leaves masked voxels at zero', () => {
  const g = scheme([1000]);
  const voxels = 3;
  const values = signal(g, 1000, [1.7e-3, 0.3e-3, 0.3e-3]);
  const data = new Float32Array(values.length * voxels);
  values.forEach((s, v) => data.fill(s, v * voxels, (v + 1) * voxels));
  const maps = noddi.dtiFit(data, voxels, g.bvals, g.bvecs, { mask: Uint8Array.from([1, 1, 0]) });
  assert.deepEqual(Object.keys(maps), DTI_MAPS);
  const fa = Math.sqrt(0.5 * (1.4e-3 ** 2 * 2) / (1.7e-3 ** 2 + 2 * 0.3e-3 ** 2));
  assert.ok(Math.abs(maps.FA[0] - fa) < 1e-5, `FA ${maps.FA[0]} vs ${fa}`);
  assert.ok(Math.abs(maps.MD[1] - 0.766667e-3) < 1e-8);
  assert.ok(Math.abs(maps.AD[0] - 1.7e-3) < 1e-8);
  assert.ok(Math.abs(maps.RD[0] - 0.3e-3) < 1e-8);
  assert.ok(Math.abs(maps.S0[0] - 1000) < 1e-2);
  assert.ok(Math.abs(Math.abs(maps.V1x[0]) - 1) < 1e-6);
  assert.equal(maps.FA[2], 0);
  assert.equal(maps.V1x[2], 0);
});

test('dtiFit leaves out shells above b = 1200', () => {
  const g = scheme([700, 2800]);
  const lowest = { bvals: g.bvals.map((b) => (b === 2800 ? 700 : b)), bvecs: g.bvecs };
  // The b = 2800 volumes carry a different signal; a fit that used them would not give this tensor.
  const values = signal(lowest, 500, [1.2e-3, 0.6e-3, 0.4e-3]).map((s, i) => (g.bvals[i] === 2800 ? 1 : s));
  const maps = noddi.dtiFit(Float32Array.from(values), 1, g.bvals, g.bvecs);
  assert.ok(Math.abs(maps.MD[0] - 0.733333e-3) < 1e-8, `MD ${maps.MD[0]}`);
});

test('noddiModel refuses a single shell', () => {
  const g = scheme([995, 1000, 1005]);
  assert.throws(() => noddi.noddiModel(g.bvals, g.bvecs), /two or more non-zero b-value shells/);
});

test('noddiModel fits a multi-shell voxel and skips masked voxels', () => {
  const g = scheme([700, 2800]);
  const values = signal(g, 1000, [1.7e-3, 0.3e-3, 0.3e-3]);
  const data = new Float32Array(values.length * 2);
  values.forEach((s, v) => data.fill(s, v * 2, v * 2 + 2));
  const model = noddi.noddiModel(g.bvals, g.bvecs);
  try {
    const maps = model.fit(data, 2, Uint8Array.from([1, 0]));
    assert.deepEqual(Object.keys(maps), NODDI_MAPS);
    for (const name of ['ICVF', 'ISOVF', 'OD']) {
      assert.ok(maps[name][0] >= 0 && maps[name][0] <= 1, `${name} ${maps[name][0]}`);
      assert.equal(maps[name][1], 0);
    }
    // A single tensor along x: the fibre direction is x and dispersion is low.
    assert.ok(Math.abs(Math.abs(maps.dirx[0]) - 1) < 1e-6);
    assert.ok(maps.OD[0] < 0.2, `OD ${maps.OD[0]}`);
  } finally {
    model.free();
  }
});

test('dtiFit checks the image against the gradient table', () => {
  const g = scheme([1000]);
  assert.throws(() => noddi.dtiFit(new Float32Array(10), 1, g.bvals, g.bvecs), /gradient table has 32/);
  assert.throws(() => noddi.dtiFit(new Float32Array(32), 1, g.bvals, g.bvecs, { mask: new Uint8Array(2) }), /not on the image grid/);
});
