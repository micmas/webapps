#!/usr/bin/env bash
# Run Synb0-DisCo v3.1 on one subject that dwi-reverse-pe-options/prep.sh prepared.
# Usage: synb0.sh <subject>
#
# Inputs (from runs/<subject>/prep): ap_mean.nii.gz is the distorted b0, and
# t1w_brain.nii.gz (MindGrab mask) is the T1w with --stripped, so the
# pipeline never runs FSL bet. Synb0-DisCo runs with --notopup. Then topup
# runs with the pipeline's own command and synb0.cnf, with --fout added.
# Writes runs/<subject>/synb0/OUTPUTS and runs/<subject>/synb0-topup.
set -euo pipefail
source "$(dirname "$0")/../dwi-reverse-pe-options/common.sh"
SYNB0_IMAGE=${SYNB0_IMAGE:-$ROOT/containers/synb0-disco_v3.1.sif}
# FreeSurfer needs a licence file at /extra/freesurfer/license.txt; the image has an empty one.
FS_LICENSE_FILE=${FS_LICENSE_FILE:?set FS_LICENSE_FILE to a FreeSurfer licence file}
sub=$1
prep=$ROOT/runs/$sub/prep
out=$ROOT/runs/$sub/synb0
rm -rf "$out"
mkdir -p "$out/INPUTS" "$out/OUTPUTS" "$out/tmp"
trt=$(py -c "import json; print(json.load(open('$prep/prep.json'))['ap']['trt'])")
pe=$(py -c "import json; print(json.load(open('$prep/prep.json'))['ap']['pe'])")
case $pe in
  i) vec="1 0 0" ;; i-) vec="-1 0 0" ;;
  j) vec="0 1 0" ;; j-) vec="0 -1 0" ;;
  *) echo "unsupported PE $pe" >&2; exit 1 ;;
esac
cp "$prep/ap_mean.nii.gz" "$out/INPUTS/b0.nii.gz"
cp "$prep/t1w_brain.nii.gz" "$out/INPUTS/T1.nii.gz"
# Row 2 is the synthetic b0: same direction, readout time 0 (the Synb0-DisCo README).
printf '%s %s\n%s 0.000\n' "$vec" "$trt" "$vec" > "$out/INPUTS/acqparams.txt"

cd "$out"
/usr/bin/time -v -o time.log apptainer run --cleanenv \
  --env OMP_NUM_THREADS=$THREADS,ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=$THREADS,MKL_NUM_THREADS=$THREADS \
  -B "$out/INPUTS:/INPUTS" -B "$out/OUTPUTS:/OUTPUTS" -B "$out/tmp:/tmp" \
  -B "$FS_LICENSE_FILE:/extra/freesurfer/license.txt" \
  "$SYNB0_IMAGE" --stripped --notopup > synb0.log 2>&1

# topup as pipeline.sh runs it, plus --fout. FSL 6.0.1 topup has no --nthr: one thread.
t=$ROOT/runs/$sub/synb0-topup
rm -rf "$t"
mkdir -p "$t"
cd "$t"
/usr/bin/time -v -o time.log apptainer exec --cleanenv -B "$out" -B "$t" "$SYNB0_IMAGE" bash -c "
  . /extra/fsl/etc/fslconf/fsl.sh; export FSLDIR=/extra/fsl FSLOUTPUTTYPE=NIFTI_GZ PATH=/extra/fsl/bin:\$PATH
  fslmerge -t b0_all.nii.gz '$out/OUTPUTS/b0_d_smooth.nii.gz' '$out/OUTPUTS/b0_u.nii.gz'
  topup -v --imain=b0_all.nii.gz --datain='$out/INPUTS/acqparams.txt' --config=/extra/synb0.cnf \
    --iout=b0_all_topup.nii.gz --out=topup --fout=topup_fout.nii.gz" > topup.log 2>&1
