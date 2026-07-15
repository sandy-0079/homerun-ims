import { describe, it, expect } from "vitest";
import { isTokenFresh } from "./tokenFreshness";

const NOW = 1_000_000_000_000;
const BUFFER = 10 * 60 * 1000; // 10 min

describe("isTokenFresh", () => {
  it("fresh when expiry is comfortably beyond the buffer", () => {
    expect(isTokenFresh({ access_token: "t", expiresAt: NOW + 30 * 60 * 1000 }, NOW, BUFFER)).toBe(true);
  });

  it("stale when expiry is within the buffer (refresh early)", () => {
    expect(isTokenFresh({ access_token: "t", expiresAt: NOW + 5 * 60 * 1000 }, NOW, BUFFER)).toBe(false);
  });

  it("stale exactly at the buffer edge (strict >)", () => {
    expect(isTokenFresh({ access_token: "t", expiresAt: NOW + BUFFER }, NOW, BUFFER)).toBe(false);
  });

  it("stale when already expired", () => {
    expect(isTokenFresh({ access_token: "t", expiresAt: NOW - 1 }, NOW, BUFFER)).toBe(false);
  });

  it("stale when access_token missing or empty", () => {
    expect(isTokenFresh({ expiresAt: NOW + 30 * 60 * 1000 }, NOW, BUFFER)).toBe(false);
    expect(isTokenFresh({ access_token: "", expiresAt: NOW + 30 * 60 * 1000 }, NOW, BUFFER)).toBe(false);
  });

  it("stale when expiresAt missing or non-numeric", () => {
    expect(isTokenFresh({ access_token: "t" }, NOW, BUFFER)).toBe(false);
    expect(isTokenFresh({ access_token: "t", expiresAt: "soon" as unknown as number }, NOW, BUFFER)).toBe(false);
  });

  it("stale on null/undefined payload (fail-safe → caller refreshes)", () => {
    expect(isTokenFresh(null, NOW, BUFFER)).toBe(false);
    expect(isTokenFresh(undefined, NOW, BUFFER)).toBe(false);
  });
});
