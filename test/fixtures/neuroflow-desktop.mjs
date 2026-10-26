// The real desktop MCP/service boundary with a deterministic scientific executor.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAutomationService } from '../../packages/desktop/src/automation.js';
import { serveMcp } from '../../packages/desktop/src/mcp.js';
import { describeFile } from '../../packages/desktop/src/reports.js';
import { parseContract } from '../../packages/desktop/src/contracts.js';

const contract = parseContract(JSON.parse(await readFile(process.env.NEURODESK_FIXTURE_CONTRACT)));
const mode = process.env.NEURODESK_FIXTURE_MODE;
if (mode === 'contract-drift') contract.appVersion = '9.0.20260930';
const trace = value => appendFile(process.env.NEURODESK_FIXTURE_TRACE, `${value}\n`);
const service = createAutomationService({
  contracts: [{ contract, sha256: 'a'.repeat(64) }],
  outputRoot: process.argv[process.argv.indexOf('--output') + 1],
  nativeBinary: '/fixture/synthseg',
  async execute({ request, outputDirectory, signal, onProgress }) {
    await trace(`start:${request.engine}`);
    if (mode === 'failure') throw new Error('Scientific execution failed');
    if (mode === 'wait') {
      onProgress({ state: 'running', message: 'Waiting for fixture compute' });
      process.stderr.write('Fixture executor is waiting\n');
      try { await delay(60000, null, { signal }); }
      finally { await trace('cancelled'); }
    }
    const artifacts = {};
    for (let i = 0; i < 2; i++) {
      const path = join(outputDirectory, `part-${i}.json`);
      await writeFile(path, mode === 'large' && i === 0 ? Buffer.alloc(64 * 1024 * 1024 + 1, 32)
        : JSON.stringify({ item: i, parameters: request.parameters }));
      artifacts[`part-${i}`] = { ...await describeFile(path), role: 'items', type: 'file:json', mediaType: 'application/json' };
    }
    const report = { schemaVersion: 2, app: contract.app, appVersion: contract.appVersion, operation: request.operation,
      status: 'succeeded', artifacts, parameters: request.parameters, provenance: { executor: 'test fixture' } };
    const reportPath = join(outputDirectory, 'report.json');
    await writeFile(reportPath, JSON.stringify(report));
    artifacts.report = { ...await describeFile(reportPath), role: 'report', type: 'neuro:report', mediaType: 'application/json' };
    return report;
  },
});
const readResource = service.readResource.bind(service);
service.readResource = async uri => {
  const result = await readResource(uri);
  if (mode === 'tamper' && uri.includes('/artifacts/')) result[0].text = '{}';
  return result;
};
const server = serveMcp(service, { version: '0.1.20260930' });
process.stdin.once('end', () => { void server.close(); });
