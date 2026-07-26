#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  printf 'Missing .env. Run: bun run setup\n' >&2
  exit 1
fi

bun_bin="$(command -v bun || true)"
[[ -n "$bun_bin" ]] || {
  printf 'Bun is required. Install Bun or Sandwich, then rerun start.sh.\n' >&2
  exit 1
}

set -a
# shellcheck disable=SC1091
source .env
set +a

exec "$bun_bin" packages/server/dist/index.js
