// Aggregations for the Hyderabad screens (Overview KPIs, SKU Detail sales table,
// the Floors only → Engine impact preview). Pure: no React, no Supabase.
import { computeInvValue } from "../invValue.js";
import { isHydRow, HYD_DS_LIST } from "../city.js";
import { isFloorsOnly } from "./hydParams.js";

const STORE = "HYDS01";
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const FLAGS = ["Purchase=OFF", "Supplier", "Dead Stock"];

const storeOf = r => r?.stores?.[STORE];
const hasTarget = r => (storeOf(r)?.max || 0) > 0;
const hasFloor = f => !!f && ((f.min || 0) > 0 || (f.max || 0) > 0);

/** report.overrides carries one entry per flag; screens count SKUs. */
export function uniqueOverrideSkus(overrides) {
  const by = new Map();
  for (const { sku, reason } of overrides || []) {
    if (!by.has(sku)) by.set(sku, []);
    by.get(sku).push(reason);
  }
  return [...by].map(([sku, reasons]) => ({ sku, reasons }));
}

/** ISO date `n-1` calendar days before `iso`; null if `iso` is not YYYY-MM-DD.
 *  Arithmetic on parts, never `new Date(x).toISOString()` on unchecked input. */
function daysBefore(iso, n) {
  const m = ISO.exec(String(iso ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - n));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const latestDate = inv => {
  let best = null;
  for (const r of inv || []) if (best === null || r.date > best) best = r.date;
  return best;
};

/** Pati units sold in the `days` calendar days ending at the network's latest
 *  invoice date (inclusive). null when there is no valid latest date. */
export function unitsSoldLastDays(invoiceData, days) {
  const latest = latestDate(invoiceData);
  const from = daysBefore(latest, days - 1);
  if (from === null) return null;
  let total = 0;
  for (const r of invoiceData) {
    if (isHydRow(r) && r.date >= from && r.date <= latest) total += Number(r.qty) || 0;
  }
  return total;
}

export function hydOverviewKpis({ results, floors, priceData, invoiceData, hydParams } = {}) {
  const res = results || {};
  const fl = floors || {};
  const inv = computeInvValue(res, priceData || {}, HYD_DS_LIST);
  return {
    inRange: Object.values(res).filter(hasTarget).length,
    floorRows: Object.keys(fl).length,
    floorRowsInRange: Object.values(fl).filter(f => hasFloor(f?.[STORE])).length,
    invMin: inv.min,
    invMax: inv.max,
    sold7: unitsSoldLastDays(invoiceData || [], 7),
    sold30: unitsSoldLastDays(invoiceData || [], 30),
    latestDate: latestDate(invoiceData),
    mode: isFloorsOnly(hydParams || {}, STORE) ? "Floors only" : "Engine",
  };
}

/** Pati's sales of one SKU on each window date that had any, newest first. */
export function patiDailySales(invoiceData, sku, windowDates) {
  const win = new Set(windowDates || []);
  const byDate = {};
  for (const r of invoiceData || []) {
    if (r.sku !== sku || !isHydRow(r) || !win.has(r.date)) continue;
    byDate[r.date] = (byDate[r.date] || 0) + (Number(r.qty) || 0);
  }
  const days = Object.entries(byDate)
    .filter(([, qty]) => qty !== 0)
    .map(([date, qty]) => ({ date, qty }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return { days, total: days.reduce((s, d) => s + d.qty, 0), windowDays: win.size };
}

/** SKUs zeroed by each Bangalore-origin flag (engine mode). Each SKU is counted
 *  once, under the flag its logicTag names — the first that applied. */
export function zeroedByFlag(results) {
  const out = Object.fromEntries(FLAGS.map(f => [f, 0]));
  for (const r of Object.values(results || {})) {
    const tag = storeOf(r)?.logicTag || "";
    const flag = tag.startsWith("Flag: ") ? tag.slice(6) : null;
    if (flag in out) out[flag]++;
  }
  return out;
}

/** What switching Pati to Engine would do, from a dry run. */
export function engineFlipImpact(beforeRun, afterRun, priceData) {
  const side = run => ({
    withTargets: Object.values(run?.results || {}).filter(hasTarget).length,
    invMax: computeInvValue(run?.results || {}, priceData || {}, HYD_DS_LIST).max,
  });
  return { before: side(beforeRun), after: side(afterRun), zeroedByFlag: zeroedByFlag(afterRun?.results) };
}
