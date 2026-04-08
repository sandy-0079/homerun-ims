// B8: Pull average purchase prices from Zoho "Purchases by Item" report
// Uses last 12 months window. Called on model refresh.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { zohoGet, jsonResponse, errorResponse } from "../_shared/zoho.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  try {
    // 12-month window ending today (IST)
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const toDate = ist.toISOString().slice(0, 10);
    const fromDate = new Date(ist.setFullYear(ist.getFullYear() - 1)).toISOString().slice(0, 10);

    const prices: Record<string, number> = {};
    let page = 1;

    while (true) {
      const data = await zohoGet("reports/purchasesbyitem", {
        from_date: fromDate, to_date: toDate,
        per_page: "200", page: String(page),
      }) as Record<string, unknown>;

      const sections = (data.purchases_by_item as Record<string, unknown>[]) ?? [];
      if (!sections.length) break;

      for (const section of sections) {
        for (const item of (section.purchase as Record<string, unknown>[]) ?? []) {
          const sku = (item.item as Record<string, string>)?.sku;
          const avgPrice = Number(item.average_price) || 0;
          if (sku && avgPrice > 0) prices[sku] = avgPrice;
        }
      }

      const hasMore = (data.page_context as Record<string, boolean>)?.has_more_page;
      if (!hasMore) break;
      page++;
    }

    return jsonResponse({ success: true, count: Object.keys(prices).length, prices });
  } catch (err) {
    return errorResponse(String(err));
  }
});
