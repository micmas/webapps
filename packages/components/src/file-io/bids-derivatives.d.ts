/** The BIDS stem and suffix of an image name: sub-01_dwi.nii.gz gives ["sub-01", "dwi"]. */
export function splitName(fileName: string): [stem: string, suffix: string];

/** The source entities of an image name: its stem without any desc- entity. */
export function sourceStem(fileName: string): string;

export interface DerivativeNames {
  image: string;
  bval: string;
  bvec: string;
  sidecar: string;
}

/** The derivative names of a corrected image: `<source>_desc-<desc>_<suffix>`. */
export function outputNames(fileName: string, desc: string, options?: { defaultSuffix?: string }): DerivativeNames;

/** The BIDS name of a brain mask: <stem>_desc-brain_mask.nii.gz. */
export function maskName(stem: string): string;

/** The sidecar of a derivative: the input's fields, with the step recorded as Description. */
export function derivativeSidecar<T extends Record<string, unknown>>(sidecar: T | null | undefined, description: string): T & { Description: string };

/** The text of a sidecar: two-space JSON and a final newline. */
export function sidecarText(sidecar: unknown): string;

/** A gzip-compressed File of the bytes. An aborted signal stops it before and after compression. */
export function gzipFile(buffer: BlobPart, name: string, signal?: AbortSignal): Promise<File>;
