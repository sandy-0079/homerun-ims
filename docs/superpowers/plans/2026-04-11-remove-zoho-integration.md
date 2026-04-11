# Remove Zoho Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all Zoho API dependency from the app — Invoice, SKU Master, and Purchase Prices all become plain CSV uploads; edge functions deleted.

**Architecture:** Surgical deletion pass on `src/App.jsx` (remove 4 state vars, 4 functions, Zoho UI block) + delete 4 Supabase edge function files + restructure Upload tab Row 1 from a 2-col Zoho-first layout to a 3-col pure-CSV layout matching Row 2.

**Tech Stack:** React (JSX), Vite, Supabase edge functions (Deno/TypeScript)

---

## Files

| Action | File |
|--------|------|
| Delete | `supabase/functions/zoho-invoices/index.ts` |
| Delete | `supabase/functions/zoho-prices/index.ts` |
| Delete | `supabase/functions/zoho-skumaster/index.ts` |
| Delete | `supabase/functions/_shared/zoho.ts` |
| Modify | `src/App.jsx` — state declarations ~line 3130 |
| Modify | `src/App.jsx` — Zoho functions ~lines 3364–3453 |
| Modify | `src/App.jsx` — Apply button disabled logic ~line 3618 |
| Modify | `src/App.jsx` — Upload tab Row 1 UI ~lines 3713–3884 |

---

## Task 1: Delete Supabase Edge Functions

**Files:**
- Delete: `supabase/functions/zoho-invoices/index.ts`
- Delete: `supabase/functions/zoho-prices/index.ts`
- Delete: `supabase/functions/zoho-skumaster/index.ts`
- Delete: `supabase/functions/_shared/zoho.ts`

- [ ] **Step 1: Delete the four edge function files**

```bash
rm supabase/functions/zoho-invoices/index.ts
rm supabase/functions/zoho-prices/index.ts
rm supabase/functions/zoho-skumaster/index.ts
rm supabase/functions/_shared/zoho.ts
```

- [ ] **Step 2: Verify no remaining files in those directories**

```bash
ls supabase/functions/
```

Expected: Only `zoho-invoices/` and `zoho-skumaster/` and `zoho-prices/` directories remain (now empty). The `_shared/` directory may also remain empty. That's fine — git will track the deletions.

- [ ] **Step 3: Commit**

```bash
git add -A supabase/functions/
git commit -m "chore: delete Zoho edge functions"
```

---

## Task 2: Remove Zoho State Declarations

**Files:**
- Modify: `src/App.jsx` ~lines 3130–3141

- [ ] **Step 1: Find and remove `zohoSync` and `invoiceUploadedThisSession` state**

Locate this block (around line 3130):

```js
const [zohoSync, setZohoSync] = useState({ invoices: null, skuMaster: null, prices: null }); // {status, message, ts}
const [invoiceUploadedThisSession, setInvoiceUploadedThisSession] = useState(false);
```

Delete both lines entirely.

- [ ] **Step 2: Find and remove `zohoInvFrom` and `zohoInvTo` state**

Locate this block (around line 3138, after removing the previous lines it will shift up slightly):

```js
const [zohoInvFrom, setZohoInvFrom] = useState(() => {
  const d = new Date(); d.setDate(d.getDate() - 5); return d.toISOString().slice(0,10);
});
const [zohoInvTo, setZohoInvTo] = useState(() => new Date().toISOString().slice(0,10));
```

Delete all 4 lines entirely.

- [ ] **Step 3: Verify the surrounding state block still makes sense**

The lines immediately before should end with `stockUploadedAtRef` and the lines immediately after should start with `const [modelDirty`. Confirm no orphaned commas or broken syntax.

---

## Task 3: Remove Zoho Functions

**Files:**
- Modify: `src/App.jsx` ~lines 3364–3453

- [ ] **Step 1: Remove the `SUPABASE_ANON` constant and `callZoho` function**

Find and delete this entire block (around line 3364):

```js
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

const callZoho = useCallback(async (fn, params = {}) => {
  const url = new URL(`${SUPABASE_URL}/functions/v1/${fn}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: params && Object.keys(params).length ? "GET" : "POST",
    headers: { Authorization: `Bearer ${SUPABASE_ANON}`, "Content-Type": "application/json" },
    body: Object.keys(params).length ? undefined : "{}",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}, [SUPABASE_ANON]);
```

- [ ] **Step 2: Remove `syncZohoInvoices`**

Find and delete this entire block (starts with the comment `// F5 + F1: Sync invoice data from Zoho`):

```js
// F5 + F1: Sync invoice data from Zoho, merge with existing
const syncZohoInvoices = useCallback(async () => {
  if (!zohoInvFrom || !zohoInvTo) return;
  setZohoSync(s => ({ ...s, invoices: { status: "syncing", message: "Fetching from Zoho…" } }));
  try {
    const data = await callZoho("zoho-invoices", { from: zohoInvFrom, to: zohoInvTo });
    if (!data.success) throw new Error(data.error || "Sync failed");

    // F5: Transform → tool format (same as CSV parse in handleInvoice)
    const newRows = (data.invoices || []).map(r => ({
      date: r.date, sku: r.sku,
      ds: r.ds, // already mapped by edge function
      qty: r.qty,
    })).filter(r => r.date && r.sku && r.qty > 0);

    // Merge: replace same-date+sku+ds combos from Zoho (Zoho is authoritative). No rolling cap.
    const newKey = r => `${r.date}||${r.sku}||${r.ds}`;
    const newSet = new Set(newRows.map(newKey));
    const filtered = [...invoiceData.filter(r => !newSet.has(newKey(r))), ...newRows];

    setInv(filtered);
    LS.set("invoiceData", JSON.stringify(filtered));
    await saveTeamData({ invoiceData: filtered });
    setZohoSync(s => ({ ...s, invoices: { status: "ok", message: `✓ ${newRows.length} rows synced`, ts: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) } }));
  } catch (err) {
    setZohoSync(s => ({ ...s, invoices: { status: "error", message: `✗ ${err.message}` } }));
  }
}, [zohoInvFrom, zohoInvTo, invoiceData, callZoho]);
```

- [ ] **Step 3: Remove `syncZohoSKUMaster`**

Find and delete this entire block (starts with `// F5 + F1: Sync SKU master`):

```js
// F5 + F1: Sync SKU master from Zoho items list
const syncZohoSKUMaster = useCallback(async () => {
  setZohoSync(s => ({ ...s, skuMaster: { status: "syncing", message: "Fetching from Zoho…" } }));
  try {
    const data = await callZoho("zoho-skumaster");
    if (!data.success) throw new Error(data.error || "Sync failed");

    // F5: Transform → skuMaster object keyed by SKU
    const master = {};
    for (const item of (data.items || [])) {
      master[item.sku] = {
        sku: item.sku, name: item.name,
        category: item.category, brand: item.brand,
        status: item.status === "active" ? "Active" : "Inactive",
        inventorisedAt: "DS",
      };
    }
    setSKU(master);
    LS.set("skuMaster", JSON.stringify(master));
    await saveTeamData({ skuMaster: master });
    setModelDirty(true);
    addChange(`SKU Master synced from Zoho: ${Object.keys(master).length.toLocaleString()} SKUs`);
    setZohoSync(s => ({ ...s, skuMaster: { status: "ok", message: `✓ ${Object.keys(master).length} SKUs`, ts: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) } }));
  } catch (err) {
    setZohoSync(s => ({ ...s, skuMaster: { status: "error", message: `✗ ${err.message}` } }));
  }
}, [callZoho, saveTeamData]);
```

- [ ] **Step 4: Remove `syncZohoPrices`**

Find and delete this entire block (starts with `// F5 + F1: Sync purchase prices`):

```js
// F5 + F1: Sync purchase prices from Zoho
const syncZohoPrices = useCallback(async () => {
  setZohoSync(s => ({ ...s, prices: { status: "syncing", message: "Fetching L12M prices…" } }));
  try {
    const data = await callZoho("zoho-prices");
    if (!data.success) throw new Error(data.error || "Sync failed");

    // F5: prices response is already {sku: avg_price} — directly usable
    const pd = data.prices || {};
    setPrice(pd);
    LS.set("priceData", JSON.stringify(pd));
    await saveTeamData({ priceData: pd });
    setModelDirty(true);
    addChange(`Purchase Prices synced from Zoho: ${Object.keys(pd).length.toLocaleString()} SKUs`);
    setZohoSync(s => ({ ...s, prices: { status: "ok", message: `✓ ${Object.keys(pd).length} SKUs`, ts: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) } }));
  } catch (err) {
    setZohoSync(s => ({ ...s, prices: { status: "error", message: `✗ ${err.message}` } }));
  }
}, [callZoho, saveTeamData]);
```

- [ ] **Step 5: Check the app builds without error**

```bash
npm run build 2>&1 | tail -20
```

Expected: Build succeeds (exit 0). If you see `zohoSync is not defined` or similar, a reference was missed — search and remove it.

---

## Task 4: Fix Apply Button — Remove Zoho Sync Gate

**Files:**
- Modify: `src/App.jsx` — Apply button block ~line 3618

- [ ] **Step 1: Remove `isSyncing2` and update `disabled2`**

Find this block inside the Apply button IIFE:

```js
const isSyncing2 = zohoSync.skuMaster?.status==="syncing" || zohoSync.prices?.status==="syncing";
// Yellow only when something changed (data upload, clear, or params tweaked) and not mid-sync
const disabled2 = !hasData || isSyncing2 || !modelDirty;
```

Replace with:

```js
// Yellow only when something changed (data upload, clear, or params tweaked)
const disabled2 = !hasData || !modelDirty;
```

- [ ] **Step 2: Update the button `title` prop**

Find:

```js
title={!hasData?"Upload invoice CSV first":isSyncing2?"Syncing SKU Master + Prices from Zoho…":!modelDirty?"No changes since last run":""}
```

Replace with:

```js
title={!hasData?"Upload all required CSVs first":!modelDirty?"No changes since last run":""}
```

- [ ] **Step 3: Update the button content**

Find:

```jsx
{isSyncing2 ? <><span style={{fontSize:14}}>⏳</span> Syncing Zoho…</> : modelDirty ? <><span>▶</span> Apply & Re-run Model</> : <><span>✓</span> Model up to date</>}
```

Replace with:

```jsx
{modelDirty ? <><span>▶</span> Apply & Re-run Model</> : <><span>✓</span> Model up to date</>}
```

---

## Task 5: Restructure Upload Tab Row 1

**Files:**
- Modify: `src/App.jsx` — Upload tab UI ~lines 3713–3884

This is the largest change. Replace the 2-column "Invoice + Zoho" layout with a 3-column pure-CSV layout, and update the intro text.

- [ ] **Step 1: Update the intro paragraph**

Find:

```jsx
<p style={{color:HR.muted,fontSize:12,marginBottom:12,margin:"0 0 12px"}}>Upload invoice CSV — SKU Master and Prices sync from Zoho automatically. Manual CSVs for floors and dead stock.</p>
```

Replace with:

```jsx
<p style={{color:HR.muted,fontSize:12,marginBottom:12,margin:"0 0 12px"}}>Upload invoice CSV, SKU Master, and Prices as CSV files. Manual CSVs for floors and dead stock.</p>
```

- [ ] **Step 2: Remove `ZohoStatusBadge` and `isSyncingZoho`**

Find and delete this entire component definition:

```jsx
const ZohoStatusBadge = ({syncState}) => {
  if (!syncState) return null;
  const color = syncState.status === "ok" ? HR.green : syncState.status === "error" ? "#B91C1C" : HR.yellowDark;
  return <div style={{fontSize:10,color,marginTop:4,fontWeight:500}}>{syncState.message}{syncState.ts && <span style={{color:HR.muted,fontWeight:400}}> · {syncState.ts}</span>}</div>;
};
```

Also find and delete:

```js
const isSyncingZoho = zohoSync.skuMaster?.status==="syncing" || zohoSync.prices?.status==="syncing";
```

- [ ] **Step 3: Remove `handleInvoiceAndSync`**

Find and delete this entire function (inside the Upload tab IIFE):

```js
// Auto-sync SKU master + prices when invoice is uploaded
const handleInvoiceAndSync = async (e) => {
  // Reset sync state so button greys out until Zoho completes
  setZohoSync(s => ({ ...s, skuMaster: { status: "syncing", message: "Syncing…" }, prices: { status: "syncing", message: "Syncing…" } }));
  setInvoiceUploadedThisSession(true);
  await handleInvoice(e);
  await Promise.all([syncZohoSKUMaster(), syncZohoPrices()]);
};
```

- [ ] **Step 4: Replace Row 1 grid (Invoice + Zoho card) with 3-column grid**

Find this entire block — from the Row 1 comment through the closing `</div>` of the 2-col grid (approximately lines 3817–3885):

```jsx
{/* ── ROW 1: Invoice (left) + SKU Master & Prices (right) ── */}
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>

  {/* Invoice card */}
  <div style={{...S.card}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
      <div>
        <div style={{fontWeight:700,color:HR.text,fontSize:12}}>Invoice Data <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span></div>
        <div style={{fontSize:10,color:HR.muted,marginTop:2}}>Upload Zoho invoice export — replaces existing data entirely</div>
      </div>
      <div style={{fontSize:12,color:HR.green,fontWeight:700,whiteSpace:"nowrap"}}>{invoiceData.length.toLocaleString()} rows</div>
    </div>
    {invoiceDateRange.min && <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>Period: {invoiceDateRange.min} → {invoiceDateRange.max}</div>}
    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      <label style={{...btnS(HR.green,""), cursor:"pointer"}}>
        ⬆ Upload CSV <input type="file" accept=".csv" onChange={handleInvoiceAndSync} style={{display:"none"}}/>
      </label>
      {invoiceData.length>0&&<button onClick={()=>{const csv=buildDataCSV("invoiceData");if(csv)dlCSV("invoiceData_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
      {invoiceData.length>0&&<button onClick={()=>clearData("invoiceData")} style={clrBtnS}>🗑 Clear</button>}
    </div>
  </div>

  {/* SKU Master + Prices — Zoho synced */}
  <div style={{...S.card}}>
    ... (entire Zoho card block through the closing </div> of the 2-col grid)
  </div>
</div>
```

Replace with this 3-column grid:

```jsx
{/* ── ROW 1: Invoice + SKU Master + Prices ── */}
<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>

  {/* Invoice card */}
  <div style={{...S.card}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
      <div style={{fontWeight:700,color:HR.text,fontSize:12}}>Invoice Data <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span></div>
      <div style={{fontSize:11,color:HR.green,fontWeight:600,whiteSpace:"nowrap"}}>{invoiceData.length.toLocaleString()} rows</div>
    </div>
    {invoiceDateRange.min && <div style={{fontSize:10,color:HR.muted,marginBottom:4}}>Period: {invoiceDateRange.min} → {invoiceDateRange.max}</div>}
    <div style={{fontSize:10,color:HR.muted,marginBottom:8,lineHeight:1.4}}>Columns: Invoice Date, Invoice Number, Invoice Status, PurchaseOrder, Item Name, SKU, Category Name, Quantity, Line Item Location Name</div>
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
      <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={handleInvoice} style={{display:"none"}}/></label>
      <button onClick={()=>{const t=templates.invoiceData;dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
      {invoiceData.length>0&&<button onClick={()=>{const csv=buildDataCSV("invoiceData");if(csv)dlCSV("invoiceData_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
      {invoiceData.length>0&&<button onClick={()=>clearData("invoiceData")} style={clrBtnS}>🗑 Clear</button>}
    </div>
  </div>

  {/* SKU Master card */}
  <div style={{...S.card}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
      <div style={{fontWeight:700,color:HR.text,fontSize:12}}>SKU Master <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span></div>
      <div style={{fontSize:11,color:HR.green,fontWeight:600,whiteSpace:"nowrap"}}>{Object.keys(skuMaster).length.toLocaleString()} SKUs</div>
    </div>
    <div style={{fontSize:10,color:HR.muted,marginBottom:8,lineHeight:1.4}}>Columns: Name, Inventorised At, SKU, Category, Status, Brand</div>
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
      <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={handleSKU} style={{display:"none"}}/></label>
      <button onClick={()=>{const t=templates.skuMaster;dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
      {Object.keys(skuMaster).length>0&&<button onClick={()=>{const csv=buildDataCSV("skuMaster");if(csv)dlCSV("skuMaster_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
      {Object.keys(skuMaster).length>0&&<button onClick={()=>clearData("skuMaster")} style={clrBtnS}>🗑 Clear</button>}
    </div>
  </div>

  {/* Purchase Prices card */}
  <div style={{...S.card}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
      <div style={{fontWeight:700,color:HR.text,fontSize:12}}>Purchase Prices <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span></div>
      <div style={{fontSize:11,color:HR.green,fontWeight:600,whiteSpace:"nowrap"}}>{Object.keys(priceData).length.toLocaleString()} SKUs</div>
    </div>
    <div style={{fontSize:10,color:HR.muted,marginBottom:8,lineHeight:1.4}}>Columns: item_id, item_name, unit, is_combo_product, quantity_purchased, amount, average_price, location_name, sku</div>
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
      <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={handlePrice} style={{display:"none"}}/></label>
      <button onClick={()=>{const t=templates.priceData;dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
      {Object.keys(priceData).length>0&&<button onClick={()=>{const csv=buildDataCSV("priceData");if(csv)dlCSV("priceData_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
      {Object.keys(priceData).length>0&&<button onClick={()=>clearData("priceData")} style={clrBtnS}>🗑 Clear</button>}
    </div>
  </div>

</div>
```

---

## Task 6: Final Verification + Commit

**Files:**
- Verify: `src/App.jsx`

- [ ] **Step 1: Grep for any remaining Zoho references**

```bash
grep -n "zoho\|Zoho\|ZOHO\|zohoSync\|zohoInv\|callZoho\|syncZoho\|handleInvoiceAndSync\|invoiceUploadedThisSession" src/App.jsx
```

Expected: **Zero matches.** If any lines appear, remove them.

- [ ] **Step 2: Build the app**

```bash
npm run build 2>&1 | tail -30
```

Expected: Build succeeds with no errors. Warnings about unused variables are a signal to clean up anything the grep missed.

- [ ] **Step 3: Start dev server and test Upload tab manually**

```bash
npm run dev
```

Open the app in a browser, go to Upload Data tab (admin view) and verify:

- [ ] Row 1 shows 3 equal cards: Invoice Data / SKU Master / Purchase Prices
- [ ] Each card has: Upload CSV button, Template button, Data button (only if data loaded), Clear button (only if data loaded)
- [ ] Uploading an Invoice CSV works and shows row count + date range — **no Zoho sync fires**
- [ ] Uploading a SKU Master CSV works and shows SKU count
- [ ] Uploading a Prices CSV works and shows SKU count
- [ ] Apply & Re-run Model button is disabled until all 3 are loaded AND something changed
- [ ] Apply & Re-run Model button is enabled after uploading all 3 — no "Syncing Zoho…" state
- [ ] Template download buttons work for Invoice, SKU Master, and Prices
- [ ] Row 2 (DS Floor / SKU Floors / Dead Stock) is unchanged

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat: remove Zoho integration — Upload tab now fully CSV-driven"
```

---

## Self-Review Checklist (completed)

- **Spec coverage:** All items in spec covered — 4 edge functions deleted (Task 1), 4 state vars removed (Task 2), 4 functions removed (Task 3), Apply button fixed (Task 4), Row 1 restructured (Task 5), verification (Task 6).
- **Placeholder scan:** No TBDs. All code blocks are complete.
- **Type consistency:** `handleInvoice`, `handleSKU`, `handlePrice` used throughout — match existing handler names in App.jsx.
- **No push:** Implementation stops at local commit. Do not run `git push`.
