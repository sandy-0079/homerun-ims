// Snapshot every input `runEngine` consumes to a local JSON file.
//
//   npx vite-node scripts/snapshot-engine-inputs.mjs [out.json]
//
// READ-ONLY against Supabase — plain GETs, writes nothing to any table.
//
// ⚠ WHY A SNAPSHOT RATHER THAN TWO LIVE DUMPS. Prod inputs move every night: the
// invoice window slides, the retention trim drops a date, sync-catalogue rewrites
// skuMaster, the floors sheet is re-read at 04:35. So "dump today, dump again after
// the change" shows differences from the CLOCK, not from the code — noise that looks
// exactly like a regression. Freezing the inputs to disk makes the before/after
// comparison deterministic and offline: same bytes in, so any difference out is ours.
//
// This is the same shape as the inertness proof CLAUDE.md records for the Dead Stock
// fix ("a git stash of the one engine file gets you the 'before'; dump both to JSON
// and diff") — this just removes the network from the middle of it.
//
// The six inputs, and the two traps in assembling them:
//   1. params/global merged over DEFAULT_PARAMS — SHALLOW, so a nested key absent
//      from prod falls back to the default (the fixedUnitFloor.minNZD trap).
//   2. the own-row configs re-attached via loadParamConfigRows — the trap where 2 of
//      3 rebuild sites missed pincodeConfig and page loads silently reverted
//      attribution to "location" for weeks.

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };

const load = async (table, id) => {
  const r = await fetch(`${B}/${table}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
  const rows = await r.json();
  return rows[0]?.payload ?? null;
};

const out = process.argv[2] || "engine-inputs-snapshot.json";

const t0 = Date.now();
const [sbParams, team, invRow, sbOverrides] = await Promise.all([
  load("params", "global"),
  load("team_data", "global"),
  load("team_data", "invoice_data"),
  load("overrides", "global"),
]);

const activeParams = sbParams ? { ...DEFAULT_PARAMS, ...sbParams } : DEFAULT_PARAMS;
const cfg = await loadParamConfigRows((id) => load("params", id), DS_LIST);
Object.assign(activeParams, cfg.extra);

const invoiceData = invRow?.invoiceData ?? [];
const dates = [...new Set(invoiceData.map((r) => r.date))].sort();

// deadStock is stored as an ARRAY and consumed as a Set — keep the array in the
// snapshot and re-wrap on replay, so the file stays plain JSON.
const snapshot = {
  capturedAt: new Date().toISOString(),
  gitHead: (() => {
    try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
    catch { return "unknown"; }
  })(),
  fingerprint: {
    invoiceRows: invoiceData.length,
    invoiceDates: dates.length,
    invoiceDataThrough: dates[dates.length - 1] ?? null,
    invoiceDataFrom: dates[0] ?? null,
    skuMaster: Object.keys(team?.skuMaster ?? {}).length,
    minReqQty: Object.keys(team?.minReqQty ?? {}).length,
    newSKUQty: Object.keys(team?.newSKUQty ?? {}).length,
    priceData: Object.keys(team?.priceData ?? {}).length,
    deadStock: (team?.deadStock ?? []).length,
    skuCeiling: Object.keys(team?.skuCeiling ?? {}).length,
    coreOverrides: Object.keys(sbOverrides ?? {}).length,
    attributionMode: activeParams.pincodeConfig?.mode ?? null,
    ownRowConfigs: Object.keys(cfg.extra),
  },
  inputs: {
    invoiceData,
    skuMaster: team?.skuMaster ?? {},
    minReqQty: team?.minReqQty ?? {},
    priceData: team?.priceData ?? {},
    deadStock: team?.deadStock ?? [],
    newSKUQty: team?.newSKUQty ?? {},
    params: activeParams,
    skuCeiling: team?.skuCeiling ?? {},
    coreOverrides: sbOverrides ?? {},
  },
};

writeFileSync(out, JSON.stringify(snapshot));

const f = snapshot.fingerprint;
console.log(`SNAPSHOT written to ${out}  (${Date.now() - t0}ms, git ${snapshot.gitHead})`);
console.log(`  invoiceData      ${f.invoiceRows.toLocaleString()} rows · ${f.invoiceDates} dates · ${f.invoiceDataFrom} → ${f.invoiceDataThrough}`);
console.log(`  skuMaster        ${f.skuMaster}`);
console.log(`  minReqQty        ${f.minReqQty} · newSKUQty ${f.newSKUQty} · priceData ${f.priceData}`);
console.log(`  deadStock        ${f.deadStock} · skuCeiling ${f.skuCeiling} · coreOverrides ${f.coreOverrides}`);
console.log(`  attribution      ${f.attributionMode ?? "(absent — would silently be 'location')"}`);
console.log(`  own-row configs  ${f.ownRowConfigs.join(", ") || "(none)"}`);
