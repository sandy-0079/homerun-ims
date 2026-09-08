// Stock Health tag derivation — PURE, and extracted from StockHealthTab.jsx on
// 2026-09-08 so it can be tested. The tab imports `supabase.js`, which builds a
// client at module load, so nothing inside it was reachable from a unit test —
// which is why a four-month-old bug in `condC` (below) survived unnoticed.
//
// Same shape as skuPolicy.js / skuStatus.js / freshness.js: the rule lives in one
// pure module, the tab renders it. ⚠ BOTH readers — `dsSummary` (tab-bar badges)
// and `allSkuRows` (KPI cards + table) — must keep calling these, never a local
// copy. Duplicating this filter is exactly how the DC tab-bar badge once came to
// over-count Critical against its own KPI card.
import { DS_LIST } from "./engine/index.js";
import { policyOf } from "./skuPolicy.js";

export function getHealthTag(ecs, min, max, ros) {
  if (ecs > max) return "excess";
  if (ecs === min && min === max) return "okay";  // fully stocked dead-stock SKU
  if (ecs <= min) return (ros - ecs >= 1) ? "ec" : "critical";
  return "okay";
}

// DC-only reclassification: a Critical/Low-Stock DC SKU needs no supplier PO when any of:
//   A) no DS is short, B) DC stock covers all short-DS reorder needs, or
//   C) network DS excess + DC stock covers DC's own Min floor.
// SHARED by dsSummary (tab-bar badges) and allSkuRows (KPI cards + table) so the two
// never diverge — the override must live in exactly one place.
export function applyDCReqCovered(tag, { sku, ecs, min, res, activeStockData }) {
  if (tag !== "ec" && tag !== "critical") return tag;
  // ⚠⚠ A DC-ONLY SKU CAN NEVER BE "DS Req Covered", and without this it ALWAYS was.
  // With all six DS at 0/0 the tag fires down BOTH paths below: where a DS stock
  // record exists, `dsEcs <= dsMin` is 0 <= 0, so hasShortDS is true with
  // dsReorderSum 0 and condB (`ecs >= 0`) is unconditionally true; where no record
  // exists, `continue` skips all six and condA (`!hasShortDS`) is true. So the DC
  // team would never see Critical for a delicate item that had run out — the one
  // SKU class where the DC is the ONLY place it can be sold. No DS can cover a DC
  // that sells direct.
  const pol = policyOf(res?.meta);
  if (pol.invAt === "dc" && !pol.move) return tag;
  let dsExcessSum = 0, dsReorderSum = 0, hasShortDS = false;
  for (const ds of DS_LIST) {
    const dsLive = activeStockData[sku]?.[ds];
    if (!dsLive) continue;
    const dsMax = res.stores?.[ds]?.max || 0;
    const dsMin = res.stores?.[ds]?.min || 0;
    const dsEcs = Math.max(0, dsLive.stock_on_hand ?? 0);  // SoH basis — matches ECS (see getLive)
    if (dsEcs > dsMax) dsExcessSum += dsEcs - dsMax;
    if (dsEcs <= dsMin) { hasShortDS = true; dsReorderSum += Math.max(0, dsMax - dsEcs); }
  }
  const condA = !hasShortDS;
  const condB = hasShortDS && ecs >= dsReorderSum;
  // ⚠⚠ NET, NOT GROSS — fixed 2026-09-08 after four months of suppressing real POs.
  // condA already covers "no DS is short", so condC only ever runs when something IS
  // short, and in that case gross excess DOUBLE-COUNTS: the surplus sitting at an
  // overstocked store cannot simultaneously refill the DC's floor and refill the short
  // stores. Measured on VZG3X: 17 spare at DS04, 69 needed across four short stores,
  // DC holding 1 against a Min of 18 — a network 52 units SHORT that read "no PO
  // needed". Subtracting the reorder need asks the question the tag actually means:
  // after refilling every short store, is there still enough to cover the DC's floor?
  const condC = (dsExcessSum - dsReorderSum) + ecs >= min;
  return (condA || condB || condC) ? "dsReqCovered" : tag;
}
