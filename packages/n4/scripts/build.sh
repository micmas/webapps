#!/usr/bin/env bash
# Build wasm/n4-bias.{mjs,wasm}: ANTs N4BiasFieldCorrection at the ANTs commit and ITK-Wasm
# Emscripten image that packages/registration pins. Docker, curl and tar are required.
#
#   bash packages/n4/scripts/build.sh /absolute/build/dir          rebuild and copy into wasm/
#   bash packages/n4/scripts/build.sh --check /absolute/build/dir  rebuild and fail unless both
#                                                                  files equal the committed ones
#
# The bytes are reproducible: the toolchain image is pinned by digest, the sources and the build
# tree are mounted at the same container paths (/source, /build) on every host, and
# SOURCE_DATE_EPOCH fixes the __DATE__ __TIME__ stamp that ANTsVersion.cxx compiles in.
set -euo pipefail
mode=build
if [ "${1:-}" = --check ]; then
  mode=check
  shift
fi
if [ $# -ne 1 ]; then
  echo "usage: $0 [--check] /absolute/build/dir" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../../.." && pwd)
build=$1
case "$build" in /*) ;; *) echo 'Build directory must be absolute' >&2; exit 1;; esac
mkdir -p "$build"
commit=52bc0ab588102682587303d31c720de94e6ef6c1
toolchain=itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d
# ANTs' build date ("Oct 18 2026 18:39:49", UTC), the time the committed module was first built.
# Clang reads it for __DATE__ and __TIME__; without it every rebuild embeds its own clock time.
source_date_epoch=1792348789
if [ ! -f "$build/ants-$commit/Examples/N4BiasFieldCorrection.cxx" ]; then
  curl --fail --location "https://codeload.github.com/ANTsX/ANTs/tar.gz/$commit" -o "$build/ants.tar.gz"
  mkdir -p "$build/ants-$commit"
  tar -xzf "$build/ants.tar.gz" --strip-components=1 -C "$build/ants-$commit"
fi
# One compile job; the container memory limit keeps a large ITK translation unit from exhausting the host.
# The build tree starts empty each time: make does not recompile when SOURCE_DATE_EPOCH changes, and
# the container writes it as root.
docker run --rm --network none --memory "${N4_BUILD_MEMORY:-8g}" --entrypoint bash \
  -e SOURCE_DATE_EPOCH="$source_date_epoch" \
  -v "$build:/build" -v "$root/packages/n4:/source:ro" \
  "$toolchain" -c "rm -rf /build/wasm && emcmake cmake -S /source -B /build/wasm -DITK_DIR=/ITK-build -DANTS_SOURCE_DIR=/build/ants-$commit -DCMAKE_BUILD_TYPE=Release && cmake --build /build/wasm -j 1"
if [ "$mode" = check ]; then
  status=0
  for file in n4-bias.wasm n4-bias.mjs; do
    committed=$(sha256sum < "$root/packages/n4/wasm/$file" | cut -c1-64)
    rebuilt=$(sha256sum < "$build/wasm/$file" | cut -c1-64)
    if cmp -s "$build/wasm/$file" "$root/packages/n4/wasm/$file"; then
      echo "PASS wasm/$file equals a rebuild from source ($committed)"
    else
      echo "FAIL wasm/$file differs from a rebuild from source: committed $committed, rebuilt $rebuilt" >&2
      status=1
    fi
  done
  if [ "$status" -ne 0 ]; then
    echo "Run 'bash packages/n4/scripts/build.sh /absolute/build/dir' and commit wasm/." >&2
  fi
  exit "$status"
fi
cp "$build/wasm/n4-bias.mjs" "$build/wasm/n4-bias.wasm" "$root/packages/n4/wasm/"
sha256sum "$root/packages/n4/wasm/n4-bias.wasm"
