import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { zohoFetchWithRetry } from '../_shared/zohoClient.ts'
import { partitionInactive, skipSetGrew, type SkippedLine } from '../_shared/toLineFilter.ts'
import {
  splitParts, partReason, linesFingerprint, findCreatedParts, stampSnapshotParts, type CreatedPart,
} from '../_shared/toSplit.ts'

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
// params/zohoItemIds), POST /transferorders (one draft — or, since 2026-10-01, one
// per part when a TO exceeds Zoho's line cap; see _shared/toSplit.ts). Nothing else.

const BRANCHES: Record<string, string> = {
  DC:   '3915979000000118466',
  DS01: '3915979000000054002',
  DS02: '3915979000000054017',
  DS03: '3915979000000054032',
  DS04: '3915979000000054047',
  DS05: '3915979000000054062',
  DS06: '3915979000000118484',
  // Added 2026-09-18, ahead of go-live. Ids read off Zoho Settings -> Locations.
  // ⚠ Both stores are gated by `openingDSList` in the engine, so their presence
  // here moves no target — it only lets stock/PO/TO data accumulate from day one.
  DS07: '3915979000030598119',
  DS08: '3915979000030600296',
}
// ⚠ DS07/DS08 are valid destinations from the moment they exist in Zoho, NOT from
// the moment they open. The TO tool cannot reach them — they are absent from
// `params/toTargets` while gated — so the only way to address one is a deliberate
// hand-built call, which is exactly what you want when test-firing a draft against
// a new branch before go-live. Everything this function creates is a draft: zero
// stock movement, deletable.
const DS_ONLY = ['DS01', 'DS02', 'DS03', 'DS04', 'DS05', 'DS06', 'DS07', 'DS08']

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

    const resolveLine = (l: any, map: Record<string, ItemInfo>) => ({
      sku: l.sku.trim(),
      item_id: map[l.sku.trim()].id,
      name: map[l.sku.trim()].name,
      quantity_transfer: l.qty,
    })
    const sendable = (part: any[]) => {
      const s = new Set(skipped.map((x) => x.sku))
      return part.filter((l: any) => !s.has(l.sku.trim())).map((l: any) => resolveLine(l, itemMap))
    }

    // ── Parts (added 2026-10-01) — see _shared/toSplit.ts ─────────────────────
    // Zoho refuses a TO over its line_items cap, so a big transfer becomes several
    // drafts, cut in the order sent (= the DC01 pick path). ≤ TO_LINE_CAP lines is
    // ONE part and runs exactly the pre-2026-10-01 path: same reason text, same
    // audit entry, same snapshot, same response (plus an additive `parts` array).
    // ⚠ Cut from the REQUESTED lines, before the inactive drop — see toSplit.ts for
    // why that is what makes a resume safe.
    const requestedParts = splitParts(lines)
    const nParts = requestedParts.length
    const multi = nParts > 1

    let resolved = sendable(lines)

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
    // (verified JWT). A split TO carries "k/n" after the reason, which is also what
    // the DC team searches Zoho's Reason filter for when a part's outcome is unknown.
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim() : 'Internal Transfer'
    const descriptionFor = (part: number) =>
      `${partReason(reason, part, nParts)} - created by ${by}` +
      (typeof body.note === 'string' && body.note ? ` ${body.note}` : '')
    const description = descriptionFor(1)

    // zohoOrgId lets the tool build "View in Zoho" deep links (org id is not a secret
    // to our own signed-in users).
    const org = Deno.env.get('ZOHO_ORG_ID')
    if (body.dryRun) {
      // `skipped` rides the DRY RUN so the tool can show the drop on its existing
      // confirm screen — the user approves a plan that already reflects it, rather
      // than discovering "90 of 94" after the TO exists. `parts` likewise lets it say
      // "2 drafts of 629" before anything is created.
      return json({ ok: true, dryRun: true, toDsId, date, description, reason, lines: resolved,
        skipped, requested: skus.length, zohoOrgId: org, toType: TO_TYPE_VALUE,
        parts: requestedParts.map((p, i) => {
          const s = sendable(p)
          return { part: i + 1, lineCount: s.length, units: s.reduce((a, l) => a + l.quantity_transfer, 0) }
        }),
      })
    }

    // ── Resume: parts of THIS request that already exist ──────────────────────
    // The tool sends one requestId per Generate and re-sends it on Resume / Try
    // again. Each part is audited the moment Zoho confirms it, so a part found here
    // definitely exists and is not created again. Only consulted for a split TO.
    const requestId = typeof body.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim().slice(0, 64) : undefined
    const linesHash = linesFingerprint(lines)
    let created = new Map<number, CreatedPart>()
    if (multi && requestId) {
      const { data: aRow } = await supabase.from('params').select('payload').eq('id', 'toAudit').maybeSingle()
      const found = findCreatedParts(aRow?.payload?.entries, requestId, linesHash, nParts)
      if (found.mismatch) {
        // ⚠ Never stitch a part cut from old lines to parts cut from new ones — SKUs
        // on the boundary would be sent twice or not at all.
        return json({
          ok: false, partial: true, parts: [], partsTotal: nParts,
          error: 'This TO\'s lines changed since its first part was created (stock reloaded?). ' +
            'Nothing new was created. Check Zoho for the parts already made before generating again.',
        }, 409)
      }
      created = found.created
      if (created.size) console.log(`create-to: resume ${requestId} — parts already created: ${[...created.keys()].join(', ')}`)
    }

    // ── Create ONE draft transfer order ───────────────────────────────────────
    // status:'draft' is the undocumented field the Zoho UI's own "Save as Draft"
    // sends (captured from the web app's network trace, 2026-07-10). NOTE:
    // is_intransit_order is NOT a draft toggle — false means "direct transfer",
    // which executes the full stock movement instantly (learned the hard way,
    // TO-00539 incident 2026-07-10).
    //
    // Returns { ok:true, to, partResolved, toTypeActual, toTypeWarning } or
    // { ok:false, error, sure } — `sure` = Zoho certainly created NOTHING for this
    // part (a 400, or a non-draft that was deleted). `sure:false` means the outcome
    // is unknown and a human must look before this part is attempted again.
    const createPart = async (partLines: any[], part: number) => {
      let partResolved = sendable(partLines)
      const postTO = (withType: boolean) => zohoFetchWithRetry(supabase, (token) => fetch(
        `https://www.zohoapis.in/inventory/v1/transferorders?organization_id=${org}`,
        {
          method: 'POST',
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date,
            from_location_id: BRANCHES.DC,
            to_location_id: BRANCHES[toDsId],
            line_items: partResolved.map(({ item_id, name, quantity_transfer }) => ({ item_id, name, quantity_transfer })),
            status: 'draft', // DRAFT — the only mode this function supports
            description: descriptionFor(part),
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
          //
          // The skip set is the WHOLE request's (shared across parts), so a SKU found
          // inactive here is also left out of every later part.
          let recovered = false
          try {
            const re = await getItemMap(supabase, skus, true)
            const after = partitionInactive(skus, re.map).skipped
            if (skipSetGrew(skipped, after)) {
              const grew = after.filter((s) => !skipped.some((p) => p.sku === s.sku)).map((s) => s.sku)
              console.error(`create-to: 400 recovered — newly inactive since the item map was built: ${grew.join(', ')}`)
              skipped = after
              itemMap = re.map
              partResolved = sendable(partLines)
              if (partResolved.length > 0) {
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
            return { ok: false as const, sure: true, was400: true, error: `Zoho create failed (400): ${firstErr}` }
          }
        }
      }

      if (!res.ok || !data.transfer_order) {
        return { ok: false as const, sure: false,
          error: `Zoho create failed (${res.status}): ${data.message ?? JSON.stringify(data)}` }
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
        return {
          ok: false as const, sure: del.ok,
          error: `Zoho returned status='${to.status}' instead of 'draft' — ${to.transfer_order_number} was ` +
            (del.ok ? 'deleted immediately; no changes persisted.' :
              `NOT deletable (HTTP ${del.status}) — DELETE IT MANUALLY IN ZOHO NOW: ${to.transfer_order_number}`),
        }
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
      return { ok: true as const, to, partResolved, toTypeActual, toTypeWarning }
    }

    // ── Audit (additive params row; best-effort) ──────────────────────────────
    // A split TO writes ONE ENTRY PER PART, the moment that part exists — not at the
    // end — so a function killed mid-run still leaves a record of what it made, and
    // a resume skips it. Split entries also carry requestId/linesHash/part/parts;
    // a single TO's entry is exactly the pre-2026-10-01 shape.
    const audit = async (entry: Record<string, unknown>) => {
      try {
        const { data: aRow } = await supabase.from('params').select('payload').eq('id', 'toAudit').maybeSingle()
        const entries = Array.isArray(aRow?.payload?.entries) ? aRow.payload.entries : []
        entries.unshift(entry)
        await supabase.from('params').upsert({
          id: 'toAudit',
          payload: { entries: entries.slice(0, AUDIT_KEEP) },
          updated_at: new Date().toISOString(),
        })
      } catch (e) {
        console.error(`toAudit write failed (non-fatal${multi ? '; a RESUME of this split TO would NOT see this part' : ''}):`, e)
      }
    }

    // ── Create every part, in order ───────────────────────────────────────────
    const done: (CreatedPart & { toType?: unknown })[] = []
    const allResolved: any[] = []
    const skuPart = new Map<string, number>()
    let toTypeActual: unknown = null
    let toTypeWarning: string | null = null
    for (let k = 1; k <= nParts; k++) {
      const partLines = requestedParts[k - 1]
      const prior = created.get(k)
      if (prior) {
        done.push(prior)
        for (const l of sendable(partLines)) { allResolved.push(l); skuPart.set(l.sku, k) }
        continue
      }
      // A part whose every line is inactive has nothing to send: no draft for it.
      if (sendable(partLines).length === 0) {
        console.log(`create-to: part ${k}/${nParts} has no transferable lines — skipped`)
        continue
      }

      let r: Awaited<ReturnType<typeof createPart>>
      try {
        r = await createPart(partLines, k)
      } catch (e) {
        // Single TO: rethrow → the outer handler's 500, exactly as before.
        if (!multi) throw e
        // A throw mid-POST (network, unparseable Zoho body) is an UNKNOWN outcome.
        r = { ok: false as const, sure: false, error: String(e) }
      }

      if (!r.ok) {
        if (!multi) {
          // Single TO: exactly the old responses (502, `skipped` on the 400 path).
          return json({ ok: false, ...('was400' in r && r.was400 ? { skipped } : {}), error: r.error }, 502)
        }
        // ⚠ Partial: say exactly what exists. Prior parts are real drafts; this one
        // either certainly does not exist (sure) or MAY exist (not sure) — in which
        // case a human checks Zoho's Reason filter for "k/n" before resuming.
        const made = done.map((d) => `${d.part}/${nParts} = ${d.transfer_order_number}`).join(', ')
        const error =
          (made ? `Created ${made}. ` : '') +
          `Part ${k}/${nParts} failed: ${r.error}` +
          (r.sure ? '' : ` — Zoho did not confirm, so part ${k}/${nParts} MAY exist: ` +
            `search Zoho Transfer Orders by Reason "${partReason(reason, k, nParts)}" before resuming.`)
        console.error(`create-to: split ${requestId ?? '(no requestId)'} → ${toDsId} stopped at part ${k}/${nParts}: ${r.error}`)
        return json({
          ok: false, partial: done.length > 0, partsTotal: nParts, failedPart: k, sure: r.sure,
          parts: done.map(({ toType: _t, ...d }) => d), skipped, zohoOrgId: org, error,
        }, 502)
      }

      const to = r.to
      const units = r.partResolved.reduce((a: number, l: any) => a + l.quantity_transfer, 0)
      // Skips that fall in THIS part only — the nightly digest maps skipped SKUs to
      // TO numbers, and a split must not attribute one SKU to every part.
      const partSkus = new Set(partLines.map((l: any) => l.sku.trim()))
      const partSkipped = multi ? skipped.filter((s) => partSkus.has(s.sku)) : skipped
      await audit({
        at: new Date().toISOString(), by, toDsId,
        lineCount: r.partResolved.length,
        units,
        // Only when something was actually dropped — an empty array on every entry
        // would be noise on a row the nightly digest reads. The digest names these
        // for the admin; the ground team only ever sees a count.
        ...(partSkipped.length ? { requested: multi ? partLines.length : skus.length, skipped: partSkipped } : {}),
        transfer_order_id: to.transfer_order_id,
        transfer_order_number: to.transfer_order_number,
        ...(multi ? { requestId, linesHash, part: k, parts: nParts } : {}),
      })
      done.push({ part: k, parts: nParts, transfer_order_id: to.transfer_order_id,
        transfer_order_number: to.transfer_order_number, lineCount: r.partResolved.length, units })
      for (const l of r.partResolved) { allResolved.push(l); skuPart.set(l.sku, k) }
      if (k === 1 || toTypeActual === null) toTypeActual = r.toTypeActual
      if (r.toTypeWarning) toTypeWarning = r.toTypeWarning
      console.log(`create-to: DRAFT ${to.transfer_order_number} → ${toDsId}` +
        (multi ? ` (part ${k}/${nParts})` : '') + `, ${r.partResolved.length} lines, by ${by}`)
    }
    resolved = allResolved
    const first = done[0]

    // ── Fill snapshot (additive params row; best-effort — same swallow-on-fail as
    // audit, so an analytics write can NEVER block a TO). The client computes it
    // from its full plan (only the client knows Req vs Actual and the shortfall);
    // we just persist it. Dedupe by (ds, batchKey) so re-generating the same DS in
    // a batch replaces its snapshot; keep the last SNAPSHOT_KEEP.
    // A split TO's snapshot is written ONCE, here, after every part exists — never
    // half a plan — with each SKU's part and every TO number (toSplit.ts).
    if (body.snapshot && typeof body.snapshot === 'object' && body.snapshot.ds === toDsId) {
      try {
        const { data: sRow } = await supabase.from('params').select('payload').eq('id', 'toSnapshots').maybeSingle()
        const prev = Array.isArray(sRow?.payload?.entries) ? sRow.payload.entries : []
        const snap = stampSnapshotParts(
          { ...body.snapshot, by, at: new Date().toISOString(), transfer_order_number: first.transfer_order_number },
          skuPart, done.map((d) => d.transfer_order_number))
        const kept = prev.filter((e: any) => !(e.ds === snap.ds && e.batchKey === snap.batchKey))
        kept.unshift(snap)
        await supabase.from('params').upsert({
          id: 'toSnapshots',
          payload: { entries: kept.slice(0, SNAPSHOT_KEEP) },
          updated_at: new Date().toISOString(),
        })
      } catch (e) { console.error('toSnapshots write failed (non-fatal):', e) }
    }

    console.log(`create-to: DONE ${done.map((d) => d.transfer_order_number).join(' + ')} → ${toDsId}, ` +
      `${resolved.length} of ${skus.length} lines, by ${by}, TO Type ${JSON.stringify(toTypeActual)}` +
      (skipped.length ? ` — SKIPPED ${skipped.length} inactive: ${skipped.map((s) => s.sku).join(', ')}` : ''))
    // toType/toTypeWarning are additive: the tool ignores unknown keys today (no
    // frontend change shipped with this), but they make the state inspectable.
    // Top-level transfer_order_* stay = part 1, so a caller that predates `parts`
    // still gets a valid TO and the right total `lines`.
    return json({
      ok: true,
      transfer_order_id: first.transfer_order_id,
      transfer_order_number: first.transfer_order_number,
      status: 'draft',
      toDsId,
      lines: resolved,
      zohoOrgId: org,
      // Always present so the tool can render "90 of 94" without inferring, and
      // `skipped` is always an array so a caller can read `.length` unguarded.
      requested: skus.length,
      skipped,
      toType: toTypeActual,
      ...(toTypeWarning ? { toTypeWarning } : {}),
      parts: done,
    })
  } catch (err) {
    console.error('create-to error:', err)
    return json({ ok: false, error: String(err) }, 500)
  }
})
