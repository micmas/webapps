import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import fixtureDownloads from './huggingface-fixtures.cjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function browserAssetPath(entry, cache, downloadOptions = {}) {
    const path = join(cache, entry.sha256);
    let bytes;
    try {
        bytes = await readFile(path);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (!bytes || bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
        const temporary = `${path}.${randomUUID()}`;
        try {
            await fixtureDownloads.download(entry.url, temporary, { maxRetries: 2, timeoutMs: 120000, ...downloadOptions });
            bytes = await readFile(temporary);
            if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error(`${entry.file}: checksum mismatch`);
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
    return path;
}
