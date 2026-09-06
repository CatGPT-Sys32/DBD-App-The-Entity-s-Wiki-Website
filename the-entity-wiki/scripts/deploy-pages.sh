#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${1:-}"

if [[ -z "$PROJECT_NAME" ]]; then
  echo "Usage: ./scripts/deploy-pages.sh <cloudflare-pages-project-name>"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required (install Node.js)." >&2
  exit 1
fi

npx wrangler@4 pages deploy web --project-name "$PROJECT_NAME"
