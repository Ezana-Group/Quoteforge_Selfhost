// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Ovid International Ltd. See LICENSE.
const STORAGE_KEY = "portable3dQuoteConfig";

const STATE = {
  config: null,
  history: [],
  lastPrintRecord: null,
  syncInProgress: false,
};

let selectedMaterialColor = "#000000";
// Components (bought-in, non-printed parts) added to the quote currently
// being built. Persists across recalculations, cleared by the Reset
// button. Snapshotted onto the job at "Calculate & Generate Quote" time.
let currentQuoteComponents = [];
let currentQuoteDiscounts = [];
let liveDiscountPreview = null;
let currentQuoteExcludedFeeIds = new Set();
let selectedEditMaterialColor = "#000000";
// Photo for a printer being created on the "Add Printer" page — held here
// until "Save Printer" is clicked (the printer object doesn't exist yet),
// mirroring the pattern used for logo/photo uploads elsewhere in the app.
let pendingNewPrinterPhotoDataUrl = "";
// Set when someone clicks "Use This" on a network-discovered printer —
// attached to the printer record when it's saved, then cleared.
let pendingDiscoveredPrinterNetwork = null;

// Jobs table sort + filter state. Intentionally kept out of STATE/
// saveState() — it's view state, not data to persist.
const historyTableState = {
  sortKey: "recordedAt",
  sortDir: "desc",
  filterCategory: "",
  filterCustomer: "",
  filterStatus: "",
  dateFrom: "",
  dateTo: "",
};

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
const ICON_TRASH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
const ICON_EYE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;

// Kenyan payment methods supported in Company & Branding → Payment Methods.
// Each type declares its own display label and the specific fields it
// needs (from a small shared set of generic keys — primary/secondary/
// bankName/accountName/extra/customLabel) so one generic card renderer
// and one generic line-formatter can handle every method without a special
// case per type. Add a new payment option by adding an entry here.
const PAYMENT_METHOD_TYPES = {
  bank: {
    label: "Bank Transfer",
    fields: [
      { key: "bankName", label: "Bank Name", placeholder: "e.g. First National Bank" },
      { key: "secondary", label: "Account Number / IBAN", placeholder: "e.g. GB29 NWBK 6016 1331 9268 19" },
      { key: "accountName", label: "Account Name", placeholder: "e.g. Your Company Ltd" },
      { key: "extra", label: "Routing / SWIFT / Sort Code (optional)", placeholder: "e.g. NWBKGB2L" },
    ],
    formatLine: (m) => `Bank: ${[m.bankName, m.secondary ? `Acc No: ${m.secondary}` : "", m.accountName ? `Acc Name: ${m.accountName}` : "", m.extra ? `SWIFT/Sort: ${m.extra}` : ""].filter(Boolean).join(", ")}`,
  },
  paypal: {
    label: "PayPal",
    fields: [
      { key: "primary", label: "PayPal Email / Link", placeholder: "e.g. pay@yourcompany.com" },
    ],
    formatLine: (m) => `PayPal: ${m.primary}`,
  },
  stripe: {
    label: "Stripe / Card Payment Link",
    fields: [
      { key: "primary", label: "Payment Link", placeholder: "e.g. https://buy.stripe.com/..." },
    ],
    formatLine: (m) => `Card payment: ${m.primary}`,
  },
  wise: {
    label: "Wise (TransferWise)",
    fields: [
      { key: "primary", label: "Wise Email / Link", placeholder: "e.g. pay@yourcompany.com" },
      { key: "accountName", label: "Account Name", placeholder: "e.g. Your Company Ltd" },
    ],
    formatLine: (m) => `Wise: ${m.primary}${m.accountName ? ` — ${m.accountName}` : ""}`,
  },
  mobile_money: {
    label: "Mobile Money (M-Pesa, Airtel Money, etc.)",
    // Different mobile money formats need different data — a Paybill needs
    // a business number AND an account number, a Till only needs one
    // number, Send-to-phone just needs the phone number. `fields` is a
    // function here (not a static list) so the visible fields change based
    // on which format the person picks in the "Format" dropdown.
    fields: (m) => {
      const subType = m.subType || "paybill";
      const base = [
        { key: "subType", label: "Format", type: "select", options: [
          { value: "paybill", label: "Paybill (Business No. + Account No.)" },
          { value: "till", label: "Till / Merchant Number" },
          { value: "phone", label: "Phone Number (Send Money)" },
          { value: "other", label: "Other" },
        ] },
        { key: "customLabel", label: "Provider Name", placeholder: "e.g. M-Pesa, Airtel Money, GCash, MTN MoMo" },
      ];
      if (subType === "paybill") {
        base.push(
          { key: "primary", label: "Business / Paybill Number", placeholder: "e.g. 123456" },
          { key: "secondary", label: "Account Number", placeholder: "e.g. Invoice No. or Your Name" },
        );
      } else if (subType === "till") {
        base.push({ key: "primary", label: "Till / Merchant Number", placeholder: "e.g. 987654" });
      } else if (subType === "phone") {
        base.push({ key: "primary", label: "Phone Number", placeholder: "e.g. +1 555 123 4567" });
      } else {
        base.push({ key: "primary", label: "Number / Reference", placeholder: "e.g. phone number or 123456" });
      }
      base.push({ key: "accountName", label: "Registered Name", placeholder: "e.g. Jane Doe or Your Company" });
      return base;
    },
    formatLine: (m) => {
      const provider = m.customLabel || "Mobile Money";
      const subType = m.subType || "paybill";
      if (subType === "paybill") {
        return `${provider} Paybill: ${m.primary}${m.secondary ? `, Acc No: ${m.secondary}` : ""}${m.accountName ? `, Acc Name: ${m.accountName}` : ""}`;
      }
      if (subType === "till") {
        return `${provider} Till: ${m.primary}${m.accountName ? `, Acc Name: ${m.accountName}` : ""}`;
      }
      return `${provider}: ${m.primary}${m.accountName ? ` — ${m.accountName}` : ""}`;
    },
  },
  crypto: {
    label: "Cryptocurrency",
    fields: [
      { key: "customLabel", label: "Coin / Network", placeholder: "e.g. BTC, ETH (ERC-20), USDT (TRC-20)" },
      { key: "primary", label: "Wallet Address", placeholder: "e.g. bc1q..." },
    ],
    formatLine: (m) => `${m.customLabel || "Crypto"}: ${m.primary}`,
  },
  cash: {
    label: "Cash",
    fields: [
      { key: "extra", label: "Note (optional)", placeholder: "e.g. Cash accepted on collection only" },
    ],
    formatLine: (m) => `Cash${m.extra ? `: ${m.extra}` : " accepted"}`,
  },
  other: {
    label: "Other",
    fields: [
      { key: "customLabel", label: "Method Name", placeholder: "e.g. Cheque" },
      { key: "extra", label: "Details", placeholder: "e.g. Payable to..." },
    ],
    formatLine: (m) => `${m.customLabel || "Other"}${m.extra ? `: ${m.extra}` : ""}`,
  },
};

// Currency → suggested payment-method ordering. This never hides or
// blocks any method — every option in PAYMENT_METHOD_TYPES stays fully
// available everywhere, regardless of currency. It only reorders the
// "add payment method" dropdown so the methods most commonly used in a
// given region surface first, since a default list ordered for one
// country isn't a great fit for everyone downloading an open source tool.
const REGION_PAYMENT_SUGGESTIONS = {
  KES: ["mobile_money", "bank", "cash", "paypal", "wise", "stripe", "crypto", "other"],
  NGN: ["mobile_money", "bank", "cash", "paypal", "wise", "stripe", "crypto", "other"],
  GHS: ["mobile_money", "bank", "cash", "paypal", "wise", "stripe", "crypto", "other"],
  UGX: ["mobile_money", "bank", "cash", "paypal", "wise", "stripe", "crypto", "other"],
  TZS: ["mobile_money", "bank", "cash", "paypal", "wise", "stripe", "crypto", "other"],
  ZAR: ["bank", "mobile_money", "paypal", "cash", "wise", "stripe", "crypto", "other"],
  INR: ["bank", "mobile_money", "paypal", "cash", "wise", "stripe", "crypto", "other"],
  PHP: ["mobile_money", "bank", "cash", "paypal", "wise", "stripe", "crypto", "other"],
  USD: ["stripe", "paypal", "bank", "wise", "cash", "mobile_money", "crypto", "other"],
  CAD: ["stripe", "paypal", "bank", "wise", "cash", "mobile_money", "crypto", "other"],
  GBP: ["bank", "stripe", "paypal", "wise", "cash", "mobile_money", "crypto", "other"],
  EUR: ["bank", "stripe", "paypal", "wise", "cash", "mobile_money", "crypto", "other"],
  AUD: ["bank", "stripe", "paypal", "wise", "cash", "mobile_money", "crypto", "other"],
};
const DEFAULT_PAYMENT_ORDER = ["bank", "paypal", "stripe", "wise", "mobile_money", "crypto", "cash", "other"];

function getSuggestedPaymentOrder() {  const code = getCurrencyCode();
  return REGION_PAYMENT_SUGGESTIONS[code] || DEFAULT_PAYMENT_ORDER;
}

// Reorders the "add payment method" dropdown to put region-typical methods
// first and shows a one-line hint — purely a convenience default. Every
// method remains selectable regardless of currency.
function applyPaymentMethodRegionOrdering() {
  const select = document.getElementById("newPaymentMethodType");
  const hint = document.getElementById("paymentMethodRegionHint");
  if (!select) return;
  const order = getSuggestedPaymentOrder();
  const optionsByValue = {};
  Array.from(select.options).forEach((o) => (optionsByValue[o.value] = o));
  const previousValue = select.value;
  order.forEach((key) => {
    if (optionsByValue[key]) select.appendChild(optionsByValue[key]);
  });
  // Any option not covered by the suggestion list (shouldn't normally
  // happen) stays wherever it already is.
  if (optionsByValue[previousValue]) select.value = previousValue;
  if (hint) {
    const topLabels = order
      .slice(0, 3)
      .map((k) => (PAYMENT_METHOD_TYPES[k] ? PAYMENT_METHOD_TYPES[k].label : null))
      .filter(Boolean);
    hint.textContent = topLabels.length
      ? `Suggested for ${getCurrencyCode()}: ${topLabels.join(", ")} — but every option above is always available.`
      : "";
  }
}

function newPaymentMethod(type) {
  return {
    id: `pm-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    type: PAYMENT_METHOD_TYPES[type] ? type : "bank",
    enabled: true,
    primary: "",
    secondary: "",
    bankName: "",
    accountName: "",
    extra: "",
    customLabel: "",
    subType: "paybill",
  };
}

// Converts a config saved before paymentMethods existed into the new
// structure, once. Runs only when paymentMethods is missing/empty AND at
// least one legacy field has a value — otherwise leaves a genuinely empty
// list alone (so removing all methods and saving doesn't get "undone" by
// migration on next load).
function migrateLegacyPaymentMethods(company) {
  if (!company) return;
  if (!Array.isArray(company.paymentMethods)) company.paymentMethods = [];
  if (company.paymentMethods.length > 0) return;
  if (company._legacyPaymentMigrated) return;

  const migrated = [];
  if (company.mpesaNumber) {
    const m = newPaymentMethod("mobile_money");
    m.customLabel = company.mpesaType === "Till" ? "M-Pesa Till" : "M-Pesa Paybill";
    m.primary = company.mpesaNumber;
    m.accountName = company.mpesaAccountName || "";
    migrated.push(m);
  }
  if (company.bankName || company.bankAccountNumber) {
    const m = newPaymentMethod("bank");
    m.bankName = company.bankName || "";
    m.secondary = company.bankAccountNumber || "";
    m.accountName = company.bankAccountName || "";
    migrated.push(m);
  }

  if (migrated.length > 0) company.paymentMethods = migrated;
  company._legacyPaymentMigrated = true;
}

function getColorName(hex) {
  if (!hex) return "Unknown";
  if (STATE.config && Array.isArray(STATE.config.colors)) {
    const c = STATE.config.colors.find(c => c.hex.toLowerCase() === hex.toLowerCase());
    if (c) return c.name;
  }
  return "Custom Color";
}

// Cheap, stable fingerprint used to tell whether an image has already been
// uploaded to Drive — avoids storing the whole base64 string as a dedupe
// key. Not cryptographic, just needs to not collide for a handful of
// photos per job.
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36) + "_" + str.length;
}

// Marks a job as changed so the sync layer knows to re-send it (Google
// Sheet writes are otherwise skipped once a job has already been synced,
// to avoid duplicate/redundant network calls on every auto-sync pass).
function touchJob(job) {
  if (!job) return;
  job.modifiedAt = new Date().toISOString();
}

const DEFAULT_CONFIG = {
  // Set to true once the first-run setup wizard has been completed. Until
  // then, the app shows the setup screen instead of the main UI.
  setupComplete: false,
  // Currency is fully user-defined at setup time — any ISO 4217 code
  // ("USD", "EUR", "KES", "INR"...) works via Intl.NumberFormat in
  // formatKes(). currencyLocale is optional (e.g. "en-US", "de-DE") and
  // only affects number grouping/decimal style; left blank it uses the
  // browser's default locale.
  currencyCode: "",
  currencyLocale: "",
  nextJobNumber: 1,
  nextInvoiceNumber: 1,
  // Net payment terms for invoices — "due within N days of the invoice
  // date". 0 means "due on receipt".
  invoiceDueDays: 7,
  googleSheetsWebhookUrl: "",
  googleSheetsAutoSync: false,
  driveAutoUpload: false,
  serviceMinimumOrderKes: 0,
  vatRatePercent: 0,
  // "print" = VAT only on the print price (original behaviour);
  // "all" = VAT on the whole quote after discounts.
  vatAppliesTo: "print",
  // What the tax is called on quotes, invoices and reports: "VAT", "GST", "Sales Tax", "IVA", "MwSt"...
  taxLabel: "VAT",
  // Warn when a quote's margin (on the ex-VAT price) is below this. 0 = off.
  targetMarginPercent: 0,
  // Round the final quote total to a multiple of this (0 = no rounding).
  roundingStep: 0,
  roundingMode: "nearest", // or "up"
  profitMarginPercent: 40,
  minChargeGrams: 10,
  // Fallback density (g/cm3) used only to turn a mesh's computed volume
  // into an estimated weight when importing a multi-part file, before
  // the user has picked a real material per part. 1.24 is a typical
  // PLA density — a reasonable "close enough to start editing" number,
  // not a substitute for picking the actual material.
  defaultMaterialDensity: 1.24,
  defaultMachineRate: 0,
  postProcessingFeePerUnit: 0,
  // Extra buffers applied to material cost inside calculatePrintCost, both
  // off (0%) by default so existing saved configs price exactly as before
  // until someone opts in:
  //  - materialWasteBufferPercent: purge towers, brims/rafts, and the
  //    unusable tail-end of a spool — loss that isn't a full failed print.
  //  - materialFxBufferPercent: cushion for KES depreciation between when
  //    costPerKgKes was set and when the material is actually restocked,
  //    for filament priced against an imported/USD cost upstream.
  materialWasteBufferPercent: 0,
  materialFxBufferPercent: 0,
  // Quantity-based discount tiers, applied to the per-unit selling price
  // before VAT. Each entry: { id, minQty, discountPercent }. Empty by
  // default (no discount behaviour change) until tiers are added in
  // Settings → Financials & Metrics.
  // Reusable, bought-in (non-printed) components — sockets, cords, LEDs,
  // threaded inserts, magnets, etc. Tagged by product category so a quote
  // for e.g. "Lamp" only offers components relevant to lamps. Empty by
  // default; manage these in Settings → Components.
  components: [],
  bulkDiscountTiers: [],
  // Arbitrary extra fee/charge line items configurable in
  // Settings → Financials & Metrics (e.g. Rush Fee, Design Time,
  // Packaging). Each folds into the quote total when enabled.
  extraFeeLineItems: [],
  // Company info & branding shown in the app header and on printed/PDF
  // quotes. logoDataUrl is a base64 data: URL (small image), stored
  // locally like everything else in config.
  companyInfo: {
    name: "",
    tagline: "",
    address: "",
    phone: "",
    email: "",
    website: "",
    logoDataUrl: "",
    // Structured, multi-method payment list — shown on the PDF quote and
    // WhatsApp message. Each entry is { id, type, enabled, ...typeFields }.
    // See PAYMENT_METHOD_TYPES below for what fields each type uses and
    // buildPaymentLines() for how they're formatted into quote text.
    // "enabled" controls whether a given method is currently included on
    // quotes/WhatsApp — lets you keep e.g. an old bank account on file
    // without sending it out.
    paymentMethods: [],
    // Legacy single M-Pesa/Bank fields + freeform notes, kept only for
    // backward compatibility with configs saved before paymentMethods
    // existed. migrateLegacyPaymentMethods() converts these into proper
    // paymentMethods entries once, the first time an old config loads.
    mpesaType: "Paybill",
    mpesaNumber: "",
    mpesaAccountName: "",
    bankName: "",
    bankAccountNumber: "",
    bankAccountName: "",
    paymentNotes: "",
    paymentDetails: "",
    termsText: "",
    quoteValidityDays: 7,
    depositPercent: 0,
    taxId: "",
  },
  colors: [
    { hex: "#000000", name: "Black" },
    { hex: "#FFFFFF", name: "White" },
    { hex: "#9CA3AF", name: "Gray" },
    { hex: "#EF4444", name: "Red" },
    { hex: "#3B82F6", name: "Blue" },
    { hex: "#10B981", name: "Green" },
    { hex: "#EAB308", name: "Yellow" },
    { hex: "#F97316", name: "Orange" },
    { hex: "#8B5CF6", name: "Purple" },
    { hex: "#EC4899", name: "Pink" },
    { hex: "#8B4513", name: "Brown" },
    { hex: "#D1D5DB", name: "Silver/Clear" },
    { hex: "#FBBF24", name: "Gold" },
    { hex: "#B45309", name: "Bronze" }
  ],
  // Mirrors the "Lists" tab of your Google Sheets Product Catalogue
  // (Category | SKU Abbreviation), so a quote's category lines up with the
  // Products tab's dropdown + auto-SKU logic when it's sent over.
  // Categories are a 3-level tree (category -> subcategory -> sub-
  // subcategory). Each node has {id, name, skuAbbr, subcategories}.
  // Old flat configs (no id/subcategories) auto-migrate on load via
  // normalizeCategoryTree().
  // Empty by default — add product categories in Settings → Categories.
  // (Previously shipped with a preloaded example catalogue; removed so the
  // app starts with a clean slate for every new user.)
  categories: [],
  materialProfiles: [
    { type: "PLA", technology: "FDM", density: 1.24, printTemp: 210, bedTemp: 60, notes: "Cooling 100%" },
    { type: "PETG", technology: "FDM", density: 1.27, printTemp: 235, bedTemp: 70, notes: "Cooling 30-50%" },
    { type: "ABS", technology: "FDM", density: 1.05, printTemp: 240, bedTemp: 100, notes: "Enclosure required" },
    { type: "TPU", technology: "FDM", density: 1.21, printTemp: 230, bedTemp: 60, notes: "Direct drive recommended" },
    { type: "RESIN", technology: "Resin", density: 1.1, printTemp: null, bedTemp: null, notes: "Wear gloves" }
  ],
  // Flat list — separate on purpose from product `categories` above.
  // Product categories classify what you're SELLING (Lamp, Vase...);
  // these classify bought-in, non-printed parts (Components tab) by what
  // they physically ARE, which rarely lines up with product categories —
  // a socket isn't "a Lamp". Managed in Settings → Components.
  componentCategories: ["Electrical", "Hardware & Fasteners", "Inserts & Magnets", "Packaging", "Other"],
  // Category Component Kits — maps a product Category id (from `categories`
  // above) to a default set of component ids from `components`. Applied as
  // a one-time suggestion on the Quote tab (still editable per quote) —
  // never silently forces components onto a job.
  categoryComponentKits: {},
  // Same idea as componentCategories, but for the Printer Accessories &
  // Parts tab (nozzles, AMS units, bed sheets...). Kept as its own list
  // since it's a different set of things than bought-in product parts.
  accessoryCategories: ["Nozzle", "Hotend / Extruder", "AMS / Multi-Material Unit", "Bed Sheet / Plate", "Tool", "Electronics", "Maintenance Supply", "Other"],
  // Empty by default — add filament/resin stock in Settings → Materials.
  materials: [],
  // Empty by default — add your printers in Settings → Printers.
  printers: [],
  // Bought-in printer accessories & spare parts (nozzles, AMS units, bed
  // sheets, tools...) — separate from `printers` (the machines themselves)
  // and from `components` (parts that go INTO a printed product).
  printerAccessories: [],
  // Customers — companies + a contact person at each. Kept separate from
  // quotes/jobs (a customer can have many quotes over time); a quote just
  // stores a reference (customerId) plus a small snapshot of the name/
  // contact at the time it was sent, so history still reads correctly
  // even if a customer's details are edited or deleted later.
  customers: [],
  printerSettings: {
    electricityRateKesKwh: 0,
    laborRateKesPerHour: 0,
    postProcessingTimeHours: 0.5,
    monthlyRentKes: 0,
    monthlyUtilitiesKes: 0,
    monthlyInsuranceKes: 0,
    // User-added extra fixed overhead lines (e.g. "Software Subscriptions",
    // "Loan Repayment") — each {id, label, amountKes}, summed alongside
    // Rent/Utilities/Insurance above. Managed in Settings → Financials.
    customOverheads: [],
    workingDaysPerMonth: 26,
    workingHoursPerDay: 8,
    failedPrintRatePercent: 5,
    packagingCostKes: 0,
    profitMarginPercent: 40,
    vatRatePercent: 0,
    postProcessingFeePerUnit: 0,
    // Share of total available machine hours actually expected to be
    // spent printing paid jobs, in a typical month. Fixed overhead (rent/
    // utilities/insurance) is recovered against this, not against 100% of
    // calendar capacity — so if the printer sits idle a lot, overhead is
    // spread over fewer billable hours and correctly costs more per job.
    // Defaults to 100 (unchanged prior behaviour) until set lower.
    plannedUtilizationPercent: 100,
    // User-added reference facility metrics (e.g. "Floor space", "Backup
    // generator capacity") — each {id, label, value, unit}. Unlike the
    // fixed metrics above, these aren't wired into any pricing formula
    // (there's no generic slot for an arbitrary metric to plug into) —
    // they're for tracking/reference only, same spirit as a notes field.
    customFacilityMetrics: [],
    // Same idea as customFacilityMetrics but for the Pricing & Margins
    // tab — reference-only custom fields, not wired into the pricing
    // formula (no generic slot for an arbitrary field to plug into).
    customPricingMetrics: [],
  },
};

// Trims trailing zeros but keeps up to 2 decimals, so 0.10 -> "0.1" and
// 10 -> "10" without ever mid-cutting a number the way a narrow numeric
// spinner input can.
function formatStockKg(kg) {
  return (Math.round((Number(kg) || 0) * 100) / 100).toString();
}

// Currency is fully configurable (Settings → set up on first run). Every
// money display in the app routes through here or through getCurrencyCode()
// so nothing is hardcoded to one country's currency.
function getCurrencyCode() {
  return (STATE.config && STATE.config.currencyCode) || "USD";
}
function taxLabel() {
  const l = STATE && STATE.config && typeof STATE.config.taxLabel === "string" ? STATE.config.taxLabel.trim().slice(0, 24) : "";
  return l || "VAT";
}

function getCurrencyLocale() {
  return (STATE.config && STATE.config.currencyLocale) || undefined;
}
function formatKes(amount) {
  const code = getCurrencyCode();
  const rounded = Math.round(Number(amount) || 0);
  try {
    // Use Intl's currency formatter when the code is a real ISO 4217 code —
    // gives correct symbol placement/spacing per locale automatically.
    return new Intl.NumberFormat(getCurrencyLocale(), {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(rounded);
  } catch (e) {
    // Falls back to a plain "CODE amount" if the code isn't a valid ISO
    // currency (e.g. a custom/unofficial one someone typed in setup).
    return `${code} ${rounded.toLocaleString(getCurrencyLocale())}`;
  }
}
// Replaces any {{CUR}} placeholders left in static HTML (index.html labels)
// with the configured currency code, without touching element structure or
// attached listeners — only walks text nodes.
//
// This must be safe to call every time the currency changes, not just
// once — a naive "find {{CUR}} and replace it" only works the FIRST call,
// because after that the token text is gone (overwritten with the old
// currency code) and there's nothing left to find. currencyLabelTemplates
// remembers each node's original template (with the token intact) the
// first time it's seen, so every later call can regenerate the text from
// that template with whatever the currency is now — not just freeze it
// at whatever currency was active on first load.
const currencyLabelTemplates = new Map();
function applyCurrencyLabels(root) {
  const code = getCurrencyCode();
  const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (currencyLabelTemplates.has(n) || n.nodeValue.indexOf("{{CUR}}") !== -1) {
      nodes.push(n);
    }
  }
  nodes.forEach((node) => {
    if (!currencyLabelTemplates.has(node)) {
      currencyLabelTemplates.set(node, node.nodeValue);
    }
    const template = currencyLabelTemplates.get(node);
    node.nodeValue = template.split("{{CUR}}").join(code);
  });
}

function applyMinOrder(total) {
  return Math.max(total, STATE.config.serviceMinimumOrderKes);
}

async function loadStoredState() {
  // Primary store: a file on disk, served via the local server (see
  // server.js). This is stable across ports and even across moving the
  // app to a new folder on a future update — unlike localStorage, which
  // is scoped per-port and gets "lost" if the server happens to start on
  // a different port than last time.
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (res.ok) {
      const serverState = await res.json();
      const hasServerData = serverState && (
        (serverState.config && Object.keys(serverState.config).length) ||
        (Array.isArray(serverState.history) && serverState.history.length)
      );
      if (hasServerData) return serverState;

      // Server file is empty — if this exact browser/port still has data
      // in localStorage from before this update, migrate it up once so
      // it isn't lost, then keep using the server file from now on.
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy) {
        try {
          const parsedLegacy = JSON.parse(legacy);
          await fetch("/api/data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsedLegacy),
          });
          return parsedLegacy;
        } catch (e) {
          console.warn("Failed to migrate legacy browser data", e);
        }
      }
      return serverState;
    }
  } catch (error) {
    console.warn("Could not reach the local server for saved data — falling back to browser storage.", error);
  }

  // Fallback only (e.g. server unreachable for some reason): old behavior.
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch (error) {
    console.warn("Failed to parse stored config", error);
    return null;
  }
}

function saveState() {
  if (!STATE.config) return;
  const payload = JSON.stringify({ config: STATE.config, history: STATE.history });
  // Quick local mirror/fallback.
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (e) {
    // ignore — not critical, the server file below is the real store
  }
  // Primary store — write-through to the on-disk data file.
  fetch("/api/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  }).catch((err) => console.warn("Could not save to local data file", err));
}

function mergeStoredConfig(baseConfig, storedConfig) {
  if (!storedConfig) return baseConfig;

  const merged = {
    ...baseConfig,
    ...storedConfig,
    printerSettings: {
      ...baseConfig.printerSettings,
      ...(storedConfig.printerSettings || {}),
    },
  };

  if (Array.isArray(storedConfig.colors)) {
    merged.colors = storedConfig.colors;
  } else if (Array.isArray(storedConfig.customColors)) {
    merged.colors = [...DEFAULT_CONFIG.colors];
    storedConfig.customColors.forEach(cc => {
      if (!merged.colors.some(c => c.hex.toLowerCase() === cc.hex.toLowerCase())) {
        merged.colors.push(cc);
      }
    });
  } else {
    merged.colors = [...DEFAULT_CONFIG.colors];
  }
  delete merged.customColors;

  if (Array.isArray(storedConfig.categories)) {
    merged.categories = normalizeCategoryTree(storedConfig.categories);
  } else {
    merged.categories = normalizeCategoryTree(DEFAULT_CONFIG.categories);
  }

  if (Array.isArray(storedConfig.materialProfiles)) {
    merged.materialProfiles = storedConfig.materialProfiles;
  } else {
    merged.materialProfiles = [...DEFAULT_CONFIG.materialProfiles];
  }
  // Backfill `technology` on profiles saved before this field existed —
  // RESIN-type profiles become "Resin", everything else defaults "FDM".
  // This is what gates the Material dropdown by the selected printer.
  merged.materialProfiles = merged.materialProfiles.map(p => ({
    ...p,
    technology: p.technology || (String(p.type).toUpperCase() === "RESIN" ? "Resin" : "FDM"),
  }));

  merged.componentCategories = Array.isArray(storedConfig.componentCategories) && storedConfig.componentCategories.length
    ? storedConfig.componentCategories
    : [...DEFAULT_CONFIG.componentCategories];

  merged.accessoryCategories = Array.isArray(storedConfig.accessoryCategories) && storedConfig.accessoryCategories.length
    ? storedConfig.accessoryCategories
    : [...DEFAULT_CONFIG.accessoryCategories];

  merged.categoryComponentKits = (storedConfig.categoryComponentKits && typeof storedConfig.categoryComponentKits === "object")
    ? storedConfig.categoryComponentKits
    : {};

  if (Array.isArray(storedConfig.extraFeeLineItems)) {
    merged.extraFeeLineItems = storedConfig.extraFeeLineItems.map(item => ({
      id: item.id || `fee-${Math.random().toString(36).slice(2, 9)}`,
      label: item.label || "",
      value: Number(item.value) || 0,
      valueType: item.valueType === "percentage" ? "percentage" : "flat",
      enabled: item.enabled !== false,
    }));
  } else {
    merged.extraFeeLineItems = [];
  }

  merged.companyInfo = {
    ...DEFAULT_CONFIG.companyInfo,
    ...(storedConfig.companyInfo && typeof storedConfig.companyInfo === "object" ? storedConfig.companyInfo : {}),
  };

  if (Array.isArray(storedConfig.materials)) {
    merged.materials = storedConfig.materials.map(m => {
      if (!m.type) {
        if (m.code.includes("PETG") || m.name.includes("PETG")) m.type = "PETG";
        else if (m.code.includes("ABS") || m.name.includes("ABS")) m.type = "ABS";
        else if (m.code.includes("RESIN") || m.name.includes("Resin")) m.type = "RESIN";
        else m.type = "PLA";
      }
      if (!m.colorHex) m.colorHex = "#9CA3AF";
      if (m.brand === undefined) m.brand = "";
      return m;
    });
  }

  if (Array.isArray(storedConfig.printers)) {
    // Backfill fields added after a printer was first saved — existing
    // machines default to FDM/Active/256mm cube so nothing silently
    // disappears from the Printer selector or gets miscategorised as Resin.
    merged.printers = storedConfig.printers.map(p => ({
      ...p,
      maxColors: p.maxColors || 1,
      technology: p.technology || "FDM",
      status: p.status || "Active",
      buildVolumeX: p.buildVolumeX || 256,
      buildVolumeY: p.buildVolumeY || 256,
      buildVolumeZ: p.buildVolumeZ || 256,
      purchaseDate: p.purchaseDate || "",
      loggedHours: p.loggedHours || 0,
      // Backfill fields added in this update — existing printers from an
      // older backup simply show these as blank rather than "undefined".
      manufacturer: p.manufacturer || "",
      serialNumber: p.serialNumber || "",
      location: p.location || "",
      photoDataUrl: p.photoDataUrl || "",
    }));
  } else if (storedConfig.printerSettings) {
    merged.printers = [
      {
        id: "PRT-001",
        name: storedConfig.printerSettings.printerModel || "FDM Standard",
        technology: "FDM",
        powerWatts: storedConfig.printerSettings.powerWatts || 270,
        printerPurchasePriceKes: storedConfig.printerSettings.printerPurchasePriceKes || 85000,
        lifespanHours: storedConfig.printerSettings.lifespanHours || 10000,
        maintenancePerYearKes: storedConfig.printerSettings.maintenancePerYearKes || 6000,
        failedPrintRatePercent: storedConfig.printerSettings.failedPrintRatePercent || 5,
        maxColors: 1,
        buildVolumeX: 256,
        buildVolumeY: 256,
        buildVolumeZ: 256,
        status: "Active",
        purchaseDate: "",
        loggedHours: 0
      }
    ];
  }

  return merged;
}

function formatJobDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString(getCurrencyLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Stamps the moment a job first reaches production (Printing / Invoiced /
// Completed) so reports can say "printed in October"; clears it if the job is
// moved back to a not-printed stage.
function syncPrintedDate(job) {
  if (!job || !window.QuoteForgeReports) return;
  if (window.QuoteForgeReports.isPrinted(job)) {
    if (!job.printedAt) job.printedAt = new Date().toISOString();
  } else if (job.printedAt) {
    delete job.printedAt;
  }
}

// The stats at the top of the Jobs tab. They follow the filters below them
// (category, customer, status, dates) so you can ask "what did we print for
// Storytime this month?". Click a stage to filter the table to it.
function renderHistorySummary() {
  const panel = document.getElementById("jobStatsPanel");
  const R = window.QuoteForgeReports;
  if (!panel || !R) return;

  const rows = getFilteredSortedHistory();
  const targetPct = Number(STATE.config.targetMarginPercent) || 0;
  const S = R.summarize(rows.map((r) => r.job), { targetMarginPct: targetPct });
  const filtered = rows.length !== STATE.history.length;
  const grams = (g) => `${Math.round(g).toLocaleString("en-US")} g`;
  const hours = (h) => `${(Math.round(h * 10) / 10).toLocaleString("en-US")} h`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const dash = "—";

  const tile = (label, value, sub, extraClass = "", attrs = "") =>
    `<div class="stat-tile ${extraClass}" ${attrs}><span class="stat-tile-label">${label}</span><strong class="stat-tile-value">${value}</strong>${sub ? `<span class="stat-tile-sub">${sub}</span>` : ""}</div>`;
  const stageTile = (stage) => {
    const st = S.stages[stage.key];
    const group = R.PRINTED_STAGES.includes(stage.key) ? "stat-tile-printed" : "stat-tile-quote";
    const active = historyTableState.filterStatus === stage.key ? "active" : "";
    return `<button type="button" class="stat-tile stat-tile-btn ${group} ${active}" data-stage="${stage.key}" title="${escapeHtml(stage.help)} — click to filter the list">
      <span class="stat-tile-label">${stage.label}</span><strong class="stat-tile-value">${st.count}</strong>
      <span class="stat-tile-sub">${formatKes(st.total)}</span></button>`;
  };

  const stages = R.STAGES;
  panel.innerHTML = `
    <div class="stats-section-title">Pipeline${filtered ? ` · showing ${rows.length} of ${STATE.history.length} jobs (filters applied)` : ` · ${plural(S.count, "job")}`}</div>
    <div class="stats-grid">${stages.map(stageTile).join("")}</div>
    <p class="stats-legend"><strong>Printed</strong> = Printing, Invoiced or Completed (orange edge). Calculated and Quote sent are quotes that haven't been printed (grey edge). Values include ${taxLabel()}.</p>

    <div class="stats-section-title">Money</div>
    <div class="stats-grid">
      ${tile("Open quotes", formatKes(S.notPrinted.total), `${plural(S.notPrinted.count, "job")} not printed yet`)}
      ${tile("Printed value", formatKes(S.printed.total), `${plural(S.printed.count, "job")} · ${formatKes(S.printed.revenueExVat)} ex ${taxLabel()}`)}
      ${tile("Received", formatKes(S.received), "payments recorded", S.received > 0 ? "stat-good" : "")}
      ${tile("Outstanding", formatKes(S.outstanding), S.outstandingJobs > 0 ? `${plural(S.outstandingJobs, "invoiced job")} owing` : "nothing owing", S.outstanding > 0 ? "stat-warn" : "")}
      ${tile("Profit (printed)", S.profitJobs > 0 ? formatKes(S.profit) : dash, S.profitJobs > 0 ? `${S.marginPct.toFixed(1)}% margin · ${plural(S.profitJobs, "job")}` : "no printed jobs with costs yet", S.profitJobs > 0 && S.profit < 0 ? "stat-warn" : "")}
      ${tile("Average printed job", S.avgPrintedValue != null ? formatKes(S.avgPrintedValue) : dash, "incl " + taxLabel())}
      ${targetPct > 0 ? tile("Below target margin", String(S.belowTarget), `of ${plural(S.marginJobs, "printed job")} · target ${targetPct}%`, S.belowTarget > 0 ? "stat-warn" : "stat-good") : ""}
    </div>

    <div class="stats-section-title">Production</div>
    <div class="stats-grid">
      ${tile("Material printed", grams(S.printed.grams), "Printing, Invoiced, Completed")}
      ${tile("In open quotes", grams(S.notPrinted.grams), "not printed yet")}
      ${tile("Print time (printed)", hours(S.printed.hours), "all sets")}
      ${tile("Quote → print rate", S.winRatePct != null ? `${S.winRatePct.toFixed(0)}%` : dash, S.sentQuotes > 0 ? `${S.wonQuotes} of ${S.sentQuotes} quotes were printed` : "no quotes sent yet")}
    </div>
  `;

  panel.querySelectorAll("[data-stage]").forEach((btn) => {
    btn.addEventListener("click", () => {
      historyTableState.filterStatus = historyTableState.filterStatus === btn.dataset.stage ? "" : btn.dataset.stage;
      renderPrintHistory();
    });
  });
}

function getFilteredSortedHistory() {
  const s = historyTableState;
  let rows = STATE.history.map((job, originalIndex) => ({ job, originalIndex }));

  if (s.filterCategory) {
    rows = rows.filter(r => (r.job.category || "") === s.filterCategory);
  }
  if (s.filterCustomer) {
    rows = rows.filter(r => (r.job.details?.customerCompany || "") === s.filterCustomer);
  }
  if (s.filterStatus) {
    rows = rows.filter(r => (r.job.status || "draft") === s.filterStatus);
  }
  if (s.dateFrom) {
    const from = new Date(s.dateFrom).getTime();
    rows = rows.filter(r => r.job.recordedAt && new Date(r.job.recordedAt).getTime() >= from);
  }
  if (s.dateTo) {
    const to = new Date(s.dateTo).getTime() + (24 * 60 * 60 * 1000 - 1);
    rows = rows.filter(r => r.job.recordedAt && new Date(r.job.recordedAt).getTime() <= to);
  }

  const dir = s.sortDir === "asc" ? 1 : -1;
  const getSortValue = (job) => {
    switch (s.sortKey) {
      case "name": return (job.name || "").toLowerCase();
      case "category": return (job.category || "").toLowerCase();
      case "customer": return (job.details?.customerCompany || "").toLowerCase();
      case "quantity": return Number(job.quantity) || 0;
      case "totalWeight": return job.parts ? job.parts.reduce((sum, p) => sum + (p.weightGrams || 0), 0) : (job.weightGrams || 0);
      case "totalAmount": return Number(job.totalAmount) || 0;
      case "status": return (job.status || "draft").toLowerCase();
      case "recordedAt":
      default: return job.recordedAt ? new Date(job.recordedAt).getTime() : 0;
    }
  };

  rows.sort((a, b) => {
    const va = getSortValue(a.job);
    const vb = getSortValue(b.job);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  return rows;
}

function buildHistorySortableTh(key, label, extraStyle = "") {
  const s = historyTableState;
  if (!key) return `<th style="${extraStyle}">${label}</th>`;
  const isActive = s.sortKey === key;
  const arrow = isActive ? (s.sortDir === "asc" ? " \u25b2" : " \u25bc") : "";
  return `<th class="sortable-th" data-sort-key="${key}" title="Click to sort" style="${extraStyle} cursor:pointer; user-select:none;">${label}${arrow}</th>`;
}

// Filter bar shown above the jobs table: category / customer / status /
// date-range dropdowns, built from whatever's actually in history (plus
// the full configured category list), so options never go stale.
function buildHistoryFilterBar() {
  const s = historyTableState;
  const categories = (STATE.config.categories || []).map(c => c.name);
  const customers = Array.from(new Set(STATE.history.map(j => j.details?.customerCompany).filter(Boolean))).sort();
  const statuses = [
    { value: "draft", label: "Draft" },
    { value: "quote_sent", label: "Quote Sent" },
    { value: "printing", label: "Printing" },
    { value: "completed", label: "Completed" },
  ];

  return `
    <div class="history-filter-bar" style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; margin-bottom:12px;">
      <label style="font-size:0.78rem; color:var(--text-secondary);">Category
        <select id="historyFilterCategory" style="display:block; padding:5px 6px; margin-top:2px;">
          <option value="">All</option>
          ${categories.map(c => `<option value="${c}" ${s.filterCategory === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </label>
      <label style="font-size:0.78rem; color:var(--text-secondary);">Customer
        <select id="historyFilterCustomer" style="display:block; padding:5px 6px; margin-top:2px;">
          <option value="">All</option>
          ${customers.map(c => `<option value="${c}" ${s.filterCustomer === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </label>
      <label style="font-size:0.78rem; color:var(--text-secondary);">Status
        <select id="historyFilterStatus" style="display:block; padding:5px 6px; margin-top:2px;">
          <option value="">All</option>
          ${statuses.map(st => `<option value="${st.value}" ${s.filterStatus === st.value ? "selected" : ""}>${st.label}</option>`).join("")}
        </select>
      </label>
      <label style="font-size:0.78rem; color:var(--text-secondary);">From
        <input type="date" id="historyFilterDateFrom" value="${s.dateFrom || ""}" style="display:block; padding:5px 6px; margin-top:2px;" />
      </label>
      <label style="font-size:0.78rem; color:var(--text-secondary);">To
        <input type="date" id="historyFilterDateTo" value="${s.dateTo || ""}" style="display:block; padding:5px 6px; margin-top:2px;" />
      </label>
      <button type="button" id="historyFilterClearBtn" class="secondary" style="padding:6px 12px; font-size:0.8rem;">Clear filters</button>
    </div>
  `;
}

function renderPrintHistory() {
  const historyArea = document.getElementById("historyArea");
  if (!historyArea) return;

  if (!STATE.history.length) {
    historyArea.innerHTML = `<p class="help-text">No printed jobs yet. Print a quote to start tracking history.</p>`;
    renderHistorySummary();
    return;
  }

  const rows = getFilteredSortedHistory();

  historyArea.innerHTML = `
    ${buildHistoryFilterBar()}
    <div class="history-table-wrap">
      <table>
        <thead>
          <tr>
            ${buildHistorySortableTh("recordedAt", "Date")}
            ${buildHistorySortableTh("name", "Project Name")}
            ${buildHistorySortableTh("category", "Category", "width: 130px;")}
            ${buildHistorySortableTh("customer", "Customer")}
            <th>Images</th>
            <th>Materials</th>
            ${buildHistorySortableTh("quantity", "Qty")}
            ${buildHistorySortableTh("totalWeight", "Total Wght")}
            ${buildHistorySortableTh("totalAmount", "Total Val")}
            ${buildHistorySortableTh("status", "Status")}
            <th style="width: 150px;">Sync</th>
            <th style="text-align: right; width: 90px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? `<tr><td colspan="12" class="help-text" style="text-align:center; padding:16px;">No jobs match the current filters.</td></tr>`
            : rows
            .map(
              ({ job, originalIndex }) => {
                const index = originalIndex;
                const isCompleted = String(job.status || "").trim().toLowerCase() === "completed";
                const totalWeight = job.parts ? job.parts.reduce((s, p) => s + p.weightGrams, 0) : job.weightGrams;
                
                let materialText = "Unknown";
                if (job.parts) {
                  materialText = job.parts.map(p => {
                    const mat = STATE.config.materials.find(m => m.code === p.materialCode);
                    const matName = mat ? mat.name : "Unknown";
                    const colorName = p.colorHex ? getColorName(p.colorHex) : "Unknown";
                    const pName = p.name ? `${escapeHtml(p.name)} (${escapeHtml(matName)})` : escapeHtml(matName);
                    const hex = p.colorHex || (mat ? mat.colorHex : "#9CA3AF");
                    return `
                      <span class="part-badge" style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; background: var(--surface-hover); border: 1px solid var(--border); border-radius: 6px; font-size: 0.8rem; font-weight: 500; color: var(--text-primary); margin: 2px;" title="${colorName}">
                        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${hex}; border: 1px solid var(--border);"></span>
                        ${pName}
                      </span>
                    `;
                  }).join("");
                } else {
                  materialText = `<span class="part-badge" style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; background: var(--surface-hover); border: 1px solid var(--border); border-radius: 6px; font-size: 0.8rem; font-weight: 500; color: var(--text-primary); margin: 2px;">
                    <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #9CA3AF; border: 1px solid var(--border);"></span>
                    ${escapeHtml(job.materialName)}
                  </span>`;
                }

                let imagesHtml = '<span style="color: var(--text-secondary); font-size: 0.8rem; font-style: italic;">None</span>';
                if (job.images && job.images.length > 0) {
                  imagesHtml = `
                    <div style="display: flex; gap: 4px; align-items: center;">
                      ${job.images.slice(0, 3).map(src => `<img src="${src}" style="width: 32px; height: 32px; border-radius: 4px; object-fit: cover; border: 1px solid var(--border);" />`).join("")}
                      ${job.images.length > 3 ? `<span style="font-size: 0.75rem; color: var(--text-secondary); font-weight: 600; margin-left: 2px;">+${job.images.length - 3}</span>` : ""}
                    </div>
                  `;
                }

                return `
                <tr>
                  <td>${formatJobDate(job.recordedAt)}</td>
                  <td><strong>${escapeHtml(job.name) || "Part"}</strong></td>
                  <td>
                    <select class="job-category-select" data-index="${index}" style="padding: 2px 4px; font-size: 0.82rem; width: 120px;">
                      ${(STATE.config.categories || []).map(c => `<option value="${escapeHtml(c.name)}" ${job.category === c.name ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
                      <option value="" ${!job.category ? "selected" : ""}>—</option>
                    </select>
                  </td>
                  <td>${escapeHtml(job.details?.customerCompany) || "—"}</td>
                  <td>${imagesHtml}</td>
                  <td>${materialText}</td>
                  <td>${job.quantity}</td>
                  <td>${Math.round(totalWeight)} g</td>
                  <td>${formatKes(job.totalAmount)}${buildPaymentBadgeHtml(job)}</td>
                  <td>
                    <select class="job-status-select" data-index="${index}" style="padding: 2px 4px; font-size: 0.85rem; width: 110px;" ${isCompleted ? 'disabled' : ''}>
                      <option value="draft" ${job.status === 'draft' ? 'selected' : ''}>Draft</option>
                      <option value="quote_sent" ${job.status === 'quote_sent' ? 'selected' : ''}>Quote Sent</option>
                      <option value="printing" ${job.status === 'printing' ? 'selected' : ''}>Printing</option>
                      <option value="invoiced" ${job.status === 'invoiced' ? 'selected' : ''}>Invoiced</option>
                      <option value="completed" ${job.status === 'completed' ? 'selected' : ''}>Completed</option>
                    </select>
                  </td>
                  <td>
                    ${buildJobSyncStatusHtml(job, index)}
                  </td>
                  <td style="text-align: right;">
                    <button type="button" class="icon-btn view-job" data-index="${index}" title="View Details">${ICON_EYE}</button>
                    <button type="button" class="icon-btn danger delete-job" data-index="${index}" title="Delete Job">${ICON_TRASH}</button>
                  </td>
                </tr>
              `;
              }
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  historyArea.querySelectorAll(".sortable-th").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (historyTableState.sortKey === key) {
        historyTableState.sortDir = historyTableState.sortDir === "asc" ? "desc" : "asc";
      } else {
        historyTableState.sortKey = key;
        historyTableState.sortDir = (key === "recordedAt" || key === "totalWeight" || key === "totalAmount" || key === "quantity") ? "desc" : "asc";
      }
      renderPrintHistory();
    });
  });

  const filterCategoryEl = document.getElementById("historyFilterCategory");
  if (filterCategoryEl) filterCategoryEl.addEventListener("change", (e) => { historyTableState.filterCategory = e.target.value; renderPrintHistory(); });
  const filterCustomerEl = document.getElementById("historyFilterCustomer");
  if (filterCustomerEl) filterCustomerEl.addEventListener("change", (e) => { historyTableState.filterCustomer = e.target.value; renderPrintHistory(); });
  const filterStatusEl = document.getElementById("historyFilterStatus");
  if (filterStatusEl) filterStatusEl.addEventListener("change", (e) => { historyTableState.filterStatus = e.target.value; renderPrintHistory(); });
  const filterDateFromEl = document.getElementById("historyFilterDateFrom");
  if (filterDateFromEl) filterDateFromEl.addEventListener("change", (e) => { historyTableState.dateFrom = e.target.value; renderPrintHistory(); });
  const filterDateToEl = document.getElementById("historyFilterDateTo");
  if (filterDateToEl) filterDateToEl.addEventListener("change", (e) => { historyTableState.dateTo = e.target.value; renderPrintHistory(); });
  const clearFiltersBtn = document.getElementById("historyFilterClearBtn");
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", () => {
      historyTableState.filterCategory = "";
      historyTableState.filterCustomer = "";
      historyTableState.filterStatus = "";
      historyTableState.dateFrom = "";
      historyTableState.dateTo = "";
      renderPrintHistory();
    });
  }

  historyArea.querySelectorAll(".job-status-select").forEach(select => {
    select.addEventListener("change", async (e) => {
      const idx = e.target.dataset.index;
      const job = STATE.history[idx];
      const oldStatus = job.status || "draft";
      const newStatus = e.target.value;

      if (oldStatus !== newStatus) {
        const qty = Math.max(1, Number(job.quantity) || 1);
        if (newStatus === "completed" && oldStatus !== "completed") {
          if (job.parts) {
            job.parts.forEach(part => {
              const mat = STATE.config.materials.find(m => m.code === part.materialCode);
              if (mat) {
                const totalUsedKg = (part.weightGrams * qty) / 1000;
                if ((mat.stockKg || 0) < totalUsedKg) {
                  alert(`\u26a0\ufe0f Insufficient filament stock in Spool "${mat.brand || ''} ${mat.name || ''}" (${mat.stockKg.toFixed(2)}kg remaining, needed ${totalUsedKg.toFixed(2)}kg). Stock has been set to 0.`);
                }
                mat.stockKg = Math.max(0, (mat.stockKg || 0) - totalUsedKg);
              }
            });
          }
          // Log the machine time this job actually consumed against its
          // assigned printer — total print time per set × quantity of
          // sets — so Logged Print Hours (Settings → Printers) reflects
          // real usage instead of staying at whatever was last typed in.
          if (job.printerId) {
            const printer = STATE.config.printers.find(p => p.id === job.printerId);
            if (printer) {
              const jobHours = (Number(job.printTimeHours) || 0) * qty;
              printer.loggedHours = Math.max(0, (printer.loggedHours || 0) + jobHours);
            }
          }
        } else if (oldStatus === "completed" && newStatus !== "completed") {
          if (job.parts) {
            job.parts.forEach(part => {
              const mat = STATE.config.materials.find(m => m.code === part.materialCode);
              if (mat) {
                const totalUsedKg = (part.weightGrams * qty) / 1000;
                mat.stockKg = (mat.stockKg || 0) + totalUsedKg;
              }
            });
          }
          // Reverting a job out of "completed" (e.g. a status mistake) —
          // give the logged hours back so re-completing it later doesn't
          // double-count.
          if (job.printerId) {
            const printer = STATE.config.printers.find(p => p.id === job.printerId);
            if (printer) {
              const jobHours = (Number(job.printTimeHours) || 0) * qty;
              printer.loggedHours = Math.max(0, (printer.loggedHours || 0) - jobHours);
            }
          }
        }
        job.status = newStatus;
        syncPrintedDate(job);
        touchJob(job);
        saveState();
        renderInventory();
        renderPrintHistory();
        renderPrinters();
      }
    });
  });

  historyArea.querySelectorAll(".job-category-select").forEach(select => {
    select.addEventListener("change", (e) => {
      const idx = e.target.dataset.index;
      const job = STATE.history[idx];
      if (!job) return;
      job.category = e.target.value;
      // Quick top-level change from the table \u2014 subcategory/sub-
      // subcategory no longer necessarily apply, so clear them. Use the
      // Job Details page to set the full category path at once.
      job.subcategory = "";
      job.subSubcategory = "";
      touchJob(job);
      saveState();
      renderPrintHistory();
    });
  });

  historyArea.querySelectorAll(".view-job").forEach(btn => {
    btn.addEventListener("click", () => viewJobDetails(btn.dataset.index));
  });

  historyArea.querySelectorAll(".delete-job").forEach(btn => {
    btn.addEventListener("click", async () => {
      const job = STATE.history[btn.dataset.index];
      const isCompletedJob = job && String(job.status || "").trim().toLowerCase() === "completed";
      const confirmMsg = isCompletedJob
        ? "This job is marked Completed and its material stock has already been deducted. Deleting it will remove the record but will NOT add that stock back automatically. Delete anyway?"
        : "Are you sure you want to delete this job record?";
      if(confirm(confirmMsg)) {
        if (job && job.parts) {
          for (const part of job.parts) {
            if (part.stl && part.stl.dbKey) {
              try {
                await deleteFileFromDB(part.stl.dbKey);
              } catch (err) {
                console.error("Failed to delete Part STL on job deletion", err);
              }
            }
          }
        }
        STATE.history.splice(btn.dataset.index, 1);
        saveState();
        renderPrintHistory();
      }
    });
  });

  historyArea.querySelectorAll(".sync-job").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = btn.dataset.index;
      const job = STATE.history[idx];
      if (!job) return;
      btn.innerHTML = "Syncing...";
      btn.disabled = true;
      await syncJobEverything(job);
      renderPrintHistory();
    });
  });

  renderHistorySummary();
  applyTableFilters();
}


function getMaterialFullName(material) {
  if (!material) return "Unknown Material";
  return `${material.brand ? material.brand + ' ' : ''}${material.name} (${getColorName(material.colorHex)})`;
}

async function downloadStlFile(dbKey, fileName) {
  try {
    const fileBlob = await getFileFromDB(dbKey);
    if (!fileBlob) {
      alert("Error: STL file data not found in local browser database.");
      return;
    }
    const url = URL.createObjectURL(fileBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Failed to download STL file:", e);
    alert("Could not download STL file from local database.");
  }
}

// Re-runs pricing for a saved job from its current parts array — used
// whenever parts are edited/added/removed on the Job Details page, and by
// the explicit "Recalculate Pricing" button. Mirrors the allocation logic
// in renderWeightEstimate() so a job's per-part costs and cost breakdown
// stay consistent with a freshly-generated quote, not just its total.
function recalculateJobPricing(jobIdx) {
  const jobToEdit = STATE.history[jobIdx];
  if (!jobToEdit || !jobToEdit.parts) return;

  let newTotalTime = 0;
  jobToEdit.parts.forEach(p => { newTotalTime += (p.printTimeHours || 0); });
  jobToEdit.printTimeHours = newTotalTime;

  const estimate = calculatePrintCost(jobToEdit, STATE.config.printerSettings, STATE.config.materials, STATE.config.printers);
  const designFee = jobToEdit.details?.designFee || 0;
  // Percentage fees follow the (possibly changed) price; flat fees stay put.
  const extraFeeRows = (jobToEdit.details?.extraFees || []).map((f) => ({
    ...f,
    amount: f.valueType === "percentage"
      ? estimate.sellingPriceExVat * ((Number(f.value) || 0) / 100)
      : (f.valueType === "flat" ? (Number(f.value) || 0) : (f.amount || 0)),
  }));
  const extraFeesTotal = extraFeeRows.reduce((sum, f) => sum + (f.amount || 0), 0);
  const subtotalExVat = estimate.sellingPriceExVat + designFee + extraFeesTotal;

  const discountAdj = applyQuoteDiscounts(estimate, designFee, extraFeesTotal, jobToEdit.details?.discountItems || [], getVatOptions());
  const totalExactAfterMinOrder = applyMinOrder(discountAdj.totalBeforeMinOrder);

  const minGrams = STATE.config?.minChargeGrams ?? 10;
  let totalPartsMaterialCost = 0;
  const partCosts = jobToEdit.parts.map(p => {
    const mat = getSelectedMaterial(p.materialCode);
    const chargedWeightGrams = Math.max(p.weightGrams, minGrams);
    const materialCost = (chargedWeightGrams / 1000) * (mat.costPerKgKes || 0);
    totalPartsMaterialCost += materialCost;
    return { name: p.name || "", materialCost };
  });
  partCosts.forEach(pc => {
    const share = totalPartsMaterialCost > 0 ? pc.materialCost / totalPartsMaterialCost : 1 / partCosts.length;
    pc.allocatedPrice = share * subtotalExVat;
  });

  const ladder = buildCustomerLadder({
    partAmounts: partCosts.map((pc) => pc.allocatedPrice),
    subtotalExact: subtotalExVat,
    discountRows: discountAdj.rows,
    vatMode: discountAdj.vatMode,
    vatRatePercent: getVatOptions().ratePercent,
    vatExact: discountAdj.vatAmount,
    totalExact: totalExactAfterMinOrder,
    rounding: getRoundingOptions(),
  });
  jobToEdit.totalAmount = ladder.total;
  const recalcMargin = calcMarginPercent(ladder.total, ladder.vat, estimate.totalProductionCost);
  const recalcTarget = Number(STATE.config.targetMarginPercent) || 0;

  jobToEdit.details = jobToEdit.details || {};
  jobToEdit.details.vatMode = discountAdj.vatMode;
  jobToEdit.details.vatRatePercent = getVatOptions().ratePercent;
  jobToEdit.details.roundingStep = getRoundingOptions().step;
  jobToEdit.details.roundingMode = getRoundingOptions().mode;
  jobToEdit.details.roundingAdjustment = ladder.roundingAdjustment;
  jobToEdit.details.preRoundingTotal = totalExactAfterMinOrder;
  jobToEdit.details.marginPercent = recalcMargin;
  jobToEdit.details.targetMarginPercent = recalcTarget;
  jobToEdit.details.marginBelowTarget = isBelowTargetMargin(recalcMargin, recalcTarget);
  jobToEdit.details.extraFees = extraFeeRows;
  jobToEdit.details.extraFeesTotal = extraFeesTotal;
  jobToEdit.details.partCosts = partCosts;
  jobToEdit.details.discounts = discountAdj.rows;
  jobToEdit.details.discountsTotal = discountAdj.discountsTotal;
  jobToEdit.details.vatAfterDiscount = discountAdj.vatAmount;
  jobToEdit.details.discountBelowCost = discountAdj.belowCost;
  jobToEdit.details.discountMinOrderApplied = discountAdj.discountsTotal > 0 && totalExactAfterMinOrder > discountAdj.totalBeforeMinOrder + 0.005;
  jobToEdit.details.costBreakdown = {
    materialCost: estimate.materialCost,
    electricityCost: estimate.electricityCost,
    depreciationCost: estimate.depreciationCost,
    maintenanceCost: estimate.maintenanceCost,
    laborCost: estimate.laborCost,
    overheadCost: estimate.overheadCost,
    failedPrintBuffer: estimate.failedPrintBuffer,
    packagingCost: estimate.packagingCost,
    componentsCost: estimate.componentsCost,
    bulkDiscountAmount: estimate.bulkDiscountAmount,
    bulkDiscountPercent: estimate.bulkDiscountPercent,
    totalProductionCost: estimate.totalProductionCost,
    profitAmount: estimate.profitAmount,
    vatAmount: estimate.vatAmount,
    sellingPriceExVat: estimate.sellingPriceExVat,
    sellingPriceIncVat: estimate.sellingPriceIncVat,
  };

  touchJob(jobToEdit);
  saveState();
}

function viewJobDetails(index) {
  const job = STATE.history[index];
  if (!job) return;
  
  const isCompleted = String(job.status || "").trim().toLowerCase() === "completed";
  
  let imagesHtml = '';
  if (job.images && job.images.length > 0) {
    imagesHtml = `
      <h3>Attached Images</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; margin-top: 8px;">
        ${job.images.map((src, imgIdx) => `
          <div style="position: relative; width: 100%; aspect-ratio: 1;">
            <img src="${src}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 1px solid var(--border);" />
            ${!isCompleted ? `<button class="drawer-img-del-btn" data-job-idx="${index}" data-img-idx="${imgIdx}" style="position: absolute; top: 4px; right: 4px; background: rgba(220,38,38,0.85); color: white; border: none; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12px; font-weight: bold; padding: 0; line-height: 1;" type="button">&times;</button>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } else {
    imagesHtml = `
      <h3>Attached Images</h3>
      <p class="help-text mt-8">No images attached to this job yet.</p>
    `;
  }

  let uploadHtml = "";
  if (!isCompleted) {
    uploadHtml = `
      <div class="upload-section mt-24 pt-16" style="border-top: 1px dashed var(--border);">
        <label style="font-weight: 600;">Add More Images</label>
        <input type="file" id="drawerJobImages" accept="image/*" multiple style="margin-top: 8px;" />
        <button id="drawerUploadBtn" class="secondary mt-8 full-width" type="button" style="padding: 8px 12px; font-size: 0.85rem;">Upload Images</button>
      </div>
    `;
  }

  let partsHtml = "";
  let totalWeight = 0;
  if (job.parts) {
    partsHtml = job.parts.map((p, partIdx) => {
      const mat = STATE.config.materials.find(m => m.code === p.materialCode);
      const matName = mat ? (mat.brand ? mat.brand + ' ' : '') + mat.name : 'Unknown';
      const colorName = p.colorHex ? getColorName(p.colorHex) : (mat ? getColorName(mat.colorHex) : "Unknown");
      totalWeight += p.weightGrams;
      const pName = `<span class="job-part-index">${partIdx + 1}</span><strong>${p.name || `Part ${partIdx + 1}`}</strong>`;
      
      let stlControlsHtml = "";
      if (p.stl) {
        const sizeMb = (p.stl.size / (1024 * 1024)).toFixed(2);
        stlControlsHtml = `
          <div style="margin-top: 8px; display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--surface-primary); border: 1px solid var(--border); border-radius: 6px;">
            <span style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; font-weight: 500;" title="${p.stl.name}">📦 ${p.stl.name} (${sizeMb} MB)</span>
            <div style="display: flex; gap: 4px;">
              <button class="drawer-part-stl-dl nav-btn" data-db-key="${p.stl.dbKey}" data-file-name="${p.stl.name}" style="padding: 4px 8px; font-size: 0.75rem; background: var(--accent-soft); color: var(--accent); border-color: var(--accent);" type="button">Download Model</button>
              ${!isCompleted ? `<button class="drawer-part-stl-del icon-btn danger" data-job-idx="${index}" data-part-idx="${partIdx}" data-db-key="${p.stl.dbKey}" style="width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; padding: 0; font-size: 0.95rem;" type="button">&times;</button>` : ''}
            </div>
          </div>
        `;
      } else {
        if (!isCompleted) {
          stlControlsHtml = `
            <div style="margin-top: 8px; display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--surface-primary); border: 1px dashed var(--border); border-radius: 6px;">
              <span style="font-size: 0.8rem; color: var(--text-secondary); font-style: italic;">No Model attached</span>
              <div>
                <input type="file" class="drawer-part-stl-upload-input" accept=".stl,.obj,.3mf,.stp,.step,.iges,.igs,.fbx,.dae,.ply,.gcode,.glb,.gltf" data-job-idx="${index}" data-part-idx="${partIdx}" style="display: none;" id="drawer-stl-input-${index}-${partIdx}" />
                <button class="drawer-part-stl-upload-btn nav-btn" onclick="document.getElementById('drawer-stl-input-${index}-${partIdx}').click()" style="padding: 4px 8px; font-size: 0.75rem;" type="button">Add Model</button>
              </div>
            </div>
          `;
        } else {
          stlControlsHtml = `
            <div style="margin-top: 8px; font-size: 0.8rem; color: var(--text-secondary); font-style: italic;">No Model attached</div>
          `;
        }
      }

      let partDetailsHtml = '';
      if (!isCompleted) {
        const materialOptions = STATE.config.materials.map(m => {
          const mName = (m.brand ? m.brand + ' ' : '') + m.name;
          return `<option value="${m.code}" ${m.code === p.materialCode ? 'selected' : ''}>${mName}</option>`;
        }).join('');
        const colorOptions = STATE.config.colors.map(c => {
          return `<option value="${c.hex}" ${c.hex === (p.colorHex || (mat ? mat.colorHex : '')) ? 'selected' : ''}>${c.name}</option>`;
        }).join('');

        const partCostEdit = job.details?.partCosts?.[partIdx];
        partDetailsHtml = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;">
            <label style="font-size: 0.75rem; color: var(--text-secondary); grid-column: span 2;">Part Name
              <input type="text" class="drawer-edit-name full-width" data-job-idx="${index}" data-part-idx="${partIdx}" value="${p.name || ''}" style="padding: 4px; font-size: 0.85rem;" />
            </label>
            <label style="font-size: 0.75rem; color: var(--text-secondary);">Weight (g)
              <input type="number" class="drawer-edit-weight full-width" data-job-idx="${index}" data-part-idx="${partIdx}" value="${p.weightGrams}" style="padding: 4px; font-size: 0.85rem;" />
            </label>
            <label style="font-size: 0.75rem; color: var(--text-secondary);">Time (hrs)
              <input type="number" class="drawer-edit-time full-width" data-job-idx="${index}" data-part-idx="${partIdx}" value="${p.printTimeHours || 0}" step="0.1" style="padding: 4px; font-size: 0.85rem;" />
            </label>
            <label style="font-size: 0.75rem; color: var(--text-secondary);">Material
              <select class="drawer-edit-material full-width" data-job-idx="${index}" data-part-idx="${partIdx}" style="padding: 4px; font-size: 0.85rem;">
                ${materialOptions}
              </select>
            </label>
            <label style="font-size: 0.75rem; color: var(--text-secondary);">Color
              <select class="drawer-edit-color full-width" data-job-idx="${index}" data-part-idx="${partIdx}" style="padding: 4px; font-size: 0.85rem;">
                ${colorOptions}
              </select>
            </label>
          </div>
          ${partCostEdit ? `<div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 6px;">Material cost: <strong>${formatKes(partCostEdit.materialCost)}</strong> · Allocated price: <strong>${formatKes(partCostEdit.allocatedPrice)}</strong></div>` : ""}
          ${job.parts.length > 1 ? `<button type="button" class="drawer-remove-part tertiary mt-8" data-job-idx="${index}" data-part-idx="${partIdx}" style="padding: 4px 8px; font-size: 0.75rem; color: var(--danger);">Remove Part</button>` : ""}
        `;
      } else {
        const partCost = job.details?.partCosts?.[partIdx];
        partDetailsHtml = `
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 2px;">
            ${Math.round(p.weightGrams)}g, ${p.printTimeHours || 0} hrs — ${matName} (${colorName})
            ${partCost ? `<br/>Material cost: <strong>${formatKes(partCost.materialCost)}</strong> · Allocated price: <strong>${formatKes(partCost.allocatedPrice)}</strong>` : ""}
          </div>
        `;
      }

      return `
        <li class="job-part-card">
          <div>
            <div class="job-part-card-header">${pName}</div>
            ${partDetailsHtml}
          </div>
          ${stlControlsHtml}
        </li>
      `;
    }).join("");
  } else {
    totalWeight = job.weightGrams;
    partsHtml = `<li class="job-part-card">${Math.round(job.weightGrams)}g — <strong>${job.materialName}</strong></li>`;
  }

  const cb = job.details?.costBreakdown;
  const customerCompany = job.details?.customerCompany;
  const statusKey = String(job.status || "draft").trim().toLowerCase();
  const statusLabel = statusKey.replace(/_/g, " ");
  const company = STATE.config.companyInfo || DEFAULT_CONFIG.companyInfo;

  const html = `
    <div class="job-overview-card">
      <div class="job-overview-top">
        <div>
          <p class="job-overview-title">${escapeHtml(job.name) || "Unnamed Project"}</p>
          ${customerCompany ? `<p class="job-overview-customer">${escapeHtml(customerCompany)}${job.details?.customerContact ? ` — ${escapeHtml(job.details.customerContact)}` : ""}</p>` : `<p class="job-overview-customer help-text" style="margin:0;">No customer linked</p>`}
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          ${buildPaymentPillHtml(job)}
          <span class="status-pill status-${statusKey}">${statusLabel}</span>
        </div>
      </div>
      <div class="job-stat-grid">
        <div class="job-stat-tile"><span class="stat-label">Date</span><span class="stat-value" style="font-size:0.95rem;">${formatJobDate(job.recordedAt)}</span></div>
        <div class="job-stat-tile"><span class="stat-label">Total Weight</span><span class="stat-value">${Math.round(totalWeight)} g</span></div>
        <div class="job-stat-tile"><span class="stat-label">Print Time</span><span class="stat-value">${job.printTimeHours.toFixed(1)} hrs</span></div>
        <div class="job-stat-tile"><span class="stat-label">Quantity</span><span class="stat-value">${job.quantity}</span></div>
      </div>
    </div>

    <div class="job-actions-bar">
      <div class="job-actions-buttons">
        <button type="button" id="jobDetailWhatsappBtn" class="secondary" data-index="${index}">💬 Send via WhatsApp</button>
        <button type="button" id="jobDetailEmailBtn" class="secondary" data-index="${index}">✉️ Email Quote</button>
        ${job.invoiceNumber ? `<button type="button" id="jobDetailEmailInvoiceBtn" class="secondary" data-index="${index}">✉️ Email Invoice</button>` : ""}
        <button type="button" id="jobDetailPdfBtn" class="secondary" data-index="${index}">📄 Generate PDF Quote</button>
        <button type="button" id="jobDetailInvoiceBtn" class="secondary" data-index="${index}">🧾 Generate Invoice${job.invoiceNumber ? ` (${job.invoiceNumber})` : ""}</button>
      </div>
      ${buildJobSyncStatusHtml(job, index, "job-actions-sync")}
    </div>

    <div class="job-detail-section">
      <h3 style="margin-bottom: 12px;">Category</h3>
      <div class="grid-2" style="gap: 8px;">
        <label class="category-level-wrap">Category
          <select id="jobDetailCategorySelect" style="padding: 6px; margin-top: 4px;"></select>
        </label>
        <label class="category-level-wrap hidden">Subcategory
          <select id="jobDetailSubcategorySelect" style="padding: 6px; margin-top: 4px;"></select>
        </label>
        <label class="category-level-wrap hidden">Sub-subcategory
          <select id="jobDetailSubSubcategorySelect" style="padding: 6px; margin-top: 4px;"></select>
        </label>
      </div>
      <button type="button" id="jobDetailSaveCategoryBtn" class="secondary mt-8" data-index="${index}" style="padding: 6px 12px; font-size: 0.85rem;">Save Category</button>
    </div>

    <div class="job-detail-grid">
      <div class="job-detail-col">
        <div class="job-detail-section">
          <div class="job-section-title">
            <h3>Project Parts & STL Models</h3>
            <span class="job-count-badge">${job.parts ? job.parts.length : 1}</span>
          </div>
          <ul style="margin: 12px 0 0 0; padding: 0;">
            ${partsHtml}
          </ul>
          ${(!isCompleted && job.parts) ? `
            <div class="flex-between" style="gap: 10px; flex-wrap: wrap; margin-top: 4px;">
              <button type="button" id="drawerAddPartBtn" class="secondary" data-job-idx="${index}" style="padding: 6px 12px; font-size: 0.85rem;">+ Add Part</button>
              <button type="button" id="drawerRecalcBtn" class="primary" data-job-idx="${index}" style="padding: 6px 12px; font-size: 0.85rem;">↻ Recalculate Pricing</button>
            </div>
            <p class="help-text mt-8">Pricing recalculates automatically whenever you change a part above. Use Recalculate if you'd like to refresh it explicitly (e.g. after editing Settings/Financials).</p>
          ` : ""}
        </div>

        <div class="job-detail-section">
          <div class="job-section-title">
            <h3>Components</h3>
            <span class="job-count-badge">${(job.components || []).length}</span>
          </div>
          ${(job.components && job.components.length > 0) ? `
            <ul style="margin: 12px 0 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px;">
              ${job.components.map((c, cIdx) => `
                <li style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background: var(--surface-hover); border-radius:8px;">
                  <span>${c.name}<span class="help-text" style="margin-left:6px;">${c.category || ""}</span></span>
                  <span style="display:flex; align-items:center; gap:10px;">
                    <strong>${formatKes(c.costKes)}</strong>
                    ${(!isCompleted && job.parts) ? `<button type="button" class="icon-btn danger drawer-remove-component" data-job-idx="${index}" data-comp-idx="${cIdx}" title="Remove">${ICON_TRASH}</button>` : ""}
                  </span>
                </li>
              `).join("")}
            </ul>
          ` : `<p class="help-text mt-8">No components on this job yet.</p>`}
          ${(!isCompleted && job.parts) ? `
            <div class="mt-12" style="display:flex; flex-direction:column; gap: 8px;">
              <label style="font-size: 0.75rem; color: var(--text-secondary);">Category
                <select id="drawerComponentCategory" data-job-idx="${index}" style="padding: 6px; margin-top: 4px;">${getComponentCategoryOptionsHtml()}</select>
              </label>
              <label style="font-size: 0.75rem; color: var(--text-secondary);">Component
                <select id="drawerComponentSelect" data-job-idx="${index}" style="padding: 6px; margin-top: 4px; width: 100%;"></select>
              </label>
            </div>
            <button type="button" id="drawerAddComponentBtn" class="secondary mt-8" data-job-idx="${index}" style="padding: 6px 12px; font-size: 0.85rem;">+ Add Component</button>
            <p class="help-text mt-8">Manage the catalog of available components (name, category, cost) in Settings → Components.</p>
          ` : ""}
        </div>

        <div class="job-detail-section">
          ${(() => {
            const canEdit = !isCompleted && job.parts;
            const fees = job.details?.extraFees || [];
            const removedFees = job.details?.removedExtraFees || [];
            const designFeeVal = job.details?.designFee || 0;
            const liStyle = "display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background: var(--surface-hover); border-radius:8px;";
            return `
          <div class="job-section-title">
            <h3>Fees</h3>
            <span class="job-count-badge">${fees.length}</span>
          </div>
          <ul style="margin: 12px 0 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px;">
            <li style="${liStyle}">
              <span>Design fee</span>
              ${canEdit ? `
                <span style="display:flex; align-items:center; gap:6px;">
                  <input type="number" id="drawerDesignFeeInput" min="0" step="any" value="${designFeeVal}" style="width: 100px; padding: 4px 6px;" />
                  <button type="button" id="drawerDesignFeeBtn" class="secondary" data-job-idx="${index}" style="padding: 4px 10px; font-size: 0.8rem;">Update</button>
                </span>
              ` : `<strong>${formatKes(designFeeVal)}</strong>`}
            </li>
            ${fees.map((f, fIdx) => `
              <li style="${liStyle}">
                <span>${escapeHtml(f.label || "Fee")}</span>
                <span style="display:flex; align-items:center; gap:10px;">
                  <strong>${formatKes(f.amount || 0)}</strong>
                  ${canEdit ? `<button type="button" class="icon-btn danger drawer-remove-fee" data-job-idx="${index}" data-fee-idx="${fIdx}" title="Remove from this job">${ICON_TRASH}</button>` : ""}
                </span>
              </li>
            `).join("")}
            ${removedFees.map((f, rIdx) => `
              <li style="${liStyle} opacity:0.65;">
                <span style="text-decoration: line-through;">${escapeHtml(f.label || "Fee")}</span>
                ${canEdit ? `<button type="button" class="secondary drawer-restore-fee" data-job-idx="${index}" data-fee-idx="${rIdx}" style="padding: 2px 10px; font-size: 0.78rem;">Restore</button>` : `<span>removed</span>`}
              </li>
            `).join("")}
          </ul>
          ${fees.length === 0 && removedFees.length === 0 ? `<p class="help-text mt-8">No extra fees on this job.</p>` : ""}
          ${canEdit ? `<p class="help-text mt-8">Removing a fee only affects this job. Fees are set up in Settings → Financials & Metrics.</p>` : ""}`;
          })()}
        </div>

        <div class="job-detail-section">
          ${(() => {
            const dItems = job.details?.discountItems || [];
            const dRows = job.details?.discounts || [];
            const canEdit = !isCompleted && job.parts;
            const dNotes = buildDiscountNotes(job.details?.discountBelowCost, job.details?.discountMinOrderApplied);
            return `
          <div class="job-section-title">
            <h3>Discounts</h3>
            <span class="job-count-badge">${dItems.length}</span>
          </div>
          ${dItems.length > 0 ? `
            <ul style="margin: 12px 0 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px;">
              ${dItems.map((d, dIdx) => `
                <li style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background: var(--surface-hover); border-radius:8px;">
                  <span>${escapeHtml(discountRowLabel(d))}</span>
                  <span style="display:flex; align-items:center; gap:10px;">
                    <strong>−${formatKes(dRows[dIdx] ? dRows[dIdx].amount : 0)}</strong>
                    ${canEdit ? `<button type="button" class="icon-btn danger drawer-remove-discount" data-job-idx="${index}" data-disc-idx="${dIdx}" title="Remove">${ICON_TRASH}</button>` : ""}
                  </span>
                </li>
              `).join("")}
            </ul>
          ` : `<p class="help-text mt-8">No discounts on this job.</p>`}
          ${dNotes.length > 0 ? `<p class="help-text mt-8" style="color:#dc2626;">⚠ ${dNotes.join(" ")}</p>` : ""}
          ${canEdit ? `
            <div class="mt-12" style="display:flex; flex-direction:column; gap: 8px;">
              <div style="display:flex; gap: 8px;">
                <label style="font-size: 0.75rem; color: var(--text-secondary); flex: 0 0 185px;">Type
                  <select id="drawerDiscountType" style="padding: 6px; margin-top: 4px;">
                    <option value="percent">Percentage (%)</option>
                    <option value="fixed">Amount (${getCurrencyCode()})</option>
                  </select>
                </label>
                <label style="font-size: 0.75rem; color: var(--text-secondary); flex: 1;">Value
                  <input type="number" id="drawerDiscountValue" min="0" step="any" placeholder="e.g. 10" style="padding: 6px; margin-top: 4px; width: 100%;" />
                </label>
              </div>
              <label style="font-size: 0.75rem; color: var(--text-secondary);">Label (optional)
                <input type="text" id="drawerDiscountLabel" placeholder="e.g. Loyal customer" style="padding: 6px; margin-top: 4px; width: 100%;" />
              </label>
            </div>
            <button type="button" id="drawerAddDiscountBtn" class="secondary mt-8" data-job-idx="${index}" style="padding: 6px 12px; font-size: 0.85rem;">+ Add Discount</button>
            <p class="help-text mt-8">Discounts come off the ex-${taxLabel()} subtotal; ${taxLabel()} and the total update automatically.</p>
          ` : ""}`;
          })()}
        </div>

      </div>


      <div class="job-detail-col">
        <div class="job-detail-section">
          <h3 style="margin-bottom: 12px;">Financial Summary</h3>
          <div class="job-total-highlight">
            <span class="label">Total Final Amount (incl. ${taxLabel()})</span>
            <span class="value">${formatKes(job.totalAmount)}</span>
          </div>
          <div class="breakdown financial-summary-table" style="border-top: none; padding-top: 0;">
            <table>
              <tbody>
                ${cb ? `<tr><td>Subtotal (ex. ${taxLabel()})</td><td>${formatKes(cb.sellingPriceExVat)}</td></tr>` : ""}
                ${cb ? `<tr><td>${taxLabel()} (${STATE.config.printerSettings.vatRatePercent}%)</td><td>${formatKes(job.details?.vatAfterDiscount ?? cb.vatAmount)}</td></tr>` : ""}
                ${(job.details?.designFee || 0) > 0 ? `<tr><td>Design Fee</td><td>${formatKes(job.details.designFee)}</td></tr>` : ""}
                ${(job.details?.postProcessFee || 0) > 0 ? `<tr><td>Post-Process Fee / Unit (included in subtotal)</td><td>${formatKes(job.details.postProcessFee)}</td></tr>` : ""}
                ${(job.details?.extraFees || []).filter(f => (f.amount || 0) !== 0).map(f => `<tr><td>${f.label}</td><td>${formatKes(f.amount)}</td></tr>`).join("")}
                ${(job.details?.discounts || []).filter(d => (d.amount || 0) > 0).map(d => `<tr><td>${escapeHtml(discountRowLabel(d))}</td><td>-${formatKes(d.amount)}</td></tr>`).join("")}
                ${(job.details?.roundingAdjustment || 0) !== 0 ? `<tr><td>Rounding</td><td>${job.details.roundingAdjustment > 0 ? "+" : "-"}${formatKes(Math.abs(job.details.roundingAdjustment))}</td></tr>` : ""}
                <tr class="financial-summary-total-row"><td>Total Final Amount</td><td>${formatKes(job.totalAmount)}</td></tr>
              </tbody>
            </table>
          </div>
          ${job.details?.marginBelowTarget ? `<p class="help-text" style="color:#dc2626; margin: 8px 0 0;">⚠ ${escapeHtml(buildMarginNote(job.details.marginPercent, job.details.targetMarginPercent))}</p>` : ""}
          ${(() => {
            const paymentLines = buildPaymentLines(company);
            if (paymentLines.length > 0) {
              return `
          <div class="payment-preview-box">
            <div class="payment-preview-label">💳 Payment Details <span style="font-weight:400; text-transform:none; letter-spacing:0;">(from Company & Branding — shown on the PDF quote & WhatsApp message)</span></div>
            <p>${paymentLines.map(escapeHtml).join("<br>")}</p>
          </div>`;
            }
            return `
          <div class="payment-preview-box">
            <div class="payment-preview-label">💳 Payment Details</div>
            <p class="help-text" style="margin:0;">Not set yet. Add your payment details in <a href="#" id="jobDetailGoToPaymentSettings" style="color: var(--accent); font-weight: 600;">Settings → Company & Branding</a> so they appear on every PDF quote.</p>
          </div>`;
          })()}
        </div>

        <div class="job-detail-section" id="jobPaymentsSection">
          ${(() => {
            const pay = getJobPaymentSummary(job);
            const payments = Array.isArray(job.payments) ? job.payments : [];
            const company = STATE.config.companyInfo || {};
            const depositPct = Math.min(100, Math.max(0, Number(company.depositPercent) || 0));
            const depositTarget = getDepositAmount(pay.total, depositPct);
            const depositStillToReceive = Math.max(0, depositTarget - pay.paid);
            const suggested = depositStillToReceive > 0 ? depositStillToReceive : Math.max(0, pay.balance);
            const colour = { unpaid: "#dc2626", partial: "#d97706", paid: "#16a34a", overpaid: "#d97706" }[pay.status];
            const statusText = { unpaid: "Unpaid", partial: "Part-paid", paid: "Paid in full", overpaid: "Overpaid" }[pay.status];
            return `
          <div class="job-section-title">
            <h3>Payments</h3>
            <span class="job-count-badge" style="color:${colour};">${statusText}</span>
          </div>
          <ul class="compact-list">
            <li class="compact-row"><span>Paid so far</span><strong>${formatKes(pay.paid)}</strong></li>
            <li class="compact-row"><span>${pay.balance < 0 ? "Overpaid by" : "Balance due"}</span><strong style="color:${colour};">${formatKes(Math.abs(pay.balance))}</strong></li>
          </ul>
          ${depositPct > 0 && depositStillToReceive > 0 ? `<p class="help-text mt-8">Deposit requested: ${formatKes(depositTarget)} (${depositPct}%) — ${formatKes(depositStillToReceive)} still to receive.</p>` : ""}
          ${payments.length > 0 ? `
            <ul class="compact-list">
              ${payments.map((p, pIdx) => `
                <li class="compact-row">
                  <span>${escapeHtml(formatPaymentDate(p.date))} · ${escapeHtml(p.method || "Payment")}${p.note ? ` <span style="color: var(--text-secondary);">(${escapeHtml(p.note)})</span>` : ""}</span>
                  <span style="display:flex; align-items:center; gap:10px;">
                    <strong>${formatKes(p.amount)}</strong>
                    <button type="button" class="icon-btn danger drawer-remove-payment" data-job-idx="${index}" data-pay-idx="${pIdx}" title="Remove this payment">${ICON_TRASH}</button>
                  </span>
                </li>
              `).join("")}
            </ul>
          ` : `<p class="help-text mt-8">No payments recorded yet.</p>`}
          <details class="payment-form">
            <summary>+ Record a payment</summary>
            <div class="payment-form-fields">
              <div class="payment-form-row">
                <label>Amount
                  <input type="number" id="drawerPayAmount" min="0" step="any" value="${suggested > 0 ? suggested : ""}" />
                </label>
                <label>Method
                  <select id="drawerPayMethod">
                    ${PAYMENT_METHODS.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}
                  </select>
                </label>
              </div>
              <div class="payment-form-row">
                <label>Date
                  <input type="date" id="drawerPayDate" value="${todayLocalIsoDate()}" />
                </label>
                <label>Note (optional)
                  <input type="text" id="drawerPayNote" placeholder="e.g. transaction ID" />
                </label>
              </div>
            </div>
            <div class="payment-form-actions">
              <button type="button" id="drawerAddPaymentBtn" class="secondary" data-job-idx="${index}" style="padding: 6px 12px; font-size: 0.85rem;">Save Payment</button>
              ${pay.balance > 0 ? `<button type="button" id="drawerPayFullBtn" class="tertiary" data-job-idx="${index}" style="padding: 6px 12px; font-size: 0.85rem;">Pay in full (${formatKes(pay.balance)})</button>` : ""}
            </div>
          </details>`;
          })()}
        </div>

        <div class="job-detail-section">
          <h3 style="margin-bottom: 4px;">Cost Breakdown</h3>
          <p class="help-text" style="margin: 0 0 12px;">Your estimate before fees and discounts — the Financial Summary above is what the customer pays.</p>
          <div class="breakdown" style="border-top: none; padding-top: 0;">
            ${cb ? `
            <table>
              <tbody>
                <tr><td>Material cost</td><td>${formatKes(cb.materialCost)}</td></tr>
                <tr><td>Electricity cost</td><td>${formatKes(cb.electricityCost)}</td></tr>
                <tr><td>Depreciation cost</td><td>${formatKes(cb.depreciationCost)}</td></tr>
                <tr><td>Maintenance cost</td><td>${formatKes(cb.maintenanceCost)}</td></tr>
                <tr><td>Labour cost</td><td>${formatKes(cb.laborCost)}</td></tr>
                <tr><td>Overhead cost</td><td>${formatKes(cb.overheadCost)}</td></tr>
                <tr><td>Failed print buffer</td><td>${formatKes(cb.failedPrintBuffer)}</td></tr>
                <tr><td>Packaging</td><td>${formatKes(cb.packagingCost)}</td></tr>
                ${cb.componentsCost > 0 ? `<tr><td>Components cost</td><td>${formatKes(cb.componentsCost)}</td></tr>` : ""}
                <tr><td>Total production cost</td><td><strong>${formatKes(cb.totalProductionCost)}</strong></td></tr>
                ${cb.bulkDiscountAmount > 0 ? `<tr><td>Bulk discount (${cb.bulkDiscountPercent}%)</td><td>-${formatKes(cb.bulkDiscountAmount)}</td></tr>` : ""}
                <tr><td>Profit + margin</td><td>${formatKes(cb.profitAmount)}</td></tr>
                <tr><td>${taxLabel()}</td><td>${formatKes(cb.vatAmount)}</td></tr>
                <tr><td>Selling price (ex. ${taxLabel()})</td><td>${formatKes(cb.sellingPriceExVat)}</td></tr>
                <tr><td>Selling price (incl. ${taxLabel()})</td><td><strong>${formatKes(cb.sellingPriceIncVat)}</strong></td></tr>
              </tbody>
            </table>
            ` : `<p class="help-text">No detailed cost breakdown was saved for this job (it was created before this feature was added).</p>`}
          </div>
        </div>

        <div class="job-detail-section">
          ${imagesHtml}
          ${uploadHtml}
        </div>
      </div>
    </div>

    <div class="job-detail-section">
      <h3>Product Listing</h3>
      <p class="help-text mt-8">Publish this quote to the "Products" tab of your catalogue sheet — a separate, deliberate step from the automatic Database/Sheet/Drive sync above, since not every quote should become a saleable listing.</p>
      <div class="mt-8" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button id="drawerSendToProductsBtn" class="secondary" type="button" data-index="${index}">
          ${job.productSyncedAt ? "Resend to Products" : "Send to Products"}
        </button>
        <span class="help-text" id="drawerProductSyncStatus">${job.productSyncedAt ? `Last sent ${new Date(job.productSyncedAt).toLocaleString()}` : "Not sent yet"}</span>
      </div>
    </div>
  `;
  
  document.getElementById("jobDetailsContent").innerHTML = html;
  setActiveTab("job-detail");
  STATE.currentJobDetailIndex = index;

  const jobDetailCatSelect = document.getElementById("jobDetailCategorySelect");
  if (jobDetailCatSelect) {
    const ids = resolveCategoryIdsFromNames(job.category, job.subcategory, job.subSubcategory);
    wireCategoryCascade(
      jobDetailCatSelect,
      document.getElementById("jobDetailSubcategorySelect"),
      document.getElementById("jobDetailSubSubcategorySelect"),
      { catId: ids.catId, subId: ids.subId, subSubId: ids.subSubId }
    );
  }
  const jobDetailSaveCategoryBtn = document.getElementById("jobDetailSaveCategoryBtn");
  if (jobDetailSaveCategoryBtn) {
    jobDetailSaveCategoryBtn.addEventListener("click", () => {
      const currentJob = STATE.history[index];
      if (!currentJob) return;
      const sel = resolveCategorySelection(
        document.getElementById("jobDetailCategorySelect")?.value,
        document.getElementById("jobDetailSubcategorySelect")?.value,
        document.getElementById("jobDetailSubSubcategorySelect")?.value
      );
      currentJob.category = sel.category;
      currentJob.subcategory = sel.subcategory;
      currentJob.subSubcategory = sel.subSubcategory;
      touchJob(currentJob);
      saveState();
      renderPrintHistory();
      const originalLabel = jobDetailSaveCategoryBtn.textContent;
      jobDetailSaveCategoryBtn.textContent = "Saved ✓";
      setTimeout(() => { jobDetailSaveCategoryBtn.textContent = originalLabel; }, 1200);
    });
  }

  const goToPaymentSettingsLink = document.getElementById("jobDetailGoToPaymentSettings");
  if (goToPaymentSettingsLink) {
    goToPaymentSettingsLink.addEventListener("click", (e) => {
      e.preventDefault();
      setActiveTab("settings");
      const companyNavBtn = document.querySelector('.settings-nav-btn[data-pane="pane-company"]');
      if (companyNavBtn) companyNavBtn.click();
    });
  }

  const jobDetailWhatsappBtn = document.getElementById("jobDetailWhatsappBtn");
  if (jobDetailWhatsappBtn) {
    jobDetailWhatsappBtn.addEventListener("click", () => {
      const currentJob = STATE.history[index];
      if (!currentJob) return;
      const { whatsappText } = buildQuoteDocumentsFromJob(currentJob);
      if (String(currentJob.status || "").trim().toLowerCase() === "draft") {
        currentJob.status = "quote_sent";
        touchJob(currentJob);
        saveState();
        renderPrintHistory();
        viewJobDetails(index);
      }
      const url = `https://wa.me/?text=${encodeURIComponent(whatsappText)}`;
      window.open(url, "_blank");
    });
  }

  const jobDetailEmailBtn = document.getElementById("jobDetailEmailBtn");
  if (jobDetailEmailBtn) {
    jobDetailEmailBtn.addEventListener("click", () => {
      const currentJob = STATE.history[index];
      if (!currentJob) return;
      if (String(currentJob.status || "").trim().toLowerCase() === "draft") {
        currentJob.status = "quote_sent";
        touchJob(currentJob);
        saveState();
        renderPrintHistory();
        viewJobDetails(index);
      }
      openMailto(buildQuoteEmail(currentJob, "quote").url);
    });
  }
  const jobDetailEmailInvoiceBtn = document.getElementById("jobDetailEmailInvoiceBtn");
  if (jobDetailEmailInvoiceBtn) {
    jobDetailEmailInvoiceBtn.addEventListener("click", () => {
      const currentJob = STATE.history[index];
      if (currentJob) openMailto(buildQuoteEmail(currentJob, "invoice").url);
    });
  }

  const jobDetailPdfBtn = document.getElementById("jobDetailPdfBtn");
  if (jobDetailPdfBtn) {
    jobDetailPdfBtn.addEventListener("click", () => {
      const currentJob = STATE.history[index];
      if (!currentJob) return;
      const { printHtml } = buildQuoteDocumentsFromJob(currentJob);
      document.getElementById("printInvoice").innerHTML = printHtml;
      // Print dialog first (window.print() blocks until dismissed), then
      // mark as sent — same order used by the Quote Calculator's own PDF
      // button, so printing itself never feels slow waiting on a save.
      window.print();
      if (String(currentJob.status || "").trim().toLowerCase() === "draft") {
        currentJob.status = "quote_sent";
        touchJob(currentJob);
        saveState();
        renderPrintHistory();
        viewJobDetails(index);
      }
    });
  }

  const jobDetailInvoiceBtn = document.getElementById("jobDetailInvoiceBtn");
  if (jobDetailInvoiceBtn) {
    jobDetailInvoiceBtn.addEventListener("click", () => {
      const currentJob = STATE.history[index];
      if (!currentJob) return;
      ensureJobInvoiced(currentJob);
      const { printHtml } = buildQuoteDocumentsFromJob(currentJob, "invoice");
      document.getElementById("printInvoice").innerHTML = printHtml;
      touchJob(currentJob);
      saveState();
      window.print();
      renderPrintHistory();
      viewJobDetails(index);
    });
  }

  const jobDetailSyncBtn = document.querySelector("#jobDetailsContent .job-actions-bar .sync-job");
  if (jobDetailSyncBtn) {
    jobDetailSyncBtn.addEventListener("click", async () => {
      const currentJob = STATE.history[index];
      if (!currentJob) return;
      jobDetailSyncBtn.textContent = "Syncing...";
      jobDetailSyncBtn.disabled = true;
      await syncJobEverything(currentJob);
      renderPrintHistory();
      viewJobDetails(index);
    });
  }

  // Payments can be recorded at any stage — including after a job is Completed.
  const recordJobPayment = (jobIdx, amount, method, date, note) => {
    const jobToEdit = STATE.history[jobIdx];
    if (!jobToEdit) return;
    const whole = Math.round(Number(amount) || 0);
    if (!(whole > 0)) { alert("Enter a payment amount greater than 0."); return; }
    if (!Array.isArray(jobToEdit.payments)) jobToEdit.payments = [];
    jobToEdit.payments.push({
      id: `pay-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : todayLocalIsoDate(),
      amount: whole,
      method: PAYMENT_METHODS.includes(method) ? method : "Other",
      note: String(note || "").trim(),
    });
    touchJob(jobToEdit);
    saveState();
    renderPrintHistory();
    viewJobDetails(jobIdx);
  };
  const drawerAddPaymentBtn = document.getElementById("drawerAddPaymentBtn");
  if (drawerAddPaymentBtn) {
    const jobIdx = Number(drawerAddPaymentBtn.dataset.jobIdx);
    const submitPayment = () => recordJobPayment(
      jobIdx,
      document.getElementById("drawerPayAmount").value,
      document.getElementById("drawerPayMethod").value,
      document.getElementById("drawerPayDate").value,
      document.getElementById("drawerPayNote").value,
    );
    drawerAddPaymentBtn.addEventListener("click", submitPayment);
    ["drawerPayAmount", "drawerPayNote"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitPayment(); } });
    });
  }
  const drawerPayFullBtn = document.getElementById("drawerPayFullBtn");
  if (drawerPayFullBtn) {
    drawerPayFullBtn.addEventListener("click", () => {
      const jobIdx = Number(drawerPayFullBtn.dataset.jobIdx);
      recordJobPayment(
        jobIdx,
        getJobPaymentSummary(STATE.history[jobIdx]).balance,
        document.getElementById("drawerPayMethod").value,
        document.getElementById("drawerPayDate").value,
        document.getElementById("drawerPayNote").value,
      );
    });
  }
  document.querySelectorAll(".drawer-remove-payment").forEach(btn => {
    btn.addEventListener("click", () => {
      const jobIdx = Number(btn.dataset.jobIdx);
      const jobToEdit = STATE.history[jobIdx];
      if (!jobToEdit || !Array.isArray(jobToEdit.payments)) return;
      if (!confirm("Remove this payment from the job?")) return;
      jobToEdit.payments.splice(Number(btn.dataset.payIdx), 1);
      touchJob(jobToEdit);
      saveState();
      renderPrintHistory();
      viewJobDetails(jobIdx);
    });
  });

  if (!isCompleted && job.parts) {
    const handlePartEdit = (e) => {
      const el = e.target;
      const jobIdx = Number(el.dataset.jobIdx);
      const partIdx = Number(el.dataset.partIdx);
      const jobToEdit = STATE.history[jobIdx];
      const part = jobToEdit.parts[partIdx];

      if (el.classList.contains("drawer-edit-name")) {
        part.name = el.value.trim();
      } else if (el.classList.contains("drawer-edit-weight")) {
        part.weightGrams = Number(el.value) || 0;
      } else if (el.classList.contains("drawer-edit-time")) {
        part.printTimeHours = Number(el.value) || 0;
      } else if (el.classList.contains("drawer-edit-material")) {
        part.materialCode = el.value;
      } else if (el.classList.contains("drawer-edit-color")) {
        part.colorHex = el.value;
      }

      recalculateJobPricing(jobIdx);
      renderPrintHistory();
      viewJobDetails(jobIdx);
    };

    document.querySelectorAll(".drawer-edit-name, .drawer-edit-weight, .drawer-edit-time, .drawer-edit-material, .drawer-edit-color").forEach(input => {
      input.addEventListener("change", handlePartEdit);
    });

    document.querySelectorAll(".drawer-remove-part").forEach(btn => {
      btn.addEventListener("click", () => {
        const jobIdx = Number(btn.dataset.jobIdx);
        const partIdx = Number(btn.dataset.partIdx);
        const jobToEdit = STATE.history[jobIdx];
        if (jobToEdit.parts.length <= 1) {
          alert("A job needs at least one part.");
          return;
        }
        if (!confirm("Remove this part from the job?")) return;
        jobToEdit.parts.splice(partIdx, 1);
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    });

    const addPartBtn = document.getElementById("drawerAddPartBtn");
    if (addPartBtn) {
      addPartBtn.addEventListener("click", () => {
        const jobIdx = Number(addPartBtn.dataset.jobIdx);
        const jobToEdit = STATE.history[jobIdx];
        const fallbackMat = STATE.config.materials[0];
        jobToEdit.parts.push({
          name: "",
          materialCode: fallbackMat ? fallbackMat.code : "",
          weightGrams: 50,
          printTimeHours: 1,
          colorHex: fallbackMat ? fallbackMat.colorHex : "#000000",
        });
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    }

    const recalcBtn = document.getElementById("drawerRecalcBtn");
    if (recalcBtn) {
      recalcBtn.addEventListener("click", () => {
        const jobIdx = Number(recalcBtn.dataset.jobIdx);
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
        recalcBtn.textContent = "✓ Recalculated";
        setTimeout(() => { recalcBtn.textContent = "↻ Recalculate Pricing"; }, 1500);
      });
    }

    const drawerCompCategory = document.getElementById("drawerComponentCategory");
    const drawerCompSelect = document.getElementById("drawerComponentSelect");
    if (drawerCompCategory && drawerCompSelect) {
      const refreshDrawerComponentOptions = () => {
        const items = (STATE.config.components || []).filter(c => c.category === drawerCompCategory.value);
        drawerCompSelect.innerHTML = items.length
          ? items.map(c => `<option value="${c.id}">${c.name} — ${formatKes(c.costKes)}</option>`).join("")
          : `<option value="">No components in this category</option>`;
      };
      drawerCompCategory.addEventListener("change", refreshDrawerComponentOptions);
      refreshDrawerComponentOptions();
    }

    const drawerAddComponentBtn = document.getElementById("drawerAddComponentBtn");
    if (drawerAddComponentBtn) {
      drawerAddComponentBtn.addEventListener("click", () => {
        const jobIdx = Number(drawerAddComponentBtn.dataset.jobIdx);
        const jobToEdit = STATE.history[jobIdx];
        const catSelect = document.getElementById("drawerComponentCategory");
        const compSelect = document.getElementById("drawerComponentSelect");
        if (!compSelect || !compSelect.value) { alert("Add components to this category in Settings → Components first."); return; }
        const source = (STATE.config.components || []).find(c => c.id === compSelect.value);
        if (!source) return;
        if (!Array.isArray(jobToEdit.components)) jobToEdit.components = [];
        jobToEdit.components.push({ id: source.id, name: source.name, category: catSelect.value, costKes: source.costKes });
        syncJobComponentsCost(jobToEdit);
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    }

    const drawerDesignFeeBtn = document.getElementById("drawerDesignFeeBtn");
    if (drawerDesignFeeBtn) {
      drawerDesignFeeBtn.addEventListener("click", () => {
        const jobIdx = Number(drawerDesignFeeBtn.dataset.jobIdx);
        const value = Number(document.getElementById("drawerDesignFeeInput").value);
        if (!(value >= 0)) { alert("Enter a design fee of 0 or more."); return; }
        const jobToEdit = STATE.history[jobIdx];
        jobToEdit.details = jobToEdit.details || {};
        jobToEdit.details.designFee = value;
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    }

    document.querySelectorAll(".drawer-remove-fee").forEach(btn => {
      btn.addEventListener("click", () => {
        const jobIdx = Number(btn.dataset.jobIdx);
        const jobToEdit = STATE.history[jobIdx];
        const [row] = jobToEdit.details.extraFees.splice(Number(btn.dataset.feeIdx), 1);
        if (!row) return;
        if (!Array.isArray(jobToEdit.details.removedExtraFees)) jobToEdit.details.removedExtraFees = [];
        jobToEdit.details.removedExtraFees.push({ id: row.id, label: row.label, valueType: row.valueType, value: row.value });
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    });

    document.querySelectorAll(".drawer-restore-fee").forEach(btn => {
      btn.addEventListener("click", () => {
        const jobIdx = Number(btn.dataset.jobIdx);
        const jobToEdit = STATE.history[jobIdx];
        const [row] = jobToEdit.details.removedExtraFees.splice(Number(btn.dataset.feeIdx), 1);
        if (!row) return;
        if (!Array.isArray(jobToEdit.details.extraFees)) jobToEdit.details.extraFees = [];
        jobToEdit.details.extraFees.push({ ...row, amount: 0 });
        recalculateJobPricing(jobIdx); // fills in the amount from the current price
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    });

    const drawerAddDiscountBtn = document.getElementById("drawerAddDiscountBtn");
    if (drawerAddDiscountBtn) {
      const addDrawerDiscount = () => {
        const jobIdx = Number(drawerAddDiscountBtn.dataset.jobIdx);
        const jobToEdit = STATE.history[jobIdx];
        const type = document.getElementById("drawerDiscountType").value === "fixed" ? "fixed" : "percent";
        const value = Number(document.getElementById("drawerDiscountValue").value);
        const label = document.getElementById("drawerDiscountLabel").value.trim();
        if (!(value > 0)) { alert("Enter a discount value greater than 0."); return; }
        if (type === "percent" && value > 100) { alert("A percentage discount can't be more than 100%."); return; }
        jobToEdit.details = jobToEdit.details || {};
        if (!Array.isArray(jobToEdit.details.discountItems)) jobToEdit.details.discountItems = [];
        jobToEdit.details.discountItems.push({ id: `disc-${Date.now()}-${Math.floor(Math.random() * 10000)}`, label, type, value });
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      };
      drawerAddDiscountBtn.addEventListener("click", addDrawerDiscount);
      ["drawerDiscountValue", "drawerDiscountLabel"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addDrawerDiscount(); } });
      });
    }

    document.querySelectorAll(".drawer-remove-discount").forEach(btn => {
      btn.addEventListener("click", () => {
        const jobIdx = Number(btn.dataset.jobIdx);
        const discIdx = Number(btn.dataset.discIdx);
        const jobToEdit = STATE.history[jobIdx];
        if (!confirm("Remove this discount from the job?")) return;
        jobToEdit.details.discountItems.splice(discIdx, 1);
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    });

    document.querySelectorAll(".drawer-remove-component").forEach(btn => {
      btn.addEventListener("click", () => {
        const jobIdx = Number(btn.dataset.jobIdx);
        const compIdx = Number(btn.dataset.compIdx);
        const jobToEdit = STATE.history[jobIdx];
        if (!confirm("Remove this component from the job?")) return;
        jobToEdit.components.splice(compIdx, 1);
        syncJobComponentsCost(jobToEdit);
        recalculateJobPricing(jobIdx);
        renderPrintHistory();
        viewJobDetails(jobIdx);
      });
    });
  }

  // Set up drawer image deletion
  document.querySelectorAll(".drawer-img-del-btn").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const jobIdx = Number(btn.dataset.jobIdx);
      const imgIdx = Number(btn.dataset.imgIdx);
      if (confirm("Are you sure you want to remove this image?")) {
        STATE.history[jobIdx].images.splice(imgIdx, 1);
        touchJob(STATE.history[jobIdx]);
        saveState();
        renderPrintHistory();
        viewJobDetails(jobIdx); // Re-render
      }
    };
  });

  // Set up drawer image upload
  const uploadBtn = document.getElementById("drawerUploadBtn");
  if (uploadBtn) {
    uploadBtn.onclick = async () => {
      const fileInput = document.getElementById("drawerJobImages");
      if (!fileInput || fileInput.files.length === 0) {
        alert("Please select at least one image file first.");
        return;
      }
      uploadBtn.innerHTML = "Processing...";
      uploadBtn.disabled = true;
      
      const newImages = [];
      for (let i = 0; i < fileInput.files.length; i++) {
        try {
          const base64 = await compressImage(fileInput.files[i]);
          newImages.push(base64);
        } catch (e) {
          console.error("Image compression error:", e);
        }
      }
      
      if (newImages.length > 0) {
        if (!job.images) job.images = [];
        job.images = [...job.images, ...newImages];
        touchJob(job);
        saveState();
        renderPrintHistory();
        viewJobDetails(index); // Re-render!
      } else {
        alert("Could not process selected image files.");
        uploadBtn.innerHTML = "Upload Images";
        uploadBtn.disabled = false;
      }
    };
  }

  // Set up "Send to Products"
  const sendToProductsBtn = document.getElementById("drawerSendToProductsBtn");
  if (sendToProductsBtn) {
    sendToProductsBtn.onclick = async () => {
      sendToProductsBtn.innerHTML = "Syncing files…";
      sendToProductsBtn.disabled = true;
      // Push any not-yet-synced model files/images (and create the Drive
      // job folder) FIRST — otherwise "Send to Products" would write an
      // empty/stale imageLink for a job whose photos never made it to
      // Drive yet. Cheap to call even when nothing's pending.
      await syncJobEverything(job);
      sendToProductsBtn.innerHTML = "Sending...";
      await sendJobToProducts(job, { statusElId: "drawerProductSyncStatus" });
      renderPrintHistory();
      viewJobDetails(index);
    };
  }

  // Set up part-level STL download
  document.querySelectorAll(".drawer-part-stl-dl").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      downloadStlFile(btn.dataset.dbKey, btn.dataset.fileName);
    };
  });

  // Set up part-level STL deletion
  document.querySelectorAll(".drawer-part-stl-del").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const jobIdx = Number(btn.dataset.jobIdx);
      const partIdx = Number(btn.dataset.partIdx);
      const dbKey = btn.dataset.dbKey;
      if (confirm("Are you sure you want to delete this model file?")) {
        try {
          await deleteFileFromDB(dbKey);
        } catch (err) {
          console.error("Error deleting file from IndexedDB:", err);
        }
        delete STATE.history[jobIdx].parts[partIdx].stl;
        touchJob(STATE.history[jobIdx]);
        saveState();
        renderPrintHistory();
        viewJobDetails(jobIdx); // Re-render
      }
    };
  });

  // Set up part-level STL upload inputs inside drawer
  document.querySelectorAll(".drawer-part-stl-upload-input").forEach(input => {
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const jobIdx = Number(input.dataset.jobIdx);
      const partIdx = Number(input.dataset.partIdx);
      
      const maxBytes = 500 * 1024 * 1024; // 500 MB
      if (file.size > maxBytes) {
        alert(`Warning: The model file "${file.name}" is ${ (file.size / (1024*1024)).toFixed(1) } MB, which exceeds the recommended 500 MB limit. Please optimize your model!`);
        input.value = "";
        return;
      }
      
      const uploadBtn = input.parentElement.querySelector(".drawer-part-stl-upload-btn");
      if (uploadBtn) {
        uploadBtn.innerHTML = "Uploading...";
        uploadBtn.disabled = true;
      }

      const dbKey = `stl-${Date.now()}-${Math.floor(Math.random()*1000000)}-${file.name}`;
      try {
        await saveFileInDB(dbKey, file);
        if (STATE.history[jobIdx].parts[partIdx]) {
          STATE.history[jobIdx].parts[partIdx].stl = { name: file.name, dbKey: dbKey, size: file.size };
          saveState();
          renderPrintHistory();
          viewJobDetails(jobIdx); // Re-render
        }
      } catch (err) {
        console.error("Error saving drawer Part Model in IndexedDB:", err);
        alert("Failed to upload model file.");
        if (uploadBtn) {
          uploadBtn.innerHTML = "Add Model";
          uploadBtn.disabled = false;
        }
      }
    };
  });
}

function autoSaveJobAs(status) {
  if (!STATE.lastPrintRecord) return;
  const existingIndex = STATE.history.findIndex(h => h.recordedAt === STATE.lastPrintRecord.recordedAt);
  
  if (existingIndex !== -1) {
    if (STATE.history[existingIndex].status === "draft") {
       STATE.history[existingIndex].status = status;
       saveState();
       renderPrintHistory();
    }
  } else {
    STATE.lastPrintRecord.status = status;
    STATE.lastPrintRecord.recordedAt = new Date().toISOString();
    STATE.history = [STATE.lastPrintRecord, ...STATE.history].slice(0, 100);
    saveState();
    renderPrintHistory();
  }
}

async function clearPrintHistory() {
  for (const job of STATE.history) {
    if (job && job.parts) {
      for (const part of job.parts) {
        if (part.stl && part.stl.dbKey) {
          try {
            await deleteFileFromDB(part.stl.dbKey);
          } catch (err) {
            console.error("Failed to delete Part STL on global history purge", err);
          }
        }
      }
    }
  }
  STATE.history = [];
  saveState();
  renderPrintHistory();
}

// Finds the bounding box of non-transparent pixels in a canvas so a logo
// exported on an oversized canvas (e.g. a full A4 artboard with a small
// icon in the middle) can be auto-trimmed down to just the artwork before
// it gets displayed at icon size.
function getOpaqueBoundingBox(ctx, width, height) {
  let data;
  try {
    data = ctx.getImageData(0, 0, width, height).data;
  } catch (err) {
    return null; // e.g. tainted canvas from a cross-origin source — skip trimming
  }
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const ALPHA_THRESHOLD = 8; // ignore near-fully-transparent antialiasing noise
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const alpha = data[rowStart + x * 4 + 3];
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null; // fully transparent image
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function compressImage(file, maxWidth, options) {
  const MAX_WIDTH = maxWidth || 250;
  // PNG/GIF/WebP can carry real transparency — keep it, but only where the
  // caller actually wants that (logos). JPEG has no alpha channel at all,
  // so forcing JPEG output on a transparent logo silently flattens every
  // transparent pixel to solid black (Canvas' default fill for missing
  // alpha), which is what made uploaded logos look like an ugly black
  // square. Photo uploads (printer/part photos) keep the original
  // always-JPEG behavior — they're opaque already and benefit from the
  // smaller JPEG file size.
  const wantsTransparency = !!(options && options.preserveTransparency);
  const preserveTransparency = wantsTransparency && /image\/(png|gif|webp)/i.test(file.type);
  const trimTransparentMargins = !!(options && options.trim) && preserveTransparency;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let sx = 0, sy = 0, sWidth = img.width, sHeight = img.height;

        if (trimTransparentMargins) {
          const fullCanvas = document.createElement("canvas");
          fullCanvas.width = img.width;
          fullCanvas.height = img.height;
          const fullCtx = fullCanvas.getContext("2d");
          fullCtx.drawImage(img, 0, 0);
          const bbox = getOpaqueBoundingBox(fullCtx, img.width, img.height);
          // Only trim when there's meaningfully wasted canvas around the
          // artwork (e.g. a logo exported on a huge blank artboard) — for
          // an already-tight image this is a no-op.
          if (bbox && (bbox.width < img.width * 0.98 || bbox.height < img.height * 0.98)) {
            sx = bbox.x;
            sy = bbox.y;
            sWidth = bbox.width;
            sHeight = bbox.height;
          }
        }

        const canvas = document.createElement("canvas");
        const scale = Math.min(1, MAX_WIDTH / sWidth);
        canvas.width = Math.max(1, Math.round(sWidth * scale));
        canvas.height = Math.max(1, Math.round(sHeight * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
        resolve(preserveTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Sums the 3 fixed overhead fields plus any custom overhead rows the user
// has added in Settings → Financials & Metrics (e.g. "Software Subscriptions").
function getTotalMonthlyOverheadKes(settings) {
  const fixed = (settings.monthlyRentKes || 0) + (settings.monthlyUtilitiesKes || 0) + (settings.monthlyInsuranceKes || 0);
  const custom = Array.isArray(settings.customOverheads)
    ? settings.customOverheads.reduce((sum, o) => sum + (Number(o.amountKes) || 0), 0)
    : 0;
  return fixed + custom;
}

function calculatePrintCost(job, settings, materials, printers, profitMarginPercentOverride) {
  const printer = printers.find(p => p.id === job.printerId) || printers[0];

  let totalMaterialCost = 0;
  let totalPrintTimeHrs = 0;
  
  const qty = Math.max(1, Number(job.quantity) || 1);
  const marginPercent = profitMarginPercentOverride ?? settings.profitMarginPercent;
  
  job.parts.forEach(part => {
    const mat = materials.find(m => m.code === part.materialCode);
    if (!mat) throw new Error(`Material ${part.materialCode} not found`);
    const minGrams = STATE.config?.minChargeGrams ?? 10;
    const chargedWeightGrams = Math.max(part.weightGrams, minGrams);
    totalMaterialCost += (chargedWeightGrams / 1000) * mat.costPerKgKes;
    totalPrintTimeHrs += (part.printTimeHours || 0);
  });

  if (totalPrintTimeHrs === 0 && job.printTimeHours > 0) {
    totalPrintTimeHrs = job.printTimeHours;
  }

  // Waste (purge towers, brims/rafts, unusable spool tail) and FX cushion
  // (for filament priced against an imported/USD cost upstream), both 0%
  // by default. Applied straight onto material cost so every existing
  // "Material cost" line across quotes/PDFs/WhatsApp already reflects it —
  // no separate line item needed, and nothing changes until either is set
  // above 0 in Settings → Financials & Metrics.
  const materialWasteBufferPercent = STATE.config?.materialWasteBufferPercent ?? 0;
  const materialFxBufferPercent = STATE.config?.materialFxBufferPercent ?? 0;
  totalMaterialCost = totalMaterialCost * (1 + (materialWasteBufferPercent + materialFxBufferPercent) / 100);

  const electricityCost = (printer.powerWatts / 1000) * totalPrintTimeHrs * settings.electricityRateKesKwh;
  const depreciationCost = (printer.printerPurchasePriceKes / printer.lifespanHours) * totalPrintTimeHrs;

  const hoursPerMonthPerMachine = settings.workingDaysPerMonth * settings.workingHoursPerDay;
  // Fixed costs (overhead, maintenance) are recovered against the hours
  // the printer is actually expected to be billing in a typical month, not
  // 100% of calendar capacity. Defaults to 100 (unchanged prior pricing)
  // until plannedUtilizationPercent is set lower to reflect real idle time.
  const utilizationPercent = Math.min(100, Math.max(1, settings.plannedUtilizationPercent ?? 100));
  const effectiveMonthlyHours = hoursPerMonthPerMachine * (utilizationPercent / 100);
  const maintenanceCost = (printer.maintenancePerYearKes / (effectiveMonthlyHours * 12)) * totalPrintTimeHrs;

  const labourTimeHours = totalPrintTimeHrs + (job.postProcessingTimeHoursOverride || 0);
  const laborCost = labourTimeHours * settings.laborRateKesPerHour;

  const postProcessingFeePerUnit = job.postProcessingFeeOverride || 0;
  // Bought-in, non-printed components (light fittings, cords, bulbs, LED
  // strips, threaded inserts, magnets...) — a real per-unit production
  // cost, so unlike Design Fee it's folded in here and gets marked up +
  // VAT like everything else, not just passed through flat.
  const componentsCostPerUnit = job.componentsCostOverride || 0;
  const overheadCost = (getTotalMonthlyOverheadKes(settings) / effectiveMonthlyHours) * totalPrintTimeHrs;

  const failedPrintBuffer = (totalMaterialCost + electricityCost) * ((printer.failedPrintRatePercent ?? settings.failedPrintRatePercent) / 100);
  const packagingCost = settings.packagingCostKes;

  const totalProductionCostPerUnit = totalMaterialCost + electricityCost + depreciationCost + maintenanceCost + laborCost + postProcessingFeePerUnit + componentsCostPerUnit + overheadCost + failedPrintBuffer + packagingCost;
  let sellingPriceExVatPerUnit = marginPercent >= 100 ? totalProductionCostPerUnit * 2 : totalProductionCostPerUnit / (1 - marginPercent / 100);

  // Quantity-based bulk discount — % off the ex-VAT selling price at/above
  // a configured quantity threshold (Settings → Financials & Metrics). Uses
  // whichever qualifying tier gives the largest discount, and never
  // discounts below production cost even if a tier is misconfigured, so a
  // bulk order can't accidentally be quoted at a loss.
  const tiers = Array.isArray(STATE.config?.bulkDiscountTiers) ? STATE.config.bulkDiscountTiers : [];
  let bulkDiscountPercent = 0;
  tiers.forEach(t => {
    const minQty = Number(t.minQty) || 0;
    const discountPercent = Number(t.discountPercent) || 0;
    if (qty >= minQty && discountPercent > bulkDiscountPercent) bulkDiscountPercent = discountPercent;
  });
  const preDiscountSellingPriceExVatPerUnit = sellingPriceExVatPerUnit;
  if (bulkDiscountPercent > 0) {
    sellingPriceExVatPerUnit = Math.max(sellingPriceExVatPerUnit * (1 - bulkDiscountPercent / 100), totalProductionCostPerUnit);
  }
  const bulkDiscountAmountPerUnit = preDiscountSellingPriceExVatPerUnit - sellingPriceExVatPerUnit;

  const profitAmountPerUnit = sellingPriceExVatPerUnit - totalProductionCostPerUnit;
  const vatAmountPerUnit = sellingPriceExVatPerUnit * (settings.vatRatePercent / 100);
  const sellingPriceIncVatPerUnit = sellingPriceExVatPerUnit + vatAmountPerUnit;

  return {
    materialCost: totalMaterialCost * qty,
    electricityCost: electricityCost * qty,
    depreciationCost: depreciationCost * qty,
    maintenanceCost: maintenanceCost * qty,
    laborCost: laborCost * qty,
    overheadCost: overheadCost * qty,
    failedPrintBuffer: failedPrintBuffer * qty,
    packagingCost: packagingCost * qty,
    componentsCost: componentsCostPerUnit * qty,
    bulkDiscountAmount: bulkDiscountAmountPerUnit * qty,
    bulkDiscountPercent,
    totalProductionCost: totalProductionCostPerUnit * qty,
    profitAmount: profitAmountPerUnit * qty,
    sellingPriceExVat: sellingPriceExVatPerUnit * qty,
    vatAmount: vatAmountPerUnit * qty,
    sellingPriceIncVat: sellingPriceIncVatPerUnit * qty,
    perUnitCost: totalProductionCostPerUnit,
    perUnitSellingPrice: sellingPriceIncVatPerUnit,
    quantity: qty,
    grossMarginPercent: marginPercent,
    breakEvenPrice: totalProductionCostPerUnit * qty,
  };
}

function buildColorPalette(containerId, activeHex, callback) {
  const palette = document.getElementById(containerId);
  if (!palette) return;
  
  let html = '';
  
  if (Array.isArray(STATE.config.colors)) {
    STATE.config.colors.forEach(c => {
      html += `<button type="button" class="color-swatch ${c.hex.toLowerCase() === activeHex.toLowerCase() ? 'active' : ''}" data-color="${c.hex}" style="background-color: ${c.hex};" title="${c.name}"></button>`;
    });
  }
  
  const isCustom = !STATE.config.colors.some(c => c.hex.toLowerCase() === activeHex.toLowerCase());
                   
  html += `<input type="color" class="color-swatch-custom ${isCustom ? 'active' : ''}" value="${isCustom ? activeHex : '#06B6D4'}" title="Custom color" />`;
  
  palette.innerHTML = html;
  
  palette.querySelectorAll(".color-swatch").forEach(btn => {
    btn.addEventListener("click", (e) => {
      palette.querySelectorAll(".color-swatch, .color-swatch-custom").forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      callback(e.target.dataset.color);
    });
  });

  const customInput = palette.querySelector(".color-swatch-custom");
  if (customInput) {
    customInput.addEventListener("input", (e) => {
      palette.querySelectorAll(".color-swatch, .color-swatch-custom").forEach(b => b.classList.remove("active"));
      customInput.classList.add("active");
      callback(e.target.value);
    });
  }
}

// Renders the "Color" picker for a quote part row so it only ever shows
// colors that actually have stock for the chosen material TYPE. Picking a
// swatch is what resolves the exact inventory item (material code) used
// for pricing — the Material dropdown above only picks the type.
function renderStockColorPicker(row, type, preferredCode) {
  const container = row.querySelector(".color-palette");
  const nameLabel = row.querySelector(".selected-color-name");
  const noStockMsg = row.querySelector(".no-stock-message");
  if (!container) return;

  // Show every color/brand stocked for this material type — including
  // ones currently at 0kg — so the person can see what exists rather
  // than have it silently vanish from the picker. Out-of-stock ones are
  // shown greyed-out and are not selectable; only in-stock ones can be
  // picked (or default-selected) for a quote.
  const allOfType = STATE.config.materials.filter((m) => m.type === type);
  const inStock = allOfType.filter((m) => (m.stockKg || 0) > 0);

  if (allOfType.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    row.dataset.materialCode = "";
    row.dataset.selectedHex = "";
    if (nameLabel) nameLabel.textContent = "—";
    if (noStockMsg) {
      noStockMsg.style.display = "block";
      noStockMsg.textContent = type ? `No ${type} colors set up in Inventory yet.` : "Select a material type.";
    }
    return;
  }

  if (inStock.length === 0) {
    // Colors exist for this type, they're just all out of stock right now.
    if (noStockMsg) {
      noStockMsg.style.display = "block";
      noStockMsg.textContent = `All ${type} colors are out of stock — add stock in Inventory to select one.`;
    }
    row.dataset.materialCode = "";
    row.dataset.selectedHex = "";
    if (nameLabel) nameLabel.textContent = "—";
  } else if (noStockMsg) {
    noStockMsg.style.display = "none";
  }

  container.style.display = "flex";

  const activeCode = (preferredCode && inStock.some((m) => m.code === preferredCode))
    ? preferredCode
    : (inStock[0] ? inStock[0].code : null);

  const applySelection = (code) => {
    const mat = inStock.find((m) => m.code === code);
    if (!mat) return;
    row.dataset.materialCode = mat.code;
    row.dataset.selectedHex = mat.colorHex;
    if (nameLabel) nameLabel.textContent = getColorName(mat.colorHex);
  };

  container.innerHTML = allOfType.map((m) => {
    const outOfStock = (m.stockKg || 0) <= 0;
    const label = `${getColorName(m.colorHex)}${m.brand ? ' · ' + m.brand : ''}${outOfStock ? ' — out of stock' : ''}`;
    return `<button type="button" class="color-swatch ${m.code === activeCode ? 'active' : ''} ${outOfStock ? 'out-of-stock' : ''}" data-code="${m.code}" ${outOfStock ? 'disabled' : ''} style="background-color: ${m.colorHex};" title="${label}"></button>`;
  }).join("");

  container.querySelectorAll(".color-swatch:not(.out-of-stock)").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".color-swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applySelection(btn.dataset.code);
      if (typeof scheduleLiveProfitPreview === "function") scheduleLiveProfitPreview();
    });
  });

  if (activeCode) applySelection(activeCode);
}

// Refreshes every quote-part-row's Material (type) dropdown and Color
// picker after materials/profiles change elsewhere (inventory edits,
// stock updates, profile renames, or the selected Printer changing) —
// preserving each row's current selection where it's still valid, and
// filtering the Material list to only profiles matching the selected
// printer's Technology (FDM/Resin/SLS) so a resin can't get assigned to
// an FDM job or vice versa.
function refreshQuotePartMaterialSelects() {
  const printerSelect = document.getElementById("printerSelect");
  const technology = printerSelect ? getPrinterTechnology(printerSelect.value) : null;

  document.querySelectorAll(".quote-part-row").forEach((row) => {
    const selectMat = row.querySelector(".quote-part-material");
    if (!selectMat) return;
    const prevType = selectMat.value;
    buildProfileOptions(selectMat, technology);
    if (prevType && Array.from(selectMat.options).some((o) => o.value === prevType)) {
      selectMat.value = prevType;
    }
    renderStockColorPicker(row, selectMat.value, row.dataset.materialCode);
  });
  updateMaterialSpecs();
}

// ---------------------------------------------------------------------
// Manual quote discounts (Quote tab → Discounts card)
//
// A quote can carry any number of discounts, each either a percentage or a
// fixed amount. They come off the ex-VAT quote subtotal (print price +
// design fee + extra fees). Every percentage is taken off that same
// original subtotal (they add up, they don't compound), fixed amounts are
// taken as-is, and the combined discount can never exceed the subtotal.
// VAT is then recalculated on the discounted print price — the discount is
// shared between the VAT-able print price and the flat fees in proportion,
// matching how this app only charges VAT on the print price.
// ---------------------------------------------------------------------
function discountRowLabel(row) {
  const base = row.label || "Discount";
  return row.type === "percent" ? `${base} (${Number(row.value)}%)` : base;
}

function buildDiscountNotes(belowCost, minOrderApplied) {
  const notes = [];
  if (belowCost) notes.push("These discounts take the quote below production cost.");
  if (minOrderApplied) notes.push(`The minimum order (${formatKes(STATE.config.serviceMinimumOrderKes)}) is higher than the discounted total, so the quote is charged at the minimum.`);
  return notes;
}

function calculateQuoteDiscounts(items, baseExVat) {
  const list = Array.isArray(items) ? items : [];
  const base = Math.max(0, Number(baseExVat) || 0);
  const rows = [];
  let raw = 0;
  list.forEach((item) => {
    const value = Number(item && item.value) || 0;
    if (value <= 0) return;
    const isPercent = item.type === "percent";
    const amount = isPercent ? base * (Math.min(value, 100) / 100) : value;
    raw += amount;
    rows.push({ label: item.label || "", type: isPercent ? "percent" : "fixed", value, amount });
  });
  const total = Math.min(raw, base);
  const capped = raw > base + 0.005;
  if (capped && raw > 0) {
    const factor = total / raw;
    rows.forEach((r) => { r.amount *= factor; });
  }
  return { rows, total, capped };
}

// Single source of truth for "quote total with discounts" — used by the
// live preview, the Calculate result, saved jobs and recalculation, so
// they can never disagree. With no discounts it returns exactly what the
// old formula did (selling price inc. VAT + design fee + extra fees).
function applyQuoteDiscounts(estimate, designFee, extraFeesTotal, items, vatOpts) {
  const subtotalBeforeDiscount = estimate.sellingPriceExVat + designFee + extraFeesTotal;
  const d = calculateQuoteDiscounts(items, subtotalBeforeDiscount);
  const vatMode = vatOpts && vatOpts.mode === "all" ? "all" : "print";
  let vatAmount = estimate.vatAmount;
  if (vatMode === "all") {
    // VAT on the whole quote after discounts (print price + fees).
    vatAmount = Math.max(0, subtotalBeforeDiscount - d.total) * (Math.max(0, Number(vatOpts.ratePercent) || 0) / 100);
  } else if (d.total > 0 && subtotalBeforeDiscount > 0 && estimate.sellingPriceExVat > 0) {
    const vatRate = estimate.vatAmount / estimate.sellingPriceExVat;
    const taxableShare = estimate.sellingPriceExVat / subtotalBeforeDiscount;
    vatAmount = Math.max(0, estimate.sellingPriceExVat - d.total * taxableShare) * vatRate;
  }
  return {
    subtotalBeforeDiscount,
    rows: d.rows,
    discountsTotal: d.total,
    capped: d.capped,
    vatAmount,
    vatMode,
    totalBeforeMinOrder: subtotalBeforeDiscount - d.total + vatAmount,
    belowCost: d.total > 0 && (subtotalBeforeDiscount - d.total) < (estimate.totalProductionCost || 0),
  };
}

// Current VAT rule, from Settings → Financials & Metrics.
function getVatOptions() {
  return {
    mode: STATE.config.vatAppliesTo === "all" ? "all" : "print",
    ratePercent: Number(STATE.config.printerSettings && STATE.config.printerSettings.vatRatePercent) || 0,
  };
}

// Splits `total` whole currency units across `weights` in proportion
// (largest-remainder), so the pieces always add up to `total` exactly.
function allocateWholeUnits(weights, total) {
  const n = weights.length;
  if (n === 0) return [];
  const safe = weights.map((w) => Math.max(0, Number(w) || 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  const exact = safe.map((w) => (sum > 0 ? (total * w) / sum : total / n));
  const base = exact.map((x) => Math.floor(x));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i] += 1;
  return base;
}

// What a CUSTOMER sees on the WhatsApp message / PDF quote / invoice:
//   items → subtotal → discounts → total before VAT → VAT → total
// Every figure is a whole currency unit and every line is arithmetic on the
// lines above it, so a customer with a calculator reaches the same total.
// (Item prices add up exactly to the subtotal; VAT in "all" mode is exactly
// rate × the total-before-VAT shown.) The same ladder is stored as the job's
// total, so the document and your records always agree.
function buildCustomerLadder({ partAmounts, subtotalExact, discountRows, vatMode, vatRatePercent, vatExact, totalExact, rounding }) {
  const subtotal = Math.max(0, Math.round(Number(subtotalExact) || 0));
  const items = allocateWholeUnits(partAmounts || [], subtotal);

  let remaining = subtotal;
  const discounts = [];
  (discountRows || []).forEach((r) => {
    const amount = Math.min(Math.round(Number(r.amount) || 0), remaining);
    if (amount <= 0) return;
    remaining -= amount;
    discounts.push({ ...r, amount });
  });
  const discountsTotal = subtotal - remaining;
  const totalBeforeVat = remaining;

  const mode = vatMode === "all" ? "all" : "print";
  const rate = Math.max(0, Number(vatRatePercent) || 0);
  const vat = mode === "all" ? Math.round(totalBeforeVat * rate / 100) : Math.max(0, Math.round(Number(vatExact) || 0));

  let total = totalBeforeVat + vat;
  // A minimum-order top-up lifts the (VAT-inclusive) total; show it as its own line.
  const target = Math.round(Number(totalExact) || 0);
  const adjustment = target - total > 1 ? target - total : 0;
  total += adjustment;

  // Optional tidy-up of the final figure, shown as its own "Rounding" line.
  const roundedTotal = applyRounding(total, rounding && rounding.step, rounding && rounding.mode);
  const roundingAdjustment = roundedTotal - total;
  total = roundedTotal;

  return { items, subtotal, discounts, discountsTotal, totalBeforeVat, vat, adjustment, roundingAdjustment, total, vatMode: mode, vatRatePercent: rate };
}

// ---- Payments (deposits and part-payments) --------------------------------
// A job keeps a list of payments received: { id, date, amount, method, note }.
// Amounts are whole currency units, like every figure the app shows.
const PAYMENT_METHODS = ["Bank transfer", "Card", "Cash", "PayPal", "Mobile money", "M-Pesa", "Other"];

function getJobPaymentSummary(job) {
  const total = Math.round(Number(job && job.totalAmount) || 0);
  const list = Array.isArray(job && job.payments) ? job.payments : [];
  const paid = Math.round(list.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
  const balance = total - paid;
  const status = paid <= 0 ? "unpaid" : balance > 0 ? "partial" : balance === 0 ? "paid" : "overpaid";
  return { total, paid, balance, status };
}

function getDepositAmount(total, percent) {
  const pct = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.round((Number(total) || 0) * pct / 100);
}

function todayLocalIsoDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatPaymentDate(value) {
  if (!value) return "";
  const text = String(value);
  const d = new Date(text.length === 10 ? `${text}T00:00:00` : text); // date-only → local midnight, no off-by-one-day
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(typeof getCurrencyLocale === "function" ? getCurrencyLocale() : undefined);
}

// A pill for the top of a job's page: payment status at a glance (blank for a
// draft/quote with nothing paid, so it only appears when it means something).
function buildPaymentPillHtml(job) {
  const sum = getJobPaymentSummary(job);
  const status = String((job && job.status) || "").trim().toLowerCase();
  let text = "", color = "";
  if (sum.status === "paid") { text = "Paid ✓"; color = "#16a34a"; }
  else if (sum.status === "overpaid") { text = "Overpaid"; color = "#d97706"; }
  else if (sum.status === "partial") { text = `Part-paid · ${formatKes(sum.balance)} due`; color = "#d97706"; }
  else if (status === "invoiced" || status === "completed") { text = "Unpaid"; color = "#dc2626"; }
  return text ? `<span class="status-pill" style="color:${color}; text-transform:none;">${text}</span>` : "";
}

// The little status under a job's amount in the Jobs list.
function buildPaymentBadgeHtml(job) {
  const sum = getJobPaymentSummary(job);
  const status = String((job && job.status) || "").trim().toLowerCase();
  const style = "display:block; font-size:0.72rem; font-weight:600; margin-top:2px;";
  if (sum.status === "paid") return `<span class="payment-badge" style="${style} color:#16a34a;">Paid ✓</span>`;
  if (sum.status === "overpaid") return `<span class="payment-badge" style="${style} color:#d97706;">Overpaid ${formatKes(-sum.balance)}</span>`;
  if (sum.status === "partial") return `<span class="payment-badge" style="${style} color:#d97706;">Balance ${formatKes(sum.balance)}</span>`;
  if (status === "invoiced" || status === "completed") return `<span class="payment-badge" style="${style} color:#dc2626;">Unpaid</span>`;
  return "";
}

// ---- Rounding and margin ----------------------------------------------------
// Rounds a (VAT-inclusive) total to a multiple of `step`. "nearest" rounds
// halves up; "up" always rounds in the seller's favour. step ≤ 1 = unchanged.
function applyRounding(total, step, mode) {
  const s = Number(step) || 0;
  const t = Number(total) || 0;
  if (!(s > 1)) return t;
  return mode === "up" ? Math.ceil(t / s - 1e-9) * s : Math.round(t / s) * s;
}

function getRoundingOptions() {
  return {
    step: [5, 10, 50, 100, 500].includes(Number(STATE.config.roundingStep)) ? Number(STATE.config.roundingStep) : 0,
    mode: STATE.config.roundingMode === "up" ? "up" : "nearest",
  };
}

// Profit margin on the ex-VAT price: (revenue ex VAT − cost) ÷ revenue ex VAT.
// This is the same basis as the Profit Margin in Settings, so the two compare
// directly. null when it can't be worked out (no price or no cost).
function calcMarginPercent(totalIncVat, vatAmount, productionCost) {
  const revenueExVat = (Number(totalIncVat) || 0) - (Number(vatAmount) || 0);
  const cost = Number(productionCost) || 0;
  if (!(revenueExVat > 0) || !(cost > 0)) return null;
  return ((revenueExVat - cost) / revenueExVat) * 100;
}

function isBelowTargetMargin(marginPercent, targetPercent) {
  const target = Number(targetPercent) || 0;
  return target > 0 && marginPercent != null && marginPercent < target - 0.05;
}

function buildMarginNote(marginPercent, targetPercent) {
  return `Margin ${Number(marginPercent).toFixed(1)}% is below your ${Number(targetPercent)}% target.`;
}

// ---- Email ----------------------------------------------------------------
// Opens the customer's mail app with the quote or invoice written out as
// plain text. (A mailto: link can't attach the PDF — use the PDF button and
// attach it yourself.) The recipient comes from the customer's email.
const MAILTO_MAX_LENGTH = 1900; // very long links get cut off by some desktop mail apps

function stripChatFormatting(text) {
  return String(text).replace(/\u00a0/g, " ").replace(/\*([^*\n]+)\*/g, "$1");
}

function buildQuoteEmail(job, kind) {
  const isInvoice = kind === "invoice";
  const docs = buildQuoteDocumentsFromJob(job, kind);
  const company = STATE.config.companyInfo || {};
  const customer = job && job.customerId ? getCustomerById(job.customerId) : null;
  // Only a plain single address is used — anything else (extra ?bcc=… parts, several
  // addresses, stray characters) is ignored so it can't add headers to the message.
  const rawEmail = String((customer && customer.email) || "").trim();
  const to = /^[^\s@,?&=#<>"]+@[^\s@,?&=#<>"]+\.[^\s@,?&=#<>"]+$/.test(rawEmail) ? rawEmail : "";
  const contact = String((job.details && job.details.customerContact) || (customer && customer.contactPerson) || "").trim();
  const first = contact.split(/\s+/)[0];
  const what = isInvoice ? "invoice" : "quote";
  const subject = `${company.name ? `${company.name} — ` : ""}${isInvoice ? "Invoice" : "Quote"} ${docs.docRef}${job.name ? ` (${job.name})` : ""}`;
  const compose = (message) => `${first ? `Hi ${first},` : "Hello,"}\n\nPlease find your ${what} below.\n\n${message}\n\nKind regards,\n${company.name || ""}`.trimEnd();
  const makeUrl = (body) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  let message = stripChatFormatting(docs.whatsappText);
  let body = compose(message);
  let trimmed = false;
  if (makeUrl(body).length > MAILTO_MAX_LENGTH) {
    // Shorten gracefully: the terms go first (the PDF carries them), then the contact footer.
    message = message.replace(/\nTerms & Conditions:\n[\s\S]*?\n\n/, "\n");
    body = compose(message);
    trimmed = true;
    if (makeUrl(body).length > MAILTO_MAX_LENGTH) {
      message = message.replace(/\n\n[^\n]*·[^\n]*$/, "");
      body = compose(message);
    }
  }
  return { to, subject, body, url: makeUrl(body), trimmed, docRef: docs.docRef };
}

function openMailto(url) {
  const a = document.createElement("a");
  a.href = url;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function calculateExtraFees(baseAmount, quantity, excludedIds) {
  const items = Array.isArray(STATE.config.extraFeeLineItems) ? STATE.config.extraFeeLineItems : [];
  const excluded = excludedIds instanceof Set ? excludedIds : new Set(excludedIds || []);
  let total = 0;
  const rows = [];
  const removed = []; // enabled fees the user left off this quote — kept so a saved job can restore them
  items.forEach((item) => {
    if (!item.enabled) return;
    const val = Number(item.value) || 0;
    if (excluded.has(item.id)) {
      removed.push({ id: item.id, label: item.label || "Fee", valueType: item.valueType, value: val });
      return;
    }
    const amount = item.valueType === "percentage" ? baseAmount * (val / 100) : val;
    if (amount === 0 && !item.label) return;
    total += amount;
    rows.push({
      id: item.id,
      label: item.label || "Fee",
      amount,
      valueType: item.valueType,
      value: val,
    });
  });
  return { total, rows, removed };
}

function buildMaterialOptions(selectElement) {
  if (!selectElement) return;
  const currentValue = selectElement.value;
  selectElement.innerHTML = "";

  STATE.config.materials.forEach((material) => {
    const option = document.createElement("option");
    option.value = material.code;
    option.textContent = `${getMaterialFullName(material)} — ${getCurrencyCode()} ${material.costPerKgKes}/kg`;
    selectElement.appendChild(option);
  });

  if (currentValue && Array.from(selectElement.options).some((o) => o.value === currentValue)) selectElement.value = currentValue;
}

function updateMaterialSpecs() {
  const selects = document.querySelectorAll(".quote-part-material");
  const specsDiv = document.getElementById("materialSpecs");
  if (!specsDiv) return;
  
  const profiles = new Set();
  selects.forEach(s => {
     if (s.value) profiles.add(s.value);
  });
  
  specsDiv.innerHTML = `<strong>Profiles in use:</strong> ${Array.from(profiles).join(", ") || "None"}`;
}

function buildPrinterOptions(select) {
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = "";

  // Retired/Maintenance machines drop out of the Quote-tab picker so they
  // can't accidentally be assigned to a new job — but if the select was
  // already pointed at one (editing an older job), keep that one option
  // visible too, so the existing assignment isn't silently wiped.
  STATE.config.printers
    .filter((printer) => printer.status !== "Retired" && printer.status !== "Maintenance" || printer.id === currentValue)
    .forEach((printer) => {
      const option = document.createElement("option");
      option.value = printer.id;
      const techTag = printer.technology && printer.technology !== "FDM" ? ` — ${printer.technology}` : "";
      const statusTag = printer.status && printer.status !== "Active" ? ` (${printer.status})` : "";
      option.textContent = `${printer.name}${techTag}${statusTag}`;
      select.appendChild(option);
    });

  if (currentValue && Array.from(select.options).some((o) => o.value === currentValue)) select.value = currentValue;
  refreshQuotePartMaterialSelects();
}

function getPrinterTechnology(printerId) {
  const printer = STATE.config.printers.find(p => p.id === printerId);
  return printer ? (printer.technology || "FDM") : "FDM";
}

function buildProfileOptions(select, technologyFilter) {
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = "";

  let profiles = technologyFilter
    ? STATE.config.materialProfiles.filter(p => (p.technology || "FDM") === technologyFilter)
    : STATE.config.materialProfiles;

  // No profile tagged for this technology yet — fall back to the full
  // list rather than leaving the dropdown empty and blocking the quote.
  if (technologyFilter && profiles.length === 0) profiles = STATE.config.materialProfiles;

  profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.type;
    option.textContent = profile.type;
    select.appendChild(option);
  });

  if (currentValue && Array.from(select.options).some((o) => o.value === currentValue)) select.value = currentValue;
}

function getSelectedMaterial(code) {
  return STATE.config.materials.find((m) => m.code === code) || STATE.config.materials[0];
}

function setPrintAvailability(enabled) {
  const saveBtn = document.getElementById("saveJobButton");
  const waBtn = document.getElementById("whatsappQuoteButton");
  const emailBtn = document.getElementById("emailQuoteButton");
  const pdfBtn = document.getElementById("printQuoteButton");
  if (saveBtn) saveBtn.disabled = !enabled;
  if (waBtn) waBtn.disabled = !enabled;
  if (emailBtn) emailBtn.disabled = !enabled;
  if (pdfBtn) pdfBtn.disabled = !enabled;
}

function syncFinanceInputsToConfig() {
  const vatAppliesToSelect = document.getElementById("vatAppliesTo");
  if (vatAppliesToSelect) STATE.config.vatAppliesTo = vatAppliesToSelect.value === "all" ? "all" : "print";
  const taxLabelInput = document.getElementById("taxLabel");
  if (taxLabelInput) STATE.config.taxLabel = taxLabelInput.value.trim().slice(0, 24) || "VAT";
  const roundingStepSelect = document.getElementById("roundingStep");
  if (roundingStepSelect) STATE.config.roundingStep = [5, 10, 50, 100, 500].includes(Number(roundingStepSelect.value)) ? Number(roundingStepSelect.value) : 0;
  const roundingModeSelect = document.getElementById("roundingMode");
  if (roundingModeSelect) STATE.config.roundingMode = roundingModeSelect.value === "up" ? "up" : "nearest";
  const fields = [
    "monthlyRentKes", "monthlyUtilitiesKes", "monthlyInsuranceKes", 
    "laborRateKesPerHour", "electricityRateKesKwh", "failedPrintRatePercent", 
    "packagingCostKes", "profitMarginPercent", "vatRatePercent", 
    "serviceMinimumOrderKes", "postProcessingFeePerUnit", "minChargeGrams",
    "workingDaysPerMonth", "workingHoursPerDay", "plannedUtilizationPercent",
    "materialWasteBufferPercent", "materialFxBufferPercent", "targetMarginPercent"
  ];

  fields.forEach((field) => {
    const input = document.getElementById(field);
    if (!input) return;
    const value = Number(input.value);
    
    if (field === "targetMarginPercent") {
      STATE.config.targetMarginPercent = Math.min(100, Math.max(0, isNaN(value) ? (STATE.config.targetMarginPercent || 0) : value));
      return;
    }
    if (field === "serviceMinimumOrderKes") {
      STATE.config.serviceMinimumOrderKes = Math.max(0, isNaN(value) ? STATE.config.serviceMinimumOrderKes : value);
      return;
    }
    if (field === "minChargeGrams") {
      STATE.config.minChargeGrams = Math.max(0, isNaN(value) ? STATE.config.minChargeGrams : value);
      return;
    }
    if (["materialWasteBufferPercent", "materialFxBufferPercent"].includes(field)) {
      STATE.config[field] = Math.max(0, isNaN(value) ? STATE.config[field] : value);
      return;
    }
    if (["profitMarginPercent", "vatRatePercent", "failedPrintRatePercent"].includes(field)) {
      STATE.config[field] = Math.max(0, isNaN(value) ? STATE.config[field] : value);
    }
    if (field === "plannedUtilizationPercent" && STATE.config.printerSettings) {
      const clamped = isNaN(value) ? STATE.config.printerSettings.plannedUtilizationPercent : Math.min(100, Math.max(1, value));
      STATE.config.printerSettings.plannedUtilizationPercent = clamped;
      return;
    }
    if (STATE.config.printerSettings && Object.prototype.hasOwnProperty.call(STATE.config.printerSettings, field)) {
      STATE.config.printerSettings[field] = isNaN(value) ? STATE.config.printerSettings[field] : value;
    }
  });
}

// ==========================================
// Extra Fee & Charge Line Items (Settings → Financials & Metrics)
// ==========================================

function renderFeeLineItems() {
  const wrap = document.getElementById("feeLineItemsWrap");
  if (!wrap) return;
  const items = Array.isArray(STATE.config.extraFeeLineItems) ? STATE.config.extraFeeLineItems : [];

  if (items.length === 0) {
    wrap.innerHTML = `<p class="help-text">No extra fee line items yet. Add one for things like Rush Fee, Design Time, or Packaging — each can be a flat ${getCurrencyCode()} amount or a percentage of the quote.</p>`;
    renderQuoteExtraFeesCard();
    return;
  }

  wrap.innerHTML = `
    <div class="inventory-table-wrap">
      <table>
        <thead>
          <tr>
            <th>On</th>
            <th>Label</th>
            <th>Value</th>
            <th>Type</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, i) => `
            <tr>
              <td><input type="checkbox" class="fee-item-enabled" data-idx="${i}" ${item.enabled ? "checked" : ""} title="Include in quote totals" /></td>
              <td><input type="text" class="fee-item-label" data-idx="${i}" value="${item.label || ""}" placeholder="e.g. Rush Fee" style="width: 100%;" /></td>
              <td><input type="number" class="fee-item-value" data-idx="${i}" value="${item.value}" min="0" step="0.01" style="width: 90px;" /></td>
              <td>
                <select class="fee-item-type" data-idx="${i}">
                  <option value="flat" ${item.valueType === "flat" ? "selected" : ""}>${getCurrencyCode()} (flat)</option>
                  <option value="percentage" ${item.valueType === "percentage" ? "selected" : ""}>%</option>
                </select>
              </td>
              <td><button type="button" class="icon-btn danger remove-fee-item" data-idx="${i}" title="Remove">${ICON_TRASH}</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  const updateItem = (idx, field, value) => {
    if (!STATE.config.extraFeeLineItems[idx]) return;
    STATE.config.extraFeeLineItems[idx][field] = value;
    saveState();
    renderQuoteExtraFeesCard();
  };

  wrap.querySelectorAll(".fee-item-enabled").forEach((el) => {
    el.addEventListener("change", () => updateItem(Number(el.dataset.idx), "enabled", el.checked));
  });
  wrap.querySelectorAll(".fee-item-label").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "label", el.value));
  });
  wrap.querySelectorAll(".fee-item-value").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "value", Number(el.value) || 0));
  });
  wrap.querySelectorAll(".fee-item-type").forEach((el) => {
    el.addEventListener("change", () => updateItem(Number(el.dataset.idx), "valueType", el.value));
  });
  wrap.querySelectorAll(".remove-fee-item").forEach((el) => {
    el.addEventListener("click", () => {
      STATE.config.extraFeeLineItems.splice(Number(el.dataset.idx), 1);
      saveState();
      renderFeeLineItems();
      renderQuoteExtraFeesCard();
    });
  });
}

function addFeeLineItem() {
  if (!Array.isArray(STATE.config.extraFeeLineItems)) STATE.config.extraFeeLineItems = [];
  STATE.config.extraFeeLineItems.push({
    id: `fee-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    label: "",
    value: 0,
    valueType: "flat",
    enabled: true,
  });
  saveState();
  renderFeeLineItems();
  renderQuoteExtraFeesCard();
}

// Custom Fixed Overheads — user-added rows alongside Rent/Utilities/
// Insurance, always summed in via getTotalMonthlyOverheadKes(). Always
// inline-editable (not gated behind the Edit Financials toggle), same as
// the fee line items above.
function renderCustomOverheads() {
  const wrap = document.getElementById("customOverheadsWrap");
  if (!wrap) return;
  const settings = STATE.config.printerSettings;
  const items = Array.isArray(settings.customOverheads) ? settings.customOverheads : [];

  wrap.innerHTML = `
    ${items.map((item, i) => `
      <tr>
        <td><input type="text" class="overhead-item-label" data-idx="${i}" value="${item.label || ""}" placeholder="e.g. Software Subscriptions" style="font-weight:500;" /></td>
        <td><input type="number" class="overhead-item-value" data-idx="${i}" value="${item.amountKes}" min="0" /></td>
        <td><span class="fin-type-badge fin-type-kes">${getCurrencyCode()}</span></td>
        <td><button type="button" class="icon-btn danger remove-overhead-item" data-idx="${i}" title="Remove">${ICON_TRASH}</button></td>
      </tr>
    `).join("")}
  `;

  const updateItem = (idx, field, value) => {
    if (!settings.customOverheads[idx]) return;
    settings.customOverheads[idx][field] = value;
    saveState();
  };

  wrap.querySelectorAll(".overhead-item-label").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "label", el.value));
  });
  wrap.querySelectorAll(".overhead-item-value").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "amountKes", Number(el.value) || 0));
  });
  wrap.querySelectorAll(".remove-overhead-item").forEach((el) => {
    el.addEventListener("click", () => {
      settings.customOverheads.splice(Number(el.dataset.idx), 1);
      saveState();
      renderCustomOverheads();
    });
  });
}

function addCustomOverheadItem() {
  if (!Array.isArray(STATE.config.printerSettings.customOverheads)) STATE.config.printerSettings.customOverheads = [];
  STATE.config.printerSettings.customOverheads.push({
    id: `oh-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    label: "",
    amountKes: 0,
  });
  saveState();
  renderCustomOverheads();
}

// Reference-only facility metrics the person adds themselves — label,
// numeric value, and a free-text unit (since unlike Overheads these
// aren't all the same kind of thing: could be "sq ft", "kWh", "units",
// anything). Not summed or used in any formula, same as the help text
// on the tab explains — purely for tracking.
function renderCustomFacilityMetrics() {
  const wrap = document.getElementById("customFacilityMetricsWrap");
  if (!wrap) return;
  const settings = STATE.config.printerSettings;
  const items = Array.isArray(settings.customFacilityMetrics) ? settings.customFacilityMetrics : [];

  if (items.length === 0) {
    wrap.innerHTML = `<tr><td colspan="4" class="help-text" style="padding: 8px 0;">No custom metrics yet.</td></tr>`;
  } else {
    wrap.innerHTML = items.map((item, i) => `
      <tr>
        <td><input type="text" class="facility-metric-label" data-idx="${i}" value="${escapeHtml(item.label || "")}" placeholder="e.g. Floor Space" style="font-weight:500;" /></td>
        <td><input type="number" class="facility-metric-value" data-idx="${i}" value="${item.value ?? ""}" /></td>
        <td><input type="text" class="facility-metric-unit" data-idx="${i}" value="${escapeHtml(item.unit || "")}" placeholder="e.g. sqm" style="width: 90px;" /></td>
        <td><button type="button" class="icon-btn danger remove-facility-metric" data-idx="${i}" title="Remove">${ICON_TRASH}</button></td>
      </tr>
    `).join("");
  }

  const updateItem = (idx, field, value) => {
    if (!settings.customFacilityMetrics[idx]) return;
    settings.customFacilityMetrics[idx][field] = value;
    saveState();
  };

  wrap.querySelectorAll(".facility-metric-label").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "label", el.value));
  });
  wrap.querySelectorAll(".facility-metric-value").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "value", Number(el.value) || 0));
  });
  wrap.querySelectorAll(".facility-metric-unit").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "unit", el.value));
  });
  wrap.querySelectorAll(".remove-facility-metric").forEach((el) => {
    el.addEventListener("click", () => {
      settings.customFacilityMetrics.splice(Number(el.dataset.idx), 1);
      saveState();
      renderCustomFacilityMetrics();
    });
  });
}

function addCustomFacilityMetricItem() {
  if (!Array.isArray(STATE.config.printerSettings.customFacilityMetrics)) STATE.config.printerSettings.customFacilityMetrics = [];
  STATE.config.printerSettings.customFacilityMetrics.push({
    id: `fm-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    label: "",
    value: 0,
    unit: "",
  });
  saveState();
  renderCustomFacilityMetrics();
}

// Same pattern as renderCustomFacilityMetrics/addCustomFacilityMetricItem,
// for the Pricing & Margins tab's custom reference fields.
function renderCustomPricingMetrics() {
  const wrap = document.getElementById("customPricingMetricsWrap");
  if (!wrap) return;
  const settings = STATE.config.printerSettings;
  const items = Array.isArray(settings.customPricingMetrics) ? settings.customPricingMetrics : [];

  if (items.length === 0) {
    wrap.innerHTML = `<tr><td colspan="4" class="help-text" style="padding: 8px 0;">No custom fields yet.</td></tr>`;
  } else {
    wrap.innerHTML = items.map((item, i) => `
      <tr>
        <td><input type="text" class="pricing-metric-label" data-idx="${i}" value="${escapeHtml(item.label || "")}" placeholder="e.g. Rush Order Surcharge" style="font-weight:500;" /></td>
        <td><input type="number" class="pricing-metric-value" data-idx="${i}" value="${item.value ?? ""}" /></td>
        <td><input type="text" class="pricing-metric-unit" data-idx="${i}" value="${escapeHtml(item.unit || "")}" placeholder="e.g. %" style="width: 90px;" /></td>
        <td><button type="button" class="icon-btn danger remove-pricing-metric" data-idx="${i}" title="Remove">${ICON_TRASH}</button></td>
      </tr>
    `).join("");
  }

  const updateItem = (idx, field, value) => {
    if (!settings.customPricingMetrics[idx]) return;
    settings.customPricingMetrics[idx][field] = value;
    saveState();
  };

  wrap.querySelectorAll(".pricing-metric-label").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "label", el.value));
  });
  wrap.querySelectorAll(".pricing-metric-value").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "value", Number(el.value) || 0));
  });
  wrap.querySelectorAll(".pricing-metric-unit").forEach((el) => {
    el.addEventListener("input", () => updateItem(Number(el.dataset.idx), "unit", el.value));
  });
  wrap.querySelectorAll(".remove-pricing-metric").forEach((el) => {
    el.addEventListener("click", () => {
      settings.customPricingMetrics.splice(Number(el.dataset.idx), 1);
      saveState();
      renderCustomPricingMetrics();
    });
  });
}

function addCustomPricingMetricItem() {
  if (!Array.isArray(STATE.config.printerSettings.customPricingMetrics)) STATE.config.printerSettings.customPricingMetrics = [];
  STATE.config.printerSettings.customPricingMetrics.push({
    id: `pcm-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    label: "",
    value: 0,
    unit: "",
  });
  saveState();
  renderCustomPricingMetrics();
}

// ==========================================
// Bulk Discount Tiers (Settings → Financials & Metrics)
// ==========================================

function renderBulkDiscountTiers() {
  const wrap = document.getElementById("bulkDiscountTiersWrap");
  if (!wrap) return;
  const tiers = Array.isArray(STATE.config.bulkDiscountTiers) ? STATE.config.bulkDiscountTiers : [];

  if (tiers.length === 0) {
    wrap.innerHTML = `<p class="help-text">No bulk discount tiers yet. Add one to automatically discount orders at or above a given quantity — e.g. 10+ units at 5% off. A quote never discounts below production cost, even if a tier is set too aggressively.</p>`;
    return;
  }

  wrap.innerHTML = `
    <div class="inventory-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Min Quantity</th>
            <th>Discount</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tiers.map((tier, i) => `
            <tr>
              <td><input type="number" class="tier-min-qty" data-idx="${i}" value="${tier.minQty ?? 1}" min="1" step="1" style="width: 100px;" /></td>
              <td><input type="number" class="tier-discount" data-idx="${i}" value="${tier.discountPercent ?? 0}" min="0" max="100" step="0.5" style="width: 90px;" /> %</td>
              <td><button type="button" class="icon-btn danger remove-tier" data-idx="${i}" title="Remove">${ICON_TRASH}</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  const updateTier = (idx, field, value) => {
    if (!STATE.config.bulkDiscountTiers[idx]) return;
    STATE.config.bulkDiscountTiers[idx][field] = value;
    saveState();
  };

  wrap.querySelectorAll(".tier-min-qty").forEach((el) => {
    el.addEventListener("input", () => updateTier(Number(el.dataset.idx), "minQty", Math.max(1, Number(el.value) || 1)));
  });
  wrap.querySelectorAll(".tier-discount").forEach((el) => {
    el.addEventListener("input", () => updateTier(Number(el.dataset.idx), "discountPercent", Math.min(100, Math.max(0, Number(el.value) || 0))));
  });
  wrap.querySelectorAll(".remove-tier").forEach((el) => {
    el.addEventListener("click", () => {
      STATE.config.bulkDiscountTiers.splice(Number(el.dataset.idx), 1);
      saveState();
      renderBulkDiscountTiers();
    });
  });
}

function addBulkDiscountTier() {
  if (!Array.isArray(STATE.config.bulkDiscountTiers)) STATE.config.bulkDiscountTiers = [];
  STATE.config.bulkDiscountTiers.push({
    id: `tier-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    minQty: 10,
    discountPercent: 5,
  });
  saveState();
  renderBulkDiscountTiers();
}

// ==========================================
// Company Info & Branding (Settings → Company & Branding)
// ==========================================

function setCompanyInfoInputs() {
  const info = STATE.config.companyInfo || {};
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };
  setVal("companyName", info.name);
  setVal("companyTagline", info.tagline);
  setVal("companyCurrencyCode", getCurrencyCode());
  setVal("companyAddress", info.address);
  setVal("companyPhone", info.phone);
  setVal("companyEmail", info.email);
  setVal("companyWebsite", info.website);
  setVal("companyTaxId", info.taxId);
  setVal("companyPaymentNotes", info.paymentNotes);
  setVal("companyTerms", info.termsText);
  setVal("companyQuoteValidityDays", info.quoteValidityDays ?? 7);
  setVal("companyDepositPercent", info.depositPercent ?? 0);
  setVal("companyInvoiceDueDays", STATE.config.invoiceDueDays ?? 7);
  populateCompanyCurrencySelect();
  renderCompanyLogoPreview();
  renderPaymentMethodsSettings();
}

// Renders the "Payment Methods" list in Settings → Company & Branding: one
// card per entry in companyInfo.paymentMethods, with a type selector (its
// fields swap when you change type), a "Include on quotes & WhatsApp"
// checkbox, and a remove button. Unlike the rest of Company & Branding,
// changes here save immediately (matching the Extra Fee Line Items list
// elsewhere in Settings) rather than waiting for "Save Company Info" —
// there's no natural single "value" to hold in a text input until Save.
function renderPaymentMethodsSettings() {
  const wrap = document.getElementById("companyPaymentMethodsWrap");
  if (!wrap) return;
  applyPaymentMethodRegionOrdering();
  if (!STATE.config.companyInfo) STATE.config.companyInfo = { ...DEFAULT_CONFIG.companyInfo };
  if (!Array.isArray(STATE.config.companyInfo.paymentMethods)) STATE.config.companyInfo.paymentMethods = [];
  const methods = STATE.config.companyInfo.paymentMethods;

  if (methods.length === 0) {
    wrap.innerHTML = `<p class="help-text">No payment methods added yet. Add Bank Transfer, PayPal, Stripe, Mobile Money, or any other way customers can pay you — you choose which ones appear on a given quote using the checkbox on each.</p>`;
    return;
  }

  const typeOptions = (selected) => Object.keys(PAYMENT_METHOD_TYPES).map((key) =>
    `<option value="${key}" ${key === selected ? "selected" : ""}>${PAYMENT_METHOD_TYPES[key].label}</option>`
  ).join("");

  wrap.innerHTML = methods.map((m, i) => {
    const def = PAYMENT_METHOD_TYPES[m.type] || PAYMENT_METHOD_TYPES.bank;
    const fieldDefs = typeof def.fields === "function" ? def.fields(m) : def.fields;
    const fieldsHtml = fieldDefs.map((f) => {
      if (f.type === "select") {
        const optionsHtml = f.options.map((o) =>
          `<option value="${o.value}" ${(m[f.key] || f.options[0].value) === o.value ? "selected" : ""}>${o.label}</option>`
        ).join("");
        return `
      <label style="font-size: 0.78rem;">${f.label}
        <select class="payment-method-field payment-method-select-field" data-idx="${i}" data-field="${f.key}" style="padding: 6px 8px; font-size: 0.85rem;">
          ${optionsHtml}
        </select>
      </label>
    `;
      }
      return `
      <label style="font-size: 0.78rem;">${f.label}
        <input type="text" class="payment-method-field" data-idx="${i}" data-field="${f.key}" value="${(m[f.key] || "").replace(/"/g, "&quot;")}" placeholder="${f.placeholder}" style="padding: 6px 8px; font-size: 0.85rem;" />
      </label>
    `;
    }).join("");

    return `
      <div class="payment-method-card" style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px 14px; margin-bottom: 10px; background: var(--surface);">
        <div class="flex-between" style="gap: 10px; flex-wrap: wrap;">
          <select class="payment-method-type" data-idx="${i}" style="font-weight: 600; max-width: 220px;">
            ${typeOptions(m.type)}
          </select>
          <div style="display: flex; align-items: center; gap: 14px;">
            <label style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 500; white-space: nowrap;">
              <input type="checkbox" class="payment-method-enabled" data-idx="${i}" ${m.enabled ? "checked" : ""} />
              Include on quotes & WhatsApp
            </label>
            <button type="button" class="icon-btn danger remove-payment-method" data-idx="${i}" title="Remove">${ICON_TRASH}</button>
          </div>
        </div>
        <div class="grid-2 mt-8" style="gap: 8px 12px;">
          ${fieldsHtml}
        </div>
      </div>
    `;
  }).join("");

  const updateMethod = (idx, field, value) => {
    if (!STATE.config.companyInfo.paymentMethods[idx]) return;
    STATE.config.companyInfo.paymentMethods[idx][field] = value;
    saveState();
  };

  wrap.querySelectorAll(".payment-method-type").forEach((el) => {
    el.addEventListener("change", () => {
      const idx = Number(el.dataset.idx);
      const current = STATE.config.companyInfo.paymentMethods[idx];
      // Swap in a fresh method of the new type (keeps id/enabled, clears
      // the old type's field values since they rarely carry over cleanly
      // — e.g. a Paybill Number isn't a Bank Name).
      const replacement = newPaymentMethod(el.value);
      replacement.id = current.id;
      replacement.enabled = current.enabled;
      STATE.config.companyInfo.paymentMethods[idx] = replacement;
      saveState();
      renderPaymentMethodsSettings();
    });
  });
  wrap.querySelectorAll(".payment-method-enabled").forEach((el) => {
    el.addEventListener("change", () => updateMethod(Number(el.dataset.idx), "enabled", el.checked));
  });
  wrap.querySelectorAll(".payment-method-field").forEach((el) => {
    const isSelectField = el.classList.contains("payment-method-select-field");
    el.addEventListener(isSelectField ? "change" : "input", () => {
      updateMethod(Number(el.dataset.idx), el.dataset.field, el.value);
      // Changing a select field (e.g. Mobile Money "Format") can change
      // which fields are relevant, so re-render that method's field list.
      if (isSelectField) renderPaymentMethodsSettings();
    });
  });
  wrap.querySelectorAll(".remove-payment-method").forEach((el) => {
    el.addEventListener("click", () => {
      STATE.config.companyInfo.paymentMethods.splice(Number(el.dataset.idx), 1);
      saveState();
      renderPaymentMethodsSettings();
    });
  });
}

function addPaymentMethod(type) {
  if (!STATE.config.companyInfo) STATE.config.companyInfo = { ...DEFAULT_CONFIG.companyInfo };
  if (!Array.isArray(STATE.config.companyInfo.paymentMethods)) STATE.config.companyInfo.paymentMethods = [];
  STATE.config.companyInfo.paymentMethods.push(newPaymentMethod(type));
  saveState();
  renderPaymentMethodsSettings();
}

// Builds the payment-details lines shown on both the PDF quote and the
// WhatsApp message — one line per enabled entry in company.paymentMethods,
// each formatted by its type's formatLine(). Unchecking "Include on
// quotes" for a method (without deleting it) simply drops it from here.
// Falls back to the legacy freeform `paymentDetails` text only if there
// are no payment methods at all yet (very old configs, pre-migration).
function buildPaymentLines(company) {
  if (!company) return [];
  const methods = Array.isArray(company.paymentMethods) ? company.paymentMethods : [];
  const lines = methods
    .filter((m) => m.enabled)
    .map((m) => {
      const def = PAYMENT_METHOD_TYPES[m.type];
      if (!def) return "";
      try {
        return def.formatLine(m);
      } catch (e) {
        return "";
      }
    })
    .filter(Boolean);

  if (company.paymentNotes) lines.push(company.paymentNotes);

  if (lines.length === 0 && company.paymentDetails) {
    return company.paymentDetails.split("\n").filter(Boolean);
  }
  return lines;
}

// Rebuilds the same PDF/WhatsApp quote text as renderWeightEstimate()
// (the Quote Calculator's "Calculate & Generate Quote" flow), but from an
// already-saved job in history instead of the live calculator form — so
// "Generate PDF" / "Send via WhatsApp" work from the Job Details page for
// any past job, not just the one currently open in the calculator. Uses
// the job's own snapshotted numbers (job.details.costBreakdown/partCosts/
// fees) rather than recalculating, so it always matches what's shown on
// screen even if pricing settings changed since the quote was made.
// Assigns this job its invoice number (once — re-generating the invoice
// later reuses the same number rather than incrementing again) and stamps
// invoicedAt. Advances status to "invoiced" unless the job is already
// further along (e.g. completed), so re-invoicing a completed job doesn't
// regress its status.
function ensureJobInvoiced(job) {
  if (!job.invoiceNumber) {
    const num = STATE.config.nextInvoiceNumber || 1;
    job.invoiceNumber = `INV-${String(num).padStart(4, "0")}`;
    STATE.config.nextInvoiceNumber = num + 1;
  }
  if (!job.invoicedAt) job.invoicedAt = new Date().toISOString();
  const currentStatus = String(job.status || "draft").trim().toLowerCase();
  if (["draft", "quote_sent", "printing"].includes(currentStatus)) {
    job.status = "invoiced";
    syncPrintedDate(job);
  }
}

// Escapes text for safe insertion into HTML built via template literals.
// Used on customer-supplied fields (company/customer names, notes, etc.)
// that end up in the printed quote/invoice — without this, a name like
// `Bob & Sons <Prints>` breaks the layout, and anything containing a
// `<script>`-shaped string would execute when the print view renders.
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildQuoteDocumentsFromJob(job, docType = "quote") {
  const isInvoice = docType === "invoice";
  const company = STATE.config.companyInfo || DEFAULT_CONFIG.companyInfo;
  const cb = job.details?.costBreakdown || {};
  const partCosts = job.details?.partCosts || [];
  const parts = job.parts && job.parts.length ? job.parts : [{
    name: job.name, materialCode: job.materialCode, weightGrams: job.weightGrams || 0, printTimeHours: job.printTimeHours || 0,
  }];
  const quantity = job.quantity || 1;
  const designFee = job.details?.designFee || 0;
  const extraFeesRows = job.details?.extraFees || [];
  const discountRows = (job.details?.discounts || []).filter(d => (d.amount || 0) > 0);
  const quoteRef = job.jobNumber || job.quotePreviewRef || `Q-${new Date(job.recordedAt || Date.now()).toISOString().slice(2, 10).replace(/-/g, "")}`;

  // The customer-facing figures: whole units, each line arithmetic on the
  // lines above it. See buildCustomerLadder().
  const hasBreakdown = (cb.sellingPriceExVat || 0) > 0;
  const vatMode = job.details?.vatMode === "all" ? "all" : "print";
  const ladder = buildCustomerLadder({
    partAmounts: parts.map((p, i) => (partCosts[i] ? partCosts[i].allocatedPrice : 1)),
    subtotalExact: hasBreakdown
      ? (cb.sellingPriceExVat || 0) + designFee + extraFeesRows.reduce((sum, f) => sum + (f.amount || 0), 0)
      : (job.totalAmount || 0),
    discountRows,
    vatMode,
    vatRatePercent: job.details?.vatRatePercent ?? STATE.config.printerSettings.vatRatePercent,
    vatExact: hasBreakdown ? (job.details?.vatAfterDiscount ?? (cb.vatAmount || 0)) : 0,
    // the saved total already includes any rounding, so the ladder starts from the pre-rounding figure
    totalExact: job.details?.preRoundingTotal ?? (job.totalAmount || 0),
    rounding: { step: job.details?.roundingStep || 0, mode: job.details?.roundingMode },
  });
  const totalFinal = ladder.total;
  // "VAT (16%)" only when that is literally what the number is — i.e. VAT
  // charged on the whole total-before-VAT shown. Otherwise just "VAT".
  const vatLabel = ladder.vatMode === "all" ? `${taxLabel()} (${ladder.vatRatePercent}%)` : taxLabel();
  const docRef = isInvoice ? (job.invoiceNumber || quoteRef) : quoteRef;
  const docLabel = isInvoice ? "Invoice" : "Quotation";
  const docRefLabel = isInvoice ? "Invoice No." : "Quote Ref";
  const showQuoteRefOnInvoice = isInvoice && docRef !== quoteRef;

  let dueDateText = "";
  if (isInvoice) {
    const dueDays = Number(STATE.config.invoiceDueDays);
    const dueDate = new Date(job.invoicedAt || Date.now());
    dueDate.setDate(dueDate.getDate() + (Number.isFinite(dueDays) ? dueDays : 0));
    dueDateText = dueDays > 0 ? `Due ${dueDate.toLocaleDateString(getCurrencyLocale())}` : "Due on receipt";
  }

  let itemsText = "";
  let itemRowsHtml = "";
  parts.forEach((p, i) => {
    const mat = getSelectedMaterial(p.materialCode);
    const colorName = p.colorHex ? getColorName(p.colorHex) : (mat ? getColorName(mat.colorHex) : "Unknown");
    const price = ladder.items[i] || 0;
    const materialText = `${mat.brand ? mat.brand + " " : ""}${mat.name} (${colorName})`;
    itemsText += `• ${p.name ? `${p.name} — ` : ""}${materialText}: ${formatKes(price)}\n`;
    itemRowsHtml += `
      <tr>
        <td>${p.name ? `<strong>${escapeHtml(p.name)}</strong><br>` : ""}${escapeHtml(materialText)}</td>
        <td style="text-align: right;">${formatKes(price)}</td>
      </tr>
    `;
  });

  const contactBits = [
    company.address,
    company.phone ? `Tel: ${company.phone}` : "",
    company.email,
    company.website,
    company.taxId ? `Tax ID: ${company.taxId}` : "",
  ].filter(Boolean);

  const validityDays = Number(company.quoteValidityDays);
  let validUntilText = "";
  if (validityDays > 0) {
    const validUntilDate = new Date();
    validUntilDate.setDate(validUntilDate.getDate() + validityDays);
    validUntilText = `Valid until ${validUntilDate.toLocaleDateString(getCurrencyLocale())}`;
  }

  const paymentLines = buildPaymentLines(company);
  const customerCompany = job.details?.customerCompany;
  const customerLine = customerCompany ? `Prepared for: ${customerCompany}${job.details?.customerContact ? ` — ${job.details.customerContact}` : ""}\n` : "";
  const customerBlockHtml = customerCompany ? `
    <div class="print-section" style="margin-bottom: 0;">
      <p style="margin: 0; font-size: 13px; color: #444;"><strong>Prepared for:</strong> ${escapeHtml(customerCompany)}${job.details?.customerContact ? ` — ${escapeHtml(job.details.customerContact)}` : ""}</p>
    </div>` : "";

  const hasDiscounts = ladder.discounts.length > 0;

  // Quotes: ask for a deposit if one is set up in Company & Branding.
  const depositPercent = Math.min(100, Math.max(0, Number(company.depositPercent) || 0));
  const deposit = !isInvoice && depositPercent > 0 ? getDepositAmount(ladder.total, depositPercent) : 0;
  const balanceOnCompletion = ladder.total - deposit;

  // Invoices: show what has already been paid and what is still owed.
  const payments = isInvoice ? (Array.isArray(job.payments) ? job.payments : []).filter(p => (Number(p.amount) || 0) > 0) : [];
  const hasPayments = payments.length > 0;
  const paidTotal = Math.round(payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
  const balanceDue = ladder.total - paidTotal;
  const paymentLabel = (p) => `Payment received ${formatPaymentDate(p.date)}${p.method ? ` (${p.method})` : ""}`.trim();
  const totalLabel = isInvoice && !hasPayments ? "Amount Due" : "Total";

  // Kept in step with the PDF below: same refs, date, items and totals — a
  // customer reading the message and the PDF never sees conflicting figures.
  const whatsappText = `*${company.name || "3D Print Quotation"}*${company.tagline ? ` — ${company.tagline}` : ""} 🖨️\n` +
    `${docRefLabel}: ${docRef}\n` +
    `${showQuoteRefOnInvoice ? `Quote Ref: ${quoteRef}\n` : ""}` +
    `Date: ${new Date().toLocaleDateString(getCurrencyLocale())}${isInvoice ? (dueDateText ? ` (${dueDateText})` : "") : (validUntilText ? ` (${validUntilText})` : "")}\n` +
    `${customerLine}` +
    `${quantity > 1 ? `Quantity: ${quantity} sets (prices are for all ${quantity} sets)\n` : ""}` +
    `\n*Items*\n${itemsText}Subtotal: ${formatKes(ladder.subtotal)}\n` +
    `${hasDiscounts ? `\n*Discounts*\n${ladder.discounts.map(r => `• ${discountRowLabel(r)}: -${formatKes(r.amount)}`).join("\n")}\nTotal before ${taxLabel()}: ${formatKes(ladder.totalBeforeVat)}\n` : ""}` +
    `\n${vatLabel}: ${formatKes(ladder.vat)}\n` +
    `${ladder.adjustment > 0 ? `Minimum order adjustment: +${formatKes(ladder.adjustment)}\n` : ""}` +
    `${ladder.roundingAdjustment !== 0 ? `Rounding: ${ladder.roundingAdjustment > 0 ? "+" : "-"}${formatKes(Math.abs(ladder.roundingAdjustment))}\n` : ""}` +
    `*${totalLabel}: ${formatKes(ladder.total)}*\n` +
    `${deposit > 0 ? `Deposit to start (${depositPercent}%): ${formatKes(deposit)}\nBalance on completion: ${formatKes(balanceOnCompletion)}\n` : ""}` +
    `${hasPayments ? `${payments.map(p => `• ${paymentLabel(p)}: -${formatKes(p.amount)}`).join("\n")}\n*${balanceDue > 0 ? "Balance due" : balanceDue === 0 ? "Balance due" : "Credit balance"}: ${formatKes(Math.abs(balanceDue))}*${balanceDue === 0 ? " — paid in full, thank you!" : ""}\n` : ""}` +
    `${paymentLines.length > 0 ? `\n*Payment Details:*\n${paymentLines.join("\n")}\n` : ""}` +
    `${company.termsText ? `\n*Terms & Conditions:*\n${company.termsText}\n` : ""}` +
    `\n${isInvoice ? "Thank you for your business — please settle this invoice by the due date above." : "Please let us know if you'd like to proceed!"}` +
    `${contactBits.length > 0 ? `\n\n${contactBits.join(" · ")}` : ""}`;

  const printHtml = `
    <div class="print-header-band">
      <div class="print-brand">
        ${company.logoDataUrl
          ? `<img class="print-brand-logo" src="${company.logoDataUrl}" alt="${escapeHtml(company.name || "Company")} logo" />`
          : `<div class="print-brand-logo-fallback">3D</div>`}
        <div class="print-brand-text">
          <h2>${escapeHtml(company.name) || "3D Quote Hub"}</h2>
          ${company.tagline ? `<p>${escapeHtml(company.tagline)}</p>` : ""}
        </div>
      </div>
      <div class="print-quote-badge">
        <h1 class="print-invoice-title">${docLabel}</h1>
        <p class="print-quote-ref">${escapeHtml(docRef)}</p>
        ${showQuoteRefOnInvoice ? `<p>Quote Ref: ${escapeHtml(quoteRef)}</p>` : ""}
        <p>${new Date().toLocaleDateString(getCurrencyLocale())}</p>
        ${isInvoice ? (dueDateText ? `<p class="print-quote-validity">${dueDateText}</p>` : "") : (validUntilText ? `<p class="print-quote-validity">${validUntilText}</p>` : "")}
      </div>
    </div>

    ${contactBits.length > 0 ? `
    <div class="print-contact-strip">
      ${contactBits.map(bit => `<span>${escapeHtml(bit)}</span>`).join("")}
    </div>` : ""}

    ${customerBlockHtml}

    <div class="print-section">
      <h3 class="print-section-title">Items</h3>
      ${quantity > 1 ? `<p class="print-notes-text" style="margin: 0 0 8px 0;">Quantity: ${quantity} sets — amounts below are for all ${quantity} sets.</p>` : ""}
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th style="text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemRowsHtml}
        </tbody>
      </table>
    </div>

    <div class="print-total-section">
      <div class="print-total-row">
        <span>Subtotal</span>
        <span>${formatKes(ladder.subtotal)}</span>
      </div>
      ${ladder.discounts.map(r => `<div class="print-total-row print-discount-row"><span>${escapeHtml(discountRowLabel(r))}</span><span>-${formatKes(r.amount)}</span></div>`).join("")}
      ${hasDiscounts ? `<div class="print-total-row">
        <span>Total before ${taxLabel()}</span>
        <span>${formatKes(ladder.totalBeforeVat)}</span>
      </div>` : ""}
      <div class="print-total-row">
        <span>${vatLabel}</span>
        <span>${formatKes(ladder.vat)}</span>
      </div>
      ${ladder.adjustment > 0 ? `<div class="print-total-row">
        <span>Minimum order adjustment</span>
        <span>+${formatKes(ladder.adjustment)}</span>
      </div>` : ""}
      ${ladder.roundingAdjustment !== 0 ? `<div class="print-total-row">
        <span>Rounding</span>
        <span>${ladder.roundingAdjustment > 0 ? "+" : "-"}${formatKes(Math.abs(ladder.roundingAdjustment))}</span>
      </div>` : ""}
      <div class="print-total-row grand-total">
        <span>${isInvoice && !hasPayments ? `Amount Due (${getCurrencyCode()})` : `Total (${getCurrencyCode()})`}</span>
        <span>${formatKes(ladder.total)}</span>
      </div>
      ${deposit > 0 ? `
      <div class="print-total-row"><span>Deposit to start (${depositPercent}%)</span><span>${formatKes(deposit)}</span></div>
      <div class="print-total-row"><span>Balance on completion</span><span>${formatKes(balanceOnCompletion)}</span></div>` : ""}
      ${hasPayments ? `
      ${payments.map(p => `<div class="print-total-row print-payment-row"><span>${escapeHtml(paymentLabel(p))}</span><span>-${formatKes(p.amount)}</span></div>`).join("")}
      <div class="print-total-row grand-total">
        <span>${balanceDue < 0 ? "Credit balance" : "Balance due"} (${getCurrencyCode()})${balanceDue === 0 ? " — paid in full" : ""}</span>
        <span>${formatKes(Math.abs(balanceDue))}</span>
      </div>` : ""}
    </div>

    ${isInvoice ? `
    <div class="print-section" style="margin-top: -8px;">
      <p style="margin: 0; font-size: 13px; color: #444;"><strong>Payment terms:</strong> ${dueDateText}</p>
    </div>` : ""}

    ${(() => {
      if (paymentLines.length === 0 && !company.termsText) return "";
      return `
    <div class="print-section print-notes-section">
      ${paymentLines.length > 0 ? `
      <div class="print-notes-block">
        <h3 class="print-section-title">Payment Details</h3>
        <p class="print-notes-text">${paymentLines.map(escapeHtml).join("<br>")}</p>
      </div>` : ""}
      ${company.termsText ? `
      <div class="print-notes-block">
        <h3 class="print-section-title">Terms & Conditions</h3>
        <p class="print-notes-text">${escapeHtml(company.termsText).replace(/\n/g, "<br>")}</p>
      </div>` : ""}
    </div>`;
    })()}

    <div class="print-footer">
      <p>${isInvoice ? "Thank you for your business — please settle this invoice by the due date above." : "Thank you for your business — please contact us if you have any questions about this quote."}</p>
      ${company.name ? `<p>${escapeHtml(company.name)}${company.website ? ` · ${escapeHtml(company.website)}` : ""}</p>` : ""}
    </div>
  `;

  return { printHtml, whatsappText, quoteRef, docRef };
}

function renderCompanyLogoPreview() {
  const logoDataUrl = STATE.config.companyInfo && STATE.config.companyInfo.logoDataUrl;
  const img = document.getElementById("companyLogoPreview");
  const placeholder = document.getElementById("companyLogoPlaceholder");
  if (!img || !placeholder) return;
  if (logoDataUrl) {
    img.src = logoDataUrl;
    img.style.display = "block";
    placeholder.style.display = "none";
  } else {
    img.src = "";
    img.style.display = "none";
    placeholder.style.display = "block";
  }
}

// Shared by the Add Printer and Edit Printer photo upload boxes — shows
// the photo if there is one, otherwise the dashed placeholder.
function renderPhotoUploadPreview(previewId, placeholderId, dataUrl) {
  const img = document.getElementById(previewId);
  const placeholder = document.getElementById(placeholderId);
  if (!img || !placeholder) return;
  if (dataUrl) {
    img.src = dataUrl;
    img.style.display = "block";
    placeholder.style.display = "none";
  } else {
    img.src = "";
    img.style.display = "none";
    placeholder.style.display = "flex";
  }
}

function renderNewPrinterPhotoPreview() {
  renderPhotoUploadPreview("newPrinterPhotoPreview", "newPrinterPhotoPlaceholder", pendingNewPrinterPhotoDataUrl);
}

function renderEditPrinterPhotoPreview() {
  const id = document.getElementById("editPrinterId")?.value;
  const printer = id ? STATE.config.printers.find(p => p.id === id) : null;
  renderPhotoUploadPreview("editPrinterPhotoPreview", "editPrinterPhotoPlaceholder", printer ? printer.photoDataUrl || "" : "");
}

function syncCompanyInfoInputsToConfig() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  };
  if (!STATE.config.companyInfo) STATE.config.companyInfo = { ...DEFAULT_CONFIG.companyInfo };
  STATE.config.companyInfo.name = getVal("companyName") || DEFAULT_CONFIG.companyInfo.name;
  STATE.config.companyInfo.tagline = getVal("companyTagline");
  const newCurrency = (() => {
    const select = document.getElementById("companyCurrencyCodeSelect");
    const custom = document.getElementById("companyCurrencyCodeCustom");
    if (select && select.value === "OTHER") return (custom?.value || "").trim().toUpperCase();
    return (select?.value || "").trim().toUpperCase();
  })();
  STATE.config.currencyCode = newCurrency || "USD";
  STATE.config.companyInfo.address = getVal("companyAddress");
  STATE.config.companyInfo.phone = getVal("companyPhone");
  STATE.config.companyInfo.email = getVal("companyEmail");
  STATE.config.companyInfo.website = getVal("companyWebsite");
  STATE.config.companyInfo.taxId = getVal("companyTaxId");
  STATE.config.companyInfo.paymentNotes = getVal("companyPaymentNotes");
  // Legacy single M-Pesa/Bank fields + freeform paymentDetails text are no
  // longer editable directly (superseded by the Payment Methods list,
  // which saves itself immediately via renderPaymentMethodsSettings) —
  // just preserved as-is here as a fallback for very old imported backups.
  STATE.config.companyInfo.termsText = getVal("companyTerms");
  STATE.config.companyInfo.quoteValidityDays = Math.max(0, Number(getVal("companyQuoteValidityDays")) || 0);
  STATE.config.companyInfo.depositPercent = Math.min(100, Math.max(0, Math.round(Number(getVal("companyDepositPercent")) || 0)));
  STATE.config.invoiceDueDays = Math.max(0, Number(getVal("companyInvoiceDueDays")) || 0);
}

// Refreshes the small header brand mark + eyebrow so the app's own
// top-left branding reflects the configured company (logo + name)
// wherever the app is open, not just on printed quotes.
function refreshHeaderBranding() {
  const info = STATE.config.companyInfo || {};
  const mark = document.getElementById("headerBrandMark");
  const eyebrow = document.getElementById("headerEyebrow");
  if (mark) {
    if (info.logoDataUrl) {
      mark.innerHTML = `<img src="${info.logoDataUrl}" alt="Logo" style="width: 100%; height: 100%; object-fit: contain; border-radius: inherit;" />`;
      // A real uploaded logo shouldn't sit on the orange placeholder
      // background — that's only meant for the "3D" fallback mark, and
      // otherwise shows through as an unwanted colored box around any
      // logo that isn't a perfect square/opaque fill.
      mark.style.background = "transparent";
      mark.style.boxShadow = "none";
    } else {
      mark.innerHTML = `<img src="icons/icon.png" alt="QuoteForge" style="width: 100%; height: 100%; object-fit: contain; border-radius: inherit;" />`;
      mark.style.background = "transparent";
      mark.style.boxShadow = "none";
    }
  }
  if (eyebrow) {
    eyebrow.textContent = info.name && info.name.trim() ? info.name : "Portable desktop app";
  }
}

function setFinanceInputs() {
  const mapping = {
    monthlyRentKes: STATE.config.printerSettings.monthlyRentKes,
    monthlyUtilitiesKes: STATE.config.printerSettings.monthlyUtilitiesKes,
    monthlyInsuranceKes: STATE.config.printerSettings.monthlyInsuranceKes,
    laborRateKesPerHour: STATE.config.printerSettings.laborRateKesPerHour,
    electricityRateKesKwh: STATE.config.printerSettings.electricityRateKesKwh,
    failedPrintRatePercent: STATE.config.printerSettings.failedPrintRatePercent,
    packagingCostKes: STATE.config.printerSettings.packagingCostKes,
    profitMarginPercent: STATE.config.printerSettings.profitMarginPercent,
    vatRatePercent: STATE.config.printerSettings.vatRatePercent,
    serviceMinimumOrderKes: STATE.config.serviceMinimumOrderKes,
    postProcessingFeePerUnit: STATE.config.printerSettings.postProcessingFeePerUnit,
    minChargeGrams: STATE.config.minChargeGrams ?? 10,
    workingDaysPerMonth: STATE.config.printerSettings.workingDaysPerMonth ?? 26,
    workingHoursPerDay: STATE.config.printerSettings.workingHoursPerDay ?? 8,
    plannedUtilizationPercent: STATE.config.printerSettings.plannedUtilizationPercent ?? 100,
    materialWasteBufferPercent: STATE.config.materialWasteBufferPercent ?? 0,
    materialFxBufferPercent: STATE.config.materialFxBufferPercent ?? 0,
    targetMarginPercent: STATE.config.targetMarginPercent ?? 0,
  };

  Object.entries(mapping).forEach(([key, value]) => {
    const input = document.getElementById(key);
    if (input) input.value = value;
  });
  const vatAppliesToSelect = document.getElementById("vatAppliesTo");
  if (vatAppliesToSelect) vatAppliesToSelect.value = STATE.config.vatAppliesTo === "all" ? "all" : "print";
  const taxLabelInput = document.getElementById("taxLabel");
  if (taxLabelInput) taxLabelInput.value = taxLabel();
  const roundingStepSelect = document.getElementById("roundingStep");
  if (roundingStepSelect) roundingStepSelect.value = String(STATE.config.roundingStep || 0);
  const roundingModeSelect = document.getElementById("roundingMode");
  if (roundingModeSelect) roundingModeSelect.value = STATE.config.roundingMode === "up" ? "up" : "nearest";
}

// ==========================================
// Google Sheets Sync
// ==========================================

function setIntegrationInputs() {
  const urlInput = document.getElementById("googleSheetsWebhookUrl");
  const autoInput = document.getElementById("googleSheetsAutoSync");
  const driveAutoInput = document.getElementById("driveAutoUpload");
  if (urlInput) urlInput.value = STATE.config.googleSheetsWebhookUrl || "";
  if (autoInput) autoInput.checked = !!STATE.config.googleSheetsAutoSync;
  if (driveAutoInput) driveAutoInput.checked = !!STATE.config.driveAutoUpload;
}

function saveIntegrationSettings(showAlert = true) {
  const urlInput = document.getElementById("googleSheetsWebhookUrl");
  const autoInput = document.getElementById("googleSheetsAutoSync");
  const driveAutoInput = document.getElementById("driveAutoUpload");
  STATE.config.googleSheetsWebhookUrl = urlInput ? urlInput.value.trim() : "";
  STATE.config.googleSheetsAutoSync = autoInput ? autoInput.checked : false;
  STATE.config.driveAutoUpload = driveAutoInput ? driveAutoInput.checked : false;
  saveState();
  if (showAlert) alert("Google Sheets sync settings saved.");
}

function buildQuoteRowPayload(job) {
  const totalWeight = job.parts
    ? job.parts.reduce((s, p) => s + (p.weightGrams || 0), 0)
    : (job.weightGrams || 0);

  let materialsText = "Unknown";
  if (job.parts && job.parts.length) {
    materialsText = job.parts.map(p => {
      const mat = STATE.config.materials.find(m => m.code === p.materialCode);
      const matName = mat ? mat.name : "Unknown";
      const colorName = p.colorHex ? getColorName(p.colorHex) : "";
      return colorName ? `${matName} (${colorName})` : matName;
    }).join(", ");
  } else if (job.materialName) {
    materialsText = job.materialName;
  }

  const printer = STATE.config.printers?.find(p => p.id === job.printerId);

  return {
    jobId: job.jobNumber || job.recordedAt || "",
    date: job.recordedAt ? formatJobDate(job.recordedAt) : "",
    projectName: job.name || "Untitled",
    status: job.status || "draft",
    quantity: job.quantity || 1,
    materials: materialsText,
    totalWeightGrams: Math.round(totalWeight),
    totalValueKes: Math.round(job.totalAmount || 0),
    printer: printer ? printer.name : "",
  };
}

// Turns a customer record into a row on the "Customers" tab of the same
// spreadsheet (Code.gs routes data.type === "customer" there). Upserts by
// Customer ID so repeated edits update the same row instead of duplicating.
async function sendCustomerToGoogleSheet(customer, options = {}) {
  const { silent = false, statusElId = "customerSyncStatus" } = options;
  const url = STATE.config.googleSheetsWebhookUrl;

  const setStatus = (text) => {
    const el = document.getElementById(statusElId);
    if (el) el.textContent = text;
  };

  if (!url) {
    if (!silent) alert('Add your Google Apps Script Web App URL under Settings → Google Sheets Sync first.');
    setStatus("No Web App URL configured yet.");
    return false;
  }

  setStatus("Sending…");
  try {
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        type: "customer",
        customerId: customer.id,
        company: customer.company || "",
        contactPerson: customer.contactPerson || "",
        phone: customer.phone || "",
        email: customer.email || "",
        address: customer.address || "",
        notes: customer.notes || "",
      }),
    });
    customer.sheetSyncedAt = new Date().toISOString();
    saveState();
    setStatus(`Sent ✓ at ${new Date().toLocaleTimeString()}. Check the "Customers" tab to confirm it landed.`);
    if (!silent) alert('Sent to Google Sheet. Check the "Customers" tab to confirm it landed.');
    return true;
  } catch (err) {
    console.error("Failed to send customer to Google Sheet", err);
    setStatus("Failed — check the Web App URL and your internet connection.");
    if (!silent) alert("Could not reach the Google Sheet. Check the Web App URL and your internet connection.");
    return false;
  }
}

async function sendJobToGoogleSheet(job, options = {}) {
  const { silent = false, statusElId = "sheetSyncStatus" } = options;
  const url = STATE.config.googleSheetsWebhookUrl;

  const setStatus = (text) => {
    const el = document.getElementById(statusElId);
    if (el) el.textContent = text;
  };

  if (!url) {
    if (!silent) alert('Add your Google Apps Script Web App URL under Settings → Google Sheets Sync first.');
    setStatus("No Web App URL configured yet.");
    return false;
  }

  setStatus("Sending…");
  try {
    // mode: "no-cors" with a text/plain body avoids a CORS preflight that
    // Apps Script web apps don't handle — this is the standard pattern for
    // posting browser data straight into a Sheet via Apps Script.
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(buildQuoteRowPayload(job)),
    });
    job.sheetSyncedAt = new Date().toISOString();
    saveState();
    setStatus(`Sent ✓ at ${new Date().toLocaleTimeString()}. Check the "Quotes" tab to confirm it landed.`);
    if (!silent) alert('Sent to Google Sheet. Check the "Quotes" tab to confirm it landed.');
    return true;
  } catch (err) {
    console.error("Failed to send job to Google Sheet", err);
    setStatus("Failed — check the Web App URL and your internet connection.");
    if (!silent) alert("Could not reach the Google Sheet. Check the Web App URL and your internet connection.");
    return false;
  }
}

// Turns a completed job into a row on the "Products" tab of the same
// spreadsheet (Code.gs routes data.type === "product" there). Product ID
// and SKU are left to the sheet's own formulas — Code.gs copies them down
// from the row above rather than typing into those columns.
function buildProductRowPayload(job) {
  let materialText = "";
  let colourText = "";
  if (job.parts && job.parts.length) {
    const mat = STATE.config.materials.find(m => m.code === job.parts[0].materialCode);
    materialText = mat ? mat.name : "";
    colourText = job.parts[0].colorHex ? getColorName(job.parts[0].colorHex) : "";
  } else if (job.materialName) {
    materialText = job.materialName;
  }

  return {
    type: "product",
    jobId: job.jobNumber || job.recordedAt,
    productName: job.name || "Untitled",
    category: job.category || "",
    priceKes: Math.round(job.totalAmount || 0),
    stockQuantity: job.quantity || 1,
    material: materialText,
    colour: colourText,
    notes: job.details && job.details.designFee ? `Design fee: ${formatKes(job.details.designFee)}` : "",
    imageLink: job.driveFolderUrl || "",
    status: "Draft",
    // Optional Facebook/Google Merchant feed fields — Code.gs only writes
    // these if the Products sheet actually has matching header columns.
    description: job.name ? `${job.name}${materialText ? " — " + materialText : ""}${colourText ? " (" + colourText + ")" : ""}` : "",
    condition: "new",
    availability: (job.quantity || 1) > 0 ? "in stock" : "out of stock",
    brand: (STATE.config.companyInfo && STATE.config.companyInfo.name) || "",
  };
}

async function sendJobToProducts(job, options = {}) {
  const { silent = false, statusElId = "productSyncStatus" } = options;
  const url = STATE.config.googleSheetsWebhookUrl;

  const setStatus = (text) => {
    const el = document.getElementById(statusElId);
    if (el) el.textContent = text;
  };

  if (!url) {
    if (!silent) alert('Add your Google Apps Script Web App URL under Settings → Google Sheets Sync first.');
    setStatus("No Web App URL configured yet.");
    return false;
  }
  if (!job.category) {
    if (!silent && !confirm('This job has no Category set — it will be sent to Products without one. Continue?')) {
      return false;
    }
  }

  setStatus("Sending…");
  try {
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(buildProductRowPayload(job)),
    });
    job.productSyncedAt = new Date().toISOString();
    saveState();
    setStatus(`Sent ✓ at ${new Date().toLocaleTimeString()}. Check the "Products" tab.`);
    if (!silent) alert('Sent to the "Products" tab. Open the sheet to fill in Price/Stock if needed, then flip Status to Active.');
    return true;
  } catch (err) {
    console.error("Failed to send job to Products sheet", err);
    setStatus("Failed — check the Web App URL and your internet connection.");
    if (!silent) alert("Could not reach the Google Sheet. Check the Web App URL and your internet connection.");
    return false;
  }
}

// ==========================================
// Backup / Restore now lives in the unified exportConfig()/importConfig()
// functions (used by the "Export Backup"/"Import Backup" buttons at the
// top of Settings), which include both settings and job history in one
// file. See those functions above.

// ==========================================
// Google Drive Model File Upload
// ==========================================

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result looks like "data:application/octet-stream;base64,AAAA..."
      const commaIdx = reader.result.indexOf(",");
      resolve(reader.result.slice(commaIdx + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function guessMimeType(fileName) {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const map = {
    stl: "model/stl",
    "3mf": "model/3mf",
    obj: "text/plain",
    step: "application/step",
    stp: "application/step",
  };
  return map[ext] || "application/octet-stream";
}

// Uploads every attached model file for a job to Google Drive, one request
// per file, via the same Apps Script Web App used for Sheets sync. Files
// land in a Drive folder named "<Job ID>_<Project Name>" so anyone with
// the link can grab the model and print it on another machine.
// Uploads only the model files not already sent to Drive for this job
// (tracked in job.driveSyncedFileKeys) — safe to call repeatedly (auto-sync
// on open/close, "Sync All Now") without creating duplicate Drive files or
// duplicate lines in the Sheet's "Model Files" column.
async function uploadJobFilesToDrive(job, options = {}) {
  const { statusElId = null } = options;
  const url = STATE.config.googleSheetsWebhookUrl;

  const setStatus = (text) => {
    if (statusElId) {
      const el = document.getElementById(statusElId);
      if (el) el.textContent = text;
    }
  };

  if (!url) {
    if (!options.silent) alert('Add your Google Apps Script Web App URL under Settings → Google Sheets Sync first.');
    return false;
  }

  if (!Array.isArray(job.driveSyncedFileKeys)) job.driveSyncedFileKeys = [];

  const allParts = (job.parts || []).filter(p => p.stl && p.stl.dbKey);
  const partsToSend = allParts.filter(p => !job.driveSyncedFileKeys.includes(p.stl.dbKey));
  if (!partsToSend.length) {
    if (!options.silent && !allParts.length) alert("This job has no attached model files to upload.");
    return allParts.length > 0; // already fully synced counts as success
  }

  const jobId = job.jobNumber || job.recordedAt;
  let successCount = 0;

  for (const part of partsToSend) {
    try {
      setStatus(`Uploading ${part.stl.name}…`);
      const blob = await getFileFromDB(part.stl.dbKey);
      if (!blob) continue;
      const base64Data = await blobToBase64(blob);

      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          type: "modelFile",
          jobId,
          productName: job.name || "Untitled",
          fileName: part.stl.name,
          mimeType: guessMimeType(part.stl.name),
          base64Data,
        }),
      });
      job.driveSyncedFileKeys.push(part.stl.dbKey);
      successCount += 1;
    } catch (err) {
      console.error("Failed to upload model file", part.stl && part.stl.name, err);
    }
  }

  job.driveUploadedAt = new Date().toISOString();
  touchJob(job);
  saveState();
  setStatus(`Sent ${successCount}/${partsToSend.length} new file(s) to Drive — check the folder "${jobId}_${(job.name || "Untitled")}" to confirm.`);
  return successCount > 0 || partsToSend.length === 0;
}

// Same dedupe approach as uploadJobFilesToDrive, but for job photos —
// tracked by a lightweight hash (job.driveSyncedImageHashes) since photos
// don't have a stable ID the way STL files do (dbKey).
async function uploadJobImagesToDrive(job, options = {}) {
  const { statusElId = null } = options;
  const url = STATE.config.googleSheetsWebhookUrl;

  const setStatus = (text) => {
    if (statusElId) {
      const el = document.getElementById(statusElId);
      if (el) el.textContent = text;
    }
  };

  if (!url) {
    if (!options.silent) alert('Add your Google Apps Script Web App URL under Settings → Google Sheets Sync first.');
    return false;
  }

  if (!Array.isArray(job.driveSyncedImageHashes)) job.driveSyncedImageHashes = [];

  const allImages = job.images || [];
  const pending = allImages
    .map((dataUrl, i) => ({ dataUrl, i, hash: hashString(dataUrl) }))
    .filter(entry => !job.driveSyncedImageHashes.includes(entry.hash));

  if (!pending.length) {
    if (!options.silent && !allImages.length) alert("This job has no attached images to upload.");
    return allImages.length > 0;
  }

  const jobId = job.jobNumber || job.recordedAt;
  let successCount = 0;

  for (const entry of pending) {
    const dataUrl = entry.dataUrl;
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) continue;
    const base64Data = dataUrl.slice(commaIdx + 1);
    const mimeMatch = dataUrl.slice(5, commaIdx).match(/^([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const ext = mimeType.split("/")[1] || "jpg";
    const fileName = `image_${entry.i + 1}.${ext}`;

    try {
      setStatus(`Uploading ${fileName}…`);
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          type: "image",
          jobId,
          productName: job.name || "Untitled",
          fileName,
          mimeType,
          base64Data,
        }),
      });
      job.driveSyncedImageHashes.push(entry.hash);
      successCount += 1;
    } catch (err) {
      console.error("Failed to upload image", fileName, err);
    }
  }

  job.imagesUploadedAt = new Date().toISOString();
  touchJob(job);
  saveState();
  setStatus(`Sent ${successCount}/${pending.length} new image(s) to Drive — check the folder "${jobId}_${(job.name || "Untitled")}" to confirm.`);
  return successCount > 0 || pending.length === 0;
}

// ==========================================
// Consolidated sync — one pass per job that pushes only what's new/changed
// to Sheet (Quotes tab) and Drive (files + images).
// Used by the single "Sync" control per job, the "Sync All Now" button,
// and the automatic sync on app open / before app close.
// ==========================================

function jobNeedsSync(job) {
  if (!job) return false;
  const sheetNeeded = !!STATE.config.googleSheetsWebhookUrl &&
    (!job.sheetSyncedAt || (job.modifiedAt && job.modifiedAt > job.sheetSyncedAt));
  const filesNeeded = !!STATE.config.googleSheetsWebhookUrl &&
    (job.parts || []).some(p => p.stl && p.stl.dbKey && !(job.driveSyncedFileKeys || []).includes(p.stl.dbKey));
  const imagesNeeded = !!STATE.config.googleSheetsWebhookUrl &&
    (job.images || []).some(img => !(job.driveSyncedImageHashes || []).includes(hashString(img)));
  return sheetNeeded || filesNeeded || imagesNeeded;
}

// Shared by the Jobs history table and the Job Details page's Actions bar
// so "what's synced" reads identically in both places. Returns the small
// "Sheet ✓ · Files … " status text plus a Sync/Resync button; sizeClass
// lets the Job Details page render a slightly larger version.
function buildJobSyncStatusHtml(job, index, sizeClass) {
  const needsSync = jobNeedsSync(job);
  const parts = [];
  if (STATE.config.googleSheetsWebhookUrl) {
    parts.push(job.sheetSyncedAt ? "Sheet ✓" : "Sheet …");
    const hasFiles = (job.parts || []).some(p => p.stl && p.stl.dbKey);
    const hasImages = (job.images || []).length > 0;
    if (hasFiles) parts.push((job.driveSyncedFileKeys || []).length ? "Files ✓" : "Files …");
    if (hasImages) parts.push((job.driveSyncedImageHashes || []).length ? "Images ✓" : "Images …");
  }
  const summary = parts.length ? parts.join(" · ") : "Nothing to sync — enable Google Sheets sync in Settings";
  return `
    <div class="job-sync-status ${sizeClass || ""}">
      <span class="${needsSync ? "sync-pending" : "sync-ok"}">${summary}</span>
      <button type="button" class="tertiary sync-job" data-index="${index}" style="padding:2px 6px; font-size:0.72rem;">${needsSync ? "Sync Now" : "Resync"}</button>
    </div>
  `;
}

// Runs every sync step that's actually pending for one job. Silent by
// design (no alerts) — this is meant to run unattended in the background.
async function syncJobEverything(job) {
  if (!job) return;

  // Drive uploads happen first so the Sheet row written below already
  // carries the up-to-date folder/image links.
  if (STATE.config.googleSheetsWebhookUrl) {
    const hasNewFiles = (job.parts || []).some(p => p.stl && p.stl.dbKey && !(job.driveSyncedFileKeys || []).includes(p.stl.dbKey));
    if (hasNewFiles) await uploadJobFilesToDrive(job, { silent: true });

    const hasNewImages = (job.images || []).some(img => !(job.driveSyncedImageHashes || []).includes(hashString(img)));
    if (hasNewImages) await uploadJobImagesToDrive(job, { silent: true });
  }

  if (STATE.config.googleSheetsWebhookUrl &&
      (!job.sheetSyncedAt || (job.modifiedAt && job.modifiedAt > job.sheetSyncedAt))) {
    await sendJobToGoogleSheet(job, { silent: true });
  }
}

// Syncs every job that has pending changes, showing the progress bar in
// the Jobs tab. Safe to call repeatedly — jobs with nothing pending are
// skipped in a fraction of a millisecond by jobNeedsSync.
async function syncAllJobs(reason) {
  if (STATE.syncInProgress) return;
  const pending = STATE.history.filter(jobNeedsSync);
  if (!pending.length) return;

  STATE.syncInProgress = true;
  showSyncProgress(0, pending.length, pending[0].name);

  for (let i = 0; i < pending.length; i++) {
    const job = pending[i];
    showSyncProgress(i, pending.length, job.name);
    try {
      await syncJobEverything(job);
    } catch (err) {
      console.error("Sync failed for job", job.name, err);
    }
    showSyncProgress(i + 1, pending.length, job.name);
  }

  renderPrintHistory();
  hideSyncProgress();
  STATE.syncInProgress = false;
}

function showSyncProgress(done, total, currentJobName) {
  const bar = document.getElementById("syncAllProgressTrack");
  const fill = document.getElementById("syncAllProgressFill");
  const label = document.getElementById("syncAllStatusLabel");
  if (bar) bar.classList.remove("hidden");
  if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  if (label) {
    label.textContent = done >= total
      ? `Synced ${total}/${total} job(s).`
      : `Syncing ${done + 1}/${total} — "${currentJobName || "job"}"…`;
  }
}

function hideSyncProgress() {
  const bar = document.getElementById("syncAllProgressTrack");
  const label = document.getElementById("syncAllStatusLabel");
  setTimeout(() => {
    if (bar) bar.classList.add("hidden");
    if (label) label.textContent = "Auto-syncs when the app opens and when you quit.";
  }, 1200);
}

function renderResult(html) {
  const resultArea = document.getElementById("resultArea");
  if (!resultArea) return;
  resultArea.innerHTML = html;
  setPrintAvailability(true);
}

function buildBreakdownTable(rows) {
  return `
    <div class="breakdown">
      <table>
        <thead><tr><th>Item</th><th>Amount</th></tr></thead>
        <tbody>
          ${rows.map(row => `<tr><td>${row.label}</td><td>${formatKes(row.amount)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildSummary(title, value, subtitle) {
  return `
    <div class="result-summary">
      <h3>${title}</h3>
      <p class="summary-value">${formatKes(value)}</p>
      <p>${subtitle}</p>
    </div>
  `;
}

// Shown after parsing a multi-part file — lets the person review what
// was detected (and edit name/weight/time) before anything is actually
// added as a part row. Nothing is added silently; this is a checkpoint,
// not an automatic import.
function showMultiPartImportReview(parts, sourceFileName) {
  const existing = document.getElementById("multiPartReviewOverlay");
  if (existing) existing.remove();

  const density = STATE.config.defaultMaterialDensity || 1.24;

  const overlay = document.createElement("div");
  overlay.className = "setup-wizard-overlay";
  overlay.id = "multiPartReviewOverlay";

  const rowsHtml = parts.map((p, i) => {
    const estWeightG = p.volumeCm3 != null ? Math.round(p.volumeCm3 * density) : null;
    const weightG = p.slicerWeightG != null ? Math.round(p.slicerWeightG) : estWeightG;
    const timeHrs = p.slicerTimeHours != null ? Number(p.slicerTimeHours.toFixed(1)) : null;
    const weightSource = p.slicerWeightG != null ? "from file's own slicer data" : `estimated from geometry @ ${density} g/cm³`;
    return `
      <tr data-idx="${i}">
        <td style="width:30px;"><input type="checkbox" class="mpi-include" checked /></td>
        <td><input type="text" class="mpi-name" value="${escapeHtml(p.name)}" style="width:100%;" /></td>
        <td>
          <input type="number" class="mpi-weight" value="${weightG ?? ""}" min="0" style="width:90px;" />
          <div class="help-text" style="font-size:0.72rem;">${weightG != null ? weightSource : "couldn't estimate — enter manually"}</div>
        </td>
        <td>
          <input type="number" class="mpi-time" value="${timeHrs ?? ""}" min="0" step="0.1" style="width:80px;" />
          <div class="help-text" style="font-size:0.72rem;">${timeHrs != null ? "from file's own slicer data" : "not in file — enter manually"}</div>
        </td>
      </tr>
    `;
  }).join("");

  overlay.innerHTML = `
    <div class="setup-wizard-panel" style="max-width:680px;">
      <h2>Found ${parts.length} part${parts.length === 1 ? "" : "s"} in "${escapeHtml(sourceFileName)}"</h2>
      <p class="setup-sub">Review names, weights, and times before adding these as quote parts. Uncheck anything you don't want. You'll still pick each part's material afterward.</p>
      <div style="max-height:340px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; margin-bottom:16px;">
        <table style="width:100%; border-collapse:collapse;">
          <thead style="position:sticky; top:0; background:var(--surface); z-index:1;">
            <tr style="font-size:0.75rem; text-align:left; color:var(--text-secondary);">
              <th style="padding:8px;"></th>
              <th style="padding:8px;">Part Name</th>
              <th style="padding:8px;">Weight (g)</th>
              <th style="padding:8px;">Time (hrs)</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="setup-actions">
        <button type="button" class="secondary" id="mpiCancelBtn">Cancel</button>
        <button type="button" class="primary" id="mpiConfirmBtn">Add Selected Parts</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById("mpiCancelBtn").addEventListener("click", () => overlay.remove());

  document.getElementById("mpiConfirmBtn").addEventListener("click", () => {
    const rows = overlay.querySelectorAll("tbody tr");
    let addedCount = 0;
    rows.forEach((row) => {
      const include = row.querySelector(".mpi-include").checked;
      if (!include) return;
      const name = row.querySelector(".mpi-name").value.trim();
      const weight = parseFloat(row.querySelector(".mpi-weight").value) || 0;
      const time = parseFloat(row.querySelector(".mpi-time").value) || 0;

      addQuotePartRow();
      const container = document.getElementById("quotePartsContainer");
      const newRow = container.lastElementChild;
      if (newRow) {
        const nameEl = newRow.querySelector(".quote-part-name");
        const weightEl = newRow.querySelector(".quote-part-weight");
        const timeEl = newRow.querySelector(".quote-part-time");
        if (nameEl) nameEl.value = name;
        if (weightEl && weight > 0) weightEl.value = weight;
        if (timeEl && time > 0) timeEl.value = time;
      }
      addedCount++;
    });
    overlay.remove();
    if (typeof scheduleLiveProfitPreview === "function") scheduleLiveProfitPreview();
  });
}

function addQuotePartRow() {
  const container = document.getElementById("quotePartsContainer");
  
  const rowId = `row-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const row = document.createElement("div");
  row.className = "quote-part-row mb-16";
  row.style = "padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-hover);";
  row.dataset.selectedHex = "#000000";

  row.innerHTML = `
    <!-- Top header: Part heading + Trash button -->
    <div class="flex-between mb-12" style="border-bottom: 1px solid var(--border); padding-bottom: 8px;">
      <span style="font-weight: 700; font-size: 0.85rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.05em;">Part Specification</span>
      <button type="button" class="icon-btn danger remove-part-row" style="width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; padding: 0;">
        ${ICON_TRASH}
      </button>
    </div>
    
    <!-- Row 1: Part Name | Material -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
      <label>
        Part Name
        <input type="text" class="quote-part-name full-width mt-4" placeholder="e.g. Base" value="" />
      </label>
      <label>
        Material
        <select class="quote-part-material full-width mt-4"></select>
      </label>
    </div>
    
    <!-- Row 2: Weight (g) | Time (hrs) -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
      <label>
        Weight (g)
        <input type="number" class="quote-part-weight full-width mt-4" min="0" value="50" />
      </label>
      <label>
        Time (hrs)
        <input type="number" class="quote-part-time full-width mt-4" min="0" step="0.1" value="4" />
      </label>
    </div>
    
    <!-- Row 3: Color Selection | Attach 3D Model -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: flex-end;">
      <div>
        <span style="font-size: 0.85rem; color: var(--text-secondary);">Color: <strong class="selected-color-name" style="color: var(--accent);">—</strong></span>
        <div class="color-palette compact-palette" id="palette-${rowId}"></div>
        <p class="no-stock-message help-text" style="display: none; font-size: 0.78rem; color: var(--text-secondary); margin-top: 4px;"></p>
      </div>
      <div>
        <label>Attach 3D Model</label>
        <input type="file" class="quote-part-stl" accept=".stl,.obj,.3mf,.stp,.step,.iges,.igs,.fbx,.dae,.ply,.gcode,.glb,.gltf" style="display: none;" id="stl-input-${rowId}" />
        <button type="button" class="nav-btn stl-upload-trigger mt-4" style="height: 42px; padding: 0 10px; display: flex; align-items: center; gap: 6px; width: 100%; justify-content: center; font-size: 0.8rem; background: var(--surface-primary); border: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <span style="font-size: 1rem;">📦</span> <span class="stl-btn-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;">Add Model</span>
        </button>
      </div>
    </div>
  `;

  container.appendChild(row);
  
  // Material dropdown is type-only (PLA, PETG, ABS...); the actual
  // inventory item (and therefore price/stock) is resolved by which
  // in-stock color the person picks below it.
  const selectMat = row.querySelector(".quote-part-material");
  buildProfileOptions(selectMat, getPrinterTechnology(document.getElementById("printerSelect")?.value));

  renderStockColorPicker(row, selectMat.value, null);

  selectMat.addEventListener("change", () => {
    renderStockColorPicker(row, selectMat.value, null);
    updateMaterialSpecs();
  });

  const stlInput = row.querySelector(".quote-part-stl");
  const stlTrigger = row.querySelector(".stl-upload-trigger");
  stlTrigger.onclick = () => stlInput.click();
  
  stlInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const maxBytes = 500 * 1024 * 1024; // 500 MB
      if (file.size > maxBytes) {
        alert(`Warning: The model file "${file.name}" is ${ (file.size / (1024*1024)).toFixed(1) } MB, which exceeds the recommended 500 MB limit. Please optimize your model!`);
        stlInput.value = "";
        stlTrigger.querySelector(".stl-btn-text").textContent = "Add Model";
        stlTrigger.style.borderColor = "var(--border)";
        stlTrigger.style.background = "var(--surface-primary)";
        stlTrigger.style.color = "var(--text-primary)";
        return;
      }
      stlTrigger.querySelector(".stl-btn-text").textContent = file.name;
      stlTrigger.style.fontWeight = "600";
      stlTrigger.style.color = "var(--accent)";
      stlTrigger.style.borderColor = "var(--accent)";
      stlTrigger.style.background = "var(--accent-soft)";
    } else {
      stlTrigger.querySelector(".stl-btn-text").textContent = "Add Model";
      stlTrigger.style.borderColor = "var(--border)";
      stlTrigger.style.background = "var(--surface-primary)";
      stlTrigger.style.color = "var(--text-primary)";
    }
  };

  row.querySelector(".remove-part-row").onclick = () => {
    if (container.querySelectorAll(".quote-part-row").length > 1) {
      row.remove();
      updateMaterialSpecs();
      if (typeof scheduleLiveProfitPreview === "function") scheduleLiveProfitPreview();
    } else {
      alert("You must have at least one part for the project.");
    }
  };

  updateMaterialSpecs();
  if (typeof scheduleLiveProfitPreview === "function") scheduleLiveProfitPreview();
}

// Lightweight live preview of cost vs. price vs. profit, updated on every
// keystroke/change in the Quote form (debounced) — unlike the full
// "Calculate Quote" breakdown, this never needs a click. Reuses the same
// calculatePrintCost() math as renderWeightEstimate() so the number here
// always matches what "Calculate Quote" will show; it just shows it sooner.
function renderLiveProfitPreview() {
  liveDiscountPreview = null;
  renderLiveProfitPreviewCore();
  updateQuoteDiscountsTotalDisplay(liveDiscountPreview);
}

function renderLiveProfitPreviewCore() {
  const wrap = document.getElementById("liveProfitPreview");
  if (!wrap) return;

  const printerId = document.getElementById("printerSelect")?.value;
  const rows = Array.from(document.querySelectorAll(".quote-part-row"));
  if (!printerId || rows.length === 0) {
    wrap.style.display = "none";
    return;
  }

  let totalWeightG = 0;
  let totalPrintTimeHrs = 0;
  const parts = [];
  let hasUsableRow = false;
  rows.forEach((row) => {
    const matCode = row.dataset.materialCode || "";
    const wght = Number(row.querySelector(".quote-part-weight")?.value) || 0;
    const time = Number(row.querySelector(".quote-part-time")?.value) || 0;
    const hex = row.dataset.selectedHex || "#000000";
    if (matCode && (wght > 0 || time > 0)) hasUsableRow = true;
    parts.push({ name: "", materialCode: matCode, weightGrams: wght, colorHex: hex, printTimeHours: time });
    totalWeightG += wght;
    totalPrintTimeHrs += time;
  });

  if (!hasUsableRow) {
    wrap.style.display = "none";
    return;
  }

  const quantity = Math.max(1, Number(document.getElementById("quantityWeight")?.value) || 1);
  const designFee = Number(document.getElementById("designFeeWeight")?.value) || 0;
  const componentsCost = typeof getQuoteComponentsTotal === "function" ? getQuoteComponentsTotal() : 0;
  const postProcessingEnabled = document.getElementById("postProcessingToggle")?.value === "true";
  const postProcessTime = postProcessingEnabled ? (Number(document.getElementById("postProcessTime")?.value) || 0) : 0;
  const postProcessFee = postProcessingEnabled ? (Number(document.getElementById("postProcessFee")?.value) || 0) : 0;

  const job = {
    name: "", printerId, parts, printTimeHours: totalPrintTimeHrs, quantity,
    postProcessingTimeHoursOverride: postProcessTime,
    postProcessingFeeOverride: postProcessFee,
    componentsCostOverride: componentsCost,
    components: typeof currentQuoteComponents !== "undefined" ? [...currentQuoteComponents] : [],
  };

  let estimate;
  try {
    estimate = calculatePrintCost(job, STATE.config.printerSettings, STATE.config.materials, STATE.config.printers);
  } catch (e) {
    wrap.style.display = "none";
    return;
  }
  if (!estimate) {
    wrap.style.display = "none";
    return;
  }

  const extraFees = typeof calculateExtraFees === "function" ? calculateExtraFees(estimate.sellingPriceExVat, quantity, currentQuoteExcludedFeeIds) : { total: 0 };
  const adj = applyQuoteDiscounts(estimate, designFee, extraFees.total || 0, currentQuoteDiscounts, getVatOptions());
  liveDiscountPreview = adj;
  const totalWithDesign = adj.totalBeforeMinOrder;
  const roundingOpts = getRoundingOptions();
  const totalFinal = applyRounding(typeof applyMinOrder === "function" ? applyMinOrder(totalWithDesign) : totalWithDesign, roundingOpts.step, roundingOpts.mode);
  adj.minOrderApplied = adj.discountsTotal > 0 && totalFinal > totalWithDesign + 0.005;

  const cost = estimate.totalProductionCost || 0;
  const profit = totalFinal - cost - (adj.vatAmount || 0);
  // Margin on the ex-VAT price (same basis as the Profit Margin setting).
  const revenueExVat = totalFinal - (adj.vatAmount || 0);
  const marginPercent = revenueExVat > 0 ? (profit / revenueExVat) * 100 : 0;
  const isPositive = profit >= 0;
  const targetMargin = Number(STATE.config.targetMarginPercent) || 0;
  const belowTarget = isBelowTargetMargin(calcMarginPercent(totalFinal, adj.vatAmount, cost), targetMargin);

  wrap.style.display = "flex";
  wrap.innerHTML = `
    <div class="lpp-item">
      <span class="lpp-label">Cost</span>
      <span class="lpp-value">${formatKes(cost)}</span>
    </div>
    <div class="lpp-item">
      <span class="lpp-label">Price</span>
      <span class="lpp-value">${formatKes(totalFinal)}</span>
    </div>
    <div class="lpp-item">
      <span class="lpp-label">${isPositive ? "Profit" : "Loss"}</span>
      <span class="lpp-value ${isPositive ? "profit-positive" : "profit-negative"}">${formatKes(Math.abs(profit))}</span>
    </div>
    <div class="lpp-item">
      <span class="lpp-label">Margin</span>
      <span class="lpp-value ${isPositive ? "profit-positive" : "profit-negative"}">${marginPercent.toFixed(1)}%</span>
    </div>
    ${belowTarget ? `<div class="lpp-warning" style="flex-basis:100%; color:#dc2626; font-size:0.8rem; font-weight:600;">⚠ ${buildMarginNote(marginPercent, targetMargin)}</div>` : ""}
  `;
  wrap.style.flexWrap = "wrap";
}

// Debounced so fast typing doesn't recompute on every keystroke.
let liveProfitPreviewTimer = null;
function scheduleLiveProfitPreview() {
  if (liveProfitPreviewTimer) clearTimeout(liveProfitPreviewTimer);
  liveProfitPreviewTimer = setTimeout(renderLiveProfitPreview, 250);
}

function renderWeightEstimate() {
  const printerId = document.getElementById("printerSelect").value;
  
  const parts = [];
  let totalWeightG = 0;
  let totalPrintTimeHrs = 0;
  
  const projectName = document.getElementById("projectName").value.trim() || "Project";
  const categorySelection = resolveCategorySelection(
    document.getElementById("categorySelect")?.value,
    document.getElementById("subcategorySelect")?.value,
    document.getElementById("subSubcategorySelect")?.value
  );
  const category = categorySelection.category;
  const customerSelectEl = document.getElementById("quoteCustomer");
  const customerId = customerSelectEl ? customerSelectEl.value : "";
  const customer = customerId ? getCustomerById(customerId) : null;

  let missingStockType = null;
  document.querySelectorAll(".quote-part-row").forEach(row => {
    const pName = row.querySelector(".quote-part-name").value.trim();
    const matType = row.querySelector(".quote-part-material").value;
    const matCode = row.dataset.materialCode || "";
    const wght = Number(row.querySelector(".quote-part-weight").value) || 0;
    const time = Number(row.querySelector(".quote-part-time").value) || 0;
    const hex = row.dataset.selectedHex || "#000000";
    if (!matCode && !missingStockType) missingStockType = matType || "the selected material";
    parts.push({ name: pName, materialCode: matCode, weightGrams: wght, colorHex: hex, printTimeHours: time });
    totalWeightG += wght;
    totalPrintTimeHrs += time;
  });

  if (parts.length === 0) {
    alert("Please add at least one part.");
    return;
  }

  if (missingStockType) {
    alert(`No colors are in stock for ${missingStockType}. Add stock in Inventory, or choose a different material type.`);
    return;
  }

  const quantity = Math.max(1, Number(document.getElementById("quantityWeight").value) || 1);
  const designFee = Number(document.getElementById("designFeeWeight").value) || 0;
  const componentsCost = getQuoteComponentsTotal();
    
  const postProcessingEnabled = document.getElementById("postProcessingToggle").value === "true";
  const postProcessTime = postProcessingEnabled ? (Number(document.getElementById("postProcessTime").value) || 0) : 0;
  const postProcessFee = postProcessingEnabled ? (Number(document.getElementById("postProcessFee").value) || 0) : 0;

  syncFinanceInputsToConfig();

  const job = {
    name: projectName,
    printerId: printerId,
    parts: parts,
    printTimeHours: totalPrintTimeHrs,
    quantity,
    postProcessingTimeHoursOverride: postProcessTime,
    postProcessingFeeOverride: postProcessFee,
    componentsCostOverride: componentsCost,
    components: [...currentQuoteComponents]
  };

  const estimate = calculatePrintCost(job, STATE.config.printerSettings, STATE.config.materials, STATE.config.printers);
  const extraFees = calculateExtraFees(estimate.sellingPriceExVat, quantity, currentQuoteExcludedFeeIds);
  const adj = applyQuoteDiscounts(estimate, designFee, extraFees.total, currentQuoteDiscounts, getVatOptions());
  const totalWithDesign = adj.totalBeforeMinOrder;
  const totalFinalExact = applyMinOrder(totalWithDesign);
  adj.minOrderApplied = adj.discountsTotal > 0 && totalFinalExact > totalWithDesign + 0.005;
  const discountNotes = buildDiscountNotes(adj.belowCost, adj.minOrderApplied);

  // Per-part cost + price, for the internal job/quote details view and to
  // put a price against each part on the customer-facing PDF. There's no
  // separately-priced-per-part figure from calculatePrintCost (margin is
  // applied once, against the whole job), so each part's price is its
  // share of the quote's subtotal, allocated by that part's share of the
  // total material cost — the same driver the pricing itself is built on.
  // These always sum back to the "Subtotal" row shown in the total block.
  const minGrams = STATE.config?.minChargeGrams ?? 10;
  const subtotalExVat = estimate.sellingPriceExVat + designFee + extraFees.total;
  let totalPartsMaterialCost = 0;
  const partCosts = parts.map(p => {
    const mat = getSelectedMaterial(p.materialCode);
    const chargedWeightGrams = Math.max(p.weightGrams, minGrams);
    const materialCost = (chargedWeightGrams / 1000) * (mat.costPerKgKes || 0);
    totalPartsMaterialCost += materialCost;
    return { name: p.name || "", materialCost };
  });
  partCosts.forEach((pc, i) => {
    const share = totalPartsMaterialCost > 0 ? pc.materialCost / totalPartsMaterialCost : 1 / partCosts.length;
    pc.allocatedPrice = share * subtotalExVat;
  });

  // The whole-unit ladder the customer sees; its total is also the quote's
  // stored total, so documents and records can't disagree.
  const ladder = buildCustomerLadder({
    partAmounts: partCosts.map((pc) => pc.allocatedPrice),
    subtotalExact: subtotalExVat,
    discountRows: adj.rows,
    vatMode: adj.vatMode,
    vatRatePercent: getVatOptions().ratePercent,
    vatExact: adj.vatAmount,
    totalExact: totalFinalExact,
    rounding: getRoundingOptions(),
  });
  const totalFinal = ladder.total;

  const marginPercent = calcMarginPercent(totalFinal, ladder.vat, estimate.totalProductionCost);
  const targetMarginPercent = Number(STATE.config.targetMarginPercent) || 0;
  const marginBelowTarget = isBelowTargetMargin(marginPercent, targetMarginPercent);
  const resultNotes = discountNotes.concat(marginBelowTarget ? [buildMarginNote(marginPercent, targetMarginPercent)] : []);

  const partsBreakdownHtml = `
    <div class="breakdown mt-16">
      <h4 style="margin: 0 0 8px 0; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary);">Parts Breakdown</h4>
      <table>
        <thead><tr><th>Part & Material</th><th>Time</th><th>Weight</th><th style="text-align: right;">Price</th></tr></thead>
        <tbody>
          ${parts.map((p, i) => {
            const mat = getSelectedMaterial(p.materialCode);
            const colorName = getColorName(p.colorHex);
            const pNameStrHtml = p.name ? `<strong>${escapeHtml(p.name)}</strong><br>` : '';
            return `
              <tr>
                <td>${pNameStrHtml}${escapeHtml(mat.brand ? mat.brand + ' ' : '')}${escapeHtml(mat.name)} (${escapeHtml(colorName)})</td>
                <td>${p.printTimeHours ? p.printTimeHours.toFixed(1) : 0} hrs</td>
                <td>${Math.round(p.weightGrams)} g</td>
                <td style="text-align: right;">${formatKes(partCosts[i].allocatedPrice)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;

  const html = `
    ${buildSummary("Final quote (incl. " + taxLabel() + ")", totalFinal, `Production cost: ${formatKes(estimate.totalProductionCost)} + design fee`)}
    ${resultNotes.length > 0 ? `<p class="help-text" style="color:#dc2626; margin: 8px 0;">⚠ ${resultNotes.join(" ")}</p>` : ""}
    <div class="result-grid">
      <div><strong>Total Material weight</strong>: ${Math.round(totalWeightG)} g</div>
      <div><strong>Total Print time</strong>: ${totalPrintTimeHrs.toFixed(1)} hrs</div>
      <div><strong>Minimum order</strong>: ${formatKes(STATE.config.serviceMinimumOrderKes)}</div>
    </div>
    ${parts.length > 1 ? partsBreakdownHtml : ""}
    ${buildBreakdownTable([
      { label: "Material cost", amount: estimate.materialCost },
      { label: "Electricity cost", amount: estimate.electricityCost },
      { label: "Depreciation cost", amount: estimate.depreciationCost },
      { label: "Maintenance cost", amount: estimate.maintenanceCost },
      { label: "Labour cost", amount: estimate.laborCost },
      { label: "Overhead cost", amount: estimate.overheadCost },
      { label: "Failed print buffer", amount: estimate.failedPrintBuffer },
      { label: "Packaging", amount: estimate.packagingCost },
      ...(estimate.componentsCost > 0 ? [{ label: "Components cost", amount: estimate.componentsCost }] : []),
      ...(estimate.bulkDiscountAmount > 0 ? [{ label: `Bulk discount (${estimate.bulkDiscountPercent}%)`, amount: -estimate.bulkDiscountAmount }] : []),
      { label: "Profit + margin", amount: estimate.sellingPriceExVat - estimate.totalProductionCost },
      { label: taxLabel(), amount: adj.vatAmount },
      ...(designFee > 0 ? [{ label: "Design Fee", amount: designFee }] : []),
      ...extraFees.rows.map(r => ({ label: r.label, amount: r.amount })),
      ...adj.rows.map(r => ({ label: escapeHtml(discountRowLabel(r)), amount: -r.amount })),
      { label: "Total final", amount: totalFinal },
    ])}
  `;

  // Draft reference shown until the quote is saved and gets its PROD number.
  const quotePreviewRef = `Q-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  STATE.lastPrintRecord = {
    name: projectName,
    printerId: printerId,
    category: category,
    subcategory: categorySelection.subcategory,
    subSubcategory: categorySelection.subSubcategory,
    type: "project",
    parts: parts,
    quantity,
    printTimeHours: totalPrintTimeHrs,
    totalAmount: totalFinal,
    quotePreviewRef,
    whatsappText: "",
    customerId: customerId || "",
    componentsCostOverride: componentsCost,
    components: [...currentQuoteComponents],
    details: {
      postProcessTime,
      postProcessFee,
      designFee,
      extraFees: extraFees.rows,
      extraFeesTotal: extraFees.total,
      removedExtraFees: extraFees.removed || [],
      // Manual discounts: the inputs (so a recalculation can re-apply them),
      // the resolved rows/amounts, and VAT after the discount.
      discountItems: currentQuoteDiscounts.map(d => ({ ...d })),
      discounts: adj.rows,
      discountsTotal: adj.discountsTotal,
      vatAfterDiscount: adj.vatAmount,
      vatMode: adj.vatMode,
      vatRatePercent: getVatOptions().ratePercent,
      roundingStep: getRoundingOptions().step,
      roundingMode: getRoundingOptions().mode,
      roundingAdjustment: ladder.roundingAdjustment,
      preRoundingTotal: totalFinalExact,
      marginPercent,
      targetMarginPercent,
      marginBelowTarget,
      discountBelowCost: adj.belowCost,
      discountMinOrderApplied: adj.minOrderApplied,
      // Snapshotted at quote time so job history still reads correctly
      // even if this customer is later edited or removed.
      customerCompany: customer ? customer.company : "",
      customerContact: customer ? customer.contactPerson : "",
      // Internal-only — never shown on the customer-facing PDF, only in
      // the job/quote details drawer.
      partCosts: partCosts,
      costBreakdown: {
        materialCost: estimate.materialCost,
        electricityCost: estimate.electricityCost,
        depreciationCost: estimate.depreciationCost,
        maintenanceCost: estimate.maintenanceCost,
        laborCost: estimate.laborCost,
        overheadCost: estimate.overheadCost,
        failedPrintBuffer: estimate.failedPrintBuffer,
        packagingCost: estimate.packagingCost,
        componentsCost: estimate.componentsCost,
        bulkDiscountAmount: estimate.bulkDiscountAmount,
        bulkDiscountPercent: estimate.bulkDiscountPercent,
        totalProductionCost: estimate.totalProductionCost,
        profitAmount: estimate.profitAmount,
        vatAmount: estimate.vatAmount,
        sellingPriceExVat: estimate.sellingPriceExVat,
        sellingPriceIncVat: estimate.sellingPriceIncVat,
      },
    },
  };

  // The preview, the saved quote and the invoice all come from the same
  // builder, so they can never disagree.
  const docs = buildQuoteDocumentsFromJob(STATE.lastPrintRecord, "quote");
  STATE.lastPrintRecord.whatsappText = docs.whatsappText;
  document.getElementById("printInvoice").innerHTML = docs.printHtml;

  renderResult(html);
}

function renderInventory() {
  const tableWrap = document.getElementById("inventoryTable");
  if (!tableWrap) return;

  const materials = Array.isArray(STATE.config.materials) ? STATE.config.materials : [];
  const totalCount = materials.length;
  const totalWeight = materials.reduce((sum, m) => sum + (m.stockKg || 0), 0);
  const totalValue = materials.reduce((sum, m) => sum + (m.stockKg || 0) * m.costPerKgKes, 0);

  const countEl = document.getElementById("invTotalCount");
  const weightEl = document.getElementById("invTotalWeight");
  const valueEl = document.getElementById("invTotalValue");

  if(countEl) countEl.textContent = totalCount;
  if(weightEl) weightEl.textContent = totalWeight.toFixed(2) + " kg";
  if(valueEl) valueEl.textContent = formatKes(totalValue);

  if (totalCount === 0) {
    tableWrap.innerHTML = `<p class="help-text">No inventory items available. Add a material to begin tracking.</p>`;
    return;
  }

  // One row per material TYPE (PLA, PETG, ABS...), not per color/brand —
  // click a row to see every color/brand variant stocked for that type,
  // each with its own price and stock, in the detail drawer.
  const groups = {};
  materials.forEach((m) => {
    if (!groups[m.type]) groups[m.type] = [];
    groups[m.type].push(m);
  });
  const types = Object.keys(groups).sort();

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Material Type</th>
          <th>Colors in Stock</th>
          <th>Variants</th>
          <th>Price Range</th>
          <th>Total Stock (kg)</th>
          <th style="width: 20px;"></th>
        </tr>
      </thead>
      <tbody>
        ${types.map((type) => {
          const items = groups[type];
          const typeStock = items.reduce((sum, m) => sum + (m.stockKg || 0), 0);
          const prices = items.map((m) => m.costPerKgKes || 0);
          const minPrice = Math.min(...prices);
          const maxPrice = Math.max(...prices);
          const priceLabel = minPrice === maxPrice ? formatKes(minPrice) : `${formatKes(minPrice)} – ${formatKes(maxPrice)}`;
          const isLowStock = typeStock < 0.5;
          return `
            <tr class="inventory-type-row ${isLowStock ? 'stock-warning-row' : ''}" data-type="${type}" style="cursor: pointer;">
              <td><strong>${type}</strong></td>
              <td>
                ${items.map((m) => `<span class="color-dot" style="background-color: ${m.colorHex || '#9CA3AF'}; margin-right: 3px;" title="${getColorName(m.colorHex)}"></span>`).join("")}
              </td>
              <td>${items.length}</td>
              <td>${priceLabel}/kg</td>
              <td>${typeStock.toFixed(2)} kg</td>
              <td style="text-align: right; color: var(--text-secondary);">›</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".inventory-type-row").forEach((row) => {
    row.addEventListener("click", () => openInventoryTypeDetailPage(row.dataset.type));
  });

  applyTableFilters();
}

// Tracks which material type the full-page inventory detail view is
// currently showing — used by the "+ Add Stock" button on that page (to
// preset the new item's type) and to know whether to refresh that page
// in place after an add/edit/remove elsewhere.
let currentInventoryTypeView = null;

// Opens the "<Type> Stock" page — a full tab, not a drawer, since this
// list can grow long as more colors/brands get added and deserves its
// own scrollable space rather than a narrow side panel.
function openInventoryTypeDetailPage(type) {
  currentInventoryTypeView = type;
  const label = document.getElementById("inventoryTypeDetailLabel");
  if (label) label.textContent = type;

  renderInventoryTypeDetailList(type);
  setActiveTab("inventory-type");
  // This page is conceptually part of "Inventory" — keep that nav button
  // highlighted rather than showing no active tab at all.
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    if (btn.dataset.tab === "inventory") btn.classList.add("active");
  });
}

// Renders just the list portion of the type-detail page (or refreshes it
// in place after a stock/edit/remove change) — separated from
// openInventoryTypeDetailPage so callers elsewhere (add/edit/remove
// material) can refresh this page without re-triggering the tab switch.
function renderInventoryTypeDetailList(type) {
  const listEl = document.getElementById("inventoryTypeDetailList");
  if (!listEl) return;

  const items = (STATE.config.materials || []).filter((m) => m.type === type);

  if (!items.length) {
    listEl.innerHTML = `<p class="help-text">No ${type} stock left — add one with the button above.</p>`;
    return;
  }

  listEl.innerHTML = items.map((material) => {
    const isLowStock = material.stockKg < 0.5;
    const fullName = `${material.brand ? escapeHtml(material.brand) + ' ' : ''}${escapeHtml(material.name)}`;
    return `
      <div class="inventory-variant-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; ${isLowStock ? 'background: var(--danger-soft);' : ''}">
        <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
          <span class="color-dot" style="background-color: ${material.colorHex || '#9CA3AF'}; width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0;"></span>
          <div style="min-width: 0;">
            <div><strong>${fullName}</strong> <span style="font-size: 0.78rem; color: var(--text-secondary);">${getColorName(material.colorHex)}</span></div>
            <div style="font-size: 0.78rem; color: var(--text-secondary);">${material.code} · ${formatKes(material.costPerKgKes)}/kg</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; flex-shrink: 0;">
          <div class="stock-readout ${isLowStock ? 'stock-warning' : ''}" title="Current stock — click the pencil to edit">
            ${formatStockKg(material.stockKg || 0)} kg
          </div>
          <button type="button" class="icon-btn edit-material" data-code="${material.code}" title="Edit Material">${ICON_EDIT}</button>
          <button type="button" class="icon-btn danger remove-material" data-code="${material.code}" title="Remove Material">${ICON_TRASH}</button>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".remove-material").forEach((button) => {
    button.addEventListener("click", () => {
      removeMaterial(button.dataset.code);
      renderInventoryTypeDetailList(type);
    });
  });

  listEl.querySelectorAll(".edit-material").forEach((button) => {
    button.addEventListener("click", () => editMaterial(button.dataset.code));
  });
}

function renderPrinters() {
  const tableWrap = document.getElementById("printersTableWrap");
  if (!tableWrap) return;

  if (!Array.isArray(STATE.config.printers) || STATE.config.printers.length === 0) {
    tableWrap.innerHTML = `<p class="help-text">No printers available. Add a printer to begin tracking.</p>`;
    return;
  }

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Model</th>
          <th>Tech</th>
          <th>Status</th>
          <th>Power (W)</th>
          <th>Price (${getCurrencyCode()})</th>
          <th>Lifespan (Hrs)</th>
          <th>Logged Hrs</th>
          <th>Build Vol. (mm)</th>
          <th>Max Spools</th>
          <th style="width: 90px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${STATE.config.printers.map(p => {
          const statusColor = p.status === "Retired" ? "var(--danger)" : p.status === "Maintenance" ? "var(--warning, #b45309)" : "var(--success, #15803d)";
          const lifePercent = p.lifespanHours ? Math.min(100, Math.round(((p.loggedHours || 0) / p.lifespanHours) * 100)) : 0;
          const buildVol = (p.buildVolumeX && p.buildVolumeY && p.buildVolumeZ) ? `${p.buildVolumeX}×${p.buildVolumeY}×${p.buildVolumeZ}` : "—";
          const thumb = p.photoDataUrl
            ? `<img src="${p.photoDataUrl}" alt="" style="width:32px; height:32px; border-radius:6px; object-fit:cover; display:block;" />`
            : `<div style="width:32px; height:32px; border-radius:6px; background:var(--surface); display:flex; align-items:center; justify-content:center; font-size:0.9rem;">🖨️</div>`;
          return `
          <tr>
            <td>${thumb}</td>
            <td>${escapeHtml(p.name)}</td>
            <td>${p.technology || "FDM"}</td>
            <td>
              <span style="color:${statusColor}; font-weight:600;">${p.status || "Active"}</span>
              ${p.networkAddress && p.networkApiType ? `
                <button type="button" class="icon-btn check-live-status" data-id="${p.id}" title="Check live status" style="margin-left:4px;">🔌</button>
                <div class="help-text live-status-inline" data-id="${p.id}" style="font-size:0.72rem; margin-top:2px;"></div>
              ` : ""}
            </td>
            <td>${p.powerWatts}</td>
            <td>${formatKes(p.printerPurchasePriceKes)}</td>
            <td>${p.lifespanHours}</td>
            <td title="${lifePercent}% of rated lifespan">${(p.loggedHours || 0).toFixed(1)}${p.lifespanHours ? ` (${lifePercent}%)` : ""}</td>
            <td>${buildVol}</td>
            <td>${p.maxColors || 1}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="icon-btn edit-printer" data-id="${p.id}" title="Edit Printer">${ICON_EDIT}</button>
              <button type="button" class="icon-btn danger remove-printer" data-id="${p.id}" title="Remove Printer">${ICON_TRASH}</button>
            </td>
          </tr>
        `;
        }).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".remove-printer").forEach((button) => {
    button.addEventListener("click", () => removePrinter(button.dataset.id));
  });
  tableWrap.querySelectorAll(".edit-printer").forEach((button) => {
    button.addEventListener("click", () => editPrinter(button.dataset.id));
  });
  tableWrap.querySelectorAll(".check-live-status").forEach((button) => {
    button.addEventListener("click", () => {
      const resultEl = tableWrap.querySelector(`.live-status-inline[data-id="${button.dataset.id}"]`);
      checkPrinterLiveStatus(button.dataset.id, resultEl);
    });
  });

  applyTableFilters();
}

// ---------- Printer Accessories & Parts ----------

function buildAccessoryPrinterOptions(select) {
  if (!select) return;
  const current = select.value;
  const printers = Array.isArray(STATE.config.printers) ? STATE.config.printers : [];
  let optionsHtml = `<option value="">— Not printer-specific —</option>` +
    printers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");

  // A printer being created (Add Printer page) doesn't exist in
  // STATE.config.printers yet, but it already has a pending id (set as
  // soon as the "+ Add Printer" page opens) so parts/accessories can be
  // linked to it before the first save. Surface that pending printer as
  // an extra option so its dropdown doesn't just show blank.
  const pendingId = document.getElementById("newPrinterId")?.value || "";
  if (pendingId && !printers.some(p => p.id === pendingId)) {
    const pendingName = document.getElementById("newPrinterName")?.value.trim() || "New printer";
    optionsHtml += `<option value="${pendingId}">${pendingName} (unsaved)</option>`;
  }

  select.innerHTML = optionsHtml;
  if (current && (printers.some(p => p.id === current) || current === pendingId)) select.value = current;
}

function renderPrinterAccessories() {
  const tableWrap = document.getElementById("printerAccessoriesTableWrap");
  if (!tableWrap) return;

  const items = Array.isArray(STATE.config.printerAccessories) ? STATE.config.printerAccessories : [];
  if (items.length === 0) {
    tableWrap.innerHTML = `<p class="help-text">No accessories or spare parts logged yet. Add spare nozzles, AMS units, bed sheets, or tools here.</p>`;
    return;
  }

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Category</th>
          <th>Qty</th>
          <th>Cost Each (${getCurrencyCode()})</th>
          <th>Total Value</th>
          <th>Linked Printer</th>
          <th>Notes</th>
          <th style="width: 90px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(a => {
          const printer = STATE.config.printers.find(p => p.id === a.printerId);
          const totalValue = (Number(a.qty) || 0) * (Number(a.costKes) || 0);
          const type = a.type || "part";
          const extraDetail = type === "part"
            ? (a.reorderQty ? `<span class="help-text">Low-stock alert at ${a.reorderQty}</span>` : "")
            : (a.assetTag ? `<span class="help-text">Asset: ${a.assetTag}</span>` : "");
          return `
          <tr>
            <td>${a.name}${extraDetail ? `<br/>${extraDetail}` : ""}</td>
            <td><span class="type-badge type-${type}">${type === "accessory" ? "Accessory" : "Part"}</span></td>
            <td>${a.category || "Other"}</td>
            <td>${a.qty || 0}</td>
            <td>${formatKes(a.costKes || 0)}</td>
            <td>${formatKes(totalValue)}</td>
            <td>${printer ? printer.name : "—"}</td>
            <td>${a.notes || ""}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="icon-btn edit-accessory" data-id="${a.id}" title="Edit">${ICON_EDIT}</button>
              <button type="button" class="icon-btn danger remove-accessory" data-id="${a.id}" title="Remove">${ICON_TRASH}</button>
            </td>
          </tr>
        `;
        }).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".remove-accessory").forEach((button) => {
    button.addEventListener("click", () => removePrinterAccessory(button.dataset.id));
  });
  tableWrap.querySelectorAll(".edit-accessory").forEach((button) => {
    button.addEventListener("click", () => editPrinterAccessory(button.dataset.id));
  });

  applyTableFilters();
}

// Routes to the right drawer (Part vs Accessory) based on the item's
// stored type — the two are separate forms with different fields.
function editPrinterAccessory(id) {
  const item = STATE.config.printerAccessories.find(a => a.id === id);
  if (!item) return;
  if ((item.type || "part") === "accessory") {
    openAccessoryDrawer(id);
  } else {
    openPartDrawer(id);
  }
}

// Opens the Add/Edit Part drawer. Pass an existing item id to edit it,
// or a presetPrinterId (real or pending) to pre-link a new part to a
// printer opened from its Parts tab.
function openPartDrawer(existingId, presetPrinterId) {
  const item = existingId ? STATE.config.printerAccessories.find(a => a.id === existingId) : null;

  document.getElementById("partFormId").value = item ? item.id : "";
  document.getElementById("partDrawerTitle").textContent = item ? "Edit Part" : "Add Part";
  document.getElementById("partFormName").value = item ? (item.name || "") : "";
  document.getElementById("partFormCategory").innerHTML = getAccessoryCategoryOptionsHtml(item ? item.category : undefined);
  document.getElementById("partFormQty").value = item ? (item.qty || 0) : "";
  document.getElementById("partFormCost").value = item ? (item.costKes || 0) : "";
  document.getElementById("partFormReorderQty").value = item && item.reorderQty ? item.reorderQty : "";
  document.getElementById("partFormNotes").value = item ? (item.notes || "") : "";

  const printerSel = document.getElementById("partFormPrinter");
  buildAccessoryPrinterOptions(printerSel);
  printerSel.value = item ? (item.printerId || "") : (presetPrinterId || "");

  openAppDrawer("partDrawerOverlay");
}

// Opens the Add/Edit Accessory drawer — same idea as openPartDrawer but
// for the Accessory form (asset tag instead of stock qty/reorder alert).
function openAccessoryDrawer(existingId, presetPrinterId) {
  const item = existingId ? STATE.config.printerAccessories.find(a => a.id === existingId) : null;

  document.getElementById("accessoryFormId").value = item ? item.id : "";
  document.getElementById("accessoryDrawerTitle").textContent = item ? "Edit Accessory" : "Add Accessory";
  document.getElementById("accessoryFormName").value = item ? (item.name || "") : "";
  document.getElementById("accessoryFormCategory").innerHTML = getAccessoryCategoryOptionsHtml(item ? item.category : undefined);
  document.getElementById("accessoryFormCost").value = item ? (item.costKes || 0) : "";
  document.getElementById("accessoryFormAssetTag").value = item ? (item.assetTag || "") : "";
  document.getElementById("accessoryFormNotes").value = item ? (item.notes || "") : "";

  const printerSel = document.getElementById("accessoryFormPrinter");
  buildAccessoryPrinterOptions(printerSel);
  printerSel.value = item ? (item.printerId || "") : (presetPrinterId || "");

  openAppDrawer("accessoryDrawerOverlay");
}

function removePrinterAccessory(id) {
  STATE.config.printerAccessories = STATE.config.printerAccessories.filter(a => a.id !== id);
  saveState();
  renderPrinterAccessories();
}

// Compact linked list of a printer's accessories/parts, filtered by
// type ("part" | "accessory"), shown in the Parts/Accessories mini-tabs
// of the Add/Edit Printer pages. wrapId names the target container;
// printerId may be a pending (not-yet-saved) id from the Add Printer
// page, in which case nothing is linked yet and we say so.
function renderLinkedAccessoriesList(wrapId, printerId, type) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const noun = type === "accessory" ? "accessories" : "parts";

  const items = (STATE.config.printerAccessories || []).filter(
    a => a.printerId === printerId && (a.type || "part") === type
  );
  if (items.length === 0) {
    wrap.innerHTML = `<p class="help-text">No ${noun} linked yet.</p>`;
    return;
  }

  wrap.innerHTML = `
    <div class="inventory-table-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Category</th><th style="width: 90px; text-align: right;">Actions</th></tr>
        </thead>
        <tbody>
          ${items.map(a => `
            <tr>
              <td>${a.name}</td>
              <td>${a.category || "Other"}${a.qty ? ` <span class="help-text">· qty ${a.qty}</span>` : ""}</td>
              <td style="text-align: right; white-space: nowrap;">
                <button type="button" class="icon-btn edit-linked-accessory" data-id="${a.id}" title="Edit">${ICON_EDIT}</button>
                <button type="button" class="icon-btn danger remove-linked-accessory" data-id="${a.id}" title="Remove">${ICON_TRASH}</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  wrap.querySelectorAll(".edit-linked-accessory").forEach((btn) => {
    btn.addEventListener("click", () => editPrinterAccessory(btn.dataset.id));
  });
  wrap.querySelectorAll(".remove-linked-accessory").forEach((btn) => {
    btn.addEventListener("click", () => {
      removePrinterAccessory(btn.dataset.id);
      renderLinkedAccessoriesList(wrapId, printerId, type);
    });
  });
}

// Refreshes both mini-tabs on the Edit Printer page for a real, saved
// printer id.
function renderEditPrinterLinkedItems(printerId) {
  renderLinkedAccessoriesList("editPrinterPartsWrap", printerId, "part");
  renderLinkedAccessoriesList("editPrinterAccessoriesWrap", printerId, "accessory");
}

// Refreshes both mini-tabs on the Add Printer page, keyed off the
// pending id generated as soon as that page opens (see the
// `[data-page="add-printer"]` click handler below).
function renderNewPrinterLinkedItems() {
  const pendingId = document.getElementById("newPrinterId")?.value || "";
  renderLinkedAccessoriesList("newPrinterPartsWrap", pendingId, "part");
  renderLinkedAccessoriesList("newPrinterAccessoriesWrap", pendingId, "accessory");
}

// ---------- Customers (companies + contact person) ----------

function getCustomerById(id) {
  if (!id || !Array.isArray(STATE.config.customers)) return null;
  return STATE.config.customers.find((c) => c.id === id) || null;
}

// Fills the "Customer" dropdown on the Quote tab. Kept optional — a quote
// can be built with no customer attached, same as before this feature.
function buildCustomerOptions(selectElement) {
  if (!selectElement) return;
  const currentValue = selectElement.value;
  const customers = Array.isArray(STATE.config.customers) ? STATE.config.customers : [];

  selectElement.innerHTML = `<option value="">— No customer selected —</option>` +
    customers
      .slice()
      .sort((a, b) => (a.company || "").localeCompare(b.company || ""))
      .map((c) => {
        const label = c.contactPerson ? `${c.company} — ${c.contactPerson}` : c.company;
        return `<option value="${c.id}">${label}</option>`;
      })
      .join("");

  if (currentValue && customers.some((c) => c.id === currentValue)) {
    selectElement.value = currentValue;
  }
}

// Full customer profile: every quote/job for this customer, their
// attached images and STL/model files, and running totals — so a
// business owner can click a customer and see their whole history in
// one place instead of hunting through Job History for their name.
function viewCustomerDetail(id) {
  const customer = getCustomerById(id);
  if (!customer) return;

  STATE.currentCustomerDetailId = id;
  const content = document.getElementById("customerDetailContent");
  if (!content) return;

  const jobs = STATE.history.filter((j) => j.customerId === id);
  const sortedJobs = jobs.slice().sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));

  const totalJobs = jobs.length;
  const totalValue = jobs.reduce((s, j) => s + (j.totalAmount || 0), 0);
  const totalImages = jobs.reduce((s, j) => s + ((j.images && j.images.length) || 0), 0);
  const totalModels = jobs.reduce((s, j) => s + ((j.parts || []).filter((p) => p.stl).length), 0);

  const infoHtml = `
    <div class="job-overview-card">
      <div class="job-overview-top">
        <div>
          <p class="job-overview-title">${escapeHtml(customer.company) || "Unnamed Customer"}</p>
          ${customer.contactPerson ? `<p class="job-overview-customer">${escapeHtml(customer.contactPerson)}</p>` : ""}
        </div>
      </div>
      <div class="job-stat-grid">
        <div class="job-stat-tile"><span class="stat-label">Phone</span><span class="stat-value" style="font-size:0.95rem;">${escapeHtml(customer.phone) || "—"}</span></div>
        <div class="job-stat-tile"><span class="stat-label">Email</span><span class="stat-value" style="font-size:0.9rem;">${escapeHtml(customer.email) || "—"}</span></div>
        <div class="job-stat-tile"><span class="stat-label">Address</span><span class="stat-value" style="font-size:0.9rem;">${escapeHtml(customer.address) || "—"}</span></div>
      </div>
      ${customer.notes ? `<p class="help-text mt-16" style="border-top: 1px dashed var(--border); padding-top: 12px;"><strong>Notes:</strong> ${escapeHtml(customer.notes)}</p>` : ""}
    </div>

    <div class="history-summary-grid mt-24">
      <div><span>Total orders</span><strong>${totalJobs}</strong></div>
      <div><span>Total value</span><strong>${formatKes(totalValue)}</strong></div>
      <div><span>Images attached</span><strong>${totalImages}</strong></div>
      <div><span>3D models attached</span><strong>${totalModels}</strong></div>
    </div>
  `;

  const jobsHtml = sortedJobs.length === 0
    ? `<p class="help-text mt-24">No orders yet for this customer. Attach them to a quote from the Quote tab to start tracking history here.</p>`
    : `
    <div class="mt-24">
      <h3 style="margin-bottom: 12px;">Order History</h3>
      <div class="form-group-vertical">
        ${sortedJobs.map((job) => {
          const jobIndex = STATE.history.indexOf(job);
          const statusKey = String(job.status || "draft").trim().toLowerCase();
          const statusLabel = statusKey.replace(/_/g, " ");
          const parts = job.parts && job.parts.length ? job.parts : [{ materialName: job.materialName, weightGrams: job.weightGrams }];
          const totalWeight = parts.reduce((s, p) => s + (p.weightGrams || 0), 0);
          const modelCount = parts.filter((p) => p.stl).length;
          const imageCount = (job.images && job.images.length) || 0;
          const thumbs = (job.images || []).slice(0, 3);

          return `
            <div class="customer-order-card" data-job-index="${jobIndex}" style="padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer;">
              <div class="flex-between" style="align-items: flex-start;">
                <div>
                  <p style="font-weight: 700; margin: 0;">${escapeHtml(job.name) || "Unnamed Project"}</p>
                  <p class="help-text" style="margin: 2px 0 0;">${formatJobDate(job.recordedAt)} · ${escapeHtml(parts.map((p) => p.materialName || getSelectedMaterial(p.materialCode)?.name).filter(Boolean).join(", ")) || "—"}</p>
                </div>
                <span class="status-pill status-${statusKey}">${statusLabel}</span>
              </div>
              <div class="job-stat-grid mt-8">
                <div class="job-stat-tile"><span class="stat-label">Weight</span><span class="stat-value">${Math.round(totalWeight)} g</span></div>
                <div class="job-stat-tile"><span class="stat-label">Total</span><span class="stat-value">${formatKes(job.totalAmount)}</span></div>
                <div class="job-stat-tile"><span class="stat-label">Files</span><span class="stat-value">${imageCount} img · ${modelCount} model${modelCount === 1 ? "" : "s"}</span></div>
              </div>
              ${thumbs.length > 0 ? `
              <div style="display: flex; gap: 6px; margin-top: 10px;">
                ${thumbs.map((src) => `<img src="${src}" style="width: 44px; height: 44px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border);" />`).join("")}
                ${imageCount > 3 ? `<span class="help-text" style="align-self: center;">+${imageCount - 3} more</span>` : ""}
              </div>` : ""}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  content.innerHTML = infoHtml + jobsHtml;

  content.querySelectorAll(".customer-order-card").forEach((card) => {
    card.addEventListener("click", () => {
      const idx = Number(card.dataset.jobIndex);
      viewJobDetails(idx);
    });
  });

  setActiveTab("customer-detail");
}

function renderCustomers() {
  const tableWrap = document.getElementById("customersTableWrap");
  if (!tableWrap) return;

  const customers = Array.isArray(STATE.config.customers) ? STATE.config.customers : [];

  if (customers.length === 0) {
    tableWrap.innerHTML = `<p class="help-text">No customers yet. Add a company and contact person to start tracking who your quotes are for.</p>`;
    return;
  }

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>Contact Person</th>
          <th>Phone</th>
          <th>Email</th>
          <th style="width: 90px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${customers.map((c) => `
          <tr>
            <td><strong class="customer-company-link" data-id="${c.id}" style="cursor: pointer; color: var(--accent);">${escapeHtml(c.company)}</strong></td>
            <td>${escapeHtml(c.contactPerson) || "—"}</td>
            <td>${escapeHtml(c.phone) || "—"}</td>
            <td>${escapeHtml(c.email) || "—"}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="icon-btn view-customer" data-id="${c.id}" title="View Customer Profile">👁️</button>
              <button type="button" class="icon-btn edit-customer" data-id="${c.id}" title="Edit Customer">${ICON_EDIT}</button>
              <button type="button" class="icon-btn danger remove-customer" data-id="${c.id}" title="Remove Customer">${ICON_TRASH}</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".remove-customer").forEach((button) => {
    button.addEventListener("click", () => removeCustomer(button.dataset.id));
  });
  tableWrap.querySelectorAll(".edit-customer").forEach((button) => {
    button.addEventListener("click", () => editCustomer(button.dataset.id));
  });
  tableWrap.querySelectorAll(".view-customer, .customer-company-link").forEach((el) => {
    el.addEventListener("click", () => viewCustomerDetail(el.dataset.id));
  });

  applyTableFilters();
}

function editCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) return;

  document.getElementById("editCustomerId").value = customer.id;
  document.getElementById("editCustomerCompany").value = customer.company || "";
  document.getElementById("editCustomerContact").value = customer.contactPerson || "";
  document.getElementById("editCustomerPhone").value = customer.phone || "";
  document.getElementById("editCustomerEmail").value = customer.email || "";
  document.getElementById("editCustomerAddress").value = customer.address || "";
  document.getElementById("editCustomerNotes").value = customer.notes || "";

  goToPage("edit-customer");
}

function removeCustomer(id) {
  STATE.config.customers = (STATE.config.customers || []).filter((c) => c.id !== id);
  saveState();
  renderCustomers();
  buildCustomerOptions(document.getElementById("quoteCustomer"));
}

function renderProfiles() {
  const tableWrap = document.getElementById("profilesTableWrap");
  if (!tableWrap) return;

  if (!Array.isArray(STATE.config.materialProfiles) || STATE.config.materialProfiles.length === 0) {
    tableWrap.innerHTML = `<p class="help-text">No profiles available.</p>`;
    return;
  }

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Density (g/cm³)</th>
          <th>Nozzle (°C)</th>
          <th>Bed (°C)</th>
          <th>Notes</th>
          <th style="width: 90px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${STATE.config.materialProfiles.map(p => `
          <tr>
            <td><strong>${p.type}</strong></td>
            <td>${p.density || 'N/A'}</td>
            <td>${p.printTemp || 'N/A'}</td>
            <td>${p.bedTemp || 'N/A'}</td>
            <td>${p.notes || '—'}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="icon-btn edit-profile" data-type="${p.type}" title="Edit Profile">${ICON_EDIT}</button>
              <button type="button" class="icon-btn danger remove-profile" data-type="${p.type}" title="Remove Profile">${ICON_TRASH}</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".remove-profile").forEach((button) => {
    button.addEventListener("click", () => removeProfile(button.dataset.type));
  });
  tableWrap.querySelectorAll(".edit-profile").forEach((button) => {
    button.addEventListener("click", () => editProfile(button.dataset.type));
  });

  applyTableFilters();
}

function renderCustomColors() {
  const tableWrap = document.getElementById("colorsTableWrap");
  if (!tableWrap) return;

  if (!Array.isArray(STATE.config.colors) || STATE.config.colors.length === 0) {
    tableWrap.innerHTML = `<p class="help-text">No colors available. Add one to see it in your palette.</p>`;
    return;
  }

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Preview</th>
          <th>Name</th>
          <th>HEX Code</th>
          <th style="width: 40px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${STATE.config.colors.map(c => `
          <tr>
            <td><span class="color-dot" style="background-color: ${c.hex}; width: 24px; height: 24px;"></span></td>
            <td><strong>${c.name}</strong></td>
            <td>${c.hex}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="icon-btn danger remove-color" data-hex="${c.hex}" title="Remove Color">${ICON_TRASH}</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".remove-color").forEach((button) => {
    button.addEventListener("click", () => removeCustomColor(button.dataset.hex));
  });

  applyTableFilters();
}

// ==========================================
// Category tree (category -> subcategory -> sub-subcategory, 3 levels)
// ==========================================

function genCategoryId() {
  return "cat-" + Math.random().toString(36).slice(2, 10);
}

// Migrates old flat/partial category configs into the {id, name, skuAbbr,
// subcategories} tree shape. Safe to run on an already-normalized tree.
function normalizeCategoryTree(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    id: item.id || genCategoryId(),
    name: item.name || "",
    skuAbbr: item.skuAbbr || "",
    subcategories: normalizeCategoryTree(item.subcategories || []),
  }));
}

// Flattens the tree into a display-order list of
// {id, name, skuAbbr, level, path, pathIds, node} rows, depth-first —
// used to render the indented Settings table.
function flattenCategoryTree(list, parentPath = [], parentIds = []) {
  let out = [];
  (list || []).forEach((node) => {
    const path = [...parentPath, node.name];
    const pathIds = [...parentIds, node.id];
    out.push({ id: node.id, name: node.name, skuAbbr: node.skuAbbr, level: parentPath.length, path, pathIds, node });
    if (node.subcategories && node.subcategories.length) {
      out = out.concat(flattenCategoryTree(node.subcategories, path, pathIds));
    }
  });
  return out;
}

function findCategoryNodeById(list, id) {
  if (!id) return null;
  for (const node of (list || [])) {
    if (node.id === id) return node;
    if (node.subcategories && node.subcategories.length) {
      const found = findCategoryNodeById(node.subcategories, id);
      if (found) return found;
    }
  }
  return null;
}

// ==========================================
// Components (bought-in parts) — Settings catalog + quote/job builders
// ==========================================

// Returns <option> markup for every category/subcategory, indented by
// depth, value = full "Parent / Child" path so subcategories with the
// same leaf name across different parents stay distinct.
function getCategoryOptionsHtml(selectedValue) {
  const rows = flattenCategoryTree(STATE.config.categories || []);
  if (rows.length === 0) return `<option value="">No categories yet — add one in Settings → Categories</option>`;
  return rows.map(r => {
    const value = r.path.join(" / ");
    const indent = "&nbsp;&nbsp;".repeat(r.level);
    return `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${indent}${r.name}</option>`;
  }).join("");
}

// Shared table style for any flat, user-managed name list (component
// categories, accessory categories...) — matches the Material Profiles /
// inventory table look. Name + a delete action (no rename yet).
function renderFlatCategoryList(wrapId, categories, onRemove, emptyMessage) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;

  if (!categories || categories.length === 0) {
    wrap.innerHTML = `<p class="help-text">${emptyMessage}</p>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th style="width: 90px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${categories.map((c, i) => `
          <tr>
            <td><strong>${c}</strong></td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="icon-btn danger remove-flat-category" data-idx="${i}" title="Remove">${ICON_TRASH}</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll(".remove-flat-category").forEach((btn) => {
    btn.addEventListener("click", () => onRemove(Number(btn.dataset.idx)));
  });
}

// Component categories are a flat list, separate from product `categories`
// (see DEFAULT_CONFIG comment) — this is the dropdown source for every
// Components-related select (Settings table, quote-tab picker, job-detail
// drawer picker), managed in Settings → Components.
function getComponentCategoryOptionsHtml(selectedValue) {
  const cats = STATE.config.componentCategories || [];
  if (cats.length === 0) return `<option value="">No component categories yet — add one in Settings → Components</option>`;
  return cats.map(c => `<option value="${c}" ${c === selectedValue ? "selected" : ""}>${c}</option>`).join("");
}

function renderComponentCategoriesTable() {
  const cats = STATE.config.componentCategories || [];
  const countEl = document.getElementById("componentCategoriesCount");
  if (countEl) countEl.textContent = `${cats.length} categor${cats.length === 1 ? "y" : "ies"}`;
  renderFlatCategoryList(
    "componentCategoriesTableWrap",
    cats,
    (idx) => {
      const removed = STATE.config.componentCategories[idx];
      const inUse = (STATE.config.components || []).some(c => c.category === removed);
      if (inUse && !confirm(`"${removed}" is used by one or more components in your catalog. Remove it anyway? Those components keep their existing category value (just no longer selectable from the dropdown) until you reassign them.`)) {
        return;
      }
      STATE.config.componentCategories.splice(idx, 1);
      saveState();
      renderComponentCategoriesTable();
      refreshQuoteComponentSelectors();
    },
    `No component categories yet — add one above (e.g. "Electrical", "Hardware & Fasteners").`
  );
}

function renderAccessoryCategoriesTable() {
  const cats = STATE.config.accessoryCategories || [];
  renderFlatCategoryList(
    "accessoryCategoriesTableWrap",
    cats,
    (idx) => {
      const removed = STATE.config.accessoryCategories[idx];
      const inUse = (STATE.config.printerAccessories || []).some(a => a.category === removed);
      if (inUse && !confirm(`"${removed}" is used by one or more accessories in your catalog. Remove it anyway? Those accessories keep their existing category value (just no longer selectable from the dropdown) until you reassign them.`)) {
        return;
      }
      STATE.config.accessoryCategories.splice(idx, 1);
      saveState();
      renderAccessoryCategoriesTable();
      renderPrinterAccessories();
    },
    `No accessory categories yet — add one above (e.g. "Nozzle", "AMS / Multi-Material Unit").`
  );
}

function getAccessoryCategoryOptionsHtml(selectedValue) {
  const cats = STATE.config.accessoryCategories || [];
  if (cats.length === 0) return `<option value="">No accessory categories yet — add one in Settings → Components</option>`;
  return cats.map(c => `<option value="${c}" ${c === selectedValue ? "selected" : ""}>${c}</option>`).join("");
}

// ---------- Category Component Kits ----------
// A kit is a plain array of component ids stored at
// STATE.config.categoryComponentKits[categoryId]. Editor below lets the
// user pick a product Category, then check which components from the
// catalog belong to its default kit.

function renderCategoryKitSelect() {
  const select = document.getElementById("categoryKitSelect");
  if (!select) return;
  const prev = select.value;
  const rows = flattenCategoryTree(STATE.config.categories || []);
  select.innerHTML = rows.length
    ? rows.map(r => `<option value="${r.id}">${"— ".repeat(r.level)}${r.name}</option>`).join("")
    : `<option value="">No categories yet — add one in Settings → Categories</option>`;
  if (rows.some(r => r.id === prev)) select.value = prev;
  renderCategoryKitEditor();
}

function updateCategoryKitsCount() {
  const countEl = document.getElementById("categoryKitsCount");
  if (!countEl) return;
  const kits = STATE.config.categoryComponentKits || {};
  const n = Object.values(kits).filter(list => Array.isArray(list) && list.length > 0).length;
  countEl.textContent = `${n} kit${n === 1 ? "" : "s"} set`;
}

function renderCategoryKitEditor() {
  const wrap = document.getElementById("categoryKitComponentsWrap");
  const select = document.getElementById("categoryKitSelect");
  if (!wrap || !select) return;
  updateCategoryKitsCount();

  const catId = select.value;
  const components = STATE.config.components || [];
  if (!catId) {
    wrap.innerHTML = `<p class="help-text">Pick a category above.</p>`;
    return;
  }
  if (components.length === 0) {
    wrap.innerHTML = `<p class="help-text">No components in your catalog yet — add some below first.</p>`;
    return;
  }

  const kit = (STATE.config.categoryComponentKits || {})[catId] || [];

  wrap.innerHTML = `
    <div class="inventory-table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:50px;">In Kit</th>
            <th>Component</th>
            <th>Category</th>
            <th style="text-align:right;">Cost</th>
          </tr>
        </thead>
        <tbody>
          ${components.map(c => `
            <tr>
              <td><input type="checkbox" id="kitchk-${c.id}" class="kit-component-check" data-id="${c.id}" style="width:auto;" ${kit.includes(c.id) ? "checked" : ""} /></td>
              <td><label for="kitchk-${c.id}" style="cursor:pointer;"><strong>${c.name || "(unnamed)"}</strong></label></td>
              <td>${c.category || "Other"}</td>
              <td style="text-align:right;">${formatKes(c.costKes)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  wrap.querySelectorAll(".kit-component-check").forEach((el) => {
    el.addEventListener("change", () => {
      if (!Array.isArray(STATE.config.categoryComponentKits)) {} // no-op guard, object not array
      if (!STATE.config.categoryComponentKits) STATE.config.categoryComponentKits = {};
      const current = STATE.config.categoryComponentKits[catId] || [];
      if (el.checked) {
        if (!current.includes(el.dataset.id)) current.push(el.dataset.id);
      } else {
        const i = current.indexOf(el.dataset.id);
        if (i !== -1) current.splice(i, 1);
      }
      STATE.config.categoryComponentKits[catId] = current;
      saveState();
      updateCategoryKitsCount();
    });
  });
}

function renderComponentsTable() {
  const wrap = document.getElementById("componentsTableWrap");
  if (!wrap) return;
  const items = Array.isArray(STATE.config.components) ? STATE.config.components : [];

  if (items.length === 0) {
    wrap.innerHTML = `<p class="help-text">No components yet. Add bought-in, non-printed parts here — sockets, cords, LEDs, threaded inserts — tagged by category, so they're selectable when building a quote or editing a job in that category.</p>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Name</th><th>Category</th><th>Cost (${getCurrencyCode()})</th><th></th></tr>
      </thead>
      <tbody>
        ${items.map((c, i) => `
          <tr>
            <td><input type="text" class="component-name" data-idx="${i}" value="${c.name || ""}" placeholder="e.g. E27 Socket" style="width: 100%;" /></td>
            <td><select class="component-category" data-idx="${i}">${getComponentCategoryOptionsHtml(c.category)}</select></td>
            <td><input type="number" class="component-cost" data-idx="${i}" value="${c.costKes ?? 0}" min="0" step="1" style="width: 110px;" /></td>
            <td><button type="button" class="icon-btn danger remove-component" data-idx="${i}" title="Remove">${ICON_TRASH}</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  const updateComponent = (idx, field, value) => {
    if (!STATE.config.components[idx]) return;
    STATE.config.components[idx][field] = value;
    saveState();
  };

  wrap.querySelectorAll(".component-name").forEach((el) => {
    el.addEventListener("input", () => updateComponent(Number(el.dataset.idx), "name", el.value));
  });
  wrap.querySelectorAll(".component-category").forEach((el) => {
    el.addEventListener("change", () => {
      updateComponent(Number(el.dataset.idx), "category", el.value);
      refreshQuoteComponentSelectors();
    });
  });
  wrap.querySelectorAll(".component-cost").forEach((el) => {
    el.addEventListener("input", () => updateComponent(Number(el.dataset.idx), "costKes", Math.max(0, Number(el.value) || 0)));
  });
  wrap.querySelectorAll(".remove-component").forEach((el) => {
    el.addEventListener("click", () => {
      const removedId = STATE.config.components[Number(el.dataset.idx)]?.id;
      STATE.config.components.splice(Number(el.dataset.idx), 1);
      // Drop the removed component from any kit that referenced it.
      if (removedId && STATE.config.categoryComponentKits) {
        Object.keys(STATE.config.categoryComponentKits).forEach((catId) => {
          STATE.config.categoryComponentKits[catId] = (STATE.config.categoryComponentKits[catId] || []).filter(id => id !== removedId);
        });
      }
      saveState();
      renderComponentsTable();
      refreshQuoteComponentSelectors();
      renderCategoryKitEditor();
    });
  });

  applyTableFilters();
}

function addComponentRow() {
  if (!Array.isArray(STATE.config.components)) STATE.config.components = [];
  const firstCategory = (STATE.config.componentCategories || [])[0] || "";
  STATE.config.components.push({
    id: `comp-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name: "",
    category: firstCategory,
    costKes: 0,
  });
  saveState();
  renderComponentsTable();
  refreshQuoteComponentSelectors();
  renderCategoryKitEditor();
}

// Sums a job's attached components back into componentsCostOverride —
// call this any time job.components is mutated, before recalculateJobPricing.
function syncJobComponentsCost(job) {
  job.componentsCostOverride = (job.components || []).reduce((sum, c) => sum + (c.costKes || 0), 0);
}

function getQuoteComponentsTotal() {
  return currentQuoteComponents.reduce((sum, c) => sum + (c.costKes || 0), 0);
}

function updateQuoteComponentOptions() {
  const catSelect = document.getElementById("quoteComponentCategory");
  const compSelect = document.getElementById("quoteComponentSelect");
  if (!catSelect || !compSelect) return;
  const items = (STATE.config.components || []).filter(c => c.category === catSelect.value);
  compSelect.innerHTML = items.length
    ? items.map(c => `<option value="${c.id}">${c.name} — ${formatKes(c.costKes)}</option>`).join("")
    : `<option value="">No components in this category</option>`;
}

function refreshQuoteComponentSelectors() {
  const catSelect = document.getElementById("quoteComponentCategory");
  if (!catSelect) return;
  const prevValue = catSelect.value;
  catSelect.innerHTML = getComponentCategoryOptionsHtml(prevValue);
  updateQuoteComponentOptions();
}

function renderQuoteComponentsList() {
  const wrap = document.getElementById("quoteComponentsListWrap");
  const totalEl = document.getElementById("quoteComponentsTotal");
  if (!wrap) return;

  if (currentQuoteComponents.length === 0) {
    wrap.innerHTML = `<p class="help-text">No components added to this quote yet.</p>`;
  } else {
    wrap.innerHTML = `
      <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px;">
        ${currentQuoteComponents.map((c, i) => `
          <li style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background: var(--surface-hover); border-radius:8px;">
            <span>${c.name}<span class="help-text" style="margin-left:6px;">${c.category}</span></span>
            <span style="display:flex; align-items:center; gap:10px;">
              <strong>${formatKes(c.costKes)}</strong>
              <button type="button" class="icon-btn danger remove-quote-component" data-idx="${i}" title="Remove">${ICON_TRASH}</button>
            </span>
          </li>
        `).join("")}
      </ul>
    `;
    wrap.querySelectorAll(".remove-quote-component").forEach((el) => {
      el.addEventListener("click", () => {
        currentQuoteComponents.splice(Number(el.dataset.idx), 1);
        renderQuoteComponentsList();
      });
    });
  }

  if (totalEl) totalEl.textContent = formatKes(getQuoteComponentsTotal());
  scheduleLiveProfitPreview();
}

function addQuoteComponent() {
  const catSelect = document.getElementById("quoteComponentCategory");
  const compSelect = document.getElementById("quoteComponentSelect");
  if (!compSelect || !compSelect.value) {
    alert("Add components to this category in Settings → Components first.");
    return;
  }
  const source = (STATE.config.components || []).find(c => c.id === compSelect.value);
  if (!source) return;
  currentQuoteComponents.push({ id: source.id, name: source.name, category: catSelect.value, costKes: source.costKes });
  renderQuoteComponentsList();
}

// ---- Quote tab: Extra fees card ----------------------------------------
// Lists the fees switched on in Settings → Financials & Metrics, each with a
// tick box. Unticking leaves that fee off THIS quote only (the Settings value
// is untouched). Saved with the job so it can be restored later.
function renderQuoteExtraFeesCard() {
  const card = document.getElementById("quoteExtraFeesCard");
  const wrap = document.getElementById("quoteExtraFeesWrap");
  if (!card || !wrap) return;
  const items = (STATE.config.extraFeeLineItems || []).filter((i) => i.enabled);

  // forget exclusions for fees that were deleted or switched off in Settings
  const liveIds = new Set(items.map((i) => i.id));
  currentQuoteExcludedFeeIds.forEach((id) => { if (!liveIds.has(id)) currentQuoteExcludedFeeIds.delete(id); });

  card.style.display = items.length ? "" : "none";
  wrap.innerHTML = items.map((i) => `
    <label style="display:flex; flex-direction:row; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; background: var(--surface-hover); border-radius:8px; cursor:pointer; font-weight:500;">
      <span style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" class="quote-fee-toggle" data-fee-id="${escapeHtml(i.id)}" style="width:auto;" ${currentQuoteExcludedFeeIds.has(i.id) ? "" : "checked"} />
        ${escapeHtml(i.label || "Fee")}
      </span>
      <span style="color: var(--text-secondary);">${i.valueType === "percentage" ? `${Number(i.value) || 0}%` : formatKes(Number(i.value) || 0)}</span>
    </label>
  `).join("");
  wrap.querySelectorAll(".quote-fee-toggle").forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked) currentQuoteExcludedFeeIds.delete(el.dataset.feeId);
      else currentQuoteExcludedFeeIds.add(el.dataset.feeId);
      scheduleLiveProfitPreview();
    });
  });
  scheduleLiveProfitPreview();
}

// ---- Quote tab: Discounts card ----------------------------------------
function formatQuoteDiscountValue(item) {
  return item.type === "percent" ? `${Number(item.value)}%` : formatKes(item.value);
}

// null → can't be worked out yet (no usable parts) so show a dash if any
// discounts exist; otherwise the live-preview result.
function updateQuoteDiscountsTotalDisplay(result) {
  const el = document.getElementById("quoteDiscountsTotal");
  const notesEl = document.getElementById("quoteDiscountsNotes");
  if (!el) return;
  let notes = [];
  if (currentQuoteDiscounts.length === 0) {
    el.textContent = formatKes(0);
  } else if (!result) {
    el.textContent = "—";
  } else {
    el.textContent = formatKes(result.discountsTotal) + (result.capped ? " (capped at subtotal)" : "");
    notes = buildDiscountNotes(result.belowCost, result.minOrderApplied);
  }
  if (notesEl) {
    notesEl.style.display = notes.length ? "block" : "none";
    notesEl.textContent = notes.length ? "⚠ " + notes.join(" ") : "";
  }
}

function renderQuoteDiscountsList() {
  const wrap = document.getElementById("quoteDiscountsListWrap");
  if (!wrap) return;

  if (currentQuoteDiscounts.length === 0) {
    wrap.innerHTML = `<p class="help-text">No discounts added to this quote yet.</p>`;
  } else {
    wrap.innerHTML = `
      <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px;">
        ${currentQuoteDiscounts.map((d, i) => `
          <li style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background: var(--surface-hover); border-radius:8px;">
            <span>${escapeHtml(d.label || "Discount")}</span>
            <span style="display:flex; align-items:center; gap:10px;">
              <strong>−${formatQuoteDiscountValue(d)}</strong>
              <button type="button" class="icon-btn danger remove-quote-discount" data-idx="${i}" title="Remove">${ICON_TRASH}</button>
            </span>
          </li>
        `).join("")}
      </ul>
    `;
    wrap.querySelectorAll(".remove-quote-discount").forEach((el) => {
      el.addEventListener("click", () => {
        currentQuoteDiscounts.splice(Number(el.dataset.idx), 1);
        renderQuoteDiscountsList();
      });
    });
  }

  updateQuoteDiscountsTotalDisplay(liveDiscountPreview);
  scheduleLiveProfitPreview();
}

function addQuoteDiscount() {
  const typeEl = document.getElementById("quoteDiscountType");
  const valueEl = document.getElementById("quoteDiscountValue");
  const labelEl = document.getElementById("quoteDiscountLabel");
  if (!typeEl || !valueEl || !labelEl) return;

  const type = typeEl.value === "fixed" ? "fixed" : "percent";
  const value = Number(valueEl.value);
  if (!(value > 0)) {
    alert("Enter a discount value greater than 0.");
    return;
  }
  if (type === "percent" && value > 100) {
    alert("A percentage discount can't be more than 100%.");
    return;
  }

  currentQuoteDiscounts.push({
    id: `disc-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    label: labelEl.value.trim(),
    type,
    value,
  });
  valueEl.value = "";
  labelEl.value = "";
  renderQuoteDiscountsList();
  valueEl.focus();
}

// Removes a node (at any depth) from the tree in place, cascading to
// whatever subcategories it had. Returns true if something was removed.
function removeCategoryNodeById(list, id) {
  if (!Array.isArray(list)) return false;
  const idx = list.findIndex((n) => n.id === id);
  if (idx !== -1) {
    list.splice(idx, 1);
    return true;
  }
  for (const node of list) {
    if (node.subcategories && removeCategoryNodeById(node.subcategories, id)) return true;
  }
  return false;
}

function countCategoryNodeAndDescendants(node) {
  if (!node) return 0;
  let count = 1;
  (node.subcategories || []).forEach((child) => {
    count += countCategoryNodeAndDescendants(child);
  });
  return count;
}

// Resolves selected category/subcategory/sub-subcategory ids (as chosen
// in a cascading <select> trio) into their names + the most specific
// SKU abbreviation available — what actually gets saved on a job.
function resolveCategorySelection(catId, subId, subSubId) {
  const tree = STATE.config.categories || [];
  const catNode = catId ? findCategoryNodeById(tree, catId) : null;
  const subNode = (catNode && subId) ? (catNode.subcategories || []).find((n) => n.id === subId) : null;
  const subSubNode = (subNode && subSubId) ? (subNode.subcategories || []).find((n) => n.id === subSubId) : null;
  const deepest = subSubNode || subNode || catNode;
  return {
    category: catNode ? catNode.name : "",
    subcategory: subNode ? subNode.name : "",
    subSubcategory: subSubNode ? subSubNode.name : "",
    skuAbbr: deepest ? (deepest.skuAbbr || "") : "",
  };
}

// The reverse: given the names saved on an existing job, finds the ids
// so a cascading <select> trio can be pre-selected to match.
function resolveCategoryIdsFromNames(categoryName, subcategoryName, subSubcategoryName) {
  const tree = STATE.config.categories || [];
  let catId = "", subId = "", subSubId = "";
  const top = tree.find((n) => n.name === categoryName);
  if (top) {
    catId = top.id;
    if (subcategoryName) {
      const sub = (top.subcategories || []).find((n) => n.name === subcategoryName);
      if (sub) {
        subId = sub.id;
        if (subSubcategoryName) {
          const subsub = (sub.subcategories || []).find((n) => n.name === subSubcategoryName);
          if (subsub) subSubId = subsub.id;
        }
      }
    }
  }
  return { catId, subId, subSubId };
}

function populateCategoryLevelSelect(selectEl, nodes, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML =
    `<option value="">${placeholder}</option>` +
    (nodes || []).map((n) => `<option value="${n.id}">${n.name}</option>`).join("");
}

// Wires up a Category -> Subcategory -> Sub-subcategory cascade across
// three <select> elements: picking a category repopulates the
// subcategory list from its children, picking a subcategory repopulates
// the sub-subcategory list, and each level whose parent has no children
// is hidden (via its closest .category-level-wrap). initialIds
// pre-selects an existing job's saved category, e.g. from
// resolveCategoryIdsFromNames().
function wireCategoryCascade(catSelect, subSelect, subSubSelect, initialIds = {}) {
  if (!catSelect) return;
  const tree = STATE.config.categories || [];

  const showWrap = (el, show) => {
    const wrap = el && el.closest(".category-level-wrap");
    if (wrap) wrap.classList.toggle("hidden", !show);
  };

  const refreshSubSub = () => {
    if (!subSubSelect) return;
    const catNode = findCategoryNodeById(tree, catSelect.value);
    const subNode = (catNode && subSelect) ? (catNode.subcategories || []).find((n) => n.id === subSelect.value) : null;
    const nodes = subNode ? (subNode.subcategories || []) : [];
    populateCategoryLevelSelect(subSubSelect, nodes, "— None —");
    showWrap(subSubSelect, nodes.length > 0);
  };

  const refreshSub = () => {
    if (!subSelect) { refreshSubSub(); return; }
    const catNode = findCategoryNodeById(tree, catSelect.value);
    const nodes = catNode ? (catNode.subcategories || []) : [];
    populateCategoryLevelSelect(subSelect, nodes, "— None —");
    showWrap(subSelect, nodes.length > 0);
    refreshSubSub();
  };

  populateCategoryLevelSelect(catSelect, tree, "— No category —");
  catSelect.value = initialIds.catId || "";
  refreshSub();
  if (subSelect) subSelect.value = initialIds.subId || "";
  refreshSubSub();
  if (subSubSelect) subSubSelect.value = initialIds.subSubId || "";

  // Assigned rather than addEventListener'd so re-wiring (every render)
  // doesn't stack duplicate listeners.
  catSelect.onchange = () => {
    refreshSub();
    if (subSelect) subSelect.value = "";
    refreshSubSub();
  };
  if (subSelect) {
    subSelect.onchange = () => {
      if (subSubSelect) subSubSelect.value = "";
      refreshSubSub();
    };
  }
}

// Re-wires every cascading category <select> trio currently in the DOM
// (Quote form + Job Details, if open) after the category tree itself
// changes in Settings. Each keeps whatever it currently has selected.
function refreshAllCategoryCascades() {
  const quoteCat = document.getElementById("categorySelect");
  if (quoteCat) {
    const quoteSub = document.getElementById("subcategorySelect");
    const quoteSubSub = document.getElementById("subSubcategorySelect");
    wireCategoryCascade(quoteCat, quoteSub, quoteSubSub, { catId: quoteCat.value });
  }
  const jobDetailCat = document.getElementById("jobDetailCategorySelect");
  if (jobDetailCat) {
    const jobDetailSub = document.getElementById("jobDetailSubcategorySelect");
    const jobDetailSubSub = document.getElementById("jobDetailSubSubcategorySelect");
    wireCategoryCascade(jobDetailCat, jobDetailSub, jobDetailSubSub, { catId: jobDetailCat.value });
  }
}

function renderCategoriesTable() {
  const tableWrap = document.getElementById("categoriesTableWrap");
  if (!tableWrap) return;

  const tree = STATE.config.categories || [];
  if (tree.length === 0) {
    tableWrap.innerHTML = `<p class="help-text">No categories yet. Add one to start tagging quotes and products.</p>`;
    return;
  }

  const rows = flattenCategoryTree(tree);

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th>SKU Abbreviation</th>
          <th style="width: 96px; text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td style="padding-left: ${12 + r.level * 22}px;">
              ${r.level > 0 ? '<span style="color: var(--text-secondary); margin-right: 4px;">↳</span>' : ""}
              <strong>${r.name}</strong>
            </td>
            <td>${r.skuAbbr || ""}</td>
            <td style="text-align: right; white-space: nowrap;">
              ${r.level < 2 ? `<button type="button" class="icon-btn add-subcategory" data-id="${r.id}" title="Add Subcategory" style="font-size: 0.72rem; padding: 4px 8px;">+ Sub</button>` : ""}
              <button type="button" class="icon-btn danger remove-category" data-id="${r.id}" title="Remove Category">${ICON_TRASH}</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll(".remove-category").forEach((button) => {
    button.addEventListener("click", () => removeCategory(button.dataset.id));
  });
  tableWrap.querySelectorAll(".add-subcategory").forEach((button) => {
    button.addEventListener("click", () => openAddCategoryDrawer(button.dataset.id));
  });

  applyTableFilters();
  refreshQuoteComponentSelectors();
  renderCategoryKitSelect();
}

function removeCategory(id) {
  const tree = STATE.config.categories || [];
  const node = findCategoryNodeById(tree, id);
  if (!node) return;
  const count = countCategoryNodeAndDescendants(node);
  const msg = count > 1
    ? `"${node.name}" has ${count - 1} subcategor${count - 1 === 1 ? "y" : "ies"} under it. Deleting it will remove all of them too. Continue?`
    : `Remove category "${node.name}"?`;
  if (!confirm(msg)) return;
  removeCategoryNodeById(tree, id);
  saveState();
  renderCategoriesTable();
  refreshAllCategoryCascades();
}

// Opens the shared Add Category drawer, either at the top level
// (parentId falsy) or to add a subcategory under an existing node.
function openAddCategoryDrawer(parentId) {
  const parentIdInput = document.getElementById("newCategoryParentId");
  const titleEl = document.getElementById("categoryDrawerTitle");
  const helpEl = document.getElementById("categoryDrawerHelp");
  const nameInput = document.getElementById("newCategoryName");
  const skuInput = document.getElementById("newCategorySkuAbbr");

  if (parentIdInput) parentIdInput.value = parentId || "";
  if (nameInput) nameInput.value = "";
  if (skuInput) skuInput.value = "";

  if (parentId) {
    const parentNode = findCategoryNodeById(STATE.config.categories || [], parentId);
    const parentName = parentNode ? parentNode.name : "";
    if (titleEl) titleEl.textContent = `Add Subcategory to "${parentName}"`;
    if (helpEl) helpEl.textContent = `Add a subcategory under "${parentName}". Leave the abbreviation blank to auto-generate one from the name.`;
  } else {
    if (titleEl) titleEl.textContent = "Add Category";
    if (helpEl) helpEl.textContent = `Add a product category. Leave the abbreviation blank to auto-generate one from the name (same fallback the Sheet uses).`;
  }

  goToPage("add-category");
}

function applyTableFilters() {
  document.querySelectorAll(".table-search").forEach(input => {
    const filter = input.value.toLowerCase();
    const targetId = input.dataset.target;
    const wrap = document.getElementById(targetId);
    if (!wrap) return;
    const tbody = wrap.querySelector("tbody");
    if (!tbody) return;
    tbody.querySelectorAll("tr").forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(filter) ? "" : "none";
    });
  });
}

function editMaterial(code) {
  const mat = STATE.config.materials.find(m => m.code === code);
  if (!mat) return;
  
  document.getElementById("editMaterialCode").value = mat.code;
  document.getElementById("editMaterialBrand").value = mat.brand || "";
  document.getElementById("editMaterialName").value = mat.name || "";
  document.getElementById("editMaterialCost").value = mat.costPerKgKes;
  document.getElementById("editMaterialStock").value = mat.stockKg;
  
  buildProfileOptions(document.getElementById("editMaterialType"));
  document.getElementById("editMaterialType").value = mat.type;
  
  selectedEditMaterialColor = mat.colorHex || "#000000";
  buildColorPalette("editMaterialColorPalette", selectedEditMaterialColor, (hex) => {
    selectedEditMaterialColor = hex;
  });
  
  goToPage("edit-material");
}

function renderEditPrinterQuickStats(printer) {
  const wrap = document.getElementById("editPrinterQuickStats");
  if (!wrap) return;

  const status = printer.status || "Active";
  const statusClass = status === "Retired" ? "status-retired" : status === "Maintenance" ? "status-maintenance" : "status-active";
  const lifePercent = printer.lifespanHours ? Math.min(100, Math.round(((printer.loggedHours || 0) / printer.lifespanHours) * 100)) : 0;
  const buildVol = (printer.buildVolumeX && printer.buildVolumeY && printer.buildVolumeZ)
    ? `${printer.buildVolumeX}×${printer.buildVolumeY}×${printer.buildVolumeZ} mm`
    : "—";
  const accessoryCount = (STATE.config.printerAccessories || []).filter(a => a.printerId === printer.id).length;

  wrap.innerHTML = `
    <div class="printer-quickstat-row"><span>Status</span><span class="status-badge ${statusClass}">${status}</span></div>
    <div class="printer-quickstat-row"><span>Technology</span><span>${printer.technology || "FDM"}</span></div>
    <div class="printer-quickstat-row"><span>Build volume</span><span>${buildVol}</span></div>
    <div class="printer-quickstat-row"><span>Linked parts</span><span>${accessoryCount}</span></div>
    <div>
      <div class="printer-quickstat-row"><span>Lifespan used</span><span>${lifePercent}%</span></div>
      <div class="progress-track mt-4"><div class="progress-fill" style="width:${lifePercent}%;"></div></div>
    </div>
  `;
}

// Fetches live status for a saved printer (must have networkApiType set)
// and renders it into the given container element. Shared by the Edit
// Printer page's "Check Live Status" button and the Printers list's
// per-printer status badges.
async function checkPrinterLiveStatus(printerId, resultEl) {
  if (!resultEl) return;
  resultEl.innerHTML = `<span class="help-text">Checking…</span>`;
  try {
    const res = await fetch(`/api/printer-status?id=${encodeURIComponent(printerId)}`);
    const data = await res.json();
    if (!data.ok) {
      resultEl.innerHTML = `<span class="help-text" style="color: var(--danger, #dc2626);">${data.error || "Couldn't get status."}</span>`;
      return;
    }
    const parts = [`<strong>${data.state}</strong>`];
    if (data.progressPercent != null) parts.push(`${data.progressPercent}%`);
    if (data.fileName) parts.push(data.fileName);
    if (data.nozzleTemp != null) parts.push(`Nozzle ${data.nozzleTemp}°${data.nozzleTarget ? `/${data.nozzleTarget}°` : ""}`);
    if (data.bedTemp != null) parts.push(`Bed ${data.bedTemp}°${data.bedTarget ? `/${data.bedTarget}°` : ""}`);
    resultEl.innerHTML = `<span class="help-text" style="color: var(--success, #059669);">${parts.join(" · ")}</span>`;
  } catch (e) {
    resultEl.innerHTML = `<span class="help-text" style="color: var(--danger, #dc2626);">Couldn't reach the status service — needs QuoteForge's own server.</span>`;
  }
}

function editPrinter(id) {
  const printer = STATE.config.printers.find(p => p.id === id);
  if (!printer) return;
  
  document.getElementById("editPrinterId").value = printer.id;
  document.getElementById("editPrinterName").value = printer.name;
  const editPrinterMfr = document.getElementById("editPrinterManufacturer");
  if (editPrinterMfr) editPrinterMfr.value = printer.manufacturer || "";
  const editPrinterSerial = document.getElementById("editPrinterSerial");
  if (editPrinterSerial) editPrinterSerial.value = printer.serialNumber || "";
  const editPrinterLoc = document.getElementById("editPrinterLocation");
  if (editPrinterLoc) editPrinterLoc.value = printer.location || "";
  const editPrinterTech = document.getElementById("editPrinterTechnology");
  if (editPrinterTech) editPrinterTech.value = printer.technology || "FDM";
  const editPrinterStat = document.getElementById("editPrinterStatus");
  if (editPrinterStat) editPrinterStat.value = printer.status || "Active";
  document.getElementById("editPrinterPower").value = printer.powerWatts;
  document.getElementById("editPrinterPrice").value = printer.printerPurchasePriceKes;
  document.getElementById("editPrinterLifespan").value = printer.lifespanHours;
  const editPrinterPD = document.getElementById("editPrinterPurchaseDate");
  if (editPrinterPD) editPrinterPD.value = printer.purchaseDate || "";
  document.getElementById("editPrinterMaintenance").value = printer.maintenancePerYearKes;
  document.getElementById("editPrinterFailRate").value = printer.failedPrintRatePercent;
  document.getElementById("editPrinterMaxColors").value = printer.maxColors || 1;
  const editPrinterBX = document.getElementById("editPrinterBuildX");
  if (editPrinterBX) editPrinterBX.value = printer.buildVolumeX || 256;
  const editPrinterBY = document.getElementById("editPrinterBuildY");
  if (editPrinterBY) editPrinterBY.value = printer.buildVolumeY || 256;
  const editPrinterBZ = document.getElementById("editPrinterBuildZ");
  if (editPrinterBZ) editPrinterBZ.value = printer.buildVolumeZ || 256;
  const editPrinterLH = document.getElementById("editPrinterLoggedHours");
  if (editPrinterLH) editPrinterLH.value = printer.loggedHours || 0;

  const editApiKeyField = document.getElementById("editPrinterApiKey");
  if (editApiKeyField) editApiKeyField.value = printer.networkApiKey || "";
  const editNetUserField = document.getElementById("editPrinterNetUsername");
  if (editNetUserField) editNetUserField.value = printer.networkUsername || "";
  const editNetPassField = document.getElementById("editPrinterNetPassword");
  if (editNetPassField) editNetPassField.value = printer.networkPassword || "";
  const netSummary = document.getElementById("editPrinterNetworkSummary");
  if (netSummary) {
    netSummary.textContent = printer.networkAddress
      ? `Connected via ${printer.networkApiType} at ${printer.networkAddress}${printer.networkPort ? ":" + printer.networkPort : ""}`
      : "Not connected to a network printer yet — use Scan Network or the Bambu Lab form from Add Printer.";
  }
  const liveStatusResult = document.getElementById("editPrinterLiveStatusResult");
  if (liveStatusResult) liveStatusResult.innerHTML = "";

  renderEditPrinterPhotoPreview();
  renderEditPrinterQuickStats(printer);
  // This is a real, already-saved printer — clear any leftover pending
  // id from an abandoned "Add Printer" session so it doesn't leak into
  // this printer's Linked Printer dropdowns.
  const newPrinterIdField = document.getElementById("newPrinterId");
  if (newPrinterIdField) newPrinterIdField.value = "";
  renderEditPrinterLinkedItems(printer.id);

  goToPage("edit-printer");
}

function editProfile(type) {
  const profile = STATE.config.materialProfiles.find(p => p.type === type);
  if (!profile) return;
  
  document.getElementById("editProfileOriginalType").value = profile.type;
  document.getElementById("editProfileType").value = profile.type;
  const editProfileTech = document.getElementById("editProfileTechnology");
  if (editProfileTech) editProfileTech.value = profile.technology || "FDM";
  document.getElementById("editProfileDensity").value = profile.density || "";
  document.getElementById("editProfilePrintTemp").value = profile.printTemp || "";
  document.getElementById("editProfileBedTemp").value = profile.bedTemp || "";
  document.getElementById("editProfileNotes").value = profile.notes || "";
  
  goToPage("edit-profile");
}

function updateMaterialStock(code, value) {
  const material = STATE.config.materials.find((item) => item.code === code);
  if (!material) return;
  material.stockKg = Math.max(0, value || 0);
  saveState();
  renderInventory();
  if (currentInventoryTypeView === material.type) renderInventoryTypeDetailList(material.type);
  refreshQuotePartMaterialSelects();
}

function removeMaterial(code) {
  STATE.config.materials = STATE.config.materials.filter((item) => item.code !== code);
  saveState();
  
  refreshQuotePartMaterialSelects();
  renderInventory();
}

function removePrinter(id) {
  STATE.config.printers = STATE.config.printers.filter((item) => item.id !== id);
  saveState();
  buildPrinterOptions(document.getElementById("printerSelect"));
  renderPrinters();
  renderPrinterAccessories();
}

function removeProfile(type) {
  STATE.config.materialProfiles = STATE.config.materialProfiles.filter((item) => item.type !== type);
  saveState();
  buildProfileOptions(document.getElementById("newMaterialType"));
  refreshQuotePartMaterialSelects();
  renderProfiles();
}

function removeCustomColor(hex) {
  STATE.config.colors = STATE.config.colors.filter((item) => item.hex !== hex);
  saveState();
  buildColorPalette("materialColorPalette", selectedMaterialColor, (h) => { selectedMaterialColor = h; });
  renderCustomColors();
}

// Collects every STL/model file referenced anywhere in job history (the
// only thing NOT already inside STATE.config/STATE.history) so a backup
// can be truly complete — these files live only in IndexedDB, keyed by
// job.parts[].stl.dbKey, and were previously left out of Export Backup
// entirely, meaning restoring a backup on a new machine gave you every
// job's numbers but silently dropped its attached 3D models.
async function collectAllModelFilesForBackup(statusCb) {
  const dbKeys = new Set();
  STATE.history.forEach((job) => {
    (job.parts || []).forEach((p) => {
      if (p.stl && p.stl.dbKey) dbKeys.add(p.stl.dbKey);
    });
  });

  const files = {};
  const keys = Array.from(dbKeys);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (statusCb) statusCb(`Packing model file ${i + 1}/${keys.length}…`);
    try {
      const blob = await getFileFromDB(key);
      if (!blob) continue;
      const base64Data = await blobToBase64(blob);
      files[key] = { data: base64Data, type: blob.type || "application/octet-stream" };
    } catch (err) {
      console.warn("Could not read model file for backup, skipping:", key, err);
    }
  }
  return files;
}

// Reverse of blobToBase64 — turns a stored base64 string back into a Blob
// so it can be written into IndexedDB on import.
function base64ToBlob(base64Data, mimeType) {
  const byteChars = atob(base64Data);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType || "application/octet-stream" });
}

async function exportConfig() {
  saveState();
  const btn = document.getElementById("exportConfigButton");
  const originalLabel = btn ? btn.textContent : "";
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Packing model files…"; }
    const files = await collectAllModelFilesForBackup((text) => {
      if (btn) btn.textContent = text;
    });

    // version 2: adds embedded IndexedDB model files (STL/3MF/etc) so a
    // single .json backup restores everything — settings, job history,
    // AND every attached model — not just settings + jobs like before.
    const exportData = { version: 2, exportedAt: new Date().toISOString(), config: { ...STATE.config }, history: STATE.history, files };
    const blob = new Blob([JSON.stringify(exportData)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `portable-3d-quote-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Export failed", err);
    alert("Something went wrong while preparing the backup. Check the console for details.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || "Export Backup"; }
  }
}

function importConfig(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || typeof parsed !== "object") {
        alert("Invalid backup file format.");
        return;
      }

      // Newer backups look like { config: {...}, history: [...], files: {...} }.
      // Older backups (from before jobs/files were included) are just the
      // config object directly, or lack `files` — all handled here.
      const incomingConfig = parsed.config && typeof parsed.config === "object" ? parsed.config : parsed;
      const incomingHistory = Array.isArray(parsed.history) ? parsed.history : [];
      const incomingFiles = parsed.files && typeof parsed.files === "object" ? parsed.files : {};

      // Merge against the currently active config (not a blank default) so
      // importing an older/partial backup never wipes out settings that
      // are already working just because that older file predates them.
      STATE.config = mergeStoredConfig(STATE.config, incomingConfig);
      migrateLegacyPaymentMethods(STATE.config.companyInfo);

      let jobsAdded = 0;
      incomingHistory.forEach((job) => {
        if (!STATE.history.some((j) => j.recordedAt === job.recordedAt)) {
          STATE.history.push(job);
          jobsAdded += 1;
        }
      });
      STATE.history.sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));

      const fileKeys = Object.keys(incomingFiles);
      let filesRestored = 0;
      for (const key of fileKeys) {
        try {
          const entry = incomingFiles[key];
          const blob = base64ToBlob(entry.data, entry.type);
          await saveFileInDB(key, blob);
          filesRestored += 1;
        } catch (err) {
          console.warn("Could not restore model file from backup:", key, err);
        }
      }

      saveState();
      const jobsNote = incomingHistory.length
        ? ` ${jobsAdded} job(s) imported (${incomingHistory.length - jobsAdded} already present, skipped).`
        : " (This backup had no job history in it — only settings were restored.)";
      const filesNote = fileKeys.length
        ? ` ${filesRestored}/${fileKeys.length} attached model file(s) restored.`
        : "";
      alert("Settings imported successfully!" + jobsNote + filesNote + " Reloading...");
      window.location.reload();
    } catch (err) {
      alert("Error parsing the backup file. Ensure it is valid JSON.");
      console.error(err);
    }
  };
  reader.readAsText(file);
}

// ---------- Reports tab + CSV export ----------
// All the maths lives in reports.js (pure functions, unit-tested). This is
// just the screen: pick a period, see the tables, download any of them.
const reportState = { period: "this_year", from: "", to: "", basis: "printed" };

function reportMaterialLabel(code) {
  const m = (STATE.config.materials || []).find((x) => x.code === code);
  return m ? `${m.brand ? m.brand + " " : ""}${m.name}` : code;
}

function getReportData() {
  const R = window.QuoteForgeReports;
  const range = reportState.period === "custom"
    ? { from: reportState.from, to: reportState.to }
    : R.presetRange(reportState.period);
  const base = reportState.basis === "printed" ? STATE.history.filter(R.isPrinted) : STATE.history.slice();
  return {
    range,
    jobs: R.filterByRange(base, range.from, range.to, reportState.basis),
    createdInRange: R.filterByRange(STATE.history, range.from, range.to, "all"),
  };
}

// Downloads text as a file. A BOM is added so Excel reads accents/symbols correctly.
function downloadTextFile(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["\ufeff" + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvFileName(kind, range) {
  const part = (v) => v || "all";
  return `quoteforge-${kind}-${part(range && range.from)}_${part(range && range.to)}.csv`.replace(/[^\w.\-]+/g, "_");
}

function buildReportCsv(kind) {
  const R = window.QuoteForgeReports;
  const { range, jobs, createdInRange } = getReportData();
  switch (kind) {
    case "jobs": return R.buildJobsCsv(jobs, { materialName: reportMaterialLabel });
    case "payments": return R.buildPaymentsCsv(STATE.history, range.from, range.to);
    case "monthly": return R.buildMonthlyCsv(R.monthlyTable(jobs, STATE.history, reportState.basis, range.from, range.to));
    case "customer": return R.buildGroupCsv("Customer", R.byCustomer(jobs));
    case "category": return R.buildGroupCsv("Category", R.byCategory(jobs));
    case "material": return R.buildMaterialCsv(R.byMaterial(jobs, reportMaterialLabel));
    case "outstanding": return R.buildOutstandingCsv(R.outstandingList(STATE.history));
    case "pipeline": {
      const S = R.summarize(createdInRange);
      return R.toCsv(
        [{ label: "Stage", key: "label" }, { label: "Jobs", key: "count" }, { label: "Total incl " + taxLabel(), key: "total" }, { label: "Material (g)", get: (r) => Math.round(r.grams) }],
        R.STAGES.map((st) => ({ label: st.label, ...S.stages[st.key] }))
      );
    }
    default: return "";
  }
}

function exportReport(kind) {
  const { range } = getReportData();
  downloadTextFile(csvFileName(kind, range), buildReportCsv(kind));
}

function ensureReportControls() {
  const root = document.getElementById("reportsRoot");
  if (!root || document.getElementById("reportPeriod")) return;
  root.innerHTML = `
    <div class="report-controls">
      <label>Period
        <select id="reportPeriod">
          <option value="this_month">This month</option>
          <option value="last_month">Last month</option>
          <option value="last_90">Last 90 days</option>
          <option value="this_year">This year</option>
          <option value="last_year">Last year</option>
          <option value="all">All time</option>
          <option value="custom">Custom…</option>
        </select>
      </label>
      <label id="reportFromWrap" style="display:none;">From<input type="date" id="reportFrom" /></label>
      <label id="reportToWrap" style="display:none;">To<input type="date" id="reportTo" /></label>
      <label>Show
        <select id="reportBasis">
          <option value="printed">Printed jobs (Printing, Invoiced, Completed)</option>
          <option value="all">All jobs, including quotes</option>
        </select>
      </label>
      <button type="button" class="secondary report-export" data-export="jobs">⬇ Jobs CSV</button>
      <button type="button" class="secondary report-export" data-export="payments">⬇ Payments CSV</button>
    </div>
    <div id="reportsResults"></div>
  `;
  document.getElementById("reportPeriod").value = reportState.period;
  document.getElementById("reportBasis").value = reportState.basis;
  const refresh = () => renderReports();
  document.getElementById("reportPeriod").addEventListener("change", (e) => { reportState.period = e.target.value; refresh(); });
  document.getElementById("reportBasis").addEventListener("change", (e) => { reportState.basis = e.target.value; refresh(); });
  document.getElementById("reportFrom").addEventListener("change", (e) => { reportState.from = e.target.value; refresh(); });
  document.getElementById("reportTo").addEventListener("change", (e) => { reportState.to = e.target.value; refresh(); });
  root.addEventListener("click", (e) => {
    const btn = e.target.closest(".report-export");
    if (btn) exportReport(btn.dataset.export);
  });
}

function renderReports() {
  const R = window.QuoteForgeReports;
  if (!R) return;
  ensureReportControls();
  const results = document.getElementById("reportsResults");
  if (!results) return;

  const custom = reportState.period === "custom";
  document.getElementById("reportFromWrap").style.display = custom ? "" : "none";
  document.getElementById("reportToWrap").style.display = custom ? "" : "none";

  const { range, jobs, createdInRange } = getReportData();
  const targetPct = Number(STATE.config.targetMarginPercent) || 0;
  const S = R.summarize(jobs, { targetMarginPct: targetPct });
  const allTime = R.summarize(STATE.history);
  const cashIn = R.paymentsInRange(STATE.history, range.from, range.to).reduce((sum, p) => sum + p.amount, 0);
  const grams = (g) => `${Math.round(g).toLocaleString("en-US")} g`;
  const num = (n) => Math.round(n).toLocaleString("en-US");
  const money = (n) => formatKes(n);
  const pct = (x) => (x == null ? "—" : `${x.toFixed(1)}%`);
  const tile = (label, value, sub, cls = "") => `<div class="stat-tile ${cls}"><span class="stat-tile-label">${label}</span><strong class="stat-tile-value">${value}</strong>${sub ? `<span class="stat-tile-sub">${sub}</span>` : ""}</div>`;
  const neg = (n) => (n < 0 ? " report-neg" : "");
  const rangeText = range.from || range.to ? `${range.from || "start"} → ${range.to || "today"}` : "all time";

  const block = (title, exportKey, headers, body, foot = "", note = "") => `
    <div class="report-block">
      <div class="report-block-head"><h3>${title}</h3><button type="button" class="secondary report-export" data-export="${exportKey}" style="padding:4px 10px; font-size:0.8rem;">⬇ CSV</button></div>
      ${note ? `<p class="help-text" style="margin:0 0 8px;">${note}</p>` : ""}
      <div class="report-scroll"><table class="report-table">
        <thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${h.label}</th>`).join("")}</tr></thead>
        <tbody>${body || `<tr><td colspan="${headers.length}" style="color: var(--text-muted);">Nothing in this period.</td></tr>`}</tbody>
        ${foot ? `<tfoot>${foot}</tfoot>` : ""}
      </table></div>
    </div>`;

  // ---- monthly
  const monthly = R.monthlyTable(jobs, STATE.history, reportState.basis, range.from, range.to);
  const maxRev = Math.max(1, ...monthly.map((r) => r.revenueExVat));
  const monthlyBody = monthly.map((r) => `<tr>
      <td>${escapeHtml(r.label)}</td><td class="num">${r.jobs}</td><td class="num">${money(r.revenueExVat)}</td>
      <td class="num${neg(r.profit)}">${r.jobs ? money(r.profit) : "—"}</td><td class="num">${pct(r.marginPct)}</td>
      <td class="num">${grams(r.grams)}</td><td class="num">${money(r.received)}</td>
      <td class="report-bar-cell"><span class="report-bar" style="width:${Math.round((r.revenueExVat / maxRev) * 100)}%"></span></td></tr>`).join("");
  const sum = (key) => monthly.reduce((a, r) => a + r[key], 0);
  const monthlyFoot = monthly.length ? `<tr><td>Total</td><td class="num">${sum("jobs")}</td><td class="num">${money(sum("revenueExVat"))}</td><td class="num${neg(sum("profit"))}">${money(sum("profit"))}</td><td class="num">${pct(S.marginPct)}</td><td class="num">${grams(sum("grams"))}</td><td class="num">${money(sum("received"))}</td><td></td></tr>` : "";

  // ---- by customer / category / material
  const groupRows = (rows, limit) => rows.slice(0, limit).map((r) => `<tr>
      <td>${escapeHtml(r.label)}</td><td class="num">${r.jobs}</td><td class="num">${money(r.revenueExVat)}</td>
      <td class="num${neg(r.profit)}">${money(r.profit)}</td><td class="num">${pct(r.marginPct)}</td>
      <td class="num">${money(r.paid)}</td><td class="num${r.outstanding > 0 ? " report-neg" : ""}">${money(r.outstanding)}</td></tr>`).join("");
  const groupHeaders = (first) => [{ label: first }, { label: "Jobs", num: 1 }, { label: "Revenue ex " + taxLabel(), num: 1 }, { label: "Profit", num: 1 }, { label: "Margin", num: 1 }, { label: "Paid", num: 1 }, { label: "Owing", num: 1 }];
  const customers = R.byCustomer(jobs);
  const categories = R.byCategory(jobs);
  const materials = R.byMaterial(jobs, reportMaterialLabel);
  const materialBody = materials.slice(0, 20).map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="num">${r.jobs}</td><td class="num">${grams(r.grams)}</td></tr>`).join("");

  // ---- pipeline for the period (by when jobs were created)
  const P = R.summarize(createdInRange);
  const pipelineBody = R.STAGES.map((st) => `<tr><td>${st.label}${R.PRINTED_STAGES.includes(st.key) ? "" : ' <span style="color:var(--text-muted);">(not printed)</span>'}</td><td class="num">${P.stages[st.key].count}</td><td class="num">${money(P.stages[st.key].total)}</td><td class="num">${grams(P.stages[st.key].grams)}</td></tr>`).join("");
  const pipelineNote = P.sentQuotes > 0 ? `${P.wonQuotes} of ${P.sentQuotes} quotes sent in this period have been printed (${P.winRatePct.toFixed(0)}%).` : "No quotes sent in this period.";

  // ---- outstanding (as of today, not limited to the period)
  const owing = R.outstandingList(STATE.history);
  const owingBody = owing.slice(0, 25).map((o) => `<tr><td>${escapeHtml(o.invoiceNumber || o.jobNumber || o.project)}</td><td>${escapeHtml(o.customer || "—")}</td><td>${escapeHtml(o.date)}</td><td class="num">${o.daysOld == null ? "—" : o.daysOld}</td><td class="num">${money(o.total)}</td><td class="num">${money(o.paid)}</td><td class="num report-neg">${money(o.balance)}</td></tr>`).join("");

  results.innerHTML = `
    <p class="help-text" style="margin:8px 0 12px;">${reportState.basis === "printed" ? "Printed jobs" : "All jobs"} · ${escapeHtml(rangeText)} · printed jobs are dated when they went to print. Revenue is ex ${taxLabel()}.</p>
    <div class="stats-grid">
      ${tile("Revenue ex " + taxLabel(), money(S.all.revenueExVat), `${S.count} job${S.count === 1 ? "" : "s"} · ${money(S.all.total)} incl ${taxLabel()}`)}
      ${tile("Profit", S.profitJobs > 0 ? money(S.profit) : "—", S.profitJobs > 0 ? `${pct(S.marginPct)} margin on ${S.profitJobs} printed job${S.profitJobs === 1 ? "" : "s"}` : "needs printed jobs with costs", S.profit < 0 ? "stat-warn" : "")}
      ${tile("Cash received", money(cashIn), "payments dated in this period", cashIn > 0 ? "stat-good" : "")}
      ${tile("Owing now", money(allTime.outstanding), allTime.outstandingJobs > 0 ? `${allTime.outstandingJobs} invoiced job${allTime.outstandingJobs === 1 ? "" : "s"}, all time` : "nothing owing", allTime.outstanding > 0 ? "stat-warn" : "")}
      ${tile("Material", grams(S.all.grams), `${Math.round(S.all.hours * 10) / 10} h print time`)}
      ${tile("Average job", S.count ? money(S.all.total / S.count) : "—", "incl " + taxLabel())}
      ${targetPct > 0 ? tile("Below target margin", String(S.belowTarget), `of ${S.marginJobs} printed job${S.marginJobs === 1 ? "" : "s"} · target ${targetPct}%`, S.belowTarget > 0 ? "stat-warn" : "stat-good") : ""}
    </div>

    ${block("By month", "monthly", [{ label: "Month" }, { label: "Jobs", num: 1 }, { label: "Revenue ex " + taxLabel(), num: 1 }, { label: "Profit", num: 1 }, { label: "Margin", num: 1 }, { label: "Material", num: 1 }, { label: "Cash received", num: 1 }, { label: "" }], monthlyBody, monthlyFoot, "Revenue and profit follow the jobs; cash received follows the day each payment was recorded.")}
    ${block("By customer", "customer", groupHeaders("Customer"), groupRows(customers, 15), "", customers.length > 15 ? `Top 15 of ${customers.length} shown — the CSV has all of them.` : "")}
    ${block("By material", "material", [{ label: "Material" }, { label: "Jobs", num: 1 }, { label: "Used", num: 1 }], materialBody, "", materials.length > 20 ? `Top 20 of ${materials.length} shown — the CSV has all of them.` : "Grams include every set in a job.")}
    ${block("By category", "category", groupHeaders("Category"), groupRows(categories, 15))}
    ${block("Pipeline in this period", "pipeline", [{ label: "Stage" }, { label: "Jobs", num: 1 }, { label: "Value incl " + taxLabel(), num: 1 }, { label: "Material", num: 1 }], pipelineBody, "", pipelineNote)}
    ${block("Outstanding invoices", "outstanding", [{ label: "Invoice / job" }, { label: "Customer" }, { label: "Date" }, { label: "Days", num: 1 }, { label: "Total", num: 1 }, { label: "Paid", num: 1 }, { label: "Balance", num: 1 }], owingBody, "", owing.length > 25 ? `Oldest 25 of ${owing.length} shown — the CSV has all of them.` : "Invoiced and completed jobs that still owe money, oldest first. Not limited to the period above.")}
  `;
}

function initReportsTab() {
  const btn = document.getElementById("exportJobsListCsvBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      const R = window.QuoteForgeReports;
      const jobs = getFilteredSortedHistory().map((r) => r.job);
      if (!jobs.length) { alert("There are no jobs to export."); return; }
      downloadTextFile(`quoteforge-jobs-${todayLocalIsoDate()}.csv`, R.buildJobsCsv(jobs, { materialName: reportMaterialLabel }));
    });
  }
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    if (panel.id === `tab-${tabName}`) panel.classList.remove("hidden");
    else panel.classList.add("hidden");
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    if (button.dataset.tab === tabName) button.classList.add("active");
    else button.classList.remove("active");
  });
  if (tabName === "reports") renderReports();
}

// ---------- Add/Edit form pages ----------
// Add/Edit forms (materials, printers, customers, etc.) live as their own
// full-screen pages (same "tab-panel" mechanism as Job Details or the
// Inventory type-detail page) rather than slide-out drawers. goToPage()
// pushes "how to get back to where we just were" onto a stack, and the
// "← Back" button (and the Save button, which calls closeDrawers() under
// the hood) pops and runs the most recent one. A stack (not a single
// remembered action) matters once pages nest — e.g. Printers → Edit
// Printer → "+ Add" Accessory → Back → Back — otherwise the second Back
// press re-shows the page you're already on instead of going further back.
let pageReturnStack = [];

function activateSettingsPane(paneId) {
  document.querySelectorAll(".settings-nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".settings-pane").forEach((p) => p.classList.add("hidden"));
  const btn = document.querySelector(`.settings-nav-btn[data-pane="${paneId}"]`);
  if (btn) btn.classList.add("active");
  const pane = document.getElementById(paneId);
  if (pane) pane.classList.remove("hidden");
}

// Sub-tab bar inside the Printers page (Printers / Accessories & Parts /
// Categories) — same show-one-hide-rest pattern as activateSettingsPane,
// just keyed off data-printer-pane instead of data-pane.
function activatePrinterPane(paneId) {
  document.querySelectorAll(".subtab-btn[data-printer-pane]").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".subtab-panel").forEach((p) => p.classList.add("hidden"));
  const btn = document.querySelector(`.subtab-btn[data-printer-pane="${paneId}"]`);
  if (btn) btn.classList.add("active");
  const pane = document.getElementById(paneId);
  if (pane) pane.classList.remove("hidden");
}

function captureReturnAction() {
  const activePanel = document.querySelector(".tab-panel:not(.hidden)");
  const tabName = activePanel ? activePanel.id.replace(/^tab-/, "") : "quote";

  if (tabName === "settings") {
    const activePaneBtn = document.querySelector(".settings-nav-btn.active");
    const paneId = activePaneBtn ? activePaneBtn.dataset.pane : null;
    return () => {
      setActiveTab("settings");
      if (paneId) activateSettingsPane(paneId);
    };
  }

  if (tabName === "printers") {
    const activePrinterPaneBtn = document.querySelector(".subtab-btn[data-printer-pane].active");
    const printerPaneId = activePrinterPaneBtn ? activePrinterPaneBtn.dataset.printerPane : null;
    return () => {
      setActiveTab("printers");
      if (printerPaneId) activatePrinterPane(printerPaneId);
    };
  }

  return () => setActiveTab(tabName);
}

function goToPage(tabName) {
  pageReturnStack.push(captureReturnAction());
  setActiveTab(tabName);
  window.scrollTo(0, 0);
}

// Kept as the single "go back / done" call so every existing Save-button
// handler (which calls closeDrawers() after saving) keeps working unchanged.
function closeDrawers() {
  const returnAction = pageReturnStack.pop() || (() => setActiveTab("quote"));
  returnAction();
  window.scrollTo(0, 0);
}

// Real slide-in drawer overlays (Add/Edit Part, Add/Edit Accessory) —
// separate from the page-navigation "drawer" naming above, which is
// really just full tab-panel pages. These open on top of whatever page
// is showing instead of navigating away from it.
function openAppDrawer(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.add("open");
}
function closeAppDrawer(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.remove("open");
}
function closeAllAppDrawers() {
  document.querySelectorAll(".app-drawer-overlay.open").forEach((overlay) => {
    overlay.classList.remove("open");
  });
}

async function loadConfig() {
  let loadedConfig = null;
  let statusText = "Using built-in defaults — edit config.json for custom values.";

  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) throw new Error("config.json not found");
    const data = await res.json();
    loadedConfig = data;
    statusText = "Configuration loaded from config.json";
  } catch (error) {
    loadedConfig = {};
  }

  const baseConfig = {
    ...DEFAULT_CONFIG,
    ...loadedConfig,
    printerSettings: {
      ...DEFAULT_CONFIG.printerSettings,
      ...(loadedConfig.printerSettings || {}),
    },
  };

  const storedState = await loadStoredState();
  if (storedState?.config) {
    STATE.config = mergeStoredConfig(baseConfig, storedState.config);
    statusText = "Loaded saved browser settings and inventory.";
  } else {
    STATE.config = baseConfig;
  }

  migrateLegacyPaymentMethods(STATE.config.companyInfo);

  // Swap any {{CUR}} placeholders in the static HTML for the configured
  // currency code now that config is loaded (runs again whenever the
  // currency is changed later in Settings).
  applyCurrencyLabels();

  // First run: nothing has been set up yet. Show the setup wizard instead
  // of the main app until it's completed.
  if (!STATE.config.setupComplete) {
    showSetupWizard();
  }

  STATE.history = Array.isArray(storedState?.history) ? storedState.history : [];
  
  STATE.history.forEach(j => {
    if (!j.status) j.status = "completed"; 
    // Data migration for old single-material history
    if (j.materialCode && !j.parts) {
      j.parts = [{ materialCode: j.materialCode, weightGrams: j.weightGrams }];
    }
  });

  const statusPanel = document.getElementById("statusPanel");
  if (statusPanel) statusPanel.textContent = statusText;

  buildPrinterOptions(document.getElementById("printerSelect"));
  buildProfileOptions(document.getElementById("newMaterialType"));
  wireCategoryCascade(
    document.getElementById("categorySelect"),
    document.getElementById("subcategorySelect"),
    document.getElementById("subSubcategorySelect")
  );
  
  const container = document.getElementById("quotePartsContainer");
  if (container && container.children.length === 0) {
    addQuotePartRow();
  }
  
  selectedMaterialColor = "#000000";
  buildColorPalette("materialColorPalette", selectedMaterialColor, (hex) => { selectedMaterialColor = hex; });
  
  setFinanceInputs();
  renderFeeLineItems();
  renderCustomOverheads();
  renderCustomFacilityMetrics();
  renderCustomPricingMetrics();
  renderBulkDiscountTiers();
  renderComponentsTable();
  renderComponentCategoriesTable();
  renderAccessoryCategoriesTable();
  renderCategoryKitSelect();
  refreshQuoteComponentSelectors();
  renderQuoteComponentsList();
  renderQuoteDiscountsList();
  renderQuoteExtraFeesCard();
  initReportsTab();
  const statusEl = document.getElementById("statusPanel");
  if (statusEl && window.MutationObserver) {
    const syncTitle = () => { statusEl.title = statusEl.textContent; };
    new MutationObserver(syncTitle).observe(statusEl, { childList: true, characterData: true, subtree: true });
    syncTitle();
  }
  setCompanyInfoInputs();
  refreshHeaderBranding();
  setIntegrationInputs();
  // Live Sync (Firebase) was removed — drop its leftover settings so old
  // saves and backups don't keep carrying a Firebase config around.
  ["firebaseConfigJson", "firebaseSyncEnabled", "firebaseInitialUploadDone"].forEach((k) => { delete STATE.config[k]; });
  setPrintAvailability(false);
  renderInventory();
  renderPrinters();
  renderPrinterAccessories();
  renderProfiles();
  renderCustomColors();
  renderCategoriesTable();
  renderCustomers();
  buildCustomerOptions(document.getElementById("quoteCustomer"));
  renderPrintHistory();

  // Auto-sync anything pending as soon as the app opens — runs in the
  // background so it doesn't block the UI from becoming interactive.
  syncAllJobs("open").catch(err => console.error("Auto-sync on open failed", err));
}

// Common ISO 4217 currency codes offered as quick-picks in setup — the
// user can also type any other code by hand, so this list is just a
// convenience shortlist, not a restriction.
const COMMON_CURRENCIES = [
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "KES", name: "Kenyan Shilling" },
  { code: "NGN", name: "Nigerian Naira" },
  { code: "ZAR", name: "South African Rand" },
  { code: "INR", name: "Indian Rupee" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "AED", name: "UAE Dirham" },
  { code: "OTHER", name: "Other (type code)" },
];

// Country → currency, used only to pre-fill the setup wizard's currency
// picker from the browser's own locale (e.g. "en-KE" → KE → KES). This is
// a starting suggestion the user can freely change before finishing setup
// — it never runs again after setup and never restricts which currency
// they can pick.
const COUNTRY_TO_CURRENCY = {
  US: "USD", GB: "GBP", IE: "EUR", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR",
  PT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", FI: "EUR", GR: "EUR",
  KE: "KES", NG: "NGN", GH: "GHS", UG: "UGX", TZ: "TZS", ZA: "ZAR",
  IN: "INR", CA: "CAD", AU: "AUD", NZ: "AUD", JP: "JPY", CN: "CNY",
  BR: "BRL", MX: "MXN", AE: "AED", PH: "PHP", PK: "PKR", EG: "EGP",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", TR: "TRY",
  SG: "SGD", MY: "MYR", ID: "IDR", TH: "THB", VN: "VND", SA: "SAR",
  IL: "ILS", RU: "RUB", KR: "KRW", RW: "RWF", ET: "ETB", ZM: "ZMW",
};

// Reads the browser's locale (e.g. from navigator.languages) and returns a
// best-guess currency code, or null if nothing usable is found. Purely a
// convenience pre-fill for the setup wizard — never applied automatically
// without the user seeing and confirming it.
function guessCurrencyFromLocale() {
  try {
    const locales = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language].filter(Boolean);
    for (const loc of locales) {
      const region = new Intl.Locale(loc).maximize().region;
      if (region && COUNTRY_TO_CURRENCY[region]) return COUNTRY_TO_CURRENCY[region];
    }
  } catch (e) {
    // Intl.Locale unsupported or locale string unparsable — fall through.
  }
  return null;
}

// Builds/refreshes the Settings → Company Details currency dropdown (same
// shortlist as the setup wizard, plus "Other" for any ISO code not
// listed) and selects whatever's currently configured. Wires up the
// select↔custom-input toggle once per call, which is cheap and safe since
// setCompanyInfoInputs() re-renders this whenever the Settings pane opens.
function populateCompanyCurrencySelect() {
  const select = document.getElementById("companyCurrencyCodeSelect");
  const custom = document.getElementById("companyCurrencyCodeCustom");
  if (!select || !custom) return;

  const current = getCurrencyCode();
  const inList = COMMON_CURRENCIES.some((c) => c.code === current);

  select.innerHTML = COMMON_CURRENCIES.map(
    (c) => `<option value="${c.code}" ${c.code === current ? "selected" : ""}>${c.code} — ${c.name}</option>`
  ).join("");

  if (inList) {
    select.value = current;
    custom.style.display = "none";
    custom.value = "";
  } else {
    select.value = "OTHER";
    custom.style.display = "block";
    custom.value = current;
  }

  select.onchange = () => {
    custom.style.display = select.value === "OTHER" ? "block" : "none";
  };
}

// Shown on first launch (STATE.config.setupComplete === false) instead of
// letting the user into an app pre-filled with someone else's business
// data. Collects just enough to make the app usable — currency, business
// name, and tax rate — everything else (materials, printers, categories)
// is added afterward from an empty Settings area.
function showSetupWizard() {
  const existing = document.getElementById("setupWizardOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "setup-wizard-overlay";
  overlay.id = "setupWizardOverlay";

  const guessedCurrency = guessCurrencyFromLocale();
  const guessedInList = guessedCurrency && COMMON_CURRENCIES.some((c) => c.code === guessedCurrency);

  const currencyOptions = COMMON_CURRENCIES.map(
    (c) => `<option value="${c.code}" ${c.code === guessedCurrency ? "selected" : ""}>${c.code} — ${c.name}</option>`
  ).join("");

  overlay.innerHTML = `
    <div class="setup-wizard-panel">
      <h2>Welcome — let's set things up</h2>
      <p class="setup-sub">A one-time setup. Everything here can be changed later in Settings.</p>

      <label>Business / studio name
        <input type="text" id="setupBusinessName" placeholder="e.g. Acme 3D Prints" />
      </label>

      <label>Currency
        <select id="setupCurrencySelect">${currencyOptions}</select>
      </label>
      <input type="text" id="setupCurrencyCustom" placeholder="Enter currency code, e.g. CHF" style="display:${guessedInList ? "none" : (guessedCurrency ? "block" : "none")}; margin-bottom:16px;" ${guessedCurrency && !guessedInList ? `value="${guessedCurrency}"` : ""} />
      <p class="setup-hint">${guessedCurrency ? `Pre-filled based on your browser's region (${guessedCurrency}) — change it if that's not right.` : "Used for every price and quote in the app. Any ISO currency code works."}</p>

      <div class="setup-row">
        <label>Tax rate (%)
          <input type="number" id="setupVatRate" value="0" min="0" max="100" step="0.5" />
        </label>
        <label>Profit margin (%)
          <input type="number" id="setupProfitMargin" value="40" min="0" max="500" step="1" />
        </label>
      </div>

      <div class="setup-actions">
        <button type="button" class="secondary" id="setupSkipBtn">Skip for now</button>
        <button type="button" class="primary" id="setupFinishBtn">Get started</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const select = document.getElementById("setupCurrencySelect");
  const custom = document.getElementById("setupCurrencyCustom");
  if (guessedCurrency && !guessedInList) select.value = "OTHER";
  select.addEventListener("change", () => {
    custom.style.display = select.value === "OTHER" ? "block" : "none";
  });

  const finish = () => {
    const name = document.getElementById("setupBusinessName").value.trim();
    let currency = select.value === "OTHER"
      ? custom.value.trim().toUpperCase()
      : select.value;
    if (!currency) currency = "USD";
    const vat = parseFloat(document.getElementById("setupVatRate").value) || 0;
    const margin = parseFloat(document.getElementById("setupProfitMargin").value) || 0;

    STATE.config.setupComplete = true;
    STATE.config.currencyCode = currency;
    if (!STATE.config.companyInfo) STATE.config.companyInfo = { ...DEFAULT_CONFIG.companyInfo };
    STATE.config.companyInfo.name = name;
    STATE.config.vatRatePercent = vat;
    STATE.config.profitMarginPercent = margin;
    if (STATE.config.printerSettings) {
      STATE.config.printerSettings.vatRatePercent = vat;
      STATE.config.printerSettings.profitMarginPercent = margin;
    }

    applyCurrencyLabels();
    if (typeof saveState === "function") saveState();
    if (typeof setCompanyInfoInputs === "function") setCompanyInfoInputs();
    if (typeof refreshHeaderBranding === "function") refreshHeaderBranding();
    if (typeof setFinanceInputs === "function") setFinanceInputs();

    overlay.remove();
  };

  document.getElementById("setupFinishBtn").addEventListener("click", finish);
  document.getElementById("setupSkipBtn").addEventListener("click", () => {
    // Skipping still marks setup complete (so the wizard doesn't nag every
    // reload) but leaves currency at the USD fallback until changed in
    // Settings.
    STATE.config.setupComplete = true;
    if (!STATE.config.currencyCode) STATE.config.currencyCode = "USD";
    applyCurrencyLabels();
    applyPaymentMethodRegionOrdering();
    if (typeof saveState === "function") saveState();
    overlay.remove();
  });
}

function installEventListeners() {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.tab) setActiveTab(button.dataset.tab);
    });
  });

  document.querySelectorAll(".settings-nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.pane) activateSettingsPane(button.dataset.pane);
    });
  });

  document.querySelectorAll(".subtab-btn[data-printer-pane]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.printerPane) activatePrinterPane(button.dataset.printerPane);
    });
  });

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.page) goToPage(button.dataset.page);
    });
  });

  const addCategoryTopBtn = document.getElementById("addCategoryTopBtn");
  if (addCategoryTopBtn) {
    addCategoryTopBtn.addEventListener("click", () => openAddCategoryDrawer(null));
  }

  const invTypeBackBtn = document.getElementById("inventoryTypeBackButton");
  if (invTypeBackBtn) {
    invTypeBackBtn.addEventListener("click", () => {
      currentInventoryTypeView = null;
      setActiveTab("inventory");
    });
  }

  const jobDetailBackBtn = document.getElementById("jobDetailBackButton");
  if (jobDetailBackBtn) {
    jobDetailBackBtn.addEventListener("click", () => {
      STATE.currentJobDetailIndex = null;
      // If we arrived here from a customer's profile, go back there
      // instead of always landing on the general Jobs list.
      if (STATE.currentCustomerDetailId) {
        viewCustomerDetail(STATE.currentCustomerDetailId);
      } else {
        setActiveTab("history");
      }
    });
  }

  const customerDetailBackBtn = document.getElementById("customerDetailBackButton");
  if (customerDetailBackBtn) {
    customerDetailBackBtn.addEventListener("click", () => {
      STATE.currentCustomerDetailId = null;
      setActiveTab("customers");
    });
  }

  const invTypeAddBtn = document.getElementById("inventoryTypeAddButton");
  if (invTypeAddBtn) {
    invTypeAddBtn.addEventListener("click", () => {
      const typeSelect = document.getElementById("newMaterialType");
      if (typeSelect && currentInventoryTypeView) typeSelect.value = currentInventoryTypeView;
      goToPage("add-material");
    });
  }

  // "← Back" buttons on every Add/Edit page return to wherever the user
  // came from (see captureReturnAction/goToPage above).
  document.querySelectorAll(".page-back-button").forEach((button) => {
    button.addEventListener("click", () => closeDrawers());
  });

  document.getElementById("calculateButton").addEventListener("click", (event) => {
    event.preventDefault();
    renderWeightEstimate();
  });

  // Live profit preview: recompute (debounced) on any change within the
  // quote form — part rows, quantity, fees, printer choice, etc. — using
  // event delegation so it also covers part rows added later.
  const quoteFormsSection = document.getElementById("quoteForms");
  if (quoteFormsSection) {
    quoteFormsSection.addEventListener("input", scheduleLiveProfitPreview);
    quoteFormsSection.addEventListener("change", scheduleLiveProfitPreview);
  }
  
  document.getElementById("addQuotePartBtn").addEventListener("click", () => {
    addQuotePartRow();
  });

  const multiPartImportBtn = document.getElementById("multiPartImportBtn");
  const multiPartImportInput = document.getElementById("multiPartImportInput");
  if (multiPartImportBtn && multiPartImportInput) {
    multiPartImportBtn.addEventListener("click", () => multiPartImportInput.click());
    multiPartImportInput.addEventListener("change", async () => {
      const file = multiPartImportInput.files && multiPartImportInput.files[0];
      multiPartImportInput.value = ""; // reset so re-selecting the same file re-fires change
      if (!file) return;

      const originalText = multiPartImportBtn.textContent;
      multiPartImportBtn.disabled = true;
      multiPartImportBtn.textContent = "Reading file…";
      try {
        if (typeof parseMultiPartFile !== "function") {
          throw new Error("Multi-part import isn't available — multi-part-import.js didn't load.");
        }
        const parts = await parseMultiPartFile(file);
        showMultiPartImportReview(parts, file.name);
      } catch (e) {
        alert(e.message || "Couldn't read that file.");
      }
      multiPartImportBtn.disabled = false;
      multiPartImportBtn.textContent = originalText;
    });
  }

  document.getElementById("printerSelect").addEventListener("change", (e) => {
    // Re-filter every part row's Material dropdown to the newly selected
    // printer's Technology (FDM/Resin/SLS) — any row on a now-incompatible
    // material falls back automatically instead of quoting an impossible
    // printer/material combination.
    refreshQuotePartMaterialSelects();
  });

  document.getElementById("postProcessingToggle").addEventListener("change", (e) => {
    const fields = document.getElementById("postProcessFields");
    if (e.target.value === "true") {
      fields.classList.remove("hidden");
      const timeInput = document.getElementById("postProcessTime");
      const feeInput = document.getElementById("postProcessFee");
      if (Number(timeInput.value) === 0) timeInput.value = STATE.config.printerSettings.postProcessingTimeHours || 0;
      if (Number(feeInput.value) === 0) feeInput.value = STATE.config.printerSettings.postProcessingFeePerUnit || 0;
    } else {
      fields.classList.add("hidden");
    }
  });

  document.getElementById("saveJobButton").addEventListener("click", async () => {
    if (STATE.lastPrintRecord) {
      const originalText = document.getElementById("saveJobButton").innerHTML;
      document.getElementById("saveJobButton").innerHTML = "Saving...";
      
      // 1. Process Images
      const imgInput = document.getElementById("jobImages");
      let images = [];
      if (imgInput && imgInput.files.length > 0) {
        for (let i = 0; i < imgInput.files.length; i++) {
          try {
            const base64 = await compressImage(imgInput.files[i]);
            images.push(base64);
          } catch (err) {
            console.error("Failed to compress image", err);
          }
        }
        imgInput.value = "";
      }
      STATE.lastPrintRecord.images = images;

      // 2. Process STL files per part row
      const partRows = document.querySelectorAll(".quote-part-row");
      if (STATE.lastPrintRecord.parts) {
        for (let i = 0; i < partRows.length; i++) {
          const row = partRows[i];
          const partStlInput = row.querySelector(".quote-part-stl");
          if (partStlInput && partStlInput.files.length > 0) {
            const file = partStlInput.files[0];
            const dbKey = `stl-${Date.now()}-${Math.floor(Math.random()*1000000)}-${file.name}`;
            try {
              await saveFileInDB(dbKey, file);
              if (STATE.lastPrintRecord.parts[i]) {
                STATE.lastPrintRecord.parts[i].stl = { name: file.name, dbKey: dbKey, size: file.size };
              }
            } catch (err) {
              console.error("Failed to save Part STL in IndexedDB", err);
            }
          }
        }
      }
      
      document.getElementById("saveJobButton").innerHTML = originalText;
      
      if (!STATE.lastPrintRecord.recordedAt) {
        STATE.lastPrintRecord.recordedAt = new Date().toISOString();
        STATE.lastPrintRecord.status = "draft";
        STATE.config.nextJobNumber = STATE.config.nextJobNumber || 1;
        STATE.lastPrintRecord.jobNumber = "PROD" + String(STATE.config.nextJobNumber).padStart(4, "0");
        STATE.config.nextJobNumber += 1;
        STATE.history = [STATE.lastPrintRecord, ...STATE.history].slice(0, 100);
      }
      saveState();
      renderPrintHistory();

      let syncNote = "";
      if (STATE.config.googleSheetsAutoSync) {
        const ok = await sendJobToGoogleSheet(STATE.lastPrintRecord, { silent: true });
        renderPrintHistory();
        syncNote = ok
          ? " Sent to Google Sheet."
          : ' (Could not reach Google Sheet — use "Share to Sheet" in Jobs to retry.)';
      }
      if (STATE.config.driveAutoUpload) {
        const hasFiles = (STATE.lastPrintRecord.parts || []).some(p => p.stl && p.stl.dbKey);
        const hasImages = (STATE.lastPrintRecord.images || []).length > 0;
        if (hasFiles) {
          await uploadJobFilesToDrive(STATE.lastPrintRecord);
          syncNote += " Model files sent to Drive.";
        }
        if (hasImages) {
          await uploadJobImagesToDrive(STATE.lastPrintRecord);
          syncNote += " Images sent to Drive.";
        }
        renderPrintHistory();
      }
      alert("Job saved to history." + syncNote);
    }
  });

  document.getElementById("emailQuoteButton").addEventListener("click", () => {
    if (!STATE.lastPrintRecord) return;
    autoSaveJobAs("quote_sent");
    openMailto(buildQuoteEmail(STATE.lastPrintRecord, "quote").url);
  });

  document.getElementById("whatsappQuoteButton").addEventListener("click", () => {
    if (STATE.lastPrintRecord && STATE.lastPrintRecord.whatsappText) {
      autoSaveJobAs("quote_sent");
      const url = `https://wa.me/?text=${encodeURIComponent(STATE.lastPrintRecord.whatsappText)}`;
      window.open(url, "_blank");
    }
  });

  document.getElementById("printQuoteButton").addEventListener("click", () => {
    if (STATE.lastPrintRecord) {
      // Open the print dialog FIRST — window.print() blocks until it's
      // dismissed, so anything after it runs once printing is done. This
      // used to run autoSaveJobAs() (which re-saves the whole job history
      // to disk and rebuilds the entire Jobs table) BEFORE printing, which
      // is what made "PDF" feel slow to click — the browser was doing that
      // work before it ever opened the print dialog. Printing itself was
      // never the slow part.
      window.print();
      autoSaveJobAs("quote_sent");
    }
  });
  
  const editFinancialsBtn = document.getElementById("editFinancialsBtn");
  if (editFinancialsBtn) {
    editFinancialsBtn.addEventListener("click", () => {
      const inputs = document.querySelectorAll("#pane-financial .financial-params-card input[type='number'], #pane-financial .financial-params-card input#taxLabel, #pane-financial .financial-params-card select#vatAppliesTo, #pane-financial .financial-params-card select#roundingStep, #pane-financial .financial-params-card select#roundingMode");
      const isEditing = editFinancialsBtn.textContent === "Save Changes";
      
      if (isEditing) {
        syncFinanceInputsToConfig();
        saveState();
        setFinanceInputs();
        inputs.forEach(i => i.disabled = true);
        editFinancialsBtn.textContent = "Edit Financials";
        editFinancialsBtn.classList.replace("primary", "secondary");
      } else {
        inputs.forEach(i => i.disabled = false);
        editFinancialsBtn.textContent = "Save Changes";
        editFinancialsBtn.classList.replace("secondary", "primary");
      }
    });
  }

  const addFeeLineItemBtn = document.getElementById("addFeeLineItemBtn");
  if (addFeeLineItemBtn) {
    addFeeLineItemBtn.addEventListener("click", () => addFeeLineItem());
  }

  const addCustomOverheadBtn = document.getElementById("addCustomOverheadBtn");
  if (addCustomOverheadBtn) {
    addCustomOverheadBtn.addEventListener("click", () => addCustomOverheadItem());
  }

  const addCustomFacilityMetricBtn = document.getElementById("addCustomFacilityMetricBtn");
  if (addCustomFacilityMetricBtn) {
    addCustomFacilityMetricBtn.addEventListener("click", () => addCustomFacilityMetricItem());
  }

  const addCustomPricingMetricBtn = document.getElementById("addCustomPricingMetricBtn");
  if (addCustomPricingMetricBtn) {
    addCustomPricingMetricBtn.addEventListener("click", () => addCustomPricingMetricItem());
  }

  const addBulkDiscountTierBtn = document.getElementById("addBulkDiscountTierBtn");
  if (addBulkDiscountTierBtn) {
    addBulkDiscountTierBtn.addEventListener("click", () => addBulkDiscountTier());
  }

  const addComponentBtn = document.getElementById("addComponentBtn");
  if (addComponentBtn) {
    addComponentBtn.addEventListener("click", () => addComponentRow());
  }

  const categoryKitSelect = document.getElementById("categoryKitSelect");
  if (categoryKitSelect) {
    categoryKitSelect.addEventListener("change", () => renderCategoryKitEditor());
  }

  // Quote tab: offer to load that category's default component kit
  // (Settings → Components → Category Component Kits) when the product
  // Category changes. Purely a suggestion — never overwrites existing
  // quote components without asking, and skips items already added.
  const quoteCategorySelect = document.getElementById("categorySelect");
  if (quoteCategorySelect) {
    quoteCategorySelect.addEventListener("change", () => {
      const catId = quoteCategorySelect.value;
      const kit = (STATE.config.categoryComponentKits || {})[catId] || [];
      if (kit.length === 0) return;
      const toAdd = kit
        .map(id => (STATE.config.components || []).find(c => c.id === id))
        .filter(c => c && !currentQuoteComponents.some(existing => existing.id === c.id));
      if (toAdd.length === 0) return;
      const catNode = findCategoryNodeById(STATE.config.categories || [], catId);
      const catName = catNode ? catNode.name : "this category";
      if (confirm(`Load the default component kit for "${catName}"? (${toAdd.map(c => c.name).join(", ")})`)) {
        toAdd.forEach(c => currentQuoteComponents.push({ id: c.id, name: c.name, category: c.category, costKes: c.costKes }));
        renderQuoteComponentsList();
      }
    });
  }

  const quoteComponentCategory = document.getElementById("quoteComponentCategory");
  if (quoteComponentCategory) {
    quoteComponentCategory.addEventListener("change", () => updateQuoteComponentOptions());
  }

  const addQuoteComponentBtn = document.getElementById("addQuoteComponentBtn");
  if (addQuoteComponentBtn) {
    addQuoteComponentBtn.addEventListener("click", () => addQuoteComponent());
  }

  const addQuoteDiscountBtn = document.getElementById("addQuoteDiscountBtn");
  if (addQuoteDiscountBtn) {
    addQuoteDiscountBtn.addEventListener("click", () => addQuoteDiscount());
  }
  ["quoteDiscountValue", "quoteDiscountLabel"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addQuoteDiscount();
        }
      });
    }
  });

  const financialParamsSearch = document.getElementById("financialParamsSearch");
  if (financialParamsSearch) {
    financialParamsSearch.addEventListener("input", () => {
      const filter = financialParamsSearch.value.trim().toLowerCase();
      let firstMatchPaneId = null;
      document.querySelectorAll("#pane-financial .pd-subtab-panel").forEach((panel) => {
        let visibleCount = 0;
        panel.querySelectorAll("tbody tr").forEach((row) => {
          const matches = !filter || row.textContent.toLowerCase().includes(filter);
          row.classList.toggle("fin-row-hidden", !matches);
          if (matches) visibleCount += 1;
        });
        if (visibleCount > 0 && !firstMatchPaneId) firstMatchPaneId = panel.id;
      });
      if (filter && firstMatchPaneId) {
        const targetBtn = document.querySelector(`#pane-financial .pd-subtab-btn[data-pd-pane="${firstMatchPaneId}"]`);
        if (targetBtn && !targetBtn.classList.contains("active")) targetBtn.click();
      }
    });
  }

  const saveCompanyInfoBtn = document.getElementById("saveCompanyInfoBtn");
  if (saveCompanyInfoBtn) {
    saveCompanyInfoBtn.addEventListener("click", () => {
      syncCompanyInfoInputsToConfig();
      saveState();
      refreshHeaderBranding();
      applyCurrencyLabels();
      applyPaymentMethodRegionOrdering();
      renderPaymentMethodsSettings();
      // Currency may have just changed — refresh every other view that
      // displays currency-coded values live, so it's correct immediately
      // rather than only updating the next time each tab happens to
      // re-render on its own.
      renderPrinters();
      renderPrinterAccessories();
      if (typeof currentInventoryTypeView !== "undefined" && currentInventoryTypeView) {
        renderInventoryTypeDetailList(currentInventoryTypeView);
      }
      if (typeof renderInventory === "function") renderInventory();
      if (typeof renderPrintHistory === "function") renderPrintHistory();
      if (typeof renderProfiles === "function") renderProfiles();
      const status = document.getElementById("companyInfoStatus");
      if (status) {
        status.textContent = "Saved — this now appears on the header and on printed quotes.";
        setTimeout(() => { if (status.textContent.startsWith("Saved")) status.textContent = ""; }, 4000);
      }
    });
  }

  const addPaymentMethodBtn = document.getElementById("addPaymentMethodBtn");
  if (addPaymentMethodBtn) {
    addPaymentMethodBtn.addEventListener("click", () => {
      const typeSelect = document.getElementById("newPaymentMethodType");
      addPaymentMethod(typeSelect ? typeSelect.value : "bank");
    });
  }

  const companyLogoInput = document.getElementById("companyLogoInput");
  if (companyLogoInput) {
    companyLogoInput.addEventListener("change", async () => {
      const file = companyLogoInput.files && companyLogoInput.files[0];
      if (!file) return;
      try {
        // Compressed the same way job photos already are (compressImage) —
        // an uncompressed logo file was getting embedded as-is and re-saved
        // in full on every single autosave/quote/print, which is one of
        // the things that made routine actions like printing feel slow.
        const dataUrl = await compressImage(file, 250, { trim: true, preserveTransparency: true });
        if (!STATE.config.companyInfo) STATE.config.companyInfo = { ...DEFAULT_CONFIG.companyInfo };
        STATE.config.companyInfo.logoDataUrl = dataUrl;
        saveState();
        renderCompanyLogoPreview();
        refreshHeaderBranding();
      } catch (err) {
        console.error("Failed to compress logo", err);
        alert("Couldn't read that image. Please try a different file.");
      }
    });
  }

  const removeCompanyLogoBtn = document.getElementById("removeCompanyLogoBtn");
  if (removeCompanyLogoBtn) {
    removeCompanyLogoBtn.addEventListener("click", () => {
      if (!STATE.config.companyInfo) STATE.config.companyInfo = { ...DEFAULT_CONFIG.companyInfo };
      STATE.config.companyInfo.logoDataUrl = "";
      saveState();
      renderCompanyLogoPreview();
      refreshHeaderBranding();
      const companyLogoInputEl = document.getElementById("companyLogoInput");
      if (companyLogoInputEl) companyLogoInputEl.value = "";
    });
  }

  const saveIntegrationSettingsBtn = document.getElementById("saveIntegrationSettingsBtn");
  if (saveIntegrationSettingsBtn) {
    saveIntegrationSettingsBtn.addEventListener("click", () => saveIntegrationSettings(true));
  }

  const testSheetSyncBtn = document.getElementById("testSheetSyncBtn");
  if (testSheetSyncBtn) {
    testSheetSyncBtn.addEventListener("click", async () => {
      saveIntegrationSettings(false);
      const originalText = testSheetSyncBtn.innerHTML;
      testSheetSyncBtn.innerHTML = "Sending...";
      testSheetSyncBtn.disabled = true;
      const testJob = {
        recordedAt: new Date().toISOString(),
        name: "Test Row (Portable 3D Quote Calculator)",
        status: "draft",
        quantity: 1,
        totalAmount: 0,
        parts: [],
      };
      await sendJobToGoogleSheet(testJob);
      testSheetSyncBtn.innerHTML = originalText;
      testSheetSyncBtn.disabled = false;
    });
  }

  const quitAppButton = document.getElementById("quitAppButton");
  if (quitAppButton) {
    quitAppButton.addEventListener("click", async () => {
      if (!confirm("Quit the app? This stops the local server — you'll need to reopen it from the app icon to use the calculator again.")) {
        return;
      }
      // Flush any pending Sheet/Drive syncs before the server
      // goes down, with the same progress bar used everywhere else.
      quitAppButton.innerHTML = "Syncing before quit...";
      quitAppButton.disabled = true;
      try {
        await syncAllJobs("close");
      } catch (e) {
        console.error("Sync before quit failed", e);
      }
      try {
        await fetch("/api/shutdown", { method: "POST" });
      } catch (e) {
        // expected — the server closes the connection as it exits
      }
      document.body.innerHTML = "<div style=\"display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:1.1rem;color:#666;\">App stopped — you can close this tab.</div>";
    });
  }

  const syncAllNowButton = document.getElementById("syncAllNowButton");
  if (syncAllNowButton) {
    syncAllNowButton.addEventListener("click", async () => {
      syncAllNowButton.disabled = true;
      await syncAllJobs("manual");
      syncAllNowButton.disabled = false;
    });
  }

  // Best-effort warning if the tab/window is closed directly (not via the
  // Quit button) while a sync is running or changes are still pending —
  // browsers won't reliably let async network calls finish here, so this
  // is a heads-up, not a guarantee. The Quit App button above is the
  // reliable way to flush everything before closing.
  window.addEventListener("beforeunload", (e) => {
    const stillPending = STATE.syncInProgress || STATE.history.some(jobNeedsSync);
    if (stillPending) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  document.getElementById("resetButton").addEventListener("click", () => {
    const container = document.getElementById("quotePartsContainer");
    if (container) {
      container.innerHTML = "";
      addQuotePartRow();
    }
    document.getElementById("projectName").value = "";
    document.getElementById("quantityWeight").value = 1;
    document.getElementById("designFeeWeight").value = 0;
    currentQuoteComponents = [];
    renderQuoteComponentsList();
    currentQuoteDiscounts = [];
    renderQuoteDiscountsList();
    currentQuoteExcludedFeeIds = new Set();
    renderQuoteExtraFeesCard();
    document.getElementById("postProcessingToggle").value = "false";
    document.getElementById("postProcessFields").classList.add("hidden");
    document.getElementById("postProcessTime").value = 0;
    document.getElementById("postProcessFee").value = 0;
    renderResult("<p class='empty-state'>Enter values and click Calculate to see the full estimate breakdown.</p>");
    setPrintAvailability(false);
  });

  document.getElementById("newMaterialApplyEstimate").addEventListener("click", () => {
    const nominalG = Number(document.getElementById("newMaterialNominalWeight").value) || 0;
    const pct = Number(document.getElementById("newMaterialRemainingPct").value);
    if (nominalG <= 0 || isNaN(pct)) {
      alert("Enter both a nominal weight and an estimated remaining percentage.");
      return;
    }
    const estKg = (nominalG * (Math.min(100, Math.max(0, pct)) / 100)) / 1000;
    document.getElementById("newMaterialStock").value = formatStockKg(estKg);
  });

  document.getElementById("editMaterialApplyEstimate").addEventListener("click", () => {
    const nominalG = Number(document.getElementById("editMaterialNominalWeight").value) || 0;
    const pct = Number(document.getElementById("editMaterialRemainingPct").value);
    if (nominalG <= 0 || isNaN(pct)) {
      alert("Enter both a nominal weight and an estimated remaining percentage.");
      return;
    }
    const estKg = (nominalG * (Math.min(100, Math.max(0, pct)) / 100)) / 1000;
    document.getElementById("editMaterialStock").value = formatStockKg(estKg);
  });

  document.getElementById("addMaterialButton").addEventListener("click", () => {
    const type = document.getElementById("newMaterialType").value;
    const brand = document.getElementById("newMaterialBrand").value.trim();
    const name = document.getElementById("newMaterialName").value.trim();
    const costPerKgKes = Number(document.getElementById("newMaterialCost").value) || 0;
    const stockKg = Number(document.getElementById("newMaterialStock").value) || 0;

    if (!type || !name || costPerKgKes <= 0) {
      alert("Please enter a valid material name and cost.");
      return;
    }
    
    const colorNameShort = getColorName(selectedMaterialColor).replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase();
    const uniqueNum = Math.floor(1000 + Math.random() * 9000);
    const code = `${type}-${colorNameShort}-${uniqueNum}`;

    if (STATE.config.materials.some((item) => item.code === code)) {
      alert("An error occurred generating a unique SKU. Please try again.");
      return;
    }

    STATE.config.materials.push({ type, code, brand, name, colorHex: selectedMaterialColor, costPerKgKes, stockKg });
    saveState();
    
    refreshQuotePartMaterialSelects();
    
    renderInventory();
    if (currentInventoryTypeView === type) renderInventoryTypeDetailList(type);

    document.getElementById("newMaterialBrand").value = "";
    document.getElementById("newMaterialName").value = "";
    document.getElementById("newMaterialCost").value = "";
    document.getElementById("newMaterialStock").value = "0";
    document.getElementById("newMaterialNominalWeight").value = "";
    document.getElementById("newMaterialRemainingPct").value = "";
    
    selectedMaterialColor = "#000000";
    buildColorPalette("materialColorPalette", selectedMaterialColor, (hex) => { selectedMaterialColor = hex; });

    closeDrawers();
  });
  
  document.getElementById("saveEditMaterialButton").addEventListener("click", () => {
    const code = document.getElementById("editMaterialCode").value;
    const type = document.getElementById("editMaterialType").value;
    const brand = document.getElementById("editMaterialBrand").value.trim();
    const name = document.getElementById("editMaterialName").value.trim();
    const costPerKgKes = Number(document.getElementById("editMaterialCost").value) || 0;
    const stockKg = Number(document.getElementById("editMaterialStock").value) || 0;

    const mat = STATE.config.materials.find(m => m.code === code);
    if (mat) {
      mat.type = type;
      mat.brand = brand;
      mat.name = name;
      mat.colorHex = selectedEditMaterialColor;
      mat.costPerKgKes = costPerKgKes;
      mat.stockKg = stockKg;
      saveState();
      
      refreshQuotePartMaterialSelects();
      
      renderInventory();
      if (currentInventoryTypeView) renderInventoryTypeDetailList(currentInventoryTypeView);
      closeDrawers();
    }
  });

  document.getElementById("addProfileButton").addEventListener("click", () => {
    const type = document.getElementById("newProfileType").value.trim().toUpperCase();
    const technology = document.getElementById("newProfileTechnology")?.value || "FDM";
    const density = Number(document.getElementById("newProfileDensity").value) || 0;
    const printTemp = Number(document.getElementById("newProfilePrintTemp").value) || 0;
    const bedTemp = Number(document.getElementById("newProfileBedTemp").value) || 0;
    const notes = document.getElementById("newProfileNotes").value.trim();

    if (!type || density <= 0) {
      alert("Please enter a valid Material Type and Density.");
      return;
    }
    if (STATE.config.materialProfiles.some((item) => item.type === type)) {
      alert("A profile with this type already exists.");
      return;
    }

    STATE.config.materialProfiles.push({ type, technology, density, printTemp, bedTemp, notes });
    saveState();
    buildProfileOptions(document.getElementById("newMaterialType"));
    refreshQuotePartMaterialSelects();
    renderProfiles();

    document.getElementById("newProfileType").value = "";
    document.getElementById("newProfileDensity").value = "";
    document.getElementById("newProfilePrintTemp").value = "";
    document.getElementById("newProfileBedTemp").value = "";
    document.getElementById("newProfileNotes").value = "";
    closeDrawers();
  });

  document.getElementById("saveEditProfileButton").addEventListener("click", () => {
    const originalType = document.getElementById("editProfileOriginalType").value;
    const type = document.getElementById("editProfileType").value.trim().toUpperCase();
    const technology = document.getElementById("editProfileTechnology")?.value || "FDM";
    const density = Number(document.getElementById("editProfileDensity").value) || 0;
    const printTemp = Number(document.getElementById("editProfilePrintTemp").value) || 0;
    const bedTemp = Number(document.getElementById("editProfileBedTemp").value) || 0;
    const notes = document.getElementById("editProfileNotes").value.trim();

    if (!type || density <= 0) {
      alert("Please enter a valid Material Type and Density.");
      return;
    }

    const profile = STATE.config.materialProfiles.find(p => p.type === originalType);
    if (profile) {
      profile.type = type;
      profile.technology = technology;
      profile.density = density;
      profile.printTemp = printTemp;
      profile.bedTemp = bedTemp;
      profile.notes = notes;
      
      if (originalType !== type) {
        STATE.config.materials.forEach(m => {
          if (m.type === originalType) m.type = type;
        });
      }

      saveState();
      buildProfileOptions(document.getElementById("newMaterialType"));
      refreshQuotePartMaterialSelects();
      renderProfiles();
      closeDrawers();
    }
  });

  // Refreshes every place a saved part/accessory might be displayed,
  // given the printerId it's linked to (real or a pending unsaved one).
  const refreshAccessoryDisplaysFor = (printerId) => {
    renderPrinterAccessories();
    const editingPrinterId = document.getElementById("editPrinterId")?.value;
    if (editingPrinterId && editingPrinterId === printerId) renderEditPrinterLinkedItems(editingPrinterId);
    const pendingPrinterId = document.getElementById("newPrinterId")?.value;
    if (pendingPrinterId && pendingPrinterId === printerId) renderNewPrinterLinkedItems();
  };

  document.getElementById("savePartFormBtn").addEventListener("click", () => {
    const id = document.getElementById("partFormId").value;
    const name = document.getElementById("partFormName").value.trim();
    const category = document.getElementById("partFormCategory").value;
    const qty = Number(document.getElementById("partFormQty").value) || 0;
    const costKes = Number(document.getElementById("partFormCost").value) || 0;
    const reorderQtyRaw = document.getElementById("partFormReorderQty").value;
    const reorderQty = reorderQtyRaw === "" ? 0 : Number(reorderQtyRaw) || 0;
    const printerId = document.getElementById("partFormPrinter").value || "";
    const notes = document.getElementById("partFormNotes").value.trim();

    if (!name) {
      alert("Please enter a name for the part.");
      return;
    }

    if (id) {
      const item = STATE.config.printerAccessories.find(a => a.id === id);
      if (item) {
        Object.assign(item, { name, type: "part", category, qty, costKes, reorderQty, printerId, notes });
      }
    } else {
      if (!Array.isArray(STATE.config.printerAccessories)) STATE.config.printerAccessories = [];
      STATE.config.printerAccessories.push({
        id: "ACC-" + Date.now(), name, type: "part", category, qty, costKes, reorderQty, printerId, notes
      });
    }

    saveState();
    refreshAccessoryDisplaysFor(printerId);
    closeAppDrawer("partDrawerOverlay");
  });

  document.getElementById("saveAccessoryFormBtn").addEventListener("click", () => {
    const id = document.getElementById("accessoryFormId").value;
    const name = document.getElementById("accessoryFormName").value.trim();
    const category = document.getElementById("accessoryFormCategory").value;
    const costKes = Number(document.getElementById("accessoryFormCost").value) || 0;
    const assetTag = document.getElementById("accessoryFormAssetTag").value.trim();
    const printerId = document.getElementById("accessoryFormPrinter").value || "";
    const notes = document.getElementById("accessoryFormNotes").value.trim();

    if (!name) {
      alert("Please enter a name for the accessory.");
      return;
    }

    if (id) {
      const item = STATE.config.printerAccessories.find(a => a.id === id);
      if (item) {
        Object.assign(item, { name, type: "accessory", category, qty: item.qty || 1, costKes, assetTag, printerId, notes });
      }
    } else {
      if (!Array.isArray(STATE.config.printerAccessories)) STATE.config.printerAccessories = [];
      STATE.config.printerAccessories.push({
        id: "ACC-" + Date.now(), name, type: "accessory", category, qty: 1, costKes, assetTag, printerId, notes
      });
    }

    saveState();
    refreshAccessoryDisplaysFor(printerId);
    closeAppDrawer("accessoryDrawerOverlay");
  });

  // Close buttons, backdrop clicks, and Escape all dismiss an open drawer
  // without saving.
  document.querySelectorAll(".drawer-close-btn[data-close-drawer]").forEach((btn) => {
    btn.addEventListener("click", () => closeAppDrawer(btn.dataset.closeDrawer));
  });
  document.querySelectorAll(".app-drawer-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllAppDrawers();
  });

  const mainAddPartBtn = document.getElementById("mainAddPartBtn");
  if (mainAddPartBtn) mainAddPartBtn.addEventListener("click", () => openPartDrawer());
  const mainAddAccessoryBtn = document.getElementById("mainAddAccessoryBtn");
  if (mainAddAccessoryBtn) mainAddAccessoryBtn.addEventListener("click", () => openAccessoryDrawer());

  // Reset any leftover photo from an abandoned "Add Printer" attempt each
  // time the page is opened fresh, so it never gets attached to the next
  // printer by mistake.
  document.querySelectorAll('[data-page="add-printer"]').forEach((button) => {
    button.addEventListener("click", () => {
      pendingNewPrinterPhotoDataUrl = "";
      pendingDiscoveredPrinterNetwork = null;
      const input = document.getElementById("newPrinterPhotoInput");
      if (input) input.value = "";
      renderNewPrinterPhotoPreview();

      // Generate the printer's id up front (instead of only at Save)
      // so parts/accessories can be linked to it right away, before
      // the printer itself has been saved for the first time.
      const newPrinterIdField = document.getElementById("newPrinterId");
      if (newPrinterIdField) newPrinterIdField.value = "PRT-" + Date.now();
      renderNewPrinterLinkedItems();

      const resultsWrap = document.getElementById("discoveredPrintersResults");
      if (resultsWrap) resultsWrap.innerHTML = "";
    });
  });

  const discoverPrintersBtn = document.getElementById("discoverPrintersBtn");
  if (discoverPrintersBtn) {
    discoverPrintersBtn.addEventListener("click", async () => {
      const resultsWrap = document.getElementById("discoveredPrintersResults");
      if (!resultsWrap) return;
      discoverPrintersBtn.disabled = true;
      discoverPrintersBtn.textContent = "Scanning…";
      resultsWrap.innerHTML = `<p class="help-text">Scanning your local network — this takes a few seconds…</p>`;

      try {
        const subnetValue = (document.getElementById("discoverSubnet")?.value || "").trim();
        const res = await fetch("/api/discover-printers" + (subnetValue ? `?subnet=${encodeURIComponent(subnetValue)}` : ""));
        const data = await res.json();
        if (!res.ok) {
          resultsWrap.innerHTML = `<p class="help-text" style="color: var(--danger, #dc2626);">${escapeHtml(data.error || "The scan failed.")}</p>`;
          discoverPrintersBtn.disabled = false;
          discoverPrintersBtn.textContent = "🔍 Scan Network";
          return;
        }
        const printers = data.printers || [];

        if (printers.length === 0) {
          resultsWrap.innerHTML = `<p class="help-text">No printers found${data.subnetsScanned && data.subnetsScanned.length ? ` on ${data.subnetsScanned.join(", ")}` : ""}. If you're running QuoteForge in Docker, network scanning needs <code>network_mode: host</code> to see your LAN — see the README. Printers on another network (for example a separate printer Wi-Fi) can be scanned by typing that network next to the Scan button. Otherwise, add the printer manually below.</p>`;
        } else {
          resultsWrap.innerHTML = `
            <p class="help-text mb-8">Found ${printers.length} printer${printers.length === 1 ? "" : "s"}:</p>
            <div class="form-group-vertical">
              ${printers.map((p, i) => `
                <div class="flex-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface);">
                  <span>${escapeHtml(p.label)}</span>
                  <button type="button" class="secondary use-discovered-printer" data-idx="${i}" style="padding: 4px 12px; font-size: 0.82rem;">Use This</button>
                </div>
              `).join("")}
            </div>
          `;
          resultsWrap.querySelectorAll(".use-discovered-printer").forEach((btn) => {
            btn.addEventListener("click", () => {
              const p = printers[Number(btn.dataset.idx)];
              const nameField = document.getElementById("newPrinterName");
              const manufacturerField = document.getElementById("newPrinterManufacturer");
              const defaults = {
                octoprint: ["OctoPrint Printer", "OctoPrint"],
                moonraker: ["Klipper Printer", "Klipper/Moonraker"],
                prusalink: ["Prusa Printer", "Prusa"],
                duet: ["Duet Printer", "Duet / RepRapFirmware"],
                sdcp: [p.name || p.model || "Elegoo Printer", "Elegoo"],
                bambu: [p.name || (p.model ? `Bambu Lab ${p.model}` : "Bambu Lab Printer"), "Bambu Lab"],
              }[p.apiType] || ["Network Printer", ""];
              if (nameField && !nameField.value) nameField.value = defaults[0];
              if (manufacturerField && !manufacturerField.value) manufacturerField.value = defaults[1];
              if (p.apiType === "bambu") {
                // A Bambu printer also needs its access code, so hand over to the Bambu form
                // with the IP address and serial number already filled in.
                document.getElementById("bambuConnectIp").value = p.ip || "";
                document.getElementById("bambuConnectSerial").value = p.serial || "";
                const note = document.getElementById("bambuDetectedNote");
                if (note) {
                  note.textContent = p.lanMode
                    ? "Found this printer on your network. LAN Only Mode is on, so just type the 8-digit access code shown on the printer."
                    : "Found this printer, but LAN Only Mode is off. On the printer go to Settings → WLAN, turn on LAN Only Mode (and Developer Mode on newer models), then enter the access code.";
                  note.classList.remove("hidden");
                }
                document.getElementById("bambuConnectForm")?.classList.remove("hidden");
                const codeField = document.getElementById("bambuConnectAccessCode");
                codeField?.scrollIntoView({ behavior: "smooth", block: "center" });
                codeField?.focus();
                return;
              }
              pendingDiscoveredPrinterNetwork = { ip: p.ip, port: p.port, apiType: p.apiType, serial: p.serial || "" };
              nameField?.scrollIntoView({ behavior: "smooth", block: "center" });
              nameField?.focus();
            });
          });
        }
      } catch (e) {
        resultsWrap.innerHTML = `<p class="help-text">Couldn't reach the discovery service — this feature needs QuoteForge's own server (self-hosted or portable mode), not a static file host.</p>`;
      }

      discoverPrintersBtn.disabled = false;
      discoverPrintersBtn.textContent = "🔍 Scan Network";
    });
  }

  const showBambuConnectFormBtn = document.getElementById("showBambuConnectFormBtn");
  if (showBambuConnectFormBtn) {
    showBambuConnectFormBtn.addEventListener("click", () => {
      document.getElementById("bambuConnectForm")?.classList.toggle("hidden");
    });
  }

  const saveBambuConnectBtn = document.getElementById("saveBambuConnectBtn");
  if (saveBambuConnectBtn) {
    saveBambuConnectBtn.addEventListener("click", () => {
      const ip = document.getElementById("bambuConnectIp")?.value.trim();
      const serial = document.getElementById("bambuConnectSerial")?.value.trim();
      const accessCode = document.getElementById("bambuConnectAccessCode")?.value.trim();

      if (!ip || !serial || !accessCode) {
        alert("Please fill in the printer's IP address, serial number, and access code — all three are shown on the printer's screen under Settings → WLAN with LAN Only Mode on.");
        return;
      }

      pendingDiscoveredPrinterNetwork = { ip, port: 8883, apiType: "bambu", serial, accessCode };

      const nameField = document.getElementById("newPrinterName");
      const manufacturerField = document.getElementById("newPrinterManufacturer");
      if (nameField && !nameField.value) nameField.value = "Bambu Lab Printer";
      if (manufacturerField && !manufacturerField.value) manufacturerField.value = "Bambu Lab";

      document.getElementById("bambuConnectForm")?.classList.add("hidden");
      nameField?.scrollIntoView({ behavior: "smooth", block: "center" });
      nameField?.focus();
    });
  }

  const testBambuConnectBtn = document.getElementById("testBambuConnectBtn");
  if (testBambuConnectBtn) {
    testBambuConnectBtn.addEventListener("click", async () => {
      const resultEl = document.getElementById("bambuConnectTestResult");
      const ip = document.getElementById("bambuConnectIp")?.value.trim();
      const serial = document.getElementById("bambuConnectSerial")?.value.trim();
      const accessCode = document.getElementById("bambuConnectAccessCode")?.value.trim();
      if (!resultEl) return;
      if (!ip || !serial || !accessCode) { resultEl.textContent = "Fill in the IP address, serial number and access code first."; return; }
      testBambuConnectBtn.disabled = true;
      resultEl.textContent = "Testing…";
      try {
        const res = await fetch("/api/test-printer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip, port: 8883, apiType: "bambu", serial, accessCode }) });
        const data = await res.json();
        resultEl.textContent = data.ok
          ? `✓ Connected. Printer is ${data.state}${data.progressPercent != null ? `, ${data.progressPercent}%` : ""}.`
          : `✗ ${data.error || "Couldn't connect."}`;
      } catch (e) {
        resultEl.textContent = "✗ Couldn't reach the QuoteForge server (this needs the portable or self-hosted version).";
      }
      testBambuConnectBtn.disabled = false;
    });
  }

  const editPrinterCheckStatusBtn = document.getElementById("editPrinterCheckStatusBtn");
  if (editPrinterCheckStatusBtn) {
    editPrinterCheckStatusBtn.addEventListener("click", () => {
      const id = document.getElementById("editPrinterId")?.value;
      const resultEl = document.getElementById("editPrinterLiveStatusResult");
      if (id) checkPrinterLiveStatus(id, resultEl);
    });
  }

  const newPrinterPhotoInput = document.getElementById("newPrinterPhotoInput");
  if (newPrinterPhotoInput) {
    newPrinterPhotoInput.addEventListener("change", async () => {
      const file = newPrinterPhotoInput.files && newPrinterPhotoInput.files[0];
      if (!file) return;
      try {
        pendingNewPrinterPhotoDataUrl = await compressImage(file, 500);
        renderNewPrinterPhotoPreview();
      } catch (err) {
        console.error("Failed to compress printer photo", err);
        alert("Couldn't read that image. Please try a different file.");
      }
    });
  }

  const removeNewPrinterPhotoBtn = document.getElementById("removeNewPrinterPhotoBtn");
  if (removeNewPrinterPhotoBtn) {
    removeNewPrinterPhotoBtn.addEventListener("click", () => {
      pendingNewPrinterPhotoDataUrl = "";
      renderNewPrinterPhotoPreview();
      if (newPrinterPhotoInput) newPrinterPhotoInput.value = "";
    });
  }

  const editPrinterPhotoInput = document.getElementById("editPrinterPhotoInput");
  if (editPrinterPhotoInput) {
    editPrinterPhotoInput.addEventListener("change", async () => {
      const file = editPrinterPhotoInput.files && editPrinterPhotoInput.files[0];
      if (!file) return;
      const id = document.getElementById("editPrinterId")?.value;
      const printer = id ? STATE.config.printers.find(p => p.id === id) : null;
      if (!printer) return;
      try {
        printer.photoDataUrl = await compressImage(file, 500);
        saveState();
        renderEditPrinterPhotoPreview();
        renderPrinters();
      } catch (err) {
        console.error("Failed to compress printer photo", err);
        alert("Couldn't read that image. Please try a different file.");
      }
    });
  }

  const removeEditPrinterPhotoBtn = document.getElementById("removeEditPrinterPhotoBtn");
  if (removeEditPrinterPhotoBtn) {
    removeEditPrinterPhotoBtn.addEventListener("click", () => {
      const id = document.getElementById("editPrinterId")?.value;
      const printer = id ? STATE.config.printers.find(p => p.id === id) : null;
      if (!printer) return;
      printer.photoDataUrl = "";
      saveState();
      renderEditPrinterPhotoPreview();
      renderPrinters();
      if (editPrinterPhotoInput) editPrinterPhotoInput.value = "";
    });
  }

  document.getElementById("addPrinterButton").addEventListener("click", () => {
    const id = document.getElementById("newPrinterId")?.value || ("PRT-" + Date.now());
    const name = document.getElementById("newPrinterName").value.trim();
    const manufacturer = document.getElementById("newPrinterManufacturer")?.value.trim() || "";
    const serialNumber = document.getElementById("newPrinterSerial")?.value.trim() || "";
    const location = document.getElementById("newPrinterLocation")?.value.trim() || "";
    const technology = document.getElementById("newPrinterTechnology")?.value || "FDM";
    const status = document.getElementById("newPrinterStatus")?.value || "Active";
    const powerWatts = Number(document.getElementById("newPrinterPower").value) || 0;
    const printerPurchasePriceKes = Number(document.getElementById("newPrinterPrice").value) || 0;
    let lifespanHours = Number(document.getElementById("newPrinterLifespan").value);
    if (isNaN(lifespanHours) || lifespanHours <= 0) lifespanHours = 10000;
    const purchaseDate = document.getElementById("newPrinterPurchaseDate")?.value || "";
    const maintenancePerYearKes = Number(document.getElementById("newPrinterMaintenance").value) || 0;
    const failedPrintRatePercent = Number(document.getElementById("newPrinterFailRate").value) || 0;
    const maxColors = Number(document.getElementById("newPrinterMaxColors").value) || 1;
    const buildVolumeX = Number(document.getElementById("newPrinterBuildX")?.value) || 256;
    const buildVolumeY = Number(document.getElementById("newPrinterBuildY")?.value) || 256;
    const buildVolumeZ = Number(document.getElementById("newPrinterBuildZ")?.value) || 256;

    if (!name || powerWatts <= 0 || printerPurchasePriceKes <= 0) {
      alert("Please enter a valid printer name, power, and price.");
      return;
    }

    STATE.config.printers.push({
      id, name, manufacturer, serialNumber, location, technology, status, powerWatts, printerPurchasePriceKes, lifespanHours,
      purchaseDate, maintenancePerYearKes, failedPrintRatePercent, maxColors,
      buildVolumeX, buildVolumeY, buildVolumeZ, loggedHours: 0,
      photoDataUrl: pendingNewPrinterPhotoDataUrl || "",
      // Only populated when this printer was added via network discovery
      // ("Use This" on a scan result). Not used for cost calculations —
      // just kept for a future live-status/network-integration feature.
      networkAddress: pendingDiscoveredPrinterNetwork ? pendingDiscoveredPrinterNetwork.ip : "",
      networkPort: pendingDiscoveredPrinterNetwork ? pendingDiscoveredPrinterNetwork.port : null,
      networkApiType: pendingDiscoveredPrinterNetwork ? pendingDiscoveredPrinterNetwork.apiType : "",
      // Only present for Bambu Lab printers connected via the manual
      // LAN-only form — needed later to open an MQTT connection.
      networkSerial: pendingDiscoveredPrinterNetwork ? (pendingDiscoveredPrinterNetwork.serial || "") : "",
      networkAccessCode: pendingDiscoveredPrinterNetwork ? (pendingDiscoveredPrinterNetwork.accessCode || "") : "",
      networkApiKey: document.getElementById("newPrinterApiKey")?.value.trim() || "",
      networkUsername: document.getElementById("newPrinterNetUsername")?.value.trim() || "",
      networkPassword: document.getElementById("newPrinterNetPassword")?.value || "",
    });
    pendingDiscoveredPrinterNetwork = null;
    saveState();
    buildPrinterOptions(document.getElementById("printerSelect"));
    renderPrinters();
    renderPrinterAccessories();

    document.getElementById("newPrinterName").value = "";
    document.getElementById("newPrinterManufacturer").value = "";
    document.getElementById("newPrinterSerial").value = "";
    document.getElementById("newPrinterLocation").value = "";
    document.getElementById("newPrinterPower").value = "";
    document.getElementById("newPrinterPrice").value = "";
    document.getElementById("newPrinterLifespan").value = "";
    document.getElementById("newPrinterPurchaseDate").value = "";
    document.getElementById("newPrinterMaintenance").value = "";
    document.getElementById("newPrinterFailRate").value = "";
    document.getElementById("newPrinterMaxColors").value = "1";
    document.getElementById("newPrinterBuildX").value = "";
    document.getElementById("newPrinterBuildY").value = "";
    document.getElementById("newPrinterBuildZ").value = "";
    document.getElementById("newPrinterTechnology").value = "FDM";
    document.getElementById("newPrinterStatus").value = "Active";
    const newApiKeyF = document.getElementById("newPrinterApiKey");
    if (newApiKeyF) newApiKeyF.value = "";
    const newNetUserF = document.getElementById("newPrinterNetUsername");
    if (newNetUserF) newNetUserF.value = "";
    const newNetPassF = document.getElementById("newPrinterNetPassword");
    if (newNetPassF) newNetPassF.value = "";
    pendingNewPrinterPhotoDataUrl = "";
    if (newPrinterPhotoInput) newPrinterPhotoInput.value = "";
    renderNewPrinterPhotoPreview();
    closeDrawers();
  });

  const editPrinterAddPartBtn = document.getElementById("editPrinterAddPartBtn");
  if (editPrinterAddPartBtn) {
    editPrinterAddPartBtn.addEventListener("click", () => {
      openPartDrawer(null, document.getElementById("editPrinterId").value);
    });
  }

  const editPrinterAddAccessoryBtn = document.getElementById("editPrinterAddAccessoryBtn");
  if (editPrinterAddAccessoryBtn) {
    editPrinterAddAccessoryBtn.addEventListener("click", () => {
      openAccessoryDrawer(null, document.getElementById("editPrinterId").value);
    });
  }

  const newPrinterAddPartBtn = document.getElementById("newPrinterAddPartBtn");
  if (newPrinterAddPartBtn) {
    newPrinterAddPartBtn.addEventListener("click", () => {
      openPartDrawer(null, document.getElementById("newPrinterId")?.value || "");
    });
  }

  const newPrinterAddAccessoryBtn = document.getElementById("newPrinterAddAccessoryBtn");
  if (newPrinterAddAccessoryBtn) {
    newPrinterAddAccessoryBtn.addEventListener("click", () => {
      openAccessoryDrawer(null, document.getElementById("newPrinterId")?.value || "");
    });
  }

  // Parts/Accessories mini-tabs inside the Add/Edit Printer pages. Each
  // .pd-subtab-bar is scoped to its own container so switching tabs on
  // one page never touches the other page's tab state.
  document.querySelectorAll(".pd-subtab-bar").forEach((bar) => {
    const container = bar.closest(".card") || bar.parentElement;
    bar.querySelectorAll(".pd-subtab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const paneId = btn.dataset.pdPane;
        bar.querySelectorAll(".pd-subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
        container.querySelectorAll(".pd-subtab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== paneId));
      });
    });
  });

  document.getElementById("saveEditPrinterButton").addEventListener("click", () => {    const id = document.getElementById("editPrinterId").value;
    const name = document.getElementById("editPrinterName").value.trim();
    const manufacturer = document.getElementById("editPrinterManufacturer")?.value.trim() || "";
    const serialNumber = document.getElementById("editPrinterSerial")?.value.trim() || "";
    const location = document.getElementById("editPrinterLocation")?.value.trim() || "";
    const technology = document.getElementById("editPrinterTechnology")?.value || "FDM";
    const status = document.getElementById("editPrinterStatus")?.value || "Active";
    const powerWatts = Number(document.getElementById("editPrinterPower").value) || 0;
    const printerPurchasePriceKes = Number(document.getElementById("editPrinterPrice").value) || 0;
    let lifespanHours = Number(document.getElementById("editPrinterLifespan").value);
    if (isNaN(lifespanHours) || lifespanHours <= 0) lifespanHours = 10000;
    const purchaseDate = document.getElementById("editPrinterPurchaseDate")?.value || "";
    const maintenancePerYearKes = Number(document.getElementById("editPrinterMaintenance").value) || 0;
    const failedPrintRatePercent = Number(document.getElementById("editPrinterFailRate").value) || 0;
    const maxColors = Number(document.getElementById("editPrinterMaxColors").value) || 1;
    const buildVolumeX = Number(document.getElementById("editPrinterBuildX")?.value) || 256;
    const buildVolumeY = Number(document.getElementById("editPrinterBuildY")?.value) || 256;
    const buildVolumeZ = Number(document.getElementById("editPrinterBuildZ")?.value) || 256;
    const loggedHours = Math.max(0, Number(document.getElementById("editPrinterLoggedHours")?.value) || 0);

    const printer = STATE.config.printers.find(p => p.id === id);
    if (printer) {
      const wasActive = printer.status !== "Retired" && printer.status !== "Maintenance";
      printer.name = name;
      printer.manufacturer = manufacturer;
      printer.serialNumber = serialNumber;
      printer.location = location;
      printer.technology = technology;
      printer.status = status;
      printer.powerWatts = powerWatts;
      printer.printerPurchasePriceKes = printerPurchasePriceKes;
      printer.lifespanHours = lifespanHours;
      printer.purchaseDate = purchaseDate;
      printer.maintenancePerYearKes = maintenancePerYearKes;
      printer.failedPrintRatePercent = failedPrintRatePercent;
      printer.maxColors = maxColors;
      printer.buildVolumeX = buildVolumeX;
      printer.buildVolumeY = buildVolumeY;
      printer.buildVolumeZ = buildVolumeZ;
      printer.loggedHours = loggedHours;
      printer.networkApiKey = document.getElementById("editPrinterApiKey")?.value.trim() || "";
      printer.networkUsername = document.getElementById("editPrinterNetUsername")?.value.trim() || "";
      printer.networkPassword = document.getElementById("editPrinterNetPassword")?.value || "";

      saveState();
      buildPrinterOptions(document.getElementById("printerSelect"));
      renderPrinters();
      renderPrinterAccessories();
      closeDrawers();
    }
  });

  document.getElementById("addCustomerButton").addEventListener("click", () => {
    const company = document.getElementById("newCustomerCompany").value.trim();
    const contactPerson = document.getElementById("newCustomerContact").value.trim();
    const phone = document.getElementById("newCustomerPhone").value.trim();
    const email = document.getElementById("newCustomerEmail").value.trim();
    const address = document.getElementById("newCustomerAddress").value.trim();
    const notes = document.getElementById("newCustomerNotes").value.trim();

    if (!company) {
      alert("Please enter a name for this customer — a business name or an individual's name both work.");
      return;
    }

    const customer = {
      id: "CUST-" + Date.now(),
      company,
      contactPerson,
      phone,
      email,
      address,
      notes,
      createdAt: new Date().toISOString(),
    };

    if (!Array.isArray(STATE.config.customers)) STATE.config.customers = [];
    STATE.config.customers.push(customer);
    saveState();
    renderCustomers();
    buildCustomerOptions(document.getElementById("quoteCustomer"));
    sendCustomerToGoogleSheet(customer, { silent: true });

    document.getElementById("newCustomerCompany").value = "";
    document.getElementById("newCustomerContact").value = "";
    document.getElementById("newCustomerPhone").value = "";
    document.getElementById("newCustomerEmail").value = "";
    document.getElementById("newCustomerAddress").value = "";
    document.getElementById("newCustomerNotes").value = "";
    closeDrawers();
  });

  document.getElementById("saveEditCustomerButton").addEventListener("click", () => {
    const id = document.getElementById("editCustomerId").value;
    const company = document.getElementById("editCustomerCompany").value.trim();
    const contactPerson = document.getElementById("editCustomerContact").value.trim();
    const phone = document.getElementById("editCustomerPhone").value.trim();
    const email = document.getElementById("editCustomerEmail").value.trim();
    const address = document.getElementById("editCustomerAddress").value.trim();
    const notes = document.getElementById("editCustomerNotes").value.trim();

    if (!company) {
      alert("Please enter a name for this customer — a business name or an individual's name both work.");
      return;
    }

    const customer = getCustomerById(id);
    if (customer) {
      customer.company = company;
      customer.contactPerson = contactPerson;
      customer.phone = phone;
      customer.email = email;
      customer.address = address;
      customer.notes = notes;
      customer.updatedAt = new Date().toISOString();

      saveState();
      renderCustomers();
      buildCustomerOptions(document.getElementById("quoteCustomer"));
      sendCustomerToGoogleSheet(customer, { silent: true });
      closeDrawers();
    }
  });

  document.getElementById("addColorButton").addEventListener("click", () => {
    const name = document.getElementById("newColorName").value.trim();
    const hex = document.getElementById("newColorHex").value;

    if (!name || !hex) {
      alert("Please enter a valid color name.");
      return;
    }
    
    if (STATE.config.colors.some(c => c.hex.toLowerCase() === hex.toLowerCase())) {
      alert("A color with this exact HEX code already exists.");
      return;
    }

    STATE.config.colors.push({ name, hex });
    saveState();
    buildColorPalette("materialColorPalette", selectedMaterialColor, (h) => { selectedMaterialColor = h; });
    renderCustomColors();

    document.getElementById("newColorName").value = "";
    closeDrawers();
  });

  const addCategoryButton = document.getElementById("addCategoryButton");
  if (addCategoryButton) {
    addCategoryButton.addEventListener("click", () => {
      const name = document.getElementById("newCategoryName").value.trim();
      let skuAbbr = document.getElementById("newCategorySkuAbbr").value.trim().toUpperCase();
      const parentId = document.getElementById("newCategoryParentId").value;

      if (!name) {
        alert("Please enter a category name.");
        return;
      }

      if (!Array.isArray(STATE.config.categories)) STATE.config.categories = [];
      let siblings = STATE.config.categories;
      if (parentId) {
        const parentNode = findCategoryNodeById(STATE.config.categories, parentId);
        if (!parentNode) {
          alert("Couldn't find the parent category — please try again.");
          return;
        }
        if (!Array.isArray(parentNode.subcategories)) parentNode.subcategories = [];
        siblings = parentNode.subcategories;
      }

      if (siblings.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        alert("A category with this name already exists at this level.");
        return;
      }
      // Mirrors the sheet's own fallback: no abbreviation given -> first
      // 3 letters of the category name, capitalised.
      if (!skuAbbr) skuAbbr = name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();

      siblings.push({ id: genCategoryId(), name, skuAbbr, subcategories: [] });
      saveState();
      renderCategoriesTable();
      refreshAllCategoryCascades();

      document.getElementById("newCategoryName").value = "";
      document.getElementById("newCategorySkuAbbr").value = "";
      document.getElementById("newCategoryParentId").value = "";
      closeDrawers();
    });
  }

  const addComponentCategoryButton = document.getElementById("addComponentCategoryButton");
  if (addComponentCategoryButton) {
    addComponentCategoryButton.addEventListener("click", () => {
      const input = document.getElementById("newComponentCategoryName");
      const name = input.value.trim();
      if (!name) {
        alert("Please enter a category name.");
        return;
      }
      if (!Array.isArray(STATE.config.componentCategories)) STATE.config.componentCategories = [];
      if (STATE.config.componentCategories.some(c => c.toLowerCase() === name.toLowerCase())) {
        alert("A component category with this name already exists.");
        return;
      }
      STATE.config.componentCategories.push(name);
      saveState();
      renderComponentCategoriesTable();
      refreshQuoteComponentSelectors();
      input.value = "";
    });
  }
  const newComponentCategoryInput = document.getElementById("newComponentCategoryName");
  if (newComponentCategoryInput) {
    newComponentCategoryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("addComponentCategoryButton")?.click();
      }
    });
  }

  const addAccessoryCategoryButton = document.getElementById("addAccessoryCategoryButton");
  if (addAccessoryCategoryButton) {
    addAccessoryCategoryButton.addEventListener("click", () => {
      const input = document.getElementById("newAccessoryCategoryName");
      const name = input.value.trim();
      if (!name) {
        alert("Please enter a category name.");
        return;
      }
      if (!Array.isArray(STATE.config.accessoryCategories)) STATE.config.accessoryCategories = [];
      if (STATE.config.accessoryCategories.some(c => c.toLowerCase() === name.toLowerCase())) {
        alert("An accessory category with this name already exists.");
        return;
      }
      STATE.config.accessoryCategories.push(name);
      saveState();
      renderAccessoryCategoriesTable();
      renderPrinterAccessories();
      input.value = "";
    });
  }
  const newAccessoryCategoryInput = document.getElementById("newAccessoryCategoryName");
  if (newAccessoryCategoryInput) {
    newAccessoryCategoryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("addAccessoryCategoryButton")?.click();
      }
    });
  }

  document.getElementById("clearHistoryButton").addEventListener("click", async () => {
    if (confirm("Clear all saved print history?")) {
      await clearPrintHistory();
    }
  });

  document.getElementById("exportConfigButton").addEventListener("click", exportConfig);

  const resetFactoryDefaultsBtn = document.getElementById("resetFactoryDefaultsBtn");
  if (resetFactoryDefaultsBtn) {
    resetFactoryDefaultsBtn.addEventListener("click", async () => {
      const first = confirm(
        "This wipes ALL settings, jobs, materials, printers, and categories back to a blank install. " +
        "This cannot be undone. Export a backup first if you want to keep anything.\n\n" +
        "Continue?"
      );
      if (!first) return;
      const second = confirm("Really reset everything? This is your last chance to cancel.");
      if (!second) return;

      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {
        // ignore
      }
      try {
        await fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: {}, history: [] }),
        });
      } catch (e) {
        console.warn("Could not clear the server-side data file", e);
      }
      // Full reload so every part of the app re-initializes from scratch
      // (including re-showing the setup wizard) instead of trying to
      // reconcile a wiped STATE against a still-rendered UI.
      window.location.reload();
    });
  }

  const importInput = document.getElementById("importConfigInput");
  if (importInput) {
    importInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        importConfig(e.target.files[0]);
      }
    });
  }

  document.querySelectorAll(".table-search").forEach(input => {
    input.addEventListener("input", applyTableFilters);
  });
}

function initTheme() {
  const toggleBtn = document.getElementById("themeToggle");
  if (!toggleBtn) return;
  const sunIcon = toggleBtn.querySelector(".sun-icon");
  const moonIcon = toggleBtn.querySelector(".moon-icon");
  
  const savedTheme = localStorage.getItem("quote-theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  
  const applyTheme = (isDark) => {
    if (isDark) {
      document.documentElement.setAttribute("data-theme", "dark");
      if(sunIcon) sunIcon.classList.remove("hidden");
      if(moonIcon) moonIcon.classList.add("hidden");
      localStorage.setItem("quote-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
      if(sunIcon) sunIcon.classList.add("hidden");
      if(moonIcon) moonIcon.classList.remove("hidden");
      localStorage.setItem("quote-theme", "light");
    }
  };

  applyTheme(savedTheme === "dark" || (!savedTheme && prefersDark));

  toggleBtn.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(!isDark);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();
  installEventListeners();
  initTheme();
  setActiveTab("quote");
});

// ==========================================
// IndexedDB File Storage for STL & Large Files
// ==========================================
const DB_NAME = "Portable3DCalculatorHeavyFilesDB";
const DB_VERSION = 1;
const STORE_NAME = "heavy_files";

let dbInstance = null;

function initDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };
    request.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

async function saveFileInDB(key, fileBlob) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(fileBlob, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getFileFromDB(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteFileFromDB(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
