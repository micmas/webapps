#!/usr/bin/env bash
# Synb0-DisCo, the sdc solver and the scores for every subject of the options document.
# Usage: run_all.sh [subject...]   (default: the six subjects)
# Needs ROOT, FS_LICENSE_FILE and SDC (see synb0.sh and solve.sh).
# ALPHA=1 also runs the diagnostic PyHySCO runs (run_alpha.py, alpha 300 and 1200)
# in the options document's $ROOT/venv-main.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../dwi-reverse-pe-options/common.sh"
python=$ROOT/venv-main/bin/python
subjects=("$@")
if [[ ${#subjects[@]} -eq 0 ]]; then
  subjects=(ds005134-sub-01 ds004146-sub-0001 ds004146-sub-0002 ds004146-sub-0003 ds004146-sub-0004 ds004146-sub-0005)
fi
for sub in "${subjects[@]}"; do
  [[ -f $ROOT/runs/$sub/synb0-topup/topup_fout.nii.gz ]] || bash "$here/synb0.sh" "$sub"
  bash "$here/solve.sh" "$sub"
  methods=(uncorrected synb0-topup synb0-sdc synb0-sdc-raw)
  if [[ ${ALPHA:-0} == 1 ]]; then
    for a in 300 1200; do
      out=$ROOT/runs/$sub/synb0-pyhysco-a$a
      rm -rf "$out"
      mkdir -p "$out"
      timed "$out/time.log" "$python" "$here/run_alpha.py" "$ROOT/runs/$sub" $a "$out" > "$out/pyhysco.log" 2>&1
      methods+=("synb0-pyhysco-a$a")
    done
  fi
  bash "$here/../dwi-reverse-pe-options/post.sh" "$sub" "${methods[@]}"
  "$python" "$here/compare.py" "$ROOT/runs/$sub" > "$ROOT/runs/$sub/synb0-compare.json"
done
