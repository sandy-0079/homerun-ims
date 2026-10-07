// Reference-data downloads for the Tool Output tab (2026-10-07): Inner Case Pack - Mid
// Mile and Purchase Prices. Neither serialises engine output — they show the inputs the
// DC team and procurement asked to check against their own sheets.
//
// Both emit EVERY master SKU so the row set is stable (a sheet VLOOKUP never loses a
// row because a value is missing) and sort Category → Brand → Item Name, the same order
// as the Zero Sale file.
//
// ⚠ INNER CASE PACK: `params/innerCasePacks` is written by the TO tool's
// scripts/build-innercasepacks.mjs (homerun-to repo) from the DC team's Google Sheet. It
// stores ONLY packs > 1; the TO tool treats every other SKU as pack 1. The file prints 1
// for those because that is what is IN EFFECT on TO quantities — the question this card
// answers. The row is fetched on click, not at page load, so a long-open tab still gets
// the live values.
//
// ⚠ PURCHASE PRICE: `priceData` is Zoho's 12-month AVERAGE purchase price
// (`average_price`, sync-catalogue nightly, PRICE_MONTHS = 12) — not the item's current
// purchase rate. The header says so, so nobody reads it as the latest rate. A SKU with
// no price is BLANK, never 0: "no price" must not read as "costs nothing".

import { normaliseStatus } from "./skuStatus.js";

export const INNER_CASE_PACK_CSV_HEADERS = ["Item Name", "SKU", "Category", "Brand", "Status", "Inner Case Pack"];
export const PURCHASE_PRICE_CSV_HEADERS = ["Item Name", "SKU", "Category", "Brand", "Status", "Avg Purchase Price 12 mo (₹)"];

const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
// Uncategorised SKUs (placeholder rows like "Asian Paint group 4") sort LAST, not first.
const catKey = (c) => (c ? c : "\uffff");
const byCatBrandName = (a, b) =>
  catKey(a.category).localeCompare(catKey(b.category)) ||
  (a.brand || "").localeCompare(b.brand || "") ||
  (a.name || "").localeCompare(b.name || "");

// Same validity rule as the TO tool's solver (`packOf`): a whole number ≥ 1, else 1.
const packOf = (n) => (Number.isInteger(n) && n >= 1 ? n : 1);

function build(headers, skuMaster, valueOf) {
  const rows = Object.values(skuMaster || {}).filter((s) => s?.sku).sort(byCatBrandName);
  if (!rows.length) return null;
  const body = rows.map((s) => [
    q(s.name || s.sku), q(s.sku), q(s.category), q(s.brand), q(normaliseStatus(s.status)), valueOf(s.sku),
  ].join(","));
  return [headers.join(","), ...body].join("\n") + "\n";
}

/** packs = params/innerCasePacks payload.packs ({sku: n}, only n > 1 stored). */
export function buildInnerCasePackCsv({ skuMaster, packs }) {
  return build(INNER_CASE_PACK_CSV_HEADERS, skuMaster, (sku) => packOf(packs?.[sku]));
}

/** priceData = team_data/global payload.priceData ({sku: average_price}). */
export function buildPurchasePriceCsv({ skuMaster, priceData }) {
  return build(PURCHASE_PRICE_CSV_HEADERS, skuMaster, (sku) => {
    const p = Number(priceData?.[sku]);
    return p > 0 ? String(Math.round(p * 100) / 100) : "";
  });
}

/** How many master SKUs carry a usable price — the count the file will actually show.
 *  NOT Object.keys(priceData).length: priceData also holds SKUs absent from the master
 *  (2,568 keys vs 2,452 priced master rows on 2026-10-07). */
export const countPricedSkus = (skuMaster, priceData) =>
  Object.keys(skuMaster || {}).filter((sku) => Number(priceData?.[sku]) > 0).length;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const innerCasePackFilename = (d = new Date()) => `Inner_Case_Pack_Mid_Mile_${ymd(d)}.csv`;
export const purchasePriceFilename = (d = new Date()) => `Purchase_Prices_${ymd(d)}.csv`;
