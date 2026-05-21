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

const COOLDOWN_MINS    = 15
const PO_LOOKBACK_DAYS = 12
const TO_LOOKBACK_DAYS = 12
const DC_BRANCH_ID     = '2753232000017648109'

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
      const wait = attempt * 10_000  // 10s, 20s
      console.warn(`Zoho 429 (attempt ${attempt}/3), retrying in ${wait / 1000}s...`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error('Zoho API 429 after 3 attempts')
}

// ─── Stock: fetch all pages for one branch ────────────────────────────────────
// showActualStock=true  → Bills & Invoices (Physical)
// showActualStock=false → Shipments & Receives (Accounting)
async function fetchBranchStock(token: string, branchId: string, showActualStock: boolean): Promise<Record<string, any>> {
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

// ─── TO: fetch active Transfer Orders from DC (last N days) ──────────────────
async function fetchActiveTOList(token: string, cutoff: string): Promise<Record<string, any>> {
  const org    = Deno.env.get('ZOHO_ORG_ID')
  const active: Record<string, any> = {}

  for (const status of ['draft', 'in_transit']) {
    let page = 1
    while (true) {
      const res = await fetch(
        `https://www.zohoapis.in/books/v3/transferorders?organization_id=${org}&status=${status}&per_page=200&sort_column=date&sort_order=D&page=${page}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      )
      const data = await res.json()
      const tos: any[] = data.transfer_orders ?? []

      let reachedCutoff = false
      for (const to of tos) {
        if (to.date < cutoff) { reachedCutoff = true; break }
        if (to.from_location_id !== DC_BRANCH_ID) continue  // only DC-originated TOs
        active[to.transfer_order_id] = to
      }
      if (reachedCutoff || !data.page_context?.has_more_page) break
      page++
    }
  }
  return active
}

// ─── TO: fetch TOs transferred today IST (by last_modified_time) from DC ─────
// Uses a 2-day date window so TOs raised yesterday but transferred today are caught.
// Filters in-memory to last_modified_time >= midnight IST (the actual transfer time).
// Caches detail calls — same pattern as _poCache/_toCache.
async function fetchTransferredToday(
  token: string,
  transferredCutoff: string,
  midnightISTasUTC: string,
  existingCache: Record<string, any>,
): Promise<{ entries: Record<string, any>; updatedCache: Record<string, any> }> {
  const org = Deno.env.get('ZOHO_ORG_ID')
  const candidates: Array<{ id: string; to: any }> = []

  let page = 1
  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/transferorders?organization_id=${org}&status=transferred&per_page=200&sort_column=date&sort_order=D&page=${page}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    )
    const data = await res.json()
    const tos: any[] = data.transfer_orders ?? []

    let pastCutoff = false
    for (const to of tos) {
      if (to.date < transferredCutoff) { pastCutoff = true; break }
      if (to.from_location_id !== DC_BRANCH_ID) continue
      const modifiedMs = to.last_modified_time ? new Date(to.last_modified_time).getTime() : 0
      if (modifiedMs >= new Date(midnightISTasUTC).getTime()) {
        candidates.push({ id: to.transfer_order_id, to })
      }
    }
    if (pastCutoff || !data.page_context?.has_more_page) break
    page++
  }

  // Fetch detail only for new/modified candidates; reuse cache for unchanged ones
  const updatedCache: Record<string, any> = {}
  let detailCalls = 0
  for (const { id: toId, to } of candidates) {
    const cached = existingCache[toId]
    if (cached && cached.last_modified === to.last_modified_time) {
      updatedCache[toId] = cached
    } else {
      const detail = await fetchTODetail(token, toId)
      if (!detail) continue
      const ds = LOCATION_TO_DS[detail.to_location_name ?? '']
      if (!ds) continue
      const skus: Record<string, number> = {}
      for (const li of detail.line_items ?? []) {
        const sku = (li.sku ?? '').trim()
        if (sku) skus[sku] = li.quantity_transfer ?? 0
      }
      updatedCache[toId] = {
        last_modified: to.last_modified_time,
        date:          to.date,
        to_number:     to.transfer_order_number,
        to_id:         toId,
        ds,
        skus,
      }
      detailCalls++
    }
  }
  console.log(`Transferred today candidates: ${candidates.length}, detail calls: ${detailCalls}`)

  // Build result — most recently transferred TO wins per SKU×DS
  const entries: Record<string, any> = {}
  for (const [toId, cached] of Object.entries(updatedCache)) {
    for (const [sku, qty] of Object.entries(cached.skus as Record<string, number>)) {
      const key = `${cached.ds}:${sku}`
      const existing = entries[key]
      if (!existing || cached.last_modified > existing._lastModified) {
        entries[key] = {
          qty:           qty,
          to_date:       cached.date,
          to_number:     cached.to_number,
          to_id:         toId,
          _lastModified: cached.last_modified,
        }
      }
    }
  }
  return { entries, updatedCache }
}

// ─── TO: fetch detail for one TO ─────────────────────────────────────────────
async function fetchTODetail(token: string, toId: string): Promise<any> {
  const res = await fetch(
    `https://www.zohoapis.in/books/v3/transferorders/${toId}?organization_id=${Deno.env.get('ZOHO_ORG_ID')}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  )
  const data = await res.json()
  return data.transfer_order ?? null
}

// ─── PO: fetch active Replenishment PO list (last N days) ────────────────────
async function fetchActivePOList(token: string, cutoff: string): Promise<Record<string, any>> {
  const org   = Deno.env.get('ZOHO_ORG_ID')
  const active: Record<string, any> = {}  // po_id → list-level data

  for (const status of ['open', 'pending_approval', 'partially_billed']) {
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

    // ── Phase A: Stock sync (both modes per branch) ───────────────────────────
    const stockData: Record<string, Record<string, any>> = {}           // Physical (Bills & Invoices)
    const stockDataAccounting: Record<string, Record<string, any>> = {} // Accounting (Shipments & Receives)
    const stockUploadedAtPerDS: Record<string, string> = {}

    // 2 concurrent per branch (physical + accounting in parallel), sequential across branches
    // inventorysummary takes ~18s/call — 6×18s=108s fits in 150s; 12×18s does not
    for (const [ds, branchId] of Object.entries(BRANCHES)) {
      console.log(`Fetching stock: ${ds}...`)
      const [physicalStock, accountingStock] = await Promise.all([
        fetchBranchStock(token, branchId, true),
        fetchBranchStock(token, branchId, false),
      ])
      for (const [sku, vals] of Object.entries(physicalStock)) {
        if (!stockData[sku]) stockData[sku] = {}
        stockData[sku][ds] = vals
      }
      for (const [sku, vals] of Object.entries(accountingStock)) {
        if (!stockDataAccounting[sku]) stockDataAccounting[sku] = {}
        stockDataAccounting[sku][ds] = vals
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

        const skus: Record<string, { qty: number; received: number }> = {}
        for (const li of detail.line_items ?? []) {
          const sku = (li.sku ?? '').trim()
          if (sku) skus[sku] = { qty: li.quantity ?? 0, received: li.quantity_received ?? 0 }
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
          po_id:         poId,
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
      .sort((a, b) => b.date.localeCompare(a.date) || b.last_modified.localeCompare(a.last_modified))

    for (const entry of sortedEntries) {
      const ds = entry.ds
      if (!poData[ds]) poData[ds] = {}
      for (const [sku, skuData] of Object.entries(entry.skus as Record<string, { qty: number; received: number }>)) {
        if (!poData[ds][sku]) {  // first assignment = latest PO
          poData[ds][sku] = {
            qty:       skuData.qty,
            received:  skuData.received,
            po_date:   entry.date,
            status:    entry.status,
            delivery:  entry.delivery,
            po_number: entry.po_number,
            po_id:     entry.po_id,
          }
        }
      }
    }

    // ── Phase C: TO sync (Draft + In Transit, last 12 days, from DC) ──────────
    const toCutoff = new Date(now.getTime() - TO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0]

    console.log(`Fetching TO list (last ${TO_LOOKBACK_DAYS} days, draft+in_transit from DC)...`)
    const activeTOs = await fetchActiveTOList(token, toCutoff)

    const currentToCache: Record<string, any> = row?.payload?._toCache ?? {}
    const updatedToCache: Record<string, any> = {}

    let toDetailCalls = 0
    for (const [toId, to] of Object.entries(activeTOs)) {
      const cached = currentToCache[toId]
      if (cached && cached.last_modified === to.last_modified_time) {
        updatedToCache[toId] = cached
      } else {
        console.log(`Fetching TO detail: ${to.transfer_order_number}`)
        const detail = await fetchTODetail(token, toId)
        if (!detail) continue
        const ds = LOCATION_TO_DS[detail.to_location_name ?? '']
        if (!ds) continue

        const skus: Record<string, { qty: number }> = {}
        for (const li of detail.line_items ?? []) {
          const sku = (li.sku ?? '').trim()
          if (sku) skus[sku] = { qty: li.quantity_transfer ?? 0 }
        }

        updatedToCache[toId] = {
          last_modified: to.last_modified_time,
          date:          to.date,
          status:        to.status,
          to_number:     to.transfer_order_number,
          to_id:         toId,
          ds,
          skus,
        }
        toDetailCalls++
      }
    }
    console.log(`TO sync: ${Object.keys(activeTOs).length} active, ${toDetailCalls} detail calls`)

    // Compute midnight IST as UTC — transferred after this timestamp = "transferred today"
    const nowIST           = new Date(now.getTime() + 5.5 * 3600 * 1000)
    const todayIST         = nowIST.toISOString().split('T')[0]
    const midnightISTasUTC = new Date(todayIST + 'T00:00:00+05:30').toISOString()
    // 2-day date window to catch TOs raised yesterday but transferred today
    const transferredCutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0]

    const currentTransferredCache: Record<string, any> = row?.payload?._transferredTodayCache ?? {}
    console.log(`Fetching transferred TOs since midnight IST (${midnightISTasUTC})...`)
    let transferredToday: Record<string, any> = {}
    let updatedTransferredCache: Record<string, any> = {}
    try {
      const result = await fetchTransferredToday(token, transferredCutoff, midnightISTasUTC, currentTransferredCache)
      transferredToday = result.entries
      updatedTransferredCache = result.updatedCache
    } catch (err) {
      console.warn('fetchTransferredToday failed (non-critical, skipping):', err)
    }
    console.log(`Transferred today: ${Object.keys(transferredToday).length} SKU×DS combos`)

    // Build toData — pass 1: transferred today (highest priority, shows "Received")
    const toData: Record<string, Record<string, any>> = {}
    for (const [key, entry] of Object.entries(transferredToday)) {
      const colonIdx = key.indexOf(':')
      const ds  = key.slice(0, colonIdx)
      const sku = key.slice(colonIdx + 1)
      if (!toData[ds]) toData[ds] = {}
      toData[ds][sku] = {
        qty:       entry.qty,
        rec_qty:   entry.qty,   // transferred qty = received qty
        to_date:   entry.to_date,
        status:    'transferred',
        to_number: entry.to_number,
        to_id:     entry.to_id,
      }
    }

    // Pass 2: active (draft/in_transit) — in_transit beats draft; skip if already transferred
    const sortedTOEntries = Object.values(updatedToCache)
      .sort((a, b) => {
        const statusRank = (s: string) => s === 'in_transit' ? 0 : 1
        return statusRank(a.status) - statusRank(b.status)
          || b.date.localeCompare(a.date)
          || b.last_modified.localeCompare(a.last_modified)
      })

    for (const entry of sortedTOEntries) {
      const ds = entry.ds
      if (!toData[ds]) toData[ds] = {}
      for (const [sku, skuData] of Object.entries(entry.skus as Record<string, { qty: number }>)) {
        if (toData[ds][sku]) continue  // already has transferred entry
        toData[ds][sku] = {
          qty:       skuData.qty,
          rec_qty:   null,
          to_date:   entry.date,
          status:    entry.status,
          to_number: entry.to_number,
          to_id:     entry.to_id,
        }
      }
    }

    // ── Write merged payload ──────────────────────────────────────────────────
    const merged = {
      ...(row?.payload ?? {}),
      stockData,
      stockDataAccounting,
      stockUploadedAtPerDS,
      stockUploadedAt: nowIso,
      poData,
      _poCache: updatedPoCache,
      toData,
      _toCache: updatedToCache,
      _transferredTodayCache: updatedTransferredCache,
    }

    const { error: writeErr } = await supabase
      .from('team_data').upsert({ id: 'global', payload: merged, updated_at: nowIso })
    if (writeErr) throw new Error(`Supabase write: ${writeErr.message}`)

    const summary = {
      ok: true, synced_at: nowIso,
      sku_count:       Object.keys(stockData).length,
      stock_modes:     2,
      po_count:        Object.keys(activePOs).length,
      po_detail_calls: detailCalls,
      to_count:        Object.keys(activeTOs).length,
      to_detail_calls: toDetailCalls,
      locations:       Object.keys(BRANCHES),
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
