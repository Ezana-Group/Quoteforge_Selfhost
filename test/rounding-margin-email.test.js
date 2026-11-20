"use strict";
// Price rounding, the target-margin warning, and the Email buttons — through the real UI.
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, errors, done } = await boot({
    configure(config) {
      config.companyInfo = { ...(config.companyInfo || {}), name: "PrintHub Test", quoteValidityDays: 7, termsText: "50% deposit to start." };
      config.invoiceDueDays = 7;
      config.customers = [
        { id: "cust1", company: "Storytime by Ivy", contactPerson: "Ivy Wanjiru", email: "ivy@example.com", phone: "0700 000 000" },
        { id: "cust2", company: "Hostile Ltd", contactPerson: "", email: "a@b.com?bcc=evil@x.com" },
        { id: "cust3", company: "Two Addresses", contactPerson: "Sam", email: "a@b.com, c@d.com" },
      ];
    },
  });
  await sleep(800);

  const nbsp = (s) => String(s).replace(/\u00a0/g, " ");
  const amt = (line) => { const m = nbsp(line).match(/(-)?KES ([\d,]+)/); return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN; };
  const readMessage = (text) => {
    const lines = nbsp(text).split("\n");
    const find = (re) => lines.findIndex((l) => re.test(l));
    const iSub = find(/^Subtotal:/), iTbv = find(/^Total before VAT:/), iVat = find(/^VAT/), iAdj = find(/^Minimum order adjustment/), iRound = find(/^Rounding:/), iTot = find(/^\*(Total|Amount Due):/);
    return { subtotal: amt(lines[iSub]), tbv: iTbv >= 0 ? amt(lines[iTbv]) : amt(lines[iSub]), vat: amt(lines[iVat]), adj: iAdj >= 0 ? amt(lines[iAdj]) : 0, rounding: iRound >= 0 ? amt(lines[iRound]) : 0, hasRounding: iRound >= 0, hasAdj: iAdj >= 0, total: amt(lines[iTot]) };
  };
  const pdfText = () => nbsp($("printInvoice").textContent).replace(/\s+/g, " ");
  const calc = async () => { $("calculateButton").click(); await sleep(420); return STATEREF().lastPrintRecord; };
  const settings = async (values) => {           // the real Edit → change → Save flow
    $("editFinancialsBtn").click();
    Object.entries(values).forEach(([id, v]) => { $(id).value = String(v); });
    $("editFinancialsBtn").click();
  };
  const fillPart = (g, h) => {
    const row = window.document.querySelector(".quote-part-row");
    row.querySelector(".quote-part-name").value = "Prototype";
    row.querySelector(".quote-part-weight").value = String(g);
    row.querySelector(".quote-part-time").value = String(h);
  };
  const mailtos = [];
  window.HTMLAnchorElement.prototype.click = function () { mailtos.push(this.getAttribute("href")); };

  check("Email button on the quote tab is off until there's a quote", $("emailQuoteButton").disabled === true);

  // ================================================================ ROUNDING
  fillPart(300, 12);
  const base = await calc();
  const total0 = base.totalAmount;
  check("no rounding by default: no Rounding line, nothing recorded", !readMessage(base.whatsappText).hasRounding && base.details.roundingStep === 0 && base.details.roundingAdjustment === 0);

  check("Settings has Round Quote Total (step + direction), locked until Edit", !!$("roundingStep") && $("roundingStep").disabled && $("roundingMode").disabled && $("roundingStep").value === "0" && $("roundingMode").value === "nearest");
  $("editFinancialsBtn").click();
  check("Edit unlocks both", !$("roundingStep").disabled && !$("roundingMode").disabled);
  $("roundingStep").value = "500"; $("roundingMode").value = "up";
  $("editFinancialsBtn").click();
  check("rounding settings are saved and locked again", STATEREF().config.roundingStep === 500 && STATEREF().config.roundingMode === "up" && $("roundingStep").disabled);

  let rec = await calc();
  for (let g = 301; rec.details.roundingAdjustment === 0 && g < 306; g++) { fillPart(g, 12); rec = await calc(); } // make sure it isn't an exact multiple
  let m = readMessage(rec.whatsappText);
  const pre = rec.details.preRoundingTotal;
  check("total is rounded UP to a multiple of 500", rec.totalAmount % 500 === 0 && rec.totalAmount >= pre - 1 && rec.totalAmount - pre < 501, `${pre.toFixed(2)} → ${rec.totalAmount}`);
  check("the Rounding line is on the message and equals the difference", m.hasRounding && m.rounding > 0 && rec.details.roundingAdjustment === m.rounding, `${m.rounding}/${rec.details.roundingAdjustment}`);
  check("customer arithmetic still works: total before VAT + VAT + rounding = total", m.tbv + m.vat + m.adj + m.rounding === m.total && m.total === rec.totalAmount, `${m.tbv}+${m.vat}+${m.rounding} vs ${m.total}`);
  check("the PDF shows the Rounding row and the same total", /Rounding \+KES [\d,]+/.test(pdfText()) && pdfText().includes(`KES ${rec.totalAmount.toLocaleString("en-US")}`));
  check("rounding is recorded with the job (step, direction, pre-rounding figure)", rec.details.roundingStep === 500 && rec.details.roundingMode === "up" && Math.abs(rec.details.preRoundingTotal - (rec.totalAmount - rec.details.roundingAdjustment)) <= 1);
  window.renderLiveProfitPreview();
  const previewPrice = Number(nbsp($("liveProfitPreview").querySelectorAll(".lpp-value")[1].textContent).replace(/[^0-9]/g, ""));
  check("the live preview price includes the rounding", Math.abs(previewPrice - rec.totalAmount) <= 1, `${previewPrice} vs ${rec.totalAmount}`);

  rec.jobNumber = "PROD0001"; rec.invoiceNumber = "INV0001"; rec.recordedAt = new Date().toISOString(); rec.status = "draft"; rec.name = "Prototype";
  STATEREF().history = [rec];
  window.viewJobDetails(0); await sleep(120);
  const fin = Array.from(window.document.querySelectorAll(".financial-summary-table tr")).map((tr) => nbsp(tr.textContent).replace(/\s+/g, " ").trim());
  check("saved-job Financial Summary shows the Rounding row (+, with the same amount)", fin.some((r) => r === `Rounding+KES ${rec.details.roundingAdjustment.toLocaleString("en-US")}`), fin.join(" | "));
  const totalBefore = rec.totalAmount;
  window.recalculateJobPricing(0);
  check("recalculating keeps the same rounded total", STATEREF().history[0].totalAmount === totalBefore, `${totalBefore} → ${STATEREF().history[0].totalAmount}`);
  const asDraft = JSON.parse(JSON.stringify(STATEREF().history[0])); delete asDraft.jobNumber;   // the message was built before a PROD number existed
  check("the saved quote rebuilds identically (message with the same Rounding line)", window.buildQuoteDocumentsFromJob(asDraft, "quote").whatsappText === rec.whatsappText);
  const invMsg = readMessage(window.buildQuoteDocumentsFromJob(rec, "invoice").whatsappText);
  check("the invoice carries the same rounding and total", invMsg.rounding === m.rounding && invMsg.total === m.total && invMsg.tbv + invMsg.vat + invMsg.rounding === invMsg.total);

  // jobs saved before this feature
  const oldJob = JSON.parse(JSON.stringify(rec));
  ["roundingStep", "roundingMode", "roundingAdjustment", "preRoundingTotal"].forEach((k) => delete oldJob.details[k]);
  oldJob.totalAmount = rec.totalAmount - rec.details.roundingAdjustment;
  const oldMsg = readMessage(window.buildQuoteDocumentsFromJob(oldJob, "quote").whatsappText);
  check("a job saved before rounding existed shows no Rounding or minimum-order line", !oldMsg.hasRounding && !oldMsg.hasAdj && oldMsg.total === oldJob.totalAmount, JSON.stringify(oldMsg));

  // nearest 100
  await settings({ roundingStep: 100, roundingMode: "nearest" });
  rec = await calc();
  m = readMessage(rec.whatsappText);
  check("nearest 100: lands on a multiple of 100 within 50 of the exact total", rec.totalAmount % 100 === 0 && Math.abs(rec.totalAmount - rec.details.preRoundingTotal) <= 50.5, `${rec.details.preRoundingTotal.toFixed(2)} → ${rec.totalAmount}`);
  check("…and the sum still works (rounding may be + or −)", m.tbv + m.vat + m.adj + m.rounding === m.total);

  // off again
  await settings({ roundingStep: 0 });
  fillPart(300, 12);
  rec = await calc();
  check("rounding switched off: exactly the original total again", rec.totalAmount === total0, `${rec.totalAmount} vs ${total0}`);
  check("…and no Rounding line", !readMessage(rec.whatsappText).hasRounding && rec.details.roundingAdjustment === 0);

  // minimum order first, then rounding
  await settings({ roundingStep: 500, roundingMode: "up" });
  $("serviceMinimumOrderKes").value = "50000"; STATEREF().config.serviceMinimumOrderKes = 50000;
  rec = await calc();
  m = readMessage(rec.whatsappText);
  check("minimum order lifts the quote to 50,000 and rounding then has nothing to add", rec.totalAmount === 50000 && m.hasAdj && !m.hasRounding && m.tbv + m.vat + m.adj === 50000, JSON.stringify(m));
  check("the saved minimum-order quote rebuilds identically", window.buildQuoteDocumentsFromJob(rec, "quote").whatsappText === rec.whatsappText);
  $("serviceMinimumOrderKes").value = "0"; STATEREF().config.serviceMinimumOrderKes = 0;
  await settings({ roundingStep: 0 });

  // ================================================================ TARGET MARGIN
  const previewMargin = () => { const items = Array.from($("liveProfitPreview").querySelectorAll(".lpp-item")); const it = items.find((i) => /Margin/.test(i.textContent)); return Number(nbsp(it.querySelector(".lpp-value").textContent).replace("%", "")); };
  fillPart(300, 12);
  window.renderLiveProfitPreview();
  check("the preview's margin is on the ex-VAT price, so it matches your 40% Settings margin", Math.abs(previewMargin() - 40) < 0.6, String(previewMargin()));
  check("no target set: no warning", !/below your/.test($("liveProfitPreview").textContent));

  check("Settings has 'Warn Below Margin', locked until Edit", !!$("targetMarginPercent") && $("targetMarginPercent").disabled && $("targetMarginPercent").value === "0");
  await settings({ targetMarginPercent: 45 });
  check("the target is saved", STATEREF().config.targetMarginPercent === 45 && $("targetMarginPercent").disabled);
  window.renderLiveProfitPreview();
  check("margin 40% < target 45%: live preview warns", /Margin 4\d\.\d% is below your 45% target|Margin 3\d\.\d% is below your 45% target/.test(nbsp($("liveProfitPreview").textContent)), nbsp($("liveProfitPreview").textContent).replace(/\s+/g, " "));
  rec = await calc();
  check("…the result warns too, and the job remembers", /below your 45% target/.test($("resultArea").textContent) && rec.details.marginBelowTarget === true && rec.details.targetMarginPercent === 45 && Math.abs(rec.details.marginPercent - 40) < 0.7, JSON.stringify([rec.details.marginPercent, rec.details.marginBelowTarget]));
  STATEREF().history = [rec]; rec.recordedAt = new Date().toISOString(); rec.status = "draft";
  window.viewJobDetails(0); await sleep(100);
  check("…and the saved job's Financial Summary shows the warning", /below your 45% target/.test($("jobDetailsContent").textContent));

  await settings({ targetMarginPercent: 35 });
  window.renderLiveProfitPreview();
  check("target 35%: base quote (40%) is fine — no warning", !/below your/.test($("liveProfitPreview").textContent));
  rec = await calc();
  check("…neither in the result nor on the job", !/below your/.test($("resultArea").textContent) && rec.details.marginBelowTarget === false);

  $("quoteDiscountType").value = "percent"; $("quoteDiscountValue").value = "30"; $("quoteDiscountLabel").value = "Friends"; $("addQuoteDiscountBtn").click(); await sleep(450);
  check("a 30% discount drags the margin under 35% → warning appears", /Margin \d+\.\d% is below your 35% target/.test(nbsp($("liveProfitPreview").textContent)), nbsp($("liveProfitPreview").textContent).replace(/\s+/g, " "));
  rec = await calc();
  check("…the result and job record it (margin ≈ 14%)", /below your 35% target/.test($("resultArea").textContent) && rec.details.marginBelowTarget === true && rec.details.marginPercent > 5 && rec.details.marginPercent < 25, String(rec.details.marginPercent));
  window.document.querySelector(".remove-quote-discount").click(); await sleep(450);
  check("removing the discount clears the warning", !/below your/.test($("liveProfitPreview").textContent));

  await settings({ targetMarginPercent: 0 });
  $("quoteDiscountType").value = "percent"; $("quoteDiscountValue").value = "30"; $("addQuoteDiscountBtn").click(); await sleep(450);
  rec = await calc();
  check("target 0 = off: no warning anywhere even with the 30% discount", !/below your/.test($("liveProfitPreview").textContent) && !/below your/.test($("resultArea").textContent) && rec.details.marginBelowTarget === false);
  window.document.querySelector(".remove-quote-discount").click(); await sleep(300);

  $("targetMarginPercent").value = "150"; window.syncFinanceInputsToConfig();
  check("target is capped at 100", STATEREF().config.targetMarginPercent === 100);
  $("targetMarginPercent").value = "-5"; window.syncFinanceInputsToConfig();
  check("negative target becomes 0 (off)", STATEREF().config.targetMarginPercent === 0);

  // stats tile
  const J = (name, status, total, cost) => ({ name, status, quantity: 1, recordedAt: "2026-10-10T09:00:00", printTimeHours: 5, totalAmount: total, parts: [{ materialCode: "PLA-RED", weightGrams: 10 }], payments: [], details: { customerCompany: "X", vatAfterDiscount: Math.round(total * 0.1), costBreakdown: { totalProductionCost: cost } } });
  STATEREF().history = [J("low", "completed", 11000, 8900), J("ok", "invoiced", 11000, 5000), J("quote", "quote_sent", 11000, 10000)];
  window.renderPrintHistory();
  check("with no target, the Jobs stats show no margin tile", !/Below target margin/.test($("jobStatsPanel").textContent));
  STATEREF().config.targetMarginPercent = 25; window.renderPrintHistory();
  const tileText = nbsp($("jobStatsPanel").textContent).replace(/\s+/g, " ");
  check("with a 25% target the Jobs stats count printed jobs below it (1 of 2; quotes ignored)", /Below target margin\s*1\s*of 2 printed jobs · target 25%/.test(tileText), tileText.slice(tileText.indexOf("Below"), tileText.indexOf("Below") + 70));
  window.document.querySelector('.nav-btn[data-tab="reports"]').click();
  $("reportPeriod").value = "all"; $("reportPeriod").dispatchEvent(new window.Event("change", { bubbles: true }));
  const reportText = nbsp($("reportsResults").textContent).replace(/\s+/g, " ");
  check("…and so does the Reports tab (1 of 2 printed jobs)", /Below target margin\s*1\s*of 2 printed jobs · target 25%/.test(reportText), reportText.slice(reportText.indexOf("Below"), reportText.indexOf("Below") + 70));
  STATEREF().config.targetMarginPercent = 0;

  // ================================================================ EMAIL
  const E = (job, kind) => window.buildQuoteEmail(job, kind);
  const ej = JSON.parse(JSON.stringify(rec));
  ej.customerId = "cust1"; ej.name = "Prototype"; ej.jobNumber = "PROD0007"; ej.recordedAt = new Date().toISOString(); ej.status = "draft";
  ej.details.customerCompany = "Storytime by Ivy"; ej.details.customerContact = "Ivy Wanjiru";
  delete ej.invoiceNumber; ej.payments = [];
  let e = E(ej, "quote");
  check("recipient comes from the customer record", e.to === "ivy@example.com" && e.url.startsWith("mailto:ivy@example.com?subject="));
  check("subject names the company, the document, its number and the project", e.subject === "PrintHub Test — Quote PROD0007 (Prototype)", e.subject);
  check("body greets by first name and introduces the quote", e.body.startsWith("Hi Ivy,\n\nPlease find your quote below.\n\n"));
  check("body has the totals, as plain text (no chat asterisks)", /Total: KES [\d,]+/.test(e.body) && !/\*/.test(e.body) && /Subtotal: KES/.test(e.body));
  check("body includes the terms and signs off with the company name", /50% deposit to start\./.test(e.body) && /Kind regards,\nPrintHub Test$/.test(e.body) && e.trimmed === false);
  const decoded = decodeURIComponent(e.url.split("&body=")[1]);
  check("the link carries exactly that body (encoded properly)", decoded === e.body);
  check("the figures in the email are the figures in the quote", Number((e.body.match(/Total: KES ([\d,]+)/) || [])[1].replace(/,/g, "")) === ej.totalAmount);

  const ej2 = JSON.parse(JSON.stringify(ej)); ej2.invoiceNumber = "INV0007"; ej2.payments = [{ amount: 1000, date: "2026-10-20", method: "M-Pesa" }];
  e = E(ej2, "invoice");
  check("invoice email: invoice subject, balance due and the payment received", e.subject === "PrintHub Test — Invoice INV0007 (Prototype)" && /Please find your invoice below\./.test(e.body) && /Payment received/.test(e.body) && /Balance due: KES/.test(e.body));

  const ej3 = JSON.parse(JSON.stringify(ej)); delete ej3.customerId; ej3.details.customerContact = "";
  e = E(ej3, "quote");
  check("no customer on the job: opens a blank 'To', plain greeting", e.to === "" && e.url.startsWith("mailto:?subject=") && e.body.startsWith("Hello,\n\n"));
  const ej4 = JSON.parse(JSON.stringify(ej)); ej4.customerId = "cust2";
  check("a booby-trapped address (extra ?bcc=…) is ignored, not passed to the mail app", E(ej4, "quote").to === "" && !/bcc/.test(E(ej4, "quote").url.split("&body=")[0]));
  const ej5 = JSON.parse(JSON.stringify(ej)); ej5.customerId = "cust3";
  check("two addresses in one field are ignored too", E(ej5, "quote").to === "");

  STATEREF().config.companyInfo.termsText = "Long terms. ".repeat(400);
  e = E(ej, "quote");
  check("very long terms: the link is kept short enough for desktop mail apps", e.url.length <= 1900 && e.trimmed === true, `${e.url.length} chars`);
  check("…the terms were dropped but the quote, total and sign-off are intact", !/Long terms/.test(e.body) && /Total: KES/.test(e.body) && /Kind regards/.test(e.body));
  STATEREF().config.companyInfo.termsText = "50% deposit to start.";

  // buttons
  STATEREF().history = [ej, ej2];
  window.viewJobDetails(0); await sleep(120);
  check("job drawer has Email Quote; Email Invoice only when there's an invoice", !!$("jobDetailEmailBtn") && !$("jobDetailEmailInvoiceBtn"));
  mailtos.length = 0;
  $("jobDetailEmailBtn").click(); await sleep(150);
  check("Email Quote opens the mail app with the customer's address", mailtos.length === 1 && mailtos[0].startsWith("mailto:ivy@example.com?subject="), mailtos[0] && mailtos[0].slice(0, 60));
  check("emailing a draft quote marks it Quote sent (like WhatsApp does)", STATEREF().history[0].status === "quote_sent");
  window.viewJobDetails(1); await sleep(120);
  check("a job with an invoice number gets Email Invoice", !!$("jobDetailEmailInvoiceBtn"));
  mailtos.length = 0;
  $("jobDetailEmailInvoiceBtn").click(); await sleep(100);
  check("Email Invoice opens an invoice email and leaves the status alone", mailtos.length === 1 && /Invoice%20INV0007/.test(mailtos[0]) && STATEREF().history[1].status === "draft", mailtos[0] && mailtos[0].slice(0, 80));

  // from the Quote tab
  window.document.querySelector('.nav-btn[data-tab="quote"]').click();
  $("resetButton").click(); await sleep(300);
  fillPart(300, 12);
  await calc();
  check("after calculating, the Email button on the Quote tab is enabled", $("emailQuoteButton").disabled === false);
  mailtos.length = 0;
  const jobsBefore = STATEREF().history.length;
  const sentBefore = STATEREF().history.filter((j) => j.status === "quote_sent").length;
  $("emailQuoteButton").click(); await sleep(200);
  check("it saves the quote as 'Quote sent' and opens the mail app", mailtos.length === 1 && /^mailto:/.test(mailtos[0]) && STATEREF().history.length === jobsBefore + 1 && STATEREF().history.filter((j) => j.status === "quote_sent").length === sentBefore + 1, `${mailtos.length} ${STATEREF().history.length} ${STATEREF().history.map((j) => j.status).join()}`);

  const real = errors.filter((x) => !/Could not parse CSS|Not implemented|navigation/.test(x));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
