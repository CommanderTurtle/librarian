#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

bun_bin="$(command -v bun || true)"
[[ -n "$bun_bin" ]] || {
  printf 'Bun is required. Install Bun or Sandwich, then rerun update.sh.\n' >&2
  exit 1
}

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  printf 'Librarian has tracked local changes; commit or stash them before updating.\n' >&2
  exit 1
fi

git pull --ff-only
"$bun_bin" install --frozen-lockfile
"$bun_bin" run build
"$repo_dir/integrate.sh"

printf 'Librarian updated and its Hermes/OMP registrations were reconciled.\n'
printf 'Restart its optional HTTP service if it is running.\n'
