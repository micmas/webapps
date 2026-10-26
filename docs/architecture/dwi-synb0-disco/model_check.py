"""Check the exported ONNX folds against Synb0-DisCo's own inference on real inputs.

Usage: model_check.py <synb0 OUTPUTS dir> <dir with fold1.onnx ... fold5.onnx> <out.json>

For each fold this prepares the input as Synb0-DisCo's inference.py does (pad
(77, 91, 77) to (80, 96, 80), torch order (1, C, z, x, y), T1w scaled from
[0, 150] and the b0 from [0, its 99th percentile] to [-1, 1]), runs ONNX
Runtime (CPU), undoes the scaling and the padding, and compares the result with
b0_u_lin_atlas_2_5_FOLD_<i>.nii.gz from the native run. The ensemble mean is
compared with b0_u_lin_atlas_2_5.nii.gz. Differences are in b0 intensity units
and relative to the b0's 99th percentile. Also writes <dir>/fold<i>.real.input.f32
and .torch.f32 (the native fold output in network units) for ort_web_check.mjs.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np
import onnxruntime as ort

PAD = ((2, 1), (3, 2), (2, 1))


def volume(path):
    """A 3D volume; Synb0-DisCo writes its outputs with a trailing length-1 axis."""
    data = nb.load(path).get_fdata()
    return data.reshape(data.shape[:3])


def to_torch(img):
    return np.transpose(np.pad(img, PAD), (2, 0, 1))[None, None]


def from_torch(out):
    vol = np.transpose(out[0, 0], (1, 2, 0))
    return vol[2:-1, 3:-2, 2:-1]


def scale(img, top):
    return img / top * 2.0 - 1.0


def unscale(img, top):
    return (img + 1.0) / 2.0 * top


def main(outputs, onnx_dir, out_json):
    outputs = Path(outputs)
    onnx_dir = Path(onnx_dir)
    t1 = volume(outputs / "T1_norm_lin_atlas_2_5.nii.gz")
    b0 = volume(outputs / "b0_d_lin_atlas_2_5.nii.gz")
    padded_b0 = np.pad(b0, PAD)
    top = float(np.percentile(padded_b0, 99))
    x = np.concatenate([scale(to_torch(b0), top), scale(to_torch(t1), 150.0)], axis=1)
    x = x.astype(np.float32)
    report = {"b0_p99": top, "folds": []}
    preds = []
    for fold in range(1, 6):
        session = ort.InferenceSession(
            str(onnx_dir / f"fold{fold}.onnx"), providers=["CPUExecutionProvider"]
        )
        y = session.run(None, {"input": x})[0]
        pred = unscale(from_torch(y.astype(np.float64)), top)
        native = volume(outputs / f"b0_u_lin_atlas_2_5_FOLD_{fold}.nii.gz")
        diff = np.abs(pred - native)
        report["folds"].append(
            {
                "fold": fold,
                "max_abs": float(diff.max()),
                "max_rel_p99": float(diff.max() / top),
                "mean_abs": float(diff.mean()),
            }
        )
        preds.append(pred)
        x.astype("<f4").tofile(onnx_dir / f"fold{fold}.real.input.f32")
        expected = np.pad(native, PAD)
        expected = scale(np.transpose(expected, (2, 0, 1))[None, None], top)
        # Padding voxels are not compared by Synb0-DisCo; take ORT's own values there.
        mask = np.zeros(expected.shape, bool)
        mask[:, :, 2:-1, 2:-1, 3:-2] = True
        expected = np.where(mask, expected, y)
        expected.astype("<f4").tofile(onnx_dir / f"fold{fold}.real.torch.f32")
    mean = np.mean(preds, axis=0)
    native_mean = volume(outputs / "b0_u_lin_atlas_2_5.nii.gz")
    diff = np.abs(mean - native_mean)
    report["ensemble"] = {
        "max_abs": float(diff.max()),
        "max_rel_p99": float(diff.max() / top),
        "mean_abs": float(diff.mean()),
    }
    Path(out_json).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
