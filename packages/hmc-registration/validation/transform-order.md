# Native and WASM transform-list order

The independent check for [#566](https://github.com/neurodesk/webapps/issues/566)
reproduces the native/WASM command-order difference. The kernel's existing
sampling-point composition is unchanged; its former claim to use the same
command-line order as native ANTs was incorrect.

`--apply ... rot.mat trans.mat` samples the moving image at `R(T(p))`, where `p`
is an output-grid point. Native `antsApplyTransforms ... -t trans.mat -t rot.mat`
produces the same samples. Native's other list order samples at `T(R(p))`.
This is about the output-to-input pull map. The apparent motion of image content
uses its inverse, which can make verbal descriptions of order ambiguous.

## Independent controls

The existing asymmetric 32³, 2 mm Gaussian fixture is reused, with SHA-256
`6c8ecd87774849a85c37097119aac1fe2de0677de09cfffbfc860fd5ecbbdf6b`.
The transforms are a 30° rotation about LPS z and an 8 mm translation along LPS x,
with centre (0,0,0). Both hosts use linear interpolation, zero fill, double
transform/interpolation arithmetic and float32 output. Analytical single-affine
controls distinguish `R(T(p))`, `T(R(p))` and `R(inverseT(p))` independently of
either host's list parser.

| WASM positional list | Equal native `-t` list | Differing voxels with the same native list | Maximum absolute voxel difference with the same list |
| --- | --- | ---: | ---: |
| `rot.mat trans.mat` | `trans.mat rot.mat` | 18,484 | 336.42828369140625 |
| `trans.mat rot.mat` | `rot.mat trans.mat` | 18,484 | 336.42828369140625 |
| `rot.mat inverse:trans.mat` | `[trans.mat,1] rot.mat` | 17,844 | 333.29205322265625 |

Every reversed-list comparison has zero differing voxels and maximum difference
zero. Every analytical single-affine control also matches exactly, including the
native single-transform control. These results resolve the affine order question
without the reporter's phantom. They do not revalidate the reporter's nonlinear
registration or establish registration accuracy.

The committed WASM SHA-256 was
`d552ee295d79cd1722ced2c13c58d9afa0a5008275bbe70593d8caf9243de9ef`.
The independent native entry was `ants.internal.get_lib_fn('antsApplyTransforms')`
from `antspyx==0.6.1`, shared-library SHA-256
`ab1b41abd0d807daef9c9c910f7f2b947142cbc4fb2ec918d26f87b19fdacc7e`.
The exact argv list is passed directly to that C++ entry, without the high-level
Python transform-list wrapper. This is an independently installed native build;
its ANTs commit is not asserted to equal the WASM build's source pin.

## Reproduce

Provide a Python environment containing `antspyx==0.6.1`, then run:

```bash
node packages/hmc-registration/validation/transform-order.mjs \
  "$TMPDIR/hmc-transform-order-new" /path/to/python
node --test packages/hmc-registration/test/transform-order.test.js
```

The output directory must be new. The oracle saves every generated transform,
WASM/native output, native library identity and exact native argv in `native.json`;
`comparison.json` records every comparison and decoded voxel hash. The small
checked-in `transform-order-reference.json` retains those identities and voxel
hashes, allowing the ordinary Node regression to run without Python or native
ANTs. No generated images or external binary are committed.
