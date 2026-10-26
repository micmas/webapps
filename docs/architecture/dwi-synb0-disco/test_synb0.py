"""Checks of the Synb0-DisCo comparison scripts that need no imaging tools.

python3 -m unittest discover -s docs/architecture/dwi-synb0-disco -p 'test_*.py'

MidpointTests needs numpy, scipy and nibabel. Without them it is skipped;
SYNB0_REQUIRE_NUMERICS=1 makes that skip a failure.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "dwi-reverse-pe-options"))

import report

HAVE_NUMERICS = all(
    importlib.util.find_spec(name) for name in ("numpy", "scipy", "nibabel")
)
if not HAVE_NUMERICS and os.environ.get("SYNB0_REQUIRE_NUMERICS") == "1":
    raise ImportError("SYNB0_REQUIRE_NUMERICS=1: needs numpy, scipy and nibabel")


def method(mad, r=0.9):
    field = {"mad_hz": mad, "offset_hz": 0.5, "mad_demeaned_hz": mad, "r": r}
    return {
        "vs_synb0_topup": field,
        "vs_topup": field,
        "appa_ratio_topup": 2.0,
        "bbr_ratio_topup": 1.05,
        "synthetic_fit": 0.06,
        "wall_s": 2.0,
    }


class ReportTests(unittest.TestCase):
    def test_tables_cover_every_subject_and_method(self):
        with tempfile.TemporaryDirectory() as directory:
            for sub in ("sub-a", "sub-b"):
                (Path(directory) / sub).mkdir()
                row = {
                    "subject": sub,
                    "methods": {m: method(1.0) for m in report.METHODS},
                }
                row["methods"]["uncorrected"]["vs_synb0_topup"]["r"] = None
                (Path(directory) / sub / "synb0-compare.json").write_text(
                    json.dumps(row)
                )
            text = report.tables(report.load(directory))
        self.assertIn("| sub-b | synb0-sdc-raw |", text)
        self.assertIn("| uncorrected |", text)
        self.assertIn("n/a", text)
        self.assertIn("| Absolute offset from topup (Hz) |", text)

    def test_alpha_rows_only_on_request(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "sub-a").mkdir()
            names = (*report.METHODS, "synb0-pyhysco-a1200")
            row = {"subject": "sub-a", "methods": {m: method(1.0) for m in names}}
            (Path(directory) / "sub-a" / "synb0-compare.json").write_text(
                json.dumps(row)
            )
            rows = report.load(directory)
            self.assertNotIn("synb0-pyhysco", report.tables(rows))
            self.assertIn("| sub-a | synb0-pyhysco-a1200 |", report.tables(rows, True))

    def test_missing_results_fail(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(SystemExit):
            report.load(directory)


@unittest.skipUnless(HAVE_NUMERICS, "needs numpy, scipy and nibabel")
class MidpointTests(unittest.TestCase):
    def test_full_field_maps_distorted_onto_undistorted(self):
        import numpy as np
        from fields import full_from_midpoint

        n = 64
        z = np.arange(n, dtype=np.float64)
        undistorted = np.exp(-(((z - 30.0) / 6.0) ** 2))
        # D(y) = U(z) with y = z + F(z): the true full displacement F.
        full = 3.0 * np.sin(z / n * np.pi)
        y = z + full
        distorted = np.interp(z, y, undistorted)
        # The symmetric fit's midpoint field: m = (y + z) / 2, b(m) = F(z) / 2.
        b = np.interp(z, 0.5 * (y + z), 0.5 * full)
        got = full_from_midpoint(b[None, :, None] * np.ones((2, n, 2)), axis=1)[0, :, 0]
        inner = slice(5, n - 5)
        self.assertLess(np.max(np.abs(got[inner] - full[inner])), 0.02)
        corrected = np.interp(z + got, z, distorted)
        self.assertLess(np.max(np.abs(corrected[inner] - undistorted[inner])), 0.02)


if __name__ == "__main__":
    unittest.main()
