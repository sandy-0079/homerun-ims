# Category Network Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new tabs to the IMS tool — "Baskets" (basket composition analysis) and "Plywood" (DS-level plywood stocking recommendations) — using invoice + SKU Master data already in the tool.

**Architecture:** Each new tab lives in its own file under `src/tabs/`. `App.jsx` passes `invoiceData`, `skuMaster`, `isAdmin`, and `invoiceDateRange` as props. Plywood Network also receives `networkConfigs` (loaded from Supabase `params/networkConfigs`) and a save callback. No changes to the Min/Max engine — Plywood tab is recommendation-only.

**Tech Stack:** React 18, Recharts (already in app), Supabase (existing `loadFromSupabase`/`saveToSupabase` helpers), Vite dev server.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `src/App.jsx` | Parser change, tab registration, state, imports, rendering |
| Create | `src/tabs/BasketAnalysisTab.jsx` | Basket Analysis tab — full component |
| Create | `src/tabs/PlywoodNetworkTab.jsx` | Plywood Network tab — full component |

---

## Task 1: Parser — add `shopifyOrder` to `handleInvoice`

**Files:**
- Modify: `src/App.jsx` (line ~3328)

- [ ] **Step 1: Find the handleInvoice map() and add shopifyOrder**

In `src/App.jsx`, locate the `handleInvoice` callback (line ~3328). The current `.map()` is:
```js
.map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0)}))
```

Change to:
```js
.map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0),shopifyOrder:r["Shopify Order"]||""}))
```

- [ ] **Step 2: Commit**
```bash
git add src/App.jsx
git commit -m "feat: add shopifyOrder to invoice parser"
```

---

## Task 2: Tab scaffolding — register tabs and create placeholder components

**Files:**
- Create: `src/tabs/BasketAnalysisTab.jsx`
- Create: `src/tabs/PlywoodNetworkTab.jsx`
- Modify: `src/App.jsx` (ADMIN_TABS, PUBLIC_TABS, imports, state, rendering)

- [ ] **Step 1: Create placeholder BasketAnalysisTab**

Create `src/tabs/BasketAnalysisTab.jsx`:
```jsx
import React from "react";

export default function BasketAnalysisTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin }) {
  return (
    <div style={{ padding: 32, color: "#888", fontFamily: "Inter,sans-serif" }}>
      Basket Analysis — coming soon
    </div>
  );
}
```

- [ ] **Step 2: Create placeholder PlywoodNetworkTab**

Create `src/tabs/PlywoodNetworkTab.jsx`:
```jsx
import React from "react";

export default function PlywoodNetworkTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin, networkConfigs, onSaveConfigs }) {
  return (
    <div style={{ padding: 32, color: "#888", fontFamily: "Inter,sans-serif" }}>
      Plywood Network — coming soon
    </div>
  );
}
```

- [ ] **Step 3: Add imports to App.jsx**

At the top of `src/App.jsx`, after the existing imports, add:
```js
import BasketAnalysisTab from "./tabs/BasketAnalysisTab";
import PlywoodNetworkTab from "./tabs/PlywoodNetworkTab";
```

- [ ] **Step 4: Add networkConfigs state to App.jsx**

In the main `App` component state block (near line ~3113), add:
```js
const [networkConfigs, setNetworkConfigs] = useState(null);
```

- [ ] **Step 5: Load networkConfigs from Supabase on mount**

Inside the existing `useEffect` that loads team data (near line ~3209), after `loadFromSupabase("team_data","global")`, add a parallel load:
```js
const sbNetCfg = await loadFromSupabase("params", "networkConfigs");
if (sbNetCfg) setNetworkConfigs(sbNetCfg);
```

- [ ] **Step 6: Add save callback**

In the main `App` component (near the other save handlers), add:
```js
const handleSaveNetworkConfigs = useCallback(async (configs) => {
  setNetworkConfigs(configs);
  await saveToSupabase("params", "networkConfigs", configs);
}, []);
```

- [ ] **Step 7: Register tabs in ADMIN_TABS and PUBLIC_TABS**

In `src/App.jsx`, locate `ADMIN_TABS` and `PUBLIC_TABS` (line ~3480):
```js
const ADMIN_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["stockHealth","Stock Health"],["simulation","OOS Simulation"],["output","Tool Output Download"],["upload","Upload Data"],["logic","Logic Tweaker"],["overrides","Manual Overrides"]];
const PUBLIC_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["stockHealth","Stock Health"],["simulation","OOS Simulation"],["output","Tool Output Download"]];
```

Change to:
```js
const ADMIN_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["baskets","Baskets"],["plywood","Plywood"],["stockHealth","Stock Health"],["simulation","OOS Simulation"],["output","Tool Output Download"],["upload","Upload Data"],["logic","Logic Tweaker"],["overrides","Manual Overrides"]];
const PUBLIC_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["baskets","Baskets"],["plywood","Plywood"],["stockHealth","Stock Health"],["simulation","OOS Simulation"],["output","Tool Output Download"]];
```

- [ ] **Step 8: Add tab rendering in App.jsx JSX**

Find where the tabs render (after `{tab==="skuDetail"&&...}`, near line ~3869). Add:
```jsx
{tab==="baskets"&&(
  <div style={S.pageWrap}>
    <BasketAnalysisTab
      invoiceData={invoiceData}
      skuMaster={skuMaster}
      invoiceDateRange={invoiceDateRange}
      isAdmin={isAdmin}
    />
  </div>
)}
{tab==="plywood"&&(
  <div style={S.pageWrap}>
    <PlywoodNetworkTab
      invoiceData={invoiceData}
      skuMaster={skuMaster}
      invoiceDateRange={invoiceDateRange}
      isAdmin={isAdmin}
      networkConfigs={networkConfigs}
      onSaveConfigs={handleSaveNetworkConfigs}
    />
  </div>
)}
```

- [ ] **Step 9: Start dev server and verify**

```bash
npm run dev
```

Open `http://localhost:5173`. Verify:
- "Baskets" and "Plywood" tabs appear in nav bar between SKU Detail and Stock Health
- Clicking each shows the placeholder text
- No console errors

- [ ] **Step 10: Commit**
```bash
git add src/App.jsx src/tabs/BasketAnalysisTab.jsx src/tabs/PlywoodNetworkTab.jsx
git commit -m "feat: scaffold Baskets and Plywood tabs"
```

---

## 🔵 MILESTONE 1 — Local test checkpoint

**User tests:** Nav shows Baskets + Plywood tabs in correct position. Both tabs open without errors.

---

## Task 3: Basket Analysis — full implementation

**Files:**
- Modify: `src/tabs/BasketAnalysisTab.jsx`

All design decisions locked during planning:
- Period: last N unique trading dates (L45D/L30D/L15D/L7D/L3D/Custom)
- DS filter: filter rows by DS, then group by `shopifyOrder`
- 5 summary cards, donut (Recharts PieChart), co-category horizontal bar (Recharts BarChart), insight text
- Show prompt if no `shopifyOrder` in data (old data pre-parser-change)

- [ ] **Step 1: Write the full BasketAnalysisTab component**

Replace the entire contents of `src/tabs/BasketAnalysisTab.jsx` with:

```jsx
import React, { useState, useMemo, useCallback } from "react";
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from "recharts";

const HR = {
  yellow:"#F5C400",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",
};
const S = {
  card:{background:HR.surface,borderRadius:8,padding:12,border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  btn:(on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,transition:"all 0.15s",whiteSpace:"nowrap",outline:"none"}),
  input:{background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"5px 10px",color:HR.text,fontSize:12},
};

const BA_PERIODS = [
  { key:"L45D",label:"L45D",days:45 },
  { key:"L30D",label:"L30D",days:30 },
  { key:"L15D",label:"L15D",days:15 },
  { key:"L7D", label:"L7D", days:7  },
  { key:"L3D", label:"L3D", days:3  },
  { key:"CUSTOM",label:"Custom" },
];

const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];
const DONUT_COLORS = ["#16a34a","#F5C400","#C05A00"];

function filterByPeriod(invoiceData, periodKey, dateFrom, dateTo, invoiceDateRange) {
  if (!invoiceData?.length) return [];
  const allDates = invoiceDateRange.dates;
  if (periodKey === "CUSTOM" && dateFrom && dateTo)
    return invoiceData.filter(r => r.date >= dateFrom && r.date <= dateTo);
  const preset = BA_PERIODS.find(p => p.key === periodKey);
  if (preset?.days) {
    const last = allDates.slice(-preset.days);
    return invoiceData.filter(r => last.includes(r.date));
  }
  return invoiceData;
}

function computeBaskets(rows, skuMaster, primaryCats, secondaryCats) {
  const isPrimary = cat => primaryCats.has(cat);
  const isSecondary = cat => secondaryCats.has(cat);

  const orderMap = {};
  rows.forEach(r => {
    const orderId = r.shopifyOrder || `${r.sku}__${r.date}`;
    if (!orderMap[orderId]) orderMap[orderId] = new Set();
    const cat = skuMaster[r.sku]?.category || "";
    if (cat) orderMap[orderId].add(cat);
  });

  let totalOrders = 0, primaryOrders = 0, primaryOnlyOrders = 0;
  let primarySecondaryOrders = 0, primaryOtherOrders = 0;
  const coCatCounts = {};

  Object.values(orderMap).forEach(cats => {
    totalOrders++;
    const allCats = [...cats];
    if (!allCats.some(isPrimary)) return;
    primaryOrders++;
    const nonPrimary = allCats.filter(c => !isPrimary(c));
    if (nonPrimary.length === 0) { primaryOnlyOrders++; return; }
    if (nonPrimary.some(isSecondary)) primarySecondaryOrders++;
    if (nonPrimary.some(c => !isSecondary(c))) primaryOtherOrders++;
    nonPrimary.forEach(c => { coCatCounts[c] = (coCatCounts[c] || 0) + 1; });
  });

  return { totalOrders, primaryOrders, primaryOnlyOrders, primarySecondaryOrders, primaryOtherOrders, coCatCounts };
}

export default function BasketAnalysisTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin }) {
  const [period, setPeriod] = useState("L45D");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dsFilter, setDsFilter] = useState("All");
  const [primaryCats, setPrimaryCats] = useState(new Set());
  const [secondaryCats, setSecondaryCats] = useState(new Set());
  const [results, setResults] = useState(null);

  const hasShopifyOrder = useMemo(() => invoiceData.some(r => r.shopifyOrder), [invoiceData]);
  const allCategories = useMemo(() =>
    [...new Set(Object.values(skuMaster).map(s => s.category).filter(Boolean))].sort(),
    [skuMaster]);

  const primaryLabel = primaryCats.size > 0 ? [...primaryCats].join(" + ") : "Primary";
  const secondaryLabel = secondaryCats.size > 0 ? [...secondaryCats].join(" + ") : "Secondary";

  const canRun = primaryCats.size > 0 && invoiceData.length > 0 && hasShopifyOrder;

  const handleRun = useCallback(() => {
    const periodRows = filterByPeriod(invoiceData, period, dateFrom, dateTo, invoiceDateRange);
    const dsRows = dsFilter === "All"
      ? periodRows.filter(r => DS_LIST.includes(r.ds))
      : periodRows.filter(r => r.ds === dsFilter);
    setResults(computeBaskets(dsRows, skuMaster, primaryCats, secondaryCats));
  }, [invoiceData, skuMaster, period, dateFrom, dateTo, dsFilter, primaryCats, secondaryCats, invoiceDateRange]);

  const toggleCat = (cat, type) => {
    if (type === "primary") {
      setPrimaryCats(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
      setSecondaryCats(prev => { const n = new Set(prev); n.delete(cat); return n; });
    } else {
      setSecondaryCats(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
      setPrimaryCats(prev => { const n = new Set(prev); n.delete(cat); return n; });
    }
    setResults(null);
  };

  if (!invoiceData.length) return (
    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
      No invoice data loaded. Upload invoice CSV in the Upload Data tab.
    </div>
  );

  return (
    <div style={{fontFamily:"Inter,sans-serif",color:HR.text}}>
      {!hasShopifyOrder && (
        <div style={{background:"#FEF3C7",border:"1px solid #FDE68A",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#92400E"}}>
          ⚠ Loaded invoice data was uploaded before Shopify Order tracking was added. Please re-upload the invoice CSV to enable basket grouping.
        </div>
      )}

      {/* Category selector */}
      <div style={{...S.card,marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Categories</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {allCategories.map(cat => {
            const isPrimary = primaryCats.has(cat);
            const isSecondary = secondaryCats.has(cat);
            return (
              <span key={cat} style={{display:"inline-flex",gap:4,alignItems:"center"}}>
                <button
                  onClick={() => toggleCat(cat, "primary")}
                  style={{...S.btn(isPrimary),background:isPrimary?"#D1FAE5":"",color:isPrimary?"#065F46":"",borderColor:isPrimary?"#6EE7B7":HR.border}}
                >
                  {cat}
                </button>
                <button
                  onClick={() => toggleCat(cat, "secondary")}
                  style={{...S.btn(isSecondary),background:isSecondary?"#FEF3C7":"",color:isSecondary?"#92400E":"",borderColor:isSecondary?"#FDE68A":HR.border,fontSize:9,padding:"2px 6px"}}
                >
                  2°
                </button>
              </span>
            );
          })}
        </div>
        <div style={{fontSize:10,color:HR.muted,marginTop:8}}>
          Click category name → <span style={{background:"#D1FAE5",color:"#065F46",padding:"1px 4px",borderRadius:3}}>Primary</span> &nbsp;
          Click "2°" → <span style={{background:"#FEF3C7",color:"#92400E",padding:"1px 4px",borderRadius:3}}>Secondary</span>
        </div>
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <div style={{display:"flex",gap:4}}>
          {BA_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
            <button key={p.key} onClick={() => { setPeriod(p.key); setResults(null); }} style={S.btn(period === p.key)}>{p.label}</button>
          ))}
          <button onClick={() => { setPeriod("CUSTOM"); setResults(null); }} style={S.btn(period === "CUSTOM")}>Custom</button>
        </div>
        {period === "CUSTOM" && (
          <>
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setResults(null); }} style={S.input}/>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setResults(null); }} style={S.input}/>
          </>
        )}
        <div style={{display:"flex",gap:4,marginLeft:8}}>
          {["All",...DS_LIST].map(ds => (
            <button key={ds} onClick={() => { setDsFilter(ds); setResults(null); }} style={S.btn(dsFilter === ds)}>{ds}</button>
          ))}
        </div>
        <button
          onClick={handleRun}
          disabled={!canRun}
          style={{marginLeft:"auto",padding:"5px 18px",borderRadius:6,border:"none",background:canRun?HR.yellow:"#E5E5E5",color:canRun?HR.black:"#999",fontWeight:800,fontSize:12,cursor:canRun?"pointer":"not-allowed"}}
        >
          ▶ Run Basket Analysis
        </button>
      </div>

      {!results && (
        <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
          {primaryCats.size === 0 ? "Select at least one Primary category to begin." : "Click Run Basket Analysis."}
        </div>
      )}

      {results && (
        <>
          {/* 5 Summary Cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
            {[
              {num:results.totalOrders,pct:null,lbl:"Total Orders",sub:`${dsFilter} · ${period}`,color:"#0077A8"},
              {num:results.primaryOrders,pct:results.totalOrders?`${((results.primaryOrders/results.totalOrders)*100).toFixed(1)}%`:null,lbl:`Orders with ${primaryLabel}`,sub:"of total orders",color:"#92400E"},
              {num:results.primaryOnlyOrders,pct:results.primaryOrders?`${((results.primaryOnlyOrders/results.primaryOrders)*100).toFixed(1)}%`:null,lbl:`${primaryLabel} Only`,sub:`of ${primaryLabel} orders`,color:"#16a34a"},
              {num:results.primarySecondaryOrders,pct:results.primaryOrders?`${((results.primarySecondaryOrders/results.primaryOrders)*100).toFixed(1)}%`:null,lbl:`+ ${secondaryLabel}`,sub:`of ${primaryLabel} orders`,color:"#B8860B"},
              {num:results.primaryOtherOrders,pct:results.primaryOrders?`${((results.primaryOtherOrders/results.primaryOrders)*100).toFixed(1)}%`:null,lbl:"+ Others",sub:`of ${primaryLabel} orders`,color:"#C05A00"},
            ].map((c,i) => (
              <div key={i} style={S.card}>
                <div style={{fontSize:24,fontWeight:800,color:c.color}}>{c.num.toLocaleString()}</div>
                {c.pct && <div style={{fontSize:16,fontWeight:800,color:c.color,margin:"-2px 0 2px"}}>{c.pct}</div>}
                <div style={{fontSize:11,fontWeight:600,color:"#555"}}>{c.lbl}</div>
                <div style={{fontSize:10,color:HR.muted,marginTop:2}}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:12,marginBottom:16}}>
            {/* Donut */}
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Basket Composition</div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={[
                      {name:`${primaryLabel} Only`,value:results.primaryOnlyOrders},
                      {name:`+ ${secondaryLabel}`,value:results.primarySecondaryOrders},
                      {name:"+ Others",value:results.primaryOtherOrders},
                    ]}
                    cx="50%" cy="50%" innerRadius={55} outerRadius={85}
                    dataKey="value"
                  >
                    {DONUT_COLORS.map((c,i) => <Cell key={i} fill={c}/>)}
                  </Pie>
                  <RTooltip/>
                  <Legend iconSize={10} wrapperStyle={{fontSize:10}}/>
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Co-category bar */}
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Co-Category Frequency (top 10)</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  layout="vertical"
                  data={Object.entries(results.coCatCounts)
                    .sort((a,b) => b[1]-a[1]).slice(0,10)
                    .map(([cat,count]) => ({cat:cat.length>28?cat.slice(0,26)+"…":cat,count,fill:secondaryCats.has(cat)?"#F5C400":"#0077A8"}))}
                  margin={{left:8,right:16,top:0,bottom:0}}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false}/>
                  <XAxis type="number" tick={{fontSize:10}}/>
                  <YAxis type="category" dataKey="cat" width={140} tick={{fontSize:10}}/>
                  <RTooltip formatter={(v) => [v, `Orders with ${primaryLabel}`]}/>
                  <Bar dataKey="count">
                    {Object.entries(results.coCatCounts)
                      .sort((a,b) => b[1]-a[1]).slice(0,10)
                      .map(([cat],i) => <Cell key={i} fill={secondaryCats.has(cat)?"#F5C400":"#0077A8"}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Insight */}
          {(() => {
            const mixedPct = results.primaryOrders > 0
              ? Math.round(((results.primarySecondaryOrders + results.primaryOtherOrders) / results.primaryOrders) * 100)
              : 0;
            const onlyPct = results.primaryOrders > 0
              ? Math.round((results.primaryOnlyOrders / results.primaryOrders) * 100)
              : 0;
            const insight = mixedPct > 60
              ? `High mix rate — routing all ${primaryLabel} to fallback would split most orders. Keeping top ${primaryLabel} SKUs at DS makes sense.`
              : onlyPct > 60
              ? `Most ${primaryLabel} orders are standalone — routing to fallback is operationally clean.`
              : `Mixed/standalone split is roughly even — stock top movers at DS, route bulk to fallback.`;
            const secNote = secondaryCats.size > 0
              ? ` ${secondaryLabel} appears in ${results.primarySecondaryOrders} orders with ${primaryLabel} (${results.primaryOrders > 0 ? Math.round((results.primarySecondaryOrders/results.primaryOrders)*100) : 0}%).`
              : "";
            return (
              <div style={{background:"#FFF9E6",border:"1px solid #FDE68A",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#92400E",lineHeight:1.6}}>
                <strong>Key Insight:</strong> {mixedPct}% of {primaryLabel} orders are mixed (contain other categories). {insight}{secNote}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run dev server and test Basket Analysis**

```bash
npm run dev
```

Test checklist:
- Select a Primary category (e.g. Plywood/MDF) — button turns green
- Select a Secondary category (e.g. Fevicol) — button turns amber
- Change period and DS filter
- Click Run → 5 cards appear with correct counts
- Donut chart renders with 3 segments
- Co-category bar chart renders, secondary categories shown in yellow
- Insight text appears and is logically correct
- Re-upload CSV with shopifyOrder → warning banner disappears
- Without shopifyOrder in data → yellow warning banner shows

- [ ] **Step 3: Commit**
```bash
git add src/tabs/BasketAnalysisTab.jsx
git commit -m "feat: implement Basket Analysis tab"
```

---

## 🔵 MILESTONE 2 — Local test checkpoint

**User tests:** Basket Analysis tab fully functional. Cards, donut, co-category bar, and insight all work correctly.

---

## Task 4: Plywood Network — computation engine

**Files:**
- Modify: `src/tabs/PlywoodNetworkTab.jsx`

All computation logic ported from `analysis/plywood-network.html`. Reference lines 620–715 of that file.

- [ ] **Step 1: Write the computation functions (top of PlywoodNetworkTab.jsx)**

Add these pure functions at the top of the file (before the component):

```jsx
import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  LineChart, Line, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { loadFromSupabase, saveToSupabase } from "../supabase";

// ── Constants ────────────────────────────────────────────────────────────────

const HR = {
  yellow:"#F5C400",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",
};
const S = {
  card:{background:HR.surface,borderRadius:8,padding:12,border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  btn:(on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,transition:"all 0.15s",whiteSpace:"nowrap",outline:"none"}),
  input:{background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"5px 8px",color:HR.text,fontSize:12,width:80},
  sectionTitle:{fontSize:12,fontWeight:700,color:"#555",borderBottom:`2px solid ${HR.yellow}`,paddingBottom:4,marginBottom:12},
};

const PLYWOOD_CATEGORIES = ["Plywood/MDF","HDHMR"];
const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];

const DS_DEFAULTS = {
  DS01: {
    thick: { tier1NZD:10, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:150 },
    thin:  { tier1NZD:10, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:60 },
    shared: { laminateThreshold:1, thresholdPctl:75 }, fallbackLabel:"Om Timber",
  },
  DS02: {
    thick: { tier1NZD:10, tier2NZD:2, minCoverDays:1, coverDays:2, bufferPct:20, capacity:150 },
    thin:  { tier1NZD:10, tier2NZD:2, minCoverDays:1, coverDays:2, bufferPct:20, capacity:60 },
    shared: { laminateThreshold:1, thresholdPctl:75 }, fallbackLabel:"DC (Rampura)",
  },
  DS03: {
    thick: { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:150 },
    thin:  { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:60 },
    shared: { laminateThreshold:1, thresholdPctl:75 }, fallbackLabel:"DC",
  },
  DS04: {
    thick: { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:150 },
    thin:  { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:60 },
    shared: { laminateThreshold:1, thresholdPctl:75 }, fallbackLabel:"DC",
  },
  DS05: {
    thick: { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:150 },
    thin:  { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, capacity:60 },
    shared: { laminateThreshold:1, thresholdPctl:75 }, fallbackLabel:"DC",
  },
};

// ── Thickness helpers ────────────────────────────────────────────────────────

function inferThickness(name) {
  const m = (name || "").match(/(\d+(?:\.\d+)?)\s*mm/i);
  return m ? parseFloat(m[1]) : null;
}

function thicknessCategory(mm, laminateThreshold = 1) {
  if (mm === null) return "Unknown";
  if (mm <= laminateThreshold) return "Laminate";
  if (mm <= 6) return "Thin";
  return "Thick";
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid-1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(arr, pct) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Main computation ─────────────────────────────────────────────────────────

function computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange) {
  // 1. Filter to Plywood categories
  const plywoodSkus = new Set(
    Object.values(skuMaster)
      .filter(s => PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active")
      .map(s => s.sku)
  );

  // 2. Period filter (last N unique dates)
  const allDates = invoiceDateRange.dates;
  const periodDates = new Set(typeof period === "number" ? allDates.slice(-period) : allDates);

  // 3. DS filter
  const rows = invoiceData.filter(r =>
    plywoodSkus.has(r.sku) &&
    periodDates.has(r.date) &&
    (dsFilter === "All" ? DS_LIST.includes(r.ds) : r.ds === dsFilter)
  );

  // 4. Per-SKU aggregation
  const skuMap = {};
  rows.forEach(r => {
    if (!skuMap[r.sku]) skuMap[r.sku] = { dailyMap: {}, orderQtys: [], dates: new Set() };
    skuMap[r.sku].dailyMap[r.date] = (skuMap[r.sku].dailyMap[r.date] || 0) + r.qty;
    skuMap[r.sku].orderQtys.push(r.qty);
    skuMap[r.sku].dates.add(r.date);
  });

  // 5. Build SKU list including active SKUs with 0 sales
  const activeMaster = Object.values(skuMaster).filter(s =>
    PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active"
  );

  return activeMaster.map(s => {
    const agg = skuMap[s.sku];
    const dailyTotals = agg ? Object.values(agg.dailyMap) : [];
    const nzd = agg ? agg.dates.size : 0;
    const dailyMedian = median(dailyTotals);
    const orderQtys = agg ? agg.orderQtys : [];
    const mm = inferThickness(s.name);
    const isLam = s.sku.toUpperCase().includes("LAM") || mm !== null && mm <= 1;
    const thicknessCat = isLam ? "Laminate" : thicknessCategory(mm, 1);
    return {
      sku: s.sku,
      name: s.name,
      thicknessCat,
      mm,
      nzd,
      dailyMedian,
      orderQtys,
      dailyTotals,
      dailyMap: agg?.dailyMap || {},
    };
  }).filter(s => s.thicknessCat !== "Laminate"); // exclude laminates from main tables
}

function computeMinMax(sku, cfg) {
  const minQty = Math.ceil(sku.dailyMedian * cfg.minCoverDays);
  const maxQty = Math.ceil(sku.dailyMedian * cfg.coverDays * (1 + cfg.bufferPct / 100));
  const threshold = percentile(sku.orderQtys, 75);
  return { minQty, maxQty, threshold };
}
```

- [ ] **Step 2: Commit computation functions**
```bash
git add src/tabs/PlywoodNetworkTab.jsx
git commit -m "feat: plywood network computation engine"
```

---

## Task 5: Plywood Network — UI (full implementation)

**Files:**
- Modify: `src/tabs/PlywoodNetworkTab.jsx`

- [ ] **Step 1: Write the full PlywoodNetworkTab component**

After the computation functions from Task 4, append the full component:

```jsx
// ── Config Panel ─────────────────────────────────────────────────────────────

function ConfigPanel({ type, cfg, onChange, isAdmin, onRun }) {
  const label = type === "thick" ? "Thick (>6mm) — Vertical Storage" : "Thin (≤6mm) — Bin Storage";
  const color = type === "thick" ? "#92400E" : "#0077A8";
  const fields = [
    { key:"tier1NZD",   label:"Running NZD",    hint:"Min NZD to stock at DS" },
    { key:"tier2NZD",   label:"Fallback NZD",   hint:"Below → Super Slow" },
    { key:"minCoverDays",label:"Min Cover Days", hint:"Min × daily median" },
    { key:"coverDays",  label:"Max Cover Days",  hint:"Max × daily median × buffer" },
    { key:"bufferPct",  label:"Buffer %",        hint:"Safety margin on Max" },
    { key:"capacity",   label:"Capacity (units)",hint:"Physical constraint" },
  ];
  return (
    <div style={{...S.card,marginBottom:8}}>
      <div style={{fontSize:11,fontWeight:700,color,marginBottom:10}}>{label}</div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-end"}}>
        {fields.map(f => (
          <div key={f.key}>
            <div style={{fontSize:9,color:HR.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>{f.label}</div>
            <input
              type="number"
              value={cfg[f.key]}
              disabled={!isAdmin}
              onChange={e => onChange({ ...cfg, [f.key]: parseFloat(e.target.value) || 0 })}
              style={{...S.input,color,fontWeight:700,border:`1px solid ${color}44`,opacity:isAdmin?1:0.7}}
            />
            <div style={{fontSize:9,color:HR.muted,marginTop:2}}>{f.hint}</div>
          </div>
        ))}
        <button
          onClick={onRun}
          style={{padding:"6px 18px",borderRadius:6,border:"none",background:HR.yellow,color:HR.black,fontWeight:800,fontSize:12,cursor:"pointer",alignSelf:"flex-end",marginBottom:2}}
        >
          ▶ Run
        </button>
      </div>
    </div>
  );
}

// ── Capacity Bar ──────────────────────────────────────────────────────────────

function CapacityBar({ used, total, label }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const over = used > total;
  const barColor = over ? "#B91C1C" : pct > 85 ? "#C05A00" : "#16a34a";
  return (
    <div style={{...S.card,marginBottom:8,padding:"8px 12px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <span style={{fontSize:11,fontWeight:600,color:"#555"}}>{label} Capacity</span>
        <span style={{fontSize:11,fontWeight:700,color:barColor}}>{used}/{total} units ({pct.toFixed(0)}%){over?" — OVER CAPACITY":""}</span>
      </div>
      <div style={{height:6,background:"#E5E5D0",borderRadius:3,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${pct}%`,background:barColor,borderRadius:3,transition:"width 0.3s"}}/>
      </div>
    </div>
  );
}

// ── SKU Table ─────────────────────────────────────────────────────────────────

function SKUTable({ skus, cfg, onSelectSku, fallbackLabel }) {
  const withTiers = skus.map(s => {
    const { minQty, maxQty, threshold } = computeMinMax(s, cfg);
    const tier = s.nzd >= cfg.tier1NZD ? "Running" : s.nzd >= cfg.tier2NZD ? "Fallback" : "Super Slow";
    return { ...s, minQty, maxQty, threshold, tier };
  }).sort((a, b) => {
    const order = { Running:0, Fallback:1, "Super Slow":2 };
    return order[a.tier] !== order[b.tier] ? order[a.tier] - order[b.tier] : b.nzd - a.nzd;
  });

  const TIER_STYLE = {
    "Running":    { bg:"#D1FAE5", color:"#065F46" },
    "Fallback":   { bg:"#FEF3C7", color:"#92400E" },
    "Super Slow": { bg:"#F1F5F9", color:"#64748B" },
  };

  return (
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
      <thead>
        <tr>
          {["SKU","Name","mm","NZD","Daily Median","Min","Max","Threshold","Tier"].map(h => (
            <th key={h} style={{padding:"6px 8px",textAlign:"left",color:HR.muted,background:HR.surfaceLight,fontWeight:600,fontSize:10,whiteSpace:"nowrap",borderBottom:`1px solid ${HR.border}`}}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {withTiers.map(s => {
          const ts = TIER_STYLE[s.tier];
          return (
            <tr
              key={s.sku}
              onClick={() => onSelectSku(s)}
              style={{cursor:"pointer",borderTop:`1px solid ${HR.border}`}}
              onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
              onMouseLeave={e => e.currentTarget.style.background = ""}
            >
              <td style={{padding:"4px 8px",fontWeight:600}}>{s.sku}</td>
              <td style={{padding:"4px 8px",color:HR.muted}}>{s.name}</td>
              <td style={{padding:"4px 8px"}}>{s.mm != null ? `${s.mm}mm` : "—"}</td>
              <td style={{padding:"4px 8px",fontWeight:700}}>{s.nzd}</td>
              <td style={{padding:"4px 8px"}}>{s.dailyMedian.toFixed(1)}</td>
              <td style={{padding:"4px 8px",color:"#16a34a",fontWeight:700}}>{s.nzd > 0 ? s.minQty : "—"}</td>
              <td style={{padding:"4px 8px",color:"#0077A8",fontWeight:700}}>{s.nzd > 0 ? s.maxQty : "—"}</td>
              <td style={{padding:"4px 8px"}}>
                {s.nzd > 0 ? <span style={{fontSize:10,color:"#555"}}>{">"}{s.threshold}</span> : "—"}
              </td>
              <td style={{padding:"4px 8px"}}>
                <span style={{...TAG_STYLE,background:ts.bg,color:ts.color,border:`1px solid ${ts.color}33`}}>
                  {s.tier === "Running" ? "Running — DS" : s.tier === "Fallback" ? `Fallback — ${fallbackLabel}` : "Super Slow"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const TAG_STYLE = {padding:"1px 6px",borderRadius:3,fontSize:9,fontWeight:700,whiteSpace:"nowrap",display:"inline-block"};

// ── SKU Detail Modal ──────────────────────────────────────────────────────────

function SKUModal({ sku, cfg, onClose, invoiceDateRange }) {
  if (!sku) return null;
  const { minQty, maxQty } = computeMinMax(sku, cfg);

  // Histogram: bucket order qtys
  const qtyBuckets = {};
  sku.orderQtys.forEach(q => {
    const b = Math.ceil(q);
    qtyBuckets[b] = (qtyBuckets[b] || 0) + 1;
  });
  const histData = Object.entries(qtyBuckets).sort((a,b)=>+a[0]-+b[0]).map(([qty,count])=>({qty:+qty,count}));

  // Timeline: daily totals over full period calendar
  const allDates = invoiceDateRange.dates;
  const timelineData = allDates.map(date => ({
    date,
    qty: sku.dailyMap[date] || 0,
  }));

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:HR.surface,borderRadius:12,padding:24,width:"min(860px,95vw)",maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <div style={{fontSize:14,fontWeight:700}}>{sku.sku}</div>
            <div style={{fontSize:11,color:HR.muted}}>{sku.name} · {sku.thicknessCat} · NZD {sku.nzd} · Min {minQty} · Max {maxQty}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:`1px solid ${HR.border}`,borderRadius:4,padding:"4px 14px",cursor:"pointer",fontSize:12,color:HR.muted,fontWeight:600}}>Close ✕</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#555",marginBottom:6}}>Order Qty Distribution</div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={histData} margin={{left:0,right:8,top:4,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="qty" tick={{fontSize:10}} label={{value:"Qty",position:"insideBottom",offset:-2,fontSize:10}}/>
                <YAxis tick={{fontSize:10}}/>
                <RTooltip formatter={(v,n,p) => [v, "Orders"]} labelFormatter={l => `Qty: ${l}`}/>
                <Bar dataKey="count" fill="#0077A8" radius={[2,2,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#555",marginBottom:6}}>Daily Consumption</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={timelineData} margin={{left:0,right:8,top:4,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="date" tick={false}/>
                <YAxis tick={{fontSize:10}}/>
                <RTooltip/>
                {minQty > 0 && <ReferenceLine y={minQty} stroke="#16a34a" strokeDasharray="4 4" label={{value:`Min ${minQty}`,position:"right",fontSize:9,fill:"#16a34a"}}/>}
                {maxQty > 0 && <ReferenceLine y={maxQty} stroke="#0077A8" strokeDasharray="4 4" label={{value:`Max ${maxQty}`,position:"right",fontSize:9,fill:"#0077A8"}}/>}
                <Line type="monotone" dataKey="qty" stroke="#92400E" strokeWidth={1.5} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Summary Cards ─────────────────────────────────────────────────────────────

function SummaryCards({ skuList, skuMaster, dsFilter }) {
  const plywoodActive = Object.values(skuMaster).filter(s =>
    PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active"
  );
  const masterThickCount = plywoodActive.filter(s => {
    if (s.sku.toUpperCase().includes("LAM")) return false;
    const mm = inferThickness(s.name);
    return thicknessCategory(mm, 1) === "Thick";
  }).length;
  const masterThinCount = plywoodActive.filter(s => {
    if (s.sku.toUpperCase().includes("LAM")) return false;
    const mm = inferThickness(s.name);
    const cat = thicknessCategory(mm, 1);
    return cat === "Thin" || cat === "Unknown";
  }).length;

  const withSales = skuList.filter(s => s.nzd > 0).length;
  const tierOf = (s, cfg) => s.nzd >= cfg.tier1NZD ? "Running" : s.nzd >= cfg.tier2NZD ? "Fallback" : "Super Slow";

  const cards = [
    { num: withSales, lbl: `SKUs with ≥1 sale / ${plywoodActive.length} Active`, sub: `Thick: ${masterThickCount} · Thin: ${masterThinCount} in master`, color:"#0077A8" },
    { num: skuList.filter(s=>s.thicknessCat==="Thick"?s.nzd>=10:s.nzd>=10).length, lbl:"Running — Stock at DS", sub:"NZD above tier1 threshold", color:"#16a34a" },
    { num: skuList.filter(s=>s.thicknessCat==="Thick"?s.nzd>=2&&s.nzd<10:s.nzd>=2&&s.nzd<10).length, lbl:"Fallback — DC or Supplier", sub:"NZD tier2 to tier1", color:"#92400E" },
    { num: skuList.filter(s=>s.nzd<2).length, lbl:"Super Slow — On Demand", sub:"NZD below tier2 threshold", color:"#6B7280" },
  ];

  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16}}>
      {cards.map((c,i) => (
        <div key={i} style={S.card}>
          <div style={{fontSize:22,fontWeight:800,color:c.color}}>{c.num}</div>
          <div style={{fontSize:11,fontWeight:600,color:"#555",margin:"2px 0"}}>{c.lbl}</div>
          <div style={{fontSize:10,color:HR.muted,lineHeight:1.5}}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function PlywoodNetworkTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin, networkConfigs, onSaveConfigs }) {
  const [dsFilter, setDsFilter] = useState("DS01");
  const [period, setPeriod] = useState(45);
  const [thickCfg, setThickCfg] = useState(null);
  const [thinCfg, setThinCfg] = useState(null);
  const [sharedCfg, setSharedCfg] = useState(null);
  const [thickResults, setThickResults] = useState(null);
  const [thinResults, setThinResults] = useState(null);
  const [allSkus, setAllSkus] = useState([]);
  const [selectedSku, setSelectedSku] = useState(null);
  const [selectedSkuType, setSelectedSkuType] = useState(null); // "thick" or "thin"

  // Load configs from networkConfigs prop (Supabase) or DS_DEFAULTS fallback
  useEffect(() => {
    const saved = networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter];
    setThickCfg({ ...DS_DEFAULTS[dsFilter].thick, ...saved.thick });
    setThinCfg({ ...DS_DEFAULTS[dsFilter].thin, ...saved.thin });
    setSharedCfg({ ...DS_DEFAULTS[dsFilter].shared, ...saved.shared });
  }, [dsFilter, networkConfigs]);

  const handleSaveConfig = useCallback((type, newCfg) => {
    if (!isAdmin) return;
    const merged = {
      ...(networkConfigs || {}),
      [dsFilter]: {
        ...(networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter]),
        [type]: newCfg,
      }
    };
    onSaveConfigs(merged);
  }, [dsFilter, networkConfigs, onSaveConfigs, isAdmin]);

  const baseSkus = useMemo(() =>
    computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange),
    [invoiceData, skuMaster, dsFilter, period, invoiceDateRange]
  );

  const thickSkus = useMemo(() => baseSkus.filter(s => s.thicknessCat === "Thick"), [baseSkus]);
  const thinSkus  = useMemo(() => baseSkus.filter(s => s.thicknessCat !== "Thick"), [baseSkus]);

  const runThick = useCallback(() => {
    const withMM = thickSkus.map(s => ({ ...s, ...computeMinMax(s, thickCfg) }));
    const capUsed = withMM.filter(s => s.nzd >= thickCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    setThickResults({ skus: withMM, capUsed });
    if (isAdmin && thickCfg) handleSaveConfig("thick", thickCfg);
  }, [thickSkus, thickCfg, isAdmin, handleSaveConfig]);

  const runThin = useCallback(() => {
    const withMM = thinSkus.map(s => ({ ...s, ...computeMinMax(s, thinCfg) }));
    const capUsed = withMM.filter(s => s.nzd >= thinCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    setThinResults({ skus: withMM, capUsed });
    if (isAdmin && thinCfg) handleSaveConfig("thin", thinCfg);
  }, [thinSkus, thinCfg, isAdmin, handleSaveConfig]);

  if (!invoiceData.length || !Object.keys(skuMaster).length) return (
    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
      Upload invoice CSV and SKU Master in the Upload Data tab to begin.
    </div>
  );

  if (!thickCfg || !thinCfg) return null;

  const dsFallbackLabel = (networkConfigs?.[dsFilter]?.fallbackLabel) || DS_DEFAULTS[dsFilter]?.fallbackLabel || "DC";

  return (
    <div style={{fontFamily:"Inter,sans-serif",color:HR.text}}>
      {/* DS Selector + Period */}
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:4}}>
          {DS_LIST.map(ds => (
            <button key={ds} onClick={() => { setDsFilter(ds); setThickResults(null); setThinResults(null); }} style={S.btn(dsFilter===ds)}>{ds}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:4,marginLeft:12}}>
          {[{v:45,l:"L45D"},{v:30,l:"L30D"},{v:15,l:"L15D"},{v:7,l:"L7D"}].map(p => (
            <button key={p.v} onClick={() => { setPeriod(p.v); setThickResults(null); setThinResults(null); }} style={S.btn(period===p.v)}>{p.l}</button>
          ))}
        </div>
        {!isAdmin && <span style={{fontSize:10,color:HR.muted,marginLeft:"auto"}}>Configs are view-only · Admin login to edit</span>}
      </div>

      {/* Summary Cards */}
      <SummaryCards skuList={baseSkus} skuMaster={skuMaster} dsFilter={dsFilter}/>

      {/* ── Thick Section ── */}
      <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thick (&gt;6mm) — Vertical Storage</div>
        <ConfigPanel type="thick" cfg={thickCfg} onChange={setThickCfg} isAdmin={isAdmin} onRun={runThick}/>
        {thickResults && (
          <>
            <CapacityBar used={thickResults.capUsed} total={thickCfg.capacity} label="Thick"/>
            <div style={S.card}>
              <SKUTable skus={thickResults.skus} cfg={thickCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }}/>
            </div>
          </>
        )}
        {!thickResults && <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click Run</div>}
      </div>

      {/* ── Thin Section ── */}
      <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thin (≤6mm) — Bin Storage</div>
        <ConfigPanel type="thin" cfg={thinCfg} onChange={setThinCfg} isAdmin={isAdmin} onRun={runThin}/>
        {thinResults && (
          <>
            <CapacityBar used={thinResults.capUsed} total={thinCfg.capacity} label="Thin"/>
            <div style={S.card}>
              <SKUTable skus={thinResults.skus} cfg={thinCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }}/>
            </div>
          </>
        )}
        {!thinResults && <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click Run</div>}
      </div>

      {/* SKU Detail Modal */}
      {selectedSku && (
        <SKUModal
          sku={selectedSku}
          cfg={selectedSkuType === "thick" ? thickCfg : thinCfg}
          onClose={() => setSelectedSku(null)}
          invoiceDateRange={invoiceDateRange}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run dev server and test Plywood Network**

```bash
npm run dev
```

Test checklist:
- Select DS01 → configs load with DS01 defaults (or saved values from Supabase)
- Change to DS02 → configs update to DS02 values
- Click "Run" in Thick section → capacity bar + SKU table render
- Click "Run" in Thin section → separate capacity bar + table render
- SKUs sorted: Running → Fallback → Super Slow within each section
- Click a SKU row → modal opens with histogram + timeline
- Timeline shows Min/Max dotted reference lines
- Over-capacity state: capacity bar turns red when capUsed > capacity
- Non-admin: config inputs are disabled/greyed out
- Admin: changing a config value and clicking Run saves to Supabase (verify in Supabase dashboard or reload page)

- [ ] **Step 3: Commit**
```bash
git add src/tabs/PlywoodNetworkTab.jsx
git commit -m "feat: implement Plywood Network tab"
```

---

## 🔵 MILESTONE 3 — Local test checkpoint

**User tests:** Full Plywood Network tab functional. Per-DS configs save/load from Supabase. SKU tables, capacity bars, and modal charts all render correctly.

---

## Self-Review Notes

**Spec coverage:**
- ✅ ST-1: `shopifyOrder` added to `handleInvoice`
- ✅ ST-2: DS filter (row-level), period filter (last N unique trading dates), BA_PERIODS L45D→L3D
- ✅ ST-3: 5 summary cards, donut (Recharts PieChart), co-category horizontal bar, insight text
- ✅ ST-4: Thickness regex from `skuMaster.name`, median daily totals, NZD per DS, Min/Max formula, routing threshold percentile, tier classification
- ✅ ST-5: networkConfigs in Supabase `params/networkConfigs`, DS_DEFAULTS fallback, admin-only save
- ✅ ST-6: DS selector, 4 summary cards, Thick/Thin sections each with Config→Run→Capacity→Table, per-SKU modal with histogram + timeline, recommendation only
- ✅ ST-7: "Baskets" and "Plywood" in both ADMIN_TABS and PUBLIC_TABS, position after SKU Detail, non-admin read-only configs

**Key type/name consistency:**
- `computeMinMax(sku, cfg)` returns `{ minQty, maxQty, threshold }` — used consistently in SKUTable and SKUModal
- `computePlywoodSKUs` returns array of `{ sku, name, thicknessCat, mm, nzd, dailyMedian, orderQtys, dailyTotals, dailyMap }` — consumed by thickSkus/thinSkus filters and SummaryCards
- `networkConfigs` shape: `{ DS01: { thick, thin, shared, fallbackLabel }, ... }` — matches DS_DEFAULTS exactly
