import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// maybeSingle, not single: `single()` makes PostgREST return HTTP 406 when the
// row is absent, which logs a red console error on every page load for rows that
// legitimately may not exist yet (e.g. params/pincodeMap before it is first saved).
// Callers already treat null as "not configured", so the return value is unchanged.
export async function loadFromSupabase(table, id) {
  const { data, error } = await supabase
    .from(table)
    .select('payload')
    .eq('id', id)
    .maybeSingle()
  if (error) return null
  return data?.payload ?? null
}

// Reads ONE key out of a payload without transferring the rest.
//
// ⚠ Use this for anything that only needs a scalar out of a big row. `params/toTargets`
// is ~693KB; `select=payload->refreshedAt` returns 44 bytes — a 15,750x saving on a
// read that happens on every page load for every user. Same pattern the TO tool uses
// for `payload->stockUploadedAtPerDS`.
export async function loadPayloadKey(table, id, key) {
  const { data, error } = await supabase
    .from(table)
    .select(`payload->${key}`)
    .eq('id', id)
    .maybeSingle()
  if (error) return null
  return data?.[key] ?? null
}

// Local-testing guard: VITE_READ_ONLY=1 turns every browser write into a recorded no-op,
// so `npm run dev` against the production project cannot change it.
export const READ_ONLY = import.meta.env.VITE_READ_ONLY === '1'
const _blocked = []
export function blockedWrites() { return _blocked }

export async function saveToSupabase(table, id, payload) {
  if (READ_ONLY) {
    _blocked.push({ table, id, at: new Date().toISOString() })
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('ims-readonly-write', { detail: { table, id } }))
    }
    return true
  }
  const { error } = await supabase
    .from(table)
    .upsert({ id, payload, updated_at: new Date().toISOString() })
  if (error) { console.error(`Supabase write error [${table}]`, error); return false }
  return true
}
