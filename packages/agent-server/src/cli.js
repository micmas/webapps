#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultPort, hostedOrigin, startAgentServer } from './server.js';

const usage = `Usage: neurodesk-mcp [--port ${defaultPort}] [--allow-origin <origin>]...

Lets an AI agent on this computer view and control the Neurodesk webapp viewers
you connect with "Connect an agent". Pages on ${hostedOrigin} and on
localhost may connect; --allow-origin adds another page origin.`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(defaultPort) },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port must be a port number, not ${values.port}\n\n${usage}`);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = startAgentServer({ port, version, allowedOrigins: [hostedOrigin, ...values['allow-origin']] });
try {
  await server.listening;
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use, perhaps by another neurodesk-mcp or NiiVue MCP server. Choose another with --port and open the app with ?agent=<port>.` : error.message);
  process.exit(1);
}
console.error(`neurodesk-mcp ${version} on ${server.url}`);
console.error(`waiting for pages on ${server.appUrl}`);
console.error(`add it to Claude Code with: claude mcp add --transport http neurodesk ${server.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close().then(() => process.exit(0)));
