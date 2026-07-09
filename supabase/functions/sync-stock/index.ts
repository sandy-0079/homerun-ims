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
const LOCK_STALE_MINS = 5
const SESSION_TTL_MINS = 12

// Every response needs CORS headers — browser callers (TO tool pull, Stock Health
// Sync Now) must be able to READ them. Before 2026-07-09 only the OPTIONS preflight
// had them, so browsers saw every response (even success 200s) as a network error.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ─── Sync lock + session lease (params/syncLock) ─────────────────────────────
// Two layers on one row, independent fields:
//  - lockedAt/holder: per-INVOCATION lock — prevents concurrent team_data/global
//    writers (statement timeouts; observed 2026-07-08: DC+DS01 74m stale). Older
//    than LOCK_STALE_MINS = leaked (crashed run), taken over.
//  - session: a SEQUENCE lease — one tool (TO pull / IMS Sync Now) owns the sync
//    path for its whole multi-group run incl. the 90s gaps between groups, so
//    crons and the other tool skip (busy) instead of stacking Zoho calls on top
//    (429 storm observed 2026-07-09). Expires after SESSION_TTL_MINS so a killed
//    browser tab can never wedge the crons.

type Session = { id: string; source: string; startedAt: string; expiresAt: string }

async function readLockRow(supabase: any): Promise<Record<string, any>> {
  const { data } = await supabase.from('params').select('payload').eq('id', 'syncLock').maybeSingle()
  return data?.payload ?? {}
}

async function writeLockRow(supabase: any, payload: Record<string, unknown>): Promise<boolean> {
  const { error } = await supabase.from('params')
    .upsert({ id: 'syncLock', payload, updated_at: new Date().toISOString() })
  if (error) console.error('syncLock write failed:', error.message)
  return !error
}

const sessionActive = (s: Session | null | undefined): boolean =>
  !!s?.expiresAt && Date.now() < new Date(s.expiresAt).getTime()

async function acquireSyncLock(
  supabase: any, holder: string, nowIso: string, sessionId: string | null,
): Promise<{ ok: boolean; reason: string }> {
  const cur = await readLockRow(supabase)
  if (sessionActive(cur.session) && cur.session.id !== sessionId) {
    return { ok: false, reason: `sync session held by ${cur.session.source}` }
  }
  const lockedAt = cur.lockedAt
  if (lockedAt && Date.now() - new Date(lockedAt).getTime() < LOCK_STALE_MINS * 60_000) {
    return { ok: false, reason: 'another stock sync is in progress' }
  }
  const ok = await writeLockRow(supabase, { ...cur, lockedAt: nowIso, holder })
  return { ok, reason: ok ? '' : 'lock write failed' }
}

async function releaseSyncLock(supabase: any): Promise<void> {
  const cur = await readLockRow(supabase)
  await writeLockRow(supabase, { ...cur, lockedAt: null, holder: null })
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
    return new Response('ok', { headers: CORS_HEADERS })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let lockHeld = false
  try {
    const now    = new Date()
    const nowIso = now.toISOString()

    // Parse body once: a session action, or a branch sync (defaults to all — the
    // crons send {branches:[…]} and behave exactly as before)
    let body: Record<string, any> = {}
    try { body = (await req.json()) ?? {} } catch { /* empty body = full sync */ }

    // ── Session lease: a tool claims the sync path for one multi-group sequence ──
    if (body.sessionStart) {
      const cur = await readLockRow(supabase)
      if (sessionActive(cur.session)) {
        return json({ ok: true, busy: true, session: cur.session })
      }
      const session: Session = {
        id: crypto.randomUUID(),
        source: typeof body.source === 'string' ? body.source : 'unknown',
        startedAt: nowIso,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MINS * 60_000).toISOString(),
      }
      if (!(await writeLockRow(supabase, { ...cur, session }))) throw new Error('session write failed')
      return json({ ok: true, session })
    }
    if (body.sessionEnd) {
      const cur = await readLockRow(supabase)
      if (cur.session?.id === body.sessionId) {
        await writeLockRow(supabase, { ...cur, session: null })
      }
      return json({ ok: true })
    }

    const requested = Array.isArray(body.branches) ? body.branches : []
    const branchesToSync = requested.length > 0
      ? requested.filter((ds: string) => BRANCHES[ds])
      : Object.keys(BRANCHES)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null

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
        return json({
          ok: true, skipped: true,
          reason: `Branches [${branchesToSync.join(',')}] synced ${Math.floor(oldestMins)}m ago — cooldown active`,
        })
      }
    }

    // 3. Sync lock — foreign sessions and in-flight invocations get `busy`
    const lock = await acquireSyncLock(supabase, branchesToSync.join(','), nowIso, sessionId)
    if (!lock.ok) {
      return json({ ok: true, busy: true, reason: lock.reason })
    }
    lockHeld = true

    // 4. Get Zoho access token
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
    return json(summary)

  } catch (err) {
    console.error('sync-stock error:', err)
    return json({ ok: false, error: String(err) }, 500)
  } finally {
    if (lockHeld) await releaseSyncLock(supabase)
  }
})
