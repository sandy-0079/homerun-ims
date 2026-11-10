# Hyderabad HYDS01 Pati — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hyderabad (store `HYDS01` Pati, no DC) to IMS. It launches on floors only and switches to the engine later. It has its own floors upload, PO CSV, Stock Health and settings, and a city switch. Bangalore stays provably unchanged.

**Architecture:**
- **Hyderabad code lives in new files** (`src/city.js`, `src/hyd/*`, `src/tabs/hyd/*`). The one Bangalore code change is a city deny-list filter on the engine's input.
- **The Hyderabad engine reuses `runEngine` UNMODIFIED through a remap.** Pati's rows are relabelled `DS01` and run with Hyderabad params. A neutralised copy of the SKU master is passed (so Move / Inventorised At / Purchase don't fire), along with no floors, no attribution and a plywood config whose only node is `DS01` with no DC. The `DS01` result is then read back as `HYDS01`, and a Hyderabad pass applies the buffer, floors, flags and the floors-only switch.
- This replaces the design's "thread a store list through `runEngine` and `plywoodNetwork.js`" (§4.3). The engine and plywood code stay byte-identical, so Bangalore's risk is only the input filter.

**Tech Stack:** React 18 + Vite, vitest (`npm test` = `vitest run`, `*.test.js|ts` beside modules), Supabase JS client (`src/supabase.js`), Deno edge functions (`supabase/functions/*`).

**Spec:** `docs/superpowers/specs/2026-11-10-hyderabad-hyds01-design.md`

## Global Constraints

- **Nothing is pushed, deployed, or written to production by this plan.** All work happens on the local branch `hyderabad-hyds01`. Every edge-function deploy, cron change and Vercel deploy is the operator's go, one step at a time (spec §6).
- **Run every local dev session with `VITE_READ_ONLY=1`.** `npm run dev` otherwise reads and writes prod.
- Store key `HYDS01`; Zoho location id `3915979000169622634`; Zoho name `HYDS01 Pati`.
- Bangalore's `DS_LIST`, `PO_CSV_HEADERS`, `BROWSER_OWNED_KEYS`, `loadParamConfigRows`, `toTargets` and both Bangalore floor parsers are **unchanged**.
- New rows only: `team_data/hyd_inputs`, `params/hydGlobal`, `params/hydPlywoodNetworkConfig`, `params/hydNetworkConfigs`.
- Hyderabad PO header (frozen): `Item Name, Inventorised At, SKU, Category, Brand, Status, HYDS01 Min, HYDS01 Max, Purchase`. Filename `PO_Hyderabad_<YYYY-MM-DD>.csv`.
- Defaults: order cycle **3** days; lead time from the copied `brandLeadTimeDays`; Pati plywood capacity **300 thick / 150 thin**; `floorsOnly.HYDS01 = true`, and missing/unreadable also means floors-only.
- Header label `HomeRun · HYDERABAD ▾` / `· BANGALORE ▾`. Tints: Bangalore `#FFF8DC` with a 3px `#F5C400` underline; Hyderabad `#E6F0FA` with a 3px `#1F5FA8` underline. Label colours `#7A5C00` / `#1F5FA8`.
- Bangalore inertness acceptance: **0 min/max changes and 0 tag-only changes** across all Bangalore cells including the DC, on a frozen snapshot, `main` vs branch.

## Review Focus

1. **A Bangalore floor/ceiling file uploaded while in Hyderabad, or a Hyderabad file in Bangalore.** Expected: Hyderabad refuses a Bangalore file loudly; Bangalore keeps today's behaviour. → Task 4 tests `refuses DS01/DC columns`; Task 9 manual check.
2. **SKU codes in the Hyderabad sheet that aren't in `skuMaster`** (old pre-July codes, typos). Expected: listed in the upload preview as unknown and not stocked; the upload is not refused. → Task 4 test `reports unknown SKUs`, Task 6 test `unknown sku gets no target`.
3. **Pati has only a few sale dates (sparse window).** Expected: the window is the last `overallPeriod` dates of the *whole* dataset, not Pati's own dates. → Task 6 test `window follows network dates`.
4. **Switching city with unsaved Bangalore Logic Tweaker changes.** Expected: the switch is blocked with a message, so nothing is lost and Bangalore's Apply never runs as a side effect. → Task 9 step.
5. **`hydGlobal` row missing or a partial object on first load.** Expected: Hyderabad runs on Bangalore-copied defaults with floors-only true, never engine mode. → Task 5 test `missing floorsOnly means floors-only`.

---

### Task 1: Branch, read-only mode, design amendment

**Files:**
- Modify: `src/supabase.js` (`saveToSupabase` at `:38`)
- Modify: `src/tabs/StockHealthTab.jsx` (edge invokes at `:266`, `:282`)
- Modify: `src/App.jsx` (banner directly under the header, `:2648`)
- Create: `src/readOnly.test.js`
- Modify: `docs/superpowers/specs/2026-11-10-hyderabad-hyds01-design.md` (§4.3 → the remap approach; §3.5 → a new parser in `src/hyd/hydFloors.js` instead of reusing `_shared/skuFloorSheet.ts`, because that file is bundled into the deployed nightly `sync-sku-floors`)

**Interfaces:**
- Produces: `export const READ_ONLY: boolean` and `export function blockedWrites(): Array<{table,id,at}>` in `src/supabase.js`. While `READ_ONLY` is set, `saveToSupabase(table,id,payload)` resolves without writing, pushes to the list, and dispatches `window` event `ims-readonly-write` with `{table,id}`.

- [ ] **Step 1:** `git switch -c hyderabad-hyds01`. Expected: on the new branch, clean tree.
- [ ] **Step 2: Write the failing test** `src/readOnly.test.js`: set `vi.stubEnv("VITE_READ_ONLY","1")`, mock `@supabase/supabase-js` `createClient` so `from().upsert` is a `vi.fn()`, dynamically import `./supabase.js`, call `saveToSupabase("params","x",{a:1})`. Assert that upsert was **not** called, `blockedWrites()` has length 1 with `table:"params", id:"x"`, and `READ_ONLY === true`. Second case: env unset → upsert called once.
- [ ] **Step 3:** `npx vitest run src/readOnly.test.js`. Expected: FAIL (`blockedWrites` is not exported).
- [ ] **Step 4: Implement** in `src/supabase.js`. `READ_ONLY = import.meta.env.VITE_READ_ONLY === "1"`; guard the first line of `saveToSupabase`. In `StockHealthTab.jsx`, the two `functions.invoke` calls return early with an alert `"Read-only mode — sync not run"` when `READ_ONLY`. In App, when `READ_ONLY`, a full-width red bar under the header reads `READ-ONLY MODE — writes are blocked (N blocked)`, and the count updates from the event.
- [ ] **Step 5:** `npx vitest run src/readOnly.test.js` → PASS; `npm test` → all green.
- [ ] **Step 6:** Edit the design doc §4.3 and §3.5 as listed under Files (one paragraph each, marked *amended 2026-11-10*).
- [ ] **Step 7: Commit** `feat: VITE_READ_ONLY blocks every browser write (local testing against prod)`.

### Task 2: City model and the Bangalore row filter

**Files:**
- Create: `src/city.js`, `src/city.test.js`

**Interfaces:**
- Produces:
  - `HYD_DS_LIST = ["HYDS01"]`
  - `CITIES = { blr:{key:"blr",label:"BANGALORE"}, hyd:{key:"hyd",label:"HYDERABAD"} }`
  - `cityOf(ds: string): "hyd"|"blr"` — `"hyd"` iff `ds` is in `HYD_DS_LIST`; **everything else, including `DC01`, `HOMERUN` and unknown values, is `"blr"`** (deny-list semantics)
  - `isHydRow(r): boolean`
  - `dropHydRows(inv: Row[]): Row[]` — returns the **same array reference** when it contains no Hyderabad row
  - `hydRowsOnly(inv): Row[]`
  - `readInitialCity(search: string, storage: Storage|null): "blr"|"hyd"` — URL `?city=` first, then storage key `ims.city`, then `"blr"`; storage access wrapped in try/catch
  - `persistCity(city, storage)`

- [ ] **Step 1: Failing tests:**
  - `cityOf("HYDS01")==="hyd"`, and `cityOf` of `"DS01"`, `"DC01"`, `"HOMERUN"`, `""`, `undefined` are all `"blr"`.
  - `dropHydRows(rows)` removes only `ds:"HYDS01"`, and `dropHydRows(blrOnly) === blrOnly` (same reference).
  - `readInitialCity("?city=hyd", null)==="hyd"`; `readInitialCity("", throwingStorage)==="blr"`; `readInitialCity("?city=xyz", store{ims.city:"hyd"})==="hyd"`.
- [ ] **Step 2:** `npx vitest run src/city.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/city.js`.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5: Commit** `feat: city model (HYDS01) with deny-list Bangalore filter`.

### Task 3: Bangalore engine ignores Hyderabad rows, proven inert

**Files:**
- Modify: `src/engine/runEngine.js:65` (immediately before `applyAttribution`)
- Test: `src/engine/__tests__/hydFilter.test.js`

**Interfaces:**
- Consumes: `dropHydRows` (Task 2).
- Produces: `runEngine` output is unaffected by any `ds:"HYDS01"` row; the signature is unchanged.

- [ ] **Step 1: Failing test** `hydFilter.test.js`. Build a minimal fixture by copying the setup pattern in `src/engine/__tests__/attribution.test.js`: 1 PCT SKU with DS01 sales over 10 dates, `pincodeConfig {mode:"shippingCode", map:{"560009":"DS08"}}`. Run `runEngine` twice: once with the base rows, and once adding 20 rows of that SKU at `ds:"HYDS01", pin:"560009"` on existing dates. Assert `JSON.stringify(a)===JSON.stringify(b)`. Second test: the same with a DC-only SKU (`move:"No"`, `inventorisedAt:"DC"`) and assert `res[sku].dc` is equal.
- [ ] **Step 2:** Run → FAIL (the DS08 store and the DC differ).
- [ ] **Step 3: Implement**: `inv = dropHydRows(inv);` as the first statement before `applyAttribution`, with a two-line comment citing the spec §4.2.
- [ ] **Step 4:** Run → PASS; `npm test` → all green.
- [ ] **Step 5: Inertness proof (Gate §5.1).**
  - `npx vite-node scripts/snapshot-engine-inputs.mjs $SP/snap.json`, where `$SP` is the session scratchpad.
  - `git stash` is not needed: use `git worktree add $SP/main-wt main`, then run `dump-engine-output.mjs` from the worktree and from the branch on the same snapshot.
  - `npx vite-node scripts/diff-engine-dumps.mjs main.dump.json branch.dump.json`.
  - Expected: `0 min/max · 0 tag-only` **unless** the snapshot holds HYDS01 rows. In that case, record every differing cell; each must trace to a HYDS01 row via attribution, the DC-only sum or the New DS Floor rank (spec §2), with **0 others**.
- [ ] **Step 6: Synthetic stress:** add DS08's last 14 days relabelled `HYDS01`/pin `500081` **on existing dates** to a copy of the snapshot, dump on the branch, and diff against the branch's dump of the original. Expected: **0/0**.
- [ ] **Step 7: Commit** `feat(engine): Bangalore engine drops Hyderabad rows before attribution`, with the diff results in the body.

### Task 4: Hyderabad floor parser

**Files:**
- Create: `src/hyd/hydFloors.js`, `src/hyd/hydFloors.test.js`

**Interfaces:**
- Produces: `parseHydFloorsCsv(text: string, opts:{dsList:string[], knownSkus:Set<string>}) → { ok:boolean, reason:"ok"|"header_mismatch"|"foreign_columns"|"invalid_value"|"empty", floors:{[sku]:{[ds]:{min,max}}}, skuCount, foreignColumns:string[], invalid:{sku,column,value}[], duplicateSkus:string[], unknownSkus:string[], blankSkuRows:number }`.
- Semantics are copied from `supabase/functions/_shared/skuFloorSheet.ts` (read it; **do not import or modify it**):
  - Required `SKU` header.
  - Store columns match `^(HYDS\d+)\s+(Min|Max)$`i.
  - **Any column matching `^(DS\d+|DC)\s+(Min|Max)$`i → `foreign_columns`, not ok.**
  - A `HYDSnn` column that isn't in `dsList` → `foreign_columns`.
  - Blank = 0. Only `^\d+$` is accepted; anything else goes in `invalid` → not ok.
  - Max raised to Min. Last row wins.
  - A SKU whose cells are all 0/0 is kept as `{}` (out of range).
  - `unknownSkus` = SKUs not in `knownSkus`. This is **reported, not refused**.

- [ ] **Step 1: Failing tests (one `it` each):**
  - Parses `SKU,Item Name,HYDS01 Min,HYDS01 Max\nA,x,2,5` → `floors.A.HYDS01` = `{min:2,max:5}`.
  - Max below Min: `A,,5,2` → `{min:5,max:5}`.
  - Blank cells → `floors.A = {}`.
  - Append rule: rows A 2/5 then A 0/0 → `floors.A = {}` and `duplicateSkus = ["A"]`.
  - `refuses DS01/DC columns`: a header with `DS01 Min` → `ok:false, reason:"foreign_columns", foreignColumns:["DS01 Min"]`.
  - `HYDS02 Min` with `dsList:["HYDS01"]` → `foreign_columns`.
  - `2.5` → `ok:false, reason:"invalid_value", invalid:[{sku:"A",column:"HYDS01 Min",value:"2.5"}]`.
  - `reports unknown SKUs`: SKU `ZZZ` not in `knownSkus` → `ok:true` and `unknownSkus = ["ZZZ"]`.
  - No SKU header → `header_mismatch`; empty text → `empty`.
  - A BOM and `\r\n` line endings parse.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Split CSV lines with the quote-aware `parseCSV` the app already uses (find it with `grep -n "export function parseCSV" src`). `Item Name` may contain commas.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(hyd): strict Hyderabad floor parser that refuses Bangalore columns`.

### Task 5: Hyderabad settings (a copy of Bangalore)

**Files:**
- Create: `src/hyd/hydParams.js`, `src/hyd/hydParams.test.js`

**Interfaces:**
- Produces:
  - `HYD_HIDDEN_KEYS = ["newDSList","openingDSList","pincodeConfig","dsCapacities","plywoodNetworkConfig","plywoodNetworkV2Config","activeDSCount"]`
  - `buildHydParamsFromBangalore(blrParams, nowIso) → hydParams`: a deep copy of `blrParams` minus the hidden keys, plus `{floorsOnly:{HYDS01:true}, orderCycleDays:3, copiedFromBangaloreAt: nowIso}`. `brandLeadTimeDays` is copied as is.
  - `mergeHydParams(defaults, stored) → hydParams`: a shallow merge, then `floorsOnly = {...defaults.floorsOnly, ...(stored?.floorsOnly||{})}`.
  - `isFloorsOnly(hydParams, ds) → boolean`: true unless `hydParams?.floorsOnly?.[ds] === false`.
  - `buildHydPlywoodFromBangalore(blrPlywoodNetworkConfig, blrNetworkConfigs) → {plywoodNetworkConfig, networkConfigs}`:
    - For every brand in the source, `nodes = {HYDS01:{covers:["HYDS01"]}}`, keeping `dcMultMin/Max`, and copying the top-level plywood params.
    - `networkConfigs = {HYDS01: deepCopy(blrNetworkConfigs.DS07 ?? blrNetworkConfigs.DS08), global: copy}`, with `HYDS01.thick.capacity=300` and `HYDS01.thin.capacity=150`.

- [ ] **Step 1: Failing tests:**
  - The copy drops every hidden key and keeps `pctDocCap`, `categoryStrategies` and `brandLeadTimeDays` deep-equal.
  - Mutating the copy doesn't mutate the source.
  - `missing floorsOnly means floors-only`: `isFloorsOnly({}, "HYDS01")===true`, `isFloorsOnly(null,"HYDS01")===true`, `isFloorsOnly({floorsOnly:{HYDS01:false}},"HYDS01")===false`.
  - `mergeHydParams(defaults, {floorsOnly:{}})` keeps `HYDS01:true`.
  - The plywood copy gives 4 brands, each with `Object.keys(nodes)` = `["HYDS01"]` and no `DC`.
  - Capacity 300/150, and the node settings deep-equal DS07's apart from capacity.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(hyd): Hyderabad settings and plywood config copied from Bangalore`.

### Task 6: Hyderabad engine pass

**Files:**
- Create: `src/hyd/hydEngine.js`, `src/hyd/hydEngine.test.js`

**Interfaces:**
- Consumes: `runEngine` (unchanged), `hydRowsOnly` (Task 2), `isFloorsOnly` (Task 5), `normalisePolicy`/`POLICY_NO` (`src/skuPolicy.js`).
- Produces:
  - `hydPurchaseOf(sku, {skuMaster, floors, floorsOnly}) → "Yes"|"No"`. This is spec §3.6's table, verbatim:
    - inactive → No
    - has a floor row with min or max > 0 → Yes
    - otherwise, floors-only → No
    - otherwise → `normalisePolicy(skuMaster[sku].purchase)`
  - `bufferTargets({min,max}, rate, leadTime, cycleDays) → {min,max}`:
    - `min1 = min + ceil(rate*leadTime)`
    - `max1 = max(max + ceil(rate*leadTime), min1 + ceil(rate*cycleDays))`
  - `runHydEngine({invoiceData, skuMaster, priceData, deadStock:Set, floors, hydParams, hydPlywood:{plywoodNetworkConfig, networkConfigs}}) → { results:{[sku]:{meta, stores:{HYDS01:{min,max,logicTag,source,engineMin,engineMax,floorMin,floorMax}}, dc:{min:0,max:0}}}, report:{inactiveFloored:string[], overrides:{sku,reason}[], outOfRangeSales:string[], unknownFloorSkus:string[]} }`
- The algorithm, which the signature doesn't determine:
  1. `windowDates` = the last `hydParams.overallPeriod` distinct dates of the **full** `invoiceData`.
  2. `rows` = `hydRowsOnly(invoiceData)` restricted to `windowDates`, each relabelled `ds:"DS01"`.
  3. `skuM2` = each master entry cloned with `move:"Yes"`, `purchase:"Yes"`, and `inventorisedAt:"DS"` when it isn't already (status kept).
  4. `p` = `{...hydParams, newDSList:[], openingDSList:[], pincodeConfig:{mode:"location",map:{}}, plywoodNetworkConfig: remap(hydPlywood.plywoodNetworkConfig, HYDS01→DS01), dsCapacities:{DS01:{thick:networkConfigs.HYDS01.thick.capacity, thin:networkConfigs.HYDS01.thin.capacity}}}`.
  5. `raw = runEngine(rows, skuM2, {}, priceData, new Set(), {}, p, {})`; `eng = raw[sku]?.stores?.DS01 ?? {min:0,max:0}`.
  6. `rate = Σqty(sku in rows) / overallPeriod`. Lead time is `brandLeadTimeDays[brand] ?? brandLeadTimeDays._default ?? 3`.
  7. `b = bufferTargets(eng, rate, lt, orderCycleDays)`.
  8. With `f` = the floor at HYDS01 (`hasFloor` = min or max > 0):
     - inactive (master `status` lowercased ≠ `"active"`, or missing from the master) → 0/0, logicTag `"Inactive in Zoho"`
     - else if floors-only → `hasFloor ? f : 0/0`
     - else if `!hasFloor` and (Purchase No, or `inventorisedAt` supplier, or `deadStock.has(sku)`) → 0/0
     - else → `{min:max(f.min,b.min), max:max(f.max,b.max)}`
     - Finally, Max ≥ Min.
  9. Report lists:
     - `inactiveFloored` = has a floor but inactive
     - `overrides` = has a floor and one of the flags (reason `"Purchase=OFF"|"Supplier"|"Dead Stock"`)
     - `outOfRangeSales` = SKUs with rows and a final 0/0 and no floor
     - `unknownFloorSkus` = floor SKUs absent from the master

- [ ] **Step 1: Failing tests (`it` names):**
  - `floors-only target equals the floor`: floor 2/5, sales 30 units → `stores.HYDS01` `{min:2,max:5}`.
  - `floors-only, sold but no floor → 0/0` and it appears in `report.outOfRangeSales`.
  - `engine mode lifts above the floor`: with `floorsOnly:{HYDS01:false}`, a Standard SKU with heavy sales gets a final ≥ floor and ≥ the buffered engine number.
  - `floor beats Purchase=OFF / Supplier / Dead Stock` (3 cases) and each appears in `report.overrides`.
  - `engine-only SKU with Purchase=OFF → 0/0`.
  - `inactive with floor → 0/0`, listed in `inactiveFloored`.
  - `bufferTargets({min:2,max:3}, 0.5, 3, 3)` → `{min:4,max:6}`; `bufferTargets({min:5,max:20}, 0.5, 3, 3)` → `{min:7,max:22}`.
  - `window follows network dates`: Pati rows only on the 2 oldest of 50 network dates with `overallPeriod 45` → those rows are excluded and the rate is 0.
  - `ignores Bangalore rows`: adding DS01 rows changes nothing in the output.
  - `unknown sku gets no target`: a floor on `ZZZ` (not in the master) → absent from `results`, present in `unknownFloorSkus`.
  - `plywood has no DC`: a Plywood SKU (categoryStrategies network_design) in engine mode → `dc` is `{min:0,max:0}` and `stores.HYDS01` comes from the network.
  - `hydPurchaseOf` table: 4 rows exactly as in the spec.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS; `npm test` green.
- [ ] **Step 5: Real-data check (read-only):** a scratch script loads the frozen snapshot and runs `runHydEngine` with `floors` from the operator's Hyderabad CSV (if provided; otherwise from 20 synthetic floor rows). Print the count of SKUs in range, the report lists, and the time taken. Expected: it runs in < 3s and every floored active SKU equals its floor.
- [ ] **Step 6: Commit** `feat(hyd): Hyderabad engine pass (floors-only/engine switch, buffer, sheet-wins flags)`.

### Task 7: Hyderabad PO CSV

**Files:**
- Create: `src/hyd/hydPoCsv.js`, `src/hyd/hydPoCsv.test.js`

**Interfaces:**
- Consumes: `normaliseStatus` (`src/skuStatus.js`), `hydPurchaseOf` (Task 6). Row order and CSV escaping **mirror `buildPoTargetsCsv` (`src/poTargetsCsv.js:112`)**. Reuse its escape helper if one is exported; otherwise copy it verbatim.
- Produces: `HYD_PO_CSV_HEADERS` (exactly as in Global Constraints); `buildHydPoCsv({skuMaster, hydResults, floors, hydParams}) → string`; `hydPoCsvFilename(dateIso) → "PO_Hyderabad_<YYYY-MM-DD>.csv"`.

- [ ] **Step 1: Failing tests:**
  - Header equals the literal 9 names.
  - Every master SKU appears exactly once.
  - Each row has exactly 9 columns, including an item name containing a comma and a quote.
  - An out-of-range SKU reads `0,0`.
  - A floored Purchase=OFF SKU reads `Purchase` = `Yes`.
  - Filename format.
  - `PO_CSV_HEADERS` from `src/poTargetsCsv.js` still deep-equals its current value (snapshot of today's array). This pins Bangalore as untouched.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(hyd): Hyderabad PO CSV (frozen 9-column header)`.

### Task 8: Hyderabad storage (load/save new rows only)

**Files:**
- Create: `src/hyd/hydStore.js`, `src/hyd/hydStore.test.js`

**Interfaces:**
- Consumes: `loadFromSupabase`, `saveToSupabase` (`src/supabase.js`), the Task 5 builders.
- Produces:
  - `loadHydState(blrParams, blrPlywoodRows:{plywoodNetworkConfig, networkConfigs}) → Promise<{floors, floorsUploadedAt, hydParams, hydPlywood, stored:{params:boolean, plywood:boolean}}>`. Missing rows fall back to the Task 5 builders applied to the Bangalore values.
  - `saveHydFloors(floors) → Promise` writes `team_data/hyd_inputs` = `{floors, uploadedAt}`.
  - `saveHydParams(hydParams)` writes `params/hydGlobal`.
  - `saveHydPlywood({plywoodNetworkConfig, networkConfigs})` writes `params/hydPlywoodNetworkConfig` and `params/hydNetworkConfigs`.
  - **No function here writes any other row**, and the test asserts it.

- [ ] **Step 1: Failing tests** with `vi.mock("../supabase.js")`:
  - Each save calls `saveToSupabase` only with its own `(table,id)` pairs.
  - `loadHydState` with all rows missing returns `floorsOnly.HYDS01 === true` and plywood nodes `["HYDS01"]`.
  - With a stored `hydGlobal {floorsOnly:{HYDS01:false}}`, `isFloorsOnly` is false.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(hyd): Hyderabad rows — load/save, own rows only`.

### Task 9: City switch in the app shell

**Files:**
- Modify: `src/App.jsx`. Header `:2636-2648`; tabs `:2622-2624`; tab renders `:3169-4181`; `attributedInvoice` `:2560`; the overview render `:3180`.
- Create: `src/tabs/hyd/HydShell.jsx` (renders Hyderabad tabs; it receives everything it needs as props)

**Interfaces:**
- Consumes: `readInitialCity`, `persistCity`, `dropHydRows` (Task 2); `loadHydState` (Task 8); `runHydEngine` (Task 6).
- Produces: App state `city`; `HydShell` props `{tab, isAdmin, invoiceData, skuMaster, priceData, deadStock, stockData, stockDataAccounting, uploadedAtPerDS, hydState, setHydState, hydRun}`, where `hydRun = {results, report}`.

- [ ] **Step 1: Header.**
  - Next to `<HomeRunLogo/>`, render a button labelled `· BANGALORE ▾` / `· HYDERABAD ▾`, styled per Global Constraints. Clicking it toggles the city.
  - The header background and border follow the city tint.
  - `document.title = "IMS · Hyderabad"` / `"IMS · Bangalore"`.
  - `?city=` is written with `history.replaceState`, and the city is persisted.
- [ ] **Step 2: Tabs.**
  - Hyderabad tabs are `overview, skuDetail, stockHealth, output, plywood`, plus `upload, logic` for admins.
  - When switching city to one where the current tab isn't offered, go to `overview`.
  - **If `changedCount > 0`, block the switch** with `alert("Apply or discard your Bangalore Logic Tweaker changes first.")`.
- [ ] **Step 3: Bangalore props.** `const blrInvoice = useMemo(() => dropHydRows(invoiceData), [invoiceData])`. Use it in `attributedInvoice` and in the `OverviewTab`/`BasketAnalysisTab`/`PlywoodNetworkTab` `invoiceData` props. The engine call sites stay as they are; Task 3 filters inside `runEngine`.
- [ ] **Step 4: Lazy Hyderabad.**
  - On the first switch to Hyderabad, `loadHydState(params, {plywoodNetworkConfig: params.plywoodNetworkConfig, networkConfigs})`.
  - `hydRun = useMemo(() => city==="hyd" && hydState ? runHydEngine({...}) : null, [...])`.
  - In Bangalore, **none of this runs**.
- [ ] **Step 5: Render.** When `city==="hyd"`, render `<HydShell …/>` in place of the Bangalore tab bodies. Bangalore's render tree is otherwise untouched.
- [ ] **Step 6: Verify.**
  - `npm run build` → success; `npm test` → green.
  - `VITE_READ_ONLY=1 npm run dev`, then manually check that Bangalore looks identical to prod (header tint aside), switching city works, and `?city=hyd` deep-links.
  - Switching with an unsaved tweak is blocked.
- [ ] **Step 7: Commit** `feat: city switch (header label + tint) with lazy Hyderabad shell`.

### Task 10: Hyderabad tabs

**Files:**
- Create in `src/tabs/hyd/`:
  - `HydUploadPanel.jsx`
  - `HydToolOutput.jsx`
  - `HydOverview.jsx`
  - `HydSkuDetail.jsx`
  - `HydLogicTweaker.jsx`
  - `HydPlywoodPanel.jsx`
- Each is wired into `HydShell.jsx`.

**Interfaces:**
- Consumes: Tasks 4–8.
- What each tab does:
  - **Upload** (admin):
    - File input → `parseHydFloorsCsv` (with `knownSkus` from the master).
    - The preview shows the SKU count, unknown SKUs, duplicates, invalid cells, and `report.inactiveFloored`/`overrides` from a dry `runHydEngine` with the new floors.
    - On refusal, it shows the reason and the columns, with no write.
    - The confirm button reads `Replace HYDERABAD floors` with the subtext `Bangalore floors are not touched.`; it calls `saveHydFloors` and refreshes `hydState`.
    - It also offers a template download (`SKU,Item Name,Category,HYDS01 Min,HYDS01 Max`).
  - **Tool Output:** one PO card → `buildHydPoCsv` → `downloadCsvFile(hydPoCsvFilename(today), csv)`. Use the existing helper `App.jsx:118`, moved to export or passed as a prop.
  - **Overview:**
    - KPI cards: SKUs in range, floor rows, Inv Value Min/Max at HYDS01 (priced with `priceData` the same way the Bangalore KPI does), Pati units sold in the last 7 and 30 days, and mode `Floors only`/`Engine`.
    - Then the four report lists, collapsible.
  - **SKU Detail:** search box → for one SKU, show floor, engine number, buffered number, final, `logicTag`, `hydPurchaseOf`, and Pati daily sales over the window (a simple table).
  - **Logic Tweaker** (admin):
    - The switch `Pati: Floors only ⇄ Engine` (with a confirm when switching to Engine).
    - Inputs: order cycle days, lead time per brand (`brandLeadTimeDays`), category strategies (dropdowns with the same options as Bangalore's), plus a generic editor for the remaining numeric params (key/value rows, nested objects flattened as `a.b`).
    - `Copied from Bangalore on <date>` text and a `Reset to Bangalore's current values` button (with a confirm).
    - `Apply (Hyderabad)` → `saveHydParams`. Bangalore's Apply isn't rendered here.
  - **Plywood:**
    - The brand list with on/off for HYDS01. **Off** means removing `HYDS01` from `nodes` for that brand.
    - Thick/thin capacity inputs; a red `0 = no cap` warning when ≤ 0.
    - The global plywood params editor.
    - `Save (Hyderabad)` → `saveHydPlywood`.
- [ ] **Step 1:** Build Upload + Tool Output. Manual check in read-only mode with a sample CSV: a Bangalore floor CSV is refused, and a valid one shows the preview and the blocked-write banner increments.
- [ ] **Step 2:** Build Overview + SKU Detail. Manual check: the numbers match the Task 6 Step 5 scratch output.
- [ ] **Step 3:** Build Logic Tweaker + Plywood. Manual check: toggling to Engine changes the Overview/PO numbers in memory; Reset restores the Bangalore values; saves are blocked in read-only.
- [ ] **Step 4:** `npm run build` + `npm test` green.
- [ ] **Step 5: Commit** `feat(hyd): Hyderabad tabs — upload, PO output, overview, SKU detail, settings, plywood`.

### Task 11: Stock Health for Pati

**Files:**
- Modify: `src/tabs/StockHealthTab.jsx`. Props at `:203`; `DS_AND_DC` `:32`; `SYNC_GROUPS` `:23`; default `selectedDS` `:206`; filenames `:1028`, `:1085`.
- Wire into `src/tabs/hyd/HydShell.jsx`.

**Interfaces:**
- New **optional** props, each with a default equal to today's constant:
  - `dsList = DS_LIST`
  - `includeDC = true`
  - `syncGroups = SYNC_GROUPS`
  - `defaultDS = "DS01"`
  - `filePrefix = ""` (prepended to both filenames, e.g. `"Hyderabad_"`)
- Bangalore's call site passes **none** of them.
- Hyderabad passes `results={hydRun.results}`, `dsList={HYD_DS_LIST}`, `includeDC={false}`, `syncGroups={[["HYDS01"]]}`, `defaultDS="HYDS01"`, `filePrefix="Hyderabad_"`.

- [ ] **Step 1:** Implement the props. Every internal use of `DS_LIST`, `DS_AND_DC` and `SYNC_GROUPS` reads the prop instead. With `includeDC=false`, the DC tab and the DC-only columns and helpers (DC stock indicator, DS Req Covered, reverse TO) are hidden.
- [ ] **Step 2: Verify Bangalore unchanged.** In read-only dev, compare Bangalore Stock Health with prod on 3 stores (DS01, DS08, DC) by KPI cards and the first 20 rows, and download the CSV from both and `diff` them. Expected: identical (allowing for a stock sync between the two loads; re-download if the times differ).
- [ ] **Step 3:** Hyderabad Stock Health renders HYDS01 with targets. Stock shows empty until stock sync is live (Task 12, after deploy).
- [ ] **Step 4: Commit** `feat: Stock Health takes an optional store list; Hyderabad view for HYDS01`.

### Task 12: sync-stock + cron for HYDS01 (code only, NOT deployed)

**Files:**
- Modify: `supabase/functions/sync-stock/index.ts` (`BRANCHES` `:6-18`, default at `:182-185`)
- Create: `supabase/migrations/<YYYYMMDDHHMMSS>_stock_sync_5_add_hyds01.sql` (**not applied**)
- Test: `supabase/functions/_shared/stockBranches.test.ts`, with the logic extracted to `supabase/functions/_shared/stockBranches.ts`

**Interfaces:**
- Produces: `resolveBranches(requested: unknown, branches: Record<string,string>, explicitOnly: Set<string>) → string[]`. A non-empty array is filtered to known keys; otherwise it's `Object.keys(branches)` minus `explicitOnly`. `EXPLICIT_ONLY = new Set(["HYDS01"])`. `BRANCHES.HYDS01 = '3915979000169622634'` with a comment saying the Zoho name is `HYDS01 Pati`.

- [ ] **Step 1: Failing tests:**
  - An empty body gives exactly today's 9 keys (literal list `DC, DS01…DS08`).
  - `["DS08","HYDS01"]` → both.
  - `["HYDS01"]` → `["HYDS01"]`.
  - `["XX"]` → `[]`.
- [ ] **Step 2–4:** FAIL → extract + implement → PASS (`npm test`).
- [ ] **Step 5: Migration file.** `select cron.alter_job(job_id := (select jobid from cron.job where jobname='stock-sync-5'), command := <same command with body {"branches":["DS08","HYDS01"]}>)`. Copy the existing command text **from the `20260925000001` migration** and change only the branches array. Add a header comment: `-- NOT APPLIED. Apply only after sync-stock is deployed and a manual HYDS01 run is verified (spec §6.3).`
- [ ] **Step 6: Commit** `feat(sync-stock): HYDS01 branch, explicit-only (not deployed); cron migration staged`.

### Task 13: Final gates and docs

**Files:**
- Modify: `src/tabs/CLAUDE.md` (the PO header now really ends `… · Purchase · Move`; add a Hyderabad PO file section), `src/engine/CLAUDE.md` (the Hyderabad row filter + the remap engine), root `CLAUDE.md` (a Hyderabad line under the store universe + new rows; an Open Work index entry **#44**: `sync-invoices` `writeRow` swallows errors, from 2026-11-08), `docs/OPEN-WORK.md` (#44 full entry).

- [ ] **Step 1: Gate 5.1.** Re-run Task 3 Steps 5–6 on a **fresh** snapshot at the branch head. Expected as before.
- [ ] **Step 2: Gate 5.3.** Bangalore PO CSV byte-identical. In both worktrees, run a scratch script that calls `buildPoTargetsCsv` on the dumps' results, then `cmp`. Also run `npx vite-node scripts/verify-po-csv.mjs` → green.
- [ ] **Step 3: Gate 5.4.** `toTargets` identical: build `buildToTargets` from both dumps' results (as `scripts/diff-headless-totargets.mjs` does) → 0 SKUs differing.
- [ ] **Step 4:** `npm test` all green; `npm run build` OK; `node scripts/check-claude-md.mjs` OK.
- [ ] **Step 5: Commit** `docs: Hyderabad HYDS01 in CLAUDE.md files; open-work #44`.
- [ ] **Step 6: Hand to the operator.** Branch name, the gate outputs, the local test command (`VITE_READ_ONLY=1 npm run dev`) and a checklist (Bangalore first, then Hyderabad). **Stop. No push, no deploy.**
