# Changelog

All notable changes to QuoteForge Pro. Format: [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Configurable tax name (VAT, GST, Sales Tax, IVA...) shown on quotes, invoices, reports and settings.
- Payment methods list now includes Bank transfer, Card, Cash, PayPal and generic Mobile money (M-Pesa is still there).

- Bambu Lab printers are now found automatically by Scan Network (serial number and LAN-mode status included); only the access code needs typing.
- Support for Elegoo SDCP printers (discovery and live status) and Duet / RepRapFirmware boards (discovery, state and progress).
- Klipper/Moonraker detection also checks ports 80 and 4408, which covers more vendor Klipper printers.
- "Test connection" button on the Bambu form, and an option to scan another private network.
- `docs/PRINTER-SUPPORT.md` lists every supported printer family and how far each has been verified.

### Changed
- License changed from MIT to AGPL-3.0-only (before first release). SPDX/copyright headers added to the JavaScript source files.
- Dates on quotes, invoices and the job list follow the business's currency locale instead of a fixed `en-GB` or the viewer's browser.
- Neutral, international placeholder text in Settings and the payment forms.
- Scan results are HTML-escaped (a device on the network can no longer inject markup through its name), and PrusaLink printers are no longer labelled "Klipper" when added from a scan.
- Docker image runs as the unprivileged `node` user.
- The web server only serves the app's front-end files (not source, tests or package files).

## [1.0.0] - not yet released
- First public release.
