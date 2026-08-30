#!/usr/bin/env bash
# Git Bash wrapper for scripts/dev.ps1 -- `make` is not required (and is not
# installed on all dev machines). Arguments pass straight through, e.g.
#   ./scripts/dev.sh -Force
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$here/dev.ps1")" "$@"
