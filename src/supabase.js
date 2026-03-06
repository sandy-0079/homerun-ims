import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export async function loadFromSupabase(table, id) {
  const { data, error } = await supabase
    .from(table)
    .select('payload')
    .eq('id', id)
    .single()
  if (error) return null
  return data.payload
}

export async function saveToSupabase(table, id, payload) {
  const { error } = await supabase
    .from(table)
    .upsert({ id, payload, updated_at: new Date().toISOString() })
  if (error) { console.error(`Supabase write error [${table}]`, error); return false }
  return true
}
