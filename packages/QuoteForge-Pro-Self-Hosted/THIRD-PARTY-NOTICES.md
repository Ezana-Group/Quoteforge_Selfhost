# Third-party notices

QuoteForge Pro bundles or optionally uses these components. Each keeps its own license.

| Component | Where | License |
|---|---|---|
| JSZip 3.10.1 | `vendor/jszip.min.js` | MIT or GPL-3.0 (used here under MIT) |
| Inter font | `vendor/fonts` | SIL Open Font License 1.1 (text in `vendor/fonts/LICENSE-Inter.txt`) |
| JetBrains Mono font | `vendor/fonts` | SIL Open Font License 1.1 (text in `vendor/fonts/LICENSE-JetBrainsMono.txt`) |
| mqtt (optional dependency) | npm | MIT |

Before release, run a license check on the full npm dependency tree (for example `npx license-checker --production`) and confirm nothing conflicts with AGPL-3.0.
