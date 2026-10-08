# Opening a store — the order, and what breaks if you change it

Durable runbook, distilled 2026-10-08 from the DS07/DS08 go-live (`docs/HANDOFF-2026-09-18-ds07-ds08.md`,
deleted once both stores' checks passed; in git history). Design reasoning:
`docs/superpowers/specs/2026-09-18-ds07-ds08-golive-design.md`.

**Shape:** wire the store early behind the gate (`openingDSList`), where it contributes nothing; go live
with one Apply. The wired-but-gated state is stable indefinitely, so **slipping the date costs nothing**
and doing a go-live step early is what costs. It worked twice with no engine code change on the day.

⚠ **Derive every expected value at check time; never copy one from this file or a past handoff.**
Each go-live here had a written-down expectation that was wrong ("Inv Value roughly flat" was +5.2%).
The scripts below derive from live data; add a check to them instead of a number to a doc.

---

## Before go-live (any day; all of it is inert behind the gate)

1. **Code:** the store goes into `DS_LIST` **and** `openingDSList`, along with its branch id and
   location name in the edge functions (`BRANCHES`, `DS_ONLY`). Deploy the functions (`sync-stock`,
   `sync-orders`, `sync-sku-floors`, `create-to`) outside the 14:30 / 20:30 IST TO windows. Use the
   Supabase CLI that reads the macOS Keychain (Homebrew); `npx supabase` fetches a different version
   with no credentials and fails `LegacyPlatformAuthRequiredError`.
2. **Its own stock cron slot, before the untick.** A new store gets a new `stock-sync-N` slot (a
   migration), never a third branch on an existing one (that 429s). **Add it to `SYNC_GROUPS`
   (`StockHealthTab.jsx`) and `PULL_GROUPS` (`homerun-to/src/sync.js`) in the same change, BEFORE
   the untick.** DS08's slot landed ~20 min after its untick, and for that time the TO tool judged a
   store its pull button could not refresh.
3. **Prove the branch is reachable by its DATA, not a timestamp.** Invoke `sync-stock` for the
   branch: an empty-but-wired store gains thousands of `stockData` keys, all zero. An unreachable
   branch gains none. A timestamp alone can't tell those apart (`supabase/functions/CLAUDE.md`).
4. **Floors sheet: add `DSxx Min` / `DSxx Max` columns.** The header must match
   `^(DS\d+|DC)\s+(Min|Max)$` (case-insensitive):
   - `DS8 Min` reads as an unknown store, and the nightly sync refuses the whole sheet. Loud and safe.
   - `DSxxMin`, `DSxx Minimum` or `DSxx-Min` match nothing, so the column is **silently ignored**
     with `ok=true`. This is the one to look for.
   - Fill cells on existing rows only. **A new SKU row flips that SKU's DC formula today, gate or
     no gate** (`isFlooredSKU` tests key presence; see `src/engine/CLAUDE.md`).
5. **Ceilings csv:** leave the new store's cells **blank** (no cap). **`0` caps it at zero.** That's
   the opposite of the floors sheet, where blank and 0 both mean "no floor" (`src/engine/CLAUDE.md`).
6. **Plywood capacity** in `params/networkConfigs`. Zero capacity means **no cap**, so an unset store
   over-allocates rather than reading 0/0. Read `networkConfigs`, never the orphan
   `params/global.dsCapacities` (root `CLAUDE.md`).
7. **Test-fire a 1-line draft TO into the new branch, then delete it.** A reachable branch only proves
   a READ; `create-to`'s write is a separate path and `dryRun` doesn't test it.
8. **Tell the PO team and the Fill Summary recipients** that their files gain the store's columns
   **on the flip day**. Both files are keyed on column **position**: the PO CSV gains `DSxx Min` /
   `DSxx Max` before `Purchase` / `Move`, and the Fill Summary (`homerun-to`) gains a column group.
   A stale sheet layout produces **wrong numbers, not an error**. **Don't give them a date in
   advance:** a sheet widened early breaks on the old file the same silent way. Tell them to discard
   any copy downloaded earlier that day; counting header fields is their self-check.

## Go-live day

9. **Pre-flight:** `node scripts/nightly-readback.mjs`. **Exit 2 = stop.** The one unrecoverable
   failure is a gated store carrying a non-zero target. Optionally take a before-reading with
   `node scripts/check-new-store.mjs DSxx`.
10. **One Apply, in this order:** upload the pincode remap (the diff must show **0 removed**; a
    short file silently un-maps pincodes) → untick the store → **edit `newDSList` explicitly** (a
    shallow merge means prod's list wins over defaults) → Apply & Re-run. **Never remap pincodes to
    a store that is still gated:** the donors give the demand away and the gated store can't claim it
    (`src/engine/CLAUDE.md`, Opening Shortly).
11. **Same day:** `node scripts/check-new-store.mjs DSxx`. Expect network Inv Value to **rise by about
    a store's worth of floors** (DS07 +5.2%, DS08 +4.9%; 0 donor cells changed both times). If the
    step needs explaining, replay inputs with and without the gate (`snapshot-engine-inputs.mjs` +
    `dump-engine-output.mjs`). Don't judge it by size. The store's first TO is huge (empty stock,
    `Req = Max` everywhere); `create-to` splits anything over Zoho's 800-line cap.

## After go-live

12. **First invoices:** the night after trading starts, `check-new-store.mjs` counts rows fulfilled
    by the store. `ds` is the first word of the Zoho `location_name` (`DS08 Rajajinagar` → `DS08`).
    Check also that no new unknown store name appears among invoice `ds` values.
13. **Floors, when ops fill them** (often deferred, letting the store run on attributed demand first):
    take a before-reading with `check-new-store.mjs`, then:
    - `npx vite-node scripts/dryrun-sku-floors.mjs`: `floors per DS` lists the store, GUARD
      `added` = 0 (or every added row is intended), `safe=true`.
    - After the next nightly, the store's ΣMin rises against the before-reading, and the DC rises by
      about a fifth of that (floored DC = Σ store Min × `skuFloorDCMultMin`, default 0.2).
    - Floors that don't bind at the store are expected for DC-only SKUs (Move = No, Inventorised-At =
      DC); the dry run lists them as ineffective.
