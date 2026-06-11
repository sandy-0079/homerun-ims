// Demand preparation for Plywood Network v2 (spec §3–4).
// Universe = all active ply SKUs except excluded brands.
// Bulk = order-level label (any line ≥ threshold); regular stream = line-level.

import { DS_LIST } from '../../constants.js';

export const PLY_CATEGORY = 'Plywood, MDF & HDHMR';

export function buildUniverse(skuM, cfg) {
  const excluded = (cfg.excludedBrands || ['Merino']).map(b => b.toLowerCase());
  const universe = {};
  for (const [sku, m] of Object.entries(skuM)) {
    if (m.category !== PLY_CATEGORY) continue;
    if ((m.status || 'Active').toLowerCase() !== 'active') continue;
    if (excluded.includes((m.brand || '').toLowerCase())) continue;
    universe[sku] = m;
  }
  return universe;
}

export function medianOrderQty(qtys) {
  if (!qtys || qtys.length === 0) return 0;
  const s = [...qtys].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function prepareDemand(inv, universe, cfg) {
  const lookbackDays = cfg.lookbackDays || 90;
  const bulkTh = cfg.bulkOrderThreshold || 10;

  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return null;
  const lastDate = allDates[allDates.length - 1];
  const latest = new Date(lastDate + 'T00:00:00Z');
  latest.setUTCDate(latest.getUTCDate() - (lookbackDays - 1));
  const cutoff = latest.toISOString().slice(0, 10);
  // Calendar window (includes zero-sale days — rolling sums and exceedance need them)
  const windowDates = [];
  for (let d = new Date(cutoff + 'T00:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10);
    if (s > lastDate) break;
    windowDates.push(s);
  }

  // Group universe ply lines into orders
  const byId = {};
  for (const r of inv) {
    if (!universe[r.sku] || r.date < cutoff) continue;
    const qty = Number(r.qty) || 0;
    if (qty <= 0 || !DS_LIST.includes(r.ds)) continue;
    const oid = r.shopifyOrder || `_noid|${r.ds}|${r.date}|${r.sku}`;
    if (!byId[oid]) byId[oid] = { id: oid, ds: r.ds, date: r.date, lines: [] };
    byId[oid].lines.push({ sku: r.sku, qty });
  }
  const orders = Object.values(byId).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);
  for (const o of orders) o.isBulk = o.lines.some(l => l.qty >= bulkTh);

  const regularDaily = {};      // sku → ds → date → qty   (line-level, DS sizing)
  const bulkDaily = {};         // sku → date → qty        (order-level, DC sizing)
  const regOrderQtys = {};      // sku → [qty]             (network order sizes)
  const regOrderQtysByDS = {};  // sku → ds → [qty]        (local order sizes)

  for (const o of orders) {
    for (const { sku, qty } of o.lines) {
      if (qty < bulkTh) {
        if (!regularDaily[sku]) regularDaily[sku] = {};
        if (!regularDaily[sku][o.ds]) regularDaily[sku][o.ds] = {};
        regularDaily[sku][o.ds][o.date] = (regularDaily[sku][o.ds][o.date] || 0) + qty;
        if (!regOrderQtys[sku]) regOrderQtys[sku] = [];
        regOrderQtys[sku].push(qty);
        if (!regOrderQtysByDS[sku]) regOrderQtysByDS[sku] = {};
        if (!regOrderQtysByDS[sku][o.ds]) regOrderQtysByDS[sku][o.ds] = [];
        regOrderQtysByDS[sku][o.ds].push(qty);
      }
      if (o.isBulk) {
        if (!bulkDaily[sku]) bulkDaily[sku] = {};
        bulkDaily[sku][o.date] = (bulkDaily[sku][o.date] || 0) + qty;
      }
    }
  }
  return { orders, regularDaily, bulkDaily, regOrderQtys, regOrderQtysByDS, windowDates, cutoff };
}
