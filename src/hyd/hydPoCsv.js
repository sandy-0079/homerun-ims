// Hyderabad PO CSV (spec §3.6). Mirrors buildPoTargetsCsv: every master SKU, master
// order, quoted text fields, bare numbers.
//
// ⚠⚠ THE HEADER IS A FROZEN CONTRACT from day one — the PO team's Hyderabad sheet keys
// on column POSITION. Columns are only ever APPENDED after `Purchase`. There is no
// `Move` (Hyderabad has no DC→DS transfers).

import { q } from "../poTargetsCsv.js";
import { normaliseStatus } from "../skuStatus.js";
import { hydPurchaseOf } from "./hydEngine.js";
import { isFloorsOnly } from "./hydParams.js";

const STORE = "HYDS01";

export const HYD_PO_CSV_HEADERS = [
  "Item Name", "Inventorised At", "SKU", "Category", "Brand", "Status",
  "HYDS01 Min", "HYDS01 Max", "Purchase",
];

const num = (v) => (Number.isFinite(v) ? v : 0);

/** @returns {string|null} CSV text, or null if the master is empty */
export function buildHydPoCsv({ skuMaster, hydResults, floors, hydParams } = {}) {
  const skus = Object.values(skuMaster || {});
  if (!skus.length) return null;
  const res = hydResults || {};
  const floorsOnly = isFloorsOnly(hydParams, STORE);

  const lines = skus.map((s) => {
    const st = res[s.sku]?.stores?.[STORE];
    return [
      q(s.name || s.sku),
      q(s.inventorisedAt || "DC"),
      q(s.sku),
      q(s.category || ""),
      q(s.brand || ""),
      q(normaliseStatus(s.status)),
      num(st?.min),
      num(st?.max),
      q(hydPurchaseOf(s.sku, { skuMaster, floors, floorsOnly })),
    ].join(",");
  });
  return [HYD_PO_CSV_HEADERS.map(q).join(","), ...lines].join("\n");
}

export function hydPoCsvFilename(dateIso) {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(dateIso ?? ""));
  return `PO_Hyderabad_${m ? m[0] : "unknown"}.csv`;
}
