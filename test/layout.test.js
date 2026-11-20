"use strict";
// Page layout and the order of things: the job drawer reads Fees → Discounts →
// Financial Summary → Payments; the Quote tab is organised into columns and
// uses the whole window. (jsdom has no layout engine, so this checks the page
// structure and the CSS rules that produce the layout.)
const fs = require("fs");
const path = require("path");
const { boot } = require("./harness");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

(async () => {
  const { window, $, STATEREF, sleep, check, errors, done } = await boot();
  await sleep(800);
  const doc = window.document;
  const text = (el) => String(el.textContent).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  // ---------------------------------------------------------------- Quote tab structure
  const inputCol = doc.querySelector(".quote-input-col");
  const stacks = Array.from(inputCol.querySelectorAll(":scope > .quote-input-stack"));
  check("Quote inputs are split into two stacks", stacks.length === 2);
  const idsIn = (stack) => Array.from(stack.querySelectorAll("[id]")).map((e) => e.id);
  check("stack 1 = Job Details then Project Parts", idsIn(stacks[0]).includes("calculateButton") && !!stacks[0].querySelector(".quote-part-row") && idsIn(stacks[0]).includes("quantityWeight"));
  const order1 = Array.from(stacks[0].children).map((c) => c.querySelector("h2, h3") ? text(c.querySelector("h2, h3")) : "");
  check("Job Details comes before Project Parts (parts are the main input, no longer last)", /Job Details/.test(order1[0]) && /Project Parts/.test(order1[1]), order1.join(" | "));
  const order2 = Array.from(stacks[1].children).map((c) => text(c.querySelector("h3, h2")));
  check("stack 2 = Components, Extra fees, Discounts", order2.join(" | ") === "Components | Extra fees | Discounts", order2.join(" | "));
  check("the result panel is its own column, after the inputs", inputCol.nextElementSibling && inputCol.nextElementSibling.classList.contains("quote-result-col") && !!inputCol.nextElementSibling.querySelector("#resultArea"));
  ["calculateButton", "resetButton", "addQuoteDiscountBtn", "addQuoteComponentBtn", "quoteExtraFeesCard", "quoteDiscountsCard", "emailQuoteButton", "whatsappQuoteButton", "printQuoteButton", "saveJobButton"].forEach((id) => {
    if (doc.querySelectorAll(`#${id}`).length !== 1) check(`element #${id} exists exactly once`, false);
  });
  check("every quote control survived the re-arrangement", ["calculateButton", "resetButton", "addQuoteDiscountBtn", "addQuoteComponentBtn", "quoteExtraFeesCard", "quoteDiscountsCard", "emailQuoteButton", "whatsappQuoteButton", "printQuoteButton", "saveJobButton"].every((id) => doc.querySelectorAll(`#${id}`).length === 1));

  // ---------------------------------------------------------------- CSS behind the full-width layout
  const shell = (css.match(/\.app-shell \{[^}]*\}/) || [""])[0];
  const maxW = Number((shell.match(/max-width:\s*(\d+)px/) || [])[1]);
  check("the app is no longer capped at 1400px (now 2560px, fluid below that)", maxW >= 2000 && /width:\s*100%/.test(shell), shell.replace(/\s+/g, " "));
  check("header is a grid: brand | nav | status", /\.topbar \{[^}]*display:\s*grid[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/.test(css));
  check("header falls back to two rows on narrower screens (nav gets a row of its own)", /@media \(max-width: 1320px\)[\s\S]*?\.action-nav \{[^}]*grid-row:\s*2/.test(css));
  check("result panel stays in view on screens ≥ 1024px (sticky, own scroll)", /@media \(min-width: 1024px\)[\s\S]*?\.quote-result-col \{[^}]*position:\s*sticky[^}]*max-height:\s*calc\(100vh - 32px\)[^}]*overflow-y:\s*auto/.test(css));
  check("screens ≥ 1700px get a second inputs column", /@media \(min-width: 1700px\)[\s\S]*?\.quote-input-col \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css));
  check("result toolbar wraps on phones (four buttons)", /\.result-header \.header-actions \{[^}]*flex-wrap:\s*wrap/.test(css));
  check("stacked cards are spaced by the column gap only", /\.quote-input-stack > \.card \{[^}]*margin-bottom:\s*0/.test(css));
  check("no leftover 1400px cap anywhere in the CSS", !/max-width:\s*1400px/.test(css));

  // ---------------------------------------------------------------- bugs a real browser exposed
  $("calculateButton").click();   // not needed for the card, but exercises the render path
  const feeLabel = doc.querySelector("#quoteExtraFeesWrap label");
  STATEREF().config.extraFeeLineItems = [{ id: "f1", label: "Sales", value: 10, valueType: "percentage", enabled: true }];
  window.renderQuoteExtraFeesCard();
  check("Extra fees rows are laid out as rows (label left, value right), not stacked", /flex-direction:\s*row/.test(doc.querySelector("#quoteExtraFeesWrap label").getAttribute("style")));
  check("the discount 'Type' box is wide enough for 'Amount (KES)'", /flex:\s*0 0 (1[8-9]\d|2\d\d)px/.test($("quoteDiscountType").closest("label").getAttribute("style")));
  $("statusPanel").textContent = "Saved 3 jobs to the Google Sheet."; await sleep(30);
  check("the (truncated) status chip keeps the full message as a tooltip", $("statusPanel").title === "Saved 3 jobs to the Google Sheet.", $("statusPanel").title);

  // ---------------------------------------------------------------- job drawer: order of sections
  const row = doc.querySelector(".quote-part-row");
  row.querySelector(".quote-part-name").value = "Part"; row.querySelector(".quote-part-weight").value = "200"; row.querySelector(".quote-part-time").value = "10";
  $("calculateButton").click(); await sleep(450);
  const rec = STATEREF().lastPrintRecord;
  rec.recordedAt = new Date().toISOString(); rec.status = "draft"; rec.name = "Part"; rec.invoiceNumber = "INV1";
  STATEREF().history = [rec];
  window.viewJobDetails(0); await sleep(150);
  const headings = Array.from(doc.querySelectorAll("#jobDetailsContent h3")).map(text);
  const pos = (name) => headings.findIndex((h) => h.startsWith(name));
  check("drawer reads: Parts → Components → Fees → Discounts → Financial Summary → Payments → Cost Breakdown → Images", ["Project Parts", "Components", "Fees", "Discounts", "Financial Summary", "Payments", "Cost Breakdown", "Attached Images"].every((n, i, arr) => pos(n) >= 0 && (i === 0 || pos(arr[i - 1]) < pos(n))), headings.join(" → "));
  check("Payments never comes before Fees or Discounts", pos("Payments") > pos("Fees") && pos("Payments") > pos("Discounts"));
  const paySection = $("jobPaymentsSection");
  const prev = paySection.previousElementSibling;
  check("Payments sits directly under the Financial Summary, in the same column", !!prev && /Financial Summary/.test(text(prev)) && paySection.parentElement === prev.parentElement);
  const cols = doc.querySelectorAll("#jobDetailsContent .job-detail-col");
  check("left column = inputs (Parts, Components, Fees, Discounts); right = money (Summary, Payments, Costs, Images)", cols.length === 2 && /Fees/.test(text(cols[0])) && /Discounts/.test(text(cols[0])) && !/Payments/.test(text(cols[0])) && /Financial Summary/.test(text(cols[1])) && /Payments/.test(text(cols[1])) && /Attached Images/.test(text(cols[1])));
  check("the Cost Breakdown says it's the estimate before fees and discounts", /estimate before fees and discounts/.test(text($("jobDetailsContent"))));

  // ---------------------------------------------------------------- the Payments card
  const details = paySection.querySelector("details.payment-form");
  check("the payment form is collapsed until you ask for it", !!details && !details.hasAttribute("open") && /\+ Record a payment/.test(text(details.querySelector("summary"))));
  check("…but its fields exist, pre-filled (amount, method, date, note)", !!$("drawerPayAmount") && Number($("drawerPayAmount").value) > 0 && !!$("drawerPayMethod") && !!$("drawerPayDate") && !!$("drawerPayNote"));
  check("the card shows just Paid so far and Balance due (the total is in the summary above)", /Paid so far/.test(text(paySection)) && /Balance due/.test(text(paySection)) && !/\bTotal\b/.test(text(paySection.querySelector(".compact-list"))));
  details.setAttribute("open", ""); $("drawerPayAmount").value = "100"; $("drawerAddPaymentBtn").click(); await sleep(150);
  check("after saving, the form closes again and the payment is listed", !$("jobPaymentsSection").querySelector("details").hasAttribute("open") && /KES 100/.test(text($("jobPaymentsSection"))) && STATEREF().history[0].payments.length === 1);

  // ---------------------------------------------------------------- payment status pill at the top of a job
  const pill = (job) => { const el = doc.createElement("div"); el.innerHTML = window.buildPaymentPillHtml(job); return text(el); };
  const j = (status, payments) => ({ status, totalAmount: 1000, payments });
  check("draft with nothing paid: no pill (no noise)", pill(j("draft", [])) === "" && pill(j("quote_sent", [])) === "");
  check("invoiced / completed and unpaid: 'Unpaid'", pill(j("invoiced", [])) === "Unpaid" && pill(j("completed", [])) === "Unpaid");
  check("part-paid: shows what's still due", pill(j("invoiced", [{ amount: 400 }])) === "Part-paid · KES 600 due", pill(j("invoiced", [{ amount: 400 }])));
  check("paid in full: 'Paid ✓'; overpaid says so", pill(j("completed", [{ amount: 1000 }])) === "Paid ✓" && pill(j("completed", [{ amount: 1500 }])) === "Overpaid");
  window.viewJobDetails(0); await sleep(100);
  check("the pill appears in the job's top card next to the status", /Part-paid · KES [\d,]+ due/.test(text(doc.querySelector(".job-overview-card"))), text(doc.querySelector(".job-overview-card")).slice(0, 120));

  const real = errors.filter((e) => !/Could not parse CSS|Not implemented|navigation/.test(e));
  check("no unexpected runtime errors", real.length === 0, real.slice(0, 3).join(" | "));
  done();
})();
