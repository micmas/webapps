import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { browserAssetPath } from '../scripts/browser-asset-cache.mjs';

const bytes = Buffer.from('pinned runtime bytes');
const entry = { file: 'runtime.whl', url: 'https://cdn.example/runtime.whl', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

test('a transient connection failure retries and caches only verified runtime bytes', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'sct-runtime-retry-'));
    const originalGet = https.get;
    let calls = 0;
    https.get = (url, callback) => {
        assert.equal(url, entry.url);
        const request = new EventEmitter();
    request.destroy = () => request.emit('close');
        calls += 1;
        process.nextTick(() => {
            if (calls === 1) request.emit('error', Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
            else {
                const response = new PassThrough();
                response.statusCode = 200;
                response.headers = {};
                response.on('end', () => request.emit('close'));
                callback(response);
                response.end(bytes);
            }
        });
        return request;
    };
    try {
        const path = await browserAssetPath(entry, cache, { maxRetries: 1, retryBaseDelayMs: 0 });
        assert.deepEqual(await readFile(path), bytes);
        assert.equal(calls, 2);
        await browserAssetPath(entry, cache);
        assert.equal(calls, 2, 'Verified cache does not fetch again');
        assert.deepEqual(await readdir(cache), [entry.sha256]);
    } finally {
        https.get = originalGet;
        await rm(cache, { recursive: true, force: true });
    }
});

async function withResponses(replies, check) {
    const cache = await mkdtemp(join(tmpdir(), 'sct-runtime-response-'));
    const originalGet = https.get;
    let calls = 0;
    https.get = (url, callback) => {
        const request = new EventEmitter();
        request.destroy = error => {
            request.emit('error', error);
            request.emit('close');
        };
        const reply = replies[Math.min(calls++, replies.length - 1)];
        process.nextTick(() => {
            if (reply.hang) return;
            if (reply.error) return request.destroy(reply.error);
            const response = new PassThrough();
            response.statusCode = reply.status ?? 200;
            response.headers = {};
            response.on('end', () => request.emit('close'));
            callback(response);
            if (reply.abort) {
                response.write(Buffer.from('partial'));
                process.nextTick(() => response.destroy(new Error('response body interrupted')));
            } else if (!reply.stallBody) response.end(reply.body ?? bytes);
        });
        return request;
    };
    try {
        await check(cache, () => calls);
    } finally {
        https.get = originalGet;
        await rm(cache, { recursive: true, force: true });
    }
}

test('transient HTTP errors reuse the bounded fixture downloader', async () => {
    await withResponses([{ status: 503 }, {}], async (cache, calls) => {
        const path = await browserAssetPath(entry, cache, { retryBaseDelayMs: 0 });
        assert.deepEqual(await readFile(path), bytes);
        assert.equal(calls(), 2);
    });
});

test('permanent HTTP and integrity failures publish no cache entry', async () => {
    for (const reply of [{ status: 404 }, { body: Buffer.alloc(bytes.length) }]) {
        await withResponses([reply], async (cache, calls) => {
            await assert.rejects(browserAssetPath(entry, cache, { retryBaseDelayMs: 0 }), /HTTP 404|checksum mismatch/);
            assert.equal(calls(), 1);
            assert.deepEqual(await readdir(cache), []);
        });
    }
});

test('repeated connection errors stop after the configured attempt bound', async () => {
    await withResponses([{ error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }], async (cache, calls) => {
        await assert.rejects(browserAssetPath(entry, cache, { maxRetries: 2, retryBaseDelayMs: 0 }), /connection reset/);
        assert.equal(calls(), 3);
        assert.deepEqual(await readdir(cache), []);
    });
});

test('a connection deadline aborts the stalled attempt before retrying', async () => {
    await withResponses([{ hang: true }, {}], async (cache, calls) => {
        const keepAlive = setTimeout(() => {}, 100);
        try {
            const path = await browserAssetPath(entry, cache, { timeoutMs: 5, maxRetries: 1, retryBaseDelayMs: 0 });
            assert.deepEqual(await readFile(path), bytes);
            assert.equal(calls(), 2);
        } finally {
            clearTimeout(keepAlive);
        }
    });
});


test('a stalled error response cannot schedule a second retry after its deadline', async () => {
    await withResponses([{ status: 503, stallBody: true }], async (cache, calls) => {
        const keepAlive = setTimeout(() => {}, 100);
        try {
            await assert.rejects(browserAssetPath(entry, cache, { timeoutMs: 5, maxRetries: 1, retryBaseDelayMs: 0 }), /HTTP 503/);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(calls(), 2);
            assert.deepEqual(await readdir(cache), []);
        } finally {
            clearTimeout(keepAlive);
        }
    });
});

test('an interrupted successful response retries without publishing partial bytes', async () => {
    await withResponses([{ abort: true }, {}], async (cache, calls) => {
        const path = await browserAssetPath(entry, cache, { maxRetries: 1, retryBaseDelayMs: 0 });
        assert.deepEqual(await readFile(path), bytes);
        assert.equal(calls(), 2);
        assert.deepEqual(await readdir(cache), [entry.sha256]);
    });
});
