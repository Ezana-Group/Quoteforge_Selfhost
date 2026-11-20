"use strict";
// Minimal test runner (no framework needed): runs every test/*.test.js in its
// own process, in order, and fails if any of them exit non-zero.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
const results = [];
for (const file of files) {
  console.log(`\n━━━ ${file} ━━━`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
  results.push({ file, ok: r.status === 0, secs: ((Date.now() - started) / 1000).toFixed(1) });
}
console.log("\n━━━ Summary ━━━");
results.forEach((r) => console.log(`${r.ok ? "✔" : "✘"} ${r.file}  (${r.secs}s)`));
const failed = results.filter((r) => !r.ok);
if (failed.length) { console.log(`\n${failed.length} of ${results.length} test files FAILED`); process.exit(1); }
console.log(`\nAll ${results.length} test files passed`);
