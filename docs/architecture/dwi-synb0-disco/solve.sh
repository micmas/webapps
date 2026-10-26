#!/usr/bin/env bash
# Run the sdc command line (the apps/sdc solver) with the synthetic b0 as image 2.
# Usage: solve.sh <subject>   (after synb0.sh)
#
# synb0-sdc:     image 1 is b0_d_smooth, the image that topup gets in Synb0-DisCo.
# synb0-sdc-raw: image 1 is the unsmoothed AP mean, as the app would read it.
# Image 2 is b0_u. The solver assumes equal and opposite displacements, so it
# gets the opposite direction and the same readout time; fields.py converts its
# midpoint field to the undistorted frame.
set -euo pipefail
source "$(dirname "$0")/../dwi-reverse-pe-options/common.sh"
SDC=${SDC:?set SDC to the sdc command line (exes/sdc target/release/sdc)}
sub=$1
run=$ROOT/runs/$sub
syn=$run/synb0/OUTPUTS
trt=$(py -c "import json; print(json.load(open('$run/prep/prep.json'))['ap']['trt'])")
pe=$(py -c "import json; print(json.load(open('$run/prep/prep.json'))['ap']['pe'])")
case $pe in
  *-) opposite=${pe%-} ;;
  *) opposite=$pe- ;;
esac
# The baseline without correction: fields.py writes a zero field for it.
mkdir -p "$run/uncorrected"
for method in synb0-sdc synb0-sdc-raw; do
  image1=$syn/b0_d_smooth.nii.gz
  [[ $method == synb0-sdc-raw ]] && image1=$run/prep/ap_mean.nii.gz
  out=$run/$method
  rm -rf "$out"
  mkdir -p "$out"
  cd "$out"
  timed time.log "$SDC" pyhysco "$image1" "$syn/b0_u.nii.gz" sdc --pe1 "$pe" --pe2 "$opposite" --trt "$trt" > sdc.log 2>&1
done
