#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CXX=${CXX:-clang++}
WASM_LD=${WASM_LD:-wasm-ld}
OUT=${1:-"$ROOT/js/physics-core.wasm"}

command -v "$CXX" >/dev/null 2>&1 || { echo "Missing C++ compiler: $CXX" >&2; exit 1; }
command -v "$WASM_LD" >/dev/null 2>&1 || { echo "Missing WebAssembly linker: $WASM_LD" >&2; exit 1; }
mkdir -p "$(dirname -- "$OUT")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

"$CXX" --target=wasm32-unknown-unknown -std=c++17 -O3 -fno-exceptions -fno-rtti -nostdlib \
  -c "$ROOT/cpp/physics_core.cpp" -o "$TMP/physics_core.o"
"$WASM_LD" --no-entry --export-memory --export=alloc --export=reset_alloc \
  --export=project_constraints --export=integrate_bodies --export=resolve_debris_pairs --export=abi_version \
  --initial-memory=2097152 --max-memory=268435456 --stack-first \
  -o "$OUT" "$TMP/physics_core.o"
echo "Built WebAssembly physics core: $OUT"
