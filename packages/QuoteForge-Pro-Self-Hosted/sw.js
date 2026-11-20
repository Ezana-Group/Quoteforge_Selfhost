// SPDX-License-Identifier: AGPL-3.0-only
// Service Worker — caches the app shell so QuoteForge loads instantly and
// works offline (useful for the portable / desktop-app use-case).
// API calls (/api/*) are never cached — they always go to the live server.

'use strict';

const CACHE_NAME = 'quoteforge-shell-v1';

// Files that make up the app shell — cached on first install.
const SHELL_URLS = [
  '/',
  '/styles.css',
  '/calculator.js',
  '/multi-part-import.js',
  '/reports.js',
  '/vendor/jszip.min.js',
  '/manifest.json',
];

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)),
  );
  // Activate immediately — don't wait for existing tabs to close.
  self.skipWaiting();
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  // Take control of all open clients immediately.
  self.clients.claim();
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept:
  //  - non-GET requests (POST saves, printer API calls, etc.)
  //  - API routes — always need live data
  //  - cross-origin requests (shouldn't happen but be safe)
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.origin !== self.location.origin
  ) {
    return; // let the browser handle it normally
  }

  // Cache-first for shell assets; network-first for everything else.
  const isShell = SHELL_URLS.includes(url.pathname) || url.pathname === '/index.html';

  if (isShell) {
    event.respondWith(
      caches.match(request).then(
        (cached) => cached || fetch(request).then((res) => {
          // Update cache with fresh copy.
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        }),
      ),
    );
  } else {
    // Network-first with cache fallback for other static assets (fonts, icons).
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request)),
    );
  }
});
