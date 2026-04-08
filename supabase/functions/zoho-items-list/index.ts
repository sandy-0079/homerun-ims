// B3: Pull all items from Zoho, split into batches of 100, queue for stock sync
// Triggered at 7:45 AM daily by pg_cron

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoGet, jsonResponse, errorResponse } from "../_shared/zoho.ts";

const BATCH_SIZE = 100;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Pull all items paginated (each page = 200 items, ~8 pages for 1500 items)
    const items: { item_id: string; sku: string }[] = [];
    let page = 1;
    while (true) {
      const data = await zohoGet("items", { per_page: "200", page: String(page), status: "active" }) as Record<string, unknown>;
      const pageItems = (data.items as Record<string, string>[]) ?? [];
      if (!pageItems.length) break;

      for (const item of pageItems) {
        if (item.sku && item.item_id) {
          items.push({ item_id: item.item_id, sku: item.sku });
        }
      }

      const hasMore = (data.page_context as Record<string, boolean>)?.has_more_page;
      if (!hasMore) break;
      page++;
    }

    // 2. Clear any stale pending batches from previous runs
    await supabase.from("zoho_sync_queue").delete().eq("status", "pending");

    // 3. Split into batches of 100 and insert into queue
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      batches.push({
        batch_number: Math.floor(i / BATCH_SIZE) + 1,
        item_ids: items.slice(i, i + BATCH_SIZE),
        status: "pending",
      });
    }

    const { error } = await supabase.from("zoho_sync_queue").insert(batches);
    if (error) throw new Error(`Queue insert failed: ${error.message}`);

    return jsonResponse({
      success: true,
      total_items: items.length,
      batches_queued: batches.length,
    });
  } catch (err) {
    return errorResponse(String(err));
  }
});
