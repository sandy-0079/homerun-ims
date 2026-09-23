// Read back how last night's chain went. READ-ONLY — plain GETs, writes nothing.
//
//   node scripts/nightly-readback.mjs
//
// ⚠⚠ WHY THIS IS A SCRIPT AND NOT A CHECKLIST IN A DOC. Every expectation here is
// DERIVED from live data at run time, because written-down expectations go stale
// silently and nothing fails when they do. Three times now on this system:
//   - the Stage 5 runbook said `toTargets.refreshedAt` would read 05:45; the second
//     engine slot rewrites it to 06:15, so the runbook nearly had a healthy system
//     reported broken.
//   - a ceiling runbook said `G9NYZ DS01 = 0/0`; the operator replaced the input an
//     hour later and the right answer became 1/1. Stale before anyone read it.
//   - the DS07 handoff quoted an Inv Value band of ₹7.99Cr/₹5.60Cr copied from
//     2026-08-05. By 2026-09-19 the live value was ₹10.30Cr/₹7.34Cr.
// So: hardcode only what the CODE guarantees (a gated store must be 0/0 — that is
// `applyOpeningToStores`, not a habit). Derive everything the DATA decides.

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
  s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }) : "(none)";
const cr = (n) => `₹${(Number(n) / 1e7).toFixed(2)}Cr`;
const agoMin = (s) => (s ? Math.round((Date.now() - new Date(s)) / 60000) : Infinity);

const [tt, glob, floors, inv, cat, dg, hist, team, eng] = await Promise.all([
  get("params", "toTargets"), get("params", "global"), get("params", "skuFloorSyncStatus"),
  get("params", "invoiceSyncStatus"), get("params", "catalogueSyncStatus"),
  get("params", "digestStatus"), get("params", "digestHistory"), get("team_data", "global"),
  get("params", "engineRunStatus"),
]);

// IST calendar date + wall time, as the operator reads them.
const istParts = (s) => {
  if (!s) return { date: "", time: "" };
  const [date, time] = new Date(s).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).split(" ");
  return { date, time };
};
const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const problems = [];
const stop = [];
const ok = (c, msg, bad, hard) => { console.log(`  ${c ? "✅" : "❌"} ${msg}`); if (!c) (hard ? stop : problems).push(bad || msg); };

// ── 1. The gate (the one thing that must block go-live) ──────────────────────
// `openingDSList` read with ?? — [] is the legitimate "all trading" end state.
const opening = glob?.openingDSList ?? [];
const targets = Array.isArray(tt?.targets) ? tt.targets : Object.values(tt?.targets ?? {});
const dsSeen = new Set();
const gatedNonZero = {};
for (const t of targets) {
  for (const [ds, v] of Object.entries(t?.perDS ?? {})) {
    dsSeen.add(ds);
    if (opening.includes(ds) && ((v?.min ?? 0) > 0 || (v?.max ?? 0) > 0))
      gatedNonZero[ds] = (gatedNonZero[ds] || 0) + 1;
  }
}
console.log(`\nGATE  openingDSList = ${JSON.stringify(opening)}`);
console.log(`  toTargets: ${targets.length} rows · stores present: ${[...dsSeen].sort().join(", ") || "(none)"}`);
ok(Object.keys(gatedNonZero).length === 0,
   `no gated store carries a non-zero target${Object.keys(gatedNonZero).length ? ` — FOUND ${JSON.stringify(gatedNonZero)}` : ""}`,
   "A GATED STORE HAS NON-ZERO TARGETS", true);

// ── 2. Engine ────────────────────────────────────────────────────────────────
// ⚠ Check the NIGHTLY run against `engineRunStatus.at`, NOT `toTargets.refreshedAt`.
// `toTargets` has two writers — the nightly `api/run-engine.js` and the browser's
// `applyAndRun` — so any manual Apply overwrites `refreshedAt` and tells you nothing
// about whether the nightly ran. `engineRunStatus` is written only by the nightly.
// (An earlier version of this script hardcoded "expect 06:15" on `refreshedAt` and
// cried wolf the first time an operator clicked Apply at 14:39 — the exact stale-
// expectation bug this file's header warns about, committed by this file.)
const er = istParts(eng?.at);
console.log(`\nENGINE  nightly ${er.date} ${er.time} IST · toTargets ${ist(tt?.refreshedAt)}`);
ok(eng?.ok === true && er.date === todayIst, `nightly engine ran today (engineRunStatus ${er.date || "never"})`);
// Two slots at 15,45 0 * * * UTC = 05:45 + 06:15 IST; the second rewrites the first,
// so a 05:45 stamp means the 06:15 run FAILED.
ok(!er.time.startsWith("05:45"), `used the 06:15 slot — a 05:45 stamp means the second run FAILED (got ${er.time})`);

const manualApply = tt?.refreshedAt && eng?.at && new Date(tt.refreshedAt) > new Date(eng.at);
if (manualApply) {
  console.log(`     \u2139 toTargets was rewritten by a browser Apply at ${istParts(tt.refreshedAt).time} IST, after the nightly.`);
  if (tt?.invValue === undefined)
    console.log(`     \u2139 invValue is absent — browser Apply strips it (Open Work #28). The next nightly`);
    console.log(`       re-stamps it before the 06:30 digest, so the digest keeps its \u20b9 line.`);
}
const through = tt?.inputs?.invoiceDataThrough;
const yday = new Date(Date.now() - 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
ok(through === yday, `invoiceDataThrough ${through} === yesterday ${yday}`);

// ── 3. Inv Value — compared against digestHistory, never a written number ─────
const h = Array.isArray(hist) ? hist : (hist?.days ?? hist?.history ?? []);
const [prev, last] = h.slice(-2);
console.log(`\nINV VALUE`);
if (prev && last) {
  const d = (a, b) => (((b - a) / a) * 100).toFixed(2);
  console.log(`  ${prev.date}  ${cr(prev.max)} max / ${cr(prev.min)} min`);
  console.log(`  ${last.date}  ${cr(last.max)} max / ${cr(last.min)} min   Δ ${d(prev.max, last.max)}% / ${d(prev.min, last.min)}%`);
  const jump = Math.max(Math.abs(d(prev.max, last.max)), Math.abs(d(prev.min, last.min)));
  // The context is derived from the same history, never written down: a hardcoded
  // "observed range ~0.1–1.6%" sat here while digestHistory already held 6.2–10.7% nights.
  const moves = h.slice(0, -1).slice(1).map((x, i) => {
    const p = h[i];
    return { date: x.date, pct: Math.max(Math.abs(d(p.max, x.max)), Math.abs(d(p.min, x.min))) };
  });
  const sorted = moves.map((m) => m.pct).sort((a, b) => a - b);
  const top = moves.reduce((a, m) => (m.pct > (a?.pct ?? -1) ? m : a), null);
  const ctx = sorted.length
    ? `prior ${sorted.length} nights: median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}%, max ${top.pct.toFixed(2)}% (${top.date}), ${sorted.filter((p) => p >= jump).length} at or above this one`
    : "no prior nights to compare";
  ok(jump < 10, `night-on-night move ${jump}% is under the 10% alarm · ${ctx}`);
} else console.log("  (not enough history to compare)");

// ── 4. The three input syncs + the digest ────────────────────────────────────
console.log(`\nSYNCS`);
ok(inv?.ok === true, `invoices ok · published ${ist(inv?.publishedAt)} · dates ${JSON.stringify(inv?.dates)}`);
ok(!!inv?.publishedAt, "invoiceSyncStatus.publishedAt is stamped (publish-only — `.at` is written on failures too)");
ok(cat?.ok === true, `catalogue ok · ${ist(cat?.at)}`);
ok(floors?.ok === true, `floors ok · night ${floors?.night} · ${floors?.skuCount} SKUs · guard ${floors?.change?.reason}`);
if (floors?.duplicates?.rows) console.log(`     ℹ ${floors.duplicates.rows} duplicate sheet row(s): ${JSON.stringify(floors.duplicates.skus)} — last row wins (the ops append rule)`);
ok(dg?.ok === true && dg?.level === "green", `digest ${dg?.level} · sent ${ist(dg?.at)} · recorded ${dg?.recorded}`);
for (const c of dg?.checks ?? []) if (c.level !== "green") problems.push(`digest check ${c.key} = ${c.level}`);

// ── 5. Stock crons — per store, staleness derived from now ───────────────────
console.log(`\nSTOCK FRESHNESS  (crons :35 :38 :41 :44 UTC = :05 :08 :11 :14 IST)`);
const per = team?.stockUploadedAtPerDS ?? {};
for (const ds of Object.keys(per).sort()) {
  const m = agoMin(per[ds]);
  const gated = opening.includes(ds) ? "  (gated)" : "";
  console.log(`  ${m > 90 ? "⚠" : "✅"} ${ds.padEnd(5)} ${ist(per[ds])}  ${String(m).padStart(4)}m ago${gated}`);
  // DS08 has no cron by design (Open Work #39) — stale is expected, not a fault.
  if (m > 90 && ds !== "DS08") problems.push(`${ds} stock is ${m}m stale`);
}
console.log(`  orders  ${ist(team?.ordersUploadedAt)}  ${agoMin(team?.ordersUploadedAt)}m ago`);

// ── verdict ──────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(70));
if (stop.length) {
  console.log("🛑 STOP — DO NOT PROCEED WITH GO-LIVE:");
  for (const s of stop) console.log("   • " + s);
}
if (problems.length) {
  console.log(`${stop.length ? "" : "⚠ "}${problems.length} issue(s) to look at:`);
  for (const p of problems) console.log("   • " + p);
}
if (!stop.length && !problems.length) console.log("✅ clean night — every check derived from live data");
process.exit(stop.length ? 2 : problems.length ? 1 : 0);
