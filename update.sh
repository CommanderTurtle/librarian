#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

git pull --rebase --autostash
bun install --frozen-lockfile
bun run build

echo "Librarian updated. Restart its optional HTTP service if it is running."
