#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

bun_bin="$(command -v bun || true)"
[[ -n "$bun_bin" ]] || {
  printf 'Bun is required. Install Bun or Sandwich, then rerun update.sh.\n' >&2
  exit 1
}

git pull --rebase --autostash
"$bun_bin" install --frozen-lockfile
"$bun_bin" run build
"$bun_bin" run integrate

printf 'Librarian updated and its Hermes/OMP registrations were reconciled.\n'
printf 'Restart its optional HTTP service if it is running.\n'
