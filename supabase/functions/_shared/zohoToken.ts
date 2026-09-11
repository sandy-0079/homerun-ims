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

export type TokenPayload = { access_token: string; expiresAt: number };

// Injectable mint, for unit tests only. Production always uses refreshFromZoho.
export type TokenOpts = { refresh?: () => Promise<TokenPayload> };

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

// ── Mint singleflight ────────────────────────────────────────────────────────
// sync-stock fans 4 paginated branch fetches out under Promise.all, and
// zohoFetchWithRetry's `reminted` guard is PER PAGE. So when the shared token is
// revoked mid-run, every in-flight page 401s at once and each one force-refreshes
// independently: 2026-09-11 08:38 UTC logged ×16 "401 — force-refreshing" for a
// single dead token, which tripped Zoho's token-endpoint throttle ("You have made
// too many requests continuously") and 500'd the whole invocation — losing that
// cron cycle's stock for DS02+DS03. Minting N tokens to replace one is also
// self-defeating: Zoho evicts older access tokens once too many are live, so the
// stampede can invalidate the very tokens its siblings are still using.
//
// One mint per dead token. Concurrent callers join the in-flight promise and all
// receive the same fresh token.
//
// ⚠ The slot MUST be cleared on rejection as well as resolution: module state
// outlives a single request in a warm edge isolate, so a retained failed mint
// would be replayed to every later caller in that isolate.
let inflight: Promise<TokenPayload> | null = null;

function mintOnce(supabase: any, refresh: () => Promise<TokenPayload>): Promise<TokenPayload> {
  if (inflight) return inflight;

  const p = (async () => {
    const fresh = await refresh();
    // Best-effort write-back (a failed write just means the next caller refreshes
    // again — still far below the old per-invocation rate). Inside the singleflight
    // so N joiners produce one upsert, not N.
    try {
      await supabase.from("zoho_auth_cache").upsert({
        id: CACHE_ID, payload: fresh, updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error("zoho token: cache write failed (non-fatal):", e);
    }
    return fresh;
  })();

  inflight = p;
  const clear = () => { if (inflight === p) inflight = null; };
  p.then(clear, clear); // both handlers return undefined → no unhandled rejection
  return p;
}

// `forceRefresh` skips the cache entirely and mints a new token, overwriting the
// cached one. Callers pass it after a downstream Zoho 401: the stored `expiresAt`
// is only a prediction, and Zoho can revoke a token before then (concurrent-token
// eviction), so a cache hit can still be a dead token. Only the Zoho call sees the
// 401 — the caller re-mints and retries once. (Root cause of the 2026-07-15 TO 401s.)
//
// ⚠ forceRefresh must NEVER fall back to the cached token, however fresh its
// expiresAt looks — that is precisely the 2026-07-15 failure (create-to's
// POST /transferorders 401'd on a cached-but-revoked token and the team was
// blocked). The singleflight below changes only HOW MANY callers mint, never
// WHETHER a forced caller mints.
export async function getZohoToken(
  supabase: any,
  forceRefresh = false,
  opts: TokenOpts = {},
): Promise<string> {
  const refresh = opts.refresh ?? refreshFromZoho;

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

  // 2. Mint — deduped across concurrent callers — then hand back the token.
  const joined = inflight !== null;
  const fresh = await mintOnce(supabase, refresh);
  console.log(
    joined ? "zoho token: joined in-flight mint"
      : forceRefresh ? "zoho token: force-refreshed (after 401)"
      : "zoho token: refreshed",
  );
  return fresh.access_token;
}
