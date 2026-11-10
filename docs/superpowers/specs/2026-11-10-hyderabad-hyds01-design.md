# Hyderabad — HYDS01 Pati in IMS — design

**Status:** draft for approval · **Date:** 2026-11-10 · **Author:** brainstorm with the operator, 2026-10-26 → 11-10

## 1. Intent

HomeRun has opened its first store outside Bangalore: Zoho location **`HYDS01 Pati`**, under the
parent location **HomeRun Hyderabad** (its own GSTIN, `36AAICH7192R1ZM`). It went live 2026-11-06.
Hyderabad has **no DC**. Vendors deliver straight to Pati, and Pati ships customer orders itself.

IMS has to work out Pati's Min/Max, show its stock, and give the PO team a Hyderabad PO file.
**Nothing that runs Bangalore today may change.** The Bangalore build is in production and several
teams rely on it every day (PO team ~07:30, DC team TOs at 14:30/20:30, the nightly chain). That
constraint outranks every other goal here.

### Goals
- Pati gets Min/Max from the existing engine, using a separate copy of Bangalore's settings.
- **Launch on floors only:** Pati's range and targets come entirely from a Hyderabad floor sheet the
  category team fills in. The range is **partial at launch and grows over 2–3 weeks**.
- **One switch** (per store) moves Pati from floors to the engine once it has enough orders.
- Stock Health for Pati, with live stock. A separate Hyderabad PO CSV in Bangalore's format.
- A city switch so one team can work in both cities without confusing them.

### Non-goals (this build)
- **TO tool**: there is nothing to transfer, because Hyderabad has no DC.
- Hyderabad DC, pincode attribution in Hyderabad (one store, so every order is Pati's), a nightly
  Hyderabad floor-sheet sync, Hyderabad SKU ceilings, a Hyderabad block in the nightly digest.
- A Zoho location-ID registry. It was needed while Pati was named `DS01 Pati`. Since the rename to
  `HYDS01` the first-word lookup (`invoiceMap.ts dsOf`) is unique again. Revisit if a name collides.
- Changing anything about Bangalore's behaviour, data or screens.

### Anti-goals (would be a failure even if Hyderabad works)
- Any Bangalore Min/Max, `toTargets` row, PO CSV byte, Stock Health number or TO-tool behaviour
  changing.
- A Hyderabad action (upload, Apply, settings change) writing to a Bangalore row, or the reverse.
- A Hyderabad file that can be mistaken for a Bangalore one, or uploaded into the wrong city.

## 2. Facts this design rests on (measured, not assumed)

- **Pati's invoices already reach `invoice_data`** labelled `ds:"HYDS01"`. The rename made `dsOf()`
  produce a unique key. `sync-orders` ignores Pati (name-keyed map), and `sync-stock` doesn't fetch it
  (ID-keyed map).
- **Measured effect of HYDS01 rows on Bangalore today (2026-11-06, snapshot harness): 0 of 29,268
  cells.** A busy DS08-sized Pati day also gives 0. The only paths that can move Bangalore are:
  1. **DC targets for DC-only SKUs** (Move=No). The engine sums *every* invoice row. A deliberately
     extreme bulk order of all 331 such SKUs moved 10 Bangalore DC cells.
  2. **Pincode attribution relabelling a Pati invoice that has a Bangalore pincode.** A test order
     (`HR/26/186377`, pin 560009) was moved to DS08. The operator confirms real Hyderabad orders never
     have Bangalore addresses.
  3. **The New DS Floor top-N ranking** counts all rows. It changed labels, not numbers, in the test.
- ⚠ **Testing trap:** synthetic rows must use a date that **already exists** in the snapshot. A new
  date slides the 45-date window and fakes ~590 changed cells.
- Live plywood config: **every brand at every store covers only itself** (`nodes.DSxx.covers =
  ["DSxx"]`, 4 brands × 8 stores). There is no cross-store network in practice.
- `runEngine` iterates the module-level `DS_LIST` (`runEngine.js:118,172,199…`). It has no
  store-list argument today.
- Both Bangalore floor parsers **ignore** a column like `HYDS01 Min` rather than refusing it: the
  nightly one via `DS_COLUMN = /^(DS\d+|DC)\s+(Min|Max)$/` (`_shared/skuFloorSheet.ts:55`), the
  browser one because it loops over `[...DS_LIST,"DC"]` (`App.jsx` `handleNSQ`). Only the nightly
  parser is strict about values; the browser one uses `parseFloat` and keeps anything > 0.
- `plywoodNetwork.js` imports `DS_LIST` itself (`:13,259,281,362`) and always computes a DC node
  (`:374-384`), so a store list passed to `runEngine` alone does not reach plywood.
- Catalogue and prices are **org-wide and item-level** (same Zoho org, same SKU codes): `skuMaster`,
  Zoho `status` and `priceData` (`purchasesbyitem` average) apply to Hyderabad as they are.
- `sync-stock` with an empty body syncs `Object.keys(BRANCHES)` (`sync-stock/index.ts:183-185`), which
  is the latent Open Work #38 path.

## 3. Decisions (the operator's)

### 3.1 Identity and naming
- The stored key is **`HYDS01`**, matching Zoho. Bangalore keys (`DS01`–`DS08`, `DC`) are unchanged.
- **City is the top-level scope in the UI.** One global switch, Bangalore / Hyderabad (option A in
  the mockups).
- A **`BLR | HYD` segmented toggle** right after the HomeRun logo: the
  selected city is filled in its colour, the other muted; clicking the selected one does nothing
  (*amended 2026-11-10 at the operator's request; was a "HomeRun · HYDERABAD ▾" label*). Tint pair 1: **Bangalore warm cream**
  (close to today's look, brand-yellow underline), **Hyderabad cool blue**. The header never scrolls
  away (it is a fixed-height flex child), so this is visible on every tab.

### 3.2 Range and targets
- **Floors-only (launch):** Pati's range is the Hyderabad floor sheet. A SKU with a row and Min/Max > 0
  is in the range and its target **is** the floor. Every other SKU is 0/0 at Pati, whatever its sales.
- **Engine (after the flip):** Bangalore rules. Every active SKU gets Min/Max from the strategies on
  **Pati's own sales**. A floor row lifts the engine number (the higher of the two). A SKU with no
  sales and no floor is 0/0. **Demand can now add a SKU to the range.**
- **The floor sheet beats Bangalore-origin flags.** For a SKU with a Hyderabad floor row, Purchase=OFF,
  Inventorised At=Supplier and the Dead Stock list do **not** zero it. Before the flip that covers the
  whole range; after the flip, engine-only SKUs follow the flags as in Bangalore.
- **Exception: Zoho `status` inactive stays 0/0** even with a floor, because Zoho refuses to transact
  an inactive item (the 2026-08-28 incident). It is reported, not silently dropped. *(Builder call)*
  It is reported in two places: the Hyderabad floor-upload preview ("N floor SKUs are inactive in Zoho")
  and a dismissible notice on Hyderabad Stock Health. **Not** as a PO CSV column. The same two places
  list floor rows that override Purchase=OFF / Supplier / Dead Stock, plus Pati sales outside the
  range.

### 3.3 Settings and the switch
- Hyderabad has **its own copy** of Bangalore's settings (taken from Bangalore's live values on the day
  it is created, stored in separate rows). The Hyderabad Logic Tweaker shows "copied from Bangalore on
  <date>" and has a **"Reset to Bangalore's current values"** button. Apply in Hyderabad writes only
  Hyderabad rows; Apply in Bangalore writes exactly what it writes today.
- **One switch per store covers every category including plywood:** "Pati: Floors only ⇄ Engine".
  It is stored per store so a second Hyderabad store can start on floors-only while Pati runs the
  engine. **Missing or unreadable means floors-only** (fail-safe, the same direction as
  `openingDSList`).
- Settings that only make sense in Bangalore are hidden in Hyderabad: `newDSList`, `openingDSList`,
  DC parameters, pincode mode, `dsCapacities`. Two settings are Hyderabad-only:
  - **Lead-time buffer:** Min += ⌈daily avg × lead time⌉, using `brandLeadTimeDays` (default 3,
    Asian Paints 4).
  - **Order cycle, default 3 days:** Max = max(Max + buffer, Min + ⌈daily avg × order cycle⌉).
  - Both apply **only to the engine's number**, before the floor lift. Floors are the category team's
    complete judgement and get no buffer (`final = max(floor, engine + buffer)`).
  - *(Builder call, pinned by tests)* "daily avg" is the calendar-window rate the engine already
    computes, `computeStats().dailyAvg` = window qty ÷ `overallPeriod` days, for **every** strategy. It
    is the same rate the Bangalore DC formula `sumDailyAvg × (leadTime+1)` uses, not a strategy's
    internal active-day rate. Order of operations: `min1 = min0 + ⌈avg × LT⌉`, then
    `max1 = max(max0 + ⌈avg × LT⌉, min1 + ⌈avg × cycle⌉)`, i.e. the cycle term uses the
    **post-buffer** Min.

### 3.4 Plywood
- It uses Network Design in Hyderabad too, from a separate copy of the plywood config: the same 4
  brands, `HYDS01 covers ["HYDS01"]`.
- Pati's node settings are copied from **DS07/DS08** (cover days 3, min cover 1.5, buffer 20%, tiers
  6/2, threshold P75).
- **The DC term is dropped** (there is no Hyderabad DC). The lead-time buffer applies after the network
  calculation, the same as for every other category.
- **Capacity starts at 300 thick / 150 thin** (copied from DS07/DS08) and is editable in the
  Hyderabad Plywood tab. ⚠ `applyCapacityTrim` reads ≤ 0 as **no cap at all**, so the tab warns
  visibly on 0.
- It follows the same switch: floors only, then engine.

### 3.5 Floors input
- A **separate Hyderabad floor sheet**, uploaded by hand in Upload Data with the city set to Hyderabad.
  There is no nightly sync for now.
- Columns: `SKU` (required) · `Item Name` (optional, ignored) · `Category` (optional, ignored) ·
  `HYDS01 Min` · `HYDS01 Max`. A future store adds `HYDS02 Min/Max`.
- Same rules as the **nightly** Bangalore parser (`_shared/skuFloorSheet.ts`), **not** the lenient
  browser one: blank = 0, whole numbers only (anything else is rejected with the SKU and column named),
  Max raised to Min, **last row wins** for a repeated SKU, 0/0 or a deleted row = out of range.
  *(Builder call, amended 2026-11-10)* The Hyderabad parser is **new code in `src/hyd/hydFloors.js`**
  mirroring the semantics of `_shared/skuFloorSheet.ts` (store-column pattern and known-store list supplied
  per city), **not a reuse**: that file is bundled into the deployed nightly `sync-sku-floors`, so touching it
  would change Bangalore's deployed code path.
- **Refused in Hyderabad:** any `DC Min/Max` or Bangalore `DSxx` column. A Bangalore file uploaded in
  Hyderabad fails loudly.
- *(Builder call, corrected after review)* **The Bangalore parsers are NOT changed.** A Hyderabad file
  uploaded in Bangalore keeps today's behaviour (Hyderabad columns ignored). Making Bangalore refuse it
  would change Bangalore behaviour and require a lockstep redeploy of `sync-sku-floors`, which is a key
  with two writers (the 2026-08-15 lesson). The protection on that side is the city-named confirm dialog
  plus the separate sheet.
- The confirm dialog names the city in large text and states that Bangalore is not touched.

### 3.6 Outputs
- **Hyderabad PO CSV**: the same format as Bangalore with honest headers. Targets only (no stock, no
  "order X"), **every master SKU** in the same row order as Bangalore:
  `Item Name · Inventorised At · SKU · Category · Brand · Status · HYDS01 Min · HYDS01 Max`.
  `· Purchase` is appended (see below), so the frozen Hyderabad header is
  `Item Name · Inventorised At · SKU · Category · Brand · Status · HYDS01 Min · HYDS01 Max · Purchase`.
  There is **no `Move`** (it governs DC→DS transfers, and Hyderabad has none).
  Filename `PO_Hyderabad_<YYYY-MM-DD>.csv`. Shown only in Hyderabad. **The PO team builds a separate
  Hyderabad sheet**, so this header is new, but once shipped it is frozen the same way as Bangalore's
  (columns are only ever appended). (Note: Bangalore's live header ends `… · Purchase · Move`;
  `src/tabs/CLAUDE.md` still says it ends at `DS06 Max`, which is stale.)
- **`Purchase` in the Hyderabad file = Hyderabad's EFFECTIVE decision, computed by IMS** (decided
  2026-11-10). Zoho has one Purchase field, and in practice it holds Bangalore's decision. Until a
  separate Zoho "HYD Purchase" field exists:

  | SKU | Hyderabad `Purchase` |
  |---|---|
  | has a Hyderabad floor row | **Yes** (the sheet wins) |
  | no floor row, Pati floors-only | No (out of range, 0/0) |
  | no floor row, after the flip | Zoho's value (normalised Yes/No) |
  | inactive in Zoho | No, regardless of floor |

  Implement it as **one function, `hydPurchaseOf(sku, …)`**, used by the PO CSV, the screens and the
  Hyderabad pass alike. A future Zoho `HYD Purchase` field then changes only that function's body
  (plus `sync-catalogue` reading it, which is a separate change with its own inertness proof, **not in
  this build**). Known gap until then: after the flip, a Bangalore-motivated Purchase=OFF also stops
  Pati on SKUs with no Hyderabad floor row. A floor row overrides it.
- **Stock Health for Pati**: SKU · stock · Min · Max · health tag, plus open POs if §3.7's
  `sync-orders` step ships. No DC or TO columns.

### 3.7 Live stock (in this build)
- **HYDS01 joins DS08 in `stock-sync-5`** (2 branches, which is normal; the rule only forbids a third).
- ⚠ The branches in a slot are fetched together (`Promise.all`, `sync-stock/index.ts:231`), so a
  Pati fetch failure also costs DS08 that hour. Hence the staged rollout in §6.
- *(Builder call)* **HYDS01 is excluded from the empty-body "sync every branch" default.** It is synced
  only when named explicitly. The empty-body path (Open Work #38: already ~128s of 150s) therefore
  stays exactly as it is today, and step 6.3b is genuinely inert.

### 3.8 Tabs in Hyderabad
Overview · SKU Detail · Stock Health · Tool Output Download · Upload Data · Logic Tweaker · Plywood.
**Hidden:** Baskets, Manual Overrides. Bangalore shows exactly today's tabs.

### 3.9 TO tool
No change, and no deploy of `homerun-to`. It reads `params/toTargets`, which stays Bangalore-only. Its
store list comes from that row's keys, and it looks up stock only for those stores. Its stock-pull
button sends explicit branch lists, so the `stock-sync-5` change doesn't affect what it pulls. The
builder **reads** `homerun-to` to confirm each of these and records the result here.

**Verified 2026-11-10 (read only, `homerun-to` at `5955b19`; nothing there was changed):**
- **Store list from `toTargets`.** `dsListFromTargets` (`src/constants.js:23`) unions the `perDS`
  keys of every target and filters them through `DS_ORDER` (`src/constants.js:18`, DS01–DS08), so a
  key not in `DS_ORDER` can never become a store; `src/App.jsx:294` builds `DS_LIST` from it. On the
  IMS side `toTargets` is `buildToTargets(…, liveDsList(params))` (`src/App.jsx:2486`,
  `api/run-engine.js:132`), and `liveDsList` derives from `DS_LIST`, which has no HYDS01 — so HYDS01
  is excluded twice over.
- **Stock only for those stores.** The TO plan reads `stockDataAccounting`/`stockData` per SKU of
  `targets`, per store of `DS_LIST`, plus `DC` (`src/App.jsx:661-669`); freshness and the alarm are
  judged over `TRADING_LOCS = ["DC", ...DS_LIST]` (`src/App.jsx:609-614`, `:640`). A HYDS01 key in
  `stockData` / `stockUploadedAtPerDS` is never read.
- **Pull button sends explicit branches.** `PULL_GROUPS` is `[["DC","DS01"], …, ["DS08"]]`
  (`src/sync.js:25`, pinned by `src/sync.test.js:330`), and each group is invoked as
  `{ branches: g.branches }` (`src/sync.js:206`). The `stock-sync-5` cron change does not reach it, and
  `PULL_GROUPS` stays `["DS08"]` — adding HYDS01 would make the DC team's pull fetch Pati stock.

## 4. Architecture

### 4.1 Store universe
- `DS_LIST` stays **exactly** as it is: the Bangalore store universe.
- New `HYD_DS_LIST = ["HYDS01"]` plus a city lookup (`cityOf(ds)`) in `src/engine/constants.js`.
  Anything that needs every store across both cities asks for it explicitly; nothing existing changes
  meaning.

### 4.2 The Bangalore path: one change, proven inert
- **Drop Hyderabad rows from the Bangalore engine's input, before attribution.** Do it as a
  **deny-list by city** (`cityOf(r.ds) === "HYD"` → drop), **not** an allow-list of Bangalore stores:
  live data carries `DC01` and `HOMERUN` rows that the engine reads today, and an allow-list would
  silently change Bangalore.
- It applies at every Bangalore engine entry: the browser load effects in `App.jsx`, `applyAndRun`,
  `api/run-engine.js` (nightly), and the scripts that replay the engine. One helper, not copies.
- It closes all three paths in §2.
- Expected Bangalore effect at ship time: **0 changed cells**. Pati's test order has since disappeared
  from the live 4 Nov rows, so the snapshot must be re-measured before ship rather than assuming 0.

### 4.3 The Hyderabad engine run
- *(amended 2026-11-10)* **The remap approach — no engine change.** The Hyderabad engine calls the
  **unmodified** `runEngine` with Pati's rows relabelled `ds:"DS01"`, Hyderabad params, a neutralised
  SKU-master clone (move "Yes", purchase "Yes", inventorisedAt "DS" unless already), no floors, ceilings,
  dead stock or attribution, and a plywood config whose only node is DS01 with no DC. It then reads
  `stores.DS01` back as HYDS01 and applies the Hyderabad pass below. `runEngine`, `plywoodNetwork.js` and
  `DS_LIST` are not modified, so Bangalore code paths are untouched by construction. (This supersedes the
  earlier plan to thread an optional store list through `runEngine` and plywood.)
- A Hyderabad pass over the finished stores applies, in order: engine number → lead-time buffer and
  order cycle → floor lift → the flag rules of §3.2 → Active-only (always) → floors-only override (if
  the switch is off: target = floor for SKUs in the sheet, 0/0 otherwise).
- The Hyderabad engine runs **in the browser only** for this build (feeding the screens and the PO
  CSV). The nightly `api/run-engine.js` computes nothing for Hyderabad and writes nothing new.

### 4.4 Storage (new rows only)
| row | written by | holds |
|---|---|---|
| `team_data/hyd_inputs` | browser, on Hyderabad floor upload only | `{ floors, uploadedAt }` |
| `params/hydGlobal` | browser, Hyderabad Apply only | Hyderabad settings copy + `floorsOnly` per store + lead time + order cycle + `copiedFromBangaloreAt` |
| `params/hydPlywoodNetworkConfig` | browser, Hyderabad Plywood save | **same shape as** `plywoodNetworkConfig`: brand matrix with `HYDS01 covers ["HYDS01"]`, global plywood params |
| `params/hydNetworkConfigs` | browser, Hyderabad Plywood save | **same shape as** `networkConfigs`: `HYDS01.thick/thin` node settings incl. `capacity` |

*(Builder call)* The two plywood rows mirror Bangalore's shapes exactly, so `plywoodNetwork.js` and
the capacity derivation in `loadParamConfigRows` are reused unchanged. "A copy of Bangalore's
settings" therefore covers `params/global` **and** these two own-row configs. `pincodeMap` and
`dsCapacities` are not copied.

- `team_data/global` gains **nothing from the browser**. ⚠ It is ~7.5 MB and its writes already time
  out (Open Work #43). The only new data that goes there is Pati's branch in `stockData`, written by
  `sync-stock`'s existing branch-level merge.
- New rows are attached through `loadParamConfigRows()` / the `teamDataBundle` pattern, never
  hand-rolled (the `pincodeConfig` revert lesson). `BROWSER_OWNED_KEYS` for `global` is **unchanged**.
- `sync-orders`: optional, a later stage. Add `'HYDS01 Pati': 'HYDS01'` to `LOCATION_TO_DS` so Pati's
  open POs appear in Stock Health. ⚠ The name is copied **exactly** from Zoho.

### 4.5 UI
- City state comes from `?city=hyd|blr`, then the last-used city (localStorage, wrapped in try/catch),
  then **Bangalore**.
- Header label and tint as in §3.1. Browser tab title "IMS · Hyderabad". The city name appears in
  section headings, every download filename and every write confirmation.
- In Bangalore, every tab renders through today's code path with today's props. The city switch must
  not re-key or re-mount Bangalore components in a way that triggers extra engine runs.

### 4.6 Local testing without prod writes
- Root `CLAUDE.md`: `npm run dev` **reads and writes production**.
- Add **`VITE_READ_ONLY=1`**. When set, every Supabase write path (team_data saves, params upserts, Apply,
  Sync Now, edge-function invocations) is blocked and shown on screen as "would have written <row>".
- The operator tests the whole Hyderabad flow on their own dev server against live data with zero
  writes. It ships off by default, so production is unaffected.

## 5. Verification gates (all must pass before anything is pushed)

1. **Bangalore engine inertness:** freeze inputs with `scripts/snapshot-engine-inputs.mjs`, then dump
   on `main` and on the branch. The result must be **0 min/max changes and 0 tag-only changes across
   every Bangalore cell including the DC**, with Inv Value identical to 4 dp. Repeat with the synthetic
   Pati stress rows (on an existing date): **still 0**, which proves §4.2 closes all three paths.
2. **Nightly path:** `POST /api/run-engine {"mode":"dry"}` from the preview deploy matches the
   production dry run (`invValue`, target count).
3. **Bangalore PO CSV byte-identical** (same snapshot, old vs new), and `scripts/verify-po-csv.mjs`
   green.
4. **`toTargets` identical** row for row (built from both dumps through `src/toTargets.js`).
5. Unit tests: the Hyderabad floor parser (including refusing a Bangalore file), the Hyderabad pass
   (floors-only, engine, flag override, inactive exception, buffer/cycle arithmetic), the Hyderabad PO
   header, city filter deny-list semantics. Full existing suite green.
6. **Operator's local test** in `VITE_READ_ONLY=1` mode, Bangalore first (it must look exactly like
   prod), then Hyderabad.

## 6. Rollout, each step only on the operator's go

1. **Vercel deploy of the frontend and `api/run-engine.js`.** Daytime, outside 14:30/20:30 ± 30 min
   and outside 00:35–06:30. Verify: the next morning's digest is green with an unchanged Inv Value, and
   a spot-check of Bangalore Stock Health and the PO CSV.
2. **First Hyderabad floor upload + Hyderabad Apply** (by an admin). Writes only the new rows.
3. **Stock, staged:**
   - a. Before deploying `sync-stock`, confirm local `_shared/` matches what is deployed (diff in a
     separate worktree, because `functions download` overwrites `_shared/`).
   - b. Named deploy `supabase functions deploy sync-stock` with HYDS01 in `BRANCHES`. The cron is
     unchanged, so nothing fetches Pati yet. Watch the next five Bangalore slots.
   - c. One manual Pati-only invocation in a free minute (`{"branches":["HYDS01"]}`). Record SKU count,
     duration and the growth of the `global` row.
   - d. `cron.alter_job` on `stock-sync-5` to `["DS08","HYDS01"]`, as a migration file, with the
     command checksum verified as in `a0d5ad7`. Watch DS08 for the next few cycles.
4. **Optional:** a named deploy of `sync-orders` with the Pati mapping.
5. **About 3 weeks after launch:** the operator flips Pati to Engine in the Hyderabad Logic Tweaker.

**Rollback:** step 1 is a Vercel instant rollback. Steps 3b/3d revert by redeploying the previous
`sync-stock` version and re-altering the cron. Hyderabad rows can be cleared without affecting
Bangalore.

## 7. Builder's discretion
- Exact component structure for the city switch. How `runEngine` takes its store list (as long as it
  defaults to `DS_LIST` and §5.1 holds). Test file layout.
- Whether Overview / SKU Detail in Hyderabad reuse the Bangalore components with a store list or get
  thin wrappers. The Bangalore render path must stay identical.
- Wording of warnings and confirmations, as long as the city is named.

## 8. Open items
- ✅ **Pati's Zoho location ID: `3915979000169622634`** (the operator read it from the Zoho Settings →
  Locations URL, 2026-11-10). It is used for `sync-stock`'s `BRANCHES.HYDS01`.
- Where the category team keeps the master Hyderabad sheet (a Google Sheet, exported to CSV for upload
  for now). A nightly sync is a later phase.

## 9. Addendum (2026-11-10, operator): Hyderabad looks identical to Bangalore

**Why:** one team uses both cities, so the tool must be consistent. The first build used separate,
simpler Hyderabad screens to keep Bangalore safe. The operator now wants Hyderabad to render the
SAME screens as Bangalore, still with no Bangalore behaviour change.

**Decisions (operator, 2026-11-10):**

- **Overview, SKU Detail:** Hyderabad renders Bangalore's own components, with a store list
  (`["HYDS01"]`, no DC) and Pati's invoice rows. Same pattern as Stock Health.
- **Tool Output Download:** the inline block becomes its own component (pure move first). Hyderabad
  shows the same card grid with the cards that apply: Hyderabad PO (its frozen 9-column file), DS-level
  file, SKU Master, Purchase Prices. DC and Inner Case Pack cards are hidden (no DC).
- **Logic Tweaker:** the inline block becomes its own component (pure move first). In Hyderabad it edits
  the Hyderabad settings draft and Apply writes only `params/hydGlobal`. The Floors only ⇄ Engine switch
  and "Reset to Bangalore's current values" sit in a Hyderabad-only section at the top.
  - **Hidden in Hyderabad:** the Bangalore-network sections (New DS list, Store Status /
    `openingDSList`, pincode attribution, Dead Stock DC multiplier, SKU Floor DC multipliers,
    plywood non-network strategy picker).
  - **Brand Lead Time stays visible.** It drives Pati's vendor lead-time buffer (§3.3) and is
    relabelled for Hyderabad.
- **Upload Data:** the inline block becomes its own component (pure move first). Hyderabad shows the
  same card layout. Only the **Hyderabad floors** card is active. Invoices, SKU master, prices, dead
  stock and ceilings are org-wide or Bangalore inputs, shown with a "shared — managed in Bangalore" note
  and no upload.
- **The three "fix your floor sheet" lists move to the Hyderabad floors card:** sold at Pati with no
  floor (with **"Download as floor template"**: a CSV of those SKUs with Item Name, Category and blank
  HYDS01 Min/Max), floor SKUs inactive in Zoho, and floors overriding Bangalore flags. The notice above
  Pati's Stock Health is **removed**, so Stock Health is identical to Bangalore's.
- **Plywood:** Hyderabad keeps its own panel, **restyled** to Bangalore's look. Bangalore's tab designs an
  8-store network with a DC fallback, and reusing it for one store would be a rewrite.

**Safety (binding):**

- Every extraction from `App.jsx` is done in two commits:
  1. A **pure move**, proven text-identical by normalising indentation and diffing old block vs new
     component body. The only allowed differences are the function wrapper and the props destructure.
  2. A separate commit adding the Hyderabad props, with defaults that leave Bangalore unchanged.
- Overview and SKU Detail are proven by a byte-identical server render of the Bangalore default props,
  before and after.
- Final gates as in §5: Bangalore engine cells, PO CSV and `toTargets`, plus the operator's read-only
  test.
