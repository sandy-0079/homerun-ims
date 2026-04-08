// Pull all items from Zoho and return as SKU master data
// Returns: { sku, name, category, brand, status } per item

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { zohoGet, jsonResponse, errorResponse } from "../_shared/zoho.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  try {
    const items: { sku: string; name: string; category: string; brand: string; status: string }[] = [];
    let page = 1;

    while (true) {
      const data = await zohoGet("items", { per_page: "200", page: String(page), status: "active" }) as Record<string, unknown>;
      const pageItems = (data.items as Record<string, string>[]) ?? [];
      if (!pageItems.length) break;

      for (const item of pageItems) {
        if (!item.sku) continue;
        items.push({
          sku: item.sku,
          name: item.name ?? "",
          category: item.category_name ?? "",
          brand: item.brand ?? "",
          status: item.status ?? "active",
        });
      }

      const hasMore = (data.page_context as Record<string, boolean>)?.has_more_page;
      if (!hasMore) break;
      page++;
    }

    return jsonResponse({ success: true, count: items.length, items });
  } catch (err) {
    return errorResponse(String(err));
  }
});
