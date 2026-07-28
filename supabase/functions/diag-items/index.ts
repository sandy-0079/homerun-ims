import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getZohoToken } from '../_shared/zohoToken.ts'

// ─── TEMPORARY DIAGNOSTIC — DELETE AFTER USE ─────────────────────────────────
// Read-only: fetches a few Zoho items (list endpoint, page 1) and returns their
// custom-field structure so we can confirm whether the `DC01 Rampura` bin comes
// back on the /items LIST response (vs needing per-item detail), and its exact
// api_name. Touches nothing: no writes, no other function, no prod data.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const token = await getZohoToken(supabase)
    const org = Deno.env.get('ZOHO_ORG_ID')
    const res = await fetch(
      `https://www.zohoapis.in/inventory/v1/items?organization_id=${org}&per_page=5&page=1`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    )
    const data = await res.json()
    const items = (data.items ?? []).map((it: any) => ({
      sku: it.sku,
      name: it.name,
      has_custom_fields_array: Array.isArray(it.custom_fields),
      custom_fields: (it.custom_fields ?? []).map((f: any) => ({
        api_name: f.api_name, label: f.label, value: f.value,
      })),
      has_custom_field_hash: !!it.custom_field_hash,
      custom_field_hash: it.custom_field_hash ?? null,
    }))
    return new Response(
      JSON.stringify({ ok: true, zoho_status: res.status, sample: items.length, items }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
