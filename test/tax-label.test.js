"use strict";
// The tax name (VAT / GST / Sales Tax ...) is configurable. This checks the helper
// without needing a DOM: it is pulled out of calculator.js and run against a fake STATE.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "calculator.js"), "utf8");
const start = src.indexOf("function taxLabel()");
const end = src.indexOf("function getCurrencyLocale()");
if (start < 0 || end < start) { console.log("FAIL could not find taxLabel() in calculator.js"); process.exit(1); }
global.STATE = { config: {} };
(0, eval)(src.slice(start, end));

let fail = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + " " + extra); if (!cond) fail++; };

check("defaults to VAT when nothing is set", taxLabel() === "VAT");
STATE.config.taxLabel = "GST";
check("uses the configured name", taxLabel() === "GST");
STATE.config.taxLabel = "  Sales Tax  ";
check("trims whitespace", taxLabel() === "Sales Tax");
STATE.config.taxLabel = "   ";
check("blank falls back to VAT", taxLabel() === "VAT");
STATE.config.taxLabel = "x".repeat(60);
check("long names are capped", taxLabel().length === 24);
STATE.config.taxLabel = 42;
check("non-text falls back to VAT", taxLabel() === "VAT");
process.exit(fail ? 1 : 0);
