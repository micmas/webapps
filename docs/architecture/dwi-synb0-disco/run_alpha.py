"""Diagnostic: PyHySCO 0.0.4 on the synthetic pair with a chosen alpha.

Usage: run_alpha.py <run-dir> <alpha> <out-dir>

Image 1 is b0_d_smooth, image 2 the synthetic b0_u, as for synb0-sdc. The
symmetric solver regularizes the half field b = F / 2, so alpha |grad b|^2 is
(alpha / 4) |grad F|^2: alpha 1200 gives the full field the smoothness that
alpha 300 gives a reverse-PE pair. Same settings as
dwi-reverse-pe-options/run_pyhysco.py otherwise (CPU, 8 threads).
"""

import json
import sys

import torch
from EPI_MRI.EPIMRIDistortionCorrection import *
from optimization.GaussNewton import *

run, alpha, out = sys.argv[1:]
with open(f"{run}/prep/prep.json") as f:
    pe = json.load(f)["ap"]["pe"]
dim = "ijk".index(pe[0]) + 1
torch.set_num_threads(8)
data = DataObject(
    f"{run}/synb0/OUTPUTS/b0_d_smooth.nii.gz",
    f"{run}/synb0/OUTPUTS/b0_u.nii.gz",
    dim,
    device="cpu",
    dtype=torch.float32,
)
loss = EPIMRIDistortionCorrection(
    data,
    alpha=float(alpha),
    beta=1e-4,
    averaging_operator=myAvg1D,
    derivative_operator=myDiff1D,
    regularizer=myLaplacian3D,
    rho=0.0,
    PC=JacobiCG,
)
b0 = loss.initialize(blur_result=True)
opt = GaussNewton(loss, max_iter=50, verbose=True, path=f"{out}/pyhysco")
opt.run_correction(b0)
opt.apply_correction(method="jac")
