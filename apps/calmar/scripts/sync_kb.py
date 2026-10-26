#!/usr/bin/env python3
"""Bring the knowledge base into the webapp: one command from a KB checkout.

The aphasia knowledge base is its own repository,
https://github.com/micmas/stroke-aphasia-kb (until October 2026 the aphasia-kb/
folder of the calmar repository; calmar now pins it as the submodule
stroke-aphasia-kb/). The webapp carries an exported snapshot of it. This script:

  1. runs export_webapp.py from the given KB checkout, writing
     web/models/annotations/aphasia-kb.json (the asset the browser loads) and
     tests/fixtures/kb-parity/kb-parity.json (the Python answers the
     JavaScript port is tested against);
  2. updates the `aphasia-kb` entry in web/models/manifest.json and
     packages/calmar/model.manifest.json: size, sha256, a cache key that
     changes with the content, the KB commit (of the KB repository) and the
     statuses exported;
  3. prints what changed and the checks to run.

Nothing here edits the knowledge base. Run it after the KB commit you want to
ship, so the asset records that commit (`--allow-dirty` exports an uncommitted
tree, for local testing only).

`--kb` is the root of a stroke-aphasia-kb checkout: a clone of the KB
repository, or calmar's stroke-aphasia-kb/ submodule directory (a full clone).

    python3 scripts/sync_kb.py --kb ../../../stroke-aphasia-kb
    python3 scripts/sync_kb.py --kb ../../../calmar/stroke-aphasia-kb --include approved,in_review
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
ASSET = APP / "web/models/annotations/aphasia-kb.json"
FIXTURES = APP / "tests/fixtures/kb-parity"
MANIFESTS = (APP / "web/models/manifest.json", APP.parents[1] / "packages/calmar/model.manifest.json")
EXPORT_FORMAT = 2   # bump when export_webapp.py changes the JSON shape; the cache key carries it


def git(root: Path, *args: str) -> str | None:
    try:
        done = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--kb", required=True,
                        help="root of a stroke-aphasia-kb checkout (github.com/micmas/stroke-aphasia-kb), "
                             "e.g. ../../../stroke-aphasia-kb or calmar's stroke-aphasia-kb/ submodule")
    parser.add_argument("--include", default="approved", help="entry statuses to export (default: approved)")
    parser.add_argument("--allow-dirty", action="store_true", help="export even if the KB has uncommitted changes")
    parser.add_argument("--python", default=sys.executable, help="interpreter for export_webapp.py (needs pandas, pyyaml)")
    args = parser.parse_args(argv)

    kb = Path(args.kb).resolve()
    export = kb / "export_webapp.py"
    if not export.is_file():
        print(f"{export} not found: point --kb at the root of a stroke-aphasia-kb checkout "
              "(git clone https://github.com/micmas/stroke-aphasia-kb)", file=sys.stderr)
        return 2
    commit = git(kb, "rev-parse", "--short", "HEAD")
    dirty = git(kb, "status", "--porcelain")
    if dirty and not args.allow_dirty:
        print("The knowledge base has uncommitted changes; commit them first so the asset records the commit, "
              "or pass --allow-dirty for a local test export:", file=sys.stderr)
        print("\n".join(f"  {line}" for line in dirty.splitlines()[:12]), file=sys.stderr)
        return 1

    before = hashlib.sha256(ASSET.read_bytes()).hexdigest() if ASSET.exists() else None
    cmd = [args.python, "-I", str(export), "--include", args.include, "--out", str(ASSET), "--fixtures", str(FIXTURES)]
    print("$ " + " ".join(cmd))
    done = subprocess.run(cmd, cwd=str(kb), text=True)
    if done.returncode:
        return done.returncode

    data = json.loads(ASSET.read_text(encoding="utf-8"))
    version = data["version"]
    sha = hashlib.sha256(ASSET.read_bytes()).hexdigest()
    digest = version["contentDigest"]
    statuses = version["statuses"]
    for path in MANIFESTS:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        entry = next(a for a in manifest["annotationAssets"] if a["id"] == "aphasia-kb")
        entry.update({
            "sizeBytes": ASSET.stat().st_size,
            "checksum": f"sha256:{sha}",
            "cacheKey": f"aphasia-kb-{digest}-e{EXPORT_FORMAT}",
            "sourceVersion": f"aphasia-kb-{'-'.join(statuses)}-{digest}-export{EXPORT_FORMAT}",
            "kbContentDigest": digest,
            "kbStatuses": statuses,
            "kbCommit": version.get("commit"),
            "kbRepository": "https://github.com/micmas/stroke-aphasia-kb",
            "kbExportedOn": version.get("exportedOn"),
            "exportFormat": EXPORT_FORMAT,
        })
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    changed = before != sha
    print(f"\nasset   {ASSET.relative_to(APP)}  {ASSET.stat().st_size / 1024:.0f} KB  {'changed' if changed else 'unchanged'}")
    print(f"KB      commit {version.get('commit') or 'none'}{' (dirty tree)' if dirty else ''} · digest {digest} · "
          f"{version['findings']} findings from {version['papers']} papers · statuses {', '.join(statuses)}")
    print(f"manifests updated: {', '.join(str(p.relative_to(APP.parents[1])) for p in MANIFESTS)}")
    print("\nNext:\n  pnpm --filter calmar test:manifest-checksums && pnpm --filter calmar test:kb-report\n"
          "  node --test packages/calmar/test/kb-evidence.test.js   (the Python/JavaScript parity gate)\n"
          "  git add apps/calmar/web/models/annotations/aphasia-kb.json apps/calmar/tests/fixtures/kb-parity "
          "apps/calmar/web/models/manifest.json packages/calmar/model.manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
