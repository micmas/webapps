/** A volume with b below this value (s/mm²) is a b0. */
export const B0_THRESHOLD: number;
export function parseNumbers(text: string): number[];
export function parseBval(bvalText: string, frames?: number): number[];
export function parseBvalBvec(bvalText: string, bvecText: string): { bvals: number[]; bvecs: [number[], number[], number[]] };
export function countDirections(bvalText: string, bvecText: string): number;
export function b0Index(bvalText: string): number;
export function isB0(b: number): boolean;
export function b0Volumes(bvals: readonly number[] | null, frames: number): number[];
