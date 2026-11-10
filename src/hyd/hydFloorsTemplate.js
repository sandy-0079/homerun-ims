// The Hyderabad floor-sheet template: the header parseHydFloorsCsv expects,
// prefilled with the current in-range floors so ops can edit and re-upload.
import { q } from "../poTargetsCsv.js";

export const HYD_FLOORS_TEMPLATE_HEADER = ["SKU", "Item Name", "Category", "HYDS01 Min", "HYDS01 Max"];

export function buildHydFloorsTemplateCsv(floors, skuMaster) {
  const lines = Object.keys(floors || {})
    .filter(sku => floors[sku]?.HYDS01)
    .sort()
    .map(sku => {
      const f = floors[sku].HYDS01, m = skuMaster?.[sku] || {};
      return [q(sku), q(m.name || ""), q(m.category || ""), f.min || 0, f.max || 0].join(",");
    });
  return [HYD_FLOORS_TEMPLATE_HEADER.join(","), ...lines].join("\n");
}
