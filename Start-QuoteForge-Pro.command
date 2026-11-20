#!/bin/bash
# Change directory to the folder where this script is located
cd "$(dirname "$0")"

clear
echo "======================================================="
echo "⚙️  Starting QuoteForge Pro..."
echo "======================================================="
echo ""

# The optional "mqtt" package (live Bambu Lab status) is installed once on
# first run. QuoteForge still starts if this fails (e.g. no internet) — only
# Bambu live status needs it. Test-only packages are skipped (--omit=dev).
if [ ! -d "node_modules" ]; then
  echo "📦 First run — installing dependencies (one-time, needs internet)..."
  npm install --omit=dev || echo "⚠️  Install failed — starting anyway (Bambu Lab live status won't be available)."
  echo ""
fi

echo "🚀 Booting local server..."
echo "🌍 Opening in your default browser..."
echo "🛑 Close this window at any time to stop QuoteForge Pro."
echo ""
echo "======================================================="

# Run the Node.js server (this serves the app and opens the browser)
node server.js
