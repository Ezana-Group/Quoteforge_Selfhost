"use strict";
// Boots the real index.html + calculator.js in jsdom with a stubbed /api/data,
// so tests drive the app exactly as a browser would (real DOM events, real
// calculation code) without needing a browser or a running server.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

async function boot({ configure } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  config.setupComplete = true;
  config.currencyCode = "KES";
  config.vatRatePercent = 16;
  config.printerSettings = {
    ...config.printerSettings,
    powerWatts: 270, electricityRateKesKwh: 25, printerPurchasePriceKes: 85000, lifespanHours: 10000,
    maintenancePerYearKes: 6000, laborRateKesPerHour: 200, profitMarginPercent: 40, vatRatePercent: 16,
  };
  config.printers = [{
    id: "PRT-1", name: "Test Printer", technology: "FDM", status: "Active", powerWatts: 270,
    printerPurchasePriceKes: 85000, lifespanHours: 10000, maintenancePerYearKes: 6000,
    failedPrintRatePercent: 5, maxColors: 1,
  }];
  config.materials = [{
    code: "PLA-RED", type: "PLA", name: "PLA Basic", brand: "Acme", colorHex: "#ff0000",
    costPerKgKes: 2500, stockKg: 5,
  }];
  config.serviceMinimumOrderKes = 0;
  config.components = [{ id: "c1", name: "Socket", category: "Electrical", costKes: 300 }];
  if (configure) configure(config);

  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script[^>]*src="https:[^"]*"[^>]*><\/script>/g, "");

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push("jsdomError: " + (e.detail || e.message)));
  virtualConsole.on("error", (e) => errors.push("console.error: " + e));

  const dom = new JSDOM(html, {
    url: "http://localhost:8080/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url) => {
    if (String(url).includes("/api/data")) return { ok: true, json: async () => ({ config, history: [] }) };
    return { ok: false, json: async () => ({}), text: async () => "" };
  };
  window.__alerts = [];
  window.alert = (m) => { window.__alerts.push(m); };
  window.confirm = () => true;
  window.indexedDB = undefined;
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {} }));

  // Real <script> elements (not window.eval) so top-level let/const such as
  // STATE are shared between the app's scripts.
  for (const f of ["multi-part-import.js", "reports.js", "calculator.js"]) {
    const el = window.document.createElement("script");
    el.textContent = fs.readFileSync(path.join(root, f), "utf8");
    window.document.head.appendChild(el);
  }

  let failures = 0;
  const check = (name, cond, extra = "") => {
    console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  → " + extra : ""));
    if (!cond) failures++;
  };

  return {
    window,
    errors,
    check,
    STATEREF: () => window.eval("STATE"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    $: (id) => window.document.getElementById(id),
    num: (s) => Number(String(s).replace(/[^0-9.\-]/g, "")),
    done: () => {
      console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
      process.exit(failures ? 1 : 0);
    },
  };
}

module.exports = { boot };
