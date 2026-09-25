// Read back one store's go-live state. READ-ONLY: plain GETs, writes nothing.
//
//   node scripts/check-new-store.mjs DS08
//
// Written for DS08 (live on IMS 2026-09-25), kept for the next store. Like
// nightly-readback.mjs, it REPORTS what the data says and asserts only what the
// code guarantees. Everything a human decides (how many floors, the plywood
// capacity, whether a TO has been raised yet) is printed, not judged. See root
// CLAUDE.md: "hardcode only what the code guarantees; derive what the data decides".

const DS = (process.argv[2] || "").toUpperCase();
if (!/^DS\d\d$/.test(DS)) {
  console.error("usage: node scripts/check-new-store.mjs DS08");
  process.exit(1);
}

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };
const get = async (table, id) => {
  const r = await fetch(`${B}/${table}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
  return (await r.json())[0]?.payload ?? null;
};
const ist = (s) =>
  s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }) : "(never)";
const agoMin = (s) => (s ? Math.round((Date.now() - new Date(s)) / 60000) : Infinity);

const [glob, tt, team, audit, pins, nets, inv] = await Promise.all([
  get("params", "global"), get("params", "toTargets"), get("team_data", "global"),
  get("params", "toAudit"), get("params", "pincodeMap"), get("params", "networkConfigs"),
  get("team_data", "invoice_data"),
]);

// ── 1. Gate ──────────────────────────────────────────────────────────────────
// Read with ??, never || — [] is the legitimate "all trading" end state.
const opening = glob?.openingDSList ?? [];
const gated = opening.includes(DS);
console.log(`\n${DS}  ${gated ? "GATED (in openingDSList)" : "LIVE on IMS (not in openingDSList)"}`);
console.log(`  newDSList: ${JSON.stringify(glob?.newDSList ?? [])} — ${DS} ${(glob?.newDSList ?? []).includes(DS) ? "IS" : "is NOT"} on the New DS Floor`);

// ── 2. Stock sync ────────────────────────────────────────────────────────────
// Which cron slot a store belongs to is the migration's business, so this prints the
// minute rather than asserting one. A stamp on the slot's minute means a CRON wrote
// it; any other minute means a manual pull (Sync Now, the TO tool, or by hand).
const per = team?.stockUploadedAtPerDS ?? {};
const ts = per[DS];
const m = agoMin(ts);
console.log(`\nSTOCK  last sync ${ist(ts)}  (${m}m ago, written at minute :${ts ? new Date(ts).toISOString().slice(14, 16) : "--"} UTC)`);
let soh = 0, sohUnits = 0, transit = 0, transitUnits = 0, keys = 0;
for (const v of Object.values(team?.stockData ?? {})) {
  const d = v?.[DS];
  if (!d) continue;
  keys++;
  if ((d.stock_on_hand ?? 0) > 0) { soh++; sohUnits += d.stock_on_hand; }
  if ((d.in_transit ?? 0) > 0) { transit++; transitUnits += d.in_transit; }
}
console.log(`  ${keys} SKU keys · ${soh} on hand (${sohUnits} units) · ${transit} in transit (${transitUnits} units)`);
if (!keys) console.log("  ⚠ NO KEYS — an unreachable branch yields no keys at all; an empty-but-wired one yields ~3,000 zeros");
if (!gated && m > 90) console.log(`  ⚠ stale for a live store — check its cron (stock-sync-5 for DS08)`);

// ── 3. Published targets ─────────────────────────────────────────────────────
const targets = Object.values(tt?.targets ?? {});
let skus = 0, sMin = 0, sMax = 0, plySkus = 0, plyMax = 0;
for (const t of targets) {
  const v = t?.perDS?.[DS];
  if (!v) continue;
  if ((v.min ?? 0) > 0 || (v.max ?? 0) > 0) skus++;
  sMin += v.min ?? 0; sMax += v.max ?? 0;
  if (/ply/i.test(t.category ?? "") && (v.max ?? 0) > 0) { plySkus++; plyMax += v.max; }
}
console.log(`\nTARGETS  toTargets written ${ist(tt?.refreshedAt)}`);
console.log(`  ${skus} SKUs with a target · ΣMin ${sMin} · ΣMax ${sMax}`);
if (gated && skus) console.log(`  ❌ A GATED STORE CARRIES TARGETS — applyOpeningToStores should zero it`);
console.log(`  toTargets.invValue ${tt?.invValue ? "stamped" : "ABSENT (a browser Apply strips it — Open Work #28; the next nightly re-stamps it)"}`);

// ── 4. Plywood capacity — lives in networkConfigs, NOT params/global.dsCapacities ─
const cap = nets?.[DS];
const thick = cap?.thick?.capacity, thin = cap?.thin?.capacity;
console.log(`\nPLYWOOD  ${plySkus} SKUs with a target · ΣMax ${plyMax}`);
console.log(cap
  ? `  capacity thick ${thick ?? "unset"} / thin ${thin ?? "unset"}`
  : `  ⚠ no networkConfigs.${DS} row — capacity unset means NO CAP (not zero stock). Ops decide the number.`);

// ── 5. Catchment ─────────────────────────────────────────────────────────────
const map = pins?.map ?? pins ?? {};
const mine = Object.entries(map).filter(([, v]) => (typeof v === "string" ? v : v?.ds) === DS).length;
console.log(`\nPINCODES  ${mine} of ${Object.keys(map).length} mapped to ${DS}`);

// ── 6. Transfer orders into Zoho ─────────────────────────────────────────────
// Drafts are pick lists: several overlapping drafts to one store are normal.
const entries = (audit?.entries ?? []).filter((e) => e.toDsId === DS);
console.log(`\nTOs raised through the tool (params/toAudit): ${entries.length}`);
for (const e of entries.slice(0, 5)) console.log(`  ${e.transfer_order_number}  ${ist(e.at)}  ${e.lineCount} lines · ${e.units} units · ${e.by}`);
if (!entries.length) console.log("  none yet — the Zoho write to this branch is unproven until one lands");
const toc = Object.values(team?._toCache ?? {}).filter((t) => t.ds === DS);
for (const t of toc) console.log(`  cache: ${t.to_number} ${t.status} ${t.date} · ${Object.keys(t.skus ?? {}).length} lines`);

// ── 7. Invoices (only once the store trades) ─────────────────────────────────
const rows = (inv?.invoiceData ?? inv ?? []).filter?.((r) => r.ds === DS) ?? [];
const dates = [...new Set(rows.map((r) => r.date))].sort();
console.log(`\nINVOICES fulfilled by ${DS}: ${rows.length} rows over ${dates.length} dates${dates.length ? ` (${dates[0]} → ${dates.at(-1)})` : ""}`);
if (!rows.length) console.log("  none yet — expected until the store trades; dsOf() reads the first word of Zoho's location_name");
console.log("");
