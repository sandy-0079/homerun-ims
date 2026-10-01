// Splitting one DS's transfer into several Zoho TOs when it has too many lines.
//
// ⚠⚠ WHY THIS EXISTS: Zoho refuses a transfer order whose line_items array is too
// long — `400: Looks like the key line_items has exceeded the size. Please check
// and try again.` Nothing is created. Hit for the first time on 2026-09-30, when a
// Min/Max re-apply raised the DS07/DS08 floors and DS07's TO came to 1,258 lines.
// Zoho documents no number. Evidence from params/toAudit: 827 lines created
// (TO-06589), 822 (TO-06797); 1,258 refused. So the real cap sits in 828–1,257.
//
// TO_LINE_CAP = 800 is the largest size PROVEN to work, not a guess at Zoho's
// limit. Raise it only on evidence of a bigger successful create.
//
// ⚠ PARTS ARE CUT FROM THE REQUESTED LINES, BEFORE THE INACTIVE-SKU DROP — not from
// what is finally sent. That is what makes a resume safe: the same request body
// always yields the same parts, so "part 2" means the same SKUs on the retry as it
// did on the first attempt, even if the item map was refreshed in between and the
// skip set changed. Cutting after the drop would shift the boundary and a resumed
// part 2 could repeat or omit lines that sit in the already-created part 1.
// The cost: a part can come out a few lines smaller than its sibling. Harmless.
//
// ⚠ Parts are CONTIGUOUS slices in the order the caller sent, which is the DC01
// pick path (homerun-to/src/ordering.js). Each TO is one unbroken stretch of the
// walk, and part 1 always opens with the heavy unbinned sacks that load first.

export const TO_LINE_CAP = 800;

/**
 * Balanced contiguous parts: ceil(n / cap) parts, sizes differing by at most one,
 * larger parts first. 1,258 → [629, 629]; 1,601 → [534, 534, 533]; ≤ cap → one part.
 */
export function splitParts<T>(lines: T[], cap = TO_LINE_CAP): T[][] {
  const n = lines?.length ?? 0;
  if (n === 0) return [];
  const count = Math.ceil(n / cap);
  const base = Math.floor(n / count), extra = n % count;
  const parts: T[][] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < extra ? 1 : 0);
    parts.push(lines.slice(at, at + size));
    at += size;
  }
  return parts;
}

/**
 * The text that leads the Zoho "Reason" (the API `description`). A single TO keeps
 * exactly today's reason — no "1/1" — so an unsplit TO is byte-identical to before.
 *   ("Internal Transfer", 1, 2)             → "Internal Transfer 1/2"
 *   ("Internal Transfer - TEST TO", 2, 2)   → "Internal Transfer - TEST TO 2/2"
 */
export function partReason(reason: string, part: number, parts: number): string {
  return parts > 1 ? `${reason} ${part}/${parts}` : reason;
}

/**
 * Order-sensitive fingerprint of the requested lines (FNV-1a, 32-bit, hex). Not a
 * security property — it only has to notice that a resume is NOT the same request
 * (stock reloaded, quantities moved), so a part created from the old lines is never
 * stitched together with parts cut from new ones.
 */
export function linesFingerprint(lines: { sku: string; qty: number }[]): string {
  let h = 0x811c9dc5;
  const s = (lines || []).map((l) => `${String(l.sku).trim()}:${l.qty}`).join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type CreatedPart = {
  part: number; parts: number;
  transfer_order_id: string; transfer_order_number: string;
  lineCount: number; units: number;
};

/**
 * Parts of THIS request that already exist in Zoho, read from params/toAudit.
 *
 * ⚠ Only a confirmed create is ever written to the audit, so a part found here
 * definitely exists. A part whose POST got no reply (timeout, 5xx) is NOT here —
 * it may or may not exist, and that is surfaced to a human, never guessed.
 *
 * `mismatch` = the requestId was seen with DIFFERENT lines or a different part
 * count. The caller must refuse to resume rather than mix the two.
 */
export function findCreatedParts(
  auditEntries: unknown, requestId: string | undefined, fingerprint: string, parts: number,
): { created: Map<number, CreatedPart>; mismatch: boolean } {
  const created = new Map<number, CreatedPart>();
  if (!requestId || !Array.isArray(auditEntries)) return { created, mismatch: false };
  let mismatch = false;
  for (const e of auditEntries as any[]) {
    if (e?.requestId !== requestId) continue;
    if (e.linesHash !== fingerprint || e.parts !== parts) { mismatch = true; continue; }
    const p = Number(e.part);
    if (!Number.isInteger(p) || p < 1 || p > parts || created.has(p)) continue;
    created.set(p, {
      part: p, parts,
      transfer_order_id: String(e.transfer_order_id),
      transfer_order_number: String(e.transfer_order_number),
      lineCount: Number(e.lineCount) || 0,
      units: Number(e.units) || 0,
    });
  }
  return { created, mismatch };
}

/**
 * Stamp each snapshot SKU row with the part it travelled on, and the snapshot with
 * every TO number. ONLY when there is more than one part — a single TO's snapshot
 * stays exactly the shape it has always been.
 *
 * Rows for SKUs that were not sent (TO Qty 0) get no `toPart`; the Fill Summary CSV
 * prints the first TO's number for those, which keeps "DSxx TO No" non-blank.
 */
export function stampSnapshotParts(
  snapshot: Record<string, any>, skuPart: Map<string, number>, numbers: string[],
): Record<string, any> {
  if (numbers.length <= 1) return snapshot;
  const skus = Array.isArray(snapshot.skus)
    ? snapshot.skus.map((r: any) => {
        const p = skuPart.get(String(r?.sku ?? "").trim());
        return p ? { ...r, toPart: p } : r;
      })
    : snapshot.skus;
  return { ...snapshot, skus, transfer_order_numbers: numbers };
}
