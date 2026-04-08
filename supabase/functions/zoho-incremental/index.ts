// B6: Hourly incremental stock sync
// Pulls today's invoices → extracts unique SKUs → fetches item detail for those SKUs only
// Updates stock_live with Zoho's actual stock (pure mirror, no calculation)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoGet, LOCATION_MAP, SIM_STATUSES, jsonResponse, errorResponse } from "../_shared/zoho.ts";

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Today's date in IST
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const today = ist.toISOString().slice(0, 10);

    // 1. Pull today's invoices (all relevant statuses) — just the list, not details
    const skuToItemId: Record<string, string> = {};
    for (const status of SIM_STATUSES) {
      let page = 1;
      while (true) {
        const data = await zohoGet("invoices", {
          date_start: today, date_end: today,
          status, per_page: "200", page: String(page),
        }) as Record<string, unknown>;

        const invoices = (data.invoices as Record<string, string>[]) ?? [];
        if (!invoices.length) break;

        // Fetch detail for each invoice to get line items with SKUs
        const details = await Promise.allSettled(
          invoices.map(inv => zohoGet(`invoices/${inv.invoice_id}`) as Promise<Record<string, unknown>>)
        );

        for (const result of details) {
          if (result.status !== "fulfilled") continue;
          const inv = (result.value as Record<string, unknown>).invoice as Record<string, unknown>;
          for (const li of (inv?.line_items as Record<string, string>[]) ?? []) {
            if (li.sku && li.item_id) skuToItemId[li.sku] = li.item_id;
          }
        }

        const hasMore = (data.page_context as Record<string, boolean>)?.has_more_page;
        if (!hasMore) break;
        page++;
      }
    }

    const uniqueSkus = Object.entries(skuToItemId);
    if (!uniqueSkus.length) {
      return jsonResponse({ success: true, message: "No sales today yet", skus_updated: 0 });
    }

    // 2. Fetch item detail for each active SKU (in groups of 5 concurrent)
    const stockRows: {
      sku: string; location: string; stock_on_hand: number; quantity_in_transit: number; synced_at: string;
    }[] = [];
    const syncedAt = new Date().toISOString();

    for (let i = 0; i < uniqueSkus.length; i += 5) {
      const group = uniqueSkus.slice(i, i + 5);
      const results = await Promise.allSettled(
        group.map(([, item_id]) => zohoGet(`items/${item_id}`) as Promise<Record<string, unknown>>)
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status !== "fulfilled") continue;
        const item = (result.value as Record<string, unknown>).item as Record<string, unknown>;
        if (!item) continue;

        const sku = group[j][0];
        for (const loc of (item.locations as Record<string, unknown>[]) ?? []) {
          const ds = LOCATION_MAP[loc.location_name as string];
          if (!ds) continue;
          stockRows.push({
            sku, location: ds,
            stock_on_hand: Math.max(0, Number(loc.location_stock_on_hand) || 0),
            quantity_in_transit: Math.max(0, Number(loc.location_quantity_in_transit) || 0),
            synced_at: syncedAt,
          });
        }
      }
    }

    // 3. Upsert into stock_live
    if (stockRows.length > 0) {
      const { error } = await supabase
        .from("stock_live")
        .upsert(stockRows, { onConflict: "sku,location" });
      if (error) throw new Error(`Upsert failed: ${error.message}`);
    }

    return jsonResponse({
      success: true,
      today,
      skus_with_sales: uniqueSkus.length,
      stock_rows_updated: stockRows.length,
    });
  } catch (err) {
    return errorResponse(String(err));
  }
});
