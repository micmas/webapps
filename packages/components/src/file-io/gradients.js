// FSL b-value files: one row of V b-values, one per volume. Shared by the DWI apps and their command lines.

/** Whitespace-separated numbers from one line or a whole file. */
export function parseNumbers(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map(Number);
}

/**
 * Parses and validates an FSL bval file: non-empty, finite, non-negative b-values. With `frames`,
 * the file must list one b-value per volume of the image. Throws an Error a user can act on.
 * @returns {number[]}
 */
export function parseBval(bvalText, frames) {
  const bvals = parseNumbers(bvalText);
  if (bvals.length === 0) throw new Error('bval file is empty.');
  if (!bvals.every(Number.isFinite)) throw new Error('bval contains non-numeric or non-finite values.');
  if (bvals.some((b) => b < 0)) throw new Error('bval contains negative values.');
  if (frames !== undefined && bvals.length !== frames) throw new Error(`The image has ${frames} volumes but the bval file lists ${bvals.length}.`);
  return bvals;
}
