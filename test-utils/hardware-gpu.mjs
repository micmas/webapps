import assert from 'node:assert/strict';
import { isSoftwareAdapter } from '../packages/runtime-support/src/mindgrab/backend.js';

// Browser launch for WebGPU and WebGL2 tests. Playwright's default headless
// shell only ever gets SwiftShader, even on a Mac. Full Chromium in new headless
// mode reaches Metal on Apple silicon, including GitHub's free macOS runners
// (niivue/mono#199), and Vulkan on Linux. NEURODESK_HARDWARE_GPU=1 selects it;
// without the variable every suite keeps the SwiftShader adapter it has on Linux CI.
export const hardwareGpu = process.env.NEURODESK_HARDWARE_GPU === '1';

// --use-webgpu-adapter keeps WebGPU on SwiftShader on a Mac too, where Chromium
// would otherwise refuse the headless shell an adapter.
const SWIFTSHADER = ['--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'];

// On Linux, full Chromium gives WebGPU a Vulkan GPU (for example Mesa on Intel)
// only with both flags; with either flag alone its WebGPU adapter stays SwiftShader.
const LINUX_VULKAN = ['--enable-features=Vulkan', '--use-angle=vulkan'];

/** Chromium arguments for a hardware GPU run on `platform`. */
export function hardwareGpuArgs(platform = process.platform) {
  return ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', ...(platform === 'linux' ? LINUX_VULKAN : [])];
}

// Spread into a config's `use` or pass to `test.use()`.
export const gpuBrowser = hardwareGpu
  ? { channel: 'chromium', launchOptions: { args: hardwareGpuArgs() } }
  : { launchOptions: { args: ['--enable-unsafe-webgpu', ...SWIFTSHADER] } };

// Fails unless the page's WebGPU adapter is real hardware. When
// NEURODESK_HARDWARE_GPU_VENDOR is set (CI sets `apple`), the vendor must match.
export function assertHardwareAdapter(info, expectedVendor = process.env.NEURODESK_HARDWARE_GPU_VENDOR) {
  assert.ok(info, 'Hardware WebGPU requires an available adapter');
  assert.notEqual(info.isFallbackAdapter, true, 'A fallback adapter cannot validate hardware WebGPU');
  assert.ok(!isSoftwareAdapter(info), 'A software adapter cannot validate hardware WebGPU');
  if (expectedVendor?.trim()) {
    assert.equal(info.vendor.toLowerCase(), expectedVendor.trim().toLowerCase(),
      'Selected WebGPU adapter must match the runner GPU vendor');
  }
}

// Runs in the page: the adapter identity assertHardwareAdapter checks.
export async function readAdapterInfo(page) {
  return page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
    return { vendor, architecture, device, description, isFallbackAdapter: isFallbackAdapter ?? adapter.isFallbackAdapter };
  });
}
