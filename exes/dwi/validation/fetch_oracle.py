#!/usr/bin/env python3
"""Fetch the pinned oracle data for the exes/dwi oracle tests.

    python3 exes/dwi/validation/fetch_oracle.py DEST

reads oracle.manifest.json beside this script and puts each file in DEST at its
dataset path (the layout of neurodeskorg/webapps), so the Patch2Self oracle finds
its input at dwidenoise/validation/../../noddi/examples and the mrdegibbs
oracle finds its input at degibbs/validation/../examples. It gunzips the AMICO
oracle. Every file is checked against the manifest's size and sha256, also when
it is already in DEST; a mismatch is an error. On success the script prints the
test variables as NAME=VALUE lines (for "$GITHUB_ENV"):

    AMICO_ORACLE=DEST/noddi/validation/amico-1.5.4-oracle-ds001226.json
    DWIDENOISE_ORACLE=DEST/dwidenoise/validation
    DEGIBBS_ORACLE=DEST/degibbs/validation

Progress goes to stderr. Needs Python 3.10+ and no other packages.
"""

import gzip
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "oracle.manifest.json")


def log(message):
    print(message, file=sys.stderr, flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def verified(path, entry):
    return (
        os.path.isfile(path)
        and os.path.getsize(path) == entry["bytes"]
        and sha256(path) == entry["sha256"]
    )


def download(url, path, entry):
    if verified(path, entry):
        log(f"  cached, sha256 matches: {path}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for attempt in range(1, 6):
        try:
            with (
                urllib.request.urlopen(url, timeout=120) as r,
                open(path + ".part", "wb") as f,
            ):
                shutil.copyfileobj(r, f, 1 << 22)
            os.replace(path + ".part", path)
            break
        except OSError as e:
            if attempt == 5:
                raise
            log(f"  retrying ({e})")
            time.sleep(5 * attempt)
    if not verified(path, entry):
        sys.exit(f"{url}: size or sha256 does not match the manifest")


def gunzip(src, entry, dest):
    out = os.path.join(dest, entry["path"])
    if not verified(out, entry):
        with gzip.open(src) as g, open(out + ".part", "wb") as f:
            shutil.copyfileobj(g, f, 1 << 22)
        os.replace(out + ".part", out)
        if not verified(out, entry):
            sys.exit(f"{out}: gunzipped size or sha256 does not match the manifest")


def main(dest):
    with open(MANIFEST) as f:
        m = json.load(f)
    dest = os.path.abspath(dest)
    for e in m["files"]:
        url = f"https://huggingface.co/datasets/{m['repository']}/resolve/{e['revision']}/{e['path']}"
        local = os.path.join(dest, e["path"])
        log(f"{e['path']} ({e['bytes'] / 1e6:.1f} MB)")
        download(url, local, e)
        if "gunzip" in e:
            gunzip(local, e["gunzip"], dest)
    for name, rel in m["env"].items():
        path = os.path.join(dest, rel)
        if not os.path.exists(path):
            sys.exit(f"{name}: {path} does not exist")
        print(f"{name}={path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
