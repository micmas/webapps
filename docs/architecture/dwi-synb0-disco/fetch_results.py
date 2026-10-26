#!/usr/bin/env python3
"""Fetch the pinned Synb0-DisCo comparison results from Hugging Face.

    python3 fetch_results.py DEST [SUBJECT ...]
    python3 fetch_results.py --pin REVISION

The same tool as dwi-reverse-pe-options/fetch_results.py, for the folder
sdc/synb0-disco/ of neurodeskorg/webapps and results.manifest.json beside this
script. Then

    python3 report.py DEST

prints the tables of dwi-synb0-disco.md (add --alpha for the run_alpha.py rows).
Standard library only.
"""

import json
import os
import sys

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "dwi-reverse-pe-options"
    ),
)
import fetch_results as base

base.ROOT = "sdc/synb0-disco"
base.MANIFEST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "results.manifest.json"
)
DESCRIPTION = (
    "Synthetic b0 images, fields and metrics of dwi-synb0-disco.md (#508). "
    "Fetch with fetch_results.py DEST; re-pin with fetch_results.py --pin REVISION."
)


def pin(revision):
    base.pin(revision)
    with open(base.MANIFEST) as f:
        text = f.read()
    old = json.loads(text)["description"]
    with open(base.MANIFEST, "w") as f:
        f.write(text.replace(json.dumps(old), json.dumps(DESCRIPTION), 1))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--pin":
        pin(sys.argv[2])
    elif len(sys.argv) >= 2 and not sys.argv[1].startswith("-"):
        base.download(sys.argv[1], sys.argv[2:])
    else:
        sys.exit(__doc__)
