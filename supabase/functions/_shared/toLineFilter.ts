// Which TO lines may actually be sent to Zoho.
//
// ⚠⚠ WHY THIS EXISTS: Zoho refuses an ENTIRE transfer order if ANY line names an
// item that is inactive or deleted — `400: Transfer Order cannot be raised for
// item <name> that has been deleted or marked as inactive`. Nothing is created.
// On 2026-08-28 ops deactivated 334 SKUs mid-afternoon and the DC team could not
// raise a single TO until they reverted the flip in Zoho by hand.
//
// The engine already filters this: `buildToTargets` emits only SKUs whose master
// status is `active`. But `skuMaster` is a NIGHTLY copy, so a SKU deactivated
// during the day is still in today's targets. Our own catalogue is structurally
// incapable of seeing a same-day flip; only Zoho knows.
//
// ⚠ Zoho names ONE item per 400, so a "read the error, drop that item, retry"
// design costs one Zoho write attempt per bad SKU — four of them for four SKUs —
// and depends on parsing an English sentence for an item NAME (not even the SKU).
// Partitioning the whole set against fresh item statuses catches all of them in
// one pass and reads a field instead of a sentence.
//
// ⚠ A MISSING status is treated as ACTIVE (`unknown`), deliberately. This fails
// OPEN: the worst case is the behaviour we have today (Zoho 400s and the reactive
// path recovers), whereas failing closed would silently drop a good line on no
// evidence. It is also what makes deploying against an older cached item map a
// non-event — entries written before `status` existed simply read `unknown`.

export type ItemStatus = { name?: string; status?: string };
export type SkippedLine = { sku: string; name: string; status: string };

/** Zoho item statuses that can appear on a transfer order. */
export const isTransferable = (status: unknown): boolean =>
  String(status ?? "").trim().toLowerCase() === "active";

/**
 * Split requested SKUs into those Zoho will accept and those it will refuse.
 *
 * ⚠ `unknown` is counted as sendable, NOT skipped — see the fail-open note above.
 * It is returned separately so a caller can tell "we checked and it is fine" from
 * "we had no status to check", which are very different confidence levels.
 */
export function partitionInactive(
  skus: string[],
  map: Record<string, ItemStatus | undefined>,
): { send: string[]; skipped: SkippedLine[]; unknown: string[] } {
  const send: string[] = [], skipped: SkippedLine[] = [], unknown: string[] = [];
  for (const sku of skus || []) {
    const info = map?.[sku];
    // A SKU absent from the map is NOT this function's problem — the existing
    // badSkus check owns that, and it refuses rather than skips. Saying anything
    // about it here would give one fact two owners.
    if (!info || info.status === undefined || info.status === null || info.status === "") {
      send.push(sku);
      unknown.push(sku);
      continue;
    }
    if (isTransferable(info.status)) send.push(sku);
    else skipped.push({ sku, name: info.name || sku, status: String(info.status) });
  }
  return { send, skipped, unknown };
}

/**
 * Did a re-check against fresher data find anything new?
 *
 * ⚠ This is the whole retry condition, and it is deliberately NOT "was the error
 * about an inactive item". A Zoho 400 can equally be about numbering or
 * locations; those produce no new skips, so the retry never fires and the
 * original error is surfaced untouched. Self-limiting without reading the message.
 */
export function skipSetGrew(before: SkippedLine[], after: SkippedLine[]): boolean {
  const seen = new Set((before || []).map((s) => s.sku));
  return (after || []).some((s) => !seen.has(s.sku));
}
