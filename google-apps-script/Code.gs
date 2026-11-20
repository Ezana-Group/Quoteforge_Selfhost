/**
 * QuoteForge — Google Sheets Sync + Drive Uploads
 * ------------------------------------------------------------------
 * Paste this into Extensions > Apps Script from INSIDE your own Google
 * Sheet (recommended — see README.md), then deploy it as a Web App. The
 * first successful write (e.g. "Send Test Row" in the calculator)
 * automatically creates a "Quotes" tab with headers — you don't need to
 * add it by hand.
 *
 * Deploy settings:
 *   Execute as:    Me
 *   Who has access: Anyone
 *
 * Copy the resulting URL (ends in /exec) into the calculator's
 * Settings → Google Sheets Sync → "Apps Script Web App URL" field.
 *
 * Four kinds of requests land here, all from the same URL:
 *   1. Job sync (data.type absent/"job") — writes/updates a row in "Quotes".
 *   2. Model file upload (data.type === "modelFile") — saves an STL/3MF
 *      into Drive, writes the link into the "Model Files" column.
 *   3. Image upload (data.type === "image") — saves a job photo into
 *      Drive, writes the link into the "Images" column.
 *   4. Product sync (data.type === "product") — appends a row to the
 *      "Products" tab from a completed quote ("Send to Products" in the
 *      calculator's Jobs list). Product ID / SKU are left alone — they're
 *      copied down from the row above so the sheet's own formulas keep
 *      working, per the sheet's "never type into columns A or B" rule.
 *      Field writes are matched by HEADER NAME, not column position, so
 *      adding extra columns to Products later (e.g. Description, Link,
 *      Condition, Availability, Brand, GTIN — useful for Facebook/Google
 *      Merchant feed compliance) is automatically picked up with no code
 *      changes here.
 *   5. Customer sync (data.type === "customer") — upserts a row in a
 *      "Customers" tab (created automatically on first sync) by Customer
 *      ID, so editing a customer in the calculator updates the same row
 *      instead of duplicating it.
 *
 * Either upload type also writes a single link to the job's whole Drive
 * folder into the "Job Folder" column — one click to see everything for
 * that job at once, instead of clicking through individual file links.
 *
 * Both file types land in the SAME per-job Drive folder, named
 * "<Job ID>_<Project Name>", under a root Drive folder (name set by
 * DRIVE_ROOT_FOLDER_NAME below).
 *
 * A fifth thing happens automatically after every product sync: the
 * "Merchant Feed" tab is rebuilt from "Products" with Meta/Google's exact
 * required column names (id, title, description, availability, condition,
 * price, link, image_link, brand, identifier_exists) — see
 * rebuildMerchantFeed() below. Publish THAT tab to the web as CSV and use
 * the resulting URL as your Facebook/Google Merchant data feed source.
 * "image_link" is sourced from a "Hero Image URL" column on Products —
 * the first photo uploaded for that job, resolved automatically at
 * product-sync time — never the "Image (Drive link / filename)" folder
 * link, which Facebook can't render as an image.
 *
 * A sixth thing happens right after that: the "Jumia Feed" tab is rebuilt
 * the same way, using Jumia Seller Center's core mandatory field names
 * (SellerSku, Product Name, Brand, Category, Description, Key Features,
 * Price, Quantity, image URLs) — see rebuildJumiaFeed() below. Jumia does
 * NOT accept a live feed URL like Facebook/Google, so this tab is for
 * copy/pasting into the category-specific mass-upload template downloaded
 * from Seller Center > Products > Import Products. (Skip this if Jumia
 * isn't a marketplace you sell on — it's just an unused tab otherwise.)
 */

// Leave SPREADSHEET_ID blank when the script is bound to (pasted inside)
// the spreadsheet you want it to write to — this is the recommended setup
// and the ID is auto-detected. Only set it if you're running the script
// unbound (e.g. as a separate standalone Apps Script project) and need to
// point it at a specific external spreadsheet.
const SPREADSHEET_ID = "";
const SHEET_NAME = "Quotes";
const PRODUCTS_SHEET_NAME = "Products";
const DRIVE_ROOT_FOLDER_NAME = "3D Print Files";

// ---------- Merchant feed (Facebook/Google Merchant compliant tab) ----------
// This tab is REBUILT from "Products" every time a product syncs (and any
// time you run rebuildMerchantFeed() by hand) — you never edit it directly.
// Its header row uses Meta/Google's exact required field names so it can be
// published (File > Share > Publish to web > this tab > CSV) and used as a
// scheduled data feed URL with zero manual field-mapping on Facebook's side.
const MERCHANT_FEED_SHEET_NAME = "Merchant Feed";
const MERCHANT_FEED_HEADERS = [
  "id", "title", "description", "availability", "condition",
  "price", "link", "image_link", "brand", "identifier_exists"
];
// Every product's "link" field points here — your storefront, WhatsApp
// Business catalog, Instagram shop, etc. This is a SINGLE constant on
// purpose: set it once below and run rebuildMerchantFeed() again if you
// ever change it — nothing else changes.
const PRODUCT_LINK_URL = ""; // e.g. "https://wa.me/c/1XXXXXXXXXX" or your storefront URL
const BRAND_NAME = ""; // your business/brand name, shown on the Merchant Feed tab
const TIMEZONE = Session.getScriptTimeZone(); // uses the spreadsheet's own timezone by default

// ISO currency code for prices. The Products tab's price column header is
// "Price (<CODE>)" and the Merchant Feed writes prices as "12.00 <CODE>".
// Set this to your currency BEFORE the sheet is first created. If you change
// it later, rename the price column header in the Products tab to match.
// (Left as "KES" so existing sheets created by earlier versions keep working.)
const CURRENCY_CODE = "KES";
const PRICE_HEADER = "Price (" + CURRENCY_CODE + ")";

// Returns the spreadsheet to write to: SPREADSHEET_ID if set (unbound
// script pointing at an external sheet), otherwise the spreadsheet this
// script is bound to (the normal/recommended setup).
function getTargetSpreadsheet() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}


// Jumia Seller Center does not accept a live feed URL like Facebook/Google —
// sellers download a category-specific mass-upload template from Seller
// Center > Products > Import Products and paste values in. This tab uses
// Jumia's core mandatory field names (present on every category template)
// so a human can copy row-by-row into whichever template a job's category
// needs. Rebuilt alongside the Merchant Feed on every product sync.
const JUMIA_FEED_SHEET_NAME = "Jumia Feed";
const JUMIA_FEED_HEADERS = [
  "SellerSku", "Product Name", "Brand", "Category (Jumia)", "Description",
  "Key Features", PRICE_HEADER, "Quantity", "Main Image URL",
  "Other Image URLs", "Colour", "Status"
];

// Writes an explicit local-time STRING (in the script's timezone — see
// TIMEZONE above) rather than a raw Date object — a raw Date is displayed by
// Sheets using the SPREADSHEET's own timezone setting (File > Settings >
// Time zone), which may differ from where the business is. This makes the
// displayed time consistent no matter what that setting is.
function localTimestamp_() {
  return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

// Extra columns Products needs for Merchant Feed compliance — added
// automatically (if missing) by ensureProductsMerchantColumns() below.
// "Source Job ID" is a bookkeeping column (not part of the Merchant Feed
// itself) that lets handleProductSync_ find and UPDATE a job's existing
// Products row instead of appending a duplicate every time "Send to
// Products" / "Resend to Products" is clicked for the same job.
const MERCHANT_PRODUCT_COLUMNS = [
  "Description", "Condition", "Availability", "Brand",
  "Hero Image URL", "Link", "GTIN", "MPN", "Source Job ID"
];

// Run this ONCE from the Apps Script editor's function dropdown
// (Run > ensureProductsMerchantColumns) to add the missing Merchant-feed
// columns to the live "Products" tab — no manual typing in the sheet
// needed. Safe to run repeatedly: only appends headers that aren't
// already present (matched by exact name), never touches existing
// columns or data, and does nothing if they're all there already.
function ensureProductsMerchantColumns() {
  const ss = getTargetSpreadsheet();
  const sheet = ss.getSheetByName(PRODUCTS_SHEET_NAME);
  if (!sheet) {
    Logger.log("ensureProductsMerchantColumns ERROR: no 'Products' tab found.");
    return;
  }

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const missing = MERCHANT_PRODUCT_COLUMNS.filter(name => headerRow.indexOf(name) === -1);

  if (!missing.length) {
    Logger.log("ensureProductsMerchantColumns — nothing to add, all columns already present.");
    hideSourceJobIdColumn_(sheet);
    return;
  }

  const startCol = lastCol + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
  sheet.getRange(1, startCol, 1, missing.length).setFontWeight("bold");
  Logger.log("ensureProductsMerchantColumns — added: " + missing.join(", "));

  // "Source Job ID" is internal bookkeeping (used by handleProductSync_ to
  // avoid duplicate rows), not something to fill in by hand — hide it so
  // it doesn't clutter the sheet. Re-hides even if it already existed but
  // was manually unhidden, since this runs every time columns are checked.
  hideSourceJobIdColumn_(sheet);
}

function hideSourceJobIdColumn_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const col = headerRow.indexOf("Source Job ID") + 1;
  if (col > 0) sheet.hideColumns(col);
}

// Column order matters — index positions below (MODEL_FILES_COL etc.) must
// stay in sync with where each name sits in this array.
const HEADERS = [
  "Job ID",           // 1
  "Date",             // 2
  "Project Name",     // 3
  "Status",           // 4
  "Quantity",         // 5
  "Materials",        // 6
  "Total Weight (g)", // 7
  "Total Value (" + CURRENCY_CODE + ")",// 8
  "Printer",          // 9
  "Received At",      // 10
  "Job Folder",       // 11
  "Model Files",      // 12
  "Images",           // 13
];
const JOB_FOLDER_COL = HEADERS.indexOf("Job Folder") + 1;   // 11
const MODEL_FILES_COL = HEADERS.indexOf("Model Files") + 1; // 12
const IMAGES_COL = HEADERS.indexOf("Images") + 1;            // 13

// ---------- Customers (companies + contact person) ----------
const CUSTOMERS_SHEET_NAME = "Customers";
const CUSTOMERS_HEADERS = [
  "Customer ID",     // 1
  "Company",         // 2
  "Contact Person",  // 3
  "Phone",           // 4
  "Email",           // 5
  "Address",         // 6
  "Notes",           // 7
  "Last Synced",     // 8
];

function getOrCreateCustomersSheet_() {
  const ss = getTargetSpreadsheet();
  let sheet = ss.getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CUSTOMERS_SHEET_NAME);
    sheet.appendRow(CUSTOMERS_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, CUSTOMERS_HEADERS.length).setFontWeight("bold");
  }
  return sheet;
}

function findCustomerRow_(sheet, customerId) {
  if (!customerId) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(customerId)) return i + 2;
  }
  return null;
}

function handleCustomerSync_(data) {
  const sheet = getOrCreateCustomersSheet_();
  const row = [
    data.customerId || "",
    data.company || "",
    data.contactPerson || "",
    data.phone || "",
    data.email || "",
    data.address || "",
    data.notes || "",
    localTimestamp_(),
  ];

  const existingRow = findCustomerRow_(sheet, data.customerId);
  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  Logger.log("Customer sync success — row written to " + CUSTOMERS_SHEET_NAME);
  return ContentService
    .createTextOutput(JSON.stringify({ status: "success", updated: !!existingRow }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    Logger.log("doPost received: " + (e && e.postData ? e.postData.contents : "NO postData"));
    const data = JSON.parse(e.postData.contents);

    if (data.type === "modelFile") return handleFileUpload_(data, MODEL_FILES_COL);
    if (data.type === "image") return handleFileUpload_(data, IMAGES_COL);
    if (data.type === "product") return handleProductSync_(data);
    if (data.type === "customer") return handleCustomerSync_(data);
    return handleJobSync_(data);
  } catch (err) {
    Logger.log("doPost ERROR: " + err + " | Stack: " + (err && err.stack));
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ---------- Job sync (Quotes sheet rows) ----------

function handleJobSync_(data) {
  const sheet = getOrCreateSheet_();
  const row = new Array(HEADERS.length).fill("");
  row[0] = data.jobId || "";
  row[1] = data.date || "";
  row[2] = data.projectName || "";
  row[3] = data.status || "";
  row[4] = data.quantity || "";
  row[5] = data.materials || "";
  row[6] = data.totalWeightGrams || "";
  row[7] = data.totalValueKes || "";
  row[8] = data.printer || "";
  row[9] = localTimestamp_();
  // Job Folder / Model Files / Images (indices 10-12) left blank here —
  // filled by handleFileUpload_, and preserved below if the row exists.

  const existingRow = findRowByJobId_(sheet, data.jobId);
  if (existingRow) {
    // Don't blank out attachment links that were already recorded.
    row[JOB_FOLDER_COL - 1] = sheet.getRange(existingRow, JOB_FOLDER_COL).getValue();
    row[MODEL_FILES_COL - 1] = sheet.getRange(existingRow, MODEL_FILES_COL).getValue();
    row[IMAGES_COL - 1] = sheet.getRange(existingRow, IMAGES_COL).getValue();
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  Logger.log("doPost success — row written to sheet: " + sheet.getName());
  return ContentService
    .createTextOutput(JSON.stringify({ status: "success", updated: !!existingRow }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Product sync (Products sheet rows) ----------

function handleProductSync_(data) {
  const ss = getTargetSpreadsheet();
  const sheet = ss.getSheetByName(PRODUCTS_SHEET_NAME);
  if (!sheet) {
    Logger.log("Product sync ERROR: no 'Products' tab found.");
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: "No 'Products' tab found in the spreadsheet." }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colIndex = {};
  headerRow.forEach((h, i) => {
    const key = String(h).trim();
    if (key) colIndex[key] = i + 1;
  });

  // Upsert, not always-append: if this job already has a Products row
  // (tracked via the "Source Job ID" column), update that row in place.
  // Otherwise create a new one. Without this, clicking "Resend to
  // Products" on the same job repeatedly — which happens naturally while
  // troubleshooting a deployment — added a brand-new duplicate row every
  // single time.
  const existingProductRow = data.jobId ? findProductRowByJobId_(sheet, colIndex, data.jobId) : null;
  let targetRow;

  if (existingProductRow) {
    targetRow = existingProductRow;
  } else {
    const lastRow = sheet.getLastRow();
    targetRow = lastRow + 1;
    // Carry every formula-driven column (Product ID, SKU, and anything
    // else formula-based) down from the row above, the same way you'd
    // drag-fill in the sheet — this is what keeps auto-numbering and the
    // SKU lookup working without ever typing into columns A/B directly.
    // Only done for genuinely NEW rows — an update never touches these.
    if (lastRow >= 2) {
      sheet.getRange(lastRow, 1, 1, lastCol).copyTo(sheet.getRange(targetRow, 1, 1, lastCol));
    }
  }

  // Also confirm the job's Drive FOLDER link makes it onto this Products
  // row (for humans browsing the sheet), and separately resolve ONE direct
  // image FILE link (the "hero" image — first photo uploaded for the job)
  // for the Merchant Feed, which needs a single hotlinkable image, not a
  // folder. Both are looked up from the "Quotes" tab, where uploads write
  // their links (Job Folder column / Images column) as each file lands.
  const jobFolderUrl = getJobFolderUrl_(data.jobId);
  const heroImageUrl = getFirstImageUrl_(data.jobId);

  // Matched by header name, not column position — so adding Merchant-feed
  // columns (Description, Link, Condition, Availability, Brand, GTIN, MPN,
  // Hero Image URL) to the sheet later is picked up automatically with no
  // code change.
  const fieldsByHeader = {
    "Product Name": data.productName || "",
    "Category": data.category || "",
    [PRICE_HEADER]: data.priceKes || "",
    "Stock Quantity": data.stockQuantity != null ? data.stockQuantity : 1,
    "Material": data.material || "",
    "Colour": data.colour || "",
    "Notes / Features": data.notes || "",
    // The job's Drive folder link (all files/photos for this job) — falls
    // back to whatever the calculator sent if the Quotes row lookup misses.
    "Image (Drive link / filename)": jobFolderUrl || data.imageLink || "",
    "Status": data.status || "Draft",
    "Last Synced": localTimestamp_(),
    "Description": data.description || "",
    "Link": data.link || "",
    "Condition": data.condition || "new",
    "Availability": data.availability || "",
    "Brand": data.brand || "",
    "GTIN": data.gtin || "",
    "MPN": data.mpn || "",
    "Hero Image URL": heroImageUrl || "",
    "Source Job ID": data.jobId || ""
  };

  Object.keys(fieldsByHeader).forEach((headerName) => {
    const col = colIndex[headerName];
    if (col) sheet.getRange(targetRow, col).setValue(fieldsByHeader[headerName]);
  });

  Logger.log("Product sync success — row " + targetRow + " " + (existingProductRow ? "updated" : "created") + " in " + PRODUCTS_SHEET_NAME);

  // Keep the Merchant Feed and Jumia Feed tabs current every time a
  // product is sent — no separate manual step needed.
  try { rebuildMerchantFeed(); } catch (feedErr) {
    Logger.log("Merchant feed rebuild ERROR (product sync still succeeded): " + feedErr);
  }
  try { rebuildJumiaFeed(); } catch (jumiaErr) {
    Logger.log("Jumia feed rebuild ERROR (product sync still succeeded): " + jumiaErr);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: "success", row: targetRow, updated: !!existingProductRow }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Finds an existing Products row for a given Job ID, via the "Source Job
// ID" column. Returns null if that column doesn't exist yet (sheet hasn't
// had ensureProductsMerchantColumns run) or no match is found — in both
// cases handleProductSync_ falls back to creating a new row, same as
// before this dedupe existed.
function findProductRowByJobId_(sheet, colIndex, jobId) {
  const col = colIndex["Source Job ID"];
  if (!col) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(jobId).trim()) return i + 2;
  }
  return null;
}

// ---------- Merchant feed rebuild ----------
// Run this manually from the Apps Script editor's function dropdown the
// first time (Run > rebuildMerchantFeed) to create the tab immediately,
// without waiting for the next "Send to Products". It's also called
// automatically at the end of every product sync above.
function rebuildMerchantFeed() {
  const ss = getTargetSpreadsheet();
  ensureProductsMerchantColumns(); // self-heals missing columns before reading them
  const products = ss.getSheetByName(PRODUCTS_SHEET_NAME);
  if (!products) {
    Logger.log("Merchant feed ERROR: no 'Products' tab found.");
    return;
  }

  let feed = ss.getSheetByName(MERCHANT_FEED_SHEET_NAME);
  if (!feed) {
    feed = ss.insertSheet(MERCHANT_FEED_SHEET_NAME);
  }
  feed.clear();
  feed.getRange(1, 1, 1, MERCHANT_FEED_HEADERS.length).setValues([MERCHANT_FEED_HEADERS]);
  feed.setFrozenRows(1);
  feed.getRange(1, 1, 1, MERCHANT_FEED_HEADERS.length).setFontWeight("bold");

  const lastRow = products.getLastRow();
  const lastCol = products.getLastColumn();
  if (lastRow < 2) return; // no product rows yet

  const headerRow = products.getRange(1, 1, 1, lastCol).getValues()[0];
  const colIndex = {};
  headerRow.forEach((h, i) => { const k = String(h).trim(); if (k) colIndex[k] = i; });
  const rows = products.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const get = (row, header) => {
    const i = colIndex[header];
    return i != null ? row[i] : "";
  };

  const outRows = [];
  rows.forEach((row) => {
    const productName = String(get(row, "Product Name") || "").trim();
    const status = String(get(row, "Status") || "").trim();
    // Only publish rows that actually have a name and aren't Draft/Discontinued —
    // adjust this filter if you want Draft items excluded/included differently.
    if (!productName || status === "Draft" || status === "Discontinued") return;

    const sku = String(get(row, "SKU") || "").trim();
    const priceKes = get(row, PRICE_HEADER);
    const stockQty = Number(get(row, "Stock Quantity")) || 0;
    const description = String(get(row, "Description") || get(row, "Notes / Features") || productName).trim();
    // image_link needs ONE direct, hotlinkable image file — never the
    // Drive folder link that lives in "Image (Drive link / filename)".
    // "Hero Image URL" (first photo uploaded for the job, resolved at
    // product-sync time by getFirstImageUrl_) is the only source for this.
    // Left blank if no photo has been uploaded yet — better than pointing
    // Facebook at a folder it can't render.
    const heroImage = String(get(row, "Hero Image URL") || "").trim();
    const condition = String(get(row, "Condition") || "new").trim() || "new";
    const availability = String(get(row, "Availability") || "").trim() || (stockQty > 0 ? "in stock" : "out of stock");
    const brand = String(get(row, "Brand") || "").trim() || BRAND_NAME;
    // Per-row "Link" column (if you ever fill one in) wins; otherwise every
    // product falls back to the single shared PRODUCT_LINK_URL above.
    const link = String(get(row, "Link") || "").trim() || PRODUCT_LINK_URL;

    outRows.push([
      sku,
      productName,
      description,
      availability,
      condition,
      priceKes ? Number(priceKes).toFixed(2) + " " + CURRENCY_CODE : "",
      link,
      driveDirectImageUrl_(heroImage),
      brand,
      "no" // identifier_exists — these are handmade goods with no GTIN/MPN
    ]);
  });

  if (outRows.length) {
    feed.getRange(2, 1, outRows.length, MERCHANT_FEED_HEADERS.length).setValues(outRows);
  }
  Logger.log("Merchant feed rebuilt — " + outRows.length + " row(s) written to " + MERCHANT_FEED_SHEET_NAME);
}

// ---------- Jumia feed rebuild ----------
// Run this manually from the Apps Script editor's function dropdown the
// first time (Run > rebuildJumiaFeed) to create the tab immediately,
// without waiting for the next "Send to Products". Also called
// automatically at the end of every product sync above, right after
// rebuildMerchantFeed(). Unlike Merchant Feed, this is NOT a publishable
// feed URL — Jumia requires the category-specific template downloaded from
// Seller Center, so this tab exists purely to make copy/pasting into that
// template fast: same row order as Products, Jumia's own field names.
function rebuildJumiaFeed() {
  const ss = getTargetSpreadsheet();
  ensureProductsMerchantColumns(); // self-heals missing columns before reading them
  const products = ss.getSheetByName(PRODUCTS_SHEET_NAME);
  if (!products) {
    Logger.log("Jumia feed ERROR: no 'Products' tab found.");
    return;
  }

  let feed = ss.getSheetByName(JUMIA_FEED_SHEET_NAME);
  if (!feed) {
    feed = ss.insertSheet(JUMIA_FEED_SHEET_NAME);
  }
  feed.clear();
  feed.getRange(1, 1, 1, JUMIA_FEED_HEADERS.length).setValues([JUMIA_FEED_HEADERS]);
  feed.setFrozenRows(1);
  feed.getRange(1, 1, 1, JUMIA_FEED_HEADERS.length).setFontWeight("bold");

  const lastRow = products.getLastRow();
  const lastCol = products.getLastColumn();
  if (lastRow < 2) return; // no product rows yet

  const headerRow = products.getRange(1, 1, 1, lastCol).getValues()[0];
  const colIndex = {};
  headerRow.forEach((h, i) => { const k = String(h).trim(); if (k) colIndex[k] = i; });
  const rows = products.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const get = (row, header) => {
    const i = colIndex[header];
    return i != null ? row[i] : "";
  };

  const outRows = [];
  rows.forEach((row) => {
    const productName = String(get(row, "Product Name") || "").trim();
    const status = String(get(row, "Status") || "").trim();
    // Same publish gate as the Merchant Feed — only real, live products.
    if (!productName || status === "Draft" || status === "Discontinued") return;

    const sku = String(get(row, "SKU") || "").trim();
    const brand = String(get(row, "Brand") || "").trim() || BRAND_NAME;
    const description = String(get(row, "Description") || get(row, "Notes / Features") || productName).trim();
    const priceKes = get(row, PRICE_HEADER);
    const stockQty = Number(get(row, "Stock Quantity")) || 0;
    const heroImage = driveDirectImageUrl_(String(get(row, "Hero Image URL") || "").trim());
    const colour = String(get(row, "Colour") || "").trim();

    outRows.push([
      sku,
      productName,
      brand,
      "", // Category (Jumia) — Jumia's own taxonomy, not a 1:1 map from internal Category; fill in manually
      description,
      description, // Key Features — same text by default; edit per-product for real bullet highlights
      priceKes ? Number(priceKes).toFixed(2) : "",
      stockQty,
      heroImage,
      "", // Other Image URLs — only the hero image is auto-resolved; add more manually if needed
      colour,
      status
    ]);
  });

  if (outRows.length) {
    feed.getRange(2, 1, outRows.length, JUMIA_FEED_HEADERS.length).setValues(outRows);
  }
  Logger.log("Jumia feed rebuilt — " + outRows.length + " row(s) written to " + JUMIA_FEED_SHEET_NAME);
}

// Facebook/Google need a direct, publicly-loadable image URL ending in the
// image itself — a Drive "folder" link or a "/view" share link do NOT work.
// This converts a Drive file share link into Drive's direct-content form.
// Anything that isn't a recognizable Drive file link is passed through
// unchanged (e.g. an image already hosted on your own site).
function driveDirectImageUrl_(rawLink) {
  if (!rawLink) return "";
  const match = rawLink.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || rawLink.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (match) return "https://drive.google.com/uc?export=view&id=" + match[1];
  return rawLink;
}

// ---------- File / image upload (Drive) ----------

function handleFileUpload_(data, targetColumn) {
  const jobId = data.jobId || "unknown-job";
  const productName = data.productName || "Untitled";
  const fileName = data.fileName || "file";
  const mimeType = data.mimeType || "application/octet-stream";

  const bytes = Utilities.base64Decode(data.base64Data);
  const blob = Utilities.newBlob(bytes, mimeType, fileName);

  const jobFolder = getOrCreateJobFolder_(jobId, productName);
  // Images go in a nested "Images" subfolder, STL/3MF model files in a
  // nested "Files" subfolder — both inside the one project folder, per
  // <root>/<job folder>/Images and <root>/<job folder>/Files.
  const subfolderName = targetColumn === IMAGES_COL ? "Images" : "Files";
  const folder = getOrCreateSubfolder_(jobFolder, subfolderName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const fileUrl = file.getUrl();

  Logger.log("File uploaded to column " + targetColumn + " (" + subfolderName + " subfolder): " + fileUrl);

  // The one-click "Job Folder" link in the sheet always points at the TOP
  // project folder (containing both Images and Files), not a subfolder.
  setJobFolderLink_(jobId, jobFolder.getUrl());
  appendAttachmentLink_(jobId, targetColumn, fileName, fileUrl);

  return ContentService
    .createTextOutput(JSON.stringify({ status: "success", url: fileUrl }))
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeFolderName_(name) {
  return String(name)
    .replace(/[\/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function getOrCreateJobFolder_(jobId, productName) {
  const rootIter = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
  const root = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder(DRIVE_ROOT_FOLDER_NAME);

  const folderName = sanitizeFolderName_(jobId) + "_" + sanitizeFolderName_(productName);
  const existingIter = root.getFoldersByName(folderName);
  if (existingIter.hasNext()) return existingIter.next();
  const newFolder = root.createFolder(folderName);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return newFolder;
}

// Gets (or creates) a named subfolder directly inside a parent folder —
// used for the "Images" / "Files" split inside each job's project folder.
function getOrCreateSubfolder_(parentFolder, subfolderName) {
  const iter = parentFolder.getFoldersByName(subfolderName);
  if (iter.hasNext()) return iter.next();
  const sub = parentFolder.createFolder(subfolderName);
  sub.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return sub;
}

// Writes (or refreshes) the one-click folder link for a job — this is the
// single link that opens everything (all model files and images) for that
// job at once, rather than clicking through individual file links.
function setJobFolderLink_(jobId, folderUrl) {
  const sheet = getOrCreateSheet_();
  const existingRow = findRowByJobId_(sheet, jobId);
  if (existingRow) {
    sheet.getRange(existingRow, JOB_FOLDER_COL).setValue(folderUrl);
  } else {
    const row = new Array(HEADERS.length).fill("");
    row[0] = jobId;
    row[JOB_FOLDER_COL - 1] = folderUrl;
    sheet.appendRow(row);
  }
}

function appendAttachmentLink_(jobId, targetColumn, fileName, fileUrl) {
  const sheet = getOrCreateSheet_();
  const linkText = fileName + ": " + fileUrl;
  const existingRow = findRowByJobId_(sheet, jobId);

  if (existingRow) {
    const cell = sheet.getRange(existingRow, targetColumn);
    const current = cell.getValue();
    cell.setValue(current ? current + "\n" + linkText : linkText);
  } else {
    // No matching Quotes row yet (upload happened before the job synced) —
    // create a minimal row so the link isn't lost.
    const row = new Array(HEADERS.length).fill("");
    row[0] = jobId;
    row[targetColumn - 1] = linkText;
    sheet.appendRow(row);
  }
}

// ---------- Job Folder / hero image lookups (Quotes tab) ----------
// Both uploaders write into "Quotes": handleFileUpload_ always refreshes
// the Job Folder link, and appendAttachmentLink_ appends "fileName: url"
// lines (one per file) into the Images column. These two helpers just read
// those back out for a given Job ID.

function getJobFolderUrl_(jobId) {
  if (!jobId) return "";
  const sheet = getOrCreateSheet_();
  const row = findRowByJobId_(sheet, jobId);
  if (!row) return "";
  return String(sheet.getRange(row, JOB_FOLDER_COL).getValue() || "").trim();
}

// Returns the direct Drive URL of the FIRST photo uploaded for a job (the
// "hero" image) — i.e. the first line in the Images column, which is
// "fileName: https://drive.google.com/file/d/.../view". Converted to a
// hotlinkable form by driveDirectImageUrl_ before use.
function getFirstImageUrl_(jobId) {
  if (!jobId) return "";
  const sheet = getOrCreateSheet_();
  const row = findRowByJobId_(sheet, jobId);
  if (!row) return "";
  const raw = String(sheet.getRange(row, IMAGES_COL).getValue() || "").trim();
  if (!raw) return "";
  const firstLine = raw.split("\n")[0];
  const colonIdx = firstLine.indexOf(": ");
  const url = colonIdx === -1 ? firstLine : firstLine.slice(colonIdx + 2);
  return driveDirectImageUrl_(url.trim());
}

// Lets you sanity-check the deployed URL by opening it in a browser.
// Bump this string any time you paste updated code in, then redeploy.
// Open the deployed /exec URL directly in a browser afterward — if it
// still shows an OLD version number, the deployment didn't actually pick
// up your changes (Save ≠ Redeploy — see README/chat for the exact steps).
const CODE_VERSION = "2026-08-08-jumia-feed-v3";

function doGet(e) {
  return ContentService
    .createTextOutput("Portable 3D Quote Calculator sync endpoint is live. Version: " + CODE_VERSION)
    .setMimeType(ContentService.MimeType.TEXT);
}

function findRowByJobId_(sheet, jobId) {
  if (!jobId) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === jobId) return i + 2; // +2: header row + 1-indexing
  }
  return null;
}

function getOrCreateSheet_() {
  const ss = getTargetSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    return sheet;
  }

  // Upgrade an existing sheet that predates any newer columns — fills in
  // whichever header cells are missing/blank, regardless of how many
  // versions behind it is, without disturbing existing data.
  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  let needsUpdate = false;
  const upgradedHeaders = HEADERS.map((name, i) => {
    if (currentHeaders[i] === name) return currentHeaders[i];
    needsUpdate = true;
    return name;
  });
  if (needsUpdate) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([upgradedHeaders]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
  return sheet;
}
