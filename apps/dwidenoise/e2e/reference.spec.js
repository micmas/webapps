import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ROLES, compareWithBrowser, pinnedExamples, readReference, summarize, writeReference } from "../../../packages/dwidenoise/validation/reference.mjs";

// Runs every pinned example through the app itself (automation, Patch2Self workers, built assets)
// and compares each download with packages/dwidenoise/validation/browser-reference.json, which the
// command line's release check also uses. Runs only when DWIDENOISE_BROWSER_REFERENCE is "check" or
// "write" ("write" records the result).
const mode = process.env.DWIDENOISE_BROWSER_REFERENCE;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test("every pinned example matches the browser reference", async ({ page, browser }) => {
  test.skip(mode !== "check" && mode !== "write", "set DWIDENOISE_BROWSER_REFERENCE=check or write");
  test.setTimeout(10 * 60_000);
  const examples = await pinnedExamples();
  await page.goto("./");
  await expect(page.locator("#neurodesk-input-transfer")).toHaveCount(1);
  const inputs = {};
  const provenance = {};
  const outputs = {};
  const started = performance.now();
  for (const example of examples) {
    inputs[example.id] = Object.fromEntries(example.files.map((file) => [file.name, file.sha256]));
    const files = await Promise.all(example.files.map(async (file) => ({ name: file.name, mimeType: "application/octet-stream", buffer: await readFile(file.path) })));
    await page.locator("#neurodesk-input-transfer").setInputFiles(files);
    await dispatch(page, "adopt", { role: "image" });
    await dispatch(page, "start", { operation: "denoise" });
    await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 5 * 60_000, intervals: [500] }).not.toBe("running");
    const snapshot = await dispatch(page, "snapshot");
    expect(snapshot.state, `${example.id}: ${JSON.stringify(snapshot.error)}`).toBe("succeeded");
    provenance[example.id] = snapshot.report.provenance;
    outputs[example.id] = {};
    for (const role of ROLES.filter((role) => snapshot.report.artifacts[role])) {
      const downloaded = page.waitForEvent("download");
      await dispatch(page, "download", { artifactId: role });
      const download = await downloaded;
      outputs[example.id][role] = summarize(download.suggestedFilename(), await readFile(await download.path()));
    }
  }
  const { appVersion } = (await dispatch(page, "snapshot")).report;
  if (mode === "write") {
    await writeReference({
      inputs,
      browser: {
        path: "apps/dwidenoise/e2e/reference.spec.js: the app's denoise automation, Patch2Self workers, built assets",
        app: `dwidenoise ${appVersion}`,
        browser: `Chromium ${browser.version()}`,
        seconds: Math.round((performance.now() - started) / 1000),
        provenance,
        outputs,
      },
    });
    return;
  }
  const reference = await readReference();
  expect(reference.inputs).toEqual(inputs);
  const failures = [];
  for (const example of examples) {
    expect(provenance[example.id]).toEqual(reference.browser.provenance[example.id]);
    for (const role of ROLES) {
      const is = outputs[example.id][role];
      const was = reference.browser.outputs[example.id][role];
      if (!is && !was) continue;
      if (!is) {
        failures.push(`web app ${example.id} ${role}: not downloaded`);
        continue;
      }
      for (const [passed, line] of compareWithBrowser(`web app ${example.id} ${role}`, is, was)) {
        if (!passed) failures.push(line);
      }
    }
  }
  expect(failures).toEqual([]);
});
