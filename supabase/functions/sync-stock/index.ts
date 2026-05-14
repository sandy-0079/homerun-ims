import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Branch ID → DS mapping ───────────────────────────────────────────────────
const BRANCHES: Record<string, string> = {
  DC:   '2753232000017648109',
  DS01: '2753232000000037051',
  DS02: '2753232000000037081',
  DS03: '2753232000000037109',
  DS04: '2753232000007867440',
  DS05: '2753232000017634267',
}

// PO location_name → DS code (as set in Zoho Books)
const LOCATION_TO_DS: Record<string, string> = {
  'DS01 Sarjapur':       'DS01',
  'DS02 Bileshivale':    'DS02',
  'DS03 Kengeri':        'DS03',
  'DS04 Chikkabanavara': 'DS04',
  'DS05 Basavanapura':   'DS05',
  'DC01 Rampura':        'DC',
}

const COOLDOWN_MINS  = 15
const PO_LOOKBACK_DAYS = 12

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

// ─── Stock: fetch all pages for one branch ────────────────────────────────────
async function fetchBranchStock(token: string, branchId: string): Promise<Record<string, any>> {
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
    const res = await fetch(`${base}&page=${page}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } })
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
      available_for_sale: item.quantity_available_for_sale ?? 0,
      in_transit:         Math.max(0, item.quantity_in_transit ?? 0),
    }
  }
  return result
}

// ─── PO: fetch active Replenishment PO list (last N days) ────────────────────
async function fetchActivePOList(token: string, cutoff: string): Promise<Record<string, any>> {
  const org   = Deno.env.get('ZOHO_ORG_ID')
  const active: Record<string, any> = {}  // po_id → list-level data

  for (const status of ['open', 'pending_approval']) {
    let page = 1
    while (true) {
      const res = await fetch(
        `https://www.zohoapis.in/books/v3/purchaseorders?organization_id=${org}&status=${status}&per_page=200&sort_column=date&sort_order=D&page=${page}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      )
      const data = await res.json()
      const pos: any[] = data.purchaseorders ?? []

      let reachedCutoff = false
      for (const po of pos) {
        if (po.date < cutoff) { reachedCutoff = true; break }
        if ((po.cf_purchase_type ?? '').toLowerCase() !== 'replenishment') continue
        active[po.purchaseorder_id] = po
      }
      if (reachedCutoff || !data.page_context?.has_more_page) break
      page++
    }
  }
  return active
}

// ─── PO: fetch detail for one PO ─────────────────────────────────────────────
async function fetchPODetail(token: string, poId: string): Promise<any> {
  const res = await fetch(
    `https://www.zohoapis.in/books/v3/purchaseorders/${poId}?organization_id=${Deno.env.get('ZOHO_ORG_ID')}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  )
  const data = await res.json()
  return data.purchaseorder ?? null
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const now    = new Date()
    const nowIso = now.toISOString()

    // 1. Read current payload (cooldown check + safe merge)
    const { data: row, error: readErr } = await supabase
      .from('team_data').select('payload').eq('id', 'global').single()
    if (readErr) throw new Error(`Supabase read: ${readErr.message}`)

    // 2. Cooldown — skip if synced within 15 min
    const perDS: Record<string, string> = row?.payload?.stockUploadedAtPerDS ?? {}
    const timestamps = Object.values(perDS).map(t => new Date(t).getTime())
    if (timestamps.length > 0) {
      const minsAgo = (now.getTime() - Math.max(...timestamps)) / 60_000
      if (minsAgo < COOLDOWN_MINS) {
        return new Response(JSON.stringify({
          ok: true, skipped: true,
          reason: `Last synced ${Math.floor(minsAgo)}m ago — ${COOLDOWN_MINS}-min cooldown active`,
        }), { headers: { 'Content-Type': 'application/json' } })
      }
    }

    // 3. Get Zoho access token
    const token = await getZohoToken()

    // ── Phase A: Stock sync ───────────────────────────────────────────────────
    const stockData: Record<string, Record<string, any>> = {}
    const stockUploadedAtPerDS: Record<string, string>   = {}

    for (const [ds, branchId] of Object.entries(BRANCHES)) {
      console.log(`Fetching stock: ${ds}...`)
      const branchStock = await fetchBranchStock(token, branchId)
      for (const [sku, vals] of Object.entries(branchStock)) {
        if (!stockData[sku]) stockData[sku] = {}
        stockData[sku][ds] = vals
      }
      stockUploadedAtPerDS[ds] = nowIso
    }

    // ── Phase B: PO sync (Replenishment, last 12 days, incremental) ──────────
    const cutoff = new Date(now.getTime() - PO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0]

    console.log(`Fetching PO list (last ${PO_LOOKBACK_DAYS} days, Replenishment)...`)
    const activePOs = await fetchActivePOList(token, cutoff)

    // Load existing PO cache for change detection
    const currentPoCache: Record<string, any> = row?.payload?._poCache ?? {}
    const updatedPoCache: Record<string, any> = {}

    // Determine which POs need a detail call (new or last_modified changed)
    let detailCalls = 0
    for (const [poId, po] of Object.entries(activePOs)) {
      const cached = currentPoCache[poId]
      if (cached && cached.last_modified === po.last_modified_time) {
        // Unchanged — reuse from cache
        updatedPoCache[poId] = cached
      } else {
        // New or modified — fetch detail
        console.log(`Fetching PO detail: ${po.purchaseorder_number}`)
        const detail = await fetchPODetail(token, poId)
        if (!detail) continue
        const ds = LOCATION_TO_DS[detail.location_name ?? '']
        if (!ds) continue

        const skus: Record<string, number> = {}
        for (const li of detail.line_items ?? []) {
          const sku = (li.sku ?? '').trim()
          if (sku) skus[sku] = li.quantity ?? 0
        }

        // cf_confirmed_delivery_time lives inside custom_fields[] array, not at top level
        const cfDelivery = (detail.custom_fields ?? [])
          .find((f: any) => f.api_name === 'cf_confirmed_delivery_time')
        const deliveryValue = cfDelivery?.value   // format: '2026-05-14 18:00'
        const delivery = deliveryValue ? deliveryValue.split(' ')[0] : null  // keep date only

        updatedPoCache[poId] = {
          last_modified: po.last_modified_time,
          date:          po.date,
          status:        po.status,
          vendor:        po.vendor_name,
          po_number:     po.purchaseorder_number,
          delivery,
          ds,
          skus,
        }
        detailCalls++
      }
    }
    // Stale entries (outside 12-day window) are simply not carried forward
    console.log(`PO sync: ${Object.keys(activePOs).length} active, ${detailCalls} detail calls`)

    // Rebuild poData from cache — sort by date DESC so latest PO wins per SKU
    const poData: Record<string, Record<string, any>> = {}
    const sortedEntries = Object.values(updatedPoCache)
      .sort((a, b) => b.date.localeCompare(a.date))

    for (const entry of sortedEntries) {
      const ds = entry.ds
      if (!poData[ds]) poData[ds] = {}
      for (const [sku, qty] of Object.entries(entry.skus as Record<string, number>)) {
        if (!poData[ds][sku]) {  // first assignment = latest PO
          poData[ds][sku] = {
            qty,
            po_date:   entry.date,
            status:    entry.status,
            vendor:    entry.vendor,
            delivery:  entry.delivery,
            po_number: entry.po_number,
          }
        }
      }
    }

    // ── Write merged payload ──────────────────────────────────────────────────
    const merged = {
      ...(row?.payload ?? {}),
      stockData,
      stockUploadedAtPerDS,
      stockUploadedAt: nowIso,
      poData,
      _poCache: updatedPoCache,
    }

    const { error: writeErr } = await supabase
      .from('team_data').upsert({ id: 'global', payload: merged, updated_at: nowIso })
    if (writeErr) throw new Error(`Supabase write: ${writeErr.message}`)

    const summary = {
      ok: true, synced_at: nowIso,
      sku_count:    Object.keys(stockData).length,
      po_count:     Object.keys(activePOs).length,
      po_detail_calls: detailCalls,
      locations:    Object.keys(BRANCHES),
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
