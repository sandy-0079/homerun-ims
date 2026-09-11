import { describe, it, expect } from "vitest";
import { getZohoToken, type TokenPayload } from "./zohoToken";

const HOUR = 60 * 60 * 1000;
const tok = (t: string): TokenPayload => ({ access_token: t, expiresAt: Date.now() + HOUR });

// Minimal stand-in for the supabase client: only the two calls zohoToken makes.
function fakeSupabase(cached: TokenPayload | null = null) {
  const writes: any[] = [];
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: cached ? { payload: cached } : null }),
    upsert: async (row: any) => { writes.push(row); return { error: null }; },
  };
  return { writes, from: () => chain };
}

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("getZohoToken — mint singleflight", () => {
  // THE BUG: sync-stock runs 4 paginated chains under Promise.all. When the shared
  // token dies, every in-flight page 401s at once and each force-refreshes
  // independently — 16 mints for one dead token, which trips Zoho's token-endpoint
  // throttle ("too many requests continuously") and 500s the whole invocation.
  it("collapses concurrent force-refreshes into exactly one mint", async () => {
    const d = deferred<TokenPayload>();
    let mints = 0;
    const refresh = () => { mints++; return d.promise; };
    const sb = fakeSupabase();

    const all = Promise.all([
      getZohoToken(sb, true, { refresh }),
      getZohoToken(sb, true, { refresh }),
      getZohoToken(sb, true, { refresh }),
    ]);
    d.resolve(tok("fresh-1"));

    expect(await all).toEqual(["fresh-1", "fresh-1", "fresh-1"]);
    expect(mints).toBe(1);
  });

  it("collapses concurrent cache-miss mints into exactly one mint", async () => {
    const d = deferred<TokenPayload>();
    let mints = 0;
    const refresh = () => { mints++; return d.promise; };
    const sb = fakeSupabase(null); // empty cache → every caller falls through to mint

    const all = Promise.all([
      getZohoToken(sb, false, { refresh }),
      getZohoToken(sb, false, { refresh }),
    ]);
    d.resolve(tok("fresh-1"));

    expect(await all).toEqual(["fresh-1", "fresh-1"]);
    expect(mints).toBe(1);
  });

  it("writes the minted token back to the shared cache exactly once", async () => {
    let mints = 0;
    const refresh = async () => { mints++; return tok(`fresh-${mints}`); };
    const sb = fakeSupabase();

    await Promise.all([
      getZohoToken(sb, true, { refresh }),
      getZohoToken(sb, true, { refresh }),
    ]);

    expect(sb.writes).toHaveLength(1);
    expect(sb.writes[0].payload.access_token).toBe("fresh-1");
  });
});

describe("getZohoToken — behaviour that must NOT regress", () => {
  // REGRESSION GUARD for the 2026-07-15 incident (commit aae5e85): create-to's
  // POST /transferorders got a 401 from a cached-but-revoked token and hard-failed
  // ("Couldn't create the TO", team blocked). forceRefresh must always mint —
  // never hand back the cached token, however fresh its expiresAt looks.
  it("forceRefresh mints even when the cached token still looks fresh", async () => {
    let mints = 0;
    const refresh = async () => { mints++; return tok(`fresh-${mints}`); };
    const sb = fakeSupabase(tok("dead-but-unexpired"));

    expect(await getZohoToken(sb, true, { refresh })).toBe("fresh-1");
    expect(mints).toBe(1);
  });

  it("a fresh cached token is served without minting", async () => {
    let mints = 0;
    const refresh = async () => { mints++; return tok("should-not-happen"); };
    const sb = fakeSupabase(tok("cached"));

    expect(await getZohoToken(sb, false, { refresh })).toBe("cached");
    expect(mints).toBe(0);
  });

  // The hazard the singleflight itself introduces: module state lives as long as a
  // warm edge isolate, so a rejected mint left in the slot would be replayed to
  // every later caller in that isolate.
  it("a failed mint is not cached — the next caller mints again", async () => {
    let mints = 0;
    const refresh = async () => {
      mints++;
      if (mints === 1) throw new Error("Zoho auth failed: throttled");
      return tok(`fresh-${mints}`);
    };
    const sb = fakeSupabase();

    await expect(getZohoToken(sb, true, { refresh })).rejects.toThrow("throttled");
    expect(await getZohoToken(sb, true, { refresh })).toBe("fresh-2");
    expect(mints).toBe(2);
  });

  it("concurrent callers share one failed mint, and the slot still clears", async () => {
    const d = deferred<TokenPayload>();
    let mints = 0;
    const refresh = () => { mints++; return d.promise; };
    const sb = fakeSupabase();

    const a = getZohoToken(sb, true, { refresh });
    const b = getZohoToken(sb, true, { refresh });
    d.reject(new Error("Zoho auth failed: throttled"));

    await expect(a).rejects.toThrow("throttled");
    await expect(b).rejects.toThrow("throttled");
    expect(mints).toBe(1);

    const refresh2 = async () => tok("fresh-after-failure");
    expect(await getZohoToken(sb, true, { refresh: refresh2 })).toBe("fresh-after-failure");
  });
});
