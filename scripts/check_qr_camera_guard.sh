#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

fail=0

check_block() {
  local file="$1"
  local label="$2"

  local has_playsinline has_muted_attr has_muted_prop has_autoplay_prop
  has_playsinline=$(rg -n "setAttribute\('playsinline',''\)" "$file" || true)
  has_muted_attr=$(rg -n "setAttribute\('muted',''\)" "$file" || true)
  has_muted_prop=$(rg -n "\.muted = true;" "$file" || true)
  has_autoplay_prop=$(rg -n "\.autoplay = true;" "$file" || true)

  if [[ -z "$has_playsinline" || -z "$has_muted_attr" || -z "$has_muted_prop" || -z "$has_autoplay_prop" ]]; then
    echo "[FAIL] ${label}: missing one or more required camera guard lines in ${file}" >&2
    [[ -z "$has_playsinline" ]] && echo "  - missing: setAttribute('playsinline','')" >&2
    [[ -z "$has_muted_attr" ]] && echo "  - missing: setAttribute('muted','')" >&2
    [[ -z "$has_muted_prop" ]] && echo "  - missing: .muted = true;" >&2
    [[ -z "$has_autoplay_prop" ]] && echo "  - missing: .autoplay = true;" >&2
    fail=1
  else
    echo "[PASS] ${label}: camera autoplay guard lines present"
  fi
}

check_block "index.html" "Main check-in scanner"
check_block "Reg2.html" "Registration self-service scanner"
check_block "Admin2.html" "Admin scanner"

if [[ "$fail" -ne 0 ]]; then
  echo "\nCamera regression guard FAILED. Re-apply the QR camera startup fix before deploy." >&2
  exit 1
fi

echo "\nCamera regression guard passed."
