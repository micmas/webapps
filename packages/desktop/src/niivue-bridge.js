import { Bridge } from '@niivue/nv-mcp/server';
import { addressesIn, grantSources, refuseCredentials, sourceOf } from './source-approval.js';

// Above a 30 s approval wait plus the session's own 30 s command limit, so a stalled page is reported by the
// session, which also closes it.
const callTimeoutMs = 65000;

/**
 * Presents each retained NiiVue viewer to nv-mcp's bridge as a tab named by its session ID. nv-mcp's tools then reach
 * the page through the session queue, keeping its serialization, timeout and window scoping.
 */
export function createNiivueBridge(service, { log = message => console.error(message) } = {}) {
  const bridge = new Bridge({
    timeoutMs: callTimeoutMs,
    noTabHint: 'No NiiVue viewer is retained. Start a run with retainViewer: true, wait for it to succeed, then call list_tabs.',
  });
  const sockets = new Map();
  const live = new Set();

  async function answer(sessionId, viewerId, socket, { id, method, params }) {
    let response;
    try {
      // Composite the window rather than read the canvas: these apps do not keep their WebGL drawing buffer.
      if (method === 'screenshot') {
        const result = await service.viewerCommand(sessionId, 'viewers.screenshot', { viewerId });
        const { state } = await service.viewerCommand(sessionId, 'viewers.niivue', { viewerId });
        response = { id, result, state };
      } else {
        // Every address is checked before any is put to a person, so no password reaches a dialog, a record or the page.
        for (const address of addressesIn(params ?? {})) refuseCredentials(address);
        // A source the run was not given is loaded only once a person approves it, and then by the address granted.
        const granted = await grantSources(params ?? {}, async value => {
          const source = sourceOf(value);
          return source ? (await service.grantSource(sessionId, source)).url : value;
        });
        const { result, state } = await service.viewerCommand(sessionId, 'viewers.niivue', { viewerId, method, params: granted });
        response = { id, result, state };
      }
    } catch (error) {
      response = { id, error: String(error?.message ?? error) };
    }
    if (sockets.get(sessionId) === socket) bridge.receive(socket, JSON.stringify(response));
  }

  async function attach({ id: sessionId, app }) {
    if (sockets.has(sessionId)) return;
    const viewers = await service.viewerCommand(sessionId, 'viewers.list', {});
    const viewer = viewers.find(entry => entry.id === 'main' && entry.capabilities.niivue)
      ?? viewers.find(entry => entry.capabilities.niivue);
    if (!viewer) return;
    const { state } = await service.viewerCommand(sessionId, 'viewers.niivue', { viewerId: viewer.id });
    if (!live.has(sessionId)) return;
    const socket = {
      send(text) {
        const message = JSON.parse(text);
        if (typeof message.method === 'string') void answer(sessionId, viewer.id, socket, message);
      },
    };
    sockets.set(sessionId, socket);
    bridge.attach(socket);
    bridge.receive(socket, JSON.stringify({ hello: { id: sessionId, title: app, url: `neurodesk://sessions/${sessionId}`, state } }));
  }

  function detach(sessionId) {
    const socket = sockets.get(sessionId);
    if (!socket) return;
    sockets.delete(sessionId);
    bridge.detach(socket);
  }

  const unwatch = service.watchSessions(event => {
    if (event.type === 'closed') {
      live.delete(event.id);
      detach(event.id);
    } else if (event.type === 'ready') {
      live.add(event.session.id);
      attach(event.session).catch(error => log(`NiiVue bridge: session ${event.session.id}: ${error.message}`));
    }
  });
  return {
    bridge,
    close() {
      unwatch();
      live.clear();
      for (const sessionId of [...sockets.keys()]) detach(sessionId);
    },
  };
}
