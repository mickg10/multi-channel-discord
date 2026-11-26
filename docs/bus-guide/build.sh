#!/usr/bin/env bash
# Render the agent bus guide to PDF with headless Chrome.
# Usage: docs/bus-guide/build.sh   (writes docs/bus-guide/agent-bus-guide.pdf)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || chrome="$(command -v google-chrome || command -v chromium)"
"$chrome" --headless=new --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=8000 --run-all-compositor-stages-before-draw \
  --print-to-pdf="$here/agent-bus-guide.pdf" "file://$here/guide.html" 2>/dev/null
echo "wrote $here/agent-bus-guide.pdf"
