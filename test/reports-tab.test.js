"use strict";
// The Reports tab and CSV downloads, driven through the real UI.
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, errors, done } = await boot();
  await sleep(700);
  const nbsp = (s) => String(s).replace(/\u00a0/g, " ");
  const text = (el) => nbsp(el.textContent).replace(/\s+/g, " ");

  const job = (o) => ({
    name: o.name, status: o.status, quantity: o.qty || 1, category: o.category || "Toy", recordedAt: o.at, printedAt: o.printedAt,
    jobNumber: o.jobNumber || "", invoiceNumber: o.invoiceNumber || "", invoicedAt: o.invoicedAt,
    printTimeHours: o.hours == null ? 10 : o.hours, totalAmount: o.total,
    parts: [{ name: "p", materialCode: "PLA-RED", weightGrams: o.grams == null ? 100 : o.grams, printTimeHours: 10, colorHex: "#ff0000" }],
    payments: o.payments || [],
    details: { customerCompany: o.customer === undefined ? "Storytime" : o.customer, vatAfterDiscount: Math.round(o.total * 0.1), costBreakdown: { totalProductionCost: o.cost, vatAmount: 0 } },
  });
  STATEREF().history = [
    job({ name: "aug-done", status: "completed", at: "2026-08-10T09:00:00", total: 5500, cost: 3000, grams: 200, jobNumber: "PROD0001", invoiceNumber: "INV0001", invoicedAt: "2026-08-12T09:00:00", payments: [{ amount: 5500, date: "2026-08-20", method: "M-Pesa", note: "A1" }] }),
    job({ name: "sep-owing", status: "invoiced", at: "2026-09-05T09:00:00", total: 11000, cost: 6000, grams: 300, customer: "Other Co", category: "Prototype", jobNumber: "PROD0002", invoiceNumber: "INV0002", invoicedAt: "2026-09-06T09:00:00", payments: [{ amount: 1000, date: "2026-09-07", method: "Cash" }] }),
    job({ name: "sep-printed-oct", status: "printing", at: "2026-09-28T09:00:00", printedAt: "2026-10-02T09:00:00", total: 2200, cost: 1000, grams: 50, qty: 2 }),
    job({ name: "oct-quote", status: "quote_sent", at: "2026-10-03T09:00:00", total: 3300, cost: 1500, grams: 80, customer: "<img src=x onerror=alert(1)>" }),
    job({ name: "oct-draft", status: "draft", at: "2026-10-04T09:00:00", total: 4400, cost: 2000, grams: 90, customer: "=HYPERLINK(\"http://evil\")" }),
  ];

  // capture downloads
  const downloads = [];
  window.URL.createObjectURL = (blob) => { downloads.push({ blob }); return "blob:test"; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads[downloads.length - 1].filename = this.download; };
  const readBlob = (blob) => new Promise((res) => { const fr = new window.FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.readAsArrayBuffer(blob); });
  const lastDownload = async () => {
    const d = downloads[downloads.length - 1];
    const bytes = await readBlob(d.blob);
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const body = Buffer.from(bytes.slice(bom ? 3 : 0)).toString("utf8");
    return { filename: d.filename, bom, body, lines: body.split("\r\n").filter(Boolean) };
  };
  const setSelect = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event("change", { bubbles: true })); };

  // ---------------------------------------------------------------- open the tab
  window.document.querySelector('.nav-btn[data-tab="reports"]').click();
  check("Reports tab opens and shows", !$("tab-reports").classList.contains("hidden") && !!$("reportPeriod") && $("reportsResults").children.length > 0);
  setSelect("reportPeriod", "all");
  const tiles = () => Array.from($("reportsResults").querySelectorAll(".stat-tile")).map((t) => [text(t.querySelector(".stat-tile-label")), text(t.querySelector(".stat-tile-value")), text(t.querySelector(".stat-tile-sub") || { textContent: "" })]);
  const tile = (label) => tiles().find((t) => t[0] === label);

  // Printed jobs, all time: aug-done (5500, vat 550), sep-owing (11000, vat 1100), sep-printed-oct (2200, vat 220)
  let t = tile("Revenue ex VAT");
  check("printed basis: revenue ex VAT = (5500−550)+(11000−1100)+(2200−220) = 16,830", /16,830/.test(t[1]) && /3 jobs/.test(t[2]) && /18,700 incl VAT/.test(t[2]), `${t[1]} | ${t[2]}`);
  t = tile("Profit");
  check("profit = revenue ex VAT − cost for printed jobs (4,950−3,000)+(9,900−6,000)+(1,980−1,000) = 6,830", /6,830/.test(t[1]), t[1]);
  t = tile("Cash received");
  check("cash received (all time) = 5,500 + 1,000", /6,500/.test(t[1]), t[1]);
  t = tile("Owing now");
  check("owing now = 10,000 on the one invoiced job", /10,000/.test(t[1]) && /1 invoiced job/.test(t[2]), `${t[1]} | ${t[2]}`);
  t = tile("Material");
  check("material = 200 + 300 + 50×2 = 600 g", /600 g/.test(t[1]), t[1]);

  setSelect("reportBasis", "all");
  t = tile("Revenue ex VAT");
  check("'All jobs' basis adds the quotes (5 jobs)", /5 jobs/.test(t[2]) && /26,400 incl VAT/.test(t[2]), t[2]);
  check("profit is still only from printed jobs", /6,830/.test(tile("Profit")[1]));
  setSelect("reportBasis", "printed");

  // ---------------------------------------------------------------- monthly table
  const monthRows = () => Array.from($("reportsResults").querySelectorAll(".report-block")).find((b) => /By month/.test(b.textContent)).querySelectorAll("tbody tr");
  let mr = Array.from(monthRows()).map((r) => text(r));
  check("monthly: Aug, Sep and Oct rows (the Oct row is the job that went to print in Oct)", mr.length === 3 && /Aug 2026/.test(mr[0]) && /Sep 2026/.test(mr[1]) && /Oct 2026/.test(mr[2]), mr.join(" | "));
  const cells = Array.from(monthRows()).map((r) => Array.from(r.children).map((c) => text(c)));
  check("monthly: cash lands in the month it was received (Aug 5,500 · Sep 1,000 · Oct 0)", /5,500/.test(cells[0][6]) && /1,000/.test(cells[1][6]) && /\b0\b/.test(cells[2][6]), cells.map((c) => c[6]).join(" | "));
  check("monthly: October shows 1 job (the one printed in Oct)", cells[2][1] === "1" && /1,980/.test(cells[2][2]), cells[2].join(" | "));
  const foot = text($("reportsResults").querySelector(".report-block tfoot"));
  check("monthly: totals row adds up", /^Total3/.test(foot) && /16,830/.test(foot) && /6,830/.test(foot), foot);
  check("monthly: each month has a revenue bar", $("reportsResults").querySelectorAll(".report-bar").length >= 3);

  // custom range
  setSelect("reportPeriod", "custom");
  check("custom period reveals From / To", $("reportFromWrap").style.display !== "none" && $("reportToWrap").style.display !== "none");
  $("reportFrom").value = "2026-09-01"; $("reportFrom").dispatchEvent(new window.Event("change", { bubbles: true }));
  $("reportTo").value = "2026-09-30"; $("reportTo").dispatchEvent(new window.Event("change", { bubbles: true }));
  check("September only: just the job created+printed in Sep (11,000 incl VAT)", /1 job\b/.test(tile("Revenue ex VAT")[2]) && /11,000 incl VAT/.test(tile("Revenue ex VAT")[2]), tile("Revenue ex VAT")[2]);
  check("cash received is by payment date (Sep: 1,000)", /\b1,000\b/.test(tile("Cash received")[1]) && !/6,500/.test(tile("Cash received")[1]), tile("Cash received")[1]);
  check("owing now ignores the period (still 10,000)", /10,000/.test(tile("Owing now")[1]));
  $("reportFrom").value = "2026-10-01"; $("reportFrom").dispatchEvent(new window.Event("change", { bubbles: true }));
  $("reportTo").value = "2026-10-31"; $("reportTo").dispatchEvent(new window.Event("change", { bubbles: true }));
  check("October (printed basis): the job printed on 2 Oct is in, even though created in Sep", /1 job\b/.test(tile("Revenue ex VAT")[2]) && /2,200 incl VAT/.test(tile("Revenue ex VAT")[2]), tile("Revenue ex VAT")[2]);
  setSelect("reportPeriod", "all");

  // ---------------------------------------------------------------- other tables
  const block = (title) => Array.from($("reportsResults").querySelectorAll(".report-block")).find((b) => new RegExp(title).test(b.querySelector("h3").textContent));
  check("by customer lists Storytime and Other Co with revenue", /Storytime/.test(text(block("By customer"))) && /Other Co/.test(text(block("By customer"))) && /9,900/.test(text(block("By customer"))));
  check("by material resolves the material name and total grams", /PLA Basic/.test(text(block("By material"))) && /600 g/.test(text(block("By material"))), text(block("By material")));
  check("by category splits Toy / Prototype", /Toy/.test(text(block("By category"))) && /Prototype/.test(text(block("By category"))));
  const pipe = text(block("Pipeline"));
  check("pipeline covers every stage, flags quotes as not printed, and gives the conversion rate", /Calculated.*not printed/.test(pipe) && /Quote sent.*not printed/.test(pipe) && /3 of 4 quotes sent in this period have been printed \(75%\)/.test(pipe), pipe);
  const owingText = text(block("Outstanding invoices"));
  check("outstanding invoices lists INV0002 for Other Co with 10,000 balance", /INV0002/.test(owingText) && /Other Co/.test(owingText) && /10,000/.test(owingText) && !/INV0001/.test(owingText), owingText);

  // ---------------------------------------------------------------- hostile names
  setSelect("reportBasis", "all");
  check("a customer named like HTML is shown as text, not run", !$("reportsResults").querySelector("img") && /<img src=x/.test($("reportsResults").textContent));
  setSelect("reportBasis", "printed");

  // ---------------------------------------------------------------- CSV downloads
  const click = async (kind) => { $("reportsResults").parentElement.querySelector(`.report-export[data-export="${kind}"]`).click(); await sleep(60); return lastDownload(); };
  let d = await click("jobs");
  check("jobs CSV downloads as UTF-8 with BOM, named for the period", d.bom && /^quoteforge-jobs-all_all\.csv$/.test(d.filename), `${d.filename} bom=${d.bom}`);
  check("jobs CSV = the 3 printed jobs (printed basis) + header", d.lines.length === 4 && /^Date,Printed date,Job number/.test(d.lines[0]), String(d.lines.length));
  setSelect("reportBasis", "all");
  d = await click("jobs");
  check("jobs CSV follows the 'All jobs' basis (5 + header) and defuses formulas", d.lines.length === 6 && /'=HYPERLINK/.test(d.body) && !/(^|,)=HYPERLINK/m.test(d.body), String(d.lines.length));
  check("jobs CSV: no HTML-escaping artefacts (names are raw text)", /<img src=x onerror=alert\(1\)>/.test(d.body));
  setSelect("reportBasis", "printed");
  d = await click("payments");
  check("payments CSV: both payments, oldest first, with method and note", d.lines.length === 3 && /M-Pesa/.test(d.lines[1]) && /Cash/.test(d.lines[2]) && /,A1,/.test(d.lines[1]), d.lines.join(" || "));
  d = await click("monthly");
  check("monthly CSV matches the table (3 months)", d.lines.length === 4 && /^Month,Jobs,/.test(d.lines[0]) && /^2026-08,/.test(d.lines[1]), d.lines.join(" || "));
  d = await click("customer");
  check("customer CSV: header, Storytime and Other Co", /^Customer,Jobs,/.test(d.lines[0]) && d.lines.length === 3 && d.filename === "quoteforge-customer-all_all.csv", `${d.filename} ${d.lines.length}`);
  d = await click("material"); check("material CSV", /^Material,Jobs,Used \(g\)/.test(d.lines[0]) && /PLA Basic,3,600/.test(d.lines[1]), d.lines.join(" || "));
  d = await click("category"); check("category CSV", /^Category,Jobs,/.test(d.lines[0]));
  d = await click("pipeline"); check("pipeline CSV has all 5 stages", d.lines.length === 6 && /^Calculated,/.test(d.lines[1]), d.lines.length);
  d = await click("outstanding"); check("outstanding CSV: only INV0002, balance 10000", d.lines.length === 2 && /INV0002/.test(d.lines[1]) && /,10000$/.test(d.lines[1]), d.lines.join(" || "));

  setSelect("reportPeriod", "custom");
  $("reportFrom").value = "2026-09-01"; $("reportFrom").dispatchEvent(new window.Event("change", { bubbles: true }));
  $("reportTo").value = "2026-09-30"; $("reportTo").dispatchEvent(new window.Event("change", { bubbles: true }));
  d = await click("jobs");
  check("file name carries the chosen dates; only September's job is exported", d.filename === "quoteforge-jobs-2026-09-01_2026-09-30.csv" && d.lines.length === 2 && /sep-owing/.test(d.lines[1]), `${d.filename} ${d.lines.length}`);
  d = await click("payments");
  check("payments CSV for September = just the 1,000 cash payment", d.lines.length === 2 && /Cash/.test(d.lines[1]), d.lines.join(" || "));
  setSelect("reportPeriod", "all");

  // ---------------------------------------------------------------- Jobs page export
  window.document.querySelector('.nav-btn[data-tab="history"]').click();
  window.eval('historyTableState.filterCustomer = "Other Co"'); window.renderPrintHistory();
  $("exportJobsListCsvBtn").click(); await sleep(60);
  d = await lastDownload();
  check("Jobs page export respects the list's filters (Other Co: 1 job)", d.lines.length === 2 && /sep-owing/.test(d.lines[1]) && /^quoteforge-jobs-\d{4}-\d{2}-\d{2}\.csv$/.test(d.filename), `${d.filename} ${d.lines.length}`);
  window.eval('historyTableState.filterCustomer = "Nobody"'); window.renderPrintHistory();
  const before = downloads.length;
  $("exportJobsListCsvBtn").click(); await sleep(60);
  check("exporting an empty list says so instead of downloading an empty file", downloads.length === before && window.__alerts.some((a) => /no jobs to export/i.test(a)));

  const real = errors.filter((e) => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
