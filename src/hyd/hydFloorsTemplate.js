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

/** The SKUs sold at Pati with no floor (hydRun.report.outOfRangeSales), as a floor
 *  sheet to fill in: Item Name + Category for the category team, Min/Max blank (blank
 *  reads as 0, so an unfilled row stays out of range). `null` when there is nothing. */
export function buildOutOfRangeTemplate(skus, skuMaster) {
  if (!skus || !skus.length) return null;
  const lines = skus.map(sku => {
    const m = skuMaster?.[sku] || {};
    return [q(sku), q(m.name || ""), q(m.category || ""), "", ""].join(",");
  });
  return [HYD_FLOORS_TEMPLATE_HEADER.join(","), ...lines].join("\n");
}

export const outOfRangeTemplateFilename = (isoDate) => `Hyderabad_floors_to_fill_${isoDate}.csv`;
