// BISON assets in the browser, from their pinned URLs. Every file is checked against the
// manifest's size and sha256 (assets.js) and kept in the shared, content-addressed Cache Storage
// of fetchModel, so a later run does not download it again.
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { assetsFor, loadAssets } from './assets.js';

/**
 * The verified assets for `modes` ('t1', 't1-flair'), as a Map of manifest filename to bytes.
 * onProgress(message, fraction) reports each file and the fraction of all bytes received.
 * @param {{ modes: string[], onProgress?: Function, signal?: AbortSignal, fetch?: Function, cache?: string|object|null }} options
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function loadBrowserAssets({ modes, onProgress = () => {}, signal, fetch = globalThis.fetch, cache } = {}) {
  const assets = assetsFor(modes);
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  let done = 0;
  let message = '';
  const read = async (asset) => {
    signal?.throwIfAborted();
    let bytes;
    try {
      bytes = await fetchModel(
        { url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } },
        {
          fetch,
          signal,
          ...(cache === undefined ? {} : { cache }),
          requestFailureMessage: `${asset.filename} did not download.`,
          onProgress: ({ received }) => onProgress(message, (done + received) / total),
        },
      );
    } catch (error) {
      if (error?.name === 'AbortError' || error?.message?.startsWith(asset.filename)) throw error;
      throw new Error(`${asset.filename}: ${error?.message ?? error}`, { cause: error });
    }
    done += asset.bytes;
    return bytes;
  };
  return loadAssets(assets, {
    read,
    onProgress: (text) => {
      message = text;
      onProgress(text, done / total);
    },
  });
}
