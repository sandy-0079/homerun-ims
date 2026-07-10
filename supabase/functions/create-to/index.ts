import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── create-to — creates Zoho Transfer Orders as DRAFTS, and nothing else ─────
// Spec: homerun-to/docs/superpowers/specs/2026-07-10-task6b-draft-to-design.md
//
// Safety by construction:
//  - is_intransit_order is HARD-CODED false: this function can only create drafts
//    (zero stock movement, deletable). Status transitions (/intransit,
//    /markastransferred) are never called — moving a draft onward is a human
//    action in Zoho after cross-checking.
//  - Destination must be a DS (never DC); source is always DC.
//  - Every SKU must resolve to a Zoho item_id or the WHOLE request fails before
//    anything is created — no partial TOs.
//
// Zoho calls: GET /items (read-only, SKU→item_id map, cached 24h in
// params/zohoItemIds), POST /transferorders (one draft). Nothing else.

const BRANCHES: Record<string, string> = {
  DC:   '3915979000000118466',
  DS01: '3915979000000054002',
  DS02: '3915979000000054017',
  DS03: '3915979000000054032',
  DS04: '3915979000000054047',
  DS05: '3915979000000054062',
  DS06: '3915979000000118484',
}
const DS_ONLY = ['DS01', 'DS02', 'DS03', 'DS04', 'DS05', 'DS06']
const ITEM_MAP_TTL_HOURS = 24
const AUDIT_KEEP = 200

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

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

// ─── SKU → {id, name, rate} map, cached in params/zohoItemIds ────────────────
type ItemInfo = { id: string; name: string; rate: number }

async function fetchItemMap(token: string): Promise<Record<string, ItemInfo>> {
  const org = Deno.env.get('ZOHO_ORG_ID')
  const map: Record<string, ItemInfo> = {}
  let page = 1
  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/inventory/v1/items?organization_id=${org}&per_page=200&page=${page}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    )
    if (!res.ok) throw new Error(`Zoho items API ${res.status} on page ${page}`)
    const data = await res.json()
    for (const it of data.items ?? []) {
      const sku = (it.sku ?? '').trim()
      if (sku) map[sku] = { id: it.item_id, name: it.name, rate: it.rate ?? 0 }
    }
    if (!data.page_context?.has_more_page) break
    page++
  }
  return map
}

async function getItemMap(
  supabase: any, token: string, requiredSkus: string[],
): Promise<Record<string, ItemInfo>> {
  const { data } = await supabase.from('params').select('payload').eq('id', 'zohoItemIds').maybeSingle()
  const cached = data?.payload
  const ageH = cached?.refreshedAt
    ? (Date.now() - new Date(cached.refreshedAt).getTime()) / 3_600_000 : Infinity
  const missing = requiredSkus.some((s) => !cached?.map?.[s])
  if (cached?.map && ageH < ITEM_MAP_TTL_HOURS && !missing) return cached.map

  const map = await fetchItemMap(token)
  await supabase.from('params').upsert({
    id: 'zohoItemIds',
    payload: { refreshedAt: new Date().toISOString(), map },
    updated_at: new Date().toISOString(),
  })
  return map
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    let body: Record<string, any> = {}
    try { body = (await req.json()) ?? {} } catch { /* validated below */ }

    // ── Validate everything before touching Zoho ──────────────────────────────
    const toDsId = body.toDsId
    if (!DS_ONLY.includes(toDsId)) {
      return json({ ok: false, error: `toDsId must be one of ${DS_ONLY.join(', ')}` }, 400)
    }
    const lines = Array.isArray(body.lines) ? body.lines : []
    if (lines.length === 0) return json({ ok: false, error: 'lines is empty' }, 400)
    for (const l of lines) {
      if (typeof l?.sku !== 'string' || !l.sku.trim() ||
          !Number.isInteger(l?.qty) || l.qty <= 0) {
        return json({ ok: false, error: `bad line: ${JSON.stringify(l)} — need {sku, qty>0 int}` }, 400)
      }
    }
    const skus = lines.map((l: any) => l.sku.trim())
    if (new Set(skus).size !== skus.length) return json({ ok: false, error: 'duplicate SKUs in lines' }, 400)

    const token = await getZohoToken()
    const itemMap = await getItemMap(supabase, token, skus)
    const badSkus = skus.filter((s: string) => !itemMap[s])
    if (badSkus.length > 0) {
      return json({ ok: false, error: 'SKUs not found in Zoho items', badSkus }, 400)
    }

    const resolved = lines.map((l: any) => ({
      sku: l.sku.trim(),
      item_id: itemMap[l.sku.trim()].id,
      name: itemMap[l.sku.trim()].name,
      quantity_transfer: l.qty,
    }))

    // IST date (Zoho org runs on IST)
    const date = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
    const description =
      'Created as DRAFT by TO tool — cross-check before moving to In Transit.' +
      (typeof body.note === 'string' && body.note ? ` ${body.note}` : '')

    if (body.dryRun) {
      return json({ ok: true, dryRun: true, toDsId, date, description, lines: resolved })
    }

    // ── Create the DRAFT transfer order ───────────────────────────────────────
    // status:'draft' is the undocumented field the Zoho UI's own "Save as Draft"
    // sends (captured from the web app's network trace, 2026-07-10). NOTE:
    // is_intransit_order is NOT a draft toggle — false means "direct transfer",
    // which executes the full stock movement instantly (learned the hard way,
    // TO-00539 incident 2026-07-10).
    const org = Deno.env.get('ZOHO_ORG_ID')
    const res = await fetch(
      `https://www.zohoapis.in/inventory/v1/transferorders?organization_id=${org}`,
      {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          from_location_id: BRANCHES.DC,
          to_location_id: BRANCHES[toDsId],
          line_items: resolved.map(({ item_id, name, quantity_transfer }) => ({ item_id, name, quantity_transfer })),
          status: 'draft', // DRAFT — the only mode this function supports
          description,
        }),
      },
    )
    const data = await res.json()
    if (!res.ok || !data.transfer_order) {
      return json({ ok: false, error: `Zoho create failed (${res.status}): ${data.message ?? JSON.stringify(data)}` }, 502)
    }
    const to = data.transfer_order

    // ── Hard guard: anything but a draft is reversed IMMEDIATELY ──────────────
    // If Zoho ignored/changed the draft semantics, delete the TO in the same
    // invocation (deletion reverses any stock effect) and fail loudly.
    if (to.status !== 'draft') {
      const del = await fetch(
        `https://www.zohoapis.in/inventory/v1/transferorders/${to.transfer_order_id}?organization_id=${org}`,
        { method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      )
      return json({
        ok: false,
        error: `Zoho returned status='${to.status}' instead of 'draft' — ${to.transfer_order_number} was ` +
          (del.ok ? 'deleted immediately; no changes persisted.' :
            `NOT deletable (HTTP ${del.status}) — DELETE IT MANUALLY IN ZOHO NOW: ${to.transfer_order_number}`),
      }, 502)
    }

    // ── Audit (additive params row; best-effort) ──────────────────────────────
    try {
      const by = req.headers.get('x-created-by') ?? 'unknown'
      const { data: aRow } = await supabase.from('params').select('payload').eq('id', 'toAudit').maybeSingle()
      const entries = Array.isArray(aRow?.payload?.entries) ? aRow.payload.entries : []
      entries.unshift({
        at: new Date().toISOString(), by, toDsId,
        lineCount: resolved.length,
        units: resolved.reduce((a: number, l: any) => a + l.quantity_transfer, 0),
        transfer_order_id: to.transfer_order_id,
        transfer_order_number: to.transfer_order_number,
      })
      await supabase.from('params').upsert({
        id: 'toAudit',
        payload: { entries: entries.slice(0, AUDIT_KEEP) },
        updated_at: new Date().toISOString(),
      })
    } catch (e) { console.error('toAudit write failed (non-fatal):', e) }

    console.log(`create-to: DRAFT ${to.transfer_order_number} → ${toDsId}, ${resolved.length} lines`)
    return json({
      ok: true,
      transfer_order_id: to.transfer_order_id,
      transfer_order_number: to.transfer_order_number,
      status: to.status,
      toDsId,
      lines: resolved,
    })
  } catch (err) {
    console.error('create-to error:', err)
    return json({ ok: false, error: String(err) }, 500)
  }
})
