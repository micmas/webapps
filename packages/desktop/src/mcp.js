import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { isAbsolute } from 'node:path';
import { registerCoreTools, toolContext } from '@niivue/nv-mcp/server';
import * as z from 'zod/v4';
import { requestSchema } from './contracts.js';
import { createNiivueBridge } from './niivue-bridge.js';
import { refuseCredentials } from './source-approval.js';

const app = z.string().regex(/^[a-z][a-z0-9-]*$/);
const run = z.strictObject({ runId: z.string().min(1) });
const request = z.strictObject({
  app,
  operation: app.optional(),
  inputs: z.record(z.string().min(1), z.union([
    z.array(z.string().min(1)).min(1), z.strictObject({ url: z.httpUrl() }), z.strictObject({ directory: z.string().min(1) }),
  ])).optional(),
  parameters: z.record(z.string(), z.json()).optional(),
  selections: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  engine: z.enum(['browser', 'native']).optional(),
  timeoutMs: z.number().int().min(1).max(86400000).optional(),
  retainViewer: z.boolean().optional(),
});
const session = z.strictObject({ sessionId: z.string().min(1) });
const viewer = session.extend({ viewerId: app });
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const startsRun = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const volumeDisplay = z.strictObject({
  index: z.number().int().min(0),
  colormap: z.string().min(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  calMin: z.number().finite().optional(),
  calMax: z.number().finite().optional(),
  visible: z.boolean().optional(),
});

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

// Images travel as MCP image content so clients can show them; the JSON keeps only their size.
function imageResult({ data, mimeType, ...value }) {
  return { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function registerTool(server, name, description, inputSchema, annotations, handler, format = result) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Tool name is not portable across clients: ${name}`);
  server.registerTool(name, { description, inputSchema, annotations }, async args => {
    try {
      return format(await handler(args));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(error?.message ?? error) }],
      };
    }
  });
}

export async function createMcpServer(service, { version, niivue }) {
  const server = new McpServer({ name: 'neurodesk-webapps', version });
  registerTool(server, 'apps_list', 'List installed applications and their automation contracts.',
    z.strictObject({}), readOnly, async () => ({ apps: await service.listApps() }));
  registerTool(server, 'apps_describe', 'Read an installed application automation contract.',
    z.strictObject({ app }), readOnly, ({ app }) => service.describeApp(app));
  registerTool(server, 'apps_validate', 'Validate local input paths and parameters without starting processing.',
    request, readOnly, ({ app, ...request }) => service.validate(app, request));
  registerTool(server, 'runs_start', 'Start processing and return a run ID immediately. Use runs_get to observe completion.',
    request, startsRun, ({ app, ...request }) => service.start(app, request));
  registerTool(server, 'runs_get', 'Read a run state, report URI and any processing error.',
    run, readOnly, ({ runId }) => service.get(runId));
  registerTool(server, 'runs_cancel', 'Cancel a run and release its processing resources. Completed runs stay terminal.',
    run, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    ({ runId }) => service.cancel(runId));

  registerTool(server, 'sessions_list', 'List retained application viewers. Closing a session preserves its completed run report.',
    z.strictObject({}), readOnly, async () => ({ sessions: await service.listSessions() }));
  registerTool(server, 'sessions_close', 'Close a retained viewer and release its memory.',
    session, { ...startsRun, idempotentHint: true }, ({ sessionId }) => service.closeSession(sessionId));
  registerTool(server, 'sessions_grant',
    'Ask to let a retained viewer load a local file or an http(s) URL its run was not given. The person at the viewer approves '
    + 'unless the desktop pre-approves it. Returns grantedUrl, the address to load it by, until the session closes. '
    + 'NiiVue loading tools ask on their own; use this to approve sources ahead of time.',
    // Every http(s) address a loading tool takes, loopback and IP addresses included.
    session.extend({ path: z.string().min(1).optional(), url: z.url({ protocol: /^https?$/ }).optional() }),
    { ...startsRun, idempotentHint: true },
    async ({ sessionId, path, url }) => {
      if (Boolean(path) === Boolean(url)) throw new Error('Give exactly one of path or url');
      refuseCredentials(path ?? url);
      if (path && !isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
      const source = path ? { path } : { url };
      const { url: grantedUrl, approval } = await service.grantSource(sessionId, source);
      return { sessionId, ...source, grantedUrl, approval };
    });
  for (const [name, description, schema, mutates] of [
    ['list', 'List the actual viewers and supported controls in a retained session.', session, false],
    ['state', 'Read the current crosshair, tabs and image location.', viewer, false],
    ['crosshair', 'Move the crosshair using three world coordinates in millimetres. Returns the actual snapped viewer position.', viewer.extend({
      position: z.strictObject({ frame: z.literal('mm'), value: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]) }),
    }), true],
    ['tab', 'Select an application tab by its reported ID.', viewer.extend({ tabId: z.string().min(1) }), true],
    ['regions', 'Read the regions exposed by the application viewer.', viewer, false],
    ['volumes', 'List the volumes loaded in a NiiVue viewer with their colormap, display range, opacity and dimensions.', viewer, false],
    ['display', 'Set the slice type and per-volume colormap, display range (calMin, calMax), opacity or visibility. Returns the resulting state and volumes.', viewer.extend({
      sliceType: z.enum(['axial', 'coronal', 'sagittal', 'multiplanar', 'render']).optional(),
      volumes: z.array(volumeDisplay).optional(),
    }), true],
    ['screenshot', 'Capture the viewer as a PNG image exactly as it is displayed.', viewer, false],
  ]) {
    registerTool(server, `viewers_${name}`, description, schema, mutates ? { ...startsRun, idempotentHint: true } : readOnly,
      async ({ sessionId, ...args }) => {
        const value = await service.viewerCommand(sessionId, `viewers.${name}`, args);
        return name === 'list' ? { viewers: value } : name === 'regions' ? { regions: value } : name === 'volumes' ? { volumes: value } : value;
      }, name === 'screenshot' ? imageResult : result);
  }

  for (const contract of await service.listApps()) {
    registerTool(server, `run_${contract.app.replaceAll('-', '_')}`,
      `Start ${contract.title}. ${contract.description} Returns a run ID; use runs_get for completion.`,
      requestSchema(contract), startsRun, request => service.start(contract.app, request));
    if (contract.schemaVersion === 2) {
      for (const [name, operation] of Object.entries(contract.operations)) {
        if (name === contract.defaultOperation) continue;
        registerTool(server, `run_${contract.app.replaceAll('-', '_')}__${name.replaceAll('-', '_')}`,
          `Start ${operation.title}. ${operation.description} Returns a run ID; use runs_get for completion.`,
          requestSchema(contract, name), startsRun, request => service.start(contract.app, request));
      }
    }
  }

  // nv-mcp's NiiVue tools, answered by retained viewers through the bridge; each session is one nv-mcp tab.
  if (niivue) registerCoreTools(server, toolContext(niivue.bridge));

  for (const resource of [
    { name: 'run-report', template: 'neurodesk://runs/{runId}/report', pattern: /^neurodesk:\/\/runs\/[^/]+\/report$/, mimeType: 'application/json' },
    { name: 'run-artifact', template: 'neurodesk://runs/{runId}/artifacts/{artifactId}', pattern: /^neurodesk:\/\/runs\/[^/]+\/artifacts\/[^/]+$/ },
  ]) {
    server.registerResource(resource.name, new ResourceTemplate(resource.template, {
      list: async () => ({ resources: (await service.listResources()).filter(entry => resource.pattern.test(entry.uri)) }),
    }), resource.mimeType ? { mimeType: resource.mimeType } : {},
    async uri => ({ contents: await service.readResource(uri.href) }));
  }
  return server;
}

export function serveMcp(service, options) {
  const transport = new StdioServerTransport();
  const niivue = createNiivueBridge(service);
  const handle = serveStdio(() => createMcpServer(service, { ...options, niivue }), {
    transport,
    onerror: error => console.error(`MCP: ${error.message}`),
  });
  let closing;
  const closeService = () => closing ??= Promise.resolve().then(() => {
    niivue.close();
    return service.close();
  });
  const onclose = transport.onclose;
  transport.onclose = () => {
    onclose();
    void closeService().catch(error => console.error(`MCP shutdown: ${error.message}`));
  };
  return {
    async close() {
      try {
        await handle.close();
      } finally {
        await closeService();
      }
    },
  };
}
