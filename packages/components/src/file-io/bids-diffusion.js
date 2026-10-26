/**
 * Read diffusion inputs from a BIDS folder: every `dwi/*_dwi.nii[.gz]` run with its
 * gradient tables and merged JSON sidecar, the `fmap/*_epi` images whose `IntendedFor`
 * names it, and the subject's `anat/*_T1w` image.
 *
 * The input is the File list of a folder input or a dropped folder, each file carrying its
 * `webkitRelativePath`. The dataset root is the folder that holds the `sub-*` folders, so a
 * drop of the dataset itself or of any parent folder reads the same.
 */

const NIFTI_EXTENSIONS = ['.nii.gz', '.nii'];
const SIDECAR_EXTENSIONS = ['.json', '.bval', '.bvec'];
const SUBJECT_FOLDER = /^sub-[A-Za-z0-9]+$/;
const SESSION_FOLDER = /^ses-[A-Za-z0-9]+$/;
const BIDS_URI_PREFIX = 'bids::';
const NUMERIC = { numeric: true };
const GRADIENT_KINDS = ['.bval', '.bvec'];
// The run last chosen from a folder, keyed by the folder's first DWI image: Undo gives the same File objects back.
const chosenRuns = new WeakMap();
const DATASET_METADATA_FILES = new Set(['dataset_description.json', 'participants.tsv', 'participants.json', 'samples.tsv', 'samples.json', '.bidsignore']);

/**
 * @param {Iterable<File> | ArrayLike<File>} fileList
 * @returns {Promise<import('./bids-diffusion').BidsDiffusionReadResult>}
 */
export async function readBidsDiffusion(fileList) {
  const entries = Array.from(fileList || [], describeFile);
  const roots = new Set(entries.filter(entry => entry.subject !== null).map(entry => entry.root));
  const byDirectory = new Map();
  for (const entry of entries) {
    if (entry.root === null) continue;
    const key = directoryKey(entry.root, entry.directory);
    if (!byDirectory.has(key)) byDirectory.set(key, []);
    byDirectory.get(key).push(entry);
  }

  const used = new Set();
  const invalid = new Map();
  const jsonCache = new Map();
  const context = { byDirectory, used, invalid, jsonCache };

  const dwiImages = entries.filter(entry => entry.datatype === 'dwi' && entry.suffix === 'dwi' && entry.kind === 'nifti');
  const epiImages = entries.filter(entry => entry.datatype === 'fmap' && entry.suffix === 'epi' && entry.kind === 'nifti');
  const t1wImages = entries.filter(entry => entry.datatype === 'anat' && entry.suffix === 'T1w' && entry.kind === 'nifti');

  const fieldmaps = [];
  for (const image of epiImages) {
    const sidecar = await mergedSidecar(image, context);
    fieldmaps.push({
      entry: image,
      record: {
        file: image.file,
        path: image.path,
        entities: { ...image.entities },
        json: sidecar.json,
        sidecar: sidecar.data
      },
      targets: intendedForTargets(sidecar.data.IntendedFor, image.subject),
      matched: false
    });
  }

  const runs = [];
  for (const image of dwiImages) {
    used.add(image);
    const sidecar = await mergedSidecar(image, context);
    markSidecarsUsed(image, context);
    const bval = nearestApplicable(image, '.bval', context);
    const bvec = nearestApplicable(image, '.bvec', context);
    if (bval) used.add(bval);
    if (bvec) used.add(bvec);

    const imageKey = stripNiftiExtension(image.path);
    const matches = fieldmaps.filter(fieldmap => fieldmap.entry.root === image.root && fieldmap.targets.includes(imageKey));
    for (const fieldmap of matches) {
      fieldmap.matched = true;
      used.add(fieldmap.entry);
    }

    const anatomy = t1wImages
      .filter(candidate => candidate.root === image.root && candidate.subject === image.subject)
      .sort((a, b) => sessionRank(a, image) - sessionRank(b, image) || a.path.localeCompare(b.path));
    for (const candidate of anatomy) used.add(candidate);

    runs.push({
      id: image.stem,
      root: image.root,
      path: image.path,
      subject: image.subject,
      session: image.session,
      entities: { ...image.entities },
      dwi: image.file,
      bval: bval ? bval.file : null,
      bvec: bvec ? bvec.file : null,
      json: sidecar.json,
      sidecar: sidecar.data,
      fieldmaps: matches.map(fieldmap => fieldmap.record),
      t1w: anatomy.length ? anatomy[0].file : null,
      t1wCandidates: anatomy.map(candidate => candidate.file),
      error: gradientError(image, bval, bvec)
    });
  }

  // The fieldmaps' and T1w images' own sidecars count as used only when their image is.
  for (const fieldmap of fieldmaps) {
    if (fieldmap.matched) markSidecarsUsed(fieldmap.entry, context);
  }
  for (const image of t1wImages) {
    if (used.has(image)) markSidecarsUsed(image, context);
  }

  // Numeric order, so run-2 comes before run-10.
  runs.sort((a, b) => a.root.localeCompare(b.root, undefined, NUMERIC) || a.path.localeCompare(b.path, undefined, NUMERIC));
  const unpaired = entries
    .filter(entry => !used.has(entry) && (invalid.has(entry) || !isDatasetMetadata(entry, roots)))
    .map(entry => ({ file: entry.file, path: entry.fullPath, reason: unpairedReason(entry, context, fieldmaps) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { runs, unpaired };
}

/**
 * The DWI runs of a dropped or selected BIDS folder, as diffusion series an app loads: one per
 * run, with the run's merged sidecar. `require` names the gradient tables the app needs; a run
 * without one of them has it in `missing`, and the app shows that run but cannot load it.
 * Throws when no run has every required table. Returns null when the files hold no BIDS DWI run,
 * so the caller reads them as loose NIfTI or DICOM files instead.
 * @param {Iterable<File> | ArrayLike<File>} fileList
 * @param {{ require?: string[] }} [options]
 * @returns {Promise<import('./bids-diffusion').BidsDiffusionSeries[] | null>}
 */
export async function bidsDiffusionSeries(fileList, { require = GRADIENT_KINDS } = {}) {
  for (const kind of require) {
    if (!GRADIENT_KINDS.includes(kind)) throw new Error(`Unknown gradient table ${kind}; use .bval or .bvec.`);
  }
  const { runs } = await readBidsDiffusion(fileList);
  if (!runs.length) return null;
  const roots = new Set(runs.map(run => run.root));
  const series = runs.map(run => ({
    label: roots.size > 1 && run.root ? `${run.root}/${run.id}` : run.id,
    run,
    image: run.dwi,
    bval: run.bval,
    bvec: run.bvec,
    sidecar: run.sidecar,
    missing: require.filter(kind => !(kind === '.bval' ? run.bval : run.bvec))
  }));
  if (!series.some(entry => !entry.missing.length)) throw new Error(missingError(series[0]));
  return series;
}

/**
 * The index of the run to load from a folder's series: the run last chosen from the same files
 * (`chooseBidsRun`), else the first run that has every required table.
 * @param {import('./bids-diffusion').BidsDiffusionSeries[]} series
 * @returns {number}
 */
export function chosenBidsRun(series) {
  const image = series.length ? chosenRuns.get(series[0].image) : undefined;
  const chosen = series.findIndex(entry => entry.image === image && !entry.missing.length);
  return chosen >= 0 ? chosen : series.findIndex(entry => !entry.missing.length);
}

/**
 * Remember the run loaded from a folder's series, so the same files load it again.
 * @param {import('./bids-diffusion').BidsDiffusionSeries[]} series
 * @param {number} index
 */
export function chooseBidsRun(series, index) {
  const entry = series[index];
  if (!entry) throw new RangeError(`No DWI run ${index}; the folder has ${series.length}.`);
  if (entry.missing.length) throw new Error(missingError(entry));
  chosenRuns.set(series[0].image, entry.image);
}

function missingError(entry) {
  const names = entry.missing.map(kind => entry.run.id + kind).join(' and ');
  return `${entry.run.path} has no ${entry.missing.join(' or ')} file. Add ${names} beside it.`;
}

/**
 * Split a BIDS file name into its entities, suffix and extension.
 * @param {string} name
 * @returns {import('./bids-diffusion').BidsFileName}
 */
export function parseBidsName(name) {
  const base = String(name).replace(/^.*\//, '');
  const extension = bidsExtension(base);
  const stem = base.slice(0, base.length - extension.length);
  const parts = stem.split('_');
  const suffix = parts.length && !parts[parts.length - 1].includes('-') ? parts.pop() : '';
  const entities = {};
  for (const part of parts) {
    const dash = part.indexOf('-');
    if (dash <= 0) continue;
    entities[part.slice(0, dash)] = part.slice(dash + 1);
  }
  return { stem, entities, suffix, extension };
}

function describeFile(file) {
  const fullPath = relativePath(file);
  const segments = fullPath.split('/');
  const name = segments.pop();
  const subjectIndex = segments.findIndex(segment => SUBJECT_FOLDER.test(segment));
  const parsed = parseBidsName(name);
  const entry = {
    file,
    fullPath,
    name,
    stem: parsed.stem,
    entities: parsed.entities,
    suffix: parsed.suffix,
    extension: parsed.extension,
    kind: fileKind(parsed.extension),
    root: null,
    directory: [],
    path: fullPath,
    subject: null,
    session: null,
    datatype: null
  };
  if (subjectIndex < 0) {
    entry.root = segments.join('/');
    entry.directory = [];
    entry.path = name;
    entry.atRoot = true;
    return entry;
  }
  entry.root = segments.slice(0, subjectIndex).join('/');
  entry.directory = segments.slice(subjectIndex);
  entry.path = [...entry.directory, name].join('/');
  entry.subject = entry.directory[0].slice('sub-'.length);
  let next = 1;
  if (entry.directory[next] && SESSION_FOLDER.test(entry.directory[next])) {
    entry.session = entry.directory[next].slice('ses-'.length);
    next += 1;
  }
  if (entry.directory.length === next + 1) entry.datatype = entry.directory[next];
  entry.inLayout = entry.directory.length <= next + 1;
  return entry;
}

function relativePath(file) {
  const path = file?.webkitRelativePath || file?._webkitRelativePath || file?.name || '';
  return String(path).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
}

function bidsExtension(name) {
  const lower = name.toLowerCase();
  for (const extension of [...NIFTI_EXTENSIONS, ...SIDECAR_EXTENSIONS]) {
    if (lower.endsWith(extension)) return name.slice(name.length - extension.length);
  }
  const dot = name.indexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

function fileKind(extension) {
  const lower = extension.toLowerCase();
  if (NIFTI_EXTENSIONS.includes(lower)) return 'nifti';
  if (SIDECAR_EXTENSIONS.includes(lower)) return lower.slice(1);
  return 'other';
}

function stripNiftiExtension(path) {
  return path.replace(/\.nii(\.gz)?$/i, '');
}

function directoryKey(root, directory) {
  return `${root}\u0000${directory.join('/')}`;
}

/**
 * The folders whose metadata applies to a file under the inheritance principle,
 * from the dataset root down to the file's own folder.
 */
function inheritanceLevels(entry) {
  const levels = [];
  for (let depth = 0; depth <= entry.directory.length; depth += 1) {
    levels.push(directoryKey(entry.root, entry.directory.slice(0, depth)));
  }
  return levels;
}

/** Sidecars at one level that apply to the image: same suffix, entities a subset of the image's. */
function applicableAt(level, image, kind, context) {
  const candidates = context.byDirectory.get(level) || [];
  return candidates
    .filter(candidate => candidate.kind === kind && candidate.suffix === image.suffix)
    .filter(candidate => Object.entries(candidate.entities).every(([key, value]) => image.entities[key] === value))
    .sort((a, b) => Object.keys(a.entities).length - Object.keys(b.entities).length || a.name.localeCompare(b.name));
}

/** The most specific applicable file of a kind; gradient tables are not merged. */
function nearestApplicable(image, extension, context) {
  const kind = extension.slice(1);
  const levels = inheritanceLevels(image).reverse();
  for (const level of levels) {
    const applicable = applicableAt(level, image, kind, context);
    if (applicable.length) return applicable[applicable.length - 1];
  }
  return null;
}

/** Merge every applicable JSON sidecar, dataset root first, so deeper keys win. */
async function mergedSidecar(image, context) {
  const data = {};
  let json = null;
  for (const level of inheritanceLevels(image)) {
    for (const candidate of applicableAt(level, image, 'json', context)) {
      const values = await readJson(candidate, context);
      if (!values) continue;
      Object.assign(data, values);
      if (candidate.stem === image.stem && level === directoryKey(image.root, image.directory)) json = candidate.file;
    }
  }
  return { json, data };
}

function markSidecarsUsed(image, context) {
  for (const level of inheritanceLevels(image)) {
    for (const candidate of applicableAt(level, image, 'json', context)) {
      if (!context.invalid.has(candidate)) context.used.add(candidate);
    }
  }
}

async function readJson(entry, context) {
  if (!context.jsonCache.has(entry)) {
    context.jsonCache.set(entry, parseJsonFile(entry, context));
  }
  return context.jsonCache.get(entry);
}

async function parseJsonFile(entry, context) {
  try {
    const text = await entry.file.text();
    const values = JSON.parse(text);
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      context.invalid.set(entry, 'JSON sidecar is not an object');
      return null;
    }
    return values;
  } catch (error) {
    context.invalid.set(entry, `JSON sidecar could not be read: ${error.message}`);
    return null;
  }
}

/**
 * Dataset-relative paths, without the NIfTI extension, that an `IntendedFor` value names.
 * Accepts `bids::` URIs and the older paths relative to the subject folder.
 */
function intendedForTargets(value, subject) {
  const values = Array.isArray(value) ? value : [value];
  const targets = [];
  for (const item of values) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const text = item.trim().replace(/\\/g, '/');
    const path = text.startsWith(BIDS_URI_PREFIX)
      ? text.slice(BIDS_URI_PREFIX.length).replace(/^\/+/, '')
      : `sub-${subject}/${text.replace(/^\/+/, '')}`;
    targets.push(stripNiftiExtension(path));
  }
  return targets;
}

/** Order T1w candidates: the run's session, then session-less images, then other sessions. */
function sessionRank(candidate, image) {
  if (candidate.session === image.session) return 0;
  if (candidate.session === null) return 1;
  return 2;
}

function gradientError(image, bval, bvec) {
  const missing = [];
  if (!bval) missing.push('.bval');
  if (!bvec) missing.push('.bvec');
  if (!missing.length) return null;
  const names = missing.map(extension => image.stem + extension).join(' and ');
  return `${image.path} has no ${missing.join(' or ')} file. Add ${names} beside it.`;
}

/** Files at the dataset root (dataset_description.json, README, top-level sidecars) are not inputs. */
function isDatasetMetadata(entry, roots) {
  if (!entry.atRoot || !roots.has(entry.root)) return false;
  return DATASET_METADATA_FILES.has(entry.name)
    || /^(README|CHANGES|LICENSE)(\.(md|rst|txt))?$/i.test(entry.name);
}

function unpairedReason(entry, context, fieldmaps) {
  if (context.invalid.has(entry)) return context.invalid.get(entry);
  const sidecarKind = ['json', 'bval', 'bvec'].includes(entry.kind);
  if (entry.atRoot) return sidecarKind ? 'No diffusion input uses this sidecar.' : 'Not inside a sub-* folder.';
  if (entry.inLayout && !entry.datatype && sidecarKind) return 'No image that this file applies to is used.';
  if (!entry.inLayout || !entry.datatype) return 'Not in a BIDS datatype folder (sub-*/[ses-*/]<datatype>/).';
  if (entry.datatype === 'dwi') {
    if (entry.kind === 'nifti') return `Not a DWI image: the suffix is "${entry.suffix}", not "dwi".`;
    return 'No DWI image in the folder that this file applies to.';
  }
  if (entry.datatype === 'fmap') {
    if (entry.kind === 'nifti' && entry.suffix === 'epi') {
      const fieldmap = fieldmaps.find(candidate => candidate.entry === entry);
      if (!fieldmap || !fieldmap.targets.length) return 'The fieldmap has no IntendedFor in its sidecar.';
      return 'IntendedFor names no DWI image in the folder.';
    }
    if (entry.kind === 'nifti') return `Only _epi fieldmaps are read, not _${entry.suffix}.`;
    return 'No fieldmap image that this file applies to is used.';
  }
  if (entry.datatype === 'anat') {
    if (entry.kind === 'nifti' && entry.suffix === 'T1w') return `No DWI run for subject ${entry.subject}.`;
    if (entry.kind === 'nifti') return `Only T1w images are read from anat, not _${entry.suffix}.`;
    return 'No T1w image that this file applies to is used.';
  }
  return `The ${entry.datatype} folder is not a diffusion input.`;
}
