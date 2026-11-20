"use strict";
// reports.js: stages, profit, summaries, breakdowns, date ranges, CSV.
const R = require("../reports.js");

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  → " + extra : ""));
  if (!cond) failures++;
};
const approx = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

function mk(o = {}) {
  const total = o.total == null ? 11137 : o.total;
  return {
    name: o.name || "Job", status: o.status || "draft", quantity: o.qty || 1, category: o.category || "",
    jobNumber: o.jobNumber || "", invoiceNumber: o.invoiceNumber || "",
    recordedAt: o.recordedAt || "2026-10-10T09:00:00.000Z", printedAt: o.printedAt, invoicedAt: o.invoicedAt,
    printTimeHours: o.hours == null ? 74 : o.hours, totalAmount: total,
    parts: o.parts || [{ name: "A", materialCode: "PLA-W", weightGrams: 507 }, { name: "B", materialCode: "PLA-W", weightGrams: 518 }],
    payments: o.payments || [],
    details: {
      customerCompany: o.customer === undefined ? "Storytime" : o.customer,
      vatAfterDiscount: o.vat == null ? 1412 : o.vat,
      discountsTotal: o.discounts || 0,
      costBreakdown: o.noCost ? undefined : { totalProductionCost: o.cost == null ? 8729 : o.cost, vatAmount: 1746 },
    },
  };
}

// ---------------------------------------------------------------- stages
check("status is normalised (case, spaces)", R.stageOf({ status: " Quote_Sent " }) === "quote_sent");
check("unknown / missing status counts as draft", R.stageOf({ status: "weird" }) === "draft" && R.stageOf({}) === "draft" && R.stageOf(null) === "draft");
check("printed = printing, invoiced, completed", ["printing", "invoiced", "completed"].every((s) => R.isPrinted({ status: s })));
check("draft and quote_sent are NOT printed", !R.isPrinted({ status: "draft" }) && !R.isPrinted({ status: "quote_sent" }));

// ---------------------------------------------------------------- one job
let m = R.jobMetrics(mk({ status: "completed", qty: 2 }));
check("revenue ex VAT = total − VAT (9725)", m.revenueExVat === 9725, m.revenueExVat);
check("profit = revenue ex VAT − cost (996)", m.profit === 996, m.profit);
check("margin is measured on ex-VAT revenue (10.2%)", approx(m.marginPct, 996 / 9725 * 100), m.marginPct);
check("material and hours scale with quantity (1025 g × 2, 74 h × 2)", m.grams === 2050 && m.hours === 148);
m = R.jobMetrics(mk({ noCost: true }));
check("job with no cost breakdown: profit unknown, not zero", m.profit === null && m.marginPct === null && m.cost === null);
m = R.jobMetrics(mk({ payments: [{ amount: 5000 }, { amount: "x" }, { amount: 137.4 }] }));
check("paid counts valid payments only; balance = total − paid", m.paid === 5137 && m.balance === 6000, `${m.paid}/${m.balance}`);
m = R.jobMetrics({});
check("empty job doesn't produce NaN", Object.values(m).every((v) => v === null || typeof v === "string" || typeof v === "boolean" || Number.isFinite(v)));

// ---------------------------------------------------------------- summaries
const jobs = [
  mk({ status: "draft", total: 1000, vat: 130, cost: 700 }),
  mk({ status: "quote_sent", total: 2000, vat: 260, cost: 1400 }),
  mk({ status: "quote_sent", total: 3000, vat: 390, cost: 2100 }),
  mk({ status: "printing", total: 4000, vat: 520, cost: 2800, payments: [{ amount: 2000 }] }),
  mk({ status: "invoiced", total: 5000, vat: 650, cost: 3500, payments: [{ amount: 1000 }] }),
  mk({ status: "completed", total: 6000, vat: 780, cost: 4200, payments: [{ amount: 6000 }] }),
  mk({ status: "completed", total: 7000, vat: 910, cost: 4900, noCost: true }),
];
let S = R.summarize(jobs);
check("counts per stage", ["draft", "quote_sent", "printing", "invoiced", "completed"].map((k) => S.stages[k].count).join() === "1,2,1,1,2");
check("not printed = draft + quote_sent (3 jobs, 6000)", S.notPrinted.count === 3 && S.notPrinted.total === 6000);
check("printed = printing + invoiced + completed (4 jobs, 22000)", S.printed.count === 4 && S.printed.total === 22000);
check("printed + not printed = everything", S.printed.total + S.notPrinted.total === S.all.total && S.printed.count + S.notPrinted.count === S.count);
check("stage totals add up to all", Object.values(S.stages).reduce((a, s) => a + s.total, 0) === S.all.total);
check("cash received = all payments (9000)", S.received === 9000);
check("outstanding counts invoiced/completed only (4000 + 0 + 7000 = 11000)", S.outstanding === 11000 && S.outstandingJobs === 2, `${S.outstanding}/${S.outstandingJobs}`);
check("profit uses printed jobs that have a cost (3 jobs)", S.profitJobs === 3);
const expProfit = (4000 - 520 - 2800) + (5000 - 650 - 3500) + (6000 - 780 - 4200);
check("profit total", S.profit === expProfit, `${S.profit} vs ${expProfit}`);
const expRev = (4000 - 520) + (5000 - 650) + (6000 - 780);
check("overall margin = profit ÷ revenue of those jobs", approx(S.marginPct, expProfit / expRev * 100), S.marginPct);
check("win rate = printed ÷ (quote sent + printed) = 4/6", S.sentQuotes === 6 && S.wonQuotes === 4 && approx(S.winRatePct, 66.67, 0.1), S.winRatePct);
check("average printed job value", S.avgPrintedValue === 22000 / 4);
S = R.summarize([]);
check("no jobs: zeros and 'unknown', never NaN", S.count === 0 && S.winRatePct === null && S.marginPct === null && S.avgPrintedValue === null && S.printed.total === 0);
check("summarize tolerates junk input", R.summarize(null).count === 0 && R.summarize([null, {}, undefined]).count === 3);

// ---------------------------------------------------------------- dates + presets
const dated = [
  mk({ name: "sep", recordedAt: "2026-09-30T20:00:00", status: "completed", printedAt: "2026-10-02T10:00:00" }),
  mk({ name: "oct1", recordedAt: "2026-10-01T00:00:00", status: "completed" }),
  mk({ name: "oct31", recordedAt: "2026-10-31T23:30:00", status: "quote_sent" }),
  mk({ name: "nov", recordedAt: "2026-11-01T00:30:00", status: "draft" }),
  { ...mk({ name: "nodate" }), recordedAt: undefined },
];
const names = (l) => l.map((j) => j.name).sort().join();
check("range is inclusive of both end days", names(R.filterByRange(dated, "2026-10-01", "2026-10-31", "all")) === "oct1,oct31");
check("printed basis uses the printed date (sep job printed in Oct)", names(R.filterByRange(dated, "2026-10-01", "2026-10-31", "printed")) === "oct1,oct31,sep");
check("a range excludes jobs with no date; no range keeps them", names(R.filterByRange(dated, "2026-01-01", "", "all")) === "nov,oct1,oct31,sep" && R.filterByRange(dated, "", "", "all").length === 5);
const now = new Date("2026-10-27T12:00:00");
check("preset this month", JSON.stringify(R.presetRange("this_month", now)) === '{"from":"2026-10-01","to":"2026-10-31"}');
check("preset last month", JSON.stringify(R.presetRange("last_month", now)) === '{"from":"2026-09-01","to":"2026-09-30"}');
check("preset this year / last year", R.presetRange("this_year", now).from === "2026-01-01" && R.presetRange("last_year", now).to === "2025-12-31");
check("preset in January looks back into December", JSON.stringify(R.presetRange("last_month", new Date("2026-01-15T12:00:00"))) === '{"from":"2025-12-01","to":"2025-12-31"}');
const l90 = R.presetRange("last_90", now);
check("preset last 90 days spans exactly 90 days", (new Date(l90.to + "T00:00:00") - new Date(l90.from + "T00:00:00")) / 86400000 === 89 && l90.to === "2026-10-27", JSON.stringify(l90));
check("preset all = no limits", R.presetRange("all", now).from === "" && R.presetRange("nonsense", now).to === "");

// ---------------------------------------------------------------- breakdowns
const mix = [
  mk({ status: "completed", total: 5000, vat: 650, cost: 3000, customer: "Acme", category: "Toy", recordedAt: "2026-08-15T10:00:00", qty: 2, parts: [{ materialCode: "PLA-W", weightGrams: 100 }, { materialCode: "PETG-B", weightGrams: 50 }] }),
  mk({ status: "invoiced", total: 3000, vat: 390, cost: 1800, customer: "Acme", category: "Toy", recordedAt: "2026-09-05T10:00:00", parts: [{ materialCode: "PLA-W", weightGrams: 200 }] }),
  mk({ status: "printing", total: 4000, vat: 520, cost: 2500, customer: "Zed Ltd", category: "", recordedAt: "2026-09-20T10:00:00", printedAt: "2026-10-03T10:00:00", parts: [{ materialCode: "PLA-W", weightGrams: 10 }, { materialCode: "PLA-W", weightGrams: 10 }] }),
  mk({ status: "draft", total: 900, vat: 117, cost: 500, customer: "", recordedAt: "2026-10-01T10:00:00" }),
];
const allRev = R.summarize(mix).all.revenueExVat;
let rows = R.byMonth(mix, "all");
check("by month: sorted oldest first, labelled", rows.map((r) => r.label).join() === "Aug 2026,Sep 2026,Oct 2026", rows.map((r) => r.label).join());
check("by month totals reconcile with the overall total", rows.reduce((a, r) => a + r.revenueExVat, 0) === allRev);
rows = R.byMonth(mix.filter(R.isPrinted), "printed");
check("by month (printed basis) puts the printing job in October", rows.find((r) => r.key === "2026-10").jobs === 1 && rows.find((r) => r.key === "2026-09").jobs === 1);
rows = R.byCustomer(mix);
check("by customer: biggest first; blank becomes '(no customer)'", rows[0].label === "Acme" && rows.some((r) => r.label === "(no customer)"));
check("by customer: Acme = 2 jobs, revenue ex VAT 7960", rows[0].jobs === 2 && rows[0].revenueExVat === (5000 - 650) + (3000 - 390), rows[0].revenueExVat);
check("by customer totals reconcile", rows.reduce((a, r) => a + r.revenueExVat, 0) === allRev);
check("by customer: outstanding counts only invoiced/completed balances", rows[0].outstanding === 8000 && rows.find((r) => r.label === "Zed Ltd").outstanding === 0, rows[0].outstanding);
rows = R.byCategory(mix);
check("by category: blank → Uncategorised", rows.some((r) => r.label === "Uncategorised") && rows.find((r) => r.label === "Toy").jobs === 2);
rows = R.byMaterial(mix, (c) => ({ "PLA-W": "PLA White", "PETG-B": "PETG Black" }[c]));
const pla = rows.find((r) => r.key === "PLA-W"), petg = rows.find((r) => r.key === "PETG-B");
check("by material: grams × quantity (PLA 200+200+20+1025=1445… see parts)", pla.grams === (100 * 2) + 200 + 20 + 1025, pla.grams);
check("by material: a job counts once per material even with two parts", pla.jobs === 4 && petg.jobs === 1 && petg.grams === 100);
check("by material: names resolved, biggest first", pla.label === "PLA White" && rows[0].key === "PLA-W");
const rec = R.receivedByMonth([mk({ payments: [{ amount: 100, date: "2026-09-30" }, { amount: 50, date: "2026-10-01" }, { amount: 25, date: "2026-10-15" }] })]);
check("cash received by payment month (date-only strings keep their day)", rec.map((r) => `${r.key}:${r.amount}`).join() === "2026-09:100,2026-10:75", rec.map((r) => `${r.key}:${r.amount}`).join());
const owing = R.outstandingList([
  mk({ status: "invoiced", total: 1000, recordedAt: "2026-10-20T00:00:00", name: "new" }),
  mk({ status: "completed", total: 2000, recordedAt: "2026-08-01T00:00:00", name: "old", payments: [{ amount: 500 }] }),
  mk({ status: "completed", total: 3000, recordedAt: "2026-08-01T00:00:00", name: "paid", payments: [{ amount: 3000 }] }),
  mk({ status: "printing", total: 4000, name: "wip" }),
], new Date("2026-10-27T12:00:00"));
check("outstanding: only billable jobs that still owe money, oldest first", owing.map((o) => o.project).join() === "old,new" && owing[0].balance === 1500 && owing[0].daysOld > 60, owing.map((o) => o.project + ":" + o.daysOld).join());

// ---------------------------------------------------------------- CSV
check("plain text stays plain", R.csvCell("hello") === "hello");
check("commas / quotes / newlines are quoted and escaped", R.csvCell('a,b') === '"a,b"' && R.csvCell('say "hi"') === '"say ""hi"""' && R.csvCell("l1\nl2") === '"l1\nl2"');
check("formula injection is neutralised (= + - @ at the start of text)", R.csvCell("=SUM(A1)") === "'=SUM(A1)" && R.csvCell("+44 1") === "'+44 1" && R.csvCell("-2+3") === "'-2+3" && R.csvCell("@cmd") === "'@cmd");
check("…but real negative numbers stay numbers", R.csvCell(-1203) === "-1203" && R.csvCell(0) === "0");
check("null / NaN become empty", R.csvCell(null) === "" && R.csvCell(undefined) === "" && R.csvCell(NaN) === "");

// minimal RFC-4180 reader to prove the output round-trips
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const tricky = 'He said "hi", then\nleft';
const csv = R.toCsv([{ label: "A,B", key: "a" }, { label: "N", key: "n" }], [{ a: tricky, n: -5 }, { a: "plain", n: 7 }]);
const back = parseCsv(csv);
check("CSV uses CRLF and round-trips awkward text", csv.includes("\r\n") && back[0][0] === "A,B" && back[1][0] === tricky && back[1][1] === "-5" && back.length === 3, JSON.stringify(back));

const evil = mk({ status: "completed", name: "=HYPERLINK(\"http://x\")", customer: "+Cust, Inc", jobNumber: "PROD0001", payments: [{ amount: 100, date: "2026-10-20", method: "M-Pesa", note: "@note" }] });
const jcsv = parseCsv(R.buildJobsCsv([evil, mk({ status: "draft" })], { materialName: () => "PLA White" }));
const head = jcsv[0], rowE = jcsv[1], rowD = jcsv[2];
const col = (name) => head.indexOf(name);
check("jobs CSV: header has the expected columns", ["Date", "Job number", "Project", "Customer", "Status", "Printed", "Total incl VAT", "Profit", "Margin %", "Paid", "Balance"].every((h) => head.includes(h)));
check("jobs CSV: no currency baked into headers", !head.some((h) => /KES|Ksh|\$/.test(h)));
check("jobs CSV: dangerous text is defused", rowE[col("Project")].startsWith("'=") && rowE[col("Customer")].startsWith("'+"));
check("jobs CSV: printed yes/no, numbers and margin", rowE[col("Printed")] === "yes" && rowD[col("Printed")] === "no" && rowE[col("Total incl VAT")] === "11137" && rowE[col("Profit")] === "996" && rowE[col("Margin %")] === "10.2", `${rowE[col("Margin %")]}`);
check("jobs CSV: material names resolved, grams × quantity", rowE[col("Materials")] === "PLA White" && rowE[col("Material (g)")] === "1025");
check("jobs CSV: paid and balance", rowE[col("Paid")] === "100" && rowE[col("Balance")] === "11037");
check("jobs CSV: one line per job", jcsv.length === 3);
const pcsv = parseCsv(R.buildPaymentsCsv([evil, mk({})]));
check("payments CSV: one row per payment, with method and defused note", pcsv.length === 2 && pcsv[1][pcsv[0].indexOf("Method")] === "M-Pesa" && pcsv[1][pcsv[0].indexOf("Note")] === "'@note" && pcsv[1][pcsv[0].indexOf("Amount")] === "100");
const gcsv = parseCsv(R.buildGroupCsv("Customer", R.byCustomer(mix)));
check("group CSV: first column label, rows match", gcsv[0][0] === "Customer" && gcsv.length === R.byCustomer(mix).length + 1 && gcsv[1][0] === "Acme");
check("outstanding / material CSVs build", parseCsv(R.buildOutstandingCsv(owing)).length === 3 && parseCsv(R.buildMaterialCsv(R.byMaterial(mix))).length === 3);


// ---------------------------------------------------------------- cash received + monthly table
const cashJobs = [
  mk({ status: "invoiced", recordedAt: "2026-08-20T10:00:00", payments: [{ amount: 1000, date: "2026-09-02" }, { amount: 500, date: "2026-10-05" }] }),
  mk({ status: "completed", recordedAt: "2026-10-02T10:00:00", payments: [{ amount: 200, date: "2026-10-30" }, { amount: 300, date: "2026-11-01" }] }),
];
check("payments in range are picked by payment date, inclusive of the last day", R.paymentsInRange(cashJobs, "2026-10-01", "2026-10-30").map((p) => p.amount).sort().join() === "200,500");
check("no range = every payment", R.paymentsInRange(cashJobs).length === 4);
check("received by month respects the range", R.receivedByMonth(cashJobs, "2026-10-01", "2026-10-31").map((r) => `${r.key}:${r.amount}`).join() === "2026-10:700");
const monthly = R.monthlyTable(R.filterByRange(cashJobs, "2026-10-01", "2026-10-31", "all"), cashJobs, "all", "2026-09-01", "2026-10-31");
check("monthly table: a month with only cash (no jobs) still appears", monthly.map((r) => r.key).join() === "2026-09,2026-10" && monthly[0].jobs === 0 && monthly[0].received === 1000, JSON.stringify(monthly.map((r) => [r.key, r.jobs, r.received])));
check("monthly table: job figures and cash sit side by side", monthly[1].jobs === 1 && monthly[1].received === 700);
const mcsv = parseCsv(R.buildMonthlyCsv(monthly));
check("monthly CSV: header and one line per month", mcsv[0].join() === "Month,Jobs,Revenue ex VAT,Total incl VAT,Profit,Margin %,Material (g),Print time (hrs),Cash received" && mcsv.length === 3 && mcsv[1][0] === "2026-09" && mcsv[1][8] === "1000");

// ---------------------------------------------------------------- target margin
const tm = [
  mk({ status: "completed", total: 11137, vat: 1412, cost: 8729 }),   // margin 10.2%
  mk({ status: "invoiced", total: 12657, vat: 1746, cost: 8729 }),    // margin 20.0%
  mk({ status: "printing", total: 2000, vat: 260, cost: 1000 }),      // margin 42.5%
  mk({ status: "quote_sent", total: 1500, vat: 195, cost: 1400 }),    // a quote: never counted
  mk({ status: "completed", total: 3000, vat: 390, noCost: true }),   // no cost known: never counted
];
let T = R.summarize(tm, { targetMarginPct: 20 });
check("below-target counts printed jobs under the target (only the 10.2% one)", T.belowTarget === 1 && T.marginJobs === 3, `${T.belowTarget}/${T.marginJobs}`);
T = R.summarize(tm, { targetMarginPct: 30 });
check("a higher target catches the 20% job too", T.belowTarget === 2);
T = R.summarize(tm, { targetMarginPct: 0 });
check("target 0 = off (nothing flagged)", T.belowTarget === 0 && T.marginJobs === 3);
check("no options = off", R.summarize(tm).belowTarget === 0);

// ---------------------------------------------------------------- invariants on random data
let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const statuses = ["draft", "quote_sent", "printing", "invoiced", "completed"];
let bad = 0;
for (let i = 0; i < 300; i++) {
  const js = Array.from({ length: Math.floor(rnd() * 12) }, (_, k) => {
    const total = Math.round(rnd() * 20000), vat = Math.round(total * 0.14);
    return mk({ status: statuses[Math.floor(rnd() * 5)], total, vat, cost: Math.round(rnd() * 9000) + 1, qty: 1 + Math.floor(rnd() * 3),
      customer: ["A", "B", "", "C"][Math.floor(rnd() * 4)], category: ["X", "", "Y"][Math.floor(rnd() * 3)],
      recordedAt: `2026-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-15T10:00:00`,
      payments: rnd() < 0.5 ? [{ amount: Math.round(rnd() * total), date: "2026-06-01" }] : [] });
  });
  const s = R.summarize(js);
  const ok = s.printed.total + s.notPrinted.total === s.all.total
    && Object.values(s.stages).reduce((a, x) => a + x.count, 0) === js.length
    && R.byCustomer(js).reduce((a, r) => a + r.revenueExVat, 0) === s.all.revenueExVat
    && R.byCategory(js).reduce((a, r) => a + r.total, 0) === s.all.total
    && R.byMonth(js, "all").reduce((a, r) => a + r.jobs, 0) === js.length
    && R.byCustomer(js).reduce((a, r) => a + r.outstanding, 0) === s.outstanding
    && R.byCustomer(js).reduce((a, r) => a + r.paid, 0) === s.received
    && (s.marginPct === null || Number.isFinite(s.marginPct));
  if (!ok) bad++;
}
check("300 random sets: every breakdown reconciles with the summary", bad === 0, bad + " bad");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
