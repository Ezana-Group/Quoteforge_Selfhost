"use strict";
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, num, errors, done } = await boot({ configure(config) { config.extraFeeLineItems = [{ id: "f-sales", label: "Sales", value: 10, valueType: "percentage", enabled: true }, { id: "f-rush", label: "Rush", value: 100, valueType: "flat", enabled: true }, { id: "f-off", label: "Disabled fee", value: 50, valueType: "flat", enabled: false }]; } });
  await sleep(800);
  const card = $("quoteExtraFeesCard");
  const toggles = () => Array.from(window.document.querySelectorAll(".quote-fee-toggle"));
  check("Extra fees card visible", card.style.display !== "none");
  check("lists only enabled fees (2 of 3)", toggles().length === 2 && toggles().every(t => t.checked), toggles().map(t => t.dataset.feeId).join(","));

  const row = window.document.querySelector(".quote-part-row");
  row.querySelector(".quote-part-weight").value = "100"; row.querySelector(".quote-part-time").value = "2";

  // 1. all fees on
  $("calculateButton").click(); await sleep(350);
  let rec = STATEREF().lastPrintRecord, d = rec.details;
  const exVat = d.costBreakdown.sellingPriceExVat;
  check("both fees applied", d.extraFees.length === 2 && d.removedExtraFees.length === 0);
  const sales = d.extraFees.find(f => f.label === "Sales");
  check("Sales = 10% of ex-VAT price", Math.abs(sales.amount - exVat * 0.10) < 0.01, sales.amount.toFixed(2));
  const totalAll = rec.totalAmount;

  // 2. untick Sales on the quote
  const salesBox = toggles().find(t => t.dataset.feeId === "f-sales");
  salesBox.checked = false; salesBox.dispatchEvent(new window.Event("change", { bubbles: true }));
  await sleep(450);
  $("calculateButton").click(); await sleep(350);
  rec = STATEREF().lastPrintRecord; d = rec.details;
  check("Sales left off this quote", d.extraFees.length === 1 && d.extraFees[0].label === "Rush", d.extraFees.map(f => f.label).join(","));
  check("Sales remembered as removed on the job", d.removedExtraFees.length === 1 && d.removedExtraFees[0].label === "Sales" && d.removedExtraFees[0].value === 10);
  check("total drops by exactly the Sales amount", Math.abs((totalAll - rec.totalAmount) - sales.amount) <= 1, (totalAll - rec.totalAmount).toFixed(2) + " vs " + sales.amount.toFixed(2));
  check("Settings value untouched", STATEREF().config.extraFeeLineItems[0].enabled === true && STATEREF().config.extraFeeLineItems[0].value === 10);
  check("result/PDF no longer list Sales", !/Sales/.test($("resultArea").textContent) && !/Sales/.test($("printInvoice").innerHTML));
  const totalNoSales = rec.totalAmount;

  // 3. drawer: restore Sales
  STATEREF().history = [rec]; rec.recordedAt = new Date().toISOString(); rec.status = "draft";
  window.viewJobDetails(0); await sleep(150);
  check("drawer lists Design fee, Rush and a struck-through Sales", /Design fee/.test(window.document.body.textContent) && window.document.querySelectorAll(".drawer-remove-fee").length === 1 && window.document.querySelectorAll(".drawer-restore-fee").length === 1);
  window.document.querySelector(".drawer-restore-fee").click(); await sleep(150);
  let hj = STATEREF().history[0];
  check("restore brings Sales back at the right amount", hj.details.extraFees.length === 2 && Math.abs(hj.totalAmount - totalAll) < 0.01 && hj.details.removedExtraFees.length === 0, hj.totalAmount.toFixed(2) + " vs " + totalAll.toFixed(2));

  // 4. drawer: remove Sales again
  window.document.querySelectorAll(".drawer-remove-fee").forEach(b => { if (/Sales/.test(b.closest("li").textContent)) b.click(); });
  await sleep(150);
  hj = STATEREF().history[0];
  check("drawer remove works and matches quote-time removal", hj.details.extraFees.length === 1 && Math.abs(hj.totalAmount - totalNoSales) < 0.01, hj.totalAmount.toFixed(2) + " vs " + totalNoSales.toFixed(2));
  check("Financial Summary no longer shows Sales", !/Sales/.test(Array.from(window.document.querySelectorAll(".financial-summary-table tr")).map(t => t.textContent).join("|")));

  // 5. drawer: design fee editable even when 0
  check("design fee field present when fee is 0", !!$("drawerDesignFeeInput") && $("drawerDesignFeeInput").value === "0");
  const before = hj.totalAmount;
  $("drawerDesignFeeInput").value = "300"; $("drawerDesignFeeBtn").click(); await sleep(150);
  hj = STATEREF().history[0];
  check("design fee saved + added to total", hj.details.designFee === 300 && Math.abs(hj.totalAmount - (before + 300)) < 0.01, before.toFixed(2) + " → " + hj.totalAmount.toFixed(2));
  check("Financial Summary now shows Design Fee", Array.from(window.document.querySelectorAll(".financial-summary-table tr")).some(t => /Design Fee/.test(t.textContent) && /300/.test(t.textContent)));
  $("drawerDesignFeeInput").value = "-5"; $("drawerDesignFeeBtn").click();
  check("negative design fee rejected", window.__alerts.some(a => /design fee of 0 or more/.test(a)) && STATEREF().history[0].details.designFee === 300);

  // 6. percentage fee follows price when parts change (was stale before)
  const rushOnly = STATEREF().history[0];
  window.document.querySelector(".drawer-restore-fee").click(); await sleep(150);
  hj = STATEREF().history[0];
  hj.parts[0].weightGrams = 250; hj.parts[0].printTimeHours = 4;
  window.recalculateJobPricing(0);
  const s2 = STATEREF().history[0].details.extraFees.find(f => f.label === "Sales");
  const newEx = STATEREF().history[0].details.costBreakdown.sellingPriceExVat;
  check("Sales re-computed from the new price after a parts edit", Math.abs(s2.amount - newEx * 0.10) < 0.01 && newEx > exVat, `${s2.amount.toFixed(2)} vs ${(newEx*0.10).toFixed(2)}`);

  // 7. discounts still sit on top of fees correctly
  hj.details.discountItems = [{ type: "percent", value: 10, label: "x" }];
  window.recalculateJobPricing(0);
  hj = STATEREF().history[0];
  const sub = hj.details.costBreakdown.sellingPriceExVat + hj.details.designFee + hj.details.extraFeesTotal;
  check("10% discount applies to subtotal incl. fees", Math.abs(hj.details.discountsTotal - sub * 0.10) < 0.01);

  // 8. Settings changes update the quote card; reset restores ticks
  window.document.querySelector(".fee-item-enabled[data-idx='1']")?.dispatchEvent(Object.assign(new window.Event("change"), {}));
  const settingsBox = window.document.querySelector(".fee-item-enabled[data-idx='1']");
  if (settingsBox) { settingsBox.checked = false; settingsBox.dispatchEvent(new window.Event("change", { bubbles: true })); }
  await sleep(100);
  check("turning a fee off in Settings removes it from the quote card", toggles().length === 1, toggles().length + " toggles");
  if (settingsBox) { settingsBox.checked = true; settingsBox.dispatchEvent(new window.Event("change", { bubbles: true })); }
  $("resetButton").click(); await sleep(300);
  check("Reset re-ticks every fee", toggles().length === 2 && toggles().every(t => t.checked));

  // 9. all fees switched off in Settings -> card hides
  STATEREF().config.extraFeeLineItems.forEach(i => { i.enabled = false; });
  window.renderQuoteExtraFeesCard();
  check("card hides when there are no enabled fees", card.style.display === "none");

  const real = errors.filter(e => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
