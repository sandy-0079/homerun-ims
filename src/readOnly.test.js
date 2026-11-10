import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const upsert = vi.fn(async () => ({ error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ upsert }) }),
}));

describe("VITE_READ_ONLY", () => {
  beforeEach(() => { vi.resetModules(); upsert.mockClear(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("blocks writes, records them and announces them", async () => {
    vi.stubEnv("VITE_READ_ONLY", "1");
    const events = [];
    globalThis.window = globalThis.window || new EventTarget();
    window.addEventListener("ims-readonly-write", e => events.push(e.detail));
    const m = await import("./supabase.js");
    const r = await m.saveToSupabase("params", "x", { a: 1 });
    expect(r).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
    expect(m.READ_ONLY).toBe(true);
    const b = m.blockedWrites();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ table: "params", id: "x" });
    expect(events).toEqual([{ table: "params", id: "x" }]);
  });

  it("writes normally when unset", async () => {
    vi.stubEnv("VITE_READ_ONLY", "");
    const m = await import("./supabase.js");
    expect(m.READ_ONLY).toBe(false);
    await m.saveToSupabase("params", "x", { a: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(m.blockedWrites()).toHaveLength(0);
  });
});
