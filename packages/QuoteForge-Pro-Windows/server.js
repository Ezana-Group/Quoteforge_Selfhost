// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Ovid International Ltd. See LICENSE.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const PRINTERS = require('./printers');

// "mqtt" is only needed for live Bambu Lab printer status, so it's an
// optional dependency loaded on first use. Everything else works without it
// (e.g. `npm install --omit=optional`, or a failed optional install).
let mqttLib;
function getMqtt() {
  if (mqttLib === undefined) {
    try { mqttLib = require('mqtt'); } catch (e) { mqttLib = null; }
  }
  return mqttLib;
}

let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

// Which network interface to listen on. Defaults to loopback so only this
// machine can reach the app — QuoteForge has no login, and its data (jobs,
// customers, printer passwords/API keys) must not be readable by anyone else
// on the same Wi-Fi. The Docker image sets HOST=0.0.0.0 because a container
// has to listen on all of its interfaces to be reachable; set HOST yourself
// (e.g. HOST=0.0.0.0) only if you're deliberately serving other machines and
// have put your own authentication in front of it.
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];
const LOOPBACK_ONLY = LOOPBACK_NAMES.includes(HOST);

// Optional password. If QUOTEFORGE_PASSWORD is set, every request must carry
// it (HTTP Basic auth — the browser shows a login box). The username defaults
// to "quoteforge" (override with QUOTEFORGE_USER). Basic auth sends the
// password unencrypted over plain HTTP, so when serving beyond a trusted
// network put HTTPS in front (reverse proxy), or use a VPN / Tailscale.
const AUTH_USER = process.env.QUOTEFORGE_USER || 'quoteforge';
const AUTH_PASSWORD = process.env.QUOTEFORGE_PASSWORD || '';

function sha256(text) { return crypto.createHash('sha256').update(String(text)).digest(); }
// Compares via fixed-length hashes with timingSafeEqual so response time
// doesn't reveal how much of a guess was right.
function safeEqual(a, b) { return crypto.timingSafeEqual(sha256(a), sha256(b)); }

function authState(req) {
  if (!AUTH_PASSWORD) return 'ok';
  const header = req.headers.authorization || '';
  if (!/^Basic /i.test(header)) return 'missing';
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); } catch (e) { return 'wrong'; }
  const sep = decoded.indexOf(':');
  if (sep < 0) return 'wrong';
  const userOk = safeEqual(decoded.slice(0, sep), AUTH_USER);
  const passOk = safeEqual(decoded.slice(sep + 1), AUTH_PASSWORD);
  return userOk && passOk ? 'ok' : 'wrong';
}

// Store saved jobs/settings in a stable folder — NOT inside the app's own
// folder. This means the data survives no matter where you unzip a future
// update to, or which port the server happens to pick. Override with
// DATA_DIR (used by the Docker image, which mounts a volume here) so
// self-hosted data persists across container restarts/upgrades.
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.quoteforge');
const DATA_FILE = path.join(DATA_DIR, 'app-data.json');

function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ config: {}, history: [] }));
  } catch (err) {
    console.error('Could not set up data file:', err.message);
  }
}
ensureDataFile();

// ---------------------------------------------------------------------------
// Safe persistence
//
// Everything lives in one JSON file, so a crash or power cut in the middle of
// a plain overwrite would take ALL jobs and settings with it. Instead:
//  - each save is written to a temp file and renamed into place (atomic — the
//    data file is always either the old version or the new one, never half);
//  - the previous version is kept as app-data.json.bak;
//  - the first save of each day also snapshots the pre-save state into
//    backups/ (last 7 days kept);
//  - if the data file is ever found unreadable, it is moved aside
//    (app-data.corrupt-<time>.json) and the newest valid backup is restored.
// ---------------------------------------------------------------------------
const fsp = fs.promises;
const BAK_FILE = DATA_FILE + '.bak';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAILY_BACKUPS = 7;
const DAILY_BACKUP_RE = /^app-data-\d{4}-\d{2}-\d{2}\.json$/;

function localDateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isValidJson(text) {
  try { JSON.parse(text); return true; } catch (e) { return false; }
}

// Windows can briefly refuse to rename over a file that antivirus/indexing
// is touching — retry a few times before giving up.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!transient || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

async function snapshotDailyBackup() {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const snap = path.join(BACKUP_DIR, `app-data-${localDateStamp()}.json`);
    try { await fsp.access(snap); return; } catch (e) { /* none yet today */ }
    await fsp.copyFile(DATA_FILE, snap);
    const old = (await fsp.readdir(BACKUP_DIR)).filter((f) => DAILY_BACKUP_RE.test(f)).sort().reverse().slice(KEEP_DAILY_BACKUPS);
    await Promise.all(old.map((f) => fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {})));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Daily backup skipped:', err.message);
  }
}

async function writeDataFile(body) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, body);
    // Keep the version we're about to replace (best effort — never block a save).
    await snapshotDailyBackup();
    try { await fsp.copyFile(DATA_FILE, BAK_FILE); } catch (e) { /* first ever save */ }
    await renameWithRetry(tmp, DATA_FILE);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Saves run strictly one after another, in the order they arrived, so two
// quick saves can never interleave.
let saveChain = Promise.resolve();
function saveDataSafely(body) {
  const run = saveChain.then(() => writeDataFile(body));
  saveChain = run.catch(() => {});
  return run;
}

async function readDataWithRecovery() {
  let primary = null;
  try { primary = await fsp.readFile(DATA_FILE, 'utf-8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (primary === null) return { content: JSON.stringify({ config: {}, history: [] }), recoveredFrom: null };
  if (isValidJson(primary)) return { content: primary, recoveredFrom: null };

  // The data file is unreadable. Keep it for inspection, then fall back.
  const aside = path.join(DATA_DIR, `app-data.corrupt-${Date.now()}.json`);
  try { await fsp.rename(DATA_FILE, aside); } catch (e) { /* ignore */ }
  console.warn(`⚠️  ${DATA_FILE} was unreadable — moved to ${aside}. Looking for a backup...`);

  const candidates = [BAK_FILE];
  try {
    const snaps = (await fsp.readdir(BACKUP_DIR)).filter((f) => DAILY_BACKUP_RE.test(f)).sort().reverse();
    snaps.forEach((f) => candidates.push(path.join(BACKUP_DIR, f)));
  } catch (e) { /* no backups folder */ }

  for (const file of candidates) {
    try {
      const content = await fsp.readFile(file, 'utf-8');
      if (!isValidJson(content)) continue;
      await writeDataFile(content);
      console.warn(`✅ Restored saved data from ${file}`);
      return { content, recoveredFrom: file };
    } catch (e) { /* try the next one */ }
  }
  console.warn('No valid backup found — starting with empty data. The unreadable file was kept as ' + aside);
  return { content: JSON.stringify({ config: {}, history: [] }), recoveredFrom: null };
}

// ===== Local network printer discovery =====
//
// Honest scope: there is no single "3D printer discovery protocol" — it
// depends entirely on what's running the printer. This covers the two
// open, self-hostable ecosystems with documented local HTTP APIs that a
// plain HTTP probe can identify without any new dependencies:
//   - OctoPrint  (probes :80 and :5000, GET /api/version)
//   - Moonraker/Klipper (probes :7125, GET /printer/info)
// Bambu Lab, Prusa Connect/PrusaLink, and most closed-firmware printers
// use proprietary or cloud-mediated protocols (MQTT+TLS with per-printer
// access codes, cloud APIs, etc.) that can't be reliably auto-discovered
// this way — those would need printer-specific integrations later.
//
// This only works when the server can actually reach the printers' LAN:
// fine for the portable/local-run mode, but if self-hosting via Docker
// with the default bridge network, the container can't see the host's
// LAN — docker-compose would need `network_mode: host` for this to find
// anything (documented in the README).

function probeHttp(ip, port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: urlPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

function getLocalSubnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  Object.values(nets).forEach((ifaceList) => {
    (ifaceList || []).forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        subnets.push({ base: `${parts[0]}.${parts[1]}.${parts[2]}`, selfIp: iface.address });
      }
    });
  });
  return subnets;
}

async function discoverPrinters(extraBases = []) {
  const subnets = getLocalSubnets();
  extraBases.slice(0, 3).forEach((base) => {
    if (!subnets.some((s) => s.base === base)) subnets.push({ base, selfIp: '' });
  });

  // Bambu Lab and Elegoo printers announce themselves over UDP rather than
  // answering a web request, so listen for them while the HTTP scan runs.
  const udpDiscovery = Promise.all([
    PRINTERS.listenForBambu({ listenMs: 5500 }),
    PRINTERS.discoverSdcp({ listenMs: 2000 }),
  ]).catch(() => [[], []]);

  const found = [];
  const timeoutMs = 350;
  const candidates = [];
  subnets.forEach(({ base }) => {
    for (let host = 1; host <= 254; host++) {
      candidates.push(`${base}.${host}`);
    }
  });

  // Scan with limited concurrency so this doesn't open hundreds of
  // sockets at once.
  const concurrency = 30;
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const ip = candidates[cursor++];
      const [port80, port5000, moonraker, moonraker80, moonraker4408, duet] = await Promise.all([
        probeHttp(ip, 80, '/api/version', timeoutMs),
        probeHttp(ip, 5000, '/api/version', timeoutMs),
        probeHttp(ip, 7125, '/printer/info', timeoutMs),
        // Fluidd/Mainsail pass these requests through to Moonraker on port 80,
        // and many Creality K1 / vendor Klipper images use port 4408.
        probeHttp(ip, 80, '/printer/info', timeoutMs),
        probeHttp(ip, 4408, '/printer/info', timeoutMs),
        probeHttp(ip, 80, '/rr_model?key=state.status', timeoutMs),
      ]);

      // OctoPrint and PrusaLink both answer GET /api/version on port 80
      // with different JSON shapes — OctoPrint's has a "server"/"text"
      // like "OctoPrint 1.x.x"; PrusaLink's (per its OpenAPI spec)
      // always includes "printer" and "firmware" fields alongside
      // "text". Check both candidates (80 first, then 5000 as
      // OctoPrint's common alt port) and classify by shape rather than
      // assuming which one answered.
      [port80, port5000].forEach((resp, i) => {
        if (!resp.ok || !resp.body) return;
        const respPort = i === 0 ? 80 : 5000;
        let parsed = null;
        try { parsed = JSON.parse(resp.body); } catch (e) { /* not JSON */ }
        if (!parsed) return;

        // Moonraker imitates OctoPrint's /api/version; don't count that as OctoPrint.
        if (/octoprint/i.test(resp.body) && !/moonraker/i.test(resp.body)) {
          found.push({ ip, port: respPort, apiType: 'octoprint', label: `OctoPrint @ ${ip}:${respPort}` });
        } else if (parsed.printer && parsed.firmware) {
          found.push({ ip, port: respPort, apiType: 'prusalink', label: `PrusaLink @ ${ip}:${respPort}${parsed.printer ? ` (${parsed.printer})` : ''}` });
        }
      });

      for (const [resp, mPort] of [[moonraker, 7125], [moonraker80, 80], [moonraker4408, 4408]]) {
        if (!resp.ok || !resp.body) continue;
        const parsed = safeJson(resp.body);
        if (parsed && parsed.result && typeof parsed.result === 'object') {
          found.push({ ip, port: mPort, apiType: 'moonraker', label: `Klipper/Moonraker @ ${ip}:${mPort}` });
          break; // one entry per printer
        }
      }

      if (duet.ok && duet.body && PRINTERS.isDuetResponse(safeJson(duet.body))) {
        found.push({ ip, port: 80, apiType: 'duet', label: `Duet / RepRapFirmware @ ${ip}` });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const [bambuList, sdcpList] = await udpDiscovery;
  bambuList.forEach((b) => {
    const modelText = [b.model, b.name && `"${b.name}"`].filter(Boolean).join(' ');
    found.push({
      ip: b.ip, port: 8883, apiType: 'bambu', serial: b.serial, model: b.model, name: b.name, lanMode: b.lanMode,
      label: `Bambu Lab ${modelText} @ ${b.ip} · LAN Only Mode ${b.lanMode ? 'is ON' : 'is OFF (turn it on to connect)'}`,
    });
  });
  sdcpList.forEach((d) => {
    const modelText = [d.brand, d.model || d.name].filter(Boolean).join(' ');
    found.push({
      ip: d.ip, port: 3030, apiType: 'sdcp', serial: d.mainboardId, model: d.model, name: d.name, brand: d.brand,
      label: `${modelText} (Elegoo SDCP) @ ${d.ip}`,
    });
  });

  return { subnetsScanned: subnets.map((s) => `${s.base}.0/24`), printers: found };
}

// ===== Live printer status =====
//
// Polls a saved printer's own local API for its current state — separate
// from discovery, and only runs for a printer that already has
// networkApiType set (i.e. was added via Scan Network or the Bambu form).
// OctoPrint/PrusaLink/Moonraker use only Node's built-in http/https/crypto
// (no dependency). Bambu Lab support (this is QuoteForge Pro) uses the
// `mqtt` package, since its protocol is MQTT over TLS — this is the one
// feature that requires `npm install` before first run, which is why it
// lives in this Pro variant rather than the dependency-free base version.

function httpRequest(options, timeoutMs) {
  return new Promise((resolve) => {
    const lib = options.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(timeoutMs || 4000);
    req.end();
  });
}

// Minimal HTTP Digest auth (RFC 7616-ish, MD5 — what PrusaLink implements):
// make an unauthenticated request, read the WWW-Authenticate challenge,
// compute the response, retry once with the Authorization header.
async function digestRequest(host, port, urlPath, username, password, timeoutMs) {
  const first = await httpRequest({ host, port, path: urlPath, method: 'GET' }, timeoutMs);
  if (first.status !== 401 || !first.headers['www-authenticate']) return first;

  const authHeader = first.headers['www-authenticate'];
  const getParam = (name) => {
    const m = authHeader.match(new RegExp(`${name}="?([^",]+)"?`));
    return m ? m[1] : '';
  };
  const realm = getParam('realm');
  const nonce = getParam('nonce');
  const qop = getParam('qop');
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`GET:${urlPath}`).digest('hex');
  const response = qop
    ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
    : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');

  const authValue = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${urlPath}", ` +
    (qop ? `qop=${qop}, nc=${nc}, cnonce="${cnonce}", ` : '') + `response="${response}"`;

  return httpRequest({ host, port, path: urlPath, method: 'GET', headers: { Authorization: authValue } }, timeoutMs);
}

function safeJson(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// Bambu Lab local status via MQTT over TLS (port 8883). Bambu's LAN-mode
// protocol: connect as user "bblp" with the printer's Access Code as the
// password, publish a "pushall" request, then read the full status off
// the printer's own report topic. The printer's TLS cert is self-signed
// (there's no public CA involved in a LAN-only connection), so
// rejectUnauthorized is intentionally off here — this is the same trust
// model OctoPrint/PrusaLink get on plain HTTP, just wrapped in TLS.
function fetchBambuStatus(ip, serial, accessCode, timeoutMs) {
  return new Promise((resolve) => {
    const mqtt = getMqtt();
    if (!mqtt) {
      resolve({ ok: false, error: 'Live Bambu Lab status needs the optional "mqtt" package. Run "npm install" in the QuoteForge folder (without --omit=optional) and restart.' });
      return;
    }
    let settled = false;
    let client;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (client) client.end(true);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Timed out waiting for the printer — double check the IP, serial number, and access code, and that LAN Only Mode + Developer Mode are on.' });
    }, timeoutMs);

    try {
      client = mqtt.connect(`mqtts://${ip}:8883`, {
        username: 'bblp',
        password: accessCode,
        rejectUnauthorized: false,
        reconnectPeriod: 0,
        connectTimeout: timeoutMs,
      });
    } catch (e) {
      finish({ ok: false, error: 'Could not start MQTT connection: ' + e.message });
      return;
    }

    client.on('connect', () => {
      const reportTopic = `device/${serial}/report`;
      client.subscribe(reportTopic, (err) => {
        if (err) { finish({ ok: false, error: 'Could not subscribe to printer status: ' + err.message }); return; }
        client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
      });
    });

    client.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        const p = data.print;
        if (p && (p.gcode_state || p.mc_percent != null)) {
          finish({
            ok: true,
            state: (p.gcode_state || 'unknown').toLowerCase(),
            progressPercent: p.mc_percent != null ? p.mc_percent : null,
            fileName: p.subtask_name || '',
            nozzleTemp: p.nozzle_temper != null ? Math.round(p.nozzle_temper) : null,
            nozzleTarget: p.nozzle_target_temper != null ? Math.round(p.nozzle_target_temper) : null,
            bedTemp: p.bed_temper != null ? Math.round(p.bed_temper) : null,
            bedTarget: p.bed_target_temper != null ? Math.round(p.bed_target_temper) : null,
            timeRemainingMin: p.mc_remaining_time != null ? p.mc_remaining_time : null,
          });
        }
      } catch (e) { /* partial/non-JSON message — wait for the next one */ }
    });

    client.on('error', (err) => {
      finish({ ok: false, error: 'Could not connect: ' + err.message + ' — check LAN Only Mode and Developer Mode are enabled on the printer.' });
    });
  });
}

async function fetchPrinterStatus(printer) {
  const timeoutMs = 4000;
  const { networkAddress: ip, networkPort: port, networkApiType: apiType } = printer;

  if (!ip || !apiType) {
    return { ok: false, error: 'This printer has no saved network connection — add it via Scan Network or the Bambu Lab form.' };
  }

  if (apiType === 'bambu') {
    if (!printer.networkSerial || !printer.networkAccessCode) {
      return { ok: false, error: 'This Bambu Lab printer is missing its serial number or access code — edit the printer to add them.' };
    }
    return fetchBambuStatus(ip, printer.networkSerial, printer.networkAccessCode, 6000);
  }

  if (apiType === 'moonraker') {
    const res = await httpRequest({ host: ip, port, path: '/printer/objects/query?print_stats&display_status&extruder&heater_bed', method: 'GET' }, timeoutMs);
    if (!res.ok || res.status !== 200) return { ok: false, error: `Moonraker didn't respond (${res.error || res.status || 'unreachable'})` };
    const data = safeJson(res.body);
    const status = data && data.result && data.result.status;
    if (!status) return { ok: false, error: 'Unexpected response from Moonraker' };
    return {
      ok: true,
      state: (status.print_stats && status.print_stats.state) || 'unknown',
      progressPercent: status.display_status ? Math.round((status.display_status.progress || 0) * 100) : null,
      fileName: (status.print_stats && status.print_stats.filename) || '',
      nozzleTemp: status.extruder ? Math.round(status.extruder.temperature) : null,
      nozzleTarget: status.extruder ? Math.round(status.extruder.target) : null,
      bedTemp: status.heater_bed ? Math.round(status.heater_bed.temperature) : null,
      bedTarget: status.heater_bed ? Math.round(status.heater_bed.target) : null,
    };
  }

  if (apiType === 'octoprint') {
    if (!printer.networkApiKey) return { ok: false, error: 'This OctoPrint printer needs an API key — add it by editing the printer (find it in OctoPrint under Settings → API).' };
    const headers = { 'X-Api-Key': printer.networkApiKey };
    const [jobRes, printerRes] = await Promise.all([
      httpRequest({ host: ip, port, path: '/api/job', method: 'GET', headers }, timeoutMs),
      httpRequest({ host: ip, port, path: '/api/printer', method: 'GET', headers }, timeoutMs),
    ]);
    if (!jobRes.ok || jobRes.status !== 200) return { ok: false, error: `OctoPrint didn't respond (${jobRes.error || jobRes.status || 'unreachable'}) — check the API key` };
    const job = safeJson(jobRes.body) || {};
    const printerData = printerRes.ok && printerRes.status === 200 ? safeJson(printerRes.body) : null;
    const temps = printerData && printerData.temperature;
    return {
      ok: true,
      state: (job.state || 'Unknown').toLowerCase(),
      progressPercent: job.progress && job.progress.completion != null ? Math.round(job.progress.completion) : null,
      fileName: job.job && job.job.file ? job.job.file.name : '',
      nozzleTemp: temps && temps.tool0 ? Math.round(temps.tool0.actual) : null,
      nozzleTarget: temps && temps.tool0 ? Math.round(temps.tool0.target) : null,
      bedTemp: temps && temps.bed ? Math.round(temps.bed.actual) : null,
      bedTarget: temps && temps.bed ? Math.round(temps.bed.target) : null,
    };
  }

  if (apiType === 'prusalink') {
    let res;
    if (printer.networkUsername && printer.networkPassword) {
      res = await digestRequest(ip, port, '/api/printer', printer.networkUsername, printer.networkPassword, timeoutMs);
    } else if (printer.networkApiKey) {
      res = await httpRequest({ host: ip, port, path: '/api/printer', method: 'GET', headers: { 'X-Api-Key': printer.networkApiKey } }, timeoutMs);
    } else {
      return { ok: false, error: 'This PrusaLink printer needs credentials — add its username/password (or legacy API key) by editing the printer.' };
    }
    if (!res.ok || res.status !== 200) return { ok: false, error: `PrusaLink didn't respond (${res.error || res.status || 'unreachable'}) — check the username/password` };
    const data = safeJson(res.body);
    if (!data) return { ok: false, error: 'Unexpected response from PrusaLink' };
    const temp = data.telemetry || {};
    return {
      ok: true,
      state: (data.state || data.printer_state || 'unknown').toString().toLowerCase(),
      progressPercent: temp['print-progress'] != null ? Math.round(temp['print-progress']) : null,
      fileName: '',
      nozzleTemp: temp['temp-nozzle'] != null ? Math.round(temp['temp-nozzle']) : null,
      bedTemp: temp['temp-bed'] != null ? Math.round(temp['temp-bed']) : null,
    };
  }

  if (apiType === 'sdcp') {
    return PRINTERS.fetchSdcpStatus(ip, port || 3030, printer.networkSerial || '', timeoutMs + 2000);
  }

  if (apiType === 'duet') {
    return PRINTERS.fetchDuetStatus(ip, port || 80, timeoutMs);
  }

  return { ok: false, error: `Unknown printer connection type: ${apiType}` };
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.stl': 'application/octet-stream',
  '.obj': 'application/octet-stream',
  '.3mf': 'application/octet-stream'
};

// Security headers sent on every response.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  // Tight CSP: only same-origin scripts/styles, no inline eval, no external
  // connections. Adjust if you add a CDN or external font later.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';",
};

// Simple in-memory brute-force throttle for wrong Basic-auth attempts.
// Tracks failed attempts per IP; after MAX_FAILS within WINDOW_MS the IP is
// locked for LOCKOUT_MS. Only active when AUTH_PASSWORD is set.
const failedAuths = new Map(); // ip → { count, firstAt, lockedUntil }
const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_MS = 60_000;   // 1 min
const AUTH_LOCKOUT_MS = 300_000; // 5 min

function checkAuthThrottle(ip) {
  if (!AUTH_PASSWORD) return 'ok';
  const now = Date.now();
  const rec = failedAuths.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (rec.lockedUntil > now) return 'locked';
  if (now - rec.firstAt > AUTH_WINDOW_MS) {
    // Window expired — reset.
    rec.count = 0; rec.firstAt = now; rec.lockedUntil = 0;
  }
  return 'ok';
}

function recordAuthFailure(ip) {
  if (!AUTH_PASSWORD) return;
  const now = Date.now();
  const rec = failedAuths.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (now - rec.firstAt > AUTH_WINDOW_MS) { rec.count = 0; rec.firstAt = now; rec.lockedUntil = 0; }
  rec.count++;
  if (rec.count >= AUTH_MAX_FAILS) rec.lockedUntil = now + AUTH_LOCKOUT_MS;
  failedAuths.set(ip, rec);
}

// Periodically prune stale entries so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of failedAuths) {
    if (now - rec.firstAt > AUTH_WINDOW_MS * 2 && rec.lockedUntil < now) failedAuths.delete(ip);
  }
}, 10 * 60_000).unref();

function startServer(p) {
  const server = http.createServer((req, res) => {
    // Attach security headers to every response up-front.
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    // When listening on loopback only, also refuse requests that a web page
    // in the user's own browser could make to this local server:
    //  - a Host header that isn't localhost/127.0.0.1 (DNS-rebinding), and
    //  - a state-changing request whose Origin isn't this server (another
    //    website POSTing to /api/data or /api/shutdown).
    // The app's own requests are same-origin, so they pass.
    if (LOOPBACK_ONLY) {
      const hostName = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
      let blocked = !LOOPBACK_NAMES.includes(hostName);
      const origin = req.headers.origin;
      if (!blocked && origin && req.method !== 'GET' && req.method !== 'HEAD') {
        try { blocked = new URL(origin).host !== req.headers.host; } catch (e) { blocked = true; }
      }
      if (blocked) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
    }

    // Liveness probe for Docker / reverse proxies / uptime monitors. Deliberately
    // answers without a password and reveals nothing (no data, no version).
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.url || '').split('?')[0] === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : '{"status":"ok"}');
      return;
    }

    const clientIp = req.socket.remoteAddress || 'unknown';
    // Brute-force check before even testing credentials.
    if (checkAuthThrottle(clientIp) === 'locked') {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(Math.ceil(AUTH_LOCKOUT_MS / 1000)) });
      res.end('Too many failed attempts — try again later');
      return;
    }

    const auth = authState(req);
    if (auth !== 'ok') {
      const challenge = () => {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="QuoteForge", charset="UTF-8"' });
        res.end('Authentication required');
      };
      // Record failure and apply the timing delay so each wrong guess costs ~400ms.
      if (auth === 'wrong') { recordAuthFailure(clientIp); setTimeout(challenge, 400); } else challenge();
      return;
    }

    // Decode URI to support spaces and special characters in filenames
    let decodedUrl = '';
    try {
      decodedUrl = decodeURIComponent(req.url);
    } catch (e) {
      decodedUrl = req.url;
    }

    // Strip query parameters
    const parsedPath = decodedUrl.split('?')[0];

    // Saved jobs & settings — stored on disk in the user's home directory
    // (see DATA_FILE above), not in the browser, so it survives across
    // port changes and future app updates.
    // Lets the "Quit App" button in the UI stop the server cleanly —
    // useful now that the Mac app has no Dock icon to quit from.
    if (parsedPath === '/api/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting down' }));
      setTimeout(() => process.exit(0), 250);
      return;
    }

    if (parsedPath === '/api/discover-printers' && req.method === 'GET') {
      // Optional ?subnet=192.168.5 to also scan a network the server isn't on
      // directly (e.g. a printer VLAN). Private ranges only.
      const subnetParam = new URLSearchParams(decodedUrl.split('?')[1] || '').get('subnet');
      const extraBase = subnetParam ? PRINTERS.parseSubnetBase(subnetParam) : null;
      if (subnetParam && !extraBase) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Enter a private network like 192.168.5.0/24', subnetsScanned: [], printers: [] }));
        return;
      }
      discoverPrinters(extraBase ? [extraBase] : []).then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, subnetsScanned: [], printers: [] }));
      });
      return;
    }

    // "Test connection" for a printer that hasn't been saved yet. Only private
    // network addresses are allowed, so this can't be used to probe the internet.
    if (parsedPath === '/api/test-printer' && req.method === 'POST') {
      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => { if (tooLarge) return; body += chunk; if (body.length > 16384) tooLarge = true; });
      req.on('end', () => {
        const fail = (code, message) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: message })); };
        if (tooLarge) return fail(413, 'Request too large');
        let d;
        try { d = JSON.parse(body); } catch (e) { return fail(400, 'Invalid request'); }
        const types = ['bambu', 'moonraker', 'octoprint', 'prusalink', 'sdcp', 'duet'];
        if (!d || !types.includes(d.apiType)) return fail(400, 'Unknown printer type');
        if (!PRINTERS.isPrivateIPv4(d.ip)) return fail(400, 'Enter the printer\'s local IP address (for example 192.168.1.42).');
        const port = d.port == null || d.port === '' ? null : Number(d.port);
        if (port != null && !(Number.isInteger(port) && port > 0 && port < 65536)) return fail(400, 'Invalid port');
        fetchPrinterStatus({
          networkAddress: d.ip, networkPort: port, networkApiType: d.apiType,
          networkSerial: String(d.serial || ''), networkAccessCode: String(d.accessCode || ''),
          networkApiKey: String(d.apiKey || ''), networkUsername: String(d.username || ''), networkPassword: String(d.password || ''),
        }).then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }).catch((err) => fail(500, err.message));
      });
      return;
    }

    if (parsedPath === '/api/printer-status' && req.method === 'GET') {
      const queryStr = decodedUrl.split('?')[1] || '';
      const printerId = new URLSearchParams(queryStr).get('id');
      readDataWithRecovery().then(({ content }) => {
        let data;
        try { data = JSON.parse(content); } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Saved data is corrupted' }));
          return;
        }
        const printers = (data.config && data.config.printers) || [];
        const printer = printers.find((p) => p.id === printerId);
        if (!printer) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Printer not found' }));
          return;
        }
        fetchPrinterStatus(printer).then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }).catch((fetchErr) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: fetchErr.message }));
        });
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Could not read saved printers' }));
      });
      return;
    }

    if (parsedPath === '/api/data') {
      if (req.method === 'GET') {
        readDataWithRecovery().then(({ content, recoveredFrom }) => {
          const headers = { 'Content-Type': 'application/json' };
          if (recoveredFrom) headers['X-QuoteForge-Recovered-From'] = path.basename(recoveredFrom);
          res.writeHead(200, headers);
          res.end(content);
        }).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        });
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        let tooLarge = false;
        // Cap body size to guard against a runaway/malicious client
        // exhausting memory — 25MB is generous for this app's actual
        // data (jobs + a handful of compressed base64 images/logos),
        // while still stopping an unbounded upload cold.
        const MAX_BODY_BYTES = 25 * 1024 * 1024;
        req.on('data', (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (body.length > MAX_BODY_BYTES) {
            tooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Payload too large' }));
            req.destroy();
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            JSON.parse(body); // validate before writing
            saveDataSafely(body).then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'success' }));
            }).catch((err) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'error', message: err.message }));
            });
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    // Default to serving bundled files from inside the EXE
    let baseDir = __dirname;
    let filePath = path.join(baseDir, parsedPath === '/' ? 'index.html' : parsedPath);
    
    // Allow overriding config.json if placed next to the EXE
    if (parsedPath === '/config.json') {
      const localConfigPath = path.join(process.cwd(), 'config.json');
      if (fs.existsSync(localConfigPath)) {
        filePath = localConfigPath;
        baseDir = process.cwd(); // allow passing the traversal check
      }
    }
    
    // Prevent directory traversal. path.join() already collapses "../"
    // segments, but comparing with a plain filePath.startsWith(baseDir)
    // has a well-known bypass: a sibling directory that happens to share
    // baseDir as a *string prefix* (e.g. baseDir "/app/quoteforge" vs a
    // sibling "/app/quoteforge-evil") would incorrectly pass, since
    // "/app/quoteforge-evil".startsWith("/app/quoteforge") is true even
    // though it's a different directory. Checking against baseDir *plus
    // a path separator* (or an exact match) closes that gap.
    const normalizedBase = path.normalize(baseDir);
    const normalizedFile = path.normalize(filePath);
    if (normalizedFile !== normalizedBase && !normalizedFile.startsWith(normalizedBase + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden: Directory traversal is not allowed.');
      return;
    }

    // Only the app's own front-end files are served. Without this, anything in
    // the install folder (server.js, package.json, tests, launchers...) would
    // be downloadable by whoever can reach the port.
    const rel = path.relative(baseDir, normalizedFile).split(path.sep).join('/');
    const STATIC_FILES = new Set([
      'index.html', 'styles.css', 'calculator.js', 'multi-part-import.js',
      'reports.js', 'config.json',
      // PWA + desktop app assets
      'manifest.json', 'sw.js',
    ]);
    if (!STATIC_FILES.has(rel) && !rel.startsWith('vendor/') && !rel.startsWith('icons/') && !rel.startsWith('docs/screenshots/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`500 Internal Server Error: ${err.code}`);
        }
      } else {
        // Prevent browser caching for local configuration files so edits take effect immediately
        const headers = { 'Content-Type': contentType };
        if (ext === '.json') {
          headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
        }
        res.writeHead(200, headers);
        res.end(content, 'utf-8');
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${p} is in use, trying port ${p + 1}...`);
      startServer(p + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(p, HOST, () => {
    const url = `http://localhost:${p}`;
    console.log(`\n======================================================`);
    console.log(`🚀 QuoteForge running!`);
    console.log(`🌍 Address: ${url}`);
    console.log(`📂 Working Directory: ${process.cwd()}`);
    console.log(`💾 Data Directory: ${DATA_DIR}`);
    if (AUTH_PASSWORD) {
      console.log(`🔒 Password protection is ON (username: ${AUTH_USER}).`);
      if (AUTH_PASSWORD.length < 8) console.log('⚠️  That password is short — use at least 8 characters.');
      if (!LOOPBACK_ONLY) console.log('⚠️  The password travels unencrypted over plain HTTP. Put HTTPS in front of this (reverse proxy), or use a VPN / Tailscale, if it leaves a trusted network.');
    } else if (!LOOPBACK_ONLY) {
      console.log(`⚠️  Listening on ${HOST} — other devices on your network can reach this app, and it has no login. Set QUOTEFORGE_PASSWORD, or only do this on a trusted network.`);
    }
    console.log(`⚙️  Edit config.json to change material rates or margins.`);
    console.log(`======================================================\n`);

    // Skip auto-opening a browser when running headless (Docker, a server,
    // CI) — there's nothing to open it in, and it would just log a
    // harmless-but-noisy error. IS_DOCKER / NO_BROWSER can also be set
    // explicitly to opt out.
    const isContainer = fs.existsSync('/.dockerenv') || process.env.NO_BROWSER || process.env.IS_DOCKER;
    if (isContainer) return;

    const startCommand = process.platform === 'darwin' 
      ? `open "${url}"` 
      : process.platform === 'win32' 
        ? `start ${url}` 
        : `xdg-open "${url}"`;
    
    exec(startCommand, (error) => {
      if (error) {
        console.warn(`Could not launch browser automatically: ${error.message}`);
        console.log(`Please open your browser and navigate to: ${url}`);
      }
    });
  });
}

startServer(port);
