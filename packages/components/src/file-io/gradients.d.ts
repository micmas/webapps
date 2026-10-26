/** Whitespace-separated numbers from one line or a whole file. */
export function parseNumbers(text: string): number[];

/** Parses an FSL bval file; with `frames`, it must list one b-value per volume. Throws on bad input. */
export function parseBval(bvalText: string, frames?: number): number[];
