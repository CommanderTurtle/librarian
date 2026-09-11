#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$repo_dir"

bun_bin="$(command -v bun || true)"
[[ -n "$bun_bin" ]] || {
  printf 'Bun is required. Install Bun or Sandwich, then rerun integrate.sh.\n' >&2
  exit 1
}

exec "$bun_bin" scripts/setup.ts --integrate-only
