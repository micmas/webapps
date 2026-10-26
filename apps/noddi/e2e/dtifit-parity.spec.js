// Both runtime adapters through their public entry points, comparing every downloaded byte
// after decompression, including the NIfTI headers and optional NODDI maps.
import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fit } from "@neurodesk/noddi/node";
import { syntheticDwi, syntheticMask } from "./fixtures.mjs";

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

for (const noddi of [false, true]) {
  test(`niimath dtifit browser and command line write identical ${noddi ? "tensor and NODDI" : "tensor-only"} files`, async ({ context }) => {
    test.setTimeout(120000);
    const directory = await mkdtemp(join(tmpdir(), "noddi-dtifit-parity-"));
    try {
      const dwi = syntheticDwi({ direction: [1, -2, 3] });
      const files = {};
      for (const [role, file] of [["image", dwi.files[0]], ["bval", dwi.files[1]], ["bvec", dwi.files[2]], ["mask", syntheticMask({ value: 1 })]]) {
        const path = join(directory, file.name);
        await writeFile(path, file.buffer);
        files[role] = path;
      }
      const cli = await fit({ dwi: files.image, bval: files.bval, bvec: files.bvec, output: join(directory, "cli"), maskFile: files.mask, tensorFit: "niimath-dtifit", noddi, threads: 2 });
      expect(cli.provenance.tensorFit).toBe("niimath-dtifit");
      expect(cli.provenance.niimath).toMatch(/^\d+\.\d+\.\S+$/);
      expect(cli.files).toHaveLength(noddi ? 11 : 7);
      const downloaded = new Set();
      const names = new Set();
      // Chromium permits ten scripted downloads in one tab, so eleven outputs take two runs.
      while (downloaded.size < cli.files.length) {
        const page = await context.newPage();
        await page.goto("/");
        for (const [role, path] of Object.entries(files)) {
          await page.locator("#neurodesk-input-transfer").setInputFiles(path);
          await dispatch(page, "adopt", { role });
        }
        await dispatch(page, "start", { operation: "fit", parameters: { tensorFit: "niimath-dtifit", noddi } });
        await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 60000 }).not.toBe("running");
        const snapshot = await dispatch(page, "snapshot");
        expect(snapshot.state, JSON.stringify(snapshot.error)).toBe("succeeded");
        expect(snapshot.report.provenance.tensorFit).toBe("niimath-dtifit");
        expect(snapshot.report.provenance.niimath).toBe(cli.provenance.niimath);
        const pending = Object.keys(snapshot.report.artifacts).filter((role) => !downloaded.has(role));
        for (const role of pending.slice(0, 10)) {
          const downloading = page.waitForEvent("download");
          await dispatch(page, "download", { artifactId: role });
          const download = await downloading;
          expect(cli.files).toContain(download.suggestedFilename());
          const [browserBytes, cliBytes] = await Promise.all([readFile(await download.path()), readFile(join(cli.output, download.suggestedFilename()))]);
          expect(gunzipSync(browserBytes).equals(gunzipSync(cliBytes)), role).toBe(true);
          downloaded.add(role);
          names.add(download.suggestedFilename());
        }
        await page.close();
      }
      expect([...names].sort()).toEqual([...cli.files].sort());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
