// B4: Process one pending batch from zoho_sync_queue
// Fetches item details for 100 SKUs and writes per-location stock to stock_live
// Called every 30s by pg_cron until queue is empty

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoGet, LOCATION_MAP, jsonResponse, errorResponse } from "../_shared/zoho.ts";

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // 1. Find next pending batch, then claim it (two-step to avoid PostgREST order-on-update limitation)
    const { data: found } = await supabase
      .from("zoho_sync_queue")
      .select("id, batch_number, item_ids")
      .eq("status", "pending")
      .order("batch_number")
      .limit(1)
      .single();

    if (!found) {
      return jsonResponse({ success: true, message: "No pending batches" });
    }

    // Claim it by updating status to processing
    const { data: batch, error: claimErr } = await supabase
      .from("zoho_sync_queue")
      .update({ status: "processing" })
      .eq("id", found.id)
      .eq("status", "pending") // guard against race condition
      .select()
      .single();

    if (claimErr || !batch) {
      return jsonResponse({ success: true, message: "Batch already claimed" });
    }

    const items = batch.item_ids as { item_id: string; sku: string }[];

    // 2. Fetch item details for each item in the batch (parallel, 5 at a time)
    const stockRows: {
      sku: string; location: string; stock_on_hand: number; quantity_in_transit: number; synced_at: string;
    }[] = [];

    const syncedAt = new Date().toISOString();

    // Process in groups of 5 concurrent requests to stay within rate limits
    for (let i = 0; i < items.length; i += 5) {
      const group = items.slice(i, i + 5);
      const results = await Promise.allSettled(
        group.map(({ item_id }) => zohoGet(`items/${item_id}`) as Promise<Record<string, unknown>>)
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status !== "fulfilled") continue;

        const item = (result.value as Record<string, unknown>).item as Record<string, unknown>;
        if (!item) continue;

        const sku = group[j].sku;
        const locations = (item.locations as Record<string, unknown>[]) ?? [];

        for (const loc of locations) {
          const locName = loc.location_name as string;
          const ds = LOCATION_MAP[locName];
          if (!ds) continue; // skip HomeRun Bangalore (HQ)

          stockRows.push({
            sku,
            location: ds,
            stock_on_hand: Math.max(0, Number(loc.location_stock_on_hand) || 0),
            quantity_in_transit: Math.max(0, Number(loc.location_quantity_in_transit) || 0),
            synced_at: syncedAt,
          });
        }
      }
    }

    // 3. Upsert stock into stock_live (on conflict replace)
    if (stockRows.length > 0) {
      const { error: upsertErr } = await supabase
        .from("stock_live")
        .upsert(stockRows, { onConflict: "sku,location" });
      if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);
    }

    // 4. Mark batch as done
    await supabase
      .from("zoho_sync_queue")
      .update({ status: "done", processed_at: syncedAt })
      .eq("id", batch.id);

    return jsonResponse({
      success: true,
      batch: batch.batch_number,
      items_processed: items.length,
      stock_rows_written: stockRows.length,
    });
  } catch (err) {
    return errorResponse(String(err));
  }
});
