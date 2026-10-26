"""Export one Synb0-DisCo fold to ONNX and check it against PyTorch.

Usage: export_onnx.py <Synb0-DISCO checkout> <fold 1-5> <out.onnx> [--sample] [--keep-transpose]

--sample writes the random test input and the PyTorch output as raw float32
(<out>.input.f32, <out>.torch.f32) for ort_web_check.mjs. --keep-transpose
exports the network as it is, for the memory comparison.

The network is Synb0-DisCo's UNet3D(2, 1) (src/model.py) with the weights of
src/train_lin. Every stride-1 ConvTranspose3d becomes the equal Conv3d (kernel
flipped, input and output channels swapped, padding k - 1 - p): ONNX Runtime's
CPU ConvTranspose builds a column buffer of C_out * k^3 * voxels values, about
4.2 GB in float32 for dc2 at 80 x 96 x 80, which is more than WebAssembly
memory. The stride-2 layers stay ConvTranspose3d (k = 2, no overlap).

Input: (1, 2, 80, 80, 96) float32, Synb0-DisCo's torch order (1, C, z, x, y)
of the padded 2.5 mm atlas grid; channel 0 is the normalized distorted b0,
channel 1 the normalized T1w. Output: (1, 1, 80, 80, 96).
"""

import argparse
import glob
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn


def as_conv(layer):
    """The Conv3d equal to a stride-1 ConvTranspose3d."""
    k = layer.kernel_size[0]
    p = layer.padding[0]
    conv = nn.Conv3d(
        layer.in_channels,
        layer.out_channels,
        k,
        stride=1,
        padding=k - 1 - p,
        bias=layer.bias is not None,
    )
    with torch.no_grad():
        w = layer.weight.flip(2, 3, 4).transpose(0, 1).contiguous()
        conv.weight.copy_(w)
        if layer.bias is not None:
            conv.bias.copy_(layer.bias)
    return conv


def rewrite(module):
    for name, child in module.named_children():
        if isinstance(child, nn.ConvTranspose3d) and child.stride == (1, 1, 1):
            setattr(module, name, as_conv(child))
        else:
            rewrite(child)
    return module


def load(source, fold):
    sys.path.insert(0, str(Path(source) / "src"))
    from model import UNet3D

    pattern = str(
        Path(source)
        / "src"
        / "train_lin"
        / f"num_fold_{fold}_total_folds_5_seed_1_*_num_epoch_*.pth"
    )
    paths = glob.glob(pattern)
    if len(paths) != 1:
        raise SystemExit(f"expected one weight file for fold {fold}, found {paths}")
    model = UNet3D(2, 1)
    model.load_state_dict(torch.load(paths[0], map_location="cpu"))
    return model.eval(), Path(paths[0]).name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("fold", type=int)
    parser.add_argument("out")
    parser.add_argument("--sample", action="store_true")
    parser.add_argument("--keep-transpose", action="store_true")
    args = parser.parse_args()
    torch.manual_seed(0)
    model, weights = load(args.source, args.fold)
    original = model
    rewritten = load(args.source, args.fold)[0]
    if not args.keep_transpose:
        rewritten = rewrite(rewritten).eval()
    x = torch.rand(1, 2, 80, 80, 96) * 2 - 1
    with torch.no_grad():
        a = original(x)
        b = rewritten(x)
    print(f"{weights}: rewrite max |diff| {float((a - b).abs().max()):.3g}")
    model = rewritten
    sample = x
    torch.onnx.export(
        model,
        (sample,),
        args.out,
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        dynamo=False,
    )
    import onnxruntime as ort

    session = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    y = session.run(None, {"input": sample.numpy()})[0].astype(np.float32)
    ref = a.numpy()
    if args.sample:
        x.numpy().astype("<f4").tofile(args.out + ".input.f32")
        ref.astype("<f4").tofile(args.out + ".torch.f32")
    print(
        f"onnxruntime vs torch float32: max |diff| {np.abs(y - ref).max():.3g}, "
        f"output range {ref.min():.3g} to {ref.max():.3g}"
    )


if __name__ == "__main__":
    main()
