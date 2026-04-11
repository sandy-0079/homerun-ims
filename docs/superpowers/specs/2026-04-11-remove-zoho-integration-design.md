# Remove Zoho Integration — Design Spec

**Date:** 2026-04-11  
**Status:** Approved  
**Scope:** Upload Data tab + Supabase edge functions

---

## Goal

Remove all Zoho API dependency from the app. Invoice, SKU Master, and Purchase Prices all become plain CSV uploads — same pattern as DS Floor, SKU Floors, and Dead Stock. No external API calls, no sync state, no fallback logic.

---

## What Gets Deleted

### Supabase Edge Functions (4 files)
- `supabase/functions/zoho-invoices/index.ts`
- `supabase/functions/zoho-prices/index.ts`
- `supabase/functions/zoho-skumaster/index.ts`
- `supabase/functions/_shared/zoho.ts`

### App.jsx — State
- `zohoSync` state (`useState({ invoices: null, skuMaster: null, prices: null })`) — line 3130
- `invoiceUploadedThisSession` state — line 3131 (set only inside `handleInvoiceAndSync`, never read)
- `zohoInvFrom` state — line 3138 (used only by `syncZohoInvoices`)
- `zohoInvTo` state — line 3141 (used only by `syncZohoInvoices`)

### App.jsx — Functions
- `callZoho` — line 3366
- `syncZohoInvoices` — line 3379
- `syncZohoSKUMaster` — line 3408
- `syncZohoPrices` — line 3436

### App.jsx — Upload Tab UI
- `handleInvoiceAndSync` — replaced by direct `handleInvoice`
- `ZohoStatusBadge` component
- `isSyncingZoho` variable and all references
- `isSyncing2` Zoho check in Apply button's disabled logic
- "auto-synced from Zoho" combined card (SKU Master + Prices)
- "FALLBACK — if Zoho unavailable" section
- "Retry Zoho sync" button
- Zoho sync status rows (⏳/✅/⬜ with sync timestamps)

---

## Upload Tab Restructure

### Before
```
Row 1: [Invoice Card (CSV)] [SKU Master + Prices (Zoho, with CSV fallback)]
Row 2: [DS Floor] [SKU Floors] [Dead Stock]
```

### After
```
Row 1: [Invoice]  [SKU Master]  [Purchase Prices]   ← 3-col grid
Row 2: [DS Floor] [SKU Floors]  [Dead Stock]        ← 3-col grid (unchanged)
```

All 6 cards follow the same pattern:
- Label + "required" / optional badge
- Brief description line
- Buttons: Upload CSV | Template | Data (if loaded) | Clear (if loaded)
- Row count or SKU count displayed top-right

### Apply Button
- Remove Zoho sync check from `disabled` condition
- Condition becomes: `!hasData || !modelDirty` (same as today minus the Zoho sync gate)
- `hasData` still requires all 3 core inputs: `invoiceData`, `skuMaster`, `priceData`

### Intro Text Update
Current: "Upload invoice CSV — SKU Master and Prices sync from Zoho automatically."  
New: "Upload invoice CSV, SKU Master, and Prices as CSV files. Manual CSVs for floors and dead stock."

---

## Template Definitions

SKU Master and Prices templates already exist in the `templates` object in App.jsx. No new templates needed — just wire up the Template buttons the same way the bottom-row cards do.

---

## What Does NOT Change

- `handleInvoice`, `handleSKU`, `handlePrice` CSV parsers — unchanged
- `handleMRQ`, `handleNSQ`, `handleDead` — unchanged
- `buildDataCSV` — unchanged
- `clearData` — unchanged
- `changeLog` / `modelDirty` logic — unchanged
- Data health strip — unchanged
- Run confirm modal — unchanged
- All other tabs — unchanged
- Supabase `team_data` persistence — unchanged

---

## Constraints

- Local changes only — do not push to GitHub until manually tested
- No new state, no new handlers — only reorganization + deletion
- Maintain identical visual style to existing cards (same button colors, same font sizes)
