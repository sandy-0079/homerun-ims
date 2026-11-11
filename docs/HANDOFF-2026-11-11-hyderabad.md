# Handover: Hyderabad (HYDS01 Pati), 2026-11-11

> Resume from here. This doc is the single entry point for the remaining Hyderabad work. It
> summarises; the authoritative design is the spec (`docs/superpowers/specs/2026-11-10-hyderabad-hyds01-design.md`,
> §1–§9). The follow-up list is in `docs/OPEN-WORK.md` #45.

## 0. The rule that outranks everything

**Bangalore is in production and used daily by several teams. Nothing in the Hyderabad work may change
Bangalore's behaviour, data or screens.** Every step below either touches only Hyderabad rows/code or
comes with a proof that Bangalore is unchanged. When in doubt, measure (snapshot → dump → diff) and ask
the operator before any prod write, deploy, cron change or push. Respect the TO windows (14:30 and 20:30 IST,
±30 min), the stock-sync minutes (:35–:50 every hour) and the nightly chain (21:55–06:30 IST).

## 1. Where things stand (end of 2026-11-11)

| piece | state |
|---|---|
| Frontend + `api/run-engine.js` (Hyderabad screens, Bangalore filter) | **LIVE.** Pushed `main` at 13:17 IST; Vercel prod `homerun-ims.vercel.app`, commit `8d4ea27` |
| Bangalore engine | One change: `runEngine` drops `HYDS01` rows before attribution. Measured 1/29,421 cells moved (**HVS7M DC 7/10 → 8/11**, a DC-only SKU whose Pati sale was skewing it). **Operator approved this 2026-11-11** |
| Nightly engine (tonight) | Dry run of the deployed endpoint at ~13:30 IST: **Inv Value identical** to this morning's live run (Min ₹98,653,271 / Max ₹122,725,566), **2,831 targets, 0 added / 0 removed** |
| `sync-stock` with HYDS01 | **Code on `main`, NOT deployed.** `BRANCHES.HYDS01 = 3915979000169622634`, explicit-only (`supabase/functions/_shared/stockBranches.ts`), so the empty-body default stays the old 9 branches |
| Cron for Pati stock | **Staged, NOT applied:** `supabase/staged/stock_sync_5_add_hyds01.sql` (DS08 → DS08 + HYDS01) |
| Hyderabad data rows | **None written yet.** Hyderabad runs on Bangalore-copied defaults, floors-only, no floors → every Pati target 0/0 until the first real floor upload |
| `sync-orders` HYDS01 mapping (open POs in Pati's Stock Health) | Not done (optional) |
| Worktree `../homerun-ims-hyd` + branch `hyderabad-hyds01` | **Removed 2026-11-11** after the merge (no other local or remote branches remain) |
| This handover doc | Committed locally on `main`, **not pushed** (a push triggers a Vercel redeploy of identical code; not done at 14:10 IST, inside the 14:30 TO buffer). Push it outside the TO windows, or with the next real change |

## 2. Key facts (do not re-derive)

- **Zoho location `HYDS01 Pati`**, id **`3915979000169622634`**, parent **HomeRun Hyderabad** (GSTIN 36AAICH7192R1ZM). It was briefly `DS01 Pati`. Same Zoho org, same catalogue and SKU codes, its own invoices. Live since 2026-11-06. **No DC**: vendors deliver to Pati, and Pati ships orders.
- The invoice sync already stores Pati rows as `ds:"HYDS01"` (first word of the location name, `invoiceMap.ts dsOf`). 17 rows as of 2026-11-10.
- **Store universe:** `DS_LIST` (Bangalore) is unchanged. `HYD_DS_LIST = ["HYDS01"]`, `cityOf`, `dropHydRows` and `hydRowsOnly` live in `src/city.js`. `cityOf` is a **deny-list** (only HYDS01 is Hyderabad; `DC01`/`HOMERUN`/unknown stay Bangalore).
- **Hyderabad engine** (`src/hyd/hydEngine.js`) is the **unmodified** `runEngine`, fed Pati rows relabelled `DS01` plus zero-qty `__HYD_WINDOW_PAD__` rows so its window equals the network window. It uses a neutralised master clone and a plywood config with only a DS01 node and no DC. It reads `stores.DS01` back as HYDS01, then runs the Hyderabad pass:
  - engine → lead-time buffer (`brandLeadTimeDays`) + 3-day order cycle
  - → floor lift
  - → flags (the floor sheet beats Purchase=OFF / Supplier / Dead Stock; engine-only SKUs follow them)
  - → inactive-in-Zoho = 0/0
  - → **floors-only switch** (default ON; missing/unreadable = floors-only).
- **The Hyderabad engine is browser-only.** The nightly computes nothing for Hyderabad and writes nothing new.
- **Hyderabad rows (new, owned by the browser only):** `team_data/hyd_inputs` (`{floors, uploadedAt}`), `params/hydGlobal` (settings copy + `floorsOnly` + `orderCycleDays`), `params/hydPlywoodNetworkConfig`, `params/hydNetworkConfigs`. Written only through `src/hyd/hydStore.js`. `team_data/global` and `BROWSER_OWNED_KEYS` gain nothing.
- **Shared screens:** Hyderabad renders Bangalore's own components with a store list:
  - `OverviewTab` and `SKUDetailTab` are exported from `App.jsx` and passed into `HydShell`.
  - `src/tabs/ToolOutputTab.jsx`, `LogicTweakerTab.jsx` and `UploadDataTab.jsx` were extracted by pure move.
  - `StockHealthTab` takes optional props.
  - **Bangalore call sites pass no new props; every new prop defaults to today's behaviour.**
  - The Plywood tab is Hyderabad's own panel (`src/tabs/hyd/HydPlywoodPanel.jsx`).
- **Local testing against prod data:** `VITE_READ_ONLY=1 npm run dev -- --port 5174` blocks every write, shows a red banner with a blocked-write count, and still lets the UI behave as if saves succeeded (in memory only; reload discards).
- **Hyderabad PO CSV (frozen header):** `Item Name, Inventorised At, SKU, Category, Brand, Status, HYDS01 Min, HYDS01 Max, Purchase`. The filename is `PO_Hyderabad_<YYYY-MM-DD>.csv`. `Purchase` is Hyderabad's **effective** decision (`hydPurchaseOf`):
  - inactive → No
  - floor row → Yes
  - floors-only and no floor → No
  - else Zoho's value.
- **Hyderabad floor sheet:** `SKU, Item Name, Category, HYDS01 Min, HYDS01 Max`. It must be whole numbers; blank = 0; Max is raised to Min; last row wins; 0/0 = out of range. **Bangalore `DSxx`/`DC` columns are refused.** The sheet defines Pati's range while floors-only.

## 3. Decisions log (the operator's; don't relitigate)

- The stored key is `HYDS01` (matches Zoho). The city switch is a **`BLR | HYD` toggle right after the HomeRun logo**: the selected city is filled, the other muted. Header tint: Bangalore cream `#FFF8DC`, Hyderabad blue `#E6F0FA`.
- Launch is **floors-only**. Pati's range = the Hyderabad floor sheet. **One switch per store, all categories incl. plywood**, flipped by an admin (~3 weeks after launch).
  - **After the flip it's Bangalore rules:** every active SKU gets a target from Pati's own sales, floors lift, and demand can add a SKU to the range.
- **Floors are final:** the category team bakes lead time into them, and IMS adds the buffer only to engine numbers.
- **Inactive in Zoho = 0/0 even with a floor.** Otherwise the Hyderabad floor sheet beats Bangalore-origin flags.
- Settings: Hyderabad gets its **own copy** of Bangalore's (frozen at first save; "Reset to Bangalore's current values" available). Bangalore-network sections are hidden in the Hyderabad Logic Tweaker. Brand Lead Time is shown (it drives Pati's buffer).
- **Plywood:**
  - all four network brands (GreenPly, CenturyPly, ArchidPly, Action Tesa) use the plywood logic at Pati;
  - **Virgo (and any other plywood brand) uses the regular PCT rule**;
  - the brand toggles were removed;
  - Pati capacity is 300 thick / 150 thin;
  - the DC term is dropped.
- **Separate Hyderabad PO CSV** (honest headers, targets only, same format as Bangalore). **Separate Hyderabad floor sheet**, uploaded by hand for now.
- **Stock sync:** Pati joins **DS08 in `stock-sync-5`** (two branches is normal; never three).
- **The "fix your floor sheet" lists live on the Hyderabad floors card in Upload Data:**
  - sold at Pati with no floor, with **⬇ Download as floor template**;
  - inactive in Zoho;
  - overriding Bangalore flags;
  - not in the catalogue.
- **The TO tool is untouched** (verified read-only: it reads `params/toTargets`, which stays Bangalore-only).
- The Hyderabad PO uses Bangalore's freshness gate. Zero Sale is hidden in Hyderabad. A failed Hyderabad read disables every Hyderabad download and save.
- **Approved 2026-11-11:** the HVS7M DC cell moving 7/10 → 8/11.

## 4. Remaining work, in order

### Step A: morning checks (2026-11-12, after the 06:30 IST digest)

Read-only. If any check fails, stop and investigate before Step B.

1. **The digest email** (06:30 IST) is all green.
   - Invoice demand: "published through 2026-11-11".
   - Inv Value (Max) within about ±₹0.01 Cr of 2026-11-11, and the move explained (the HVS7M cell is ~+₹0.0006 Cr; normal daily drift also applies).
   - `targets` count ≈ 2,831 with no mass add/remove.
2. **`params/engineRunStatus`**: `.at` is the 06:15 IST slot, `ok:true`, and `engineCommit` is `8d4ea27…` (or later). This is the nightly's own single-writer field; **don't assert on `toTargets.refreshedAt`**, since any browser Apply overwrites it.
3. **`params/invoiceSyncStatus`** has `publishedPlan` = [2026-11-11, 2026-11-08] (D-3 recheck) and `phase:"published"`. **`params/invoiceSyncCursor`** is empty. (Background: Open Work #44, the 2026-11-08 stale-cursor incident, is still unfixed.)
4. **`team_data/invoice_data`** has rows for 2026-11-11, including any `HYDS01` rows.
5. **Bangalore spot check:** open `homerun-ims.vercel.app` (city BLR). Overview and Stock Health load. The PO CSV downloads with the same header as before (`… DS08 Max, Purchase, Move`).
6. **Optional re-proof:** `npx vite-node scripts/snapshot-engine-inputs.mjs <scratch>/snap.json` (read-only). Dump on the current `main` and on `72441d0` (pre-Hyderabad) and diff. Expect only DC cells on DC-only (Move=No) SKUs that Pati has sold. Synthetic rows must use **existing dates** (a new date slides the 45-date window and fakes ~590 changes).

### Step B: Pati stock sync (Stock Health live stock)

Each sub-step needs the operator's go. Suggested 2026-11-12, ~11:00–12:00 IST, never during :35–:50, never near 14:30/20:30.

1. **B1, drift check (read-only).** Make sure the deployed `sync-stock` = `main`'s `sync-stock` minus the HYDS01 change.
   - `supabase functions download sync-stock` **in a throwaway directory outside the repo**, because download overwrites `_shared/*`. Then diff `index.ts` and the `_shared` files it imports against `main`.
   - Expected differences: only the `BRANCHES.HYDS01` entry plus the `resolveBranches` extraction (`_shared/stockBranches.ts`).
   - Run `git status` in the repo afterwards and confirm nothing changed.
2. **B2, deploy.** Run `supabase functions deploy sync-stock` (**always name the function**; a bare deploy redeploys all seven).
   - The cron is unchanged, so nothing fetches Pati yet. Note the version number.
   - Watch the next stock cycles (`:35` DC+DS01 … `:47` DS08). Each should return 200 and `stockUploadedAtPerDS` should advance for every Bangalore branch.
   - Logs: Management API `GET /v1/projects/rgyupnrogkbugsadwlye/analytics/endpoints/logs` with ClickHouse SQL over `logs`, `source='function_edge_logs'`. Send a browser User-Agent; the token is in the keychain. Recipe: `supabase/functions/CLAUDE.md`.
3. **B3, one manual Pati-only pull** in a free minute (e.g. hh:10–hh:30). POST `{"branches":["HYDS01"]}` to `https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock` with the anon Bearer. Check:
   - HTTP 200 and its duration;
   - `team_data/global.stockUploadedAtPerDS.HYDS01` is set;
   - the number of SKUs with a `HYDS01` entry in `stockData`;
   - the growth of the `team_data/global` payload. It was 7.5 MB on 2026-10-12, and Open Work #43 records writes timing out. Measure before and after.
   - Stock Health (HYD) now shows Pati's stock instead of "—".
   - ⚠ `sync-stock` merges at branch level from a fresh read, so Bangalore branches are untouched. Confirm by checking one Bangalore SKU's DS01 values before and after.
4. **B4, cron.** Move the staged SQL into `supabase/migrations/` with a fresh timestamp, then apply it **once**.
   - Either via the SQL editor followed by `supabase migration repair --status applied <version>`, or via `supabase db push` after `supabase migration list` shows only this one pending. Never both: a manual run followed by db push runs it twice.
   - Verify: `select jobname, schedule, command from cron.job where jobname='stock-sync-5';` shows `["DS08","HYDS01"]` and schedule `47 * * * *`.
   - Watch the next two `:47` cycles: 200, and both DS08 and HYDS01 timestamps advance. The branches are fetched together (`Promise.all`), so a Pati failure would also cost DS08 that hour. Watch DS08 specifically.
5. **Rollback:**
   - B2: redeploy the previous `sync-stock` version.
   - B4: `cron.alter_job` back to `["DS08"]`.
   - Both are safe at any time outside :47.
6. **Don't** add HYDS01 to Bangalore's `SYNC_GROUPS` (`StockHealthTab.jsx`) or homerun-to's `PULL_GROUPS`. Pati has its own Sync Now group in the Hyderabad view. ⚠ `docs/runbooks/opening-a-store.md` step 2 says to add a new store to those lists. That is right for a Bangalore store and **wrong for Pati**; update the runbook.
7. Update docs after B4: root `CLAUDE.md` (Hyderabad block + the sync architecture slot list), `supabase/functions/CLAUDE.md` (stock-sync-5 = DS08 + HYDS01), Open Work #45.

### Step C (optional): Pati's open POs in Stock Health

Add `'HYDS01 Pati': 'HYDS01'` to `LOCATION_TO_DS` in `supabase/functions/sync-orders/index.ts`. Copy the name **exactly** from Zoho; a wrong character silently drops every PO. Then do a named deploy of `sync-orders`, which writes `team_data/global` at :50, so deploy away from :35–:50. Check that `poData.HYDS01` appears after the next :50 run and that Bangalore `poData` is unchanged.

### Step D: real Hyderabad data (operator-driven)

1. **First real floor upload** (prod, Hyderabad only): HYD → Upload Data → Hyderabad floors card. This writes `team_data/hyd_inputs` only.
   - Check the preview lists (unknown, inactive and override SKUs) before confirming.
   - The floor sheet lists only part of Pati's assortment at launch; the category team adds rows over 2–3 weeks.
2. **First Hyderabad settings save:** HYD → Logic Tweaker → Apply (enabled on first save, changelog line "First save — creates Hyderabad's own copy"). This freezes the copy of Bangalore's settings. Until then, Hyderabad's settings track Bangalore's current values on every load.
3. **Plywood capacity:** HYD → Plywood. Confirm 300/150 or set Pati's real numbers, then Save. **0 means no cap**, not zero stock.
4. The PO team builds their Hyderabad sheet from `PO_Hyderabad_<date>.csv` (9 columns, frozen once they rely on it).

### Step E: before flipping Pati to Engine (~2026-11-24, operator's call)

1. **Purchase=OFF gap.** Zoho's single `cf_purchase_status` holds Bangalore's decision. After the flip, an engine-only Pati SKU (no Hyderabad floor) with Purchase=OFF goes 0/0.
   - The Engine-switch confirm shows "Pati demand blocked by a Bangalore flag". Read it before flipping.
   - Proper fix: a Zoho "HYD Purchase" field. `sync-catalogue` would read it and `hydPurchaseOf` would change; the body was designed for exactly this. `sync-catalogue` is Bangalore-critical, so that change needs its own inertness proof.
2. Re-check the freshness gate behaviour on the Hyderabad PO (it now uses Bangalore's gate).
3. Flip in HYD → Logic Tweaker (topSlot switch with a dry-run impact confirm) → Apply. This writes only `params/hydGlobal`.

### Step F: later / parked

- A nightly sync for the Hyderabad floor sheet (a Google Sheet) and a Hyderabad block in the nightly digest.
- A Hyderabad pincode map when a second Hyderabad store opens, and a Hyderabad DC (the DC term returns then).
- **Open Work #44:** `sync-invoices` `writeRow` swallows Supabase errors (2026-11-08: a cursor-clear write timed out and left a stale cursor; manual reset applied). Fix by checking `{error}` and throwing, and by clearing the cursor before the buffer; needs a named deploy of `sync-invoices`. Unrelated to Hyderabad, but it is the most likely thing to turn a morning digest red.
- Bangalore cosmetic bugs kept for byte-identity (#45). Fix them on `main` as a separate change with its own render check:
  - the pincode "+N more" count uses the wrong variable (`missing`);
  - the Tool Output DS Level card says "15 columns" but writes 19;
  - the PO blurb says "DS01–DS06".
- Docs budgets: `docs/OPEN-WORK.md` ~24.7k/25k and `supabase/functions/CLAUDE.md` ~61.9k/62k. Trim verbatim to `docs/CHANGELOG-ARCHIVE.md` before adding entries (`node scripts/check-claude-md.mjs`).

## 5. Known caveats (accepted, documented)

- Bangalore's Zero Sale list and Data Health still read raw `invoiceData` (incl. HYDS01 rows), the same as before this work.
- In the Hyderabad Stock Health, the shared Sync Now cooldown means Pati's Sync Now greys out after Bangalore crons. Sync Now is hidden until HYDS01 has synced once, and it never calls `sync-orders`.
- Plywood SKUs with no thickness in their name count as thin in the capacity bar, as in Bangalore's tab.
- Unsaved Hyderabad settings or plywood edits prompt on a tab or city switch (`window.confirm`). There is no `beforeunload` guard, the same as Bangalore.
- Every Hyderabad UI check uses render-smoke tests (react-dom/server). There is no jsdom, so click paths are covered by pure-helper tests plus the operator's read-only click-through.

## 6. Proof harnesses (reuse; scratch only, never in the repo root)

- **Engine inertness:** `scripts/snapshot-engine-inputs.mjs` (read-only GETs) → `scripts/dump-engine-output.mjs` → `scripts/diff-engine-dumps.mjs`. For the "main" side use `git worktree add --detach <scratch>/main-wt <commit>` and symlink `node_modules`. Never run inside the operator's checkout.
- **Nightly dry run:** `POST https://homerun-ims.vercel.app/api/run-engine {"mode":"dry"}` with `x-engine-secret`. Get the secret from the `engine-run-nightly` cron command via the Management API, and extract it in the same shell command (memory note `reference_engine_run_secret`). It writes nothing (`wroteTo: null`).
- **Bangalore render byte-identity:** server-render the component with Bangalore props before and after, then compare SHA. The pattern is in the `*.test.jsx` files under `src/tabs/`.
