/**
 * Ad-hoc: Zero-Sale SKU lists for L60D / L75D / L90D — the read-only oracle for the
 * "Zero Sale SKUs" card on the Tool Output Download tab.
 *
 * READ-ONLY. Writes nothing to Supabase; output goes to validation-out/ (gitignored).
 *
 * ⚠ THIS SCRIPT NOW IMPORTS `src/zeroSaleCsv.js` — the same module the card uses — so
 * the two CANNOT drift. It deliberately did NOT at first: it was written as an
 * independent implementation, and the card was verified against it by diffing real
 * output (2026-09-17: three files, byte-identical, 547 / 529 / 517 SKUs). That diff was
 * meaningful precisely because the two implementations shared no code. Having banked
 * the evidence, sharing the module is now strictly better than keeping a second copy
 * that can rot — the duplicated-Stock-Health-filter shape.
 *
 * What remains here is what the CARD cannot do: assertions. The card must not throw at
 * a user, so it degrades (it disables a button when a window is short). A script can
 * refuse loudly, which is the whole point of running it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  summariseZeroSale, buildZeroSaleCsv, zeroSaleFilename, ZERO_SALE_WINDOWS,
} from "../src/zeroSaleCsv.js";

const URL = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const OUT_DIR = process.argv[2] || "validation-out/zero-sale";

const get = async (table, id) => {
  const r = await fetch(`${URL}/${table}?id=eq.${id}&select=payload`, { headers: { apikey: KEY } });
  if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
  const rows = await r.json();
  if (!rows.length) throw new Error(`${table}/${id}: row not found`);
  return rows[0].payload;
};

const invRow = await get("team_data", "invoice_data");
const invoiceData = invRow.invoiceData || invRow;
const global = await get("team_data", "global");
const params = await get("params", "global");

const skuMaster = global.skuMaster || {};
const priceData = global.priceData || {};
const priceTiers = params.priceTiers;

const summary = summariseZeroSale({ invoiceData, skuMaster, windows: ZERO_SALE_WINDOWS });

const dates = [...new Set(invoiceData.map((r) => r.date))].sort();
const span = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 864e5 + 1;

console.log(`invoice rows      : ${invoiceData.length.toLocaleString()}`);
console.log(`distinct dates    : ${summary.dateCount}  (${dates[0]} -> ${summary.latest})`);
console.log(`calendar span     : ${span} days  contiguous: ${span === summary.dateCount}`);
console.log(`skuMaster         : ${Object.keys(skuMaster).length.toLocaleString()} SKUs`);
console.log(`active SKUs       : ${summary.activeCount.toLocaleString()}`);
console.log(`priceTiers        : ${JSON.stringify(priceTiers)}\n`);

// A window is "the last N DATES PRESENT", so a gap means "last N dates" != "last N
// days" and an L<N>D label would overstate the coverage. The card handles this by
// naming the resolved range in the filename; here we can simply refuse.
if (span !== summary.dateCount) {
  throw new Error(`Invoice dates are NOT contiguous (${summary.dateCount} dates over ${span} days). ` +
    `"L<N>D" would be misleading -- resolve before trusting these lists.`);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const w of summary.windows) {
  if (!w.available) throw new Error(`Asked for L${w.days}D but only ${summary.dateCount} dates exist.`);
  const csv = buildZeroSaleCsv({ skus: w.skus, priceData, priceTiers });
  const file = `${OUT_DIR}/${zeroSaleFilename(w)}`;
  writeFileSync(file, csv);
  console.log(`L${w.days}D  ${w.from} -> ${w.to}  ${String(w.skus.length).padStart(4)} zero-sale active SKUs  -> ${file}`);
}

// Nesting check: a SKU with no sales in 90 days necessarily had none in 60. It is free
// to assert and it is the one property that catches a window built wrong.
console.log("");
const skusOf = (w) => new Set(w.skus.map((s) => s.sku));
for (let i = 1; i < summary.windows.length; i++) {
  const wider = summary.windows[i], narrower = summary.windows[i - 1];
  const narrowSet = skusOf(narrower);
  const outside = [...skusOf(wider)].filter((s) => !narrowSet.has(s));
  console.log(`L${wider.days}D subset of L${narrower.days}D : ${outside.length === 0 ? "OK" : `FAIL (${outside.length} outside)`}`);
}
const [first, , last] = summary.windows;
console.log(`\nwoke up between L${last.days}D and L${first.days}D: ${first.skus.length - last.skus.length} SKUs sold something in the older 30 days but nothing in the last 60.`);
