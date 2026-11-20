# QuoteForge — Self-Hosted Edition

An open-source, self-hostable 3D printing quote calculator and shop management tool. Calculate production costs down to the gram and kWh, monitor live network printers (Bambu Lab, Klipper/Moonraker, Prusa, OctoPrint), and manage customer quotes and jobs from your own server.

All data is stored locally in your chosen directory or Docker volume — **100% private, zero cloud dependencies, and zero subscriptions**.

---

## Quick Start (Docker Compose)

The fastest and recommended way to run QuoteForge:

```bash
git clone https://github.com/Ezana-Group/Quoteforge_Selfhost.git
cd Quoteforge_Selfhost
docker compose up -d
```

Open your browser to:
```
http://localhost:8080
```

To stop the server:
```bash
docker compose down
```
*(Your saved quotes, jobs, and settings survive restarts in the `quoteforge-data` volume).*

---

## Single-File Deployment (Zero-Clone)

If you just want to run QuoteForge on a remote VPS, Synology NAS, Unraid, or Raspberry Pi without cloning the whole source repository, create a `docker-compose.yml` file:

```yaml
services:
  quoteforge:
    image: ghcr.io/ezana-group/quoteforge:latest
    container_name: quoteforge
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - quoteforge-data:/data

volumes:
  quoteforge-data:
```

Then run:
```bash
docker compose pull
docker compose up -d
```

---

## Configuration & Environment Variables

QuoteForge is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the internal server listens on |
| `HOST` | `0.0.0.0` (in Docker) | Interface to bind (`127.0.0.1` when run directly) |
| `DATA_DIR` | `/data` (in Docker) | Directory where `app-data.json` and automatic daily backups live |
| `QUOTEFORGE_PASSWORD` | *(none)* | Enables HTTP Basic Authentication (recommended if exposed beyond LAN) |
| `QUOTEFORGE_USER` | `quoteforge` | Username for HTTP Basic Authentication |

### Example with Password Protection:

In `docker-compose.yml`:
```yaml
environment:
  QUOTEFORGE_PASSWORD: "choose-a-strong-password"
  QUOTEFORGE_USER: "admin"
```

---

## 🖨️ Local 3D Printer Discovery

QuoteForge includes auto-discovery and live telemetry for network 3D printers:

* **Bambu Lab** (P1P, P1S, X1C, A1, A1 mini) — Local MQTT over TLS (port 8883)
* **Klipper / Moonraker** (Voron, Creality K1, Elegoo, Sovol, etc.) — Ports 7125 / 80 / 4408
* **PrusaLink / Prusa Connect** (MK4, XL, MINI, MK3.9) — HTTP Digest API
* **OctoPrint** — HTTP REST API with API key
* **Elegoo SDCP** & **Duet/RepRapFirmware**

### LAN Discovery Note for Docker:
By default, Docker isolates containers in a bridge network. To allow QuoteForge's **Scan Network** feature to discover printers on your physical home or office LAN, uncomment `network_mode: host` in `docker-compose.yml`:

```yaml
services:
  quoteforge:
    build: .
    network_mode: host
    volumes:
      - quoteforge-data:/data
```

---

## Running Without Docker (Direct Node.js)

Requirements: **Node.js 18+**

```bash
# 1. Install dependencies (skip optional Bambu MQTT if not needed: npm install --omit=optional)
npm install --omit=dev

# 2. Start server
npm start
```

Data will automatically persist in `~/.quoteforge/app-data.json` on the host machine.

---

## Security & Production Hosting

If hosting QuoteForge on an internet-accessible server:

1. **Always use HTTPS**: Basic authentication sends credentials in plain text unless encrypted by TLS. Put a reverse proxy like [Caddy](https://caddyserver.com/) or Nginx in front:
   ```caddy
   quoteforge.yourdomain.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
2. **Brute-Force Guard**: QuoteForge includes an automated in-memory throttle that blocks IPs after 10 failed password attempts for 5 minutes (`429 Too Many Requests`).
3. **Backup your volume**: Back up `/data` or the `quoteforge-data` volume periodically. Automatic rolling 7-day backups are also maintained inside `/data/backups`.

---

## License

AGPL-3.0-only — see [LICENSE](LICENSE).
