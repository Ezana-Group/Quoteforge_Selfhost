"use strict";
// Starts the real server.js and exercises it over HTTP: serving, the
// localhost-only guards, crash-safe saves, backups, corrupt-file recovery and
// running without the optional "mqtt" package.
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  → " + extra : ""));
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request({ port, method = "GET", urlPath = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: raw.toString(), raw }); });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer({ env = {}, nodeArgs = [] } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quoteforge-test-"));
  const child = spawn(process.execPath, [...nodeArgs, path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NO_BROWSER: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = [200, 401].includes((await request({ port })).status); } catch (e) { await sleep(100); }
  }
  if (!up) throw new Error("server did not start:\n" + log);
  return {
    port, dataDir, getLog: () => log,
    stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill(); }),
    post: (data, headers = {}) => request({ port, method: "POST", urlPath: "/api/data", headers, body: typeof data === "string" ? data : JSON.stringify(data) }),
    get: (urlPath = "/api/data", headers = {}) => request({ port, urlPath, headers }),
    file: (...p) => path.join(dataDir, ...p),
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

(async () => {
  // ---------------------------------------------------------------- serving + guards
  let s = await startServer();
  try {
    const home = await s.get("/");
    check("serves the app", home.status === 200 && /QuoteForge/i.test(home.body));
    check("/healthz works on a normal install too", (await s.get("/healthz")).status === 200);
    const leaks = await Promise.all(["/server.js", "/package.json", "/Dockerfile", "/test/server.test.js", "/docker-compose.yml", "/.github/workflows/ci.yml"].map((u) => s.get(u)));
    check("source, package and test files are not served", leaks.every((r) => r.status === 404), leaks.map((r) => r.status).join(","));
    const assets = await Promise.all(["/styles.css", "/calculator.js", "/reports.js", "/multi-part-import.js", "/config.json", "/vendor/jszip.min.js", "/vendor/fonts/inter-latin-400-normal.woff2"].map((u) => s.get(u)));
    check("the app's own front-end files still are served", assets.every((r) => r.status === 200), assets.map((r) => r.status).join(","));

    // ---- printer connection testing
    const fakeDuet = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ key: "state.status", flags: "", result: "idle" })); });
    await new Promise((r) => fakeDuet.listen(0, "127.0.0.1", r));
    const tp = (obj) => request({ port: s.port, method: "POST", urlPath: "/api/test-printer", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
    const okTest = await tp({ ip: "127.0.0.1", port: fakeDuet.address().port, apiType: "duet" });
    check("Test connection reaches a printer on the local network", okTest.status === 200 && JSON.parse(okTest.body).ok === true && JSON.parse(okTest.body).state === "idle", okTest.body);
    check("Test connection refuses public internet addresses", (await tp({ ip: "8.8.8.8", apiType: "duet" })).status === 400);
    check("Test connection refuses unknown printer types", (await tp({ ip: "127.0.0.1", apiType: "nope" })).status === 400);
    check("Test connection refuses bad ports", (await tp({ ip: "127.0.0.1", port: 99999, apiType: "duet" })).status === 400);
    check("Test connection is POST only", (await s.get("/api/test-printer")).status !== 200);
    check("Scan rejects a public subnet", (await s.get("/api/discover-printers?subnet=8.8.8.0/24")).status === 400);
    fakeDuet.close();
    check("serves scripts", (await s.get("/calculator.js")).status === 200 && (await s.get("/reports.js")).status === 200);
    const trav = await s.get("/..%2f..%2fserver.js");
    const trav2 = await s.get("/../server.js");
    check("blocks path traversal", !/createServer/.test(trav.body) && !/createServer/.test(trav2.body), `${trav.status}/${trav2.status}`);

    const origin = `http://127.0.0.1:${s.port}`;
    check("same-origin save allowed", (await s.post({ config: {}, history: [] }, { Origin: origin })).status === 200);
    check("save with no Origin (curl, scripts) allowed", (await s.post({ config: {}, history: [] })).status === 200);
    check("foreign-site save rejected", (await s.post({ config: { hacked: 1 }, history: [] }, { Origin: "https://evil.example" })).status === 403);
    check("foreign-site shutdown rejected", (await request({ port: s.port, method: "POST", urlPath: "/api/shutdown", headers: { Origin: "https://evil.example" } })).status === 403);
    check("DNS-rebinding Host rejected", (await s.get("/api/data", { Host: "evil.example" })).status === 403);
    check("data was not changed by the rejected requests", !("hacked" in (readJson(s.file("app-data.json")).config || {})));
    check("invalid JSON rejected", (await s.post("{not json")).status === 400);
  } finally { await s.stop(); }

  // ---------------------------------------------------------------- persistence
  s = await startServer();
  try {
    const A = { config: { v: "A" }, history: [] };
    const B = { config: { v: "B" }, history: [] };
    check("save A", (await s.post(A)).status === 200);
    check("save B", (await s.post(B)).status === 200);
    check("data file holds the latest save", readJson(s.file("app-data.json")).config.v === "B");
    check("previous version kept as .bak", readJson(s.file("app-data.json.bak")).config.v === "A");
    check("no temp files left behind", tmpLeftovers(s.dataDir).length === 0);
    const snaps = fs.existsSync(s.file("backups")) ? fs.readdirSync(s.file("backups")).filter((f) => /^app-data-\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
    check("one daily snapshot taken", snaps.length === 1, snaps.join(","));
    check("daily snapshot is the state from before today's first save", snaps.length === 1 && !("v" in (readJson(s.file("backups", snaps[0])).config || {})));
    check("GET returns the latest save", JSON.parse((await s.get()).body).config.v === "B");

    // many saves at once: result must be one complete payload, nothing half-written
    const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => s.post({ config: { burst: i, pad: "x".repeat(20000) }, history: [] })));
    check("25 simultaneous saves all succeed", burst.every((r) => r.status === 200));
    const after = readJson(s.file("app-data.json"));
    check("file is one complete payload after the burst", Number.isInteger(after.config.burst) && after.config.pad.length === 20000);
    check("no temp files after the burst", tmpLeftovers(s.dataDir).length === 0);

    // ---------------------------------------------------------------- recovery
    await s.post(A); await s.post(B);                       // primary = B, .bak = A
    fs.writeFileSync(s.file("app-data.json"), '{"config": {"v": "B"');   // simulate a torn write
    let r = await s.get();
    check("corrupt data file: GET still returns valid JSON", r.status === 200 && JSON.parse(r.body).config.v === "A", r.body.slice(0, 60));
    check("tells the client which backup was used", r.headers["x-quoteforge-recovered-from"] === "app-data.json.bak", String(r.headers["x-quoteforge-recovered-from"]));
    check("unreadable file kept aside, not deleted", fs.readdirSync(s.dataDir).some((f) => /^app-data\.corrupt-\d+\.json$/.test(f)));
    check("data file repaired", readJson(s.file("app-data.json")).config.v === "A");

    fs.writeFileSync(s.file("app-data.json"), "garbage");
    fs.writeFileSync(s.file("app-data.json.bak"), "garbage too");
    r = await s.get();
    check("both corrupt: falls back to the daily snapshot", r.status === 200 && /^app-data-\d{4}-\d{2}-\d{2}\.json$/.test(String(r.headers["x-quoteforge-recovered-from"])), String(r.headers["x-quoteforge-recovered-from"]));

    fs.writeFileSync(s.file("app-data.json"), "");
    fs.writeFileSync(s.file("app-data.json.bak"), "");
    for (const f of fs.readdirSync(s.file("backups"))) fs.unlinkSync(s.file("backups", f));
    r = await s.get();
    check("no usable backup: starts empty instead of crashing", r.status === 200 && JSON.parse(r.body).history.length === 0);
  } finally { await s.stop(); }

  // ---------------------------------------------------------------- HOST=0.0.0.0
  s = await startServer({ env: { HOST: "0.0.0.0" } });
  try {
    check("HOST=0.0.0.0: other Host headers (reverse proxy) allowed", (await s.get("/api/data", { Host: "quotes.example.test" })).status === 200);
    check("HOST=0.0.0.0: prints a no-login warning", /no login/i.test(s.getLog()));
  } finally { await s.stop(); }

  // ---------------------------------------------------------------- without the optional mqtt package
  s = await startServer({ nodeArgs: ["--require", path.join(__dirname, "helpers", "block-mqtt.js")] });
  try {
    check("starts and serves without mqtt installed", (await s.get("/")).status === 200);
    await s.post({ config: { printers: [{ id: "b1", name: "Bambu", networkAddress: "192.0.2.1", networkApiType: "bambu", networkSerial: "SERIAL", networkAccessCode: "CODE" }] }, history: [] });
    const ps = await s.get("/api/printer-status?id=b1");
    const body = JSON.parse(ps.body);
    check("Bambu status explains how to enable mqtt", ps.status === 200 && body.ok === false && /mqtt/.test(body.error), body.error);
  } finally { await s.stop(); }

  // ---------------------------------------------------------------- optional password
  s = await startServer({ env: { QUOTEFORGE_PASSWORD: "correct horse battery" } });
  try {
    const basic = (u, p) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
    let r = await s.get("/");
    check("password set: no credentials → 401 with a login challenge", r.status === 401 && /Basic realm/.test(String(r.headers["www-authenticate"])));
    const t0 = Date.now();
    r = await s.get("/", basic("quoteforge", "wrong password"));
    check("wrong password → 401", r.status === 401);
    check("wrong password is slowed down (≥ 350 ms)", Date.now() - t0 >= 350, `${Date.now() - t0} ms`);
    check("right password, wrong username → 401", (await s.get("/", basic("someone", "correct horse battery"))).status === 401);
    check("empty password → 401", (await s.get("/", basic("quoteforge", ""))).status === 401);
    check("correct login → app loads", (await s.get("/", basic("quoteforge", "correct horse battery"))).status === 200);
    check("correct login → data readable", (await s.get("/api/data", basic("quoteforge", "correct horse battery"))).status === 200);
    check("saving without a login is refused", (await s.post({ config: { hacked: 1 }, history: [] })).status === 401);
    check("saving with the login works", (await s.post({ config: { ok: 1 }, history: [] }, basic("quoteforge", "correct horse battery"))).status === 200);
    check("refused save changed nothing", readJson(s.file("app-data.json")).config.ok === 1 && !("hacked" in readJson(s.file("app-data.json")).config));
    check("shutdown needs the login too", (await request({ port: s.port, method: "POST", urlPath: "/api/shutdown" })).status === 401 && (await s.get("/", basic("quoteforge", "correct horse battery"))).status === 200);
    check("startup says password protection is on", /Password protection is ON/.test(s.getLog()));
    const hz = await s.get("/healthz");
    check("/healthz answers without a password (so Docker's health check works)", hz.status === 200 && hz.body === '{"status":"ok"}', `${hz.status} ${hz.body}`);
    check("/healthz leaks nothing and the app itself is still locked", !/config|history|version/i.test(hz.body) && (await s.get("/")).status === 401 && (await s.get("/api/data")).status === 401);
    check("/healthz is GET/HEAD only", (await request({ port: s.port, method: "POST", urlPath: "/healthz" })).status === 401);
  } finally { await s.stop(); }

  s = await startServer({ env: { QUOTEFORGE_PASSWORD: "pw-12345678", QUOTEFORGE_USER: "ivy", HOST: "0.0.0.0" } });
  try {
    const ok = { Authorization: "Basic " + Buffer.from("ivy:pw-12345678").toString("base64") };
    check("custom username works", (await s.get("/", ok)).status === 200);
    check("default username no longer works when overridden", (await s.get("/", { Authorization: "Basic " + Buffer.from("quoteforge:pw-12345678").toString("base64") })).status === 401);
    check("with a password, the 'no login' warning is replaced by an HTTPS reminder", !/no login/.test(s.getLog()) && /HTTPS/.test(s.getLog()));
  } finally { await s.stop(); }

  // ---------------------------------------------------------------- bundled fonts (no Google requests)
  s = await startServer();
  try {
    const font = await s.get("/vendor/fonts/inter-latin-400-normal.woff2");
    check("bundled font is served as woff2", font.status === 200 && font.headers["content-type"] === "font/woff2" && font.raw.length === fs.statSync(path.join(root, "vendor/fonts/inter-latin-400-normal.woff2")).size && font.raw.slice(0, 4).toString() === "wOF2", `${font.status} ${font.headers["content-type"]} ${font.raw.length} bytes`);
    const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    check("app makes no requests to Google Fonts", !/fonts\.(googleapis|gstatic)\.com/.test(css + html));
    const faces = [...css.matchAll(/url\("(vendor\/fonts\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
    const missing = faces.filter((f) => !fs.existsSync(path.join(root, f)));
    check("every @font-face file exists", faces.length === 7 && missing.length === 0, missing.join(","));
    check("font licences shipped", fs.existsSync(path.join(root, "vendor/fonts/LICENSE-Inter.txt")) && fs.existsSync(path.join(root, "vendor/fonts/LICENSE-JetBrainsMono.txt")));
  } finally { await s.stop(); }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
