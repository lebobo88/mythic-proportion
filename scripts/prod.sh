#!/usr/bin/env bash
# Git Bash wrapper for scripts/prod.ps1 -- see scripts/dev.sh.
#   ./scripts/prod.sh -SkipBuild
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$here/prod.ps1")" "$@"
