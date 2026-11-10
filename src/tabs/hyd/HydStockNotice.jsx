// Notice above Hyderabad Stock Health (spec §3.2): the floor rows and sales that
// the targets below do NOT simply reflect. Built from hydRun.report; renders
// nothing when all three lists are empty. Dismissal is held by the caller
// (HydShell) so it lasts the page session across tab switches, never persisted.
import React from "react";
import { uniqueOverrideSkus } from "../../hyd/hydStats.js";
import { C, banner } from "./hydStyles.js";
import { Collapsible, SkuList } from "./HydUi.jsx";

export default function HydStockNotice({ report, skuMaster, onDismiss }) {
  const inactive = report?.inactiveFloored || [];
  const overrides = uniqueOverrideSkus(report?.overrides);
  const outOfRange = report?.outOfRangeSales || [];
  if (!inactive.length && !overrides.length && !outOfRange.length) return null;
  const lists = [
    [`${inactive.length} floor SKUs are inactive in Zoho`, inactive, null],
    [`${overrides.length} floor SKUs override Bangalore flags`, overrides, o => o.reasons.join(", ")],
    [`${outOfRange.length} SKUs sold at Pati but not in range`, outOfRange, null],
  ].filter(([, items]) => items.length);
  return (
    <div style={{ ...banner("warn"), margin: "0 0 10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 700 }}>Pati floor sheet — check these</span>
        <button onClick={onDismiss}
          style={{ border: `1px solid ${C.border}`, background: C.white, borderRadius: 5, padding: "2px 8px", fontSize: 11, cursor: "pointer", color: C.text }}>
          Dismiss
        </button>
      </div>
      {lists.map(([title, items, render]) => (
        <Collapsible key={title} title={title}>
          <SkuList items={items} skuMaster={skuMaster} render={render || undefined} />
        </Collapsible>
      ))}
    </div>
  );
}
