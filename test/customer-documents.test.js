"use strict";
// What the CUSTOMER sees (WhatsApp message, PDF quote, invoice): it must not
// leak your cost drivers, and a customer with a calculator must be able to
// reproduce the total from the lines on the page.
const { boot } = require("./harness");

(async () => {
  const { window, $, STATEREF, sleep, check, errors, done } = await boot({
    configure(config) {
      config.extraFeeLineItems = [{ id: "f-sales", label: "Sales", value: 10, valueType: "percentage", enabled: true }];
      config.companyInfo = {
        ...(config.companyInfo || {}),
        name: "PrintHub Test", tagline: "Portable Printing", phone: "0700 000 000",
        taxId: "P000TEST", quoteValidityDays: 7, termsText: "50% deposit to start.",
      };
      config.invoiceDueDays = 7;
    },
  });
  await sleep(800);

  const nbsp = (s) => String(s).replace(/\u00a0/g, " ");
  const amt = (line) => {
    const m = nbsp(line).match(/(-)?KES ([\d,]+)/);
    return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN;
  };

  // Read a WhatsApp message the way a customer would, line by line.
  function readMessage(text) {
    const lines = nbsp(text).split("\n");
    const find = (re) => lines.findIndex((l) => re.test(l));
    const iItems = find(/^\*Items\*/), iSub = find(/^Subtotal:/);
    const iDisc = find(/^\*Discounts\*/), iTbv = find(/^Total before VAT:/);
    const iVat = find(/^VAT/), iAdj = find(/^Minimum order adjustment/), iTot = find(/^\*(Total|Amount Due):/);
    return {
      items: lines.slice(iItems + 1, iSub).filter((l) => l.startsWith("•")).map(amt),
      subtotal: amt(lines[iSub]),
      discounts: iDisc >= 0 ? lines.slice(iDisc + 1, iTbv).filter((l) => l.startsWith("•")).map(amt) : [],
      totalBeforeVat: iTbv >= 0 ? amt(lines[iTbv]) : amt(lines[iSub]),
      vatLabel: lines[iVat].split(":")[0],
      vat: amt(lines[iVat]),
      adjustment: iAdj >= 0 ? amt(lines[iAdj]) : 0,
      total: amt(lines[iTot]),
      totalText: (lines[iTot].match(/KES [\d,]+/) || [""])[0],
    };
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  // Does the customer's arithmetic work? Returns the parsed message.
  function verify(name, text, { vatPercent }) {
    const d = readMessage(text);
    check(`${name}: items add up to the subtotal`, sum(d.items) === d.subtotal, `${d.items.join("+")} vs ${d.subtotal}`);
    check(`${name}: subtotal − discounts = total before VAT`, d.subtotal + sum(d.discounts) === d.totalBeforeVat, `${d.subtotal} ${d.discounts.join(" ")} vs ${d.totalBeforeVat}`);
    check(`${name}: total before VAT + VAT (+ top-up) = total`, d.totalBeforeVat + d.vat + d.adjustment === d.total, `${d.totalBeforeVat}+${d.vat}+${d.adjustment} vs ${d.total}`);
    if (vatPercent != null) {
      check(`${name}: "VAT (${vatPercent}%)" really is ${vatPercent}% of the total before VAT`, d.vatLabel === `VAT (${vatPercent}%)` && d.vat === Math.round(d.totalBeforeVat * vatPercent / 100), `${d.vatLabel}: ${d.vat} vs ${Math.round(d.totalBeforeVat * vatPercent / 100)}`);
    } else {
      check(`${name}: VAT is not labelled with a percentage it doesn't match`, d.vatLabel === "VAT");
    }
    return d;
  }

  const pdfText = () => nbsp($("printInvoice").textContent).replace(/\s+/g, " ");
  const noInternals = (name, text) => {
    const t = nbsp(text);
    check(`${name}: no print hours`, !/\bhrs?\b|hours/i.test(t));
    check(`${name}: no weights in grams`, !/\d\s?g\b/.test(t) && !/material weight/i.test(t));
    check(`${name}: no fee names / margin / cost wording`, !/Sales|margin|profit|production cost/i.test(t));
  };

  // ------------------------------------------------------------ build a 2-part quote
  const row1 = window.document.querySelector(".quote-part-row");
  window.addQuotePartRow();
  const rows = window.document.querySelectorAll(".quote-part-row");
  const fill = (row, name, g, h) => {
    row.querySelector(".quote-part-name").value = name;
    row.querySelector(".quote-part-weight").value = String(g);
    row.querySelector(".quote-part-time").value = String(h);
  };
  fill(rows[0], "Otieno", 507, 40);
  fill(rows[1], "Kip", 518, 34);

  $("quoteDiscountType").value = "percent"; $("quoteDiscountValue").value = "10"; $("quoteDiscountLabel").value = "Loyal Customer"; $("addQuoteDiscountBtn").click();
  $("quoteDiscountType").value = "fixed"; $("quoteDiscountValue").value = "1100"; $("quoteDiscountLabel").value = "Agreed Previous Discount"; $("addQuoteDiscountBtn").click();

  // ------------------------------------------------------------ 1. VAT as it works today ("print")
  $("calculateButton").click(); await sleep(450);
  let rec = STATEREF().lastPrintRecord;
  check("default VAT rule is unchanged (print price only)", rec.details.vatMode === "print");
  let wa = verify("print-mode message", rec.whatsappText, { vatPercent: null });
  check("stored total equals the total on the message", rec.totalAmount === wa.total && Number.isInteger(rec.totalAmount), `${rec.totalAmount} vs ${wa.total}`);
  check("PDF shows the same total as the message", pdfText().includes(wa.totalText), wa.totalText);
  check("PDF shows both parts and both discounts", /Otieno/.test(pdfText()) && /Kip/.test(pdfText()) && /Loyal Customer \(10%\)/.test(pdfText()) && /Agreed Previous Discount/.test(pdfText()));
  noInternals("print-mode message", rec.whatsappText);
  noInternals("print-mode PDF", pdfText());
  check("tax ID is printed (message + PDF)", /Tax ID: P000TEST/.test(rec.whatsappText) && /Tax ID: P000TEST/.test(pdfText()));
  check("quote shows validity", /Valid until/.test(rec.whatsappText) && /Valid until/.test(pdfText()));
  const totalPrintMode = rec.totalAmount;

  // ------------------------------------------------------------ 2. switch the VAT rule in Settings
  check("Settings has the 'VAT Applies To' switch (locked until Edit)", !!$("vatAppliesTo") && $("vatAppliesTo").disabled === true && $("vatAppliesTo").value === "print");
  $("editFinancialsBtn").click();
  check("Edit unlocks it", $("vatAppliesTo").disabled === false);
  $("vatAppliesTo").value = "all";
  $("editFinancialsBtn").click();   // "Save Changes"
  check("saved to settings and locked again", STATEREF().config.vatAppliesTo === "all" && $("vatAppliesTo").disabled === true && $("vatAppliesTo").value === "all");

  $("calculateButton").click(); await sleep(450);
  rec = STATEREF().lastPrintRecord;
  check("quote now records the 'all' rule", rec.details.vatMode === "all");
  wa = verify("all-mode message", rec.whatsappText, { vatPercent: 16 });
  check("all-mode: stored total = total on message", rec.totalAmount === wa.total, `${rec.totalAmount} vs ${wa.total}`);
  check("all-mode: PDF shows the same total", pdfText().includes(wa.totalText));
  check("all-mode: PDF labels VAT (16%)", /VAT \(16%\)/.test(pdfText()));
  check("all-mode: total differs from print-mode (fees now taxed)", wa.total > totalPrintMode, `${totalPrintMode} → ${wa.total}`);
  noInternals("all-mode message", rec.whatsappText);

  // ------------------------------------------------------------ 3. saved quote == preview; invoice
  const rebuilt = window.buildQuoteDocumentsFromJob(rec, "quote");
  check("saved-quote message is identical to the preview", rebuilt.whatsappText === rec.whatsappText);
  rec.jobNumber = "PROD0012"; rec.invoiceNumber = "INV0007"; rec.recordedAt = new Date().toISOString(); rec.status = "draft";
  const inv = window.buildQuoteDocumentsFromJob(rec, "invoice");
  const invMsg = verify("invoice message", inv.whatsappText, { vatPercent: 16 });
  check("invoice total = quote total", invMsg.total === rec.totalAmount);
  check("invoice says Amount Due, with invoice no. and the quote it came from", /Amount Due/.test(inv.whatsappText) && /Invoice No\.: INV0007/.test(inv.whatsappText) && /Quote Ref: PROD0012/.test(inv.whatsappText));
  const invPdf = nbsp(inv.printHtml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  check("invoice PDF: title, refs, due date, tax ID, total", /Invoice/.test(invPdf) && /INV0007/.test(invPdf) && /Quote Ref: PROD0012/.test(invPdf) && /Due/.test(invPdf) && /Tax ID: P000TEST/.test(invPdf) && invPdf.includes(invMsg.totalText));
  noInternals("invoice message", inv.whatsappText);
  noInternals("invoice PDF", invPdf);

  // ------------------------------------------------------------ 4. recalculating keeps everything consistent
  STATEREF().history = [rec];
  window.recalculateJobPricing(0);
  const afterRecalc = STATEREF().history[0];
  const rcMsg = verify("after recalculation", window.buildQuoteDocumentsFromJob(afterRecalc, "quote").whatsappText, { vatPercent: 16 });
  check("recalculation keeps the same total", afterRecalc.totalAmount === rcMsg.total && Math.abs(afterRecalc.totalAmount - rec.totalAmount) <= 1, `${rec.totalAmount} → ${afterRecalc.totalAmount}`);

  // ------------------------------------------------------------ 5. quantity, 3 parts, minimum order
  $("resetButton").click(); await sleep(300);
  window.addQuotePartRow(); window.addQuotePartRow();
  const r3 = window.document.querySelectorAll(".quote-part-row");
  fill(r3[0], "Base", 120, 3); fill(r3[1], "Lid", 77, 2); fill(r3[2], "Clip", 33, 1);
  $("quantityWeight").value = "3";
  $("serviceMinimumOrderKes").value = "50000"; STATEREF().config.serviceMinimumOrderKes = 50000;
  $("calculateButton").click(); await sleep(450);
  rec = STATEREF().lastPrintRecord;
  wa = verify("3 parts + minimum order", rec.whatsappText, { vatPercent: 16 });
  check("3 parts listed, adding up exactly", wa.items.length === 3 && sum(wa.items) === wa.subtotal);
  check("minimum-order top-up is shown as its own line", wa.adjustment > 0 && wa.total === 50000, `${wa.adjustment} / ${wa.total}`);
  check("quantity stated on message and PDF", /Quantity: 3 sets/.test(rec.whatsappText) && /Quantity: 3 sets/.test(pdfText()));
  check("minimum-order top-up shown on PDF", /Minimum order adjustment/.test(pdfText()));
  $("serviceMinimumOrderKes").value = "0"; STATEREF().config.serviceMinimumOrderKes = 0;

  // ------------------------------------------------------------ 6. settings round trip
  window.setCompanyInfoInputs();
  check("Tax ID shows in Company settings", $("companyTaxId").value === "P000TEST");

  const real = errors.filter((e) => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
