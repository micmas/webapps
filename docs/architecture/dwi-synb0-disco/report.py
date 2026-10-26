"""Print the Markdown tables of the Synb0-DisCo comparison.

Usage: report.py [--alpha] <results-dir>

Reads <results-dir>/<subject>/synb0-compare.json (compare.py) for every
subject that has one. Without --alpha the output is the tables of
dwi-synb0-disco.md. --alpha also prints the run_alpha.py rows
(synb0-pyhysco-a300, synb0-pyhysco-a1200) in each table. Standard library only.
"""

import json
import sys
from pathlib import Path

METHODS = ("uncorrected", "synb0-topup", "synb0-sdc", "synb0-sdc-raw")


def fmt(value, digits=3):
    if value is None:
        return "n/a"
    return f"{value:.{digits}g}" if abs(value) < 1000 else f"{value:.0f}"


def load(results):
    rows = []
    for path in sorted(Path(results).glob("*/synb0-compare.json")):
        rows.append(json.loads(path.read_text()))
    if not rows:
        raise SystemExit(f"no */synb0-compare.json under {results}")
    return rows


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def diagnostics(rows):
    """The run_alpha.py rows, in every subject."""
    names = [
        {m for m in row["methods"] if m.startswith("synb0-pyhysco")} for row in rows
    ]
    return sorted(set.intersection(*names)) if names else []


def tables(rows, alpha=False):
    extra = diagnostics(rows) if alpha else []
    out = []
    out.append("### Field difference from topup with the same synthetic b0 (Hz)\n")
    out.append(
        "| Subject | Method | Δfield | Offset | Δfield demeaned | r | Synthetic fit |"
    )
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for row in rows:
        for m in ("synb0-sdc", "synb0-sdc-raw", *extra, "uncorrected"):
            r = row["methods"][m]
            v = r["vs_synb0_topup"]
            out.append(
                f"| {row['subject']} | {m} | {fmt(v['mad_hz'])} | {fmt(v['offset_hz'])} "
                f"| {fmt(v['mad_demeaned_hz'])} | {fmt(v['r'])} | {fmt(r['synthetic_fit'])} |"
            )
    out.append("")
    out.append(
        "### The options document's metrics (reference: topup with the real reverse-PE pair)\n"
    )
    out.append(
        "| Subject | Method | AP-PA ratio | BBR ratio | Δfield demeaned (Hz) | r | Δ GRE demeaned (Hz) |"
    )
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for row in rows:
        for m in (*METHODS, *extra):
            r = row["methods"][m]
            v = r["vs_topup"]
            out.append(
                f"| {row['subject']} | {m} | {fmt(r['appa_ratio_topup'])} | {fmt(r['bbr_ratio_topup'], 4)} "
                f"| {fmt(v['mad_demeaned_hz'])} | {fmt(v['r'])} | {fmt(r.get('vs_gre_mad_demeaned_hz'))} |"
            )
    out.append("")
    out.append("### Means over the subjects\n")
    out.append(
        "| Method | Δfield demeaned from synb0-topup (Hz) | r with synb0-topup | AP-PA ratio | BBR ratio "
        "| Δfield demeaned from topup (Hz) | Δfield from topup (Hz) | Absolute offset from topup (Hz) | Time (s) |"
    )
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for m in (*METHODS, *extra):
        rs = [row["methods"][m] for row in rows]
        out.append(
            f"| {m} | {fmt(mean([r['vs_synb0_topup']['mad_demeaned_hz'] for r in rs]))} "
            f"| {fmt(mean([r['vs_synb0_topup']['r'] for r in rs]))} "
            f"| {fmt(mean([r['appa_ratio_topup'] for r in rs]))} "
            f"| {fmt(mean([r['bbr_ratio_topup'] for r in rs]), 4)} "
            f"| {fmt(mean([r['vs_topup']['mad_demeaned_hz'] for r in rs]))} "
            f"| {fmt(mean([r['vs_topup']['mad_hz'] for r in rs]))} "
            f"| {fmt(mean([abs(r['vs_topup']['offset_hz']) for r in rs]))} "
            f"| {fmt(mean([r.get('wall_s') for r in rs]))} |"
        )
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    args = sys.argv[1:]
    alpha = "--alpha" in args
    args = [a for a in args if a != "--alpha"]
    if len(args) != 1:
        raise SystemExit(__doc__)
    sys.stdout.write(tables(load(args[0]), alpha=alpha))
