/** A file name split under the BIDS naming scheme. */
export interface BidsFileName {
  /** The name without its extension, e.g. `sub-01_ses-1_run-1_dwi`. */
  stem: string;
  /** Key-value entities in name order, e.g. `{ sub: '01', ses: '1', run: '1' }`. */
  entities: Record<string, string>;
  /** The suffix after the last entity, e.g. `dwi`, `epi`, `T1w`. */
  suffix: string;
  /** The extension with its leading dot, e.g. `.nii.gz`. */
  extension: string;
}

/** An `fmap/*_epi` image whose `IntendedFor` names a DWI run. */
export interface BidsFieldmap {
  file: File;
  /** Path from the dataset root. */
  path: string;
  entities: Record<string, string>;
  /** The fieldmap's own sidecar beside it, or null when only inherited sidecars apply. */
  json: File | null;
  /** Every applicable sidecar merged, dataset root first. */
  sidecar: Record<string, unknown>;
}

/** One `dwi/*_dwi.nii[.gz]` run and the files that go with it. */
export interface BidsDiffusionRun {
  /** The DWI file name without its extension. */
  id: string;
  /** The dataset folder within the dropped folder, '' when the drop is the dataset's contents. */
  root: string;
  /** Path of the DWI image from the dataset root. */
  path: string;
  subject: string;
  session: string | null;
  entities: Record<string, string>;
  dwi: File;
  /** The most specific applicable `.bval`, or null (see `error`). */
  bval: File | null;
  /** The most specific applicable `.bvec`, or null (see `error`). */
  bvec: File | null;
  /** The run's own JSON sidecar beside the image, or null. */
  json: File | null;
  /** Every applicable JSON sidecar merged by BIDS inheritance, dataset root first. */
  sidecar: Record<string, unknown>;
  fieldmaps: BidsFieldmap[];
  /** The preferred T1w image: same session, then session-less, then other sessions. */
  t1w: File | null;
  /** Every T1w image of the subject, in preference order. */
  t1wCandidates: File[];
  /** Why the run cannot be processed (a missing `.bval` or `.bvec`), or null. */
  error: string | null;
}

/** A file the reader did not pair with any run. */
export interface BidsUnpairedFile {
  file: File;
  /** Path as dropped or selected. */
  path: string;
  reason: string;
}

export interface BidsDiffusionReadResult {
  /** One record per DWI run, sorted by dataset and path. */
  runs: BidsDiffusionRun[];
  /** Files that belong to no run, except metadata at the dataset root. */
  unpaired: BidsUnpairedFile[];
}

/**
 * Read diffusion runs from a selected or dropped BIDS folder (files carry `webkitRelativePath`).
 */
export function readBidsDiffusion(files: Iterable<File> | ArrayLike<File>): Promise<BidsDiffusionReadResult>;

/** One BIDS DWI run in the shape of `readDiffusionSeries`' series. */
export interface BidsDiffusionSeries {
  /** The run's DWI file name without its extension, with its dataset folder when the drop holds more than one. */
  label: string;
  run: BidsDiffusionRun;
  image: File;
  bval: File | null;
  bvec: File | null;
  /** Every applicable JSON sidecar merged by BIDS inheritance. */
  sidecar: Record<string, unknown>;
  /** The required gradient tables (`.bval`, `.bvec`) that the run does not have. A run with any cannot be loaded. */
  missing: string[];
}

export interface BidsDiffusionSeriesOptions {
  /** The gradient tables the app needs: `.bval`, `.bvec`, both (the default) or none. */
  require?: string[];
}

/**
 * Every DWI run of a BIDS folder, or null when the files hold no BIDS DWI run. Throws when no
 * run has every required gradient table.
 */
export function bidsDiffusionSeries(
  files: Iterable<File> | ArrayLike<File>,
  options?: BidsDiffusionSeriesOptions
): Promise<BidsDiffusionSeries[] | null>;

/** The run to load: the one last chosen from the same files, else the first complete run. */
export function chosenBidsRun(series: BidsDiffusionSeries[]): number;

/** Remember the run loaded from these series, so the same files (for example on Undo) load it again. */
export function chooseBidsRun(series: BidsDiffusionSeries[], index: number): void;

/** Split a BIDS file name into entities, suffix and extension. */
export function parseBidsName(name: string): BidsFileName;
