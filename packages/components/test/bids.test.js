import test from 'node:test';
import assert from 'node:assert/strict';
import { bidsDiffusionSeries, chooseBidsRun, chosenBidsRun, parseBidsName, readBidsDiffusion } from '../src/file-io/index.js';
import { readBidsDiffusion as readFromSubpath } from '../src/file-io/bids-diffusion.js';

/** A File as a folder input gives it: a name, a webkitRelativePath and text(). */
function fakeFile(path, content = '') {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return {
    name: path.replace(/^.*\//, ''),
    webkitRelativePath: path,
    text: async () => text
  };
}

/** Build a dropped folder from { path: content } with the dropped folder name in front. */
function tree(files, folder = 'ds') {
  return Object.entries(files).map(([path, content]) => fakeFile(`${folder}/${path}`, content));
}

function dwiRun(prefix, sidecar = { PhaseEncodingDirection: 'j-' }) {
  return {
    [`${prefix}_dwi.nii.gz`]: '',
    [`${prefix}_dwi.bval`]: '0 1000',
    [`${prefix}_dwi.bvec`]: '0 1\n0 0\n0 0',
    [`${prefix}_dwi.json`]: sidecar
  };
}

const unpairedPaths = result => result.unpaired.map(entry => entry.path);

test('parses BIDS names into entities, suffix and extension', () => {
  assert.deepEqual(parseBidsName('sub-01_ses-1_acq-b1000_run-2_dwi.nii.gz'), {
    stem: 'sub-01_ses-1_acq-b1000_run-2_dwi',
    entities: { sub: '01', ses: '1', acq: 'b1000', run: '2' },
    suffix: 'dwi',
    extension: '.nii.gz'
  });
  assert.equal(parseBidsName('dwi.json').suffix, 'dwi');
  assert.deepEqual(parseBidsName('dwi.json').entities, {});
});

test('reads one DWI run with its gradient tables and sidecar', async () => {
  const files = tree({
    'dataset_description.json': { Name: 'test', BIDSVersion: '1.10.0' },
    'participants.tsv': 'participant_id\nsub-01\n',
    ...dwiRun('sub-01/dwi/sub-01')
  });
  const result = await readBidsDiffusion(files);
  assert.equal(result.runs.length, 1);
  const [run] = result.runs;
  assert.equal(run.id, 'sub-01_dwi');
  assert.equal(run.root, 'ds');
  assert.equal(run.path, 'sub-01/dwi/sub-01_dwi.nii.gz');
  assert.equal(run.subject, '01');
  assert.equal(run.session, null);
  assert.deepEqual(run.entities, { sub: '01' });
  assert.equal(run.dwi, files[2]);
  assert.equal(run.bval, files[3]);
  assert.equal(run.bvec, files[4]);
  assert.equal(run.json, files[5]);
  assert.deepEqual(run.sidecar, { PhaseEncodingDirection: 'j-' });
  assert.deepEqual(run.fieldmaps, []);
  assert.equal(run.error, null);
  assert.deepEqual(result.unpaired, []);
});

test('is exported from the file-io index and its own subpath', () => {
  assert.equal(readBidsDiffusion, readFromSubpath);
});

test('returns one record per run', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01_run-1'),
    ...dwiRun('sub-01/dwi/sub-01_run-2')
  }));
  assert.deepEqual(result.runs.map(run => run.id), ['sub-01_run-1_dwi', 'sub-01_run-2_dwi']);
  assert.deepEqual(result.runs.map(run => run.entities.run), ['1', '2']);
  assert.deepEqual(result.runs.map(run => run.bval.name), ['sub-01_run-1_dwi.bval', 'sub-01_run-2_dwi.bval']);
  assert.ok(result.runs.every(run => run.error === null));
});

test('reads sessions and prefers the T1w from the same session', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/ses-1/dwi/sub-01_ses-1'),
    ...dwiRun('sub-01/ses-2/dwi/sub-01_ses-2'),
    'sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz': '',
    'sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz': ''
  }));
  assert.deepEqual(result.runs.map(run => run.session), ['1', '2']);
  assert.deepEqual(result.runs.map(run => run.t1w.name), ['sub-01_ses-1_T1w.nii.gz', 'sub-01_ses-2_T1w.nii.gz']);
  assert.deepEqual(result.runs[0].t1wCandidates.map(file => file.name), ['sub-01_ses-1_T1w.nii.gz', 'sub-01_ses-2_T1w.nii.gz']);
  assert.deepEqual(result.unpaired, []);
});

test('falls back to a T1w from another session of the subject', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/ses-2/dwi/sub-01_ses-2'),
    'sub-01/ses-1/anat/sub-01_ses-1_T1w.nii': ''
  }));
  assert.equal(result.runs[0].t1w.name, 'sub-01_ses-1_T1w.nii');
});

test('reports no T1w when the subject has none', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'sub-02/anat/sub-02_T1w.nii.gz': ''
  }));
  assert.equal(result.runs[0].t1w, null);
  assert.deepEqual(result.runs[0].t1wCandidates, []);
  assert.deepEqual(result.unpaired.map(entry => [entry.path, entry.reason]), [
    ['ds/sub-02/anat/sub-02_T1w.nii.gz', 'No DWI run for subject 02.']
  ]);
});

test('pairs an epi fieldmap whose IntendedFor is a bids:: URI', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/ses-1/dwi/sub-01_ses-1_run-1'),
    ...dwiRun('sub-01/ses-1/dwi/sub-01_ses-1_run-2'),
    'sub-01/ses-1/fmap/sub-01_ses-1_dir-PA_epi.nii.gz': '',
    'sub-01/ses-1/fmap/sub-01_ses-1_dir-PA_epi.json': {
      PhaseEncodingDirection: 'j',
      TotalReadoutTime: 0.05,
      IntendedFor: 'bids::sub-01/ses-1/dwi/sub-01_ses-1_run-2_dwi.nii.gz'
    }
  }));
  assert.deepEqual(result.runs[0].fieldmaps, []);
  const [fieldmap] = result.runs[1].fieldmaps;
  assert.equal(fieldmap.path, 'sub-01/ses-1/fmap/sub-01_ses-1_dir-PA_epi.nii.gz');
  assert.equal(fieldmap.file.name, 'sub-01_ses-1_dir-PA_epi.nii.gz');
  assert.equal(fieldmap.json.name, 'sub-01_ses-1_dir-PA_epi.json');
  assert.equal(fieldmap.entities.dir, 'PA');
  assert.equal(fieldmap.sidecar.TotalReadoutTime, 0.05);
  assert.deepEqual(result.unpaired, []);
});

test('pairs an epi fieldmap whose IntendedFor is a subject-relative path list', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/ses-1/dwi/sub-01_ses-1_run-1'),
    ...dwiRun('sub-01/ses-1/dwi/sub-01_ses-1_run-2'),
    'sub-01/ses-1/fmap/sub-01_ses-1_dir-PA_epi.nii.gz': '',
    'sub-01/ses-1/fmap/sub-01_ses-1_dir-PA_epi.json': {
      IntendedFor: ['ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz', 'ses-1/func/sub-01_ses-1_task-rest_bold.nii.gz']
    }
  }));
  assert.equal(result.runs[0].fieldmaps.length, 1);
  assert.deepEqual(result.runs[1].fieldmaps, []);
});

test('lists a fieldmap that names no DWI run', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'sub-01/fmap/sub-01_dir-PA_epi.nii.gz': '',
    'sub-01/fmap/sub-01_dir-PA_epi.json': { IntendedFor: 'bids::sub-01/func/sub-01_task-rest_bold.nii.gz' },
    'sub-01/fmap/sub-01_dir-AP_epi.nii.gz': '',
    'sub-01/fmap/sub-01_phasediff.nii.gz': ''
  }));
  assert.deepEqual(result.runs[0].fieldmaps, []);
  assert.deepEqual(result.unpaired.map(entry => [entry.path, entry.reason]), [
    ['ds/sub-01/fmap/sub-01_dir-AP_epi.nii.gz', 'The fieldmap has no IntendedFor in its sidecar.'],
    ['ds/sub-01/fmap/sub-01_dir-PA_epi.json', 'No fieldmap image that this file applies to is used.'],
    ['ds/sub-01/fmap/sub-01_dir-PA_epi.nii.gz', 'IntendedFor names no DWI image in the folder.'],
    ['ds/sub-01/fmap/sub-01_phasediff.nii.gz', 'Only _epi fieldmaps are read, not _phasediff.']
  ]);
});

test('gives a clear error for a run without a .bval', async () => {
  const files = dwiRun('sub-01/dwi/sub-01');
  delete files['sub-01/dwi/sub-01_dwi.bval'];
  const result = await readBidsDiffusion(tree(files));
  const [run] = result.runs;
  assert.equal(run.bval, null);
  assert.equal(run.bvec.name, 'sub-01_dwi.bvec');
  assert.equal(run.error, 'sub-01/dwi/sub-01_dwi.nii.gz has no .bval file. Add sub-01_dwi.bval beside it.');
});

test('gives a clear error for a run without a .bvec, and keeps the other run usable', async () => {
  const files = { ...dwiRun('sub-01/dwi/sub-01_run-1'), ...dwiRun('sub-01/dwi/sub-01_run-2') };
  delete files['sub-01/dwi/sub-01_run-2_dwi.bvec'];
  const result = await readBidsDiffusion(tree(files));
  assert.equal(result.runs[0].error, null);
  assert.equal(result.runs[1].bvec, null);
  assert.equal(result.runs[1].error, 'sub-01/dwi/sub-01_run-2_dwi.nii.gz has no .bvec file. Add sub-01_run-2_dwi.bvec beside it.');
});

test('names both gradient tables when both are missing', async () => {
  const result = await readBidsDiffusion(tree({ 'sub-01/dwi/sub-01_dwi.nii': '' }));
  assert.equal(result.runs[0].error, 'sub-01/dwi/sub-01_dwi.nii has no .bval or .bvec file. Add sub-01_dwi.bval and sub-01_dwi.bvec beside it.');
});

test('merges JSON sidecars by inheritance, deeper levels winning', async () => {
  const result = await readBidsDiffusion(tree({
    'dwi.json': { MagneticFieldStrength: 3, EchoTime: 0.1, Manufacturer: 'Siemens' },
    'dwi.bval': '0 1000',
    'task-rest_bold.json': { RepetitionTime: 2 },
    'sub-01/sub-01_dwi.json': { EchoTime: 0.09 },
    'sub-01/ses-1/sub-01_ses-1_acq-other_dwi.json': { EchoTime: 0.5 },
    'sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz': '',
    'sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.bvec': '0 1\n0 0\n0 0',
    'sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.json': { PhaseEncodingDirection: 'j-' }
  }));
  const [run] = result.runs;
  assert.deepEqual(run.sidecar, {
    MagneticFieldStrength: 3,
    EchoTime: 0.09,
    Manufacturer: 'Siemens',
    PhaseEncodingDirection: 'j-'
  });
  assert.equal(run.json.name, 'sub-01_ses-1_run-1_dwi.json');
  assert.equal(run.bval.webkitRelativePath, 'ds/dwi.bval');
  assert.equal(run.error, null);
  assert.deepEqual(unpairedPaths(result), [
    'ds/sub-01/ses-1/sub-01_ses-1_acq-other_dwi.json',
    'ds/task-rest_bold.json'
  ]);
});

test('reads a dropped folder whose root is a parent of the dataset', async () => {
  const files = [
    fakeFile('studies/notes.txt', 'hello'),
    ...tree(dwiRun('sub-01/dwi/sub-01'), 'studies/ds001'),
    fakeFile('studies/ds001/dataset_description.json', {})
  ];
  const result = await readBidsDiffusion(files);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].root, 'studies/ds001');
  assert.equal(result.runs[0].path, 'sub-01/dwi/sub-01_dwi.nii.gz');
  assert.deepEqual(result.unpaired.map(entry => [entry.path, entry.reason]), [
    ['studies/notes.txt', 'Not inside a sub-* folder.']
  ]);
});

test('reads a selection whose paths start at the subject folder', async () => {
  const files = Object.entries(dwiRun('sub-01/dwi/sub-01')).map(([path, content]) => fakeFile(path, content));
  const result = await readBidsDiffusion(files);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].root, '');
});

test('lists files it cannot pair, with reasons', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'sub-01/dwi/sub-01_run-9_dwi.bval': '0',
    'sub-01/dwi/sub-01_sbref.nii.gz': '',
    'sub-01/anat/sub-01_FLAIR.nii.gz': '',
    'sub-01/func/sub-01_task-rest_bold.nii.gz': '',
    'sub-01/dwi/sub-01_acq-bad_dwi.json': 'not json'
  }));
  assert.equal(result.runs.length, 1);
  const reasons = Object.fromEntries(result.unpaired.map(entry => [entry.path, entry.reason]));
  assert.equal(reasons['ds/sub-01/dwi/sub-01_run-9_dwi.bval'], 'No DWI image in the folder that this file applies to.');
  assert.equal(reasons['ds/sub-01/dwi/sub-01_sbref.nii.gz'], 'Not a DWI image: the suffix is "sbref", not "dwi".');
  assert.equal(reasons['ds/sub-01/anat/sub-01_FLAIR.nii.gz'], 'Only T1w images are read from anat, not _FLAIR.');
  assert.equal(reasons['ds/sub-01/func/sub-01_task-rest_bold.nii.gz'], 'The func folder is not a diffusion input.');
  assert.equal(reasons['ds/sub-01/dwi/sub-01_acq-bad_dwi.json'], 'No DWI image in the folder that this file applies to.');
  assert.equal(Object.keys(reasons).length, 5);
});

test('reports a sidecar that applies to a run but is not valid JSON', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'sub-01/sub-01_dwi.json': '{ broken'
  }));
  assert.deepEqual(result.runs[0].sidecar, { PhaseEncodingDirection: 'j-' });
  assert.equal(result.unpaired.length, 1);
  assert.equal(result.unpaired[0].path, 'ds/sub-01/sub-01_dwi.json');
  assert.match(result.unpaired[0].reason, /^JSON sidecar could not be read: /);
});

test('reports an invalid inherited JSON sidecar at the dataset root', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'dwi.json': '{ broken'
  }));
  assert.deepEqual(result.runs[0].sidecar, { PhaseEncodingDirection: 'j-' });
  assert.equal(result.unpaired.length, 1);
  assert.equal(result.unpaired[0].path, 'ds/dwi.json');
  assert.match(result.unpaired[0].reason, /^JSON sidecar could not be read: /);
});

test('lists unexpected root files while omitting dataset metadata', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'dataset_description.json': { Name: 'test', BIDSVersion: '1.10.0' },
    'participants.tsv': 'participant_id\nsub-01\n',
    'participants.json': { participant_id: { Description: 'Participant identifier' } },
    'samples.json': { sample_id: { Description: 'Sample identifier' } },
    'README': 'Dataset documentation',
    'CHANGES.md': 'Dataset history',
    'LICENSE.txt': 'Dataset licence',
    '.bidsignore': 'notes.txt\n',
    'unrelated.nii.gz': '',
    'notes.txt': 'An unpaired file'
  }));
  assert.deepEqual(result.unpaired.map(entry => [entry.path, entry.reason]), [
    ['ds/notes.txt', 'Not inside a sub-* folder.'],
    ['ds/unrelated.nii.gz', 'Not inside a sub-* folder.']
  ]);
});

test('lists root sidecars that apply to no diffusion input', async () => {
  const result = await readBidsDiffusion(tree({
    ...dwiRun('sub-01/dwi/sub-01'),
    'acq-other_dwi.bvec': '0 1\n0 0\n0 0',
    'acq-other_dwi.json': { EchoTime: 0.12 }
  }));
  assert.deepEqual(result.unpaired.map(entry => [entry.path, entry.reason]), [
    ['ds/acq-other_dwi.bvec', 'No diffusion input uses this sidecar.'],
    ['ds/acq-other_dwi.json', 'No diffusion input uses this sidecar.']
  ]);
});

test('gives each DWI run as a diffusion series with its merged sidecar', async () => {
  const files = tree({
    'dwi.json': { TotalReadoutTime: 0.05 },
    ...dwiRun('sub-01/dwi/sub-01_run-1'),
    ...dwiRun('sub-01/dwi/sub-01_run-2', { PhaseEncodingDirection: 'j' }),
    'sub-01/dwi/sub-01_run-3_dwi.nii.gz': ''
  });
  const series = await bidsDiffusionSeries(files);
  assert.deepEqual(series.map(entry => entry.label), ['sub-01_run-1_dwi', 'sub-01_run-2_dwi', 'sub-01_run-3_dwi']);
  assert.deepEqual(series.map(entry => entry.missing), [[], [], ['.bval', '.bvec']]);
  assert.equal(series[1].image, files.find(file => file.name === 'sub-01_run-2_dwi.nii.gz'));
  assert.equal(series[1].bval, files.find(file => file.name === 'sub-01_run-2_dwi.bval'));
  assert.equal(series[1].bvec, files.find(file => file.name === 'sub-01_run-2_dwi.bvec'));
  assert.deepEqual(series[1].sidecar, { TotalReadoutTime: 0.05, PhaseEncodingDirection: 'j' });
  assert.equal(series[1].run.id, 'sub-01_run-2_dwi');
  assert.equal(series[2].bval, null);
});

test('orders runs by number, so run-2 comes before run-10', async () => {
  const series = await bidsDiffusionSeries(tree({ ...dwiRun('sub-01/dwi/sub-01_run-10'), ...dwiRun('sub-01/dwi/sub-01_run-2') }));
  assert.deepEqual(series.map(entry => entry.label), ['sub-01_run-2_dwi', 'sub-01_run-10_dwi']);
  assert.equal(chosenBidsRun(series), 0);
});

test('names the dataset of each series when a drop holds two datasets', async () => {
  const files = [...tree(dwiRun('sub-01/dwi/sub-01'), 'a'), ...tree(dwiRun('sub-01/dwi/sub-01'), 'b')]
    .map(file => ({ ...file, webkitRelativePath: `top/${file.webkitRelativePath}` }));
  const series = await bidsDiffusionSeries(files);
  assert.deepEqual(series.map(entry => entry.label), ['top/a/sub-01_dwi', 'top/b/sub-01_dwi']);
});

test('gives no series for loose files and refuses a folder whose runs lack the required tables', async () => {
  assert.equal(await bidsDiffusionSeries([fakeFile('dwi.nii.gz'), fakeFile('dwi.bval', '0')]), null);
  await assert.rejects(
    bidsDiffusionSeries(tree({ 'sub-01/dwi/sub-01_dwi.nii.gz': '' })),
    { message: 'sub-01/dwi/sub-01_dwi.nii.gz has no .bval or .bvec file. Add sub-01_dwi.bval and sub-01_dwi.bvec beside it.' }
  );
  await assert.rejects(
    bidsDiffusionSeries(tree({ 'sub-01/dwi/sub-01_dwi.nii.gz': '', 'sub-01/dwi/sub-01_dwi.bvec': '' }), { require: ['.bval'] }),
    { message: 'sub-01/dwi/sub-01_dwi.nii.gz has no .bval file. Add sub-01_dwi.bval beside it.' }
  );
  await assert.rejects(bidsDiffusionSeries([], { require: ['.json'] }), /Unknown gradient table/);
});

test('loads a folder without gradients when the app needs none', async () => {
  const files = tree({
    'sub-01/anat/sub-01_T1w.nii.gz': '',
    'sub-01/dwi/sub-01_run-1_dwi.nii.gz': '',
    ...dwiRun('sub-01/dwi/sub-01_run-2')
  });
  const none = await bidsDiffusionSeries(files, { require: [] });
  assert.deepEqual(none.map(entry => [entry.label, entry.missing]), [['sub-01_run-1_dwi', []], ['sub-01_run-2_dwi', []]]);
  assert.equal(none[0].bval, null);
  const bval = await bidsDiffusionSeries(files, { require: ['.bval'] });
  assert.deepEqual(bval.map(entry => entry.missing), [['.bval'], []]);
  // The first loadable run is the default.
  assert.equal(chosenBidsRun(bval), 1);
});

test('remembers the chosen run for the same files only', async () => {
  const files = tree({ ...dwiRun('sub-01/dwi/sub-01_run-1'), ...dwiRun('sub-01/dwi/sub-01_run-2'), 'sub-01/dwi/sub-01_run-3_dwi.nii.gz': '' });
  const first = await bidsDiffusionSeries(files);
  assert.equal(chosenBidsRun(first), 0);
  chooseBidsRun(first, 1);
  // Undo puts the same File objects back on the input.
  assert.equal(chosenBidsRun(await bidsDiffusionSeries(files)), 1);
  // A new drop of the same folder gives new File objects.
  const again = tree({ ...dwiRun('sub-01/dwi/sub-01_run-1'), ...dwiRun('sub-01/dwi/sub-01_run-2') });
  assert.equal(chosenBidsRun(await bidsDiffusionSeries(again)), 0);
  assert.throws(() => chooseBidsRun(first, 2), { message: 'sub-01/dwi/sub-01_run-3_dwi.nii.gz has no .bval or .bvec file. Add sub-01_run-3_dwi.bval and sub-01_run-3_dwi.bvec beside it.' });
  assert.throws(() => chooseBidsRun(first, 5), RangeError);
});
