/** Collect browser transport evidence without treating cleanup aborts as workflow failures. */
export function observePageDiagnostics(page, { label, log = console.log }) {
  const diagnostics = { requestFailures: [], consoleErrors: [] };
  page.on('requestfailed', request => {
    const failure = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText ?? null,
    };
    diagnostics.requestFailures.push(failure);
    log(`${label} requestfailed: ${JSON.stringify(failure)}`);
  });
  page.on('console', message => {
    const location = message.location();
    const record = { type: message.type(), text: message.text(), location };
    if (record.type === 'error') diagnostics.consoleErrors.push(record);
    const source = location.url ? ` (${location.url}:${location.lineNumber + 1}:${location.columnNumber + 1})` : '';
    log(`${label} ${record.type}: ${record.text}${source}`);
  });
  return diagnostics;
}
