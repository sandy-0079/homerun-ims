import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
const TO_LOOKBACK_DAYS = 3
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
        if (to.from_location_id !== DC_BRANCH_ID) continue
        active[to.transfer_order_id] = to
      }
      if (reachedCutoff || !data.page_context?.has_more_page) break
      page++
    }
  }
  return active
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
  const active: Record<string, any> = {}

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

    // 1. Read current payload (cooldown check + cache lookup)
    const { data: row, error: readErr } = await supabase
      .from('team_data').select('payload').eq('id', 'global').single()
    if (readErr) throw new Error(`Supabase read: ${readErr.message}`)

    // 2. Cooldown — skip if orders synced within 15 min
    const lastOrdersSync = row?.payload?.ordersUploadedAt
    if (lastOrdersSync) {
      const minsAgo = (now.getTime() - new Date(lastOrdersSync).getTime()) / 60_000
      if (minsAgo < COOLDOWN_MINS) {
        return new Response(JSON.stringify({
          ok: true, skipped: true,
          reason: `Orders synced ${Math.floor(minsAgo)}m ago — ${COOLDOWN_MINS}-min cooldown active`,
        }), { headers: { 'Content-Type': 'application/json' } })
      }
    }

    // 3. Get Zoho access token
    const token = await getZohoToken()

    // ── Phase A: PO sync (Replenishment, last 12 days, incremental) ──────────
    const cutoff = new Date(now.getTime() - PO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0]

    console.log(`Fetching PO list (last ${PO_LOOKBACK_DAYS} days, Replenishment)...`)
    const activePOs = await fetchActivePOList(token, cutoff)

    const currentPoCache: Record<string, any> = row?.payload?._poCache ?? {}
    const updatedPoCache: Record<string, any> = {}

    let detailCalls = 0
    for (const [poId, po] of Object.entries(activePOs)) {
      const cached = currentPoCache[poId]
      if (cached && cached.last_modified === po.last_modified_time) {
        updatedPoCache[poId] = cached
      } else {
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

        const cfDelivery = (detail.custom_fields ?? [])
          .find((f: any) => f.api_name === 'cf_confirmed_delivery_time')
        const deliveryValue = cfDelivery?.value
        const delivery = deliveryValue ? deliveryValue.split(' ')[0] : null

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
    console.log(`PO sync: ${Object.keys(activePOs).length} active, ${detailCalls} detail calls`)

    const poData: Record<string, Record<string, any>> = {}
    const sortedEntries = Object.values(updatedPoCache)
      .sort((a, b) => b.date.localeCompare(a.date) || b.last_modified.localeCompare(a.last_modified))

    for (const entry of sortedEntries) {
      const ds = entry.ds
      if (!poData[ds]) poData[ds] = {}
      for (const [sku, skuData] of Object.entries(entry.skus as Record<string, { qty: number; received: number }>)) {
        if (!poData[ds][sku]) {
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

    // ── Phase B: TO sync (Draft + In Transit, last 3 days, from DC) ──────────
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

    // Build toData — active TOs only (in_transit > draft).
    // Transferred TOs are not shown: once received, stock appears in AFS.
    // Zoho's last_modified_time is unreliable as a transfer-date signal.
    const toData: Record<string, Record<string, any>> = {}
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
        if (toData[ds][sku]) continue
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

    // ── Fresh read before write — spreads latest payload so sync-stock's ──────
    // concurrent writes are not overwritten by our startup-time snapshot.
    const { data: latestRow, error: latestErr } = await supabase
      .from('team_data').select('payload').eq('id', 'global').single()
    if (latestErr) throw new Error(`Supabase pre-write read: ${latestErr.message}`)

    const merged = {
      ...(latestRow?.payload ?? {}),
      poData,
      _poCache:               updatedPoCache,
      toData,
      _toCache:               updatedToCache,
      ordersUploadedAt:       nowIso,
    }

    const { error: writeErr } = await supabase
      .from('team_data').upsert({ id: 'global', payload: merged, updated_at: nowIso })
    if (writeErr) throw new Error(`Supabase write: ${writeErr.message}`)

    const summary = {
      ok: true, synced_at: nowIso,
      po_count:        Object.keys(activePOs).length,
      po_detail_calls: detailCalls,
      to_count:        Object.keys(activeTOs).length,
      to_detail_calls: toDetailCalls,
    }
    console.log('sync-orders complete:', JSON.stringify(summary))
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('sync-orders error:', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
