#!/usr/bin/env node
// The knowledge-base report stage in the browser module (web/js/modules/kb-report.js):
//
//   * asset lookup from the manifest (KB JSON, the hosted report atlases, the
//     disconnectome atlas), with an unhosted atlas reported as missing;
//   * the lesion copied onto a label grid by world coordinates and reduced to
//     the overlap rows the knowledge-base mapping reads (measureDamage);
//   * the lesion written onto the MNI152 1 mm disconnectome grid;
//   * the disconnectome worker (web/js/disconnectome-worker.js) run in-process
//     through DisconnectomeClient against a TVX atlas built from the nii2tvx
//     fixtures with the native tool, including its error paths;
//   * rendering into a jsdom copy of web/index.html: the three sections, the
//     symptom table, region and tract disclosures, therapies, provenance, and
//     clearKbReport hiding everything again.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
// A Node Buffer may share a pooled ArrayBuffer: copy exactly the file's bytes.
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const manifest = read('web/models/manifest.json');
const kb = read('web/models/annotations/aphasia-kb.json');
const parity = read('tests/fixtures/kb-parity/kb-parity.json');

const {
  loadKnowledgeBase, reportAtlasEntries, disconnectomeEntry, measureDamage, lesionOnGrid, disconnectomeLesionNifti,
  fractionsByBundle, DisconnectomeClient, evaluateDamage, renderKbReport, clearKbReport, KB_SECTION_IDS,
} = await import('../web/js/modules/kb-report.js');
const { decodeNiftiBuffer } = await import('../web/js/modules/atlas-loader.js');

// --- Assets -----------------------------------------------------------------

{
  const { kb: loaded, entry } = await loadKnowledgeBase(manifest, {
    fetchBuffer: async (asset) => {
      assert.equal(asset.id, 'aphasia-kb');
      return readFileSync(join(root, 'web/models', asset.filename));
    },
  });
  assert.equal(entry.cacheKey, `aphasia-kb-${loaded.version.contentDigest}`, 'the cache key follows the KB content digest');
  assert.equal(loaded.findings.length, kb.findings.length);
  await assert.rejects(loadKnowledgeBase({ annotationAssets: [] }), /kbReport is missing/);
  await assert.rejects(loadKnowledgeBase({ kbReport: { annotationAssetId: 'nope' }, annotationAssets: [] }), /not found/);

  const atlases = reportAtlasEntries(manifest);
  assert.deepEqual(atlases.map((a) => a.name), ['HarvardOxford', 'AAL', 'JHU', 'XTRACT']);
  const hosted = atlases.filter((a) => a.entry).map((a) => a.name);
  assert.ok(hosted.includes('HarvardOxford') && hosted.includes('AAL'), 'the cortical atlases are hosted');
  for (const { entry } of atlases.filter((a) => a.entry)) {
    assert.equal(entry.role, 'report-atlas');
    assert.ok(Object.keys(entry.labels).length >= entry.labelsPresent);
    // The static build drops NIfTI files, so a hosted atlas is fetched from a pinned, immutable URL.
    assert.match(entry.sourceUrl, /^https:\/\/(?:raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/|huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/)/,
      `${entry.id} is fetched from a pinned URL`);
    assert.match(entry.checksum, /^sha256:[0-9a-f]{64}$/);
  }
  const disco = disconnectomeEntry(manifest);
  assert.equal(disco.entry.id, 'enigma-symmetric-tvx');
  assert.deepEqual(disco.grid.dims, [182, 218, 182]);
  assert.equal(disco.entry.bundles, 65);
  assert.match(disco.entry.sourceUrl, /huggingface\.co.+enigma_symmetric\.tvx\.gz$/);
  // Every ENIGMA bundle the mapping names exists in the atlas (golden TSV header of the engine's tests).
  const header = readFileSync(join(root, '../../exes/nii2tvx/test/expected-examples-enigma.tsv'), 'utf8').split('\n')[0].split('\t').slice(1);
  const mapped = Object.values({ ...kb.mapping.disconnectome.units, ...kb.mapping.disconnectome.extraUnits })
    .flatMap((u) => (Array.isArray(u.labels) ? u.labels : Object.values(u.labels).flat()));
  for (const bundle of mapped) assert.ok(header.includes(bundle), `${bundle} is an ENIGMA bundle`);
  assert.equal(header.length, 65);
}

// --- Measurements -----------------------------------------------------------

{
  // A 4x1x1 lesion grid at 2 mm, x = -4 + 2i (two left, two right voxels).
  const lesion = {
    data: Uint8Array.from([1, 1, 0, 1]), dims: [4, 1, 1],
    affine: [[2, 0, 0, -4], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]],
  };
  // The atlas grid is the same world span at 1 mm, offset a quarter voxel so no
  // sample sits on a nearest-neighbour tie: 8 voxels, x = -4.25 + i.
  const atlasAffine = [[1, 0, 0, -4.25], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const onGrid = lesionOnGrid(lesion, [8, 1, 1], atlasAffine);
  assert.deepEqual(Array.from(onGrid), [1, 1, 1, 1, 0, 0, 1, 1]);
  const atlas = {
    data: Int16Array.from([5, 5, 5, 5, 5, 5, 5, 5]), dims: [8, 1, 1], header: { affine: atlasAffine },
    manifestEntry: { labels: { 5: 'Precentral Gyrus' } },
  };
  const empty = { ...atlas, data: Int16Array.from([0, 0, 0, 0, 0, 0, 0, 0]) };
  const damage = measureDamage(lesion, [{ name: 'HarvardOxford', atlas }, { name: 'AAL', atlas: empty }]);
  assert.deepEqual(damage.measured, ['HarvardOxford']);
  assert.deepEqual(damage.unmeasured, ['AAL']);
  const [row] = damage.rowsByAtlas.HarvardOxford;
  assert.equal(row.region, 'Precentral Gyrus');
  assert.equal(row.overlap_voxels, 6);
  assert.equal(row.total_lesion_voxels, 6);
  assert.equal(row.left_overlap_voxels, 4, 'x < 0 is left');
  assert.equal(row.right_overlap_voxels, 2);
  assert.deepEqual([row.left_region_voxels, row.right_region_voxels], [5, 3], 'x = -0.25 counts as left');

  const grid = manifest.kbReport.disconnectomeGrid;
  const mni = { data: new Uint8Array(160 * 160 * 192), dims: [160, 160, 192], affine: [[1, 0, 0, -79.5], [0, 1, 0, -112.5], [0, 0, 1, -79.5], [0, 0, 0, 1]] };
  // One lesion voxel at world (-40, -20, 30): i = 39.5 -> 40, j = 92.5 -> 93, k = 109.5 -> 110.
  mni.data[40 + 160 * (93 + 160 * 110)] = 1;
  const { buffer, voxels } = disconnectomeLesionNifti(mni, grid);
  assert.equal(voxels, 1);
  const decoded = await decodeNiftiBuffer(buffer);
  assert.deepEqual(decoded.dims, [182, 218, 182]);
  assert.deepEqual(decoded.header.affine[0], grid.affine[0]);
  let index = -1;
  for (let i = 0; i < decoded.data.length; i += 1) if (decoded.data[i]) { assert.equal(index, -1); index = i; }
  const [nx, ny] = decoded.dims;
  const i = index % nx; const j = Math.floor(index / nx) % ny; const k = Math.floor(index / (nx * ny));
  // FSL MNI152 1 mm: x = 90 - i, y = j - 126, z = k - 72 -> (-40.5, -19.5, 30.5) rounds to i=130, j=106, k=102.
  assert.deepEqual([i, j, k], [130, 106, 102], 'the lesion lands at its world position on the FSL grid');

  assert.deepEqual(fractionsByBundle(['a', 'b'], Float32Array.from([0.5, NaN])), { a: 0.5, b: NaN });
}

// --- The disconnectome worker, in-process -----------------------------------

{
  const transcript = [];
  let client = null;
  const scope = { postMessage(message) { transcript.push(message); client?.onmessage?.({ data: message }); } };
  globalThis.self = scope;
  await import('../web/js/disconnectome-worker.js');
  class InProcessWorker {
    constructor(url, options) { this.url = url; this.options = options; this.onmessage = null; this.onerror = null; client = this; }
    postMessage(message) { queueMicrotask(() => scope.onmessage({ data: message })); }
    terminate() { client = null; }
  }
  const disconnectome = new DisconnectomeClient('js/disconnectome-worker.js?v=test', { WorkerClass: InProcessWorker });

  const exe = join(root, '../../exes/nii2tvx');
  const native = join(exe, 'nii2tvx');
  if (existsSync(native)) {
    const work = mkdtempSync(join(tmpdir(), 'calmar-kb-'));
    try {
      cpSync(join(exe, 'test/fixtures'), work, { recursive: true });
      const run = (...args) => execFileSync(native, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
      run('template.nii.gz', 'all_hit.trk', 'some_hit.trk', 'none_hit.trk', 'outside.trk');
      run('-p', 'atlas.tvx', 'all_hit.tvx', 'some_hit.tvx', 'none_hit.tvx', 'outside.tvx');
      const atlasBytes = readFileSync(join(work, 'atlas.tvx'));
      let fetched = 0;
      const lesionBytes = () => arrayBuffer(readFileSync(join(exe, 'test/fixtures/lesion.nii.gz')));
      const first = await disconnectome.query(lesionBytes(), {
        atlasKey: 'fixture', atlasBytes: async () => { fetched += 1; return arrayBuffer(atlasBytes); },
      });
      assert.deepEqual(first.tracts, ['all_hit', 'some_hit', 'none_hit', 'outside']);
      const expected = readFileSync(join(exe, 'test/expected.tsv'), 'utf8').trim().split('\n')
        .find((line) => line.startsWith('lesion\t')).split('\t').slice(1).map(Number);
      for (let t = 0; t < 4; t += 1) {
        if (Number.isNaN(expected[t])) assert.ok(Number.isNaN(first.fractions[t]));
        else assert.ok(Math.abs(first.fractions[t] - expected[t]) < 1e-6, `${first.tracts[t]} ${first.fractions[t]} vs ${expected[t]}`);
      }
      const second = await disconnectome.query(lesionBytes(), {
        atlasKey: 'fixture', atlasBytes: async () => { throw new Error('the atlas must not be fetched twice'); },
      });
      assert.equal(fetched, 1, 'the opened atlas is reused');
      assert.deepEqual(Array.from(second.fractions), Array.from(first.fractions));
      const wrong = readFileSync(join(exe, 'test/fixtures/wrong_grid.nii.gz'));
      await assert.rejects(disconnectome.query(arrayBuffer(wrong), { atlasKey: 'fixture' }),
        // nii2tvx prints the mismatch over several stderr lines and the wrapper
        // keeps the last one (here the atlas's sto_xyz row), so only a refusal is asserted.
        (error) => error instanceof Error && error.message.length > 0, 'a lesion on another grid is refused');
      const byBundle = fractionsByBundle(first.tracts, first.fractions);
      assert.equal(byBundle.all_hit, 1);
      console.log('kb-report: disconnectome worker scored the nii2tvx fixtures through DisconnectomeClient.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else {
    console.log('kb-report: exes/nii2tvx not built; worker scoring skipped (make -C exes/nii2tvx).');
  }
  await assert.rejects(disconnectome.query(new ArrayBuffer(8), { atlasKey: 'never-sent' }), /atlas bytes are needed/);
  assert.ok(transcript.every((m) => typeof m.id === 'number'), 'every reply carries its request id');
  disconnectome.terminate();
  assert.equal(client, null);
}

// --- Rendering --------------------------------------------------------------

{
  const dom = new JSDOM(readFileSync(join(root, 'web/index.html'), 'utf8'));
  const { document } = dom.window;
  const fixture = parity.cases.left_perisylvian;
  const fractions = Object.fromEntries(Object.entries(parity.disconnectome.arcuate_cut.fractions).map(([k, v]) => [k, v === null ? NaN : v]));
  const result = evaluateDamage(kb, fixture.input, { fractions });
  assert.ok(result.location.summaries.length && result.whiteMatter.tracts.length && result.therapy.length);
  const context = { measured: ['HarvardOxford', 'AAL', 'JHU', 'XTRACT'], unmeasured: [], missingAtlases: [], disconnectomeLabel: 'ENIGMA Symmetric tractography atlas', bundles: 65, disconnectomeNote: 'Disconnectome: ENIGMA (test).' };
  renderKbReport(document, result, { kb, context });
  for (const id of Object.values(KB_SECTION_IDS)) assert.ok(!document.getElementById(id).classList.contains('hidden'), `${id} shown`);
  const symptomRows = document.querySelectorAll('#kbLocationBody .kb-symptom-table tbody tr');
  assert.equal(symptomRows.length, result.location.summaries.length);
  assert.equal(symptomRows[0].dataset.target, result.location.summaries[0].target, 'summaries render in display-signal order');
  assert.match(symptomRows[0].textContent, /★|—/, 'a display signal is drawn');
  const regions = document.querySelectorAll('#kbLocationBody details.kb-region');
  assert.equal(regions.length, result.location.regions.length);
  assert.match(regions[0].querySelector('summary').textContent, /% of the lesion/);
  assert.ok(regions[0].querySelectorAll('article.kb-finding').length >= result.location.regions[0].distinct);
  const finding = regions[0].querySelector('article.kb-finding');
  assert.match(finding.textContent, /Study method:|Relationship:/);
  assert.ok(finding.querySelector('code').textContent.startsWith('@'), 'citation keys are shown as keys');
  for (const table of document.querySelectorAll('#resultsReport table')) {
    assert.ok(table.classList.contains('nd-data-table') && table.parentElement.classList.contains('nd-table-scroll'), 'shared table classes');
  }
  const tracts = document.querySelectorAll('#kbWhiteMatterBody details.kb-tract');
  assert.equal(tracts.length, result.whiteMatter.tracts.length);
  assert.match(tracts[0].querySelector('summary').textContent, /streamlines pass through the lesion/);
  assert.ok(document.querySelector('#kbWhiteMatterBody .kb-tract-table') || result.whiteMatter.anatomyOnly.length === 0);
  const therapyRows = document.querySelectorAll('#kbTherapyBody tbody tr');
  assert.equal(therapyRows.length, result.therapy.length);
  assert.equal(therapyRows[0].dataset.therapy, result.therapy[0].therapy_id);
  assert.match(document.getElementById('kbReportProvenance').textContent, /Knowledge base .*statuses used: approved\./);
  assert.match(document.getElementById('kbReportProvenance').textContent, /Research use only, not a diagnosis/);
  assert.equal(document.querySelector('#kbLocationBody .nd-message.warning'), null, 'a left lesion gets no right-hemisphere caution');

  // Nothing matched: the sections still render their explanations.
  const nothing = evaluateDamage(kb, {}, { fractions: null });
  renderKbReport(document, nothing, { kb, context: { measured: [], unmeasured: ['HarvardOxford'], missingAtlases: ['JHU'], disconnectomeError: 'offline' } });
  assert.match(document.getElementById('kbLocationBody').textContent, /No knowledge-base findings concern the damaged regions/);
  assert.match(document.getElementById('kbWhiteMatterBody').textContent, /could not be computed: offline/);
  assert.match(document.getElementById('kbTherapyBody').textContent, /No therapy entry matched/);
  assert.match(document.getElementById('kbReportProvenance').textContent, /Not hosted in this build: JHU/);

  // A right-hemisphere lesion carries the caution.
  const right = evaluateDamage(kb, parity.cases.right_small.input, { fractions: null });
  renderKbReport(document, right, { kb, context: {} });
  assert.ok(document.querySelector('#kbLocationBody .nd-message.warning'), 'the right-hemisphere caution is shown');

  clearKbReport(document);
  for (const id of Object.values(KB_SECTION_IDS)) assert.ok(document.getElementById(id).classList.contains('hidden'), `${id} hidden again`);
  assert.equal(document.getElementById('kbLocationBody').children.length, 0);
}

console.log('kb-report OK: assets, measurements, disconnectome worker, rendering and clearing checked.');
