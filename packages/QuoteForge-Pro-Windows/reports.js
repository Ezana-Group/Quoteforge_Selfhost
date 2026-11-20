// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Ovid International Ltd. See LICENSE.
/*
 * QuoteForge reports — pure functions (no DOM, no app state), so they can be
 * tested on their own and reused by the Jobs stats and the Reports tab.
 *
 * Vocabulary
 *   Stage     where a job is in its life: draft → quote_sent → printing →
 *             invoiced → completed.  (draft = "calculated", not yet quoted.)
 *   Printed   a job that has reached production: printing, invoiced or
 *             completed. Everything earlier (draft / quote_sent) is a quote
 *             that has not been printed.
 *   Revenue   always the ex-VAT amount unless a field says "incl VAT".
 *   Profit    revenue ex VAT − production cost (only when the job has a saved
 *             cost breakdown; older jobs without one are left out of profit).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QuoteForgeReports = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STAGES = [
    { key: "draft", label: "Calculated", help: "Saved calculation, no quote sent yet" },
    { key: "quote_sent", label: "Quote sent", help: "Quote generated / sent, not printed yet" },
    { key: "printing", label: "Printing", help: "In production" },
    { key: "invoiced", label: "Invoiced", help: "Printed and invoiced" },
    { key: "completed", label: "Completed", help: "Printed, finished and stock deducted" },
  ];
  const STAGE_KEYS = STAGES.map((s) => s.key);
  const PRINTED = new Set(["printing", "invoiced", "completed"]);
  const BILLABLE = new Set(["invoiced", "completed"]); // balances on these are "owed"

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round1 = (x) => Math.round(x * 10) / 10;

  function stageOf(job) {
    const s = String((job && job.status) || "draft").trim().toLowerCase();
    return STAGE_KEYS.includes(s) ? s : "draft";
  }
  const isPrinted = (job) => PRINTED.has(stageOf(job));
  const quantityOf = (job) => Math.max(1, num(job && job.quantity) || 1);

  function gramsOf(job) {
    const q = quantityOf(job);
    const parts = Array.isArray(job && job.parts) && job.parts.length ? job.parts : null;
    const perSet = parts ? parts.reduce((s, p) => s + num(p.weightGrams), 0) : num(job && job.weightGrams);
    return perSet * q;
  }
  const hoursOf = (job) => num(job && job.printTimeHours) * quantityOf(job);

  function paymentsOf(job) {
    return (Array.isArray(job && job.payments) ? job.payments : []).filter((p) => num(p && p.amount) > 0);
  }

  // ----------------------------------------------------------------- per job
  function jobMetrics(job) {
    const d = (job && job.details) || {};
    const cb = d.costBreakdown || {};
    const total = Math.round(num(job && job.totalAmount));
    const vat = Math.round(num(d.vatAfterDiscount != null ? d.vatAfterDiscount : cb.vatAmount));
    const hasCost = cb.totalProductionCost != null && num(cb.totalProductionCost) > 0;
    const cost = hasCost ? Math.round(num(cb.totalProductionCost)) : null;
    const revenueExVat = total - vat;
    const profit = hasCost ? revenueExVat - cost : null;
    const marginPct = hasCost && revenueExVat > 0 ? (profit / revenueExVat) * 100 : null;
    const paid = Math.round(paymentsOf(job).reduce((s, p) => s + num(p.amount), 0));
    return {
      stage: stageOf(job), printed: isPrinted(job),
      total, vat, revenueExVat, cost, profit, marginPct,
      grams: gramsOf(job), hours: hoursOf(job),
      paid, balance: total - paid, discounts: Math.round(num(d.discountsTotal)),
    };
  }

  // -------------------------------------------------------------- summaries
  const blank = () => ({ count: 0, total: 0, revenueExVat: 0, grams: 0, hours: 0 });
  function addTo(bucket, m) {
    bucket.count += 1; bucket.total += m.total; bucket.revenueExVat += m.revenueExVat;
    bucket.grams += m.grams; bucket.hours += m.hours;
  }

  function summarize(jobs, opts) {
    const list = Array.isArray(jobs) ? jobs : [];
    const target = Math.max(0, num(opts && opts.targetMarginPct));
    const out = {
      count: list.length,
      stages: Object.fromEntries(STAGE_KEYS.map((k) => [k, blank()])),
      all: blank(), printed: blank(), notPrinted: blank(),
      received: 0, outstanding: 0, outstandingJobs: 0,
      profit: 0, profitJobs: 0, marginPct: null,
      sentQuotes: 0, wonQuotes: 0, winRatePct: null, avgPrintedValue: null,
      marginJobs: 0, belowTarget: 0,
    };
    let profitRevenue = 0;
    list.forEach((job) => {
      const m = jobMetrics(job);
      addTo(out.all, m);
      addTo(out.stages[m.stage], m);
      addTo(m.printed ? out.printed : out.notPrinted, m);
      out.received += m.paid;
      if (BILLABLE.has(m.stage) && m.balance > 0) { out.outstanding += m.balance; out.outstandingJobs += 1; }
      if (m.printed && m.marginPct != null) { out.marginJobs += 1; if (target > 0 && m.marginPct < target - 0.05) out.belowTarget += 1; }
      if (m.printed && m.profit != null) { out.profit += m.profit; out.profitJobs += 1; profitRevenue += m.revenueExVat; }
      if (m.stage === "quote_sent" || m.printed) out.sentQuotes += 1;
      if (m.printed) out.wonQuotes += 1;
    });
    out.marginPct = profitRevenue > 0 ? (out.profit / profitRevenue) * 100 : null;
    out.winRatePct = out.sentQuotes > 0 ? (out.wonQuotes / out.sentQuotes) * 100 : null;
    out.avgPrintedValue = out.printed.count > 0 ? out.printed.total / out.printed.count : null;
    return out;
  }

  // -------------------------------------------------------------- dates
  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const text = String(value);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text); // date-only = local day
    return isNaN(d.getTime()) ? null : d;
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthLabel = (key) => { const [y, m] = key.split("-"); return `${MONTHS[Number(m) - 1]} ${y}`; };

  // Printed jobs are dated by when they went to print (falling back to when
  // they were created, for jobs saved before that was recorded).
  function reportDate(job, basis) {
    return parseDate(basis === "printed" ? (job.printedAt || job.recordedAt) : job.recordedAt);
  }

  function filterByRange(jobs, from, to, basis) {
    const start = from ? parseDate(from) : null;
    const end = to ? parseDate(to) : null;
    const endMs = end ? end.getTime() + 24 * 60 * 60 * 1000 - 1 : null;
    return (jobs || []).filter((job) => {
      if (!start && !end) return true;
      const d = reportDate(job, basis);
      if (!d) return false;
      if (start && d.getTime() < start.getTime()) return false;
      if (endMs != null && d.getTime() > endMs) return false;
      return true;
    });
  }

  function presetRange(preset, now) {
    const today = now ? new Date(now) : new Date();
    const y = today.getFullYear(), m = today.getMonth();
    switch (preset) {
      case "this_month": return { from: isoDay(new Date(y, m, 1)), to: isoDay(new Date(y, m + 1, 0)) };
      case "last_month": return { from: isoDay(new Date(y, m - 1, 1)), to: isoDay(new Date(y, m, 0)) };
      case "last_90": { const s = new Date(today); s.setDate(s.getDate() - 89); return { from: isoDay(s), to: isoDay(today) }; }
      case "this_year": return { from: isoDay(new Date(y, 0, 1)), to: isoDay(new Date(y, 11, 31)) };
      case "last_year": return { from: isoDay(new Date(y - 1, 0, 1)), to: isoDay(new Date(y - 1, 11, 31)) };
      default: return { from: "", to: "" };
    }
  }

  // -------------------------------------------------------------- breakdowns
  function rollup(map, key, label, m) {
    if (!map.has(key)) map.set(key, { key, label, jobs: 0, total: 0, revenueExVat: 0, profit: 0, profitRevenue: 0, grams: 0, hours: 0, paid: 0, outstanding: 0 });
    const r = map.get(key);
    r.jobs += 1; r.total += m.total; r.revenueExVat += m.revenueExVat; r.grams += m.grams; r.hours += m.hours; r.paid += m.paid;
    if (m.profit != null) { r.profit += m.profit; r.profitRevenue += m.revenueExVat; }
    if (BILLABLE.has(m.stage) && m.balance > 0) r.outstanding += m.balance;
  }
  function finish(map, sortBy) {
    return Array.from(map.values())
      .map((r) => ({ ...r, marginPct: r.profitRevenue > 0 ? (r.profit / r.profitRevenue) * 100 : null }))
      .sort(sortBy || ((a, b) => b.revenueExVat - a.revenueExVat || a.label.localeCompare(b.label)));
  }

  function byMonth(jobs, basis) {
    const map = new Map();
    (jobs || []).forEach((job) => {
      const d = reportDate(job, basis);
      if (!d) return;
      const key = monthKey(d);
      rollup(map, key, monthLabel(key), jobMetrics(job));
    });
    return finish(map, (a, b) => a.key.localeCompare(b.key));
  }

  function byCustomer(jobs) {
    const map = new Map();
    (jobs || []).forEach((job) => {
      const name = (job.details && job.details.customerCompany) || "";
      rollup(map, name || "(no customer)", name || "(no customer)", jobMetrics(job));
    });
    return finish(map);
  }

  function byCategory(jobs) {
    const map = new Map();
    (jobs || []).forEach((job) => {
      const name = String(job.category || "").trim() || "Uncategorised";
      rollup(map, name, name, jobMetrics(job));
    });
    return finish(map);
  }

  // Grams per material across all parts (× quantity). `nameOf(code)` supplies a label.
  function byMaterial(jobs, nameOf) {
    const map = new Map();
    (jobs || []).forEach((job) => {
      const q = quantityOf(job);
      const seen = new Set();
      (Array.isArray(job.parts) ? job.parts : []).forEach((p) => {
        const code = p.materialCode || "(unknown)";
        const label = (nameOf && nameOf(code)) || code;
        if (!map.has(code)) map.set(code, { key: code, label, jobs: 0, grams: 0 });
        const r = map.get(code);
        r.grams += num(p.weightGrams) * q;
        if (!seen.has(code)) { r.jobs += 1; seen.add(code); }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.grams - a.grams || a.label.localeCompare(b.label));
  }

  // Every payment dated within [from, to] (both optional, inclusive), across the given jobs.
  function paymentsInRange(jobs, from, to) {
    const start = from ? parseDate(from) : null;
    const end = to ? parseDate(to) : null;
    const endMs = end ? end.getTime() + 24 * 60 * 60 * 1000 - 1 : null;
    const out = [];
    (jobs || []).forEach((job) => {
      paymentsOf(job).forEach((p) => {
        const d = parseDate(p.date) || parseDate(job.recordedAt);
        if (!d) return;
        if (start && d.getTime() < start.getTime()) return;
        if (endMs != null && d.getTime() > endMs) return;
        out.push({ job, payment: p, date: d, amount: Math.round(num(p.amount)) });
      });
    });
    return out;
  }

  // Cash actually received, by month of the payment date.
  function receivedByMonth(jobs, from, to) {
    const map = new Map();
    paymentsInRange(jobs, from, to).forEach(({ date, amount }) => {
      const key = monthKey(date);
      map.set(key, (map.get(key) || 0) + amount);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([key, amount]) => ({ key, label: monthLabel(key), amount }));
  }

  // One row per month: the jobs' figures (dated per `basis`) beside the cash
  // actually received that month (from ALL jobs' payments, by payment date).
  function monthlyTable(jobsInRange, allJobs, basis, from, to) {
    const rows = new Map(byMonth(jobsInRange, basis).map((r) => [r.key, { ...r, received: 0 }]));
    receivedByMonth(allJobs, from, to).forEach(({ key, label, amount }) => {
      if (!rows.has(key)) rows.set(key, { key, label, jobs: 0, total: 0, revenueExVat: 0, profit: 0, profitRevenue: 0, marginPct: null, grams: 0, hours: 0, paid: 0, outstanding: 0, received: 0 });
      rows.get(key).received += amount;
    });
    return Array.from(rows.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  // Invoiced / completed jobs that still owe money, oldest first.
  function outstandingList(jobs, now) {
    const today = now ? new Date(now) : new Date();
    return (jobs || [])
      .map((job) => ({ job, m: jobMetrics(job) }))
      .filter((x) => BILLABLE.has(x.m.stage) && x.m.balance > 0)
      .map(({ job, m }) => {
        const d = parseDate(job.invoicedAt) || parseDate(job.recordedAt);
        return {
          jobNumber: job.jobNumber || "", invoiceNumber: job.invoiceNumber || "", project: job.name || "",
          customer: (job.details && job.details.customerCompany) || "", date: d ? isoDay(d) : "",
          daysOld: d ? Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000)) : null,
          total: m.total, paid: m.paid, balance: m.balance, status: m.stage,
        };
      })
      .sort((a, b) => (b.daysOld || 0) - (a.daysOld || 0) || b.balance - a.balance);
  }

  // -------------------------------------------------------------- CSV
  // Spreadsheet programs run cells that start with = + - @ as formulas, and
  // customer / project names are typed by people — so text cells that start
  // that way are prefixed with an apostrophe. Numbers are written as-is.
  function csvCell(value) {
    if (value == null) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function toCsv(columns, rows) {
    const lines = [columns.map((c) => csvCell(c.label)).join(",")];
    (rows || []).forEach((row) => lines.push(columns.map((c) => csvCell(typeof c.get === "function" ? c.get(row) : row[c.key])).join(",")));
    return lines.join("\r\n") + "\r\n";
  }

  const dayText = (v) => { const d = parseDate(v); return d ? isoDay(d) : ""; };
  const pct = (x) => (x == null ? "" : round1(x));

  function buildJobsCsv(jobs, opts) {
    const materialName = (opts && opts.materialName) || ((c) => c);
    const columns = [
      { label: "Date", get: (j) => dayText(j.recordedAt) },
      { label: "Printed date", get: (j) => (isPrinted(j) ? dayText(j.printedAt || j.recordedAt) : "") },
      { label: "Job number", get: (j) => j.jobNumber || "" },
      { label: "Invoice number", get: (j) => j.invoiceNumber || "" },
      { label: "Project", get: (j) => j.name || "" },
      { label: "Customer", get: (j) => (j.details && j.details.customerCompany) || "" },
      { label: "Category", get: (j) => j.category || "" },
      { label: "Status", get: (j) => stageOf(j) },
      { label: "Printed", get: (j) => (isPrinted(j) ? "yes" : "no") },
      { label: "Quantity (sets)", get: (j) => quantityOf(j) },
      { label: "Parts", get: (j) => (Array.isArray(j.parts) ? j.parts.map((p) => p.name || "").filter(Boolean).join("; ") : "") },
      { label: "Materials", get: (j) => Array.from(new Set((Array.isArray(j.parts) ? j.parts : []).map((p) => materialName(p.materialCode)).filter(Boolean))).join("; ") },
      { label: "Material (g)", get: (j) => Math.round(gramsOf(j)) },
      { label: "Print time (hrs)", get: (j) => round1(hoursOf(j)) },
      { label: "Production cost", get: (j) => jobMetrics(j).cost },
      { label: "Revenue ex VAT", get: (j) => jobMetrics(j).revenueExVat },
      { label: "VAT", get: (j) => jobMetrics(j).vat },
      { label: "Total incl VAT", get: (j) => jobMetrics(j).total },
      { label: "Profit", get: (j) => jobMetrics(j).profit },
      { label: "Margin %", get: (j) => pct(jobMetrics(j).marginPct) },
      { label: "Discounts", get: (j) => jobMetrics(j).discounts },
      { label: "Paid", get: (j) => jobMetrics(j).paid },
      { label: "Balance", get: (j) => jobMetrics(j).balance },
    ];
    return toCsv(columns, jobs || []);
  }

  function buildPaymentsCsv(jobs, from, to) {
    const rows = paymentsInRange(jobs, from, to).map(({ job, payment }) => ({ job, p: payment, m: jobMetrics(job) }));
    rows.sort((a, b) => String(dayText(a.p.date)).localeCompare(String(dayText(b.p.date))));
    return toCsv([
      { label: "Payment date", get: (r) => dayText(r.p.date) },
      { label: "Job number", get: (r) => r.job.jobNumber || "" },
      { label: "Invoice number", get: (r) => r.job.invoiceNumber || "" },
      { label: "Project", get: (r) => r.job.name || "" },
      { label: "Customer", get: (r) => (r.job.details && r.job.details.customerCompany) || "" },
      { label: "Method", get: (r) => r.p.method || "" },
      { label: "Amount", get: (r) => Math.round(num(r.p.amount)) },
      { label: "Note", get: (r) => r.p.note || "" },
      { label: "Job total", get: (r) => r.m.total },
      { label: "Job balance", get: (r) => r.m.balance },
    ], rows);
  }

  // Report tables → CSV (rows come from byMonth / byCustomer / byCategory / byMaterial / outstandingList)
  const GROUP_COLUMNS = (firstLabel) => [
    { label: firstLabel, key: "label" },
    { label: "Jobs", key: "jobs" },
    { label: "Revenue ex VAT", get: (r) => Math.round(r.revenueExVat) },
    { label: "Total incl VAT", get: (r) => Math.round(r.total) },
    { label: "Profit", get: (r) => Math.round(r.profit) },
    { label: "Margin %", get: (r) => pct(r.marginPct) },
    { label: "Material (g)", get: (r) => Math.round(r.grams) },
    { label: "Print time (hrs)", get: (r) => round1(r.hours) },
    { label: "Paid", get: (r) => Math.round(r.paid) },
    { label: "Outstanding", get: (r) => Math.round(r.outstanding) },
  ];
  const buildGroupCsv = (firstLabel, rows) => toCsv(GROUP_COLUMNS(firstLabel), rows);
  const buildMonthlyCsv = (rows) => toCsv([
    { label: "Month", key: "key" }, { label: "Jobs", key: "jobs" },
    { label: "Revenue ex VAT", get: (r) => Math.round(r.revenueExVat) }, { label: "Total incl VAT", get: (r) => Math.round(r.total) },
    { label: "Profit", get: (r) => Math.round(r.profit) }, { label: "Margin %", get: (r) => pct(r.marginPct) },
    { label: "Material (g)", get: (r) => Math.round(r.grams) }, { label: "Print time (hrs)", get: (r) => round1(r.hours) },
    { label: "Cash received", get: (r) => Math.round(r.received) },
  ], rows);
  const buildMaterialCsv = (rows) => toCsv([
    { label: "Material", key: "label" }, { label: "Jobs", key: "jobs" }, { label: "Used (g)", get: (r) => Math.round(r.grams) },
  ], rows);
  const buildOutstandingCsv = (rows) => toCsv([
    { label: "Job number", key: "jobNumber" }, { label: "Invoice number", key: "invoiceNumber" }, { label: "Project", key: "project" },
    { label: "Customer", key: "customer" }, { label: "Date", key: "date" }, { label: "Days old", key: "daysOld" },
    { label: "Total", key: "total" }, { label: "Paid", key: "paid" }, { label: "Balance", key: "balance" },
  ], rows);

  return {
    STAGES, PRINTED_STAGES: Array.from(PRINTED), stageOf, isPrinted, jobMetrics, summarize,
    parseDate, reportDate, filterByRange, presetRange, monthKey, monthLabel,
    byMonth, byCustomer, byCategory, byMaterial, paymentsInRange, receivedByMonth, monthlyTable, outstandingList,
    csvCell, toCsv, buildJobsCsv, buildPaymentsCsv, buildGroupCsv, buildMonthlyCsv, buildMaterialCsv, buildOutstandingCsv,
  };
});
