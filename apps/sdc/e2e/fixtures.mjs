// A synthetic reverse phase-encoding pair: Gaussian bumps along j, shifted by +shift mm in the
// first image and -shift mm in the second, so the field is about shift / voxel / TRT Hz.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

export const TRT = 0.05;

function bumps([nx, ny, nz], frames, shift) {
  const voxels = nx * ny * nz;
  const out = new Float32Array(voxels * frames);
  for (let f = 0; f < frames; f++) {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const centre = ny + 2 * Math.sin(x - 4) + z;
          const position = (y + 0.5) * 2 - shift;
          out[f * voxels + x + nx * (y + ny * z)] = 100 * Math.exp(-(((position - centre) / 6) ** 2)) + 5;
        }
      }
    }
  }
  return out;
}

function nifti(dims, frames, shift) {
  const all = frames > 1 ? [4, ...dims, frames, 1, 1, 1] : [3, ...dims, 1, 1, 1, 1];
  const header = createNiftiHeaderFromVolume({ hdr: { dims: all, pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine: [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]] } });
  return gzipSync(Buffer.from(createNiftiFromData(bumps(dims, frames, shift), header, { dims: frames > 1 ? [...dims, frames] : dims })));
}

const json = (value) => Buffer.from(JSON.stringify(value));

/** Files for setInputFiles: an AP DWI series (two b = 0 volumes and one b = 1000) and a PA EPI. */
export function syntheticPair({ dims = [8, 40, 4], dims2 = dims, shift = 3, pe = ["j-", "j"] } = {}) {
  return [
    { name: "sub-01_dir-AP_dwi.nii.gz", mimeType: "application/gzip", buffer: nifti(dims, 3, shift) },
    { name: "sub-01_dir-AP_dwi.json", mimeType: "application/json", buffer: json({ PhaseEncodingDirection: pe[0], TotalReadoutTime: TRT }) },
    { name: "sub-01_dir-AP_dwi.bval", mimeType: "text/plain", buffer: Buffer.from("0 0 1000") },
    { name: "sub-01_dir-PA_epi.nii.gz", mimeType: "application/gzip", buffer: nifti(dims2, 1, -shift) },
    { name: "sub-01_dir-PA_epi.json", mimeType: "application/json", buffer: json({ PhaseEncodingDirection: pe[1], TotalReadoutTime: TRT }) },
  ];
}

/**
 * Serves the example (and the native reference field) from SDC_EXAMPLE_DIR when it is set, for
 * runs before the files are on Hugging Face; otherwise the requests go to the pinned URLs.
 */
export async function routeExample(context, urls) {
  const dir = process.env.SDC_EXAMPLE_DIR;
  if (!dir) return;
  for (const url of urls) {
    const name = url.split("/").pop();
    await context.route(url, (route) => route.fulfill({ body: readFileSync(`${dir}/${name}`) }));
  }
}

/** A pinned file's bytes, from SDC_EXAMPLE_DIR when it is set (request contexts bypass routes). */
export async function pinnedBytes(request, url) {
  const dir = process.env.SDC_EXAMPLE_DIR;
  if (dir) return readFileSync(`${dir}/${url.split("/").pop()}`);
  const response = await request.get(url);
  if (!response.ok()) throw new Error(`${url}: HTTP ${response.status()}`);
  return response.body();
}


/** Adopt the two images and their acquisition data through the automation contract. */
export async function adoptPair(page, files = syntheticPair()) {
  for (const [role, index] of [["image1", 0], ["sidecar1", 1], ["bval1", 2], ["image2", 3], ["sidecar2", 4]]) {
    const file = files[index];
    await page.locator("#neurodesk-input-transfer").setInputFiles(role.startsWith("sidecar") ? { ...file, name: `${role}.json` } : file);
    await page.evaluate(role => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
}
