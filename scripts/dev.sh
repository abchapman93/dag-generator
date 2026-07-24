#!/usr/bin/env bash
# Start the dag-generator web app (see CLAUDE.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npm run dev
