"""Compare the sdc solver with topup when both get the Synb0-DisCo synthetic b0.

Usage: compare.py <run-dir>   (after run_all.sh's post.sh step; prints JSON)

Issue #508's comparison: the field from the sdc solver with the synthetic b0
(synb0-sdc, and synb0-sdc-raw with the unsmoothed b0) against topup with the
same synthetic b0 (synb0-topup, Synb0-DisCo's own pipeline). The field metrics
are the options document's: median absolute difference in its brain mask, the
same after the median offset is removed, and Pearson r. The image metrics
(metrics.json from evaluate.py and post.sh: AP-PA agreement with the real PA
b0, BBR cost against the T1w) are given as ratios to topup with the real
reverse-PE pair and to synb0-topup.

synthetic_fit is the mean |corrected b0 - synthetic b0| / mean synthetic b0
in the mask after the corrected b0 is scaled to the synthetic mean: how well
each field maps the distorted b0 onto the synthetic image it was fitted to.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np

sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent / "dwi-reverse-pe-options")
)
from correct import correct

AXES = "ijk"
SOLVER = ("synb0-sdc", "synb0-sdc-raw")
METHODS = ("uncorrected", "synb0-topup", *SOLVER, "topup")


def load(path):
    return np.asarray(nb.load(path).dataobj, np.float64)


def field_metrics(f, g, mask):
    d = f[mask] - g[mask]
    offset = float(np.median(d))
    return {
        "mad_hz": float(np.median(np.abs(d))),
        "offset_hz": offset,
        "mad_demeaned_hz": float(np.median(np.abs(d - offset))),
        # r is undefined for a constant field (the uncorrected baseline).
        "r": float(np.corrcoef(f[mask], g[mask])[0, 1])
        if np.std(f[mask]) > 0 and np.std(g[mask]) > 0
        else None,
    }


def synthetic_fit(image, field, synthetic, mask, meta, s):
    axis = AXES.index(meta["ap"]["pe"][0])
    v = -1.0 if meta["ap"]["pe"].endswith("-") else 1.0
    c = correct(image, field, meta["ap"]["trt"], v, axis, s)[mask]
    u = synthetic[mask]
    c = c / c.mean() * u.mean()
    return float(np.mean(np.abs(c - u)) / u.mean())


def main(run):
    run = Path(run)
    meta = json.loads((run / "prep" / "prep.json").read_text())
    s = json.loads((run / "calibration.json").read_text())["S"]
    mask = load(run / "mask" / "b0_mask.nii.gz") > 0.5
    # Diagnostic runs (run_alpha.py) are added when present.
    methods = METHODS + tuple(
        sorted(p.parent.name for p in run.glob("synb0-pyhysco*/metrics.json"))
    )
    fields = {m: load(run / m / "field_hz.nii.gz") for m in methods}
    metrics = {m: json.loads((run / m / "metrics.json").read_text()) for m in methods}
    synthetic = load(run / "synb0" / "OUTPUTS" / "b0_u.nii.gz")
    smooth = load(run / "synb0" / "OUTPUTS" / "b0_d_smooth.nii.gz")
    raw = load(run / "prep" / "ap_mean.nii.gz")
    out = {"subject": run.name, "methods": {}}
    for m in methods:
        row = {
            "vs_synb0_topup": field_metrics(fields[m], fields["synb0-topup"], mask),
            "vs_topup": field_metrics(fields[m], fields["topup"], mask),
            "appa_mad": metrics[m]["appa_mad"],
            "bbr_cost": metrics[m]["bbr_cost"],
            "appa_ratio_topup": metrics[m]["appa_mad"] / metrics["topup"]["appa_mad"],
            "bbr_ratio_topup": metrics[m]["bbr_cost"] / metrics["topup"]["bbr_cost"],
            "appa_ratio_synb0_topup": metrics[m]["appa_mad"]
            / metrics["synb0-topup"]["appa_mad"],
            "bbr_ratio_synb0_topup": metrics[m]["bbr_cost"]
            / metrics["synb0-topup"]["bbr_cost"],
            "synthetic_fit": synthetic_fit(
                raw if m == "synb0-sdc-raw" else smooth,
                fields[m],
                synthetic,
                mask,
                meta,
                s,
            ),
            "wall_s": metrics[m].get("wall_s"),
            "peak_rss_mb": metrics[m].get("peak_rss_mb"),
        }
        if "field_vs_gre_mad_demeaned_hz" in metrics[m]:
            row["vs_gre_mad_demeaned_hz"] = metrics[m]["field_vs_gre_mad_demeaned_hz"]
        out["methods"][m] = row
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
