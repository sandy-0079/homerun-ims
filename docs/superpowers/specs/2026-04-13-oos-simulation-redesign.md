# OOS Simulation Redesign — Design Spec

**Date:** 2026-04-13
**Status:** Approved

---

## Goal

Redesign the OOS Simulation tab to replace the "Last N days" slider with a date range picker, and add a new "Fresh CSV" simulation mode with two sub-modes: Ideal Restock and Actual Stock (single-day with root cause classification).

---

## Section 1: Overall Layout & Mode Toggle

Top bar — always visible:

```
[ Loaded Data ]  [ Fresh CSV ]                    DS Filter: [All ▼]
```

- Mode toggle on the left, DS filter on the right
- DS filter applies in both modes
- Switching modes preserves results in state (hidden, not destroyed) — switching back does not require a re-run
- Uploaded fresh CSV is kept in session state across mode switches — no re-upload needed

---

## Section 2: Loaded Data Mode

Replaces the current "Last N days" input with a preset bar + date picker:

```
[ L45D ]  [ L30D ]  [ L15D ]  [ L7D ]  [ L3D ]  [ 📅 From: __ To: __ ]
```

- Active preset highlighted (yellow, matching Overview tab style)
- Selecting a preset immediately triggers a re-run
- Selecting the date picker reveals From/To date inputs, clamped to the loaded invoice date range
- Run triggers on blur/Enter for date inputs — not on every keystroke
- Default on first load: **L15D**
- Selecting either date input deselects the active preset
- All other UI (DS filter, org → category → brand drill-down, OOS % badge, override comparison) unchanged from today

---

## Section 3: Fresh CSV Mode

### 3a. Upload Section

Two cards at the top, always visible:

**Invoice CSV card** (always required):
- Upload button + filename display once uploaded
- Label: "Temporary — won't replace loaded data"

**DS Stock CSVs card** (required for Actual Stock only, greyed out in Ideal Restock):
- 5 upload buttons: DS01, DS02, DS03, DS04, DS05
- Each shows ✅ / ⬜ status indicator and filename once uploaded
- Same Inventory Summary CSV format as Stock Health tab

### 3b. Sub-mode Selector + Date Controls

```
Simulation type:  ● Ideal Restock   ○ Actual Stock (single day)
```

**Ideal Restock controls:**
```
[ L45D ]  [ L30D ]  [ L15D ]  [ L7D ]  [ L3D ]  [ 📅 From: __ To: __ ]
```

**Actual Stock controls:**
```
[ 📅 Simulate date: _______ ]
```

- Switching sub-mode greys out / enables the DS Stock card accordingly
- Run button appears only when all required inputs are satisfied:
  - Ideal Restock: Invoice CSV + date range
  - Actual Stock: Invoice CSV + all 5 DS stock CSVs + single date

### 3c. Results Display

**Ideal Restock results:** Identical to Loaded Data mode — org → category → brand drill-down, OOS % badge, failing SKU count.

**Actual Stock results:**

Root cause summary strip above the drill-down:

```
┌─ Ops Failure ──┐  ┌─ Tool Failure ─┐  ┌─ Unstocked ────┐  ┌─ Could Have Been Saved ┐
│  12 instances  │  │  5 instances   │  │  3 SKUs        │  │  2 instances           │
│ DC didn't send │  │ Min/Max too low│  │  Min=Max=0     │  │  TO was close          │
└────────────────┘  └────────────────┘  └────────────────┘  └────────────────────────┘
```

- Clicking a cell filters the drill-down to show only SKUs with that root cause
- Drill-down adds a "Root Cause" column
- DC excluded from simulation entirely in Actual Stock mode

---

## Section 4: Data Flow & State

### New State Variables

| State | Type | Purpose |
|---|---|---|
| `simMode` | `"loaded" \| "fresh"` | Active top-level mode |
| `simSubMode` | `"ideal" \| "actual"` | Fresh CSV sub-mode |
| `simPreset` | `"L45D" \| "L30D" \| "L15D" \| "L7D" \| "L3D" \| "custom"` | Active preset in Loaded Data and Ideal Restock |
| `simDateFrom` | string (YYYY-MM-DD) | Custom range start |
| `simDateTo` | string (YYYY-MM-DD) | Custom range end |
| `simSingleDate` | string (YYYY-MM-DD) | Actual Stock simulation date |
| `freshInvoiceData` | row array | Parsed rows from uploaded fresh invoice CSV (session only) |
| `freshInvoiceFile` | string | Filename for display |
| `dsStockData` | `{DS01: [...], ...}` | Opening stock rows from 5 uploaded DS CSVs |
| `dsStockFiles` | `{DS01: filename, ...}` | Filenames for display |
| `rootCauseFilter` | `null \| "ops_failure" \| "tool_failure" \| "unstocked" \| "could_have_saved"` | Active root cause filter |

### simWorker.js Changes

**Loaded Data + Ideal Restock:** Same simulation logic as today. Change: date filter switches from `slice(-N days)` to filtering by `simDateFrom`/`simDateTo`.

**Actual Stock:** New message type. Receives `{freshInvoiceData, openingStock, singleDate, results}`.
- Simulates one trading day only
- For each SKU/DS: looks up opening stock from uploaded DS CSVs, runs that day's orders against it, classifies root cause

### Root Cause Classification Logic (Actual Stock)

```
Min = Max = 0                                      → Unstocked
opening stock ≤ Min AND OOS occurs                 → Ops Failure (DC didn't restock)
opening stock > Min AND OOS occurs                 → Tool Failure (Min/Max too low)
OOS AND (physical + in_transit) ≥ order qty        → Could Have Been Saved (TO timing)
```

Priority order: Unstocked → Could Have Been Saved → Ops Failure → Tool Failure (check in this order; first match wins).

---

## What Doesn't Change

- simWorker.js worker instantiation pattern
- Existing drill-down components (SimOrgLevel, SimCategoryLevel, SimBrandLevel)
- Override comparison (tool vs ovr) in Loaded Data mode
- DS filter behaviour

---

## Constraints

- Fresh CSV data is session-only — never saved to Supabase or localStorage
- DC is excluded from Actual Stock simulation
- No push to GitHub until explicitly approved after local testing
