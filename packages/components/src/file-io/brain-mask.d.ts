import type { NiftiBytes } from './NiftiUtils.js';

/** One byte per voxel: 1 where the value is above 0, else 0. */
export function binaryMask(data: ArrayLike<number>): Uint8Array;

/** Reads a brain mask for an image; refuses another grid and more than one volume. */
export function readBrainMask(
  bytes: NiftiBytes,
  reference: NiftiBytes,
  options?: { name?: string; grid?: string; signal?: AbortSignal }
): Promise<Uint8Array>;
