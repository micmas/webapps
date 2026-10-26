// Runs one production build of dwidenoise in headless Chromium on one input and reports the
// peak memory of the browser processes and the longest main-thread task during the denoise
// step, and the sha256 of the uncompressed denoised NIfTI. Linux only: it reads /proc.
// packages/dwidenoise/README.md ("Memory and responsiveness of the app") holds the results.
//
//   node validation/measure-run.mjs DIST OUTDIR fixture
//   node validation/measure-run.mjs DIST OUTDIR IMAGE.nii.gz IMAGE.bval [IMAGE.bvec IMAGE.json]
//
// DIST is a `vite build` output of this app (for example the build of another commit), OUTDIR
// receives the downloaded image and a JSON summary, and PORT (default 4180) is the preview port.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { dwiSeries } from "../e2e/fixtures.mjs";

const [dist, outDir, ...inputArgs] = process.argv.slice(2);
if (!dist || !outDir || !inputArgs.length) {
  console.error("Usage: node validation/measure-run.mjs DIST OUTDIR fixture|IMAGE.nii.gz IMAGE.bval [...]");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 4180);
const app = fileURLToPath(new URL("..", import.meta.url));
const inputs = inputArgs[0] === "fixture" ? dwiSeries().files : inputArgs;
const name = inputArgs[0] === "fixture" ? "fixture" : "input";
mkdirSync(outDir, { recursive: true });

const server = spawn("pnpm", ["exec", "vite", "preview", "--outDir", dist, "--port", String(port), "--strictPort"], {
  cwd: app,
  env: { ...process.env, BROWSER: "none" },
  stdio: "ignore",
  detached: true,
});
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(`http://localhost:${port}/`)).ok) break;
  } catch {
    // The preview server is not listening yet.
  }
  if (attempt > 100) throw new Error("The preview server did not start.");
  await sleep(200);
}

/** The process `root` and all its descendants. */
function descendants(root) {
  const parents = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // The process ended.
    }
  }
  const found = [root];
  for (let i = 0; i < found.length; i++) {
    for (const [pid, ppid] of parents) {
      if (ppid === found[i]) found.push(pid);
    }
  }
  return found;
}

function processType(pid) {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.match(/--type=([a-z-]+)/)?.[1] ?? "browser";
  } catch {
    return "gone";
  }
}

/** A /proc/<pid>/status field in bytes (VmRSS, VmHWM). */
function statusBytes(pid, key) {
  try {
    const line = readFileSync(`/proc/${pid}/status`, "utf8")
      .split("\n")
      .find((row) => row.startsWith(key));
    return line ? Number(line.split(/\s+/)[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

const totalRss = (pids) => pids.reduce((sum, pid) => sum + statusBytes(pid, "VmRSS"), 0);

const browserServer = await chromium.launchServer();
const root = browserServer.process().pid;
const browser = await chromium.connect(browserServer.wsEndpoint());
const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
await page.addInitScript(() => {
  window.__measuring = false;
  window.__longestTask = 0;
  window.__longestFrameGap = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (window.__measuring) window.__longestTask = Math.max(window.__longestTask, entry.duration);
    }
  }).observe({ type: "longtask", buffered: false });
  let last = performance.now();
  const frame = (now) => {
    if (window.__measuring) window.__longestFrameGap = Math.max(window.__longestFrameGap, now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
await page.goto(`http://localhost:${port}/`);
await page.locator("#imageInput").setInputFiles(inputs);
await page.waitForFunction(() => !document.getElementById("runButton").disabled, null, { timeout: 300000 });
await sleep(1000);

// Reset the peak RSS of each process, so that VmHWM gives the peak of the denoise step only.
for (const pid of descendants(root)) {
  try {
    writeFileSync(`/proc/${pid}/clear_refs`, "5");
  } catch {
    // Not every process can be reset; its peak then includes the load.
  }
}
let sampledPeak = 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    sampledPeak = Math.max(sampledPeak, totalRss(descendants(root)));
    await sleep(25);
  }
})();
await page.evaluate(() => {
  window.__measuring = true;
});
const started = Date.now();
await page.locator("#runButton").click();
await page.waitForFunction(() => /^Denoised \d+ volumes$/.test(document.getElementById("statusText").textContent), null, {
  timeout: 1800000,
});
const seconds = (Date.now() - started) / 1000;
const responsiveness = await page.evaluate(() => {
  window.__measuring = false;
  return { longestTaskMs: Math.round(window.__longestTask), longestFrameGapMs: Math.round(window.__longestFrameGap) };
});
sampling = false;
await sampler;
const peaks = {};
for (const pid of descendants(root)) {
  const type = processType(pid);
  peaks[type] = Math.max(peaks[type] ?? 0, statusBytes(pid, "VmHWM"));
}

const downloaded = page.waitForEvent("download");
await page
  .locator("#resultList .nd-volume-toggle")
  .filter({ hasText: "Denoised image" })
  .getByRole("button", { name: "Download" })
  .click();
const imagePath = `${outDir}/${name}.denoised.nii.gz`;
await (await downloaded).saveAs(imagePath);
const nifti = gunzipSync(readFileSync(imagePath));
const megabytes = (bytes) => Math.round(bytes / 1e6);
const result = {
  dist,
  inputs: inputs.map((input) => (typeof input === "string" ? input : input.name)),
  seconds,
  sha256: createHash("sha256").update(nifti).digest("hex"),
  ...responsiveness,
  peakRssMBByProcessType: Object.fromEntries(Object.entries(peaks).map(([type, bytes]) => [type, megabytes(bytes)])),
  peakSampledTotalRssMB: megabytes(sampledPeak),
};
console.log(JSON.stringify(result));
writeFileSync(`${outDir}/${name}.json`, `${JSON.stringify(result, null, 2)}\n`);
await browser.close();
await browserServer.close();
process.kill(-server.pid);
