// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Ovid International Ltd. See LICENSE.
"use strict";
// Printer discovery and status adapters that need more than a plain HTTP probe.
// Kept apart from server.js so each piece can be tested against a fake printer.
//
//   Bambu Lab   printers announce themselves on UDP 1990/2021 (SSDP-style broadcast).
//   Elegoo      SDCP printers answer a UDP "M99999" broadcast on port 3000 and
//               report status over a WebSocket on port 3030.
//   Duet        RepRapFirmware boards answer /rr_model over plain HTTP.
//
// Everything here uses Node's built-in modules only (no new dependencies).
// Protocol details come from public documentation and community write-ups and
// have been tested against simulated printers, not yet against every real model.

const dgram = require("dgram");
const net = require("net");
const http = require("http");
const crypto = require("crypto");

// ---------------------------------------------------------------- helpers
function isPrivateIPv4(ip) {
  if (typeof ip !== "string" || !net.isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// "192.168.5", "192.168.5.0" or "192.168.5.0/24" -> "192.168.5" (or null)
function parseSubnetBase(text) {
  const m = String(text || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.0(?:\/24)?)?$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map(Number);
  if (parts.some((n) => n > 255)) return null;
  const base = parts.join(".");
  return isPrivateIPv4(base + ".1") ? base : null;
}

function getJson(ip, port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: urlPath, timeout: timeoutMs || 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
        resolve({ ok: true, status: res.statusCode, json, body });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

// ------------------------------------------------------------- Bambu Lab
const BAMBU_MODELS = {
  "BL-P001": "X1 Carbon", "BL-P002": "X1", "C11": "P1P", "C12": "P1S",
  "N1": "A1 mini", "N2S": "A1", "O1D": "H2D",
};
function friendlyBambuModel(code) {
  const raw = String(code || "").trim();
  if (BAMBU_MODELS[raw]) return BAMBU_MODELS[raw];
  return raw.replace(/^3DPrinter-/i, "").replace(/-/g, " ");
}

function parseBambuAnnouncement(text, rinfo) {
  const h = {};
  String(text).split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  const looksBambu = /bambulab-com:device:3dprinter/i.test(h.nt || h.st || "") || h["devmodel.bambu.com"];
  if (!looksBambu || !h.usn) return null;
  const ip = net.isIPv4(h.location || "") ? h.location : (rinfo && rinfo.address);
  if (!ip) return null;
  return {
    ip,
    serial: h.usn,
    model: friendlyBambuModel(h["devmodel.bambu.com"]),
    name: h["devname.bambu.com"] || "",
    lanMode: (h["devconnect.bambu.com"] || "").toLowerCase() === "lan",
    firmware: h["devversion.bambu.com"] || "",
  };
}

// Listens for Bambu announcements (they repeat about every 5 seconds).
// Never throws: if a port is already taken (e.g. Bambu Studio is open) it is skipped.
function listenForBambu({ ports = [1990, 2021], listenMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    ports.forEach((port) => {
      let sock;
      try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); } catch (e) { return; }
      sockets.push(sock);
      sock.on("error", () => { try { sock.close(); } catch (e) { /* already closed */ } });
      sock.on("message", (msg, rinfo) => {
        const p = parseBambuAnnouncement(msg.toString("utf8"), rinfo);
        if (p && !found.has(p.serial)) found.set(p.serial, p);
      });
      try {
        sock.bind(port, "0.0.0.0", () => {
          try { sock.addMembership("239.255.255.250"); } catch (e) { /* multicast not available; broadcasts still arrive */ }
        });
      } catch (e) { /* port unavailable */ }
    });
    setTimeout(() => {
      sockets.forEach((s) => { try { s.close(); } catch (e) { /* already closed */ } });
      resolve([...found.values()]);
    }, listenMs);
  });
}

// ----------------------------------------------------------- Elegoo SDCP
function parseSdcpReply(buf, rinfo) {
  let j;
  try { j = JSON.parse(buf.toString("utf8")); } catch (e) { return null; }
  const d = j && (j.Data || j);
  if (!d || (!d.MainboardID && !d.MainboardIP)) return null;
  return {
    ip: net.isIPv4(d.MainboardIP || "") ? d.MainboardIP : rinfo.address,
    mainboardId: String(d.MainboardID || ""),
    name: d.Name || "",
    model: d.MachineName || "",
    brand: d.BrandName || "ELEGOO",
    firmware: d.FirmwareVersion || "",
  };
}

function discoverSdcp({ port = 3000, address = "255.255.255.255", listenMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket("udp4"); } catch (e) { resolve([]); return; }
    const finish = () => { try { sock.close(); } catch (e) { /* already closed */ } resolve([...found.values()]); };
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      const p = parseSdcpReply(msg, rinfo);
      if (p && !found.has(p.ip)) found.set(p.ip, p);
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
      sock.send(Buffer.from("M99999"), port, address, () => { /* replies arrive via 'message' */ });
    });
    setTimeout(finish, listenMs);
  });
}

function sdcpState(machine, printStatus) {
  if (printStatus === 13 || (machine && machine.includes(1))) return "printing";
  if (printStatus === 6) return "paused";
  if (printStatus === 9) return "complete";
  if (printStatus === 8) return "stopped";
  if (printStatus === 0 || (machine && machine.includes(0))) return "idle";
  return printStatus != null ? `status ${printStatus}` : "unknown";
}

function wsSend(sock, text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  sock.write(Buffer.concat([head, mask, masked]));
}

function wsReadFrame(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  const masked = (buf[1] & 0x80) !== 0;
  const maskLen = masked ? 4 : 0;
  if (len > 4 * 1024 * 1024) return { opcode: 8, payload: Buffer.alloc(0), length: buf.length, fin: true };
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.slice(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const key = buf.slice(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
  }
  return { opcode: buf[0] & 0x0f, fin: (buf[0] & 0x80) !== 0, payload, length: offset + maskLen + len };
}

function fetchSdcpStatus(ip, port, mainboardId, timeoutMs) {
  port = port || 3030;
  return new Promise((resolve) => {
    let done = false;
    let upgraded = false;
    let buf = Buffer.alloc(0);
    let pendingText = null;
    const sock = net.connect({ host: ip, port });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "Timed out waiting for the printer. Check the IP address and that it is powered on and on the same network." }), timeoutMs || 5000);
    sock.on("error", (e) => finish({ ok: false, error: "Could not connect: " + e.message }));
    sock.on("close", () => finish({ ok: false, error: "The printer closed the connection before sending its status." }));
    sock.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(`GET /websocket HTTP/1.1\r\nHost: ${ip}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const handleText = (text) => {
      let j;
      try { j = JSON.parse(text); } catch (e) { return; }
      const s = j && (j.Status || (j.Data && j.Data.Status));
      if (!s) return;
      const pi = s.PrintInfo || {};
      const machine = Array.isArray(s.CurrentStatus) ? s.CurrentStatus : (s.CurrentStatus != null ? [s.CurrentStatus] : []);
      finish({
        ok: true,
        state: sdcpState(machine, pi.Status),
        progressPercent: pi.Progress != null ? Math.round(pi.Progress) : null,
        fileName: pi.Filename || "",
        nozzleTemp: s.TempOfNozzle != null ? Math.round(s.TempOfNozzle) : null,
        nozzleTarget: s.TempTargetNozzle != null ? Math.round(s.TempTargetNozzle) : null,
        bedTemp: s.TempOfHotbed != null ? Math.round(s.TempOfHotbed) : null,
        bedTarget: s.TempTargetHotbed != null ? Math.round(s.TempTargetHotbed) : null,
      });
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.slice(0, idx).toString())) { finish({ ok: false, error: "The printer did not accept the connection (is this an Elegoo SDCP printer?)." }); return; }
        upgraded = true;
        buf = buf.slice(idx + 4);
        const id = crypto.randomBytes(16).toString("hex");
        wsSend(sock, JSON.stringify({
          Id: id,
          Data: { Cmd: 0, Data: {}, RequestID: id, MainboardID: mainboardId || "", TimeStamp: Date.now(), From: 0 },
          Topic: `sdcp/request/${mainboardId || ""}`,
        }));
      }
      for (;;) {
        const f = wsReadFrame(buf);
        if (!f) break;
        buf = buf.slice(f.length);
        if (f.opcode === 8) { finish({ ok: false, error: "The printer closed the connection before sending its status." }); return; }
        if (f.opcode === 1 || f.opcode === 0) {
          pendingText = (f.opcode === 1 ? "" : (pendingText || "")) + f.payload.toString("utf8");
          if (f.fin) { handleText(pendingText); pendingText = null; }
        }
      }
    });
  });
}

// ------------------------------------------------------------------ Duet
function isDuetResponse(json) {
  return !!json && json.key === "state.status" && typeof json.result === "string";
}

async function fetchDuetStatus(ip, port, timeoutMs) {
  port = port || 80;
  const st = await getJson(ip, port, "/rr_model?key=state.status", timeoutMs || 4000);
  if (!st.ok || st.status !== 200 || !isDuetResponse(st.json)) {
    return { ok: false, error: `The Duet board didn't respond as expected (${st.error || st.status || "unreachable"}). If it has a web password set, this version can't read it yet.` };
  }
  const raw = st.json.result;
  let progressPercent = null;
  let fileName = "";
  const job = await getJson(ip, port, "/rr_model?key=job", timeoutMs || 4000);
  const jr = job.ok && job.json && job.json.result;
  if (jr && jr.file) {
    fileName = jr.file.fileName ? String(jr.file.fileName).split("/").pop() : "";
    if (jr.file.size > 0 && jr.filePosition != null) progressPercent = Math.max(0, Math.min(100, Math.round((jr.filePosition / jr.file.size) * 100)));
  }
  const state = raw === "processing" ? "printing" : raw.toLowerCase();
  return { ok: true, state, progressPercent, fileName, nozzleTemp: null, nozzleTarget: null, bedTemp: null, bedTarget: null };
}

module.exports = {
  isPrivateIPv4, parseSubnetBase, getJson,
  friendlyBambuModel, parseBambuAnnouncement, listenForBambu,
  parseSdcpReply, discoverSdcp, fetchSdcpStatus, sdcpState,
  isDuetResponse, fetchDuetStatus,
};
