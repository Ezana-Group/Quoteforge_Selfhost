# Printer support

How each kind of printer connects, and how far each connection has been verified.

**Verification levels**
- **Simulated:** tested against a simulated printer in the automated tests (`test/printers.test.js`, `test/server.test.js`). The protocol follows public documentation but has not yet been confirmed on every real model.
- **Field-proven:** the pre-existing connections (OctoPrint, PrusaLink, Moonraker, Bambu status) were built before this release; treat them as working but re-test on real hardware before launch.
- **Needs hardware:** not built yet, or can't be confirmed without a real printer.

| Printer family | Connection | Discovery | Status | Notes |
|---|---|---|---|---|
| Bambu Lab P1P/P1S, X1, A1/A1 mini | MQTT over TLS (8883), access code | Automatic (UDP 1990/2021 announcement) | Live status | Needs LAN Only Mode. Discovery simulated; status from earlier release |
| Bambu Lab H2 series | Same | Automatic | Live status | Needs LAN Only Mode **and** Developer Mode |
| Prusa MK4/MK3.9/MK3.5/MINI/XL/CORE One | PrusaLink HTTP | Scan | Live status | Digest login or API key |
| Prusa MK3S / MK2.5 | PrusaLink via Raspberry Pi | Scan | Live status | |
| OctoPrint (any printer behind it) | HTTP + API key | Scan | Live status | |
| Klipper / Moonraker (Voron, RatRig, QIDI, Sovol, Creality K1, Snapmaker U1, many Anycubic and Elegoo Klipper models) | HTTP, ports 7125 / 80 / 4408 | Scan | Live status | Detection widened to ports 80 and 4408 |
| Elegoo Centauri Carbon and other SDCP models | UDP discovery (3000), WebSocket (3030) | Automatic | Live status | Simulated only. SDCP has no authentication |
| Duet / RepRapFirmware (standalone) | HTTP `/rr_model` | Scan | State and progress | Simulated only. Temperatures and password-protected boards not yet supported |

## Not yet supported (candidates, in suggested order)
1. **Creality K2 / Hi and other Creality models**: check which expose Moonraker or another local API (needs a unit to test).
2. **Flashforge** (Adventurer 3/4/5M, Guider): local TCP/HTTP interfaces exist; needs a unit to test.
3. **Snapmaker J1 and A150/A250/A350**: Luban HTTP API with a token.
4. **Duet in SBC mode** and password-protected Duet boards.
5. **Repetier-Server, AstroPrint, others** by demand.
6. **Anycubic stock firmware, stock Creality/Ender:** no local interface; only possible through a vendor cloud, which is out of scope for now.

## Adding a new printer type
1. Add the adapter (discovery plus status) to `printers.js` and keep it dependency-free if possible.
2. Wire it into `discoverPrinters()` and `fetchPrinterStatus()` in `server.js`, and add the type to the allowed list for `/api/test-printer`.
3. Teach `calculator.js` the default name and manufacturer for the new type.
4. Add a simulated-printer test to `test/printers.test.js`.
5. Update this table.
