# Hyderabad Identical UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hyderabad renders Bangalore's own screens (Overview, SKU Detail, Tool Output, Logic Tweaker, Upload Data) with a store list, so the tool looks the same in both cities. Bangalore's behaviour does not change.

**Architecture:**
- Components already defined in `App.jsx` (Overview, SKU Detail) gain optional store-list props whose defaults are today's constants. This is the Stock Health pattern.
- Inline `App.jsx` tab bodies (Tool Output, Logic Tweaker, Upload Data) are extracted in two commits:
  1. A **pure move** into `src/tabs/<Name>Tab.jsx`, verified text-identical.
  2. **Hyderabad props**, each with a default equal to today's behaviour.
- `HydShell` then renders these shared components with Hyderabad data, and the bespoke `src/tabs/hyd/Hyd*` screens they replace are deleted.

**Tech Stack:** React + Vite, vitest (`npm test`), react-dom/server render-smoke tests (no jsdom/testing-library).

**Spec:** `docs/superpowers/specs/2026-11-10-hyderabad-hyds01-design.md`, §9 (addendum), plus §3–§4.

## Global Constraints

- Same binding constraints as the first build: no push or deploy; no Supabase writes; `npm run dev` is not run (the operator tests with `VITE_READ_ONLY=1`); `runEngine`, `plywoodNetwork.js`, `DS_LIST`, `PO_CSV_HEADERS`, `BROWSER_OWNED_KEYS` and the Bangalore floor parsers are unchanged.
- **Every pure-move commit is proven text-identical.** A scratch script extracts the old block from `git show <base>:src/App.jsx` and the new component's returned JSX/body. It strips leading whitespace on each line, then diffs. The only allowed differences are the component wrapper (`export default function X({...}) {` / `return (` … `)`), the props destructure, and `import` lines. Record the exact diff output in the report.
- **Every props commit is proven to leave Bangalore unchanged.** Server-render the component with Bangalore's props on a fixture before and after, and require byte-identical HTML. If server render is impossible for a block (e.g. hooks needing App state), the proof is a code-level audit listing every prop default and why it resolves to today's value.
- Bangalore call sites pass **no new props**.
- Hyderabad never writes a Bangalore row. Hyderabad Apply writes only `params/hydGlobal` (via `saveHydParams`); the Hyderabad floor upload writes only `team_data/hyd_inputs` (via `saveHydFloors`).
- The Hyderabad store list is `HYD_DS_LIST = ["HYDS01"]` with no DC. Hyderabad invoice data comes from `hydRowsOnly(invoiceData)` (`src/city.js`).
- Hyderabad read failure (`hydReadFailed(hydState)`) still disables the PO download, the floor Replace action and Apply, as in the first build.

## Review Focus

1. **A Bangalore Apply after visiting Hyderabad** must write exactly the same rows as today. The extracted Logic Tweaker must not capture Hyderabad's `onApply` in Bangalore. → Task 3 test: render the component in Bangalore mode and assert that `onApply` is App's `applyAndRun`, wired by the call site, unchanged.
2. **Unsaved Hyderabad settings when switching tab or city** must prompt rather than vanish silently. Bangalore already has a modal for this. → Task 3 step.
3. **The template download with 0 out-of-range SKUs**: the button is hidden, never an empty file. → Task 4 test.
4. **The Hyderabad Overview store picker** must not offer "DC" or "All Locations (incl. DC)". → Task 1 test.
5. **Hyderabad PO card** must use `buildHydPoCsv` / `hydPoCsvFilename`, never `buildPoTargetsCsv`. → Task 2 test.

---

### Task 1: Overview + SKU Detail take a store list; Hyderabad uses them

**Files:**
- Modify: `src/App.jsx`: `OverviewTab` (~:1409-1750) and `SKUDetailTab` (~:1030-1407), plus helpers they use (`SD_DS_OPTS` ~:772, `getInv`, `computeInvValue` call, `DS_COLOR` use).
- Modify: `src/invValue.js` only if needed for an `includeDC` option (default `true`, unchanged).
- Modify: `src/tabs/hyd/HydShell.jsx`. Delete: `src/tabs/hyd/HydOverview.jsx`, `src/tabs/hyd/HydSkuDetail.jsx` (and their pure helpers if unused).
- Test: `src/tabs/OverviewSkuDetail.test.jsx`.

**Interfaces:**
- Produces: optional props on both components, `dsList = DS_LIST`, `includeDC = true`, `openingList` (SKU Detail; default = today's `params.openingDSList ?? OPENING_DS_DEFAULT` derivation; Hyderabad passes `[]`).
- Hyderabad call: `invoiceData={hydRowsOnly(invoiceData)}`, `results={hydRun.results}`, `params={hydState.hydParams}`, `dsList={HYD_DS_LIST}`, `includeDC={false}`, plus the same period/store/drill state, which HydShell keeps in local state.

- [ ] **Step 1:** Commit 1: add `export` to `OverviewTab` and `SKUDetailTab` only (needed to render them in tests). No other change. `npm test` green.
- [ ] **Step 2:** Capture the baseline. A scratch script server-renders both components with Bangalore props on a small fixture (8 stores + DC, a few SKUs), covering the store picker on "All", on "DS01", and on "DC". Save the HTML.
- [ ] **Step 3:** Add the props, replacing every hardcoded `DS_LIST`/DC use the exploration listed (~8 sites in Overview, ~7 in SKU Detail). Give HYDS01 a colour (`#1F5FA8`).
- [ ] **Step 4:** Re-render the baseline cases: byte-identical. Add `OverviewSkuDetail.test.jsx`, which checks the Bangalore render contains "All Locations (incl. DC)"; the Hyderabad render (`dsList ["HYDS01"]`, `includeDC false`) has no "DC" option, shows HYDS01, and has no DC card in SKU Detail.
- [ ] **Step 5:** Wire HydShell, delete the replaced Hyderabad screens, and move any still-needed helper. `npm test` + `npm run build`.
- [ ] **Step 6:** Commit `feat: Overview/SKU Detail take a store list; Hyderabad renders Bangalore's screens`.

### Task 2: Tool Output Download extracted; Hyderabad uses it

**Files:**
- Create: `src/tabs/ToolOutputTab.jsx`.
- Modify: `src/App.jsx`: the inline Tool Output body (~:3316-3560). App renders `<ToolOutputTab …/>` with the ~13 names it closes over passed as props.
- Modify: `src/tabs/hyd/HydShell.jsx`. Delete: `src/tabs/hyd/HydToolOutput.jsx`.
- Test: `src/tabs/ToolOutputTab.test.jsx`.

**Interfaces:**
- Hyderabad props (added in Commit 2): `dsList = <today's>`, `includeDC = true`, `poCard` (optional override `{ build: () => csv|null, filename: () => string, note }`). When `includeDC` is false, the DC card and the Inner Case Pack - Mid Mile card are hidden. The DS Level CSV uses `dsList`.
- Hyderabad passes `poCard` built from `buildHydPoCsv({skuMaster, hydResults, floors, hydParams})` and `hydPoCsvFilename(today)`. The PO download is disabled while `hydReadFailed`.

- [ ] **Step 1:** Commit 1 is a **pure move**. Run the text-identical proof (Global Constraints). `npm test` + `npm run build`. Commit `refactor: extract Tool Output Download into ToolOutputTab (pure move)`.
- [ ] **Step 2:** Commit 2 adds the Hyderabad props. Bangalore audit: every default equals today's value; a server render of `ToolOutputTab` with Bangalore props is byte-identical before and after this commit.
- [ ] **Step 3:** Tests: Bangalore render has the DC card and Inner Case Pack card. Hyderabad render has neither, its PO card label/filename comes from `poCard`, and the PO button is disabled when read failed.
- [ ] **Step 4:** Wire HydShell; delete `HydToolOutput.jsx`. `npm test` + build. Commit `feat: Hyderabad Tool Output renders the shared ToolOutputTab`.

### Task 3: Logic Tweaker extracted; Hyderabad uses it

**Files:**
- Create: `src/tabs/LogicTweakerTab.jsx`.
- Modify: `src/App.jsx`: the inline Logic Tweaker body (~:3575-4254). App renders `<LogicTweakerTab …/>` with the ~16 names passed as props (`params`, `savedParams`, `saveParams`, `setParams`, `applyAndRun` → `onApply`, `hasChanges`, `handlePincodeMap`, `blrInvoice`, `skuMaster`, `uploading`, `advancedOpen`/`setAdvancedOpen`, `showLogicConfirm`/`setShowLogicConfirm`, `isAdmin`).
- Modify: `src/tabs/hyd/HydShell.jsx`. Delete: `src/tabs/hyd/HydLogicTweaker.jsx`, `src/tabs/hyd/HydParamEditor.jsx` (keep pure helpers still used elsewhere).
- Test: `src/tabs/LogicTweakerTab.test.jsx`.

**Interfaces:**
- Hyderabad props (Commit 2):
  - `showNetworkSections = true`. When false, hide: New Dark Store Logic, Store Status (`openingDSList`), Demand Attribution / pincode map, Dead Stock DC Multiplier, SKU Floor DC Multipliers, the plywood non-network strategy picker, and the changelog lines for those keys.
  - `topSlot` (optional node, rendered above the first section).
  - `leadTimeLabel` (default today's "Brand Lead Time (DC)"; Hyderabad: "Brand Lead Time (vendor → Pati)").
- Hyderabad passes:
  - `params` = the Hyderabad draft; `savedParams` = `hydState.hydParams`.
  - `saveParams` = the draft setter; `setParams` = draft reset; `hasChanges` = draft ≠ saved.
  - `onApply` = Hyderabad apply. Confirm when `!hydState.stored.params` (the existing NOT_SAVED_BEFORE text), then `saveHydParams`, then `setHydState`. Disabled when `hydReadFailed`.
  - `topSlot` = the Floors only ⇄ Engine switch with its dry-run impact confirm (reuse `engineFlipImpact`), the order cycle input, "Copied from Bangalore on <date>" and "Reset to Bangalore's current values" (reuse the existing logic from `HydLogicTweaker`).

- [ ] **Step 1:** Commit 1 is a **pure move** with the text-identical proof. `npm test` + build. Commit `refactor: extract Logic Tweaker into LogicTweakerTab (pure move)`.
- [ ] **Step 2:** Commit 2 adds the props. Bangalore audit: defaults reproduce today's sections and labels; App's call site passes `onApply={applyAndRun}` and no new props.
- [ ] **Step 3:** Tests:
  - Bangalore render contains "New Dark Store Logic", "Demand Attribution" and "Brand Lead Time (DC)".
  - Hyderabad render (`showNetworkSections false`) contains none of the network sections, but does contain the PCT and Fixed Unit Floor sections, the vendor lead-time label and the `topSlot` content.
  - A unit test that Hyderabad apply calls `saveHydParams` only (mocked `saveToSupabase` sees only `params/hydGlobal`).
- [ ] **Step 4:** Unsaved Hyderabad draft guard. Switching Hyderabad tab or city while the draft is dirty shows `confirm("You have unsaved Hyderabad settings. Discard them?")`. Cancel keeps the user where they are. Bangalore's existing guard is unchanged.
- [ ] **Step 5:** Wire HydShell; delete the replaced files. `npm test` + build. Commit `feat: Hyderabad Logic Tweaker renders the shared LogicTweakerTab`.

### Task 4: Upload Data extracted; Hyderabad floors card with the three lists

**Files:**
- Create: `src/tabs/UploadDataTab.jsx`.
- Modify: `src/App.jsx`: the inline Upload Data body (~:2803-3242), with its ~36 names passed as props (handlers stay defined in App.jsx).
- Create: `src/tabs/hyd/HydFloorsCard.jsx` (the Hyderabad floors card in the shared card style; it absorbs `HydUploadPanel`'s parse → preview → confirm → `saveHydFloors` flow).
- Modify: `src/tabs/hyd/HydShell.jsx`. Delete: `src/tabs/hyd/HydUploadPanel.jsx`, `src/tabs/hyd/HydStockNotice.jsx` and HydShell's notice rendering above Stock Health.
- Create: `src/hyd/hydFloorTemplate.js` (pure) + test.
- Test: `src/tabs/UploadDataTab.test.jsx`.

**Interfaces:**
- `UploadDataTab` Hyderabad props (Commit 2):
  - `mode = "blr"`. In `"hyd"` mode the shared/Bangalore cards (invoice, SKU master, MRQ, price, dead stock, ceilings, floors) render in the same card style, disabled, with the note "Shared — managed in Bangalore", and no file inputs.
  - `extraCards` (nodes rendered first).
  - Hyderabad passes `mode="hyd"` and `extraCards={<HydFloorsCard …/>}`.
- `buildOutOfRangeTemplate(skus: string[], skuMaster) → string|null`. Header `SKU,Item Name,Category,HYDS01 Min,HYDS01 Max`; one row per SKU with name/category and blank Min/Max; `null` when `skus` is empty. Filename `Hyderabad_floors_to_fill_<YYYY-MM-DD>.csv`.
- `HydFloorsCard` shows:
  - SKUs in range, and uploaded-at.
  - ⚠ "N SKUs sold at Pati have no floor" + `⬇ Download as floor template` (hidden when N = 0).
  - ⚠ "N floor SKUs are inactive in Zoho" (expandable list).
  - ℹ "N floor SKUs override Bangalore flags" (deduped, expandable).
  - The upload button, preview and confirm, with the exact texts from the first build ("Replace HYDERABAD floors" / "Bangalore floors are not touched."). Replace is disabled when read failed.

- [ ] **Step 1:** Commit 1 is a **pure move** with the text-identical proof. `npm test` + build. Commit `refactor: extract Upload Data into UploadDataTab (pure move)`.
- [ ] **Step 2:** Commit 2 adds the props + Bangalore audit (default `mode "blr"` reproduces today exactly; App passes no new props).
- [ ] **Step 3:** Template module with TDD:
  - 2 SKUs → header + 2 rows with names and categories, blank Min/Max.
  - Empty → `null`.
  - A name with a comma is quoted.
  - The result round-trips through `parseHydFloorsCsv` with `ok:true` and both SKUs present as `{}` (out of range until filled).
- [ ] **Step 4:** `HydFloorsCard` plus tests:
  - The card shows the three counts.
  - The template button is absent when there are 0 out-of-range SKUs.
  - The UploadDataTab Hyderabad render shows "Shared — managed in Bangalore" on the shared cards and has no file inputs on them.
  - Bangalore render unchanged (the existing card titles are present).
- [ ] **Step 5:** Remove the Stock Health notice. Wire HydShell; delete replaced files. `npm test` + build. Commit `feat: Hyderabad Upload Data renders the shared UploadDataTab; floor-sheet lists on the floors card`.

### Task 5: Hyderabad Plywood restyled

**Files:**
- Modify: `src/tabs/hyd/HydPlywoodPanel.jsx` (+ `hydStyles.js` if needed).

- [ ] **Step 1:** Restyle using the same visual vocabulary as Bangalore's Plywood tab: section headers, cards, tables, buttons and input styles (read `src/tabs/PlywoodNetworkTab.jsx` for its style objects; import shared ones if exported, otherwise mirror them). Behaviour and saves are unchanged.
- [ ] **Step 2:** Existing HydShell tests green; `npm run build`. Commit `style: Hyderabad Plywood panel matches Bangalore's look`.

### Task 6: Final gates and docs

- [ ] **Step 1:** Re-run the first build's Gates 5.1/5.3/5.4 on a fresh read-only snapshot (engine main vs branch, PO CSV, toTargets). Expected: the same single HVS7M DC cell traced to a Pati row; byte-identical when HYDS01 rows are stripped.
- [ ] **Step 2:** `npm test`, `npm run build`, `node scripts/check-claude-md.mjs`.
- [ ] **Step 3:** Docs: `src/tabs/CLAUDE.md` gets the new shared components, their Hyderabad props, and the rule "Bangalore call sites pass no new props; extract by pure move first". Root `CLAUDE.md` gets the one-line note that Hyderabad renders the shared tab components. Commit `docs: shared tab components serve both cities`.
