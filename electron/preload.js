// SPDX-License-Identifier: AGPL-3.0-only
// Preload script — runs in the renderer context before the page loads.
// contextIsolation is ON, nodeIntegration is OFF, so this is the only
// place we can safely bridge Electron APIs to the page if ever needed.
// Currently there is nothing to bridge — the app talks only to its own
// local HTTP server via fetch(), which works without any bridging.
'use strict';

// Keep this file as a placeholder so webPreferences.preload has a valid target.
// Add contextBridge.exposeInMainWorld(...) calls here if you ever need
// native OS features (file dialogs, notifications, auto-update status, etc.)
// accessible from calculator.js.
