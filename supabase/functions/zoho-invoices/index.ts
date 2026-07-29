// B7: Pull invoice line items for a date range (used for model refresh)
// Returns data in the same format as the existing CSV invoice dump
// Called by Admin via "Sync from Zoho" button in Upload tab

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { zohoGet, ENGINE_STATUSES, LOCATION_MAP, jsonResponse, errorResponse } from "../_shared/zoho.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  try {
    const url = new URL(req.url);
    const fromDate = url.searchParams.get("from") ?? "";
    const toDate = url.searchParams.get("to") ?? "";
    if (!fromDate || !toDate) return errorResponse("Missing from/to params", 400);

    const lines: {
      date: string; sku: string; ds: string; qty: number; status: string;
    }[] = [];

    // Pull paid + overdue invoices (engine statuses only)
    for (const status of ENGINE_STATUSES) {
      let page = 1;
      while (true) {
        const data = await zohoGet("invoices", {
          date_start: fromDate, date_end: toDate,
          status, per_page: "200", page: String(page),
        }) as Record<string, unknown>;

        const invoices = (data.invoices as Record<string, string>[]) ?? [];
        if (!invoices.length) break;

        // Fetch line items for each invoice (in groups of 5 concurrent)
        for (let i = 0; i < invoices.length; i += 5) {
          const group = invoices.slice(i, i + 5);
          const details = await Promise.allSettled(
            group.map(inv => zohoGet(`invoices/${inv.invoice_id}`) as Promise<Record<string, unknown>>)
          );

          for (const result of details) {
            if (result.status !== "fulfilled") continue;
            const inv = (result.value as Record<string, unknown>).invoice as Record<string, unknown>;
            const date = inv?.date as string;
            const invStatus = inv?.status as string;

            for (const li of (inv?.line_items as Record<string, unknown>[]) ?? []) {
              const locName = li.location_name as string;
              const ds = LOCATION_MAP[locName];
              if (!ds) continue; // skip HQ location

              const sku = li.sku as string;
              const qty = Number(li.quantity) || 0;
              if (!sku || qty <= 0) continue;

              lines.push({ date, sku, ds, qty, status: invStatus });
            }
          }
        }

        const hasMore = (data.page_context as Record<string, boolean>)?.has_more_page;
        if (!hasMore) break;
        page++;
      }
    }

    return jsonResponse({ success: true, count: lines.length, invoices: lines });
  } catch (err) {
    return errorResponse(String(err));
  }
});
