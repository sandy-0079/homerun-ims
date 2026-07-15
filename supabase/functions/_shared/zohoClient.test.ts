import { describe, it, expect, vi } from "vitest";
import { zohoFetchWithRetry } from "./zohoClient";

// A makeReq that returns a scripted sequence of HTTP statuses and records the
// token it was called with each time.
function scripted(statuses: number[]) {
  const tokensSeen: string[] = [];
  let i = 0;
  const makeReq = async (token: string) => {
    tokensSeen.push(token);
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return new Response(null, { status });
  };
  return { makeReq, tokensSeen, calls: () => i };
}

// Fake token source: getToken(false) → cached token, getToken(true) → a fresh one.
function fakeToken() {
  let fresh = 0;
  const forceHistory: boolean[] = [];
  const getToken = vi.fn(async (force: boolean) => {
    forceHistory.push(force);
    return force ? `fresh-${++fresh}` : fresh > 0 ? `fresh-${fresh}` : "cached";
  });
  return { getToken, forceHistory };
}

const noSleep = { sleep: async () => {} };

describe("zohoFetchWithRetry", () => {
  it("happy path: a 200 returns after a single fetch, no re-mint, no sleep", async () => {
    const s = scripted([200]);
    const t = fakeToken();
    const sleep = vi.fn(async () => {});
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, sleep });
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(1);
    expect(t.forceHistory).toEqual([false]); // one cache read, never forced
    expect(sleep).not.toHaveBeenCalled();
  });

  it("401 then 200: force-refreshes once and retries, returns 200", async () => {
    const s = scripted([401, 200]);
    const t = fakeToken();
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, ...noSleep });
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(2);
    expect(t.forceHistory.filter(Boolean)).toHaveLength(1); // exactly one force-refresh
    expect(s.tokensSeen[1]).toBe("fresh-1"); // retry used the fresh token
  });

  it("persistent 401: re-mints only once, then surfaces the 401 (no infinite loop)", async () => {
    const s = scripted([401, 401]);
    const t = fakeToken();
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, ...noSleep });
    expect(res.status).toBe(401); // a real auth failure is returned, not masked
    expect(s.calls()).toBe(2);
    expect(t.forceHistory.filter(Boolean)).toHaveLength(1);
  });

  it("429 then 200: backs off once and returns 200", async () => {
    const s = scripted([429, 200]);
    const t = fakeToken();
    const sleep = vi.fn(async () => {});
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, sleep });
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("429 exhausted: throws after maxAttempts with two back-offs (10s, 20s)", async () => {
    const s = scripted([429]);
    const t = fakeToken();
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    await expect(zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, sleep }))
      .rejects.toThrow(/429 after 3 attempts/);
    expect(s.calls()).toBe(3);
    expect(waits).toEqual([10_000, 20_000]);
  });

  it("retry429:false — a 429 is returned immediately (write path, never auto-repeated)", async () => {
    const s = scripted([429]);
    const t = fakeToken();
    const sleep = vi.fn(async () => {});
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, sleep, retry429: false });
    expect(res.status).toBe(429);
    expect(s.calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retry429:false still recovers a 401 (write path keeps 401 self-heal)", async () => {
    const s = scripted([401, 200]);
    const t = fakeToken();
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, ...noSleep, retry429: false });
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(2);
    expect(t.forceHistory.filter(Boolean)).toHaveLength(1);
  });

  it("mixed 401 then 429 then 200: re-mint does not consume a 429 attempt", async () => {
    const s = scripted([401, 429, 200]);
    const t = fakeToken();
    const sleep = vi.fn(async () => {});
    const res = await zohoFetchWithRetry({}, s.makeReq, { getToken: t.getToken, sleep });
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(3);
    expect(t.forceHistory.filter(Boolean)).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1); // the 429 still got its normal back-off
  });
});
