import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceGrants } from './source-grants.js';

// A page in an app, as far as reading an address goes: plain http, below the root of its server.
const page = 'http://viewer.invalid/app/';

function nativeWindowsPath(value) {
  // Only canonical backslash paths: URL parsers also accept mixed/protocol-relative slashes.
  if (value.includes('/') || Array.from(value).some(character => character.charCodeAt(0) < 32)) return false;
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) return true;
  // WebDAV's native server syntax is server[@SSL][@port], not URL user information.
  // https://learn.microsoft.com/en-us/windows/win32/api/davclnt/nf-davclnt-davgethttpfromuncpath
  const unc = /^\\\\(?:\?\\UNC\\)?([a-z0-9_.-]+)(?:@(SSL))?(?:@([0-9]+))?\\[^\\]+(?:\\|$)/i.exec(value);
  if (!unc || (!/^\\\\\?\\UNC\\/i.test(value) && !unc[2] && !unc[3])) return false;
  return !unc[3] || (Number(unc[3]) > 0 && Number(unc[3]) <= 65535);
}

/** Whether a relative address climbs into the local server's mounts, wherever in the app the page sits. */
function reachesMounts(value) {
  try {
    return decodeURIComponent(new URL(value, page).pathname).startsWith('/_local/');
  } catch {
    return false;
  }
}

/**
 * Refuses an address the page would send with a user name or password, however it is written: //user:password@host
 * and \\user:password@host name a host as much as http://user:password@host does. An address the page cannot read
 * at all is refused when it has an @, which may end a password. The error never repeats the address.
 */
export function refuseCredentials(value, platform = process.platform) {
  // These sources are mounted as native files before the page ever receives their address.
  if (platform === 'win32' && nativeWindowsPath(value)) return;
  const address = URL.parse(value, page);
  if (address ? address.username || address.password : value.includes('@')) throw new Error('Source URLs must not contain credentials');
}

// The arguments of nv-mcp's tools that the page fetches: each source's url, a label table and a font's two files.
const addressKeys = new Set(['url', 'labels', 'atlas', 'metrics']);

/** Every address the page fetches in a tool's arguments, at any depth. */
export function addressesIn(value) {
  if (Array.isArray(value)) return value.flatMap(addressesIn);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    if (addressKeys.has(key) && typeof item === 'string') return [item];
    return addressesIn(item);
  });
}

/**
 * What a viewer is asked to load: a local file for an absolute path or file: URL, a remote address for http(s), the
 * address itself for a relative one into the local server's mounts, and nothing to approve for anything else (bundled
 * relative paths, data: and blob: URLs).
 */
export function sourceOf(value) {
  if (value.startsWith('file:')) return { path: fileURLToPath(value) };
  if (isAbsolute(value)) return { path: value };
  const url = URL.parse(value);
  if (!url) return reachesMounts(value) ? { url: value } : null;
  return ['http:', 'https:'].includes(url.protocol) ? { url: url.href } : null;
}

/** Replaces every loading address with what `grant` returns for it, one at a time. */
export async function grantSources(value, grant) {
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) items.push(await grantSources(item, grant));
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = addressKeys.has(key) && typeof item === 'string' ? await grant(item) : await grantSources(item, grant);
  }
  return result;
}

/**
 * Sources an unattended setup approves in advance: comma-separated absolute directories and http(s) URL prefixes.
 * Anything outside them still needs a person's approval.
 */
export function parseApprovedSources(value) {
  const directories = [];
  const urls = [];
  for (const entry of String(value || '').split(',').map(text => text.trim()).filter(Boolean)) {
    if (isAbsolute(entry)) directories.push(entry);
    else urls.push(entry);
  }
  const grants = createSourceGrants();
  try { grants.add(urls); } catch { throw new Error(`NEURODESK_APPROVED_SOURCES entries must be absolute directories or http(s) URLs: ${urls.join(', ')}`); }
  return {
    /** `file` must already be resolved with realpath. Directories resolve now, so they may be created after startup. */
    async permits({ file, url }) {
      if (url) return grants.permits(url);
      for (const entry of directories) {
        const directory = await realpath(entry).catch(() => null);
        const child = directory && relative(directory, file);
        if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return true;
      }
      return false;
    },
  };
}

/**
 * Decides whether one viewer may load a source, asking `ask` for anything neither its own server (`site`), its grants
 * nor the pre-approved sources cover. An approved URL joins the viewer's grants; an approved file is mounted on the
 * viewer's own server. Returns the address to load and how it was approved.
 */
export function createSourceGranter({ site, grants, approved, ask }) {
  const files = new Map();
  return async ({ path, url }, { base, signal }) => {
    if (url) {
      // Resolved against the viewer's page, as the page itself would resolve it.
      const address = new URL(url, base);
      if (address.origin === site.origin) {
        if (site.owns(address.href)) return { url, approval: 'existing' };
        throw new Error(`${url} is not granted to this viewer. Grant the file by its path.`);
      }
      if (grants.permits(address.href)) return { url, approval: 'existing' };
    }
    const file = path && await realpath(path).catch(() => { throw new Error(`No such file: ${path}`); });
    if (file && !(await stat(file)).isFile()) throw new Error(`Not a file: ${path}`);
    if (file && files.has(file)) return { url: files.get(file), approval: 'existing' };
    let approval = 'configured';
    if (!(await approved.permits({ file, url }))) {
      await ask(file ?? url, signal);
      approval = 'person';
    }
    if (url) {
      grants.add([url]);
      return { url, approval };
    }
    const mounted = await site.mountFile(file);
    files.set(file, mounted);
    return { url: mounted, approval };
  };
}
