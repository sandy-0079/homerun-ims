import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Branch ID → DS mapping (Zoho Inventory org 60075214606) ─────────────────
const BRANCHES: Record<string, string> = {
  DC:   '3915979000000118466',
  DS01: '3915979000000054002',
  DS02: '3915979000000054017',
  DS03: '3915979000000054032',
  DS04: '3915979000000054047',
  DS05: '3915979000000054062',
  DS06: '3915979000000118484',
}

const COOLDOWN_MINS = 15

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

// ─── Retry helper — waits and retries on Zoho 429 ────────────────────────────
async function zohoFetch(url: string, token: string): Promise<Response> {
  const opts = { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, opts)
    if (res.status !== 429) return res
    if (attempt < 3) {
      const wait = attempt * 10_000
      console.warn(`Zoho 429 (attempt ${attempt}/3), retrying in ${wait / 1000}s...`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error('Zoho API 429 after 3 attempts')
}

// ─── Stock: fetch all pages for one branch ────────────────────────────────────
async function fetchBranchStock(token: string, branchId: string, showActualStock: boolean): Promise<Record<string, any>> {
  const rule = JSON.stringify({
    columns: [{ index: 1, field: 'location_name', value: [branchId], comparator: 'in', group: 'branch' }],
    criteria_string: '1',
  })
  const base =
    `https://www.zohoapis.in/inventory/v1/reports/inventorysummary` +
    `?organization_id=${Deno.env.get('ZOHO_ORG_ID')}` +
    `&filter_by=TransactionDate.Today` +
    `&per_page=200` +
    `&exclude_transfer_order=false` +
    `&show_actual_stock=${showActualStock}` +
    `&rule=${encodeURIComponent(rule)}`

  const allItems: any[] = []
  let page = 1
  while (true) {
    const res = await zohoFetch(`${base}&page=${page}`, token)
    if (!res.ok) throw new Error(`Zoho API ${res.status} on page ${page}`)
    const data = await res.json()
    allItems.push(...(data.inventory?.[0]?.item_details ?? []))
    if (!data.page_context?.has_more_page) break
    page++
  }

  const result: Record<string, any> = {}
  for (const item of allItems) {
    const sku = (item.sku ?? '').trim()
    if (!sku) continue
    result[sku] = {
      stock_on_hand:      item.quantity_available ?? 0,
      available_for_sale: item.quantity_available_for_sale ?? 0,
      in_transit:         Math.max(0, item.quantity_in_transit ?? 0),
    }
  }
  return result
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }})
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const now    = new Date()
    const nowIso = now.toISOString()

    // Parse which branches to sync from request body (defaults to all)
    let branchesToSync: string[]
    try {
      const body = await req.json()
      const requested = Array.isArray(body?.branches) ? body.branches : []
      branchesToSync = requested.length > 0
        ? requested.filter((ds: string) => BRANCHES[ds])
        : Object.keys(BRANCHES)
    } catch {
      branchesToSync = Object.keys(BRANCHES)
    }

    // 1. Read current payload (cooldown check + base for merge)
    const { data: row, error: readErr } = await supabase
      .from('team_data').select('payload').eq('id', 'global').single()
    if (readErr) throw new Error(`Supabase read: ${readErr.message}`)

    // 2. Cooldown — skip if all requested branches were synced within 15 min
    const perDS: Record<string, string> = row?.payload?.stockUploadedAtPerDS ?? {}
    const branchTimestamps = branchesToSync
      .map(ds => perDS[ds]).filter(Boolean).map(t => new Date(t).getTime())
    if (branchTimestamps.length === branchesToSync.length) {
      const oldestMins = (now.getTime() - Math.min(...branchTimestamps)) / 60_000
      if (oldestMins < COOLDOWN_MINS) {
        return new Response(JSON.stringify({
          ok: true, skipped: true,
          reason: `Branches [${branchesToSync.join(',')}] synced ${Math.floor(oldestMins)}m ago — cooldown active`,
        }), { headers: { 'Content-Type': 'application/json' } })
      }
    }

    // 3. Get Zoho access token
    const token = await getZohoToken()

    // ── Fetch both modes for each requested branch, 2 branches in parallel ────
    // 4 concurrent Zoho calls at a time — stays under Zoho's inventorysummary
    // rate limit (~8 calls/min). Cron jobs are staggered 1 min apart so each
    // function's 4 calls never overlap with another function's calls.
    const newStockData:        Record<string, Record<string, any>> = {}
    const newStockDataAccting: Record<string, Record<string, any>> = {}
    const newStockUploadedAt:  Record<string, string>              = {}

    const branchEntries = branchesToSync.map(ds => [ds, BRANCHES[ds]] as [string, string])
    for (let i = 0; i < branchEntries.length; i += 2) {
      const group = branchEntries.slice(i, i + 2)
      console.log(`Fetching stock: ${group.map(([ds]) => ds).join(', ')}...`)
      const results = await Promise.all(
        group.map(([ds, branchId]) =>
          Promise.all([
            fetchBranchStock(token, branchId, true),
            fetchBranchStock(token, branchId, false),
          ]).then(([physical, accounting]) => ({ ds, physical, accounting }))
        )
      )
      for (const { ds, physical, accounting } of results) {
        for (const [sku, vals] of Object.entries(physical)) {
          if (!newStockData[sku]) newStockData[sku] = {}
          newStockData[sku][ds] = vals
        }
        for (const [sku, vals] of Object.entries(accounting)) {
          if (!newStockDataAccting[sku]) newStockDataAccting[sku] = {}
          newStockDataAccting[sku][ds] = vals
        }
        newStockUploadedAt[ds] = nowIso
      }
    }

    // ── Fresh read before write — get latest payload for branch-level merge ───
    const { data: latestRow, error: latestErr } = await supabase
      .from('team_data').select('payload').eq('id', 'global').single()
    if (latestErr) throw new Error(`Supabase pre-write read: ${latestErr.message}`)

    // Merge at branch level: preserve other functions' branch data
    const existingStockData  = latestRow?.payload?.stockData         ?? {}
    const existingStockAcct  = latestRow?.payload?.stockDataAccounting ?? {}
    const existingPerDS      = latestRow?.payload?.stockUploadedAtPerDS ?? {}

    const mergedStockData: Record<string, any> = { ...existingStockData }
    for (const [sku, branches] of Object.entries(newStockData)) {
      mergedStockData[sku] = { ...(existingStockData[sku] ?? {}), ...branches }
    }
    const mergedStockDataAccting: Record<string, any> = { ...existingStockAcct }
    for (const [sku, branches] of Object.entries(newStockDataAccting)) {
      mergedStockDataAccting[sku] = { ...(existingStockAcct[sku] ?? {}), ...branches }
    }

    const merged = {
      ...(latestRow?.payload ?? {}),
      stockData:            mergedStockData,
      stockDataAccounting:  mergedStockDataAccting,
      stockUploadedAtPerDS: { ...existingPerDS, ...newStockUploadedAt },
      stockUploadedAt:      nowIso,
    }

    const { error: writeErr } = await supabase
      .from('team_data').upsert({ id: 'global', payload: merged, updated_at: nowIso })
    if (writeErr) throw new Error(`Supabase write: ${writeErr.message}`)

    const summary = {
      ok: true, synced_at: nowIso,
      branches:    branchesToSync,
      sku_count:   Object.keys(newStockData).length,
      stock_modes: 2,
    }
    console.log('sync-stock complete:', JSON.stringify(summary))
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('sync-stock error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
