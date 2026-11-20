"use strict";
// The stats at the top of the Jobs tab: pipeline, money, production — and how
// they respond to filters and status changes.
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, errors, done } = await boot();
  await sleep(700);
  const nbsp = (s) => String(s).replace(/\u00a0/g, " ");

  const panel = () => $("jobStatsPanel");
  const tile = (label) => {
    const el = Array.from(panel().querySelectorAll(".stat-tile")).find((t) => nbsp(t.querySelector(".stat-tile-label").textContent).trim() === label);
    return el ? { value: nbsp(el.querySelector(".stat-tile-value").textContent).trim(), sub: nbsp((el.querySelector(".stat-tile-sub") || { textContent: "" }).textContent).trim(), cls: el.className } : null;
  };
  const stageCount = (key) => Number(panel().querySelector(`[data-stage="${key}"] .stat-tile-value`).textContent);

  const job = (o) => ({
    name: o.name, status: o.status, quantity: o.qty || 1, category: o.category || "", recordedAt: o.at || "2026-10-10T09:00:00.000Z",
    printTimeHours: o.hours == null ? 10 : o.hours, totalAmount: o.total, printerId: "PRT-1",
    parts: [{ name: "p", materialCode: "PLA-RED", weightGrams: o.grams == null ? 100 : o.grams, printTimeHours: 10, colorHex: "#ff0000" }],
    payments: o.payments || [],
    details: { customerCompany: o.customer || "Storytime", vatAfterDiscount: Math.round(o.total * 0.14), costBreakdown: { totalProductionCost: o.cost, vatAmount: 0 } },
  });

  // ---------------------------------------------------------------- empty
  STATEREF().history = [];
  window.renderPrintHistory();
  check("panel exists, empty state shows zeros not NaN", !!panel() && stageCount("draft") === 0 && !/NaN|undefined/.test(panel().textContent));
  check("no jobs: profit and rates show a dash", tile("Profit (printed)").value === "—" && tile("Quote → print rate").value === "—");

  // ---------------------------------------------------------------- a realistic mix
  STATEREF().history = [
    job({ name: "calc", status: "draft", total: 1000, cost: 700, grams: 50 }),
    job({ name: "q1", status: "quote_sent", total: 2000, cost: 1400, grams: 100 }),
    job({ name: "q2", status: "quote_sent", total: 3000, cost: 2100, grams: 150, customer: "Other Co" }),
    job({ name: "p1", status: "printing", total: 4000, cost: 2800, grams: 200, qty: 2, hours: 5, payments: [{ amount: 2000, date: "2026-10-12", method: "Cash" }] }),
    job({ name: "i1", status: "invoiced", total: 5000, cost: 3500, grams: 300, payments: [{ amount: 1000, date: "2026-10-13", method: "M-Pesa" }] }),
    job({ name: "c1", status: "completed", total: 6000, cost: 4200, grams: 400, payments: [{ amount: 6000, date: "2026-10-14", method: "Bank transfer" }] }),
    job({ name: "c2", status: "completed", total: 7000, cost: 4900, grams: 500, customer: "Other Co" }),
  ];
  window.renderPrintHistory();
  check("pipeline counts per stage", ["draft", "quote_sent", "printing", "invoiced", "completed"].map(stageCount).join() === "1,2,1,1,2");
  check("pipeline tiles show their value incl VAT", /1,000/.test(panel().querySelector('[data-stage="draft"]').textContent) && /5,000/.test(panel().querySelector('[data-stage="invoiced"]').textContent));
  check("printed stages are marked differently from quote stages", panel().querySelector('[data-stage="printing"]').classList.contains("stat-tile-printed") && panel().querySelector('[data-stage="draft"]').classList.contains("stat-tile-quote") && panel().querySelector('[data-stage="quote_sent"]').classList.contains("stat-tile-quote"));
  check("legend explains what 'printed' means", /Printed.*Printing, Invoiced or Completed/.test(panel().textContent));

  let t = tile("Open quotes");
  check("open quotes = calculated + quote sent (6,000, 3 jobs)", /6,000/.test(t.value) && /3 jobs/.test(t.sub), `${t.value} | ${t.sub}`);
  t = tile("Printed value");
  check("printed value = printing + invoiced + completed (22,000, 4 jobs)", /22,000/.test(t.value) && /4 jobs/.test(t.sub), `${t.value} | ${t.sub}`);
  t = tile("Received");
  check("received = every payment recorded (9,000)", /9,000/.test(t.value) && /stat-good/.test(t.cls), t.value);
  t = tile("Outstanding");
  check("outstanding = unpaid balance on invoiced/completed jobs (4,000 + 7,000)", /11,000/.test(t.value) && /2 invoiced jobs owing/.test(t.sub) && /stat-warn/.test(t.cls), `${t.value} | ${t.sub}`);
  t = tile("Profit (printed)");
  const expProfit = (4000 - 560 - 2800) + (5000 - 700 - 3500) + (6000 - 840 - 4200) + (7000 - 980 - 4900);
  check("profit adds up printed jobs (ex VAT − cost)", new RegExp(expProfit.toLocaleString("en-US")).test(t.value) && /% margin/.test(t.sub), `${t.value} | ${t.sub} (expected ${expProfit})`);
  t = tile("Material printed");
  check("material printed counts quantity: 200×2 + 300 + 400 + 500 = 1,600 g", t.value === "1,600 g", t.value);
  t = tile("In open quotes");
  check("material in open quotes = 50 + 100 + 150", t.value === "300 g", t.value);
  t = tile("Print time (printed)");
  check("print time scales with quantity: 5×2 + 10 + 10 + 10 = 40 h", t.value === "40 h", t.value);
  t = tile("Quote → print rate");
  check("quote → print rate = 4 of 6 sent quotes", t.value === "67%" && /4 of 6/.test(t.sub), `${t.value} | ${t.sub}`);
  t = tile("Average printed job");
  check("average printed job = 22,000 ÷ 4", /5,500/.test(t.value), t.value);

  // ---------------------------------------------------------------- stats follow the list's filters
  panel().querySelector('[data-stage="completed"]').click();
  check("clicking a stage filters the table to it", window.eval("historyTableState.filterStatus") === "completed" && $("historyArea").querySelectorAll("tbody tr").length === 2, String($("historyArea").querySelectorAll("tbody tr").length));
  check("…the tile shows as active and the stats say they're filtered", panel().querySelector('[data-stage="completed"]').classList.contains("active") && /showing 2 of 7 jobs/.test(panel().textContent));
  check("…and the numbers now describe only those jobs (printed 13,000 / 2 jobs, no open quotes)", /13,000/.test(tile("Printed value").value) && /2 jobs/.test(tile("Printed value").sub) && /KES 0$/.test(tile("Open quotes").value) && /0 jobs/.test(tile("Open quotes").sub), `${tile("Printed value").value} | ${tile("Open quotes").value}`);
  panel().querySelector('[data-stage="completed"]').click();
  check("clicking it again clears the filter", window.eval("historyTableState.filterStatus") === "" && /7 jobs/.test(panel().textContent));

  window.eval('historyTableState.filterCustomer = "Other Co"'); window.renderPrintHistory();
  check("customer filter narrows the stats too (Other Co: 2 jobs)", /showing 2 of 7/.test(panel().textContent) && stageCount("quote_sent") === 1 && stageCount("completed") === 1);
  window.eval('historyTableState.filterCustomer = ""'); window.renderPrintHistory();

  // ---------------------------------------------------------------- printed date is recorded when a job goes to print
  const select = (name) => Array.from(window.document.querySelectorAll(".job-status-select")).find((s) => STATEREF().history[s.dataset.index].name === name);
  const change = async (name, value) => { const s = select(name); s.value = value; s.dispatchEvent(new window.Event("change", { bubbles: true })); await sleep(80); };
  const h = (name) => STATEREF().history.find((j) => j.name === name);
  await change("q1", "printing");
  check("moving a quote to Printing stamps the printed date", h("q1").status === "printing" && !!h("q1").printedAt && !isNaN(new Date(h("q1").printedAt)));
  check("…and the stats move it from open quotes to printed (printed value 22,000 → 24,000)", stageCount("quote_sent") === 1 && stageCount("printing") === 2 && /24,000/.test(tile("Printed value").value), tile("Printed value").value);
  const stamped = h("q1").printedAt;
  await change("q1", "invoiced");
  check("moving on to Invoiced keeps the original printed date", h("q1").printedAt === stamped);
  await change("q1", "quote_sent");
  check("moving back to a quote clears the printed date", !h("q1").printedAt);

  const real = errors.filter((e) => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
