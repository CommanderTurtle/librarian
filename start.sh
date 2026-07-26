#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  echo "Missing .env. Run: bun run setup" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

exec bun packages/server/dist/index.js
