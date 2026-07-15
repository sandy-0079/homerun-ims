import { isTokenFresh } from "./tokenFreshness.ts";

// Shared Zoho access-token accessor with a service-role-only DB cache
// (public.zoho_auth_cache, RLS-locked — see migration 20260715000001).
//
// Reuses a cached token until ~10 min before expiry so the OAuth token endpoint
// (accounts.zoho.in) isn't hit on every invocation (sync-stock, sync-orders,
// create-to). This is what keeps the TO tool's on-demand TO creation from
// starving the sync crons at Zoho's auth throttle.
//
// FAIL-SAFE BY CONSTRUCTION: every failure path (cache table missing, read
// error, expired token, write error) falls back to a fresh refresh_token grant
// — i.e. exactly the pre-cache behaviour. This can only improve on the old code,
// never regress below it.

const CACHE_ID = "zoho";
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh when <10 min to expiry

type TokenPayload = { access_token: string; expiresAt: number };

async function refreshFromZoho(): Promise<TokenPayload> {
  const res = await fetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
      client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho auth failed: ${JSON.stringify(data)}`);
  const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
  return { access_token: data.access_token, expiresAt: Date.now() + expiresInMs };
}

// `forceRefresh` skips the cache entirely and mints a new token, overwriting the
// cached one. Callers pass it after a downstream Zoho 401: the stored `expiresAt`
// is only a prediction, and Zoho can revoke a token before then (concurrent-token
// eviction), so a cache hit can still be a dead token. Only the Zoho call sees the
// 401 — the caller re-mints and retries once. (Root cause of the 2026-07-15 TO 401s.)
export async function getZohoToken(supabase: any, forceRefresh = false): Promise<string> {
  // 1. Try the shared cache (unless the caller is recovering from a 401).
  if (!forceRefresh) {
    try {
      const { data } = await supabase
        .from("zoho_auth_cache").select("payload").eq("id", CACHE_ID).maybeSingle();
      if (data?.payload && isTokenFresh(data.payload, Date.now(), REFRESH_BUFFER_MS)) {
        console.log("zoho token: cache hit");
        return data.payload.access_token;
      }
    } catch (e) {
      console.error("zoho token: cache read failed (falling back to refresh):", e);
    }
  }

  // 2. Refresh, then best-effort write-back (a failed write just means the next
  //    caller refreshes again — still far below the old per-invocation rate).
  const fresh = await refreshFromZoho();
  console.log(forceRefresh ? "zoho token: force-refreshed (after 401)" : "zoho token: refreshed");
  try {
    await supabase.from("zoho_auth_cache").upsert({
      id: CACHE_ID, payload: fresh, updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("zoho token: cache write failed (non-fatal):", e);
  }
  return fresh.access_token;
}
