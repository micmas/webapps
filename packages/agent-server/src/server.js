import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Bridge, buildServer } from '@niivue/nv-mcp/server';
import { WebSocketServer } from 'ws';

export const defaultPort = 4242;
/** Where the hosted Neurodesk webapps are served. Their pages may open the app socket. */
export const hostedOrigin = 'https://webapps.neurodesk.org';

const loopbackNames = ['localhost', '127.0.0.1', '[::1]'];

const instructions = [
  'Each tab is a Neurodesk webapp in a browser on this computer whose user chose "Connect an agent".',
  'The page loads volumes itself, so a load can only fetch an http(s) URL that allows the page to read it under CORS;',
  'a local path on this computer cannot be loaded. Files the user opened in the page are already listed in its state.',
].join(' ');

/**
 * Whether a page may open the app socket: a client that sends no Origin is not a browser; a page on a loopback name or
 * on this server's own host is local; anything else must be listed.
 */
export function originAllowed(origin, host, allowedOrigins) {
  if (origin === undefined || allowedOrigins.includes(origin)) return true;
  let hostname;
  try { hostname = new URL(origin).hostname; } catch { return false; }
  return loopbackNames.includes(hostname) || hostname === host;
}

/**
 * nv-mcp's server for Node: agents call `/mcp`, and pages that connected an agent hold the `/app` socket. It listens on
 * loopback only, so an agent on this computer reaches only the pages a person on this computer connected.
 */
export function startAgentServer({
  host = '127.0.0.1',
  port = defaultPort,
  allowedOrigins = [hostedOrigin],
  allowedHosts = [],
  version = '0.0.0',
  log = line => console.error(line),
} = {}) {
  const bridge = new Bridge({
    noTabHint: 'Open a Neurodesk webapp in Chrome or Firefox, open an image, and choose "Connect an agent".',
  });
  const hostNames = () => [...new Set([...[...loopbackNames, host].map(name => `${name}:${server.address().port}`), ...allowedHosts])];
  const sockets = new WebSocketServer({ noServer: true });

  async function mcp(req, res) {
    const agent = buildServer({ bridge, name: 'neurodesk', version, instructions });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hostNames(),
    });
    res.on('close', () => void agent.close());
    await agent.connect(transport);
    await transport.handleRequest(req, res);
  }

  function status(req, res) {
    if (!hostNames().includes(req.headers.host)) {
      log(`refused the status page to host ${req.headers.host}`);
      return send(res, 403, 'Forbidden host.');
    }
    const tabs = bridge.list();
    const lines = tabs.length ? tabs.map(tab => `  ${tab.bound ? '*' : ' '} ${tab.id}  ${tab.title}  ${tab.url}`) : ['  none'];
    send(res, 200, `neurodesk-mcp\nmcp endpoint: ${running.url}\napp socket: ${running.appUrl}\ntabs (* answers):\n${lines.join('\n')}\n`);
  }

  const server = createServer((req, res) => {
    const pathname = pathOf(req);
    if (pathname === '/mcp') {
      mcp(req, res).catch(error => {
        log(`mcp request failed: ${error.message}`);
        if (!res.headersSent) send(res, 500, 'Internal error.');
      });
    } else if (pathname === '/') status(req, res);
    else if (pathname === '/app') send(res, 426, 'Expected a WebSocket.');
    else send(res, 404, 'Not found.');
  });

  server.on('upgrade', (req, socket, head) => {
    // Node stops handling a socket's errors once it is upgraded, so a client that resets a refused socket would
    // otherwise end the process.
    socket.on('error', () => socket.destroy());
    const pathname = pathOf(req);
    const origin = req.headers.origin;
    if (pathname !== '/app') return refuse(socket, 404, 'Not Found');
    if (!originAllowed(origin, host, allowedOrigins)) {
      log(`refused a socket from ${origin}`);
      return refuse(socket, 403, 'Forbidden');
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const tab = { send: text => ws.send(text) };
      bridge.attach(tab);
      ws.on('message', (data, binary) => {
        if (binary) return;
        const before = bridge.list().length;
        bridge.receive(tab, data.toString());
        const tabs = bridge.list();
        if (tabs.length !== before) log(`tab connected: ${tabs.map(entry => `${entry.id} "${entry.title}"`).join(', ')}`);
      });
      // An invalid frame closes this socket; without a listener its error would end the process.
      ws.on('error', error => log(`socket error: ${error.message}`));
      ws.on('close', () => {
        const before = bridge.list().length;
        bridge.detach(tab);
        if (bridge.list().length !== before) log(`tab disconnected (${bridge.list().length} left)`);
      });
    });
  });

  const running = {
    bridge,
    host,
    get port() { return server.address().port; },
    get url() { return `http://${host}:${this.port}/mcp`; },
    get appUrl() { return `ws://${host}:${this.port}/app`; },
    listening: new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    }),
    close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
  return running;
}

/** The request's path, or null when its target is not a URL, which no route matches. */
function pathOf(req) {
  try { return new URL(req.url, 'http://localhost').pathname; } catch { return null; }
}

function send(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain' }).end(text);
}

// Closed once the answer is sent, as ws closes a handshake it refuses. Otherwise a client that never closes its side
// keeps the socket, and with it the server, open.
function refuse(socket, code, reason) {
  socket.once('finish', socket.destroy);
  socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
