import { getZohoToken } from "./zohoToken.ts";

// Single source of truth for calling a Zoho API with the shared cached token and
// recovering from the two transient failures we actually see in prod:
//
//   401 — the cached token was valid when cached but Zoho revoked it before its
//         stored expiry (concurrent-token eviction). getZohoToken can't detect
//         this; only the Zoho call sees the 401. We force-refresh ONCE (which
//         writes the fresh token back to the shared cache, healing it for every
//         other function — crons included) and retry. A SECOND 401 is a real
//         auth failure (e.g. a revoked refresh_token) and is returned as-is so
//         the caller surfaces it — we never mask a genuine outage.
//         (Root cause of the 2026-07-15 TO 401 incident.)
//
//   429 — Zoho rate limit. Back off and retry (mirrors sync-stock's long-standing
//         behaviour: up to `maxAttempts`, 10s then 20s). Idempotent reads only —
//         callers that create/delete pass { retry429: false } so a write is never
//         auto-repeated.
//
// The happy path is unchanged: a 200 (or any non-401/429 status) returns after a
// single fetch, exactly as before this helper existed.

export type ZohoRetryOpts = {
  retry429?: boolean;
  maxAttempts?: number;
  // Injectable for unit tests; production uses the real getZohoToken / setTimeout.
  getToken?: (forceRefresh: boolean) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
};

export async function zohoFetchWithRetry(
  supabase: any,
  makeReq: (token: string) => Promise<Response>,
  opts: ZohoRetryOpts = {},
): Promise<Response> {
  const retry429 = opts.retry429 ?? true;
  const maxAttempts = opts.maxAttempts ?? 3;
  const getToken = opts.getToken ?? ((force: boolean) => getZohoToken(supabase, force));
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let reminted = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getToken(false); // cache hit (fresh, after any re-mint writes back)
    const res = await makeReq(token);

    if (res.status === 401 && !reminted) {
      reminted = true;
      console.warn("zoho: 401 — force-refreshing token and retrying once");
      await getToken(true); // re-mint + write-back to the shared cache
      attempt--; // the re-mint retry is free — it must not consume a 429 attempt
      continue;
    }

    if (res.status !== 429 || !retry429) return res;

    if (attempt < maxAttempts) {
      const wait = attempt * 10_000;
      console.warn(`zoho: 429 (attempt ${attempt}/${maxAttempts}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error(`Zoho API: 429 after ${maxAttempts} attempts`);
}
