// Nightly digest — DRY RUN. Reads the five live status values from prod Supabase,
// runs the real assessment, prints the exact email. Writes NOTHING, sends NOTHING.
//
//   npx vite-node scripts/dryrun-nightly-digest.mjs
//   npx vite-node scripts/dryrun-nightly-digest.mjs --demo    # + synthetic bad mornings
//   npx vite-node scripts/dryrun-nightly-digest.mjs --with-value  # run the engine to show the ₹ line
//   npx vite-node scripts/dryrun-nightly-digest.mjs --at 2026-08-06T01:00:00Z
//
// Imports the same `_shared/nightlyDigest.ts` the edge function will use, on purpose:
// a dry run that re-implements the assessment proves nothing about the thing that will
// actually send. Same reasoning as dryrun-sku-floors.mjs and compare-csv-vs-live.mjs.
//
// ⚠ READS ONLY THE SMALL `params` ROWS. Never team_data/invoice_data (~7MB) or
// team_data/global — row counts come from stamps that already exist. A daily job that
// pulls the invoice row would put 7MB/day of Disk IO on the budget for nothing.

import { assessNight, renderDigest } from "../supabase/functions/_shared/nightlyDigest.ts";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };

const argv = process.argv.slice(2);
const DEMO = argv.includes("--demo");
const AT = (() => {
  const i = argv.indexOf("--at");
  if (i === -1) return Date.now();
  const t = Date.parse(argv[i + 1]);
  if (!Number.isFinite(t)) throw new Error(`--at: not a parseable timestamp: ${argv[i + 1]}`);
  return t;
})();

const istBefore = (ms) => new Date(ms + 5.5 * 3600_000 - 86400000).toISOString().slice(0, 10);

const row = async (id, select = "payload") => {
  const r = await fetch(`${B}/params?select=${select}&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`params/${id}: HTTP ${r.status}`);
  const j = (await r.json())[0];
  return j ? (j.payload ?? j) : null;
};

const [invoices, catalogue, floors, engine, targets, historyRow, toAudit] = await Promise.all([
  row("invoiceSyncStatus"),
  row("catalogueSyncStatus"),
  row("skuFloorSyncStatus"),
  row("engineRunStatus"),
  // Three tiny selects off the ~695KB row rather than the row itself.
  row("toTargets", "payload->refreshedAt,payload->inputs,payload->invValue"),
  row("digestHistory"),
  // create-to's audit — read only for the skipped-TO-lines block. Without it the
  // dry run could never preview that block, i.e. a preview tool that lies by omission.
  row("toAudit"),
]);

const history = Array.isArray(historyRow?.days) ? historyRow.days : [];
const bytes = JSON.stringify({ invoices, catalogue, floors, engine, targets, history, toAudit }).length;
console.log(`READ  7 params values · ${bytes.toLocaleString()} bytes total · zero writes, zero Zoho calls`);
console.log(`      invValue stamped: ${targets?.invValue ? "yes" : "NO — run-engine not redeployed yet, the value line will be omitted"}`);
console.log(`      history: ${history.length} day(s) recorded`);
console.log(`NOW   ${new Date(AT).toISOString()}  (${argv.includes("--at") ? "simulated" : "live clock"})\n`);

const show = (label, verdict) => {
  const { subject, text } = renderDigest(verdict);
  console.log("─".repeat(78));
  console.log(label);
  console.log("─".repeat(78));
  console.log(`Subject: ${subject}`);
  console.log(`To:      sandeep.kumar@home-run.co\n`);
  console.log(text);
  console.log("");
};

// --with-value: run the REAL engine locally and inject the inventory value, so the
// value line can be judged before api/run-engine.js is redeployed to stamp it. Slow
// (~30s, reads the 7MB invoice row) and strictly a dev convenience — the deployed
// function never does this, it reads the stamp. Uses the same computeInvValue the
// Overview card uses, so the figure shown here is the figure you'd get.
if (argv.includes("--with-value")) {
  const { runEngine } = await import("../src/engine/index.js");
  const { DEFAULT_PARAMS, DS_LIST } = await import("../src/engine/constants.js");
  const { loadParamConfigRows } = await import("../src/paramConfigRows.js");
  const { computeInvValue } = await import("../src/invValue.js");
  const tRow = async (t, id) => {
    const r = await fetch(`${B}/${t}?select=payload&id=eq.${id}`, { headers: H });
    return (await r.json())[0]?.payload ?? null;
  };
  console.log("--with-value: running the engine locally …");
  const [p, team, inv] = await Promise.all([
    tRow("params", "global"), tRow("team_data", "global"), tRow("team_data", "invoice_data"),
  ]);
  const prm = { ...DEFAULT_PARAMS, ...(p || {}) };
  Object.assign(prm, (await loadParamConfigRows((id) => tRow("params", id), DS_LIST)).extra);
  const res = runEngine(inv?.invoiceData ?? [], team?.skuMaster ?? {}, team?.minReqQty ?? {},
    team?.priceData ?? {}, new Set(team?.deadStock ?? []), team?.newSKUQty ?? {}, prm, team?.skuCeiling ?? {});
  targets.invValue = computeInvValue(res, team?.priceData ?? {}, DS_LIST);
  console.log(`  invValue Max ₹${(targets.invValue.max / 1e7).toFixed(4)}Cr · Min ₹${(targets.invValue.min / 1e7).toFixed(4)}Cr`);
  if (!history.length) {
    // No recorded history yet, so show what a normal second-day email looks like.
    history.push({ date: istBefore(AT), min: Math.round(targets.invValue.min * 0.995), max: Math.round(targets.invValue.max * 0.987) });
    console.log(`  (no recorded history — injected a SYNTHETIC previous day so the delta line is visible)`);
  }
}

const live = assessNight({ now: AT, invoices, catalogue, floors, engine, targets, history, toAudit });
show("LIVE — what would be sent right now", live);

console.log(`VERDICT  ${live.level.toUpperCase()}`);
for (const c of live.checks) {
  console.log(`  ${c.level.padEnd(5)} ${c.key.padEnd(10)} lag=${c.lag ?? "—"} missed=${c.missed ?? "—"} mode=${c.mode}`);
}
if (live.flags.length) for (const f of live.flags) console.log(`  flag  ${f.key}: ${f.detail}`);
else console.log("  (no composition flags)");

if (!DEMO) {
  console.log("\nRe-run with --demo to see what the failure emails look like.");
  process.exit(0);
}

// ── Synthetic bad mornings, built by mutating the LIVE payloads ──────────────
// Judging the format needs a red to look at, and a healthy chain will not supply one.
const clone = (o) => JSON.parse(JSON.stringify(o));
const scenario = (label, mutate) => {
  const s = { now: AT, invoices: clone(invoices), catalogue: clone(catalogue), floors: clone(floors), engine: clone(engine), targets: clone(targets), history: clone(history) };
  mutate(s);
  show(label, assessNight(s));
};

console.log("\n\n" + "=".repeat(78));
console.log("SYNTHETIC — these are NOT the live state, they show what a bad morning reads like");
console.log("=".repeat(78) + "\n");

scenario("A. Floors missed one night (red on first miss, cron never fired)", (s) => {
  const d = new Date(Date.parse(`${s.floors.lastOkNight}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  s.floors.lastOkNight = d;
  s.floors.at = `${d}T23:05:00.000Z`;
});

scenario("B. Floors ran but a guard refused it (ops broke the sheet)", (s) => {
  const d = new Date(Date.parse(`${s.floors.lastOkNight}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  s.floors.lastOkNight = d;
  s.floors.ok = false;
  s.floors.change = { reason: "floor_drop", floorDropPct: 71.4 };
});

scenario("C. Invoice sync silent two nights (red, still self-healing)", (s) => {
  s.invoices.publishedPlan = s.invoices.publishedPlan.map((x) =>
    new Date(Date.parse(`${x}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10));
  s.invoices.at = new Date(AT - 50 * 3600_000).toISOString();
  s.targets.inputs.invoiceDataThrough = s.invoices.publishedPlan[0];
});

scenario("D. Chain fine, but SKUs silently moved to Supplier in Zoho", (s) => {
  s.catalogue.invAtChanged = { count: 3, toSupplier: ["UVJQ9", "HQ2B4", "K825K"] };
});

scenario("E. The engine stopped while everything else kept working", (s) => {
  s.targets.refreshedAt = new Date(AT - 3 * 86400000).toISOString();
  s.engine.at = new Date(AT - 3 * 86400000).toISOString();
  s.targets.inputs.invoiceDataThrough = "2026-08-01";
});

scenario("F. A status row cannot be read at all", (s) => { s.catalogue = null; });
