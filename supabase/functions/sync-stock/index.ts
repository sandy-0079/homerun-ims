import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Branch ID → DS mapping (confirmed via API 2026-05-14) ───────────────────
const BRANCHES: Record<string, string> = {
  DC:   '2753232000017648109',
  DS01: '2753232000000037051',
  DS02: '2753232000000037081',
  DS03: '2753232000000037109',
  DS04: '2753232000007867440',
  DS05: '2753232000017634267',
}

// ─── Zoho OAuth ───────────────────────────────────────────────────────────────
async function getZohoToken(): Promise<string> {
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id:     Deno.env.get('ZOHO_CLIENT_ID')!,
      client_secret: Deno.env.get('ZOHO_CLIENT_SECRET')!,
      refresh_token: Deno.env.get('ZOHO_REFRESH_TOKEN')!,
      grant_type:    'refresh_token',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Zoho auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

// ─── Fetch all pages for one branch ──────────────────────────────────────────
async function fetchBranchStock(
  token: string,
  branchId: string
): Promise<Record<string, { available_for_sale: number; in_transit: number }>> {
  const rule = JSON.stringify({
    columns: [{ index: 1, field: 'location_name', value: [branchId], comparator: 'in', group: 'branch' }],
    criteria_string: '1',
  })

  const base =
    `https://www.zohoapis.in/books/v3/reports/inventorysummary` +
    `?organization_id=${Deno.env.get('ZOHO_ORG_ID')}` +
    `&filter_by=TransactionDate.Today` +
    `&per_page=200` +
    `&exclude_transfer_order=false` +
    `&rule=${encodeURIComponent(rule)}`

  const allItems: any[] = []
  let page = 1

  while (true) {
    const res = await fetch(`${base}&page=${page}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    })
    if (!res.ok) throw new Error(`Zoho API ${res.status} on page ${page}`)
    const data = await res.json()
    const items: any[] = data.inventory?.[0]?.item_details ?? []
    allItems.push(...items)
    if (!data.page_context?.has_more_page) break
    page++
  }

  const result: Record<string, { available_for_sale: number; in_transit: number }> = {}
  for (const item of allItems) {
    const sku = (item.sku ?? '').trim()
    if (!sku) continue
    result[sku] = {
      available_for_sale: item.quantity_available_for_sale ?? 0,
      in_transit:         Math.max(0, item.quantity_in_transit ?? 0),
    }
  }
  return result
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const now = new Date().toISOString()

    // 1. Get Zoho access token (valid 1 hour — refreshed each run)
    const token = await getZohoToken()

    // 2. Fetch stock for all 6 branches sequentially (avoids Zoho rate limits)
    const stockData: Record<string, Record<string, any>> = {}
    const stockUploadedAtPerDS: Record<string, string> = {}

    for (const [ds, branchId] of Object.entries(BRANCHES)) {
      console.log(`Fetching ${ds}...`)
      const branchStock = await fetchBranchStock(token, branchId)
      for (const [sku, vals] of Object.entries(branchStock)) {
        if (!stockData[sku]) stockData[sku] = {}
        stockData[sku][ds] = vals
      }
      stockUploadedAtPerDS[ds] = now
    }

    // 3. Read current payload — safe merge, never wipe invoiceData/skuMaster/params
    const { data: row, error: readErr } = await supabase
      .from('team_data')
      .select('payload')
      .eq('id', 'global')
      .single()

    if (readErr) throw new Error(`Supabase read: ${readErr.message}`)

    const merged = {
      ...(row?.payload ?? {}),
      stockData,
      stockUploadedAtPerDS,
      stockUploadedAt: now,  // keep legacy field in sync
    }

    // 4. Write back merged payload
    const { error: writeErr } = await supabase
      .from('team_data')
      .upsert({ id: 'global', payload: merged, updated_at: now })

    if (writeErr) throw new Error(`Supabase write: ${writeErr.message}`)

    const summary = {
      ok: true,
      synced_at: now,
      locations: Object.keys(BRANCHES),
      sku_count: Object.keys(stockData).length,
    }
    console.log('sync-stock complete:', JSON.stringify(summary))
    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('sync-stock error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
