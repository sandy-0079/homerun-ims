// B5: Copy current stock_live → stock_snapshots as today's 8 AM opening snapshot
// Triggered at 7:55 AM daily by pg_cron

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonResponse, errorResponse } from "../_shared/zoho.ts";

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Get today's date (IST = UTC+5:30)
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset);
    const snapshotDate = ist.toISOString().slice(0, 10);

    // Read all current stock_live rows
    const { data: liveStock, error: readErr } = await supabase
      .from("stock_live")
      .select("sku, location, stock_on_hand, quantity_in_transit");

    if (readErr) throw new Error(`Read stock_live failed: ${readErr.message}`);
    if (!liveStock?.length) {
      return jsonResponse({ success: false, message: "stock_live is empty — snapshot skipped" });
    }

    // Build snapshot rows
    const snapshotRows = liveStock.map(row => ({
      snapshot_date: snapshotDate,
      sku: row.sku,
      location: row.location,
      stock_on_hand: row.stock_on_hand,
      quantity_in_transit: row.quantity_in_transit,
    }));

    // Upsert: if snapshot for today already exists, update it
    const { error: upsertErr } = await supabase
      .from("stock_snapshots")
      .upsert(snapshotRows, { onConflict: "snapshot_date,sku,location" });

    if (upsertErr) throw new Error(`Snapshot upsert failed: ${upsertErr.message}`);

    return jsonResponse({
      success: true,
      snapshot_date: snapshotDate,
      rows_saved: snapshotRows.length,
    });
  } catch (err) {
    return errorResponse(String(err));
  }
});
