#!/bin/zsh
set -euo pipefail

cd "/Users/mima0000/Desktop/cursor1"

PORT="${1:-5173}"

echo "Starting server on http://localhost:${PORT}"
python3 -m http.server "${PORT}"

