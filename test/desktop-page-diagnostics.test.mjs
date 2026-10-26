import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observePageDiagnostics } from '../scripts/desktop/page-diagnostics.mjs';

test('a failed shell request records its URL, resource and transport error', () => {
  const page = new EventEmitter();
  const lines = [];
  const diagnostics = observePageDiagnostics(page, { label: 'elastix', log: line => lines.push(line) });
  page.emit('requestfailed', {
    url: () => 'http://127.0.0.1:57214/elastix/app-shell.js',
    method: () => 'GET',
    resourceType: () => 'script',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_FAILED' }),
  });
  const expected = { url: 'http://127.0.0.1:57214/elastix/app-shell.js', method: 'GET', resourceType: 'script', error: 'net::ERR_CONNECTION_FAILED' };
  assert.deepEqual(diagnostics, { requestFailures: [expected], consoleErrors: [] });
  assert.deepEqual(lines, [`elastix requestfailed: ${JSON.stringify(expected)}`]);
});

test('console errors retain their location and ordinary messages remain visible', () => {
  const page = new EventEmitter();
  const lines = [];
  const diagnostics = observePageDiagnostics(page, { label: 'elastix', log: line => lines.push(line) });
  const location = { url: 'http://127.0.0.1:57214/elastix/app-shell.js', lineNumber: 0, columnNumber: 8 };
  page.emit('console', { type: () => 'error', text: () => 'Failed to load resource', location: () => location });
  page.emit('console', { type: () => 'log', text: () => 'Viewer initialized', location: () => ({ url: '', lineNumber: 0, columnNumber: 0 }) });
  assert.deepEqual(diagnostics.consoleErrors, [{ type: 'error', text: 'Failed to load resource', location }]);
  assert.deepEqual(lines, ['elastix error: Failed to load resource (http://127.0.0.1:57214/elastix/app-shell.js:1:9)', 'elastix log: Viewer initialized']);
});

test('cleanup aborts and absent transport details remain diagnostics only', () => {
  const page = new EventEmitter();
  const diagnostics = observePageDiagnostics(page, { label: 'elastix', log: () => {} });
  for (const error of ['net::ERR_ABORTED', null]) {
    page.emit('requestfailed', {
      url: () => 'http://127.0.0.1:57214/elastix/worker.js',
      method: () => 'GET',
      resourceType: () => 'script',
      failure: () => error && { errorText: error },
    });
  }
  assert.deepEqual(diagnostics.requestFailures.map(failure => failure.error), ['net::ERR_ABORTED', null]);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['consoleErrors', 'requestFailures']);
});
