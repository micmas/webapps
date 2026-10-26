import { createElement } from '../core/dom.js';
import { bindInfoTooltips, renderInfoIcon } from './bindInfoTooltips.js';

/**
 * A toolbar row with a button that connects or disconnects the agent, beside short help. Where the connection stands
 * goes to `onStatus(message, error)`, the app's status bar, like any other live status.
 */
export function createAgentControl(connection, { document: doc = globalThis.document, onStatus = () => {} } = {}) {
  const button = createElement('button', { className: 'nd-btn nd-btn-sm', type: 'button', ownerDocument: doc });
  const row = createElement('div', { className: 'nd-viewer-toolbar', ownerDocument: doc }, [
    button,
    createElement('span', { className: 'nd-viewer-label', text: 'Lets an AI agent control this viewer.', ownerDocument: doc }),
    renderInfoIcon(`Connects to neurodesk-mcp on this computer, port ${connection.port}. Chrome asks to allow local network `
      + 'access first, Firefox connects directly, and Safari cannot connect.', { label: 'About connecting an agent' }, doc),
  ]);
  bindInfoTooltips(row);
  let reported;
  const report = (message, error = false) => {
    if (message === reported) return;
    reported = message;
    onStatus(message, error);
  };
  const show = ({ active, connected, id }) => {
    button.textContent = active ? 'Disconnect agent' : 'Connect an agent';
    button.setAttribute('aria-pressed', String(active));
    if (connected) report(`Agent connected. This viewer is tab ${id}.`);
    else if (active) report(`Waiting for neurodesk-mcp on port ${connection.port}, or for Chrome's local network prompt.`);
    else if (reported) report('Agent disconnected.');
  };
  connection.watch(show);
  button.addEventListener('click', () => {
    if (connection.status.active) connection.disconnect();
    else connection.connect().catch(error => report(error.message, true));
  });
  show(connection.status);
  return row;
}
