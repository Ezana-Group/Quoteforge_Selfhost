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
