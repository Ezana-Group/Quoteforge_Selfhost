// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Ovid International Ltd. See LICENSE.
//
// Electron main process — wraps the existing Node HTTP server so QuoteForge
// runs as a native desktop app on macOS and Windows.
//
// Architecture:
//   1. Find a free localhost port (avoids clashes if the user has something on 8080).
//   2. Fork server.js as a child process on that port (HOST=127.0.0.1, NO_BROWSER=1).
//   3. Poll /healthz until the server is up, then open a BrowserWindow.
//   4. All data still goes to ~/.quoteforge — same location as the portable
//      (.bat/.command) launcher, so existing data migrates automatically.

'use strict';

const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');
const net  = require('net');
const os   = require('os');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Ask the OS for any free port on loopback, then release it immediately. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Poll GET /healthz until it returns 200 or we give up. */
function waitForServer(port, maxMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    function attempt() {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/healthz', timeout: 1000 },
        (res) => {
          if (res.statusCode === 200) return resolve(port);
          retry();
        },
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    }
    function retry() {
      if (Date.now() > deadline) return reject(new Error('QuoteForge server did not start in time'));
      setTimeout(attempt, 300);
    }
    attempt();
  });
}

// ─── State ──────────────────────────────────────────────────────────────────

let serverProcess = null;
let mainWindow    = null;
let serverPort    = null;

// ─── Server lifecycle ────────────────────────────────────────────────────────

async function launchServer() {
  serverPort = await getFreePort();

  const serverScript = path.join(__dirname, '..', 'server.js');

  serverProcess = fork(serverScript, [], {
    env: {
      ...process.env,
      PORT:       String(serverPort),
      HOST:       '127.0.0.1',
      NO_BROWSER: '1',
      // Keep the same data directory as the portable launcher so data
      // migrates seamlessly — no separate "Electron data" location.
      DATA_DIR:   process.env.DATA_DIR || path.join(os.homedir(), '.quoteforge'),
    },
    // Let stdout/stderr flow to the terminal (or Electron's log) so the
    // server's startup messages (port, data dir, security warnings) are visible.
    silent: false,
  });

  serverProcess.on('error', (err) => {
    console.error('[electron] Server process error:', err.message);
  });

  serverProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`[electron] Server exited with code ${code} (signal: ${signal})`);
    }
    serverProcess = null;
  });

  await waitForServer(serverPort);
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  serverProcess = null;
}

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1400,
    height:    900,
    minWidth:  900,
    minHeight: 600,
    title:     'QuoteForge Pro',
    // Icon paths — replace with real .icns / .ico files in icons/
    // icon: path.join(__dirname, '..', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.icns'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Explicitly block remote content from getting any extra privileges.
      webSecurity:      true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // Open every link that would leave localhost in the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App menu (macOS) ────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Data Folder',
          click() {
            shell.openPath(path.join(os.homedir(), '.quoteforge'));
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.NODE_ENV === 'development'
          ? [{ type: 'separator' }, { role: 'toggleDevTools' }]
          : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'QuoteForge on GitHub',
          click() { shell.openExternal('https://github.com/your-org/quoteforge-pro'); },
        },
        {
          label: 'Report a Bug',
          click() { shell.openExternal('https://github.com/your-org/quoteforge-pro/issues'); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  try {
    await launchServer();
    createWindow();
  } catch (err) {
    console.error('[electron] Startup failed:', err.message);
    dialog.showErrorBox(
      'QuoteForge Pro — Startup Error',
      `The local server could not start.\n\n${err.message}\n\nCheck that Node.js is installed and try again.`,
    );
    app.quit();
  }
});

// Re-create window on macOS when the dock icon is clicked and no windows open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
});

// On non-mac platforms quit when all windows are closed.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Always stop the server cleanly before the process exits.
app.on('before-quit', stopServer);
app.on('will-quit',   stopServer);
