// Hyderabad engine pass (spec §3.2–§3.4, §4.3 of
// docs/superpowers/specs/2026-11-10-hyderabad-hyds01-design.md).
//
// Pati's Min/Max comes from the UNMODIFIED Bangalore `runEngine`, reached through a
// remap: Pati's rows are relabelled `ds:"DS01"`, the master is neutralised, the
// plywood config's only node is DS01 with no DC. `stores.DS01` is then read back as
// HYDS01 and the Hyderabad pass below is applied. Nothing in `src/engine/` changes,
// so Bangalore code paths are untouched by construction.
//
// Pure: no React, no Supabase.
//
// logicTag values on `stores.HYDS01` (pinned by hydEngine.test.js):
//   "Inactive in Zoho"          Zoho status not "active" (or SKU absent) → 0/0, both modes
//   "Hyd Floor"                 floors-only, target = the floor
//   "Out of range"              floors-only, no floor → 0/0
//   "Flag: Purchase=OFF"        engine mode, no floor, Purchase=OFF       → 0/0
//   "Flag: Supplier"            engine mode, no floor, Inventorised At=Supplier → 0/0
//   "Flag: Dead Stock"          engine mode, no floor, on the Dead Stock list → 0/0
//   "Hyd Floor (beats engine)"  engine mode, the floor exceeds engine+buffer on Min or Max
//   "Hyd Engine"                engine mode, engine+buffer is the target (≥ any floor)
//   "No demand"                 engine mode, no floor, no Pati sales in the window → 0/0
// `source` is "floor" | "engine" | "none" (zeroed), for the same audit.

import { runEngine } from "../engine/runEngine.js";
import { hydRowsOnly } from "../city.js";
import { isFloorsOnly } from "./hydParams.js";
import { normalisePolicy, isPolicyNo, POLICY_NO, POLICY_YES } from "../skuPolicy.js";

const STORE = "HYDS01";
const ENGINE_DS = "DS01";

/** A zero-qty row on every window date, so the engine's own date window is the
 *  NETWORK window and not just the days Pati happened to sell. Without it a
 *  strategy that divides by the number of dates (Percentile Cover's dailyAvg/DOC
 *  caps) or splits recency by date count would see only Pati's sale days. Lives on
 *  DS02 so it never touches DS01's series; qty 0 is skipped by plywood. Dropped
 *  from results (it is not in the master). */
export const HYD_PAD_SKU = "__HYD_WINDOW_PAD__";

// Engine convention (src/engine/CLAUDE.md, Active-only): a master row with NO status
// counts as active; a SKU absent from the master, or a status present and not
// "active" (case-insensitive), does not.
// runEngine's Active-only rule: absent SKU (no meta) = inactive; a missing status
// field = active (`??`, so an empty-string status is NOT active, as in runEngine).
const isActive = meta => !!meta && String(meta.status ?? "Active").trim().toLowerCase() === "active";
const isSupplier = meta => String(meta?.inventorisedAt ?? "").trim().toLowerCase() === "supplier";
const floorAt = (floors, sku) => floors?.[sku]?.[STORE];
const hasFloorOf = f => !!f && ((f.min || 0) > 0 || (f.max || 0) > 0);

/**
 * Hyderabad's EFFECTIVE Purchase decision (spec §3.6). The one place it is decided;
 * the PO CSV, the screens and this pass all call it.
 * @param {{skuMaster:object, floors:object, floorsOnly:boolean}} ctx
 * @returns {"Yes"|"No"}
 */
export function hydPurchaseOf(sku, { skuMaster, floors, floorsOnly }) {
  const meta = skuMaster?.[sku];
  if (!isActive(meta)) return POLICY_NO;
  if (hasFloorOf(floorAt(floors, sku))) return POLICY_YES;
  if (floorsOnly) return POLICY_NO;
  return normalisePolicy(meta.purchase);
}

/** Lead-time buffer then order cycle; the cycle term uses the post-buffer Min (§3.3). */
export function bufferTargets({ min, max }, rate, leadTime, cycleDays) {
  const lt = Math.ceil(rate * leadTime);
  const min1 = min + lt;
  const max1 = Math.max(max + lt, min1 + Math.ceil(rate * cycleDays));
  return { min: min1, max: max1 };
}

/** The last `op` distinct dates across the FULL invoice data (both cities). */
export function networkWindowDates(invoiceData, op) {
  return [...new Set(invoiceData.map(r => r.date))].sort().slice(-op);
}

/**
 * Rows handed to `runEngine`: EVERY Pati row relabelled DS01 (not window-cut —
 * runEngine slices its own window, and plywood keeps its own `lookbackDays` over the
 * full rows exactly as in Bangalore), plus a zero-qty pad row on each window date.
 * Because Pati's dates are a subset of the network's, runEngine's `slice(-op)` then
 * lands exactly on `windowDates`.
 */
export function hydEngineRows(invoiceData, windowDates) {
  const rows = hydRowsOnly(invoiceData).map(r => ({ ...r, ds: ENGINE_DS }));
  for (const date of windowDates) rows.push({ sku: HYD_PAD_SKU, ds: "DS02", date, qty: 0 });
  return rows;
}

function neutraliseMaster(skuMaster) {
  const out = {};
  for (const [sku, m] of Object.entries(skuMaster || {})) {
    const invAt = String(m?.inventorisedAt ?? "").trim().toLowerCase();
    out[sku] = { ...m, move: "Yes", purchase: "Yes", inventorisedAt: invAt === "ds" ? m.inventorisedAt : "DS" };
  }
  return out;
}

const remapNode = id => (id === STORE ? ENGINE_DS : id);

function remapPlywood(cfg) {
  const { brands = {}, ...top } = cfg || {};
  const out = { ...top, brands: {} };
  for (const [brand, b] of Object.entries(brands)) {
    const nodes = {};
    for (const [id, n] of Object.entries(b?.nodes || {})) {
      if (id === "DC") continue; // no Hyderabad DC
      nodes[remapNode(id)] = { ...n, covers: (n?.covers || []).map(remapNode) };
    }
    out.brands[brand] = { ...b, nodes };
  }
  return out;
}

/**
 * @returns {{results:object, report:{inactiveFloored:string[], overrides:{sku:string,reason:string}[],
 *   outOfRangeSales:string[], unknownFloorSkus:string[]}}}
 */
export function runHydEngine({ invoiceData, skuMaster, priceData, deadStock, floors, hydParams, hydPlywood }) {
  const inv = invoiceData || [];
  const master = skuMaster || {};
  const dead = deadStock || new Set();
  const hp = hydParams || {};
  const op = hp.overallPeriod || 45;
  const cycleDays = hp.orderCycleDays ?? 3;
  const lead = hp.brandLeadTimeDays || {};
  const floorsOnly = isFloorsOnly(hp, STORE);

  const windowDates = networkWindowDates(inv, op);
  const windowSet = new Set(windowDates);
  const qty = {};
  for (const r of hydRowsOnly(inv)) {
    if (windowSet.has(r.date)) qty[r.sku] = (qty[r.sku] || 0) + (Number(r.qty) || 0);
  }

  const nc = hydPlywood?.networkConfigs?.[STORE] || {};
  const p = {
    ...hp,
    overallPeriod: op,
    newDSList: [],
    openingDSList: [],
    pincodeConfig: { mode: "location", map: {} },
    plywoodNetworkConfig: remapPlywood(hydPlywood?.plywoodNetworkConfig),
    dsCapacities: { [ENGINE_DS]: { thick: nc.thick?.capacity || 0, thin: nc.thin?.capacity || 0 } },
  };
  const raw = runEngine(hydEngineRows(inv, windowDates), neutraliseMaster(master), {}, priceData || {}, new Set(), {}, p, {});

  const results = {};
  const report = { inactiveFloored: [], overrides: [], outOfRangeSales: [], unknownFloorSkus: [] };

  for (const [sku, meta] of Object.entries(master)) {
    const eng = raw[sku]?.stores?.[ENGINE_DS] ?? { min: 0, max: 0 };
    const rate = (qty[sku] || 0) / op;
    const lt = lead[meta?.brand] ?? lead._default ?? 3;
    const b = bufferTargets({ min: eng.min || 0, max: eng.max || 0 }, rate, lt, cycleDays);
    const f = floorAt(floors, sku);
    const hasFloor = hasFloorOf(f);
    const fMin = hasFloor ? f.min || 0 : 0, fMax = hasFloor ? f.max || 0 : 0;

    const flags = [];
    if (isPolicyNo(meta?.purchase)) flags.push("Purchase=OFF");
    if (isSupplier(meta)) flags.push("Supplier");
    if (dead.has(sku)) flags.push("Dead Stock");

    let min, max, logicTag, source;
    if (!isActive(meta)) {
      min = 0; max = 0; logicTag = "Inactive in Zoho"; source = "none";
      if (hasFloor) report.inactiveFloored.push(sku);
    } else {
      if (hasFloor) for (const reason of flags) report.overrides.push({ sku, reason });
      if (floorsOnly) {
        if (hasFloor) { min = fMin; max = fMax; logicTag = "Hyd Floor"; source = "floor"; }
        else { min = 0; max = 0; logicTag = "Out of range"; source = "none"; }
      } else if (!hasFloor && flags.length) {
        min = 0; max = 0; logicTag = `Flag: ${flags[0]}`; source = "none";
      } else {
        min = Math.max(fMin, b.min); max = Math.max(fMax, b.max);
        const floorWins = fMin > b.min || fMax > b.max;
        logicTag = floorWins ? "Hyd Floor (beats engine)" : "Hyd Engine";
        source = floorWins ? "floor" : "engine";
        if (!hasFloor && !qty[sku] && min === 0 && max === 0) { logicTag = "No demand"; source = "none"; }
      }
    }
    max = Math.max(max, min);

    results[sku] = {
      meta: raw[sku]?.meta ? { ...raw[sku].meta, ...meta } : meta,
      stores: {
        [STORE]: {
          min, max, logicTag, source,
          engineMin: b.min, engineMax: b.max,
          rawEngineMin: eng.min || 0, rawEngineMax: eng.max || 0,
          floorMin: fMin, floorMax: fMax,
          dailyAvg: rate, leadTime: lt, orderCycleDays: cycleDays,
          strategyTag: eng.strategyTag, mvTag: eng.mvTag, engineLogicTag: eng.logicTag,
        },
      },
      dc: { min: 0, max: 0 },
    };
  }

  for (const sku of Object.keys(qty)) {
    if (!qty[sku]) continue;
    const s = results[sku]?.stores?.[STORE];
    if (!s || (s.min === 0 && s.max === 0 && !s.floorMin && !s.floorMax)) report.outOfRangeSales.push(sku);
  }
  for (const sku of Object.keys(floors || {})) {
    if (!master[sku]) report.unknownFloorSkus.push(sku);
  }

  return { results, report };
}
