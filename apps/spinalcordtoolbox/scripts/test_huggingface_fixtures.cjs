#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { download } = require('./huggingface-fixtures.cjs');

function mockResponse({ statusCode, headers = {}, body = '' }) {
  const response = new PassThrough();
  response.statusCode = statusCode;
  response.headers = headers;
  process.nextTick(() => response.end(body));
  return response;
}

(async () => {
  const originalGet = https.get;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-hf-download-test-'));
  const destination = path.join(tempRoot, 'fixtures', 'input.nii.gz');
  const requestedUrls = [];
  const responses = [
    { statusCode: 302, headers: { location: 'https://cdn.example/input.nii.gz' } },
    { statusCode: 503 },
    { statusCode: 200, body: 'fixture data' }
  ];

  https.get = (url, callback) => {
    requestedUrls.push(url);
    const request = new EventEmitter();
    request.destroy = () => request.emit('close');
    const response = responses.shift();
    process.nextTick(() => callback(mockResponse(response)));
    return request;
  };

  try {
    await download('https://fixtures.example/input.nii.gz', destination, {
      maxRetries: 2,
      retryBaseDelayMs: 0
    });
    assert.deepEqual(requestedUrls, [
      'https://fixtures.example/input.nii.gz',
      'https://cdn.example/input.nii.gz',
      'https://cdn.example/input.nii.gz'
    ]);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'fixture data');
    console.log('Hugging Face fixture download retry tests passed');
  } finally {
    https.get = originalGet;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
