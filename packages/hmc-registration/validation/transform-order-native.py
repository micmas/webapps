"""Run the actual native ANTs entry, preserving the argument list order."""
import hashlib
import json
from pathlib import Path
import sys

import ants
import ants.lib
from ants.internal import get_lib_fn

root = Path(sys.argv[1]).resolve()
cases = json.loads((root / "cases.json").read_text())
run = get_lib_fn("antsApplyTransforms")
metadata = {
    "antspyx": ants.__version__,
    "librarySha256": hashlib.sha256(Path(ants.lib.__file__).read_bytes()).hexdigest(),
    "entry": "ants.internal.get_lib_fn('antsApplyTransforms')",
    "cases": {},
}
for name, chain in cases.items():
    args = ["-d", "3", "--float", "0", "-i", str(root / "fixed.nii"),
            "-r", str(root / "fixed.nii"), "-o", str(root / f"native-{name}.nii"),
            "-n", "Linear"]
    for item in chain:
        transform = (f"[{root / item[len('inverse:'):]},1]"
                     if item.startswith("inverse:") else str(root / item))
        args.extend(["-t", transform])
    status = run(args)
    metadata["cases"][name] = {"argv": args, "status": status}
    if status != 0:
        raise RuntimeError(f"Native {name} failed: {status}")
(root / "native.json").write_text(json.dumps(metadata, indent=2) + "\n")
