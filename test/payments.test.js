"use strict";
// Deposits and part-payments: the Payments section on a job, the status in the
// Jobs list, deposit lines on quotes, and paid / balance-due lines on invoices.
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, errors, done } = await boot({
    configure(config) {
      config.companyInfo = { ...(config.companyInfo || {}), name: "PrintHub Test", quoteValidityDays: 7, depositPercent: 50 };
      config.invoiceDueDays = 7;
    },
  });
  await sleep(800);

  const nbsp = (s) => String(s).replace(/\u00a0/g, " ");
  const amt = (line) => { const m = nbsp(line).match(/(-)?KES ([\d,]+)/); return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN; };
  const lineOf = (text, re) => nbsp(text).split("\n").find((l) => re.test(l));
  const pdfText = (html) => nbsp(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

  // ---------------------------------------------------------------- a quote with a deposit
  const row = window.document.querySelector(".quote-part-row");
  row.querySelector(".quote-part-name").value = "Prototype";
  row.querySelector(".quote-part-weight").value = "300";
  row.querySelector(".quote-part-time").value = "12";
  $("calculateButton").click(); await sleep(450);
  let rec = STATEREF().lastPrintRecord;
  const total = rec.totalAmount;
  check("quote total is a whole number", Number.isInteger(total) && total > 0, String(total));

  const wa = rec.whatsappText;
  const depLine = lineOf(wa, /^Deposit to start \(50%\)/);
  const balLine = lineOf(wa, /^Balance on completion/);
  check("quote message asks for the deposit", !!depLine && !!balLine);
  check("deposit is 50% of the total", amt(depLine) === Math.round(total * 0.5), `${amt(depLine)} of ${total}`);
  check("deposit + balance on completion = total", amt(depLine) + amt(balLine) === total, `${amt(depLine)}+${amt(balLine)} vs ${total}`);
  const pdf = nbsp($("printInvoice").textContent).replace(/\s+/g, " ");
  check("PDF quote shows deposit and balance too", /Deposit to start \(50%\)/.test(pdf) && /Balance on completion/.test(pdf));

  STATEREF().config.companyInfo.depositPercent = 0;
  const noDeposit = window.buildQuoteDocumentsFromJob(rec, "quote");
  check("no deposit % set → no deposit lines anywhere", !/Deposit to start/.test(noDeposit.whatsappText) && !/Deposit to start/.test(noDeposit.printHtml));
  STATEREF().config.companyInfo.depositPercent = 50;

  const inv0 = window.buildQuoteDocumentsFromJob(rec, "invoice");
  check("invoice never shows a deposit request", !/Deposit to start/.test(inv0.whatsappText));
  check("invoice with no payments says Amount Due (unchanged)", /\*Amount Due: KES/.test(nbsp(inv0.whatsappText)) && !/Balance due/.test(inv0.whatsappText));

  // ---------------------------------------------------------------- recording payments in the drawer
  rec.recordedAt = new Date().toISOString(); rec.jobNumber = "PROD0001"; rec.invoiceNumber = "INV0001"; rec.status = "draft";
  STATEREF().history = [rec];
  const open = async () => { window.viewJobDetails(0); await sleep(120); };
  await open();
  check("Payments section is there", !!$("drawerAddPaymentBtn") && /Payments/.test($("jobDetailsContent").textContent));
  check("starts Unpaid, no payments", /Unpaid/.test($("jobDetailsContent").textContent) && /No payments recorded yet/.test($("jobDetailsContent").textContent));
  check("deposit target is shown and pre-filled as the amount", /Deposit requested/.test($("jobDetailsContent").textContent) && Number($("drawerPayAmount").value) === Math.round(total * 0.5), $("drawerPayAmount").value);

  // bad input is refused
  $("drawerPayAmount").value = "0"; $("drawerAddPaymentBtn").click();
  $("drawerPayAmount").value = "-50"; $("drawerAddPaymentBtn").click();
  $("drawerPayAmount").value = ""; $("drawerAddPaymentBtn").click();
  check("zero, negative and blank amounts are refused", (rec.payments || []).length === 0 && window.__alerts.filter((a) => /greater than 0/.test(a)).length === 3);

  // record the deposit (M-Pesa, with a code)
  rec.modifiedAt = "2000-01-01T00:00:00.000Z";
  $("drawerPayAmount").value = String(Math.round(total * 0.5));
  $("drawerPayMethod").value = "M-Pesa"; $("drawerPayNote").value = "QJK12345"; $("drawerPayDate").value = "2026-10-20";
  $("drawerAddPaymentBtn").click(); await sleep(120);
  rec = STATEREF().history[0];
  check("deposit recorded with method, date and note", rec.payments.length === 1 && rec.payments[0].amount === Math.round(total * 0.5) && rec.payments[0].method === "M-Pesa" && rec.payments[0].date === "2026-10-20" && rec.payments[0].note === "QJK12345", JSON.stringify(rec.payments));
  check("job marked modified so it re-syncs", rec.modifiedAt > "2000-01-01T00:00:00.000Z");
  let body = nbsp($("jobDetailsContent").textContent);
  check("drawer shows Part-paid, the payment, its note, and the balance", /Part-paid/.test(body) && /M-Pesa/.test(body) && /QJK12345/.test(body) && body.includes(`KES ${(total - Math.round(total * 0.5)).toLocaleString("en-US")}`));
  check("amount box now suggests the remaining balance", Number($("drawerPayAmount").value) === total - Math.round(total * 0.5), $("drawerPayAmount").value);
  check("Jobs list shows the balance", /Balance KES/.test(nbsp($("historyArea") ? $("historyArea").textContent : window.document.body.textContent)));

  // the invoice now shows what was paid
  let inv = window.buildQuoteDocumentsFromJob(rec, "invoice");
  let invWa = inv.whatsappText;
  const invTotal = amt(lineOf(invWa, /^\*Total:/));
  const paidLine = lineOf(invWa, /^• Payment received/);
  const balDue = amt(lineOf(invWa, /^\*Balance due:/));
  check("invoice: total, then the payment, then balance due", invTotal === total && amt(paidLine) === -Math.round(total * 0.5) && /M-Pesa/.test(paidLine), paidLine);
  check("invoice: total − payments = balance due", invTotal + amt(paidLine) === balDue, `${invTotal} ${amt(paidLine)} vs ${balDue}`);
  check("invoice no longer says Amount Due once something is paid", !/Amount Due/.test(invWa));
  const invPdf = pdfText(inv.printHtml);
  check("invoice PDF shows the payment and balance due", /Payment received/.test(invPdf) && /Balance due/.test(invPdf) && invPdf.includes(`KES ${balDue.toLocaleString("en-US")}`));
  check("quote PDF/message unaffected by payments", !/Payment received/.test(window.buildQuoteDocumentsFromJob(rec, "quote").whatsappText));

  // pay the rest with the shortcut
  await open();
  $("drawerPayFullBtn").click(); await sleep(120);
  rec = STATEREF().history[0];
  check("'Mark paid in full' records exactly the balance", rec.payments.length === 2 && rec.payments[1].amount === total - Math.round(total * 0.5) && window.getJobPaymentSummary(rec).status === "paid");
  body = nbsp($("jobDetailsContent").textContent);
  check("drawer says Paid in full; shortcut button gone", /Paid in full/.test(body) && !$("drawerPayFullBtn"));
  check("Jobs list shows Paid ✓", /Paid ✓/.test(nbsp(window.document.body.textContent)));
  inv = window.buildQuoteDocumentsFromJob(rec, "invoice");
  check("invoice: balance due 0 and says paid in full", /\*Balance due: KES 0\* — paid in full/.test(nbsp(inv.whatsappText)) && /paid in full/i.test(pdfText(inv.printHtml)));

  // remove a payment
  window.document.querySelectorAll(".drawer-remove-payment")[1].click(); await sleep(120);
  rec = STATEREF().history[0];
  check("removing a payment puts the balance back", rec.payments.length === 1 && window.getJobPaymentSummary(rec).status === "partial");

  // ---------------------------------------------------------------- completed jobs still take payments
  rec.status = "completed";
  await open();
  check("completed job: payment form still available (parts are locked, payments aren't)", !!$("drawerAddPaymentBtn") && !$("drawerAddPartBtn"));
  $("drawerPayAmount").value = "100"; $("drawerAddPaymentBtn").click(); await sleep(120);
  check("payment recorded on a completed job", STATEREF().history[0].payments.length === 2);

  // ---------------------------------------------------------------- overpayment, recalculation, flags
  $("drawerPayAmount").value = String(total * 2); $("drawerAddPaymentBtn").click(); await sleep(120);
  rec = STATEREF().history[0];
  check("overpaying is allowed and flagged", window.getJobPaymentSummary(rec).status === "overpaid" && /Overpaid/.test(nbsp($("jobDetailsContent").textContent)));
  inv = window.buildQuoteDocumentsFromJob(rec, "invoice");
  check("invoice shows a credit balance, not a negative amount due", /\*Credit balance: KES [\d,]+\*/.test(nbsp(inv.whatsappText)) && /Credit balance/.test(pdfText(inv.printHtml)));

  rec.status = "draft";
  const paymentsBefore = JSON.stringify(rec.payments);
  window.recalculateJobPricing(0);
  check("recalculating prices never touches recorded payments", JSON.stringify(STATEREF().history[0].payments) === paymentsBefore);
  check("payments are saved with the job", STATEREF().history[0].payments.length === 3);

  // ---------------------------------------------------------------- unpaid warning once invoiced
  const fresh = { ...JSON.parse(JSON.stringify(rec)), payments: [], status: "invoiced" };
  check("invoiced and nothing paid → flagged Unpaid in the list", /Unpaid/.test(window.buildPaymentBadgeHtml(fresh)));
  check("a draft with nothing paid shows no badge (no noise)", window.buildPaymentBadgeHtml({ ...fresh, status: "draft" }) === "");

  // ---------------------------------------------------------------- deposit % setting
  const setPct = (v) => { $("companyDepositPercent").value = v; window.syncCompanyInfoInputsToConfig(); return STATEREF().config.companyInfo.depositPercent; };
  check("deposit setting: 30 stays 30", setPct("30") === 30);
  check("deposit setting: 150 is capped at 100", setPct("150") === 100);
  check("deposit setting: negative / text become 0", setPct("-5") === 0 && setPct("abc") === 0);
  STATEREF().config.companyInfo.depositPercent = 25; window.setCompanyInfoInputs();
  check("deposit setting shows in Company settings", $("companyDepositPercent").value === "25");

  const real = errors.filter((e) => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
