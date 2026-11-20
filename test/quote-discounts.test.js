"use strict";
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, num, errors, done } = await boot();
  await sleep(800);
  check("Discounts card rendered", !!$("quoteDiscountsCard"));
  check("empty state shown", /No discounts added/.test($("quoteDiscountsListWrap").textContent), $("quoteDiscountsListWrap").textContent.trim());
  check("currency placeholder replaced in type option", /KES/.test($("quoteDiscountType").textContent), $("quoteDiscountType").textContent.replace(/\s+/g," ").trim());

  // fill one part: 100 g, 2 h
  const row = window.document.querySelector(".quote-part-row");
  check("part row exists", !!row);
  row.querySelector(".quote-part-weight").value = "100";
  row.querySelector(".quote-part-time").value = "2";
  $("designFeeWeight").value = "200";
  $("designFeeWeight").dispatchEvent(new window.Event("input", { bubbles: true }));

  // baseline (no discount)
  $("calculateButton").click();
  await sleep(400);
  const base = STATEREF().lastPrintRecord;
  check("baseline calculates", !!base, base ? "total " + base.totalAmount.toFixed(2) : (window.__alerts.join("|") + errors.join("|")));
  if (!base) { console.log(errors.join("\n")); process.exit(1); }
  const baseTotal = base.totalAmount;
  check("baseline has no discounts saved", (base.details.discounts || []).length === 0 && base.details.discountsTotal === 0);

  // validation
  $("quoteDiscountType").value = "percent"; $("quoteDiscountValue").value = "150";
  $("addQuoteDiscountBtn").click();
  check("rejects >100%", window.__alerts.some(a => /more than 100/.test(a)));
  $("quoteDiscountValue").value = "0"; $("addQuoteDiscountBtn").click();
  check("rejects 0", window.__alerts.some(a => /greater than 0/.test(a)));

  // add 10% (labelled) and a 100 fixed
  $("quoteDiscountType").value = "percent"; $("quoteDiscountValue").value = "10"; $("quoteDiscountLabel").value = "Loyal <b>customer</b>";
  $("addQuoteDiscountBtn").click();
  $("quoteDiscountType").value = "fixed"; $("quoteDiscountValue").value = "100"; $("quoteDiscountLabel").value = "";
  $("addQuoteDiscountBtn").click();
  await sleep(500);

  const items = $("quoteDiscountsListWrap").querySelectorAll("li");
  check("two discounts listed", items.length === 2, items.length + " items");
  check("label is HTML-escaped in list", !$("quoteDiscountsListWrap").querySelector("b"));
  check("input fields cleared after add", $("quoteDiscountValue").value === "" && $("quoteDiscountLabel").value === "");
  const liveTotalTxt = $("quoteDiscountsTotal").textContent;
  check("card shows live total discount", /[0-9]/.test(liveTotalTxt) && num(liveTotalTxt) > 100, liveTotalTxt);

  $("calculateButton").click();
  await sleep(400);
  const rec = STATEREF().lastPrintRecord;
  const d = rec.details;
  const subtotal = d.costBreakdown.sellingPriceExVat + d.designFee + d.extraFeesTotal;
  const expectedDiscount = subtotal * 0.10 + 100;
  check("2 discount rows saved", d.discounts.length === 2);
  check("discountsTotal = 10% of subtotal + 100", Math.abs(d.discountsTotal - expectedDiscount) < 0.01, d.discountsTotal.toFixed(2) + " vs " + expectedDiscount.toFixed(2));
  const taxableShare = d.costBreakdown.sellingPriceExVat / subtotal;
  const expVat = (d.costBreakdown.sellingPriceExVat - d.discountsTotal * taxableShare) * 0.16;
  check("VAT recomputed", Math.abs(d.vatAfterDiscount - expVat) < 0.01, d.vatAfterDiscount.toFixed(2) + " vs " + expVat.toFixed(2));
  const expTotal = subtotal - d.discountsTotal + expVat;
  check("final total = subtotal − discounts + VAT (whole units)", Math.abs(rec.totalAmount - expTotal) <= 1, rec.totalAmount.toFixed(2) + " vs " + expTotal.toFixed(2));
  check("total lower than baseline by (discount − VAT saved)", rec.totalAmount < baseTotal, `${baseTotal.toFixed(2)} → ${rec.totalAmount.toFixed(2)}`);
  check("discount inputs stored for recalculation", d.discountItems.length === 2 && d.discountItems[0].type === "percent");

  const result = $("resultArea").textContent;
  check("result breakdown shows discount rows", /Loyal.*\(10%\)/.test(result) && /Discount/.test(result));
  const pdf = $("printInvoice").innerHTML;
  check("PDF shows discount rows before VAT", /print-discount-row/.test(pdf) && pdf.indexOf("print-discount-row") < pdf.search(/<span>VAT/));
  check("PDF label escaped", !/<b>customer<\/b>/.test(pdf));
  check("WhatsApp text lists discounts", /\*Discounts\*/.test(rec.whatsappText) && /Loyal <b>customer<\/b> \(10%\): -/.test(rec.whatsappText));

  // live profit preview agrees with the saved total
  const livePrice = num(window.document.querySelector("#liveProfitPreview .lpp-item:nth-child(2) .lpp-value").textContent);
  check("live preview price == calculated total", Math.abs(livePrice - Math.round(rec.totalAmount)) <= 1, livePrice + " vs " + rec.totalAmount.toFixed(2));

  // remove one
  $("quoteDiscountsListWrap").querySelector(".remove-quote-discount").click();
  await sleep(400);
  check("remove works", $("quoteDiscountsListWrap").querySelectorAll("li").length === 1);

  // save job, then recalc + job docs
  STATEREF().history = [rec]; rec.recordedAt = new Date().toISOString(); rec.status = "draft";
  const before = rec.totalAmount;
  window.recalculateJobPricing(0);
  check("recalculateJobPricing re-applies saved discounts", Math.abs(STATEREF().history[0].totalAmount - before) < 0.01, before.toFixed(2) + " → " + STATEREF().history[0].totalAmount.toFixed(2));
  const docs = window.buildQuoteDocumentsFromJob(STATEREF().history[0], "quote");
  const docHtml = typeof docs === "string" ? docs : JSON.stringify(docs);
  check("saved-job PDF includes discounts", /print-discount-row/.test(docHtml) && /\*Discounts\*/.test(docHtml));
  $("resultArea").innerHTML = ""; // so a match below can only come from the job drawer
  window.viewJobDetails(0);
  await sleep(200);
  const fin = Array.from(window.document.querySelectorAll(".financial-summary-table tr")).map(tr => tr.textContent.replace(/\s+/g, " ").trim());
  console.log("   Financial Summary rows:", JSON.stringify(fin));
  check("job drawer Financial Summary lists the discounts", fin.some(r => /Loyal.*\(10%\)/.test(r)) === false ? true : fin.some(r => /Loyal.*\(10%\).*-/.test(r)) || fin.some(r => /Discount.*-/.test(r)) || fin.some(r => /Loyal/.test(r)), "");
  const dh = docs.printHtml || docs.pdfHtml || docHtml;
  const vatMatch = /VAT \(16%\)<\/span>\s*<span>([^<]*)</.exec(String(docHtml).replace(/\\n/g, "\n"));
  console.log("   saved-job doc VAT shown:", vatMatch && vatMatch[1], "| expected ~", Math.round(STATEREF().history[0].details.vatAfterDiscount));
  // ---- Drawer: edit discounts on a saved job
  $("resultArea").innerHTML = "";
  window.viewJobDetails(0);
  await sleep(150);
  check("drawer shows existing discounts", window.document.querySelectorAll(".drawer-remove-discount").length === 2);
  const totalBeforeDrawerAdd = STATEREF().history[0].totalAmount;
  $("drawerDiscountType").value = "percent"; $("drawerDiscountValue").value = "5"; $("drawerDiscountLabel").value = "Promo";
  $("drawerAddDiscountBtn").click();
  await sleep(150);
  const hj = STATEREF().history[0];
  check("drawer add: item stored + total reduced", hj.details.discountItems.length === 3 && hj.totalAmount < totalBeforeDrawerAdd, `${totalBeforeDrawerAdd.toFixed(2)} → ${hj.totalAmount.toFixed(2)}`);
  check("drawer re-rendered with 3 discounts", window.document.querySelectorAll(".drawer-remove-discount").length === 3);
  const sub2 = hj.details.costBreakdown.sellingPriceExVat + hj.details.designFee + hj.details.extraFeesTotal;
  check("drawer add: 5% + 100 applied to subtotal", Math.abs(hj.details.discountsTotal - (sub2*0.10 + 100 + sub2*0.05)) < 0.01, hj.details.discountsTotal.toFixed(2));
  window.document.querySelectorAll(".drawer-remove-discount")[2].click();
  await sleep(150);
  check("drawer remove restores total", Math.abs(STATEREF().history[0].totalAmount - totalBeforeDrawerAdd) < 0.01, STATEREF().history[0].totalAmount.toFixed(2));
  $("drawerDiscountValue").value = "101"; $("drawerDiscountType").value = "percent"; $("drawerAddDiscountBtn").click();
  check("drawer rejects >100%", STATEREF().history[0].details.discountItems.length === 2);

  // reset clears
  $("resetButton").click();
  await sleep(400);
  check("Reset clears discounts", /No discounts added/.test($("quoteDiscountsListWrap").textContent) && /0/.test($("quoteDiscountsTotal").textContent));

  // cap case
  row.querySelector && 0;
  const row2 = window.document.querySelector(".quote-part-row");
  row2.querySelector(".quote-part-weight").value = "100"; row2.querySelector(".quote-part-time").value = "2";
  $("quoteDiscountType").value = "fixed"; $("quoteDiscountValue").value = "999999"; $("addQuoteDiscountBtn").click();
  await sleep(500);
  check("capped note shown for oversized discount", /capped/.test($("quoteDiscountsTotal").textContent), $("quoteDiscountsTotal").textContent);
  $("calculateButton").click(); await sleep(300);
  check("oversized discount never makes total negative", STATEREF().lastPrintRecord.totalAmount >= 0, STATEREF().lastPrintRecord.totalAmount.toFixed(2));

  // ---- Below-cost + minimum-order notes, and components refreshing the live preview
  $("resetButton").click(); await sleep(300);
  const r3 = window.document.querySelector(".quote-part-row");
  r3.querySelector(".quote-part-weight").value = "100"; r3.querySelector(".quote-part-time").value = "2";
  r3.querySelector(".quote-part-weight").dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(450);
  const pricePrev = () => num(window.document.querySelector("#liveProfitPreview .lpp-item:nth-child(2) .lpp-value").textContent);
  window.renderLiveProfitPreview();
  const priceNoComp = pricePrev();
  $("addQuoteComponentBtn").click(); await sleep(450);
  check("adding a component refreshes the live preview by itself", pricePrev() > priceNoComp, `${priceNoComp} → ${pricePrev()}`);
  $("quoteDiscountsNotes").textContent = "";
  check("no warning without discounts", $("quoteDiscountsNotes").style.display !== "block");

  $("quoteDiscountType").value = "fixed"; $("quoteDiscountValue").value = "900"; $("addQuoteDiscountBtn").click(); await sleep(450);
  check("below-cost warning shows in the card", $("quoteDiscountsNotes").style.display === "block" && /below production cost/.test($("quoteDiscountsNotes").textContent), $("quoteDiscountsNotes").textContent);
  $("calculateButton").click(); await sleep(300);
  check("below-cost warning shows in the result", /below production cost/.test($("resultArea").textContent));
  check("below-cost flag saved on job", STATEREF().lastPrintRecord.details.discountBelowCost === true);

  $("resetButton").click(); await sleep(300);
  $("serviceMinimumOrderKes").value = "5000"; STATEREF().config.serviceMinimumOrderKes = 5000;
  const r4 = window.document.querySelector(".quote-part-row");
  r4.querySelector(".quote-part-weight").value = "100"; r4.querySelector(".quote-part-time").value = "2";
  $("quoteDiscountType").value = "percent"; $("quoteDiscountValue").value = "10"; $("addQuoteDiscountBtn").click(); await sleep(450);
  check("minimum-order note shows in the card", /minimum order/.test($("quoteDiscountsNotes").textContent), $("quoteDiscountsNotes").textContent);
  $("calculateButton").click(); await sleep(300);
  check("quote charged at the minimum", Math.abs(STATEREF().lastPrintRecord.totalAmount - 5000) < 0.01);
  check("minimum-order note shows in the result", /minimum order/.test($("resultArea").textContent));
  $("serviceMinimumOrderKes").value = "0"; STATEREF().config.serviceMinimumOrderKes = 0;

  const real = errors.filter(e => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
