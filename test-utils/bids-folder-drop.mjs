// A small BIDS dataset made from an app's pinned diffusion example, dropped on the page the way a
// browser delivers a dropped folder: directory entries that the shared page drop walks.

/** A pinned example file's bytes. The request context bypasses page routes, so this is the network copy. */
export async function pinnedBytes(request, url) {
  const response = await request.get(url);
  if (!response.ok()) throw new Error(`${url}: HTTP ${response.status()}`);
  return response.body();
}

/**
 * `{ path: bytes }` for a dataset `ds` with one subject and `runs` DWI runs, each a copy of the
 * example's image, bval and bvec. The root `dwi.json` applies to every run (BIDS inheritance);
 * each run also has its own sidecar, the example's when it has one, with `RunSidecar` set to the run.
 */
export async function exampleBidsTree(request, example, { runs = 1, inherited = { InheritedField: 'ds/dwi.json' } } = {}) {
  const pinned = async role => {
    const file = example.files.find(entry => entry.role === role);
    return file ? pinnedBytes(request, file.url) : null;
  };
  const [image, bval, bvec, sidecar] = await Promise.all(['image', 'bval', 'bvec', 'sidecar'].map(pinned));
  const own = sidecar ? JSON.parse(sidecar.toString('utf8')) : {};
  const tree = {
    'ds/dataset_description.json': Buffer.from(JSON.stringify({ Name: 'BIDS input test', BIDSVersion: '1.10.0' })),
    'ds/dwi.json': Buffer.from(JSON.stringify(inherited)),
  };
  for (let run = 1; run <= runs; run++) {
    const stem = runs > 1 ? `ds/sub-01/dwi/sub-01_run-${run}_dwi` : 'ds/sub-01/dwi/sub-01_dwi';
    tree[`${stem}.nii.gz`] = image;
    tree[`${stem}.bval`] = bval;
    tree[`${stem}.bvec`] = bvec;
    tree[`${stem}.json`] = Buffer.from(JSON.stringify({ ...own, RunSidecar: run }));
  }
  return tree;
}

/**
 * `{ path: bytes }` for a dataset `ds` whose subject has `runs` copies of one series, given as
 * `{ name, buffer }` files (image, bval, bvec) whose names end in `_dwi` and their extension.
 */
export function bidsTree(files, runs = 2) {
  const tree = {};
  for (let run = 1; run <= runs; run++) {
    for (const file of files) tree[`ds/sub-01/dwi/sub-01_run-${run}${file.name.slice(file.name.indexOf('_dwi'))}`] = file.buffer;
  }
  return tree;
}

/** Drop the `{ path: bytes }` tree on the page as one dropped folder (its first path segment). */
export async function dropFolder(page, tree) {
  const handle = await page.evaluateHandle(() => ({}));
  for (const [path, bytes] of Object.entries(tree)) {
    // Large files go through a base64 string; an array of numbers would be far larger.
    await page.evaluate(({ files, path, data }) => {
      const binary = atob(data);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      files[path] = array;
    }, { files: handle, path, data: Buffer.from(bytes).toString('base64') });
  }
  await page.evaluate(files => {
    const directory = name => ({ isFile: false, isDirectory: true, name, children: new Map() });
    const root = directory('');
    for (const [path, bytes] of Object.entries(files)) {
      const segments = path.split('/');
      const name = segments.pop();
      let folder = root;
      for (const segment of segments) {
        if (!folder.children.has(segment)) folder.children.set(segment, directory(segment));
        folder = folder.children.get(segment);
      }
      folder.children.set(name, { isFile: true, isDirectory: false, name, file: callback => callback(new File([bytes], name)) });
    }
    const asEntry = node => {
      if (node.isFile) return node;
      let read = false;
      const children = [...node.children.values()].map(asEntry);
      return {
        isFile: false,
        isDirectory: true,
        name: node.name,
        createReader: () => ({
          readEntries: callback => {
            const batch = read ? [] : children;
            read = true;
            callback(batch);
          },
        }),
      };
    };
    const items = [...root.children.values()].map(node => ({ kind: 'file', webkitGetAsEntry: () => asEntry(node), getAsFile: () => null }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], items, files: [] } });
    document.body.dispatchEvent(event);
  }, handle);
  await handle.dispose();
}
