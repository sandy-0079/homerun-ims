// Pure helper (no imports) so it is unit-testable with vitest outside Deno.
//
// A cached Zoho token counts as "fresh" only if it has a non-empty access_token
// and its expiry is more than `bufferMs` in the future. The buffer makes us
// refresh a little early, so we never hand back a token that expires mid-request.
export function isTokenFresh(
  payload: { access_token?: string; expiresAt?: number } | null | undefined,
  nowMs: number,
  bufferMs: number,
): boolean {
  return (
    !!payload &&
    typeof payload.access_token === "string" &&
    payload.access_token.length > 0 &&
    typeof payload.expiresAt === "number" &&
    payload.expiresAt - nowMs > bufferMs
  );
}
