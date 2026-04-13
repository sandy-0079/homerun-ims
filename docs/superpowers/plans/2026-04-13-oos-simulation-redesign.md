# OOS Simulation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Last N days" slider with a preset date range bar, add a Fresh CSV simulation mode with Ideal Restock and Actual Stock sub-modes (with root cause classification).

**Architecture:** SimulationTab gains a mode toggle (Loaded Data / Fresh CSV). Loaded Data replaces the slider with presets + custom date picker. Fresh CSV adds upload cards and two sub-modes. simWorker.js gains a new message type for Actual Stock simulation. New hoisted state in App for fresh CSV data and results.

**Tech Stack:** React, Web Workers (simWorker.js), Vite, inline styles matching existing HR color palette

---

## Files

| Action | File | What changes |
|---|---|---|
| Modify | `src/simWorker.js` | Accept date arrays; add Actual Stock sim + root cause logic |
| Modify | `src/App.jsx` lines ~2813–2817 | Add hoisted state for fresh CSV data/results |
| Modify | `src/App.jsx` line ~3714 | Pass new props to SimulationTab |
| Modify | `src/App.jsx` lines 1031–1282 | Rebuild SimulationTab: mode toggle, preset bar, Fresh CSV UI |

---

## Task 1: Update simWorker.js

**Files:**
- Modify: `src/simWorker.js` (full rewrite — 76 lines → ~130 lines)

The worker currently accepts `{ invoiceData, results, overrides, simDays }` and calls `runSim` twice.

Replace with:
- `runSim` accepts a `simDates` array instead of `simDays` count
- New `runActualStockSim` function for Actual Stock mode
- `self.onmessage` dispatches on `data.type`

- [ ] **Step 1: Rewrite `src/simWorker.js`**

```js
function runSim(invoiceData, results, overrides, simDates) {
  const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];
  if (!invoiceData.length || !results || !simDates.length) return [];
  const simDateSet = new Set(simDates);
  const simIndex = {};
  invoiceData.forEach(r => {
    if (!simDateSet.has(r.date)) return;
    const k = `${r.sku}||${r.ds}`;
    if (!simIndex[k]) simIndex[k] = [];
    simIndex[k].push(r);
  });
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const out = [];
  Object.entries(results).forEach(([skuId, res]) => {
    DS_LIST.forEach(dsId => {
      const toolMin = res.stores[dsId]?.min || 0;
      const toolMax = res.stores[dsId]?.max || 0;
      if (!toolMax) return;
      const ov = overrides[skuId]?.[dsId];
      const useMin = (ov?.min !== null && ov?.min !== undefined) ? ov.min : toolMin;
      const useMax = (ov?.max !== null && ov?.max !== undefined) ? ov.max : toolMax;
      const isOverridden = ov !== undefined && (ov.min !== null || ov.max !== null);
      const simLines = simIndex[`${skuId}||${dsId}`] || [];
      let stock = useMax, oosInstances = 0;
      const shortQtys = [], orderLog = [];
      simDates.forEach(date => {
        const dayLines = simLines.filter(l => l.date === date);
        dayLines.forEach((line, li) => {
          const stockBefore = stock;
          const fulfilled = Math.min(line.qty, stock);
          const shortQty = line.qty - fulfilled;
          const oos = shortQty > 0;
          if (oos) { oosInstances++; shortQtys.push(shortQty); }
          stock = Math.max(0, stock - line.qty);
          const isLastOfDay = li === dayLines.length - 1;
          const replenished = isLastOfDay && stock <= useMin;
          orderLog.push({ date: line.date, qty: line.qty, stockBefore, fulfilled, shortQty, oos, stockAfter: stock, replenished });
          if (replenished) stock = useMax;
        });
      });
      if (oosInstances > 0 || isOverridden) {
        out.push({
          skuId, dsId,
          name: res.meta.name || skuId,
          category: res.meta.category || "Unknown",
          brand: res.meta.brand || "Unknown",
          priceTag: res.meta.priceTag || "—",
          mvTag: res.stores[dsId]?.mvTag || "—",
          toolMin, toolMax, useMin, useMax, isOverridden,
          oosInstances,
          totalInstances: simLines.length,
          medianShort: Math.ceil(median(shortQtys)),
          maxShort: shortQtys.length ? Math.max(...shortQtys) : 0,
          orderLog,
        });
      }
    });
  });
  out.sort((a, b) => b.oosInstances - a.oosInstances);
  return out;
}

// Root cause priority: Unstocked → Could Have Been Saved → Ops Failure → Tool Failure
function classifyRootCause(openingStock, toolMin, orderQty, physical, inTransit) {
  if (toolMin === 0 && openingStock === 0) return "unstocked";
  if (physical + inTransit >= orderQty) return "could_have_saved";
  if (openingStock <= toolMin) return "ops_failure";
  return "tool_failure";
}

function runActualStockSim(invoiceData, results, openingStock, singleDate) {
  // openingStock: { DS01: { SKU1: { physical, inTransit }, ... }, ... }
  const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];
  if (!invoiceData.length || !results) return [];
  const dayLines = invoiceData.filter(r => r.date === singleDate);
  const simIndex = {};
  dayLines.forEach(r => {
    const k = `${r.sku}||${r.ds}`;
    if (!simIndex[k]) simIndex[k] = [];
    simIndex[k].push(r);
  });
  const out = [];
  Object.entries(results).forEach(([skuId, res]) => {
    DS_LIST.forEach(dsId => {
      const toolMin = res.stores[dsId]?.min || 0;
      const toolMax = res.stores[dsId]?.max || 0;
      const dsStock = openingStock[dsId] || {};
      const stockEntry = dsStock[skuId] || { physical: 0, inTransit: 0 };
      const { physical, inTransit } = stockEntry;
      let stock = physical;
      const lines = simIndex[`${skuId}||${dsId}`] || [];
      if (!lines.length) return;
      let oosInstances = 0;
      const shortQtys = [], orderLog = [];
      lines.forEach(line => {
        const stockBefore = stock;
        const fulfilled = Math.min(line.qty, stock);
        const shortQty = line.qty - fulfilled;
        const oos = shortQty > 0;
        if (oos) {
          oosInstances++;
          shortQtys.push(shortQty);
        }
        stock = Math.max(0, stock - line.qty);
        const rootCause = oos ? classifyRootCause(physical, toolMin, line.qty, physical, inTransit) : null;
        orderLog.push({ date: line.date, qty: line.qty, stockBefore, fulfilled, shortQty, oos, stockAfter: stock, rootCause });
      });
      if (oosInstances > 0) {
        const firstOosLine = orderLog.find(l => l.oos);
        out.push({
          skuId, dsId,
          name: res.meta.name || skuId,
          category: res.meta.category || "Unknown",
          brand: res.meta.brand || "Unknown",
          priceTag: res.meta.priceTag || "—",
          mvTag: res.stores[dsId]?.mvTag || "—",
          toolMin, toolMax,
          openingStock: physical,
          inTransit,
          oosInstances,
          totalInstances: lines.length,
          medianShort: Math.ceil((() => { const s=[...shortQtys].sort((a,b)=>a-b),m=Math.floor(s.length/2); return s.length%2===1?s[m]:(s[m-1]+s[m])/2; })()),
          maxShort: shortQtys.length ? Math.max(...shortQtys) : 0,
          rootCause: firstOosLine?.rootCause || "tool_failure",
          orderLog,
        });
      }
    });
  });
  out.sort((a, b) => b.oosInstances - a.oosInstances);
  return out;
}

self.onmessage = ({ data }) => {
  if (data.type === "actual") {
    const { invoiceData, results, openingStock, singleDate } = data;
    const actual = runActualStockSim(invoiceData, results, openingStock, singleDate);
    self.postMessage({ actual });
    return;
  }
  // Default: ideal restock (loaded data or fresh CSV)
  const { invoiceData, results, overrides, simDates } = data;
  const tool = runSim(invoiceData, results, {}, simDates);
  const ovr  = runSim(invoiceData, results, overrides || {}, simDates);
  self.postMessage({ tool, ovr });
};
```

- [ ] **Step 2: Verify build is clean**

```bash
cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...`

- [ ] **Step 3: Commit**

```bash
git add src/simWorker.js
git commit -m "feat(sim): update worker — date array input, Actual Stock sim + root cause"
```

---

## Task 2: Add hoisted state + update SimulationTab call in App.jsx

**Files:**
- Modify: `src/App.jsx` ~line 2817 (state declarations)
- Modify: `src/App.jsx` ~line 3714 (SimulationTab render)

- [ ] **Step 1: Add new hoisted state after `const [simDays, setSimDays] = useState(15);` (~line 2817)**

```js
const [freshInvoiceData, setFreshInvoiceData] = useState([]);
const [freshInvoiceFile, setFreshInvoiceFile] = useState("");
const [dsStockData, setDsStockData] = useState({});  // {DS01:[...], DS02:[...], ...}
const [dsStockFiles, setDsStockFiles] = useState({}); // {DS01:"filename.csv", ...}
const [freshSimResults, setFreshSimResults] = useState({ tool: [], ovr: [], actual: [] });
const [freshSimLoading, setFreshSimLoading] = useState(false);
```

- [ ] **Step 2: Update SimulationTab call (~line 3714) to pass new props**

Find the existing `<SimulationTab` call and add the new props:

```jsx
<SimulationTab
  invoiceData={invoiceData}
  results={results}
  skuMaster={skuMaster}
  params={params}
  priceData={priceData}
  onApplyToCore={payload => { /* existing handler */ }}
  simOverrides={simOverrides} setSimOverrides={setSimOverrides}
  simOverrideCount={simOverrideCount} setSimOverrideCount={setSimOverrideCount}
  simResults={simResults} setSimResults={setSimResults}
  simLoading={simLoading} setSimLoading={setSimLoading}
  simDays={simDays} setSimDays={setSimDays}
  freshInvoiceData={freshInvoiceData} setFreshInvoiceData={setFreshInvoiceData}
  freshInvoiceFile={freshInvoiceFile} setFreshInvoiceFile={setFreshInvoiceFile}
  dsStockData={dsStockData} setDsStockData={setDsStockData}
  dsStockFiles={dsStockFiles} setDsStockFiles={setDsStockFiles}
  freshSimResults={freshSimResults} setFreshSimResults={setFreshSimResults}
  freshSimLoading={freshSimLoading} setFreshSimLoading={setFreshSimLoading}
/>
```

Note: keep the existing `onApplyToCore` handler exactly as-is, just add the new props around it.

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...`

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sim): add hoisted state for Fresh CSV mode"
```

---

## Task 3: Loaded Data mode — replace slider with preset bar

**Files:**
- Modify: `src/App.jsx` — SimulationTab function (lines 1031–1282)

The slider lives at lines 1179–1188. The `allDates` memo at line 1086 uses `simDays`. The useEffect at lines 1093–1117 posts `simDays` to the worker.

Changes:
1. Add local state: `simPreset`, `simDateFrom`, `simDateTo`
2. Add `simDates` computed array (replaces `allDates`)
3. Replace slider UI with preset bar
4. Update useEffect to post `simDates` instead of `simDays`
5. Update `allDates` references to use `simDates`

- [ ] **Step 1: Update SimulationTab function signature to accept new props**

Change:
```js
function SimulationTab({ invoiceData, results, skuMaster, params, priceData, onApplyToCore, simOverrides, setSimOverrides, simOverrideCount, setSimOverrideCount, simResults, setSimResults, simLoading, setSimLoading, simDays, setSimDays }) {
```

To:
```js
function SimulationTab({ invoiceData, results, skuMaster, params, priceData, onApplyToCore, simOverrides, setSimOverrides, simOverrideCount, setSimOverrideCount, simResults, setSimResults, simLoading, setSimLoading, simDays, setSimDays, freshInvoiceData, setFreshInvoiceData, freshInvoiceFile, setFreshInvoiceFile, dsStockData, setDsStockData, dsStockFiles, setDsStockFiles, freshSimResults, setFreshSimResults, freshSimLoading, setFreshSimLoading }) {
```

- [ ] **Step 2: Add local state at the top of SimulationTab (after existing useState declarations, ~line 1042)**

```js
const [simMode, setSimMode] = useState("loaded"); // "loaded" | "fresh"
const [simSubMode, setSimSubMode] = useState("ideal"); // "ideal" | "actual"
const [simPreset, setSimPreset] = useState("L15D"); // active preset key
const [simDateFrom, setSimDateFrom] = useState(""); // custom from (YYYY-MM-DD)
const [simDateTo, setSimDateTo] = useState("");     // custom to (YYYY-MM-DD)
const [simSingleDate, setSimSingleDate] = useState(""); // Actual Stock date
const [rootCauseFilter, setRootCauseFilter] = useState(null); // null | "ops_failure" | "tool_failure" | "unstocked" | "could_have_saved"
```

- [ ] **Step 3: Replace the `allDates` memo (line 1086) with a `simDates` computed value**

Remove:
```js
const allDates = useMemo(() => [...new Set(invoiceData.map(r => r.date))].sort().slice(-simDays), [invoiceData, simDays]);
```

Add after the `simMode` state declarations:
```js
// All unique sorted dates in the loaded invoice data
const allInvoiceDates = useMemo(() => [...new Set(invoiceData.map(r => r.date))].sort(), [invoiceData]);

// Active simulation dates for Loaded Data mode
const simDates = useMemo(() => {
  if (simPreset !== "custom") {
    const n = parseInt(simPreset.slice(1)); // "L45D" → 45
    return allInvoiceDates.slice(-n);
  }
  if (simDateFrom && simDateTo) {
    return allInvoiceDates.filter(d => d >= simDateFrom && d <= simDateTo);
  }
  return allInvoiceDates.slice(-15);
}, [allInvoiceDates, simPreset, simDateFrom, simDateTo]);
```

- [ ] **Step 4: Update the useEffect (lines 1093–1117) to use `simDates` and pass it to the worker**

Replace:
```js
useEffect(() => {
  if (!invoiceData.length || !results) return;
  setSimLoading(true);
  setSimResults({ tool: [], ovr: [] });
  const worker = new Worker(new URL("./simWorker.js", import.meta.url));
  worker.onmessage = ({ data }) => {
    setSimResults({ tool: data.tool, ovr: data.ovr });
    setSimLoading(false);
    worker.terminate();
  };
  worker.onerror = (e) => {
    console.error("Worker error:", e);
    setSimLoading(false);
    worker.terminate();
  };
  const allDatesArr = [...new Set(invoiceData.map(r => r.date))].sort();
  const simDatesSet = new Set(allDatesArr.slice(-simDays));
  const slimInvoice = invoiceData
    .filter(r => simDatesSet.has(r.date))
    .map(r => ({ date: r.date, sku: r.sku, ds: r.ds, qty: r.qty }));
  worker.postMessage({ invoiceData: slimInvoice, results, overrides, simDays });
  return () => worker.terminate();
}, [invoiceData, results, overrides, simDays]);
```

With:
```js
useEffect(() => {
  if (simMode !== "loaded") return;
  if (!invoiceData.length || !results || !simDates.length) return;
  setSimLoading(true);
  setSimResults({ tool: [], ovr: [] });
  const worker = new Worker(new URL("./simWorker.js", import.meta.url));
  worker.onmessage = ({ data }) => {
    setSimResults({ tool: data.tool, ovr: data.ovr });
    setSimLoading(false);
    worker.terminate();
  };
  worker.onerror = (e) => {
    console.error("Worker error:", e);
    setSimLoading(false);
    worker.terminate();
  };
  const simDatesSet = new Set(simDates);
  const slimInvoice = invoiceData
    .filter(r => simDatesSet.has(r.date))
    .map(r => ({ date: r.date, sku: r.sku, ds: r.ds, qty: r.qty }));
  worker.postMessage({ invoiceData: slimInvoice, results, overrides, simDates });
  return () => worker.terminate();
}, [invoiceData, results, overrides, simDates, simMode]);
```

- [ ] **Step 5: Update references to `allDates` in the component**

Find and replace all remaining `allDates` references within SimulationTab with `simDates`:
- Line 1131: `const winRows = useMemo(() => simLoading ? [] : inv.filter(r => allDates.includes(r.date)), ...`
  → `const winRows = useMemo(() => simLoading ? [] : inv.filter(r => simDates.includes(r.date)), [inv, simDates, simLoading]);`
- Line 1190: `{allDates.length > 0 && <span ...>{allDates[0]} → {allDates[allDates.length - 1]}</span>}`
  → `{simDates.length > 0 && <span ...>{simDates[0]} → {simDates[simDates.length - 1]}</span>}`
- Line 1277, 1278: `allDates={allDates}` props → `allDates={simDates}`

- [ ] **Step 6: Replace the slider UI (lines 1179–1188) with the preset bar**

Remove the entire slider block:
```jsx
<div style={{ display: "flex", alignItems: "center", gap: 0, border: `2px solid ${HR.yellow}`, ... }}>
  <span ...>Last</span>
  <input type="number" ... />
  <span ...>days ...</span>
  <button onClick={...}>▶ Run</button>
</div>
```

Replace with:
```jsx
<div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
  {["L45D","L30D","L15D","L7D","L3D"].map(preset=>(
    <button key={preset} onClick={()=>{setSimPreset(preset);setSimDateFrom("");setSimDateTo("");setDrill(null);}}
      style={{padding:"4px 10px",borderRadius:5,border:`1px solid ${simPreset===preset?HR.yellow:HR.border}`,background:simPreset===preset?HR.yellow:HR.white,color:simPreset===preset?HR.black:HR.muted,fontWeight:700,fontSize:11,cursor:"pointer"}}>
      {preset.replace("L","").replace("D"," days")}
    </button>
  ))}
  <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:5,border:`1px solid ${simPreset==="custom"?HR.yellow:HR.border}`,background:simPreset==="custom"?"#FFFBEA":HR.white}}>
    <span style={{fontSize:10,color:HR.muted,fontWeight:600}}>From</span>
    <input type="date" value={simDateFrom}
      min={allInvoiceDates[0]||""} max={simDateTo||allInvoiceDates[allInvoiceDates.length-1]||""}
      onChange={e=>{setSimDateFrom(e.target.value);setSimPreset("custom");setDrill(null);}}
      style={{border:"none",background:"transparent",fontSize:11,fontWeight:700,color:HR.yellowDark,outline:"none",cursor:"pointer"}}/>
    <span style={{fontSize:10,color:HR.muted}}>→</span>
    <input type="date" value={simDateTo}
      min={simDateFrom||allInvoiceDates[0]||""} max={allInvoiceDates[allInvoiceDates.length-1]||""}
      onChange={e=>{setSimDateTo(e.target.value);setSimPreset("custom");setDrill(null);}}
      style={{border:"none",background:"transparent",fontSize:11,fontWeight:700,color:HR.yellowDark,outline:"none",cursor:"pointer"}}/>
  </div>
  {simDates.length > 0 && <span style={{fontSize:10,color:HR.muted}}>{simDates[0]} → {simDates[simDates.length-1]} ({simDates.length}D)</span>}
</div>
```

- [ ] **Step 7: Verify build and test Loaded Data mode manually**

```bash
npm run build 2>&1 | tail -5
npm run dev
```

Open OOS Simulation tab. Verify:
- Preset buttons appear (45 days, 30 days, 15 days, 7 days, 3 days)
- L15D is active by default (yellow)
- Clicking a preset updates the date range and reruns simulation
- Custom date picker works, selecting dates reruns simulation
- Drill-down still works

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sim): replace slider with preset bar + date range picker"
```

---

## Task 4: Add mode toggle + Fresh CSV mode (Ideal Restock)

**Files:**
- Modify: `src/App.jsx` — SimulationTab (lines 1172–1264, the return/render section)

- [ ] **Step 1: Add mode toggle at the very top of the SimulationTab return**

In the sticky header div (line 1174), add the mode toggle as the first row:

```jsx
{/* Mode toggle */}
<div style={{display:"flex",gap:0,border:`1px solid ${HR.border}`,borderRadius:6,overflow:"hidden",marginBottom:8,alignSelf:"flex-start"}}>
  {[["loaded","Loaded Data"],["fresh","Fresh CSV"]].map(([mode,label])=>(
    <button key={mode} onClick={()=>setSimMode(mode)}
      style={{padding:"6px 18px",background:simMode===mode?HR.yellow:HR.white,color:simMode===mode?HR.black:HR.muted,border:"none",fontWeight:700,fontSize:12,cursor:"pointer",borderRight:mode==="loaded"?`1px solid ${HR.border}`:"none"}}>
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 2: Wrap existing controls (preset bar, DS filter, OOS badges) in `simMode === "loaded"` conditional**

The existing controls block (lines 1176–1263) should render only when `simMode === "loaded"`. Wrap it:

```jsx
{simMode === "loaded" && (
  <div> {/* existing sticky controls */} </div>
)}
```

- [ ] **Step 3: Add Fresh CSV mode header + upload section**

After the mode toggle (within the SimulationTab return, before the results area), add:

```jsx
{simMode === "fresh" && (
  <div style={{display:"flex",flexDirection:"column",gap:12}}>

    {/* Upload cards row */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>

      {/* Invoice CSV card */}
      <div style={{...S.card,display:"flex",flexDirection:"column"}}>
        <div style={{fontWeight:700,color:HR.text,fontSize:12,marginBottom:4}}>
          Invoice CSV <span style={{fontSize:10,color:"#B91C1C",fontWeight:400}}>required</span>
        </div>
        <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>Temporary — won't replace loaded data</div>
        <div style={{marginTop:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          <label style={{background:HR.green,color:HR.white,padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,border:"none"}}>
            ⬆ Upload CSV
            <input type="file" accept=".csv" style={{display:"none"}} onChange={e=>{
              const file=e.target.files[0]; if(!file)return;
              file.text().then(text=>{
                const rows=parseCSV(text);
                const filtered=rows.filter(r=>["Closed","Overdue"].includes(r["Invoice Status"]||""))
                  .map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0)}))
                  .filter(r=>r.date&&r.sku&&r.qty>0);
                setFreshInvoiceData(filtered);
                setFreshInvoiceFile(file.name);
                setFreshSimResults({tool:[],ovr:[],actual:[]});
              });
              e.target.value="";
            }}/>
          </label>
          {freshInvoiceFile && <span style={{fontSize:9,color:"#6B7280"}}>📄 {freshInvoiceFile}</span>}
          {freshInvoiceData.length>0 && <span style={{fontSize:11,color:HR.green,fontWeight:700}}>{freshInvoiceData.length.toLocaleString()} rows</span>}
          {freshInvoiceData.length>0 && <button onClick={()=>{setFreshInvoiceData([]);setFreshInvoiceFile("");setFreshSimResults({tool:[],ovr:[],actual:[]});}} style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"4px 8px",borderRadius:5,cursor:"pointer",fontSize:10,fontWeight:600}}>🗑 Clear</button>}
        </div>
      </div>

      {/* DS Stock CSVs card */}
      <div style={{...S.card,display:"flex",flexDirection:"column",opacity:simSubMode==="actual"?1:0.5,pointerEvents:simSubMode==="actual"?"auto":"none"}}>
        <div style={{fontWeight:700,color:HR.text,fontSize:12,marginBottom:4}}>
          DS Stock CSVs <span style={{fontSize:10,color:simSubMode==="actual"?"#B91C1C":"#999",fontWeight:400}}>{simSubMode==="actual"?"required (5 DS)":"Actual Stock only"}</span>
        </div>
        <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>Inventory Summary format — one per DS</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:"auto"}}>
          {DS_LIST.map(dsId=>(
            <div key={dsId} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
              <span style={{fontSize:11,color:dsStockData[dsId]?.length?HR.green:"#999",fontWeight:700}}>
                {dsStockData[dsId]?.length ? "✅" : "⬜"} {dsId}
              </span>
              <label style={{background:HR.green,color:HR.white,padding:"3px 7px",borderRadius:4,cursor:"pointer",fontSize:10,fontWeight:600}}>
                ⬆
                <input type="file" accept=".csv" style={{display:"none"}} onChange={e=>{
                  const file=e.target.files[0]; if(!file)return;
                  file.text().then(text=>{
                    const rows=parseCSV(text);
                    // Parse: SKU, physical quantity, quantity in transit
                    const stockMap={};
                    rows.forEach(r=>{
                      const sku=(r["SKU"]||r["Item Name"]||"").trim();
                      const physical=parseFloat(r["Quantity On Hand"]||r["Physical Quantity"]||r["Closing Stock"]||0);
                      const inTransit=parseFloat(r["Quantity In Transit"]||r["In Transit"]||0);
                      if(sku) stockMap[sku]={physical,inTransit};
                    });
                    setDsStockData(prev=>({...prev,[dsId]:stockMap}));
                    setDsStockFiles(prev=>({...prev,[dsId]:file.name}));
                  });
                  e.target.value="";
                }}/>
              </label>
              {dsStockFiles[dsId] && <span style={{fontSize:8,color:"#6B7280",maxWidth:60,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{dsStockFiles[dsId]}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Sub-mode selector */}
    <div style={{display:"flex",alignItems:"center",gap:12}}>
      <span style={{fontSize:12,color:HR.muted,fontWeight:600}}>Simulation type:</span>
      {[["ideal","Ideal Restock"],["actual","Actual Stock (single day)"]].map(([mode,label])=>(
        <label key={mode} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,fontWeight:mode===simSubMode?700:400,color:mode===simSubMode?HR.text:HR.muted}}>
          <input type="radio" name="simSubMode" value={mode} checked={simSubMode===mode} onChange={()=>{setSimSubMode(mode);setFreshSimResults({tool:[],ovr:[],actual:[]});}}/>
          {label}
        </label>
      ))}
    </div>

    {/* Date controls for Fresh CSV */}
    {simSubMode==="ideal" && (
      <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
        {["L45D","L30D","L15D","L7D","L3D"].map(preset=>{
          const freshDates=[...new Set(freshInvoiceData.map(r=>r.date))].sort();
          return(
            <button key={preset} onClick={()=>{setSimPreset(preset+"_fresh");setSimDateFrom("");setSimDateTo("");}}
              style={{padding:"4px 10px",borderRadius:5,border:`1px solid ${simPreset===preset+"_fresh"?HR.yellow:HR.border}`,background:simPreset===preset+"_fresh"?HR.yellow:HR.white,color:simPreset===preset+"_fresh"?HR.black:HR.muted,fontWeight:700,fontSize:11,cursor:"pointer"}}>
              {preset.replace("L","").replace("D"," days")}
            </button>
          );
        })}
        <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:5,border:`1px solid ${simPreset==="custom_fresh"?HR.yellow:HR.border}`}}>
          <span style={{fontSize:10,color:HR.muted,fontWeight:600}}>From</span>
          <input type="date" value={simDateFrom} onChange={e=>{setSimDateFrom(e.target.value);setSimPreset("custom_fresh");}} style={{border:"none",background:"transparent",fontSize:11,fontWeight:700,color:HR.yellowDark,outline:"none",cursor:"pointer"}}/>
          <span style={{fontSize:10,color:HR.muted}}>→</span>
          <input type="date" value={simDateTo} onChange={e=>{setSimDateTo(e.target.value);setSimPreset("custom_fresh");}} style={{border:"none",background:"transparent",fontSize:11,fontWeight:700,color:HR.yellowDark,outline:"none",cursor:"pointer"}}/>
        </div>
      </div>
    )}
    {simSubMode==="actual" && (
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:12,color:HR.muted,fontWeight:600}}>Simulate date:</span>
        <input type="date" value={simSingleDate} onChange={e=>setSimSingleDate(e.target.value)}
          style={{...S.input,width:160,fontWeight:700,color:HR.yellowDark}}/>
      </div>
    )}

    {/* Run button for Fresh CSV */}
    {(()=>{
      const freshDates=[...new Set(freshInvoiceData.map(r=>r.date))].sort();
      const idealReady = simSubMode==="ideal" && freshInvoiceData.length>0 && (simPreset!=="custom_fresh"||(simDateFrom&&simDateTo));
      const actualReady = simSubMode==="actual" && freshInvoiceData.length>0 && DS_LIST.every(d=>dsStockData[d]) && simSingleDate;
      const canRun = idealReady || actualReady;
      return(
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button disabled={!canRun||freshSimLoading} onClick={()=>{
            if(!canRun) return;
            setFreshSimLoading(true);
            setFreshSimResults({tool:[],ovr:[],actual:[]});
            const worker=new Worker(new URL("./simWorker.js",import.meta.url));
            if(simSubMode==="actual"){
              // Build openingStock: {DS01:{SKU:{physical,inTransit}}, ...}
              const openingStock={};
              DS_LIST.forEach(dsId=>{openingStock[dsId]=dsStockData[dsId]||{};});
              worker.onmessage=({data})=>{setFreshSimResults(prev=>({...prev,actual:data.actual}));setFreshSimLoading(false);worker.terminate();};
              worker.onerror=()=>{setFreshSimLoading(false);worker.terminate();};
              worker.postMessage({type:"actual",invoiceData:freshInvoiceData,results,openingStock,singleDate:simSingleDate});
            } else {
              // Ideal restock: use fresh invoice data with date range
              let fd=freshDates;
              if(simPreset!=="custom_fresh"){const n=parseInt(simPreset.slice(1));fd=freshDates.slice(-n);}
              else if(simDateFrom&&simDateTo) fd=freshDates.filter(d=>d>=simDateFrom&&d<=simDateTo);
              const simDatesSet=new Set(fd);
              const slimInvoice=freshInvoiceData.filter(r=>simDatesSet.has(r.date)).map(r=>({date:r.date,sku:r.sku,ds:r.ds,qty:r.qty}));
              worker.onmessage=({data})=>{setFreshSimResults(prev=>({...prev,tool:data.tool,ovr:data.ovr}));setFreshSimLoading(false);worker.terminate();};
              worker.onerror=()=>{setFreshSimLoading(false);worker.terminate();};
              worker.postMessage({invoiceData:slimInvoice,results,overrides:{},simDates:fd});
            }
          }} style={{background:canRun?HR.yellow:"#E5E5E5",color:canRun?HR.black:"#999",border:"none",padding:"8px 20px",borderRadius:7,cursor:canRun?"pointer":"not-allowed",fontWeight:800,fontSize:12}}>
            {freshSimLoading?"⚡ Running…":"▶ Run Simulation"}
          </button>
          {!canRun && <span style={{fontSize:11,color:HR.muted}}>
            {simSubMode==="ideal"?"Upload invoice CSV to run":"Upload invoice CSV + all 5 DS stock CSVs + pick a date"}
          </span>}
        </div>
      );
    })()}

    {/* Fresh sim results */}
    {freshSimLoading && <div style={{textAlign:"center",padding:40}}><div style={{fontSize:32,marginBottom:8}}>⚡</div><div style={{color:HR.yellowDark,fontWeight:700}}>Running Simulation…</div></div>}

    {!freshSimLoading && simSubMode==="ideal" && freshSimResults.tool.length>0 && (
      // Reuse existing org-level display with fresh results
      <SimOrgLevel
        toolRows={freshSimResults.tool.filter(r=>dsFilter==="All"||r.dsId===dsFilter)}
        ovrRows={freshSimResults.tool.filter(r=>dsFilter==="All"||r.dsId===dsFilter)}
        ovrRowsFull={freshSimResults.tool}
        winRows={freshInvoiceData.filter(r=>dsFilter==="All"||r.ds===dsFilter)}
        skuMeta={skuMeta}
        hasOverrides={false}
        priceData={priceData}
        totInst={freshInvoiceData.filter(r=>dsFilter==="All"||r.ds===dsFilter).length}
        totSkus={new Set(freshInvoiceData.filter(r=>dsFilter==="All"||r.ds===dsFilter).map(r=>r.sku)).size}
        onDrillCategory={cat=>setDrill({type:"category",value:cat,category:cat})}
      />
    )}
  </div>
)}
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Manually test Fresh CSV Ideal Restock**

Start dev server. Switch to Fresh CSV mode. Upload an invoice CSV. Select a preset. Click Run. Verify results appear in the drill-down.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sim): add mode toggle + Fresh CSV Ideal Restock mode"
```

---

## Task 5: Actual Stock mode — root cause summary + drill-down

**Files:**
- Modify: `src/App.jsx` — SimulationTab (the Fresh CSV results section)

This adds the root cause strip and the filtered drill-down display for Actual Stock results.

- [ ] **Step 1: Add root cause summary strip + filtered results after the Ideal Restock results block**

Find the `{!freshSimLoading && simSubMode==="ideal" && ...}` block from Task 4 and add after it:

```jsx
{!freshSimLoading && simSubMode==="actual" && freshSimResults.actual.length>0 && (()=>{
  const actualRows=freshSimResults.actual.filter(r=>dsFilter==="All"||r.dsId===dsFilter);
  const counts={ops_failure:0,tool_failure:0,unstocked:0,could_have_saved:0};
  actualRows.forEach(r=>{if(counts[r.rootCause]!==undefined)counts[r.rootCause]++;});
  const causeLabels={ops_failure:["Ops Failure","DC didn't restock when it should"],tool_failure:["Tool Failure","Min/Max set too low"],unstocked:["Unstocked","Min = Max = 0"],could_have_saved:["Could Have Been Saved","TO was close — timing issue"]};
  const causeColors={ops_failure:"#B91C1C",tool_failure:"#C05A00",unstocked:"#6B7280",could_have_saved:"#0077A8"};
  const filteredRows=rootCauseFilter?actualRows.filter(r=>r.rootCause===rootCauseFilter):actualRows;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      {/* Root cause summary strip */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        {Object.entries(causeLabels).map(([key,[title,desc]])=>{
          const count=counts[key];
          const isActive=rootCauseFilter===key;
          return(
            <div key={key} onClick={()=>setRootCauseFilter(isActive?null:key)}
              style={{...S.card,cursor:"pointer",border:`2px solid ${isActive?causeColors[key]:HR.border}`,background:isActive?causeColors[key]+"10":HR.white}}>
              <div style={{fontWeight:800,fontSize:20,color:causeColors[key]}}>{count}</div>
              <div style={{fontWeight:700,fontSize:11,color:HR.text,marginBottom:2}}>{title}</div>
              <div style={{fontSize:9,color:HR.muted,lineHeight:1.3}}>{desc}</div>
            </div>
          );
        })}
      </div>
      {rootCauseFilter && <div style={{fontSize:11,color:HR.muted}}>Showing: <strong>{causeLabels[rootCauseFilter][0]}</strong> — <button onClick={()=>setRootCauseFilter(null)} style={{background:"none",border:"none",color:HR.yellowDark,cursor:"pointer",fontWeight:600,fontSize:11}}>Clear filter ×</button></div>}
      {/* Results table */}
      <div style={{...S.card,padding:0,overflow:"hidden"}}>
        <table style={S.table}>
          <thead><tr style={{background:HR.surfaceLight}}>
            <th style={S.th}>SKU</th>
            <th style={S.th}>DS</th>
            <th style={S.th}>Category</th>
            <th style={{...S.th,textAlign:"center"}}>Opening Stock</th>
            <th style={{...S.th,textAlign:"center"}}>Tool Min</th>
            <th style={{...S.th,textAlign:"center"}}>OOS Orders</th>
            <th style={S.th}>Root Cause</th>
          </tr></thead>
          <tbody>
            {filteredRows.map((r,i)=>{
              const color=causeColors[r.rootCause]||HR.muted;
              const label=causeLabels[r.rootCause]?.[0]||r.rootCause;
              return(
                <tr key={`${r.skuId}||${r.dsId}`} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                  <td style={{...S.td,fontWeight:600,fontSize:11}}>{r.name}</td>
                  <td style={S.td}>{r.dsId}</td>
                  <td style={{...S.td,fontSize:11}}>{r.category}</td>
                  <td style={{...S.td,textAlign:"center",fontWeight:700}}>{r.openingStock}</td>
                  <td style={{...S.td,textAlign:"center"}}>{r.toolMin}</td>
                  <td style={{...S.td,textAlign:"center",fontWeight:700,color:"#B91C1C"}}>{r.oosInstances}</td>
                  <td style={S.td}><span style={{background:color+"18",color,border:`1px solid ${color}44`,borderRadius:4,padding:"2px 6px",fontSize:10,fontWeight:700}}>{label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredRows.length===0&&<div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>No OOS instances for this filter</div>}
      </div>
    </div>
  );
})()}
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...`

- [ ] **Step 3: Manually test Actual Stock mode**

Start dev server (`npm run dev`). Switch to Fresh CSV mode. Upload fresh invoice CSV + all 5 DS stock CSVs. Select a date. Click Run. Verify:
- Root cause summary strip shows 4 cells with counts
- Clicking a cell filters the table below
- Table shows SKU, DS, Opening Stock, Tool Min, OOS Orders, Root Cause tag
- Clear filter removes the root cause filter
- DS filter in the top bar still works

- [ ] **Step 4: Final build check**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sim): add Actual Stock mode with root cause classification"
```

---

## Self-Review

**Spec coverage:**
- ✅ Mode toggle (Loaded Data / Fresh CSV) — Task 4
- ✅ Preset bar L45D/L30D/L15D/L7D/L3D + date picker — Task 3
- ✅ Default L15D — Task 3 (initial state)
- ✅ Mode switching preserves results (hoisted state) — Task 2
- ✅ Fresh CSV upload inline in tab — Task 4
- ✅ Invoice CSV card + DS Stock CSVs card (greyed for Ideal Restock) — Task 4
- ✅ Sub-mode selector (Ideal / Actual) — Task 4
- ✅ Date range for Ideal Restock — Task 4
- ✅ Single date picker for Actual Stock — Task 4
- ✅ Run button only when required inputs satisfied — Task 4
- ✅ Ideal Restock results reuse existing drill-down — Task 4
- ✅ Actual Stock root cause strip (4 cells, click-to-filter) — Task 5
- ✅ Actual Stock results table with Root Cause column — Task 5
- ✅ DC excluded from Actual Stock (DS_LIST only) — Task 1 (runActualStockSim)
- ✅ Root cause priority: Unstocked → Could Have Been Saved → Ops Failure → Tool Failure — Task 1
- ✅ Fresh CSV session-only (no Supabase/localStorage) — Tasks 2, 4

**Type consistency:** `simDates` (array) used consistently in worker messages and useEffect deps. `freshSimResults.actual` flows from worker → state → render.

**No placeholders found.**
