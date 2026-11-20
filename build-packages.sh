#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGES_DIR="$DIR/packages"

echo "Creating package directories in: $PACKAGES_DIR"
rm -rf "$PACKAGES_DIR"
mkdir -p "$PACKAGES_DIR/QuoteForge-Pro-Mac"
mkdir -p "$PACKAGES_DIR/QuoteForge-Pro-Windows"
mkdir -p "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted"

SHARED_FILES=(
  "server.js"
  "printers.js"
  "calculator.js"
  "index.html"
  "styles.css"
  "multi-part-import.js"
  "reports.js"
  "config.json"
  "manifest.json"
  "sw.js"
  "LICENSE"
  "THIRD-PARTY-NOTICES.md"
)

copy_shared() {
  local target="$1"
  for f in "${SHARED_FILES[@]}"; do
    if [ -f "$DIR/$f" ]; then
      cp "$DIR/$f" "$target/"
    fi
  done
  if [ -d "$DIR/vendor" ]; then
    cp -r "$DIR/vendor" "$target/"
  fi
  if [ -d "$DIR/icons" ]; then
    cp -r "$DIR/icons" "$target/"
  fi
}

# ============================================================================
# 1. macOS Package
# ============================================================================
echo "Building macOS package..."
copy_shared "$PACKAGES_DIR/QuoteForge-Pro-Mac"
cp "$DIR/Start-QuoteForge-Pro.command" "$PACKAGES_DIR/QuoteForge-Pro-Mac/"
chmod +x "$PACKAGES_DIR/QuoteForge-Pro-Mac/Start-QuoteForge-Pro.command"
cp "$DIR/package.json" "$PACKAGES_DIR/QuoteForge-Pro-Mac/"
if [ -f "$DIR/package-lock.json" ]; then
  cp "$DIR/package-lock.json" "$PACKAGES_DIR/QuoteForge-Pro-Mac/"
fi

cat << 'TXT' > "$PACKAGES_DIR/QuoteForge-Pro-Mac/HOW-TO-RUN.txt"
QuoteForge Pro for macOS
========================

Requirements:
- Node.js v18 or newer (download free from https://nodejs.org if not already installed).

How to start:
1. Double-click "Start-QuoteForge-Pro.command".
2. It will boot the local server and open QuoteForge Pro in your browser.
3. Close the terminal window at any time to quit the app.

First time running on macOS:
macOS Gatekeeper may show a warning for scripts downloaded from the web.
If that happens:
- Right-click "Start-QuoteForge-Pro.command" -> choose "Open" -> click "Open" again.
(You only need to do this once).

Where is your data saved?
All your jobs, materials, and settings are saved to:
  ~/.quoteforge/app-data.json
Your data is 100% private, stays on this computer, and will survive future updates.
TXT

# ============================================================================
# 2. Windows Package
# ============================================================================
echo "Building Windows package..."
copy_shared "$PACKAGES_DIR/QuoteForge-Pro-Windows"
cp "$DIR/Start-QuoteForge-Pro.bat" "$PACKAGES_DIR/QuoteForge-Pro-Windows/"
cp "$DIR/package.json" "$PACKAGES_DIR/QuoteForge-Pro-Windows/"
if [ -f "$DIR/package-lock.json" ]; then
  cp "$DIR/package-lock.json" "$PACKAGES_DIR/QuoteForge-Pro-Windows/"
fi

cat << 'TXT' > "$PACKAGES_DIR/QuoteForge-Pro-Windows/HOW-TO-RUN.txt"
QuoteForge Pro for Windows
==========================

Requirements:
- Node.js v18 or newer (download free from https://nodejs.org if not already installed).

How to start:
1. Double-click "Start-QuoteForge-Pro.bat".
2. It will start the local server and open QuoteForge Pro in your default browser.
3. Close the console window at any time to stop QuoteForge Pro.

First time running on Windows:
If Windows Defender SmartScreen shows "Windows protected your PC":
- Click "More info", then click "Run anyway".

Where is your data saved?
All your jobs, materials, and settings are saved to:
  %USERPROFILE%\.quoteforge\app-data.json
Your data stays on this PC and survives future updates.
TXT

# ============================================================================
# 3. Self-Hosted Package
# ============================================================================
echo "Building Self-Hosted package..."
copy_shared "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted"
cp "$DIR/Dockerfile" "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted/"
cp "$DIR/docker-compose.yml" "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted/"
cp "$DIR/.dockerignore" "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted/"
cp "$DIR/package.json" "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted/"
if [ -f "$DIR/package-lock.json" ]; then
  cp "$DIR/package-lock.json" "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted/"
fi

cat << 'MD' > "$PACKAGES_DIR/QuoteForge-Pro-Self-Hosted/README.md"
# QuoteForge Pro — Self-Hosted Edition

This package contains everything needed to run QuoteForge Pro in Docker or on your own private server / NAS / cloud VPS.

## Quick Start (Docker Compose)

1. Ensure [Docker](https://docs.docker.com/get-docker/) is installed.
2. In this directory, start the container:
   ```bash
   docker compose up -d
   ```
3. Open `http://localhost:8080` (or your server's IP address).

To stop:
```bash
docker compose down
```

## Data Persistence

Your jobs, quotes, materials, and settings are stored in the named Docker volume `quoteforge-data` (mounted at `/data` inside the container). Your data survives container restarts, updates, and rebuilds.

## Password Protection

QuoteForge Pro includes optional HTTP Basic authentication. To enable it, edit `docker-compose.yml` or pass environment variables:

```yaml
environment:
  QUOTEFORGE_PASSWORD: "your-strong-password"
  QUOTEFORGE_USER: "quoteforge" # optional, defaults to quoteforge
```

> **Security Note:** If exposing QuoteForge beyond your local network, always place a TLS reverse proxy (such as Caddy, Nginx, or Traefik) or VPN (such as Tailscale) in front of it.

## Network Printer Discovery

To allow QuoteForge to scan and discover local 3D printers on your office/home LAN from Docker, uncomment `network_mode: host` in `docker-compose.yml`.
MD

# ============================================================================
# 4. Create ZIP archives ready for website upload
# ============================================================================
echo "Creating ZIP files for website downloads..."
cd "$PACKAGES_DIR"
rm -f *.zip
zip -rq "QuoteForge-Pro-Mac.zip" "QuoteForge-Pro-Mac"
zip -rq "QuoteForge-Pro-Windows.zip" "QuoteForge-Pro-Windows"
zip -rq "QuoteForge-Pro-Self-Hosted.zip" "QuoteForge-Pro-Self-Hosted"

echo "Done!"
ls -lh "$PACKAGES_DIR"/*.zip
