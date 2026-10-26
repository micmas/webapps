# @dipy/gpu-streamlines

Browser-native WebGPU streamline tracking for diffusion MRI, derived from GPUStreamlines' WebGPU Boot/OPDT implementation.

This package ships TypeScript source and WGSL shaders for Vite-compatible browser applications. It requires WebGPU subgroup support and is not a Node or Python package.

```ts
import {
  DEFAULT_PARAMS,
  assembleTrackingInputs,
  getTrackingDevice,
  loadSphere,
  seedsFromMask,
  trackStreamlines,
  writeTrx,
} from '@dipy/gpu-streamlines'
```

`assembleTrackingInputs` accepts a DWI NIfTI `File`, FA NIfTI `File`, bvals, bvecs, and a sphere. `trackStreamlines` returns voxel-space streamlines; use `writeTrx` to create a TRX file in RASMM space.

`loadSphere()` uses the bundled DIPY default sphere. Pass a URL only to use a custom sphere.
