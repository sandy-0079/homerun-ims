// Branch resolution for sync-stock. Pure (no Deno/remote imports) so vitest can run it.
//
// A non-empty `requested` array is filtered to known branch keys (unknown names dropped).
// Anything else (empty body, non-array) means "every branch" — EXCEPT those in `explicitOnly`,
// which are synced only when named. This keeps the empty-body path (Open Work #38) exactly
// what it was before HYDS01 existed.

export const EXPLICIT_ONLY: Set<string> = new Set(["HYDS01"]);

export function resolveBranches(
  requested: unknown,
  branches: Record<string, string>,
  explicitOnly: Set<string>,
): string[] {
  if (Array.isArray(requested) && requested.length > 0) {
    return requested.filter(
      (ds): ds is string => typeof ds === "string" && Object.prototype.hasOwnProperty.call(branches, ds),
    );
  }
  return Object.keys(branches).filter((k) => !explicitOnly.has(k));
}
