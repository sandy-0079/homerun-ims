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

export async function saveToSupabase(table, id, payload) {
  const { error } = await supabase
    .from(table)
    .upsert({ id, payload, updated_at: new Date().toISOString() })
  if (error) { console.error(`Supabase write error [${table}]`, error); return false }
  return true
}
