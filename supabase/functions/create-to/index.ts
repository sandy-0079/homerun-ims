import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { zohoFetchWithRetry } from '../_shared/zohoClient.ts'
import { partitionInactive, skipSetGrew, type SkippedLine } from '../_shared/toLineFilter.ts'

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
//    anything is created.
//  - ⚠ ONE EXCEPTION, added 2026-08-29: a SKU that resolves but is INACTIVE in
//    Zoho is DROPPED and the rest of the TO proceeds. Zoho refuses the entire
//    order if any line names an inactive item, so "all or nothing" here meant
//    "nothing" — on 2026-08-28 the DC team could not raise a single TO. The drop
//    is reported to the caller (`skipped`) and recorded in params/toAudit.
//  - Caller must be a signed-in Supabase Auth user (the anon key alone is
//    rejected); the audit trail records the verified token's email.
//
// Zoho calls: GET /items (read-only, SKU→item_id+status map, cached 30 MIN in
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

// ─── TO Type (Zoho custom field, added 2026-08-07) ───────────────────────────
// Every TO this function creates is a DC→DS mid-mile restock, so the type is a
// property of THIS ENDPOINT, not a user choice — the tool never asks and never
// sends it. Zoho defaults the field to "Order Fulfilment" when it is absent,
// which the DC team was flipping by hand on every tool-created TO.
//
// ⚠ Custom fields MUST go in `custom_fields` — a top-level `to_type` key would be
// silently ignored, exactly as a standalone `reason` key is (the UI's "Reason" is
// really `description`; live-verified 2026-07-10). A wrong api_name therefore
// fails SILENTLY: the TO is created and Zoho applies its default, so it reads
// "Order Fulfilment" — indistinguishable from the old behaviour except by the
// read-back check below.
//
// Field config, read off Zoho Settings → Transfer Orders → Edit Field, 2026-08-07:
//   Label "TO Type" · Dropdown · options exactly "Mid Mile" | "Order Fulfilment"
//   (British single-l Fulfilment) · Default "Order Fulfilment" · Is Mandatory NO.
// Not mandatory is what makes the retry-without-it path below safe by config, not
// just by inference.
const TO_TYPE_API_NAME = 'cf_to_type' // confirmed: Zoho's "API Field Name"
const TO_TYPE_VALUE = 'Mid Mile'      // must match the dropdown option EXACTLY

// ⚠ 30 MINUTES, not 24 hours (changed 2026-08-29). The TTL is what decides whether
// validation can SEE a same-day deactivation. At 24h the map called yesterday's 334
// flipped SKUs active, so the pre-flight passed and only the Zoho POST discovered
// otherwise. At 30 min the first TO of a session refreshes (~8s, surfaced in the
// tool's existing "validating" stage) and the rest of that session is instant.
// ~12 TOs/day raised in two windows => roughly 2 refreshes/day.
const ITEM_MAP_TTL_HOURS = 0.5
const AUDIT_KEEP = 200
const SNAPSHOT_KEEP = 48 // ~8 batches × 6 DSes — comfortably covers the last-2 compare

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Every Zoho call goes through zohoFetchWithRetry (../_shared/zohoClient.ts):
// token from the shared cache, self-heal on a 401 (force-refresh + retry once),
// 429 back-off. Writes (POST/DELETE) pass { retry429: false } so a create is
// never auto-repeated. (Root cause of the 2026-07-15 TO 401 incident.)

// ─── SKU → {id, name, rate} map, cached in params/zohoItemIds ────────────────
// `status` added 2026-08-29. It rides the SAME /items response we already page
// through, so storing it costs no extra Zoho call — and it is the only way to
// know a SKU was deactivated TODAY. `skuMaster` is a nightly copy and is
// structurally blind to a same-day flip; see _shared/toLineFilter.ts.
type ItemInfo = { id: string; name: string; rate: number; status?: string }

// Two Zoho items sharing one SKU code would bind a TO line to whichever the map
// saw last — collect duplicates so validation can refuse those SKUs instead.
async function fetchItemMap(supabase: any): Promise<{ map: Record<string, ItemInfo>; dups: string[] }> {
  const org = Deno.env.get('ZOHO_ORG_ID')
  const map: Record<string, ItemInfo> = {}
  const dupSet = new Set<string>()
  let page = 1
  while (true) {
    const res = await zohoFetchWithRetry(supabase, (token) => fetch(
      `https://www.zohoapis.in/inventory/v1/items?organization_id=${org}&per_page=200&page=${page}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    ))
    if (!res.ok) throw new Error(`Zoho items API ${res.status} on page ${page}`)
    const data = await res.json()
    for (const it of data.items ?? []) {
      const sku = (it.sku ?? '').trim()
      if (!sku) continue
      if (map[sku]) dupSet.add(sku)
      map[sku] = { id: it.item_id, name: it.name, rate: it.rate ?? 0, status: it.status ?? '' }
    }
    if (!data.page_context?.has_more_page) break
    page++
  }
  return { map, dups: [...dupSet] }
}

async function getItemMap(
  supabase: any, requiredSkus: string[], force = false,
): Promise<{ map: Record<string, ItemInfo>; dups: string[]; fresh: boolean }> {
  const { data } = await supabase.from('params').select('payload').eq('id', 'zohoItemIds').maybeSingle()
  const cached = data?.payload
  const ageH = cached?.refreshedAt
    ? (Date.now() - new Date(cached.refreshedAt).getTime()) / 3_600_000 : Infinity
  const missing = requiredSkus.some((s) => !cached?.map?.[s])
  // dups was added 2026-07-10, status 2026-08-29 — an older cached payload
  // without either forces one refresh rather than reasoning from a field that
  // is not there.
  const hasStatus = !!cached?.map &&
    Object.values(cached.map as Record<string, ItemInfo>).some((v) => v?.status !== undefined)
  if (!force && cached?.map && Array.isArray(cached.dups) && hasStatus &&
      ageH < ITEM_MAP_TTL_HOURS && !missing) {
    return { map: cached.map, dups: cached.dups, fresh: false }
  }

  // ⚠ A REFRESH FAILURE MUST NOT BLOCK A TRANSFER ORDER. Before 2026-08-29 the TTL
  // was 24h, so almost every TO was served from cache and never touched /items at
  // all; at 30 minutes most TOs now refresh, which would newly expose the whole DC
  // TO path to Zoho being slow or rate-limited. Falling back to the cached map
  // degrades to exactly the old behaviour — a possibly stale status, which the
  // reactive retry below then recovers — instead of failing the transfer outright.
  let fetched: { map: Record<string, ItemInfo>; dups: string[] }
  try {
    fetched = await fetchItemMap(supabase)
  } catch (e) {
    if (cached?.map && !missing) {
      console.error(`create-to: item map refresh failed, falling back to ${ageH.toFixed(1)}h-old cache: ${e}`)
      return { map: cached.map, dups: cached.dups ?? [], fresh: false }
    }
    throw e   // no usable cache — the existing badSkus path is the right failure
  }

  await supabase.from('params').upsert({
    id: 'zohoItemIds',
    payload: { refreshedAt: new Date().toISOString(), map: fetched.map, dups: fetched.dups },
    updated_at: new Date().toISOString(),
  })
  return { ...fetched, fresh: true }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    // ── Caller must be a real signed-in user ──────────────────────────────────
    // The gateway's JWT check also passes the PUBLIC anon key (it ships in every
    // browser bundle) — reject it here. Audit identity comes from the verified
    // token, not a spoofable header.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: caller, error: callerErr } = await supabase.auth.getUser(jwt)
    const by = caller?.user?.email
    if (callerErr || !by) {
      return json({ ok: false, error: 'Sign in required — this endpoint needs a user session' }, 401)
    }

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

    let { map: itemMap, dups, fresh } = await getItemMap(supabase, skus)
    const badSkus = skus.filter((s: string) => !itemMap[s])
    if (badSkus.length > 0) {
      return json({ ok: false, error: 'SKUs not found in Zoho items', badSkus }, 400)
    }
    const dupSet = new Set(dups)
    const dupSkus = skus.filter((s: string) => dupSet.has(s))
    if (dupSkus.length > 0) {
      return json({
        ok: false, dupSkus,
        error: 'SKUs ambiguous in Zoho (two items share the SKU code) — fix in Zoho first',
      }, 400)
    }

    // ── Drop lines Zoho will not accept ───────────────────────────────────────
    // Zoho refuses the WHOLE transfer order if any line names an inactive item, so
    // one deactivated SKU blocks a 94-line TO. See _shared/toLineFilter.ts.
    let skipped: SkippedLine[] = partitionInactive(skus, itemMap).skipped

    // ⚠⚠ NEVER SKIP ON STALE DATA — this guard matters more than the skip itself.
    // The cache is stale in BOTH directions. "Says active, actually inactive" is the
    // bug being fixed. "Says inactive, actually active" would SILENTLY DROP GOOD
    // LINES, which is strictly worse — and it is not hypothetical: on 2026-08-29 ops
    // reactivated 334 SKUs, and a map from the previous evening would have skipped
    // every one of them while the screen calmly reported "90 of 94 items".
    // So a skip proposed from a cached map is never acted on: refresh and re-ask.
    // Costs nothing on a clean TO, because `buildToTargets` already emits only
    // SKUs that were active at the last engine run.
    if (skipped.length > 0 && !fresh) {
      console.log(`create-to: ${skipped.length} skip(s) proposed from a cached item map — refreshing before acting`)
      const re = await getItemMap(supabase, skus, true)
      itemMap = re.map; fresh = re.fresh
      skipped = partitionInactive(skus, itemMap).skipped
      console.log(`create-to: after refresh, ${skipped.length} skip(s) confirmed`)
    }

    const skippedSet = new Set(skipped.map((s) => s.sku))
    let resolved = lines
      .filter((l: any) => !skippedSet.has(l.sku.trim()))
      .map((l: any) => ({
        sku: l.sku.trim(),
        item_id: itemMap[l.sku.trim()].id,
        name: itemMap[l.sku.trim()].name,
        quantity_transfer: l.qty,
      }))

    // ⚠ An empty TO is refused, never created. If every line is inactive there is
    // nothing to transfer, and a zero-line draft in Zoho is worse than a clear
    // error: someone would have to find and delete it.
    if (resolved.length === 0) {
      return json({
        ok: false, skipped,
        error: `No transferable lines — all ${skus.length} SKU(s) are inactive or deleted in Zoho`,
      }, 400)
    }

    // IST date (Zoho org runs on IST)
    const date = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
    // Zoho TOs have NO separate reason field — the UI/PDF's "Reason" section renders
    // the API `description` (live-verified 2026-07-10; a standalone `reason` key is
    // ignored). So the reason leads the description, attribution follows. Zoho's
    // "Created By" always shows the API account — the email is the real clicker
    // (verified JWT).
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim() : 'Internal Transfer'
    const description =
      `${reason} - created by ${by}` +
      (typeof body.note === 'string' && body.note ? ` ${body.note}` : '')

    // zohoOrgId lets the tool build "View in Zoho" deep links (org id is not a secret
    // to our own signed-in users).
    const org = Deno.env.get('ZOHO_ORG_ID')
    if (body.dryRun) {
      // `skipped` rides the DRY RUN so the tool can show the drop on its existing
      // confirm screen — the user approves a plan that already reflects it, rather
      // than discovering "90 of 94" after the TO exists.
      return json({ ok: true, dryRun: true, toDsId, date, description, reason, lines: resolved,
        skipped, requested: skus.length, zohoOrgId: org, toType: TO_TYPE_VALUE })
    }

    // ── Create the DRAFT transfer order ───────────────────────────────────────
    // status:'draft' is the undocumented field the Zoho UI's own "Save as Draft"
    // sends (captured from the web app's network trace, 2026-07-10). NOTE:
    // is_intransit_order is NOT a draft toggle — false means "direct transfer",
    // which executes the full stock movement instantly (learned the hard way,
    // TO-00539 incident 2026-07-10).
    const postTO = (withType: boolean) => zohoFetchWithRetry(supabase, (token) => fetch(
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
          ...(withType
            ? { custom_fields: [{ api_name: TO_TYPE_API_NAME, value: TO_TYPE_VALUE }] }
            : {}),
        }),
      },
    ), { retry429: false })

    let res = await postTO(true)
    let data = await res.json()
    let toTypeWarning: string | null = null

    // ── Safety valve: TO Type must never block a transfer ─────────────────────
    // Before 2026-08-07 this field could not fail a create at all (Zoho just
    // applied its default), so setting it is the FIRST thing here that can 400.
    // On a 400 — Zoho's validation layer, which means nothing was created, the
    // same reasoning the numbering self-heal relies on — retry ONCE without the
    // custom field. Worst case is then exactly the old behaviour: TO created,
    // type "Order Fulfilment", flipped by hand.
    // Deliberately NOT retried on 5xx/timeout/429: there a TO may in fact have
    // been created, and a blind repeat would duplicate it (why writes carry
    // retry429:false in the first place).
    if (!res.ok && res.status === 400) {
      const firstErr = data.message ?? JSON.stringify(data)
      console.error(`create-to: 400 with ${TO_TYPE_API_NAME} — retrying without it: ${firstErr}`)
      const retryRes = await postTO(false)
      const retryData = await retryRes.json()
      if (retryRes.ok && retryData.transfer_order) {
        res = retryRes
        data = retryData
        toTypeWarning = `TO Type NOT set — Zoho rejected ${TO_TYPE_API_NAME}="${TO_TYPE_VALUE}" (${firstErr}). ` +
          `The TO was created with Zoho's default; set the type manually.`
        console.error(`create-to: ${toTypeWarning}`)
      } else {
        // ── Last resort: was a SKU deactivated since our item map was built? ────
        // The pre-flight above uses a map up to ITEM_MAP_TTL_HOURS old, so a SKU
        // deactivated inside that window still reaches Zoho and 400s here. Refresh,
        // re-partition, and retry ONCE — but only if the skip set actually GREW.
        //
        // ⚠ That condition is the whole safety of this branch, and it is why we do
        // NOT parse Zoho's message. A 400 about numbering or locations produces no
        // new skips, so nothing is retried and the original error is surfaced
        // untouched. Reading the English sentence would also only ever give us the
        // item NAME, and only ONE of them — four bad SKUs would cost four attempts.
        // Re-partitioning catches all of them in a single pass.
        //
        // ⚠ Reached only on status === 400 — Zoho's validation layer, which means
        // NOTHING WAS CREATED. Never on 5xx/timeout/429, where a TO may exist and a
        // repeat would duplicate it. Same rule as the TO Type valve above.
        let recovered = false
        try {
          const re = await getItemMap(supabase, skus, true)
          const after = partitionInactive(skus, re.map).skipped
          if (skipSetGrew(skipped, after)) {
            const grew = after.filter((s) => !skipped.some((p) => p.sku === s.sku)).map((s) => s.sku)
            console.error(`create-to: 400 recovered — newly inactive since the item map was built: ${grew.join(', ')}`)
            skipped = after
            itemMap = re.map
            const nowSkipped = new Set(after.map((s) => s.sku))
            resolved = lines
              .filter((l: any) => !nowSkipped.has(l.sku.trim()))
              .map((l: any) => ({
                sku: l.sku.trim(),
                item_id: re.map[l.sku.trim()].id,
                name: re.map[l.sku.trim()].name,
                quantity_transfer: l.qty,
              }))
            if (resolved.length > 0) {
              const finalRes = await postTO(true)
              const finalData = await finalRes.json()
              if (finalRes.ok && finalData.transfer_order) {
                res = finalRes
                data = finalData
                recovered = true
              }
            }
          }
        } catch (e) {
          console.error(`create-to: inactive-SKU recovery failed, surfacing the original 400: ${e}`)
        }
        if (!recovered) {
          // Surface the ORIGINAL error: if the 400 was really about numbering or
          // locations, that message is far more useful than the retry's.
          return json({ ok: false, skipped, error: `Zoho create failed (400): ${firstErr}` }, 502)
        }
      }
    }

    if (!res.ok || !data.transfer_order) {
      return json({ ok: false, error: `Zoho create failed (${res.status}): ${data.message ?? JSON.stringify(data)}` }, 502)
    }
    const to = data.transfer_order

    // ── Hard guard: anything but a draft is reversed IMMEDIATELY ──────────────
    // If Zoho ignored/changed the draft semantics, delete the TO in the same
    // invocation (deletion reverses any stock effect) and fail loudly.
    if (to.status !== 'draft') {
      const del = await zohoFetchWithRetry(supabase, (token) => fetch(
        `https://www.zohoapis.in/inventory/v1/transferorders/${to.transfer_order_id}?organization_id=${org}`,
        { method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      ), { retry429: false })
      return json({
        ok: false,
        error: `Zoho returned status='${to.status}' instead of 'draft' — ${to.transfer_order_number} was ` +
          (del.ok ? 'deleted immediately; no changes persisted.' :
            `NOT deletable (HTTP ${del.status}) — DELETE IT MANUALLY IN ZOHO NOW: ${to.transfer_order_number}`),
      }, 502)
    }

    // ── Read the TO Type back off the created TO ──────────────────────────────
    // The create response carries the same `custom_fields` array sync-orders reads,
    // so this turns a SILENT no-op (wrong api_name → Zoho's default silently wins)
    // into something visible. Never fatal: a mislabelled draft is a data-quality
    // issue, not a stock one, and the draft is worth far more than the label.
    // The full array is logged because it is also how the real api_name is
    // discovered if the constant above is ever wrong.
    const cfList = Array.isArray(to.custom_fields) ? to.custom_fields : []
    const toTypeActual = cfList.find((f: any) => f.api_name === TO_TYPE_API_NAME)?.value ?? null
    if (!toTypeWarning && toTypeActual !== TO_TYPE_VALUE) {
      toTypeWarning = `TO Type reads ${JSON.stringify(toTypeActual)} not "${TO_TYPE_VALUE}" — ` +
        `api_name "${TO_TYPE_API_NAME}" is probably wrong; Zoho ignored it and applied its default.`
      console.error(`create-to: ${toTypeWarning} custom_fields=${JSON.stringify(cfList)}`)
    }

    // ── Audit (additive params row; best-effort) ──────────────────────────────
    try {
      const { data: aRow } = await supabase.from('params').select('payload').eq('id', 'toAudit').maybeSingle()
      const entries = Array.isArray(aRow?.payload?.entries) ? aRow.payload.entries : []
      entries.unshift({
        at: new Date().toISOString(), by, toDsId,
        lineCount: resolved.length,
        units: resolved.reduce((a: number, l: any) => a + l.quantity_transfer, 0),
        // Only when something was actually dropped — an empty array on every entry
        // would be noise on a row the nightly digest reads. The digest names these
        // for the admin; the ground team only ever sees a count.
        ...(skipped.length ? { requested: skus.length, skipped } : {}),
        transfer_order_id: to.transfer_order_id,
        transfer_order_number: to.transfer_order_number,
      })
      await supabase.from('params').upsert({
        id: 'toAudit',
        payload: { entries: entries.slice(0, AUDIT_KEEP) },
        updated_at: new Date().toISOString(),
      })
    } catch (e) { console.error('toAudit write failed (non-fatal):', e) }

    // ── Fill snapshot (additive params row; best-effort — same swallow-on-fail as
    // audit, so an analytics write can NEVER block a TO). The client computes it
    // from its full plan (only the client knows Req vs Actual and the shortfall);
    // we just persist it. Dedupe by (ds, batchKey) so re-generating the same DS in
    // a batch replaces its snapshot; keep the last SNAPSHOT_KEEP.
    if (body.snapshot && typeof body.snapshot === 'object' && body.snapshot.ds === toDsId) {
      try {
        const { data: sRow } = await supabase.from('params').select('payload').eq('id', 'toSnapshots').maybeSingle()
        const prev = Array.isArray(sRow?.payload?.entries) ? sRow.payload.entries : []
        const snap = { ...body.snapshot, by, at: new Date().toISOString(),
          transfer_order_number: to.transfer_order_number }
        const kept = prev.filter((e: any) => !(e.ds === snap.ds && e.batchKey === snap.batchKey))
        kept.unshift(snap)
        await supabase.from('params').upsert({
          id: 'toSnapshots',
          payload: { entries: kept.slice(0, SNAPSHOT_KEEP) },
          updated_at: new Date().toISOString(),
        })
      } catch (e) { console.error('toSnapshots write failed (non-fatal):', e) }
    }

    console.log(`create-to: DRAFT ${to.transfer_order_number} → ${toDsId}, ${resolved.length} of ` +
      `${skus.length} lines, by ${by}, TO Type ${JSON.stringify(toTypeActual)}` +
      (skipped.length ? ` — SKIPPED ${skipped.length} inactive: ${skipped.map((s) => s.sku).join(', ')}` : ''))
    // toType/toTypeWarning are additive: the tool ignores unknown keys today (no
    // frontend change shipped with this), but they make the state inspectable.
    return json({
      ok: true,
      transfer_order_id: to.transfer_order_id,
      transfer_order_number: to.transfer_order_number,
      status: to.status,
      toDsId,
      lines: resolved,
      zohoOrgId: org,
      // Always present so the tool can render "90 of 94" without inferring, and
      // `skipped` is always an array so a caller can read `.length` unguarded.
      requested: skus.length,
      skipped,
      toType: toTypeActual,
      ...(toTypeWarning ? { toTypeWarning } : {}),
    })
  } catch (err) {
    console.error('create-to error:', err)
    return json({ ok: false, error: String(err) }, 500)
  }
})
