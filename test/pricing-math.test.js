"use strict";
// Unit tests for the manual-discount maths (pure functions pulled out of calculator.js).
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "calculator.js"), "utf8");
const start = src.indexOf("function discountRowLabel");
const end = src.indexOf("function calculateExtraFees");
(0, eval)(src.slice(start, end)); // indirect eval: defines the functions globally even under "use strict"

const approx = (a, b) => Math.abs(a - b) < 0.01;
let fail = 0;
const check = (name, cond, extra="") => { console.log((cond ? "PASS " : "FAIL ") + name + " " + extra); if (!cond) fail++; };

// estimate: print price ex VAT 1000, VAT 16% => 160
const est = { sellingPriceExVat: 1000, vatAmount: 160, sellingPriceIncVat: 1160 };

// 1. no discounts == old formula
let r = applyQuoteDiscounts(est, 200, 50, []);
check("no discounts equals old total", approx(r.totalBeforeMinOrder, 1160 + 200 + 50), r.totalBeforeMinOrder);

// 2. single percent: 10% of subtotal 1250 = 125
r = applyQuoteDiscounts(est, 200, 50, [{type:"percent", value:10}]);
check("10% of subtotal", approx(r.discountsTotal, 125), r.discountsTotal);
// taxable share = 1000/1250 = .8 -> VAT base 1000 - 100 = 900 -> 144
check("VAT recomputed on discounted print price", approx(r.vatAmount, 144), r.vatAmount);
check("total = 1250-125+144", approx(r.totalBeforeMinOrder, 1269), r.totalBeforeMinOrder);

// 3. multiple: 10% + 100 fixed + 5% (percentages add, not compound)
r = applyQuoteDiscounts(est, 0, 0, [{type:"percent", value:10},{type:"fixed", value:100},{type:"percent", value:5}]);
check("multiple discounts add up", approx(r.discountsTotal, 100 + 100 + 50), r.discountsTotal);
check("row count", r.rows.length === 3);
check("total (no fees): VAT on 750", approx(r.totalBeforeMinOrder, 750 * 1.16), r.totalBeforeMinOrder);

// 4. cap at subtotal
r = applyQuoteDiscounts(est, 0, 0, [{type:"fixed", value:800},{type:"fixed", value:800}]);
check("capped at subtotal", approx(r.discountsTotal, 1000) && r.capped, JSON.stringify([r.discountsTotal, r.capped]));
check("capped total is 0", approx(r.totalBeforeMinOrder, 0), r.totalBeforeMinOrder);
check("row amounts sum to capped total", approx(r.rows.reduce((s,x)=>s+x.amount,0), 1000));

// 5. zero VAT
r = applyQuoteDiscounts({sellingPriceExVat:1000, vatAmount:0, sellingPriceIncVat:1000}, 0, 0, [{type:"percent", value:20}]);
check("zero-VAT", approx(r.totalBeforeMinOrder, 800), r.totalBeforeMinOrder);

// 6. invalid entries ignored
r = applyQuoteDiscounts(est, 0, 0, [{type:"percent", value:0},{type:"fixed", value:-5},{type:"fixed"}]);
check("invalid ignored", r.rows.length === 0 && approx(r.totalBeforeMinOrder, 1160));

// 7. label
check("label percent", discountRowLabel({label:"Loyal", type:"percent", value:10}) === "Loyal (10%)");
check("label fixed default", discountRowLabel({label:"", type:"fixed", value:100}) === "Discount");

// ---------------------------------------------------------------- VAT modes
r = applyQuoteDiscounts(est, 200, 50, [{type:"percent", value:10}], { mode: "all", ratePercent: 16 });
check("VAT 'all': subtotal 1250 − 125 discount = 1125, VAT 16% = 180", approx(r.vatAmount, 180) && r.vatMode === "all", r.vatAmount);
check("VAT 'all': total = 1125 + 180", approx(r.totalBeforeMinOrder, 1305), r.totalBeforeMinOrder);
r = applyQuoteDiscounts(est, 200, 50, [{type:"percent", value:10}], { mode: "print", ratePercent: 16 });
check("VAT 'print' unchanged (144 on discounted print price)", approx(r.vatAmount, 144) && r.vatMode === "print", r.vatAmount);
r = applyQuoteDiscounts(est, 200, 50, [], undefined);
check("no VAT options → original behaviour", approx(r.totalBeforeMinOrder, 1410) && r.vatMode === "print");

// ---------------------------------------------------------------- whole-unit allocation
const sum = (a) => a.reduce((x, y) => x + y, 0);
check("allocateWholeUnits adds up exactly", sum(allocateWholeUnits([5949.6, 6078.4], 12028)) === 12028);
check("allocateWholeUnits thirds", sum(allocateWholeUnits([1, 1, 1], 10)) === 10);
check("allocateWholeUnits no parts", allocateWholeUnits([], 5).length === 0);
check("allocateWholeUnits zero weights splits evenly", sum(allocateWholeUnits([0, 0], 7)) === 7);

// ---------------------------------------------------------------- the customer ladder (a real quote)
const disc = [{ label: "Loyal Customer", type: "percent", value: 10, amount: 1202.825 }, { label: "Agreed", type: "fixed", value: 1100, amount: 1100 }];
let L = buildCustomerLadder({ partAmounts: [5949.6, 6078.65], subtotalExact: 12028.25, discountRows: disc, vatMode: "all", vatRatePercent: 16, vatExact: 1556, totalExact: 11281.49 });
check("ladder: items add up to subtotal", sum(L.items) === L.subtotal && L.subtotal === 12028, JSON.stringify(L.items));
check("ladder: discounts rounded (1203 + 1100)", L.discounts.map((d) => d.amount).join() === "1203,1100");
check("ladder: total before VAT = 9725", L.totalBeforeVat === 9725);
check("ladder 'all': VAT = 16% of total before VAT = 1556, total 11281", L.vat === 1556 && L.total === 11281 && L.adjustment === 0, `${L.vat}/${L.total}`);
L = buildCustomerLadder({ partAmounts: [5949.6, 6078.65], subtotalExact: 12028.25, discountRows: disc, vatMode: "print", vatRatePercent: 16, vatExact: 1411.56, totalExact: 11136.99 });
check("ladder 'print': VAT 1412, total 11137", L.vat === 1412 && L.total === 11137 && L.vatMode === "print", `${L.vat}/${L.total}`);
L = buildCustomerLadder({ partAmounts: [1000], subtotalExact: 1000, discountRows: [], vatMode: "all", vatRatePercent: 16, vatExact: 160, totalExact: 5000 });
check("ladder: minimum-order top-up shown as its own amount", L.adjustment === 5000 - 1160 && L.total === 5000, `${L.adjustment}/${L.total}`);
L = buildCustomerLadder({ partAmounts: [1000], subtotalExact: 1000, discountRows: [{ amount: 800 }, { amount: 800 }], vatMode: "all", vatRatePercent: 16, vatExact: 0, totalExact: 0 });
check("ladder: discounts can't exceed the subtotal (800 + 200, not 800 + 800)", L.discountsTotal === 1000 && L.totalBeforeVat === 0 && L.total === 0 && L.discounts.map((d) => d.amount).join() === "800,200", JSON.stringify(L.discounts.map((d) => d.amount)));

// every line is arithmetic on the lines above, for lots of random quotes
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let bad = 0;
for (let i = 0; i < 1000; i++) {
  const n = 1 + Math.floor(rnd() * 5);
  const parts = Array.from({ length: n }, () => rnd() * 9000 + 1);
  const subtotalExact = sum(parts) + rnd() * 500;
  const rows = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ amount: rnd() * subtotalExact * 0.4 }));
  const rate = [0, 8, 16][Math.floor(rnd() * 3)];
  const mode = rnd() < 0.5 ? "all" : "print";
  const l = buildCustomerLadder({ partAmounts: parts, subtotalExact, discountRows: rows, vatMode: mode, vatRatePercent: rate, vatExact: rnd() * 2000, totalExact: 0 });
  const ok = sum(l.items) === l.subtotal
    && l.subtotal - l.discountsTotal === l.totalBeforeVat
    && sum(l.discounts.map((d) => d.amount)) === l.discountsTotal
    && l.totalBeforeVat + l.vat + l.adjustment === l.total
    && l.totalBeforeVat >= 0
    && (mode !== "all" || l.vat === Math.round(l.totalBeforeVat * rate / 100))
    && Number.isInteger(l.total);
  if (!ok) bad++;
}
check("1000 random quotes: every line adds up exactly, in whole units", bad === 0, bad + " bad");


// ---------------------------------------------------------------- payments
let ps = getJobPaymentSummary({ totalAmount: 11137 });
check("no payments → unpaid, balance = total", ps.status === "unpaid" && ps.paid === 0 && ps.balance === 11137);
ps = getJobPaymentSummary({ totalAmount: 11137, payments: [{ amount: 5569 }] });
check("deposit received → part-paid", ps.status === "partial" && ps.paid === 5569 && ps.balance === 5568);
ps = getJobPaymentSummary({ totalAmount: 11137, payments: [{ amount: 5569 }, { amount: 5568 }] });
check("fully paid in two instalments → paid, balance 0", ps.status === "paid" && ps.balance === 0);
ps = getJobPaymentSummary({ totalAmount: 1000, payments: [{ amount: 1200 }] });
check("paying too much → overpaid, negative balance", ps.status === "overpaid" && ps.balance === -200);
ps = getJobPaymentSummary({ totalAmount: 1000, payments: [{ amount: "x" }, {}, { amount: 250.4 }] });
check("junk entries are ignored; amounts counted in whole units", ps.paid === 250 && ps.status === "partial");
check("no job at all doesn't crash", getJobPaymentSummary(null).status === "unpaid");
check("deposit 50% of 11137 = 5569 (rounded), balance 5568", getDepositAmount(11137, 50) === 5569 && 11137 - getDepositAmount(11137, 50) === 5568);
check("deposit 0% / blank / junk = 0", getDepositAmount(11137, 0) === 0 && getDepositAmount(11137, "") === 0 && getDepositAmount(11137, "abc") === 0);
check("deposit above 100% is capped at 100%", getDepositAmount(1000, 250) === 1000);
check("formatPaymentDate: date-only string keeps its day", (() => { const d = formatPaymentDate("2026-10-27"); return /27/.test(d) && /10|Oct/.test(d); })());
check("formatPaymentDate: bad input is blank, not 'Invalid Date'", formatPaymentDate("nope") === "" && formatPaymentDate("") === "");


// ---------------------------------------------------------------- rounding
check("round to 10 (nearest): 11137 → 11140, 11134 → 11130", applyRounding(11137, 10, "nearest") === 11140 && applyRounding(11134, 10, "nearest") === 11130);
check("nearest rounds halves up: 11135 → 11140", applyRounding(11135, 10, "nearest") === 11140);
check("always up: 11131 → 11140, and an exact multiple stays put", applyRounding(11131, 10, "up") === 11140 && applyRounding(11140, 10, "up") === 11140);
check("always up isn't fooled by floating-point dust (11140.0000000001)", applyRounding(11140.0000000001, 10, "up") === 11140);
check("up to 100 / nearest 500", applyRounding(11101, 100, "up") === 11200 && applyRounding(11249, 500, "nearest") === 11000 && applyRounding(11250, 500, "nearest") === 11500);
check("step 0, 1, blank or junk leaves the total alone", applyRounding(11137, 0, "up") === 11137 && applyRounding(11137, 1, "up") === 11137 && applyRounding(11137, "", "up") === 11137 && applyRounding(11137, "x", "nearest") === 11137);

// ---------------------------------------------------------------- margin
check("margin on the ex-VAT price: (9725 − 8729) ÷ 9725 = 10.24%", approx(calcMarginPercent(11137, 1412, 8729), 10.24, 0.01), calcMarginPercent(11137, 1412, 8729));
check("a quote at the Settings margin reads exactly that margin (20%)", approx(calcMarginPercent(12657, 1746, 8729), 20.0, 0.01), calcMarginPercent(12657, 1746, 8729));
check("margin can't be worked out without a cost or a price", calcMarginPercent(1000, 100, 0) === null && calcMarginPercent(0, 0, 500) === null && calcMarginPercent(100, 100, 50) === null);
check("selling below cost gives a negative margin", calcMarginPercent(1160, 160, 1200) < 0);
check("below-target test: 19.9 < 20 yes, 19.96 no (tolerance), 20 no", isBelowTargetMargin(19.9, 20) && !isBelowTargetMargin(19.96, 20) && !isBelowTargetMargin(20, 20));
check("below-target is off when the target is 0 / blank, or margin unknown", !isBelowTargetMargin(1, 0) && !isBelowTargetMargin(1, "") && !isBelowTargetMargin(null, 20));
check("margin note reads naturally", buildMarginNote(10.2386, 20) === "Margin 10.2% is below your 20% target.");

// ---------------------------------------------------------------- the ladder with rounding
const baseArgs = { partAmounts: [5949.6, 6078.65], subtotalExact: 12028.25, discountRows: disc, vatMode: "all", vatRatePercent: 16, vatExact: 1556, totalExact: 11281.49 };
L = buildCustomerLadder({ ...baseArgs, rounding: { step: 10, mode: "nearest" } });
check("ladder rounding 10 nearest: 11281 → 11280, shown as −1", L.total === 11280 && L.roundingAdjustment === -1, `${L.total}/${L.roundingAdjustment}`);
L = buildCustomerLadder({ ...baseArgs, rounding: { step: 10, mode: "up" } });
check("ladder rounding 10 up: 11281 → 11290, shown as +9", L.total === 11290 && L.roundingAdjustment === 9);
L = buildCustomerLadder({ ...baseArgs, rounding: { step: 0, mode: "up" } });
check("no rounding step: nothing added", L.total === 11281 && L.roundingAdjustment === 0);
L = buildCustomerLadder({ ...baseArgs });
check("rounding omitted entirely: same as before", L.total === 11281 && L.roundingAdjustment === 0);
const first = buildCustomerLadder({ ...baseArgs, rounding: { step: 100, mode: "up" } });
const again = buildCustomerLadder({ ...baseArgs, rounding: { step: 100, mode: "up" } });
check("rebuilding from the saved pre-rounding figure gives the identical ladder", JSON.stringify(first) === JSON.stringify(again) && first.total === 11300);
L = buildCustomerLadder({ partAmounts: [1000], subtotalExact: 1000, discountRows: [], vatMode: "all", vatRatePercent: 16, vatExact: 160, totalExact: 5000, rounding: { step: 500, mode: "up" } });
check("minimum-order top-up happens first, then rounding (5000 stays 5000)", L.adjustment === 3840 && L.roundingAdjustment === 0 && L.total === 5000, JSON.stringify([L.adjustment, L.roundingAdjustment, L.total]));

let badRound = 0;
for (let i = 0; i < 1000; i++) {
  const step = [0, 5, 10, 50, 100, 500][Math.floor(rnd() * 6)];
  const mode = rnd() < 0.5 ? "up" : "nearest";
  const sub = rnd() * 20000 + 1;
  const l = buildCustomerLadder({ partAmounts: [sub * 0.3, sub * 0.7], subtotalExact: sub, discountRows: rnd() < 0.5 ? [{ amount: sub * 0.1 }] : [], vatMode: rnd() < 0.5 ? "all" : "print", vatRatePercent: 16, vatExact: sub * 0.12, totalExact: 0, rounding: { step, mode } });
  const ok = l.totalBeforeVat + l.vat + l.adjustment + l.roundingAdjustment === l.total
    && (step <= 1 ? l.roundingAdjustment === 0 : l.total % step === 0)
    && (mode === "up" ? l.roundingAdjustment >= 0 && l.roundingAdjustment < Math.max(step, 1) : Math.abs(l.roundingAdjustment) <= step / 2)
    && Number.isInteger(l.total);
  if (!ok) badRound++;
}
check("1000 random quotes: rounding line always makes the sum work and lands on a multiple of the step", badRound === 0, badRound + " bad");

process.exit(fail ? 1 : 0);
