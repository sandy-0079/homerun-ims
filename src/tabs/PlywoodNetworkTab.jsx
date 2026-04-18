import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import { saveToSupabase } from "../supabase";

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

const PLYWOOD_CATEGORIES = ["Plywood, MDF & HDHMR"];
const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];

const DS_DEFAULTS = {
  DS01: {
    thick: { tier1NZD:10, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:150 },
    thin:  { tier1NZD:10, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:60 },
    shared: { laminateThreshold:1 }, fallbackLabel:"Om Timber",
  },
  DS02: {
    thick: { tier1NZD:10, tier2NZD:2, minCoverDays:1, coverDays:2, bufferPct:20, thresholdPctl:75, capacity:150 },
    thin:  { tier1NZD:10, tier2NZD:2, minCoverDays:1, coverDays:2, bufferPct:20, thresholdPctl:75, capacity:60 },
    shared: { laminateThreshold:1 }, fallbackLabel:"DC (Rampura)",
  },
  DS03: {
    thick: { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:150 },
    thin:  { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:60 },
    shared: { laminateThreshold:1 }, fallbackLabel:"DC",
  },
  DS04: {
    thick: { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:150 },
    thin:  { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:60 },
    shared: { laminateThreshold:1 }, fallbackLabel:"DC",
  },
  DS05: {
    thick: { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:150 },
    thin:  { tier1NZD:6, tier2NZD:2, minCoverDays:1.5, coverDays:3, bufferPct:20, thresholdPctl:75, capacity:60 },
    shared: { laminateThreshold:1 }, fallbackLabel:"DC",
  },
};

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

function computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange) {
  const plywoodSkus = new Set(
    Object.values(skuMaster)
      .filter(s => PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active")
      .map(s => s.sku)
  );
  const allDates = invoiceDateRange.dates;
  const periodDates = new Set(typeof period === "number" ? allDates.slice(-period) : allDates);
  const rows = invoiceData.filter(r =>
    plywoodSkus.has(r.sku) &&
    periodDates.has(r.date) &&
    (dsFilter === "All" ? DS_LIST.includes(r.ds) : r.ds === dsFilter)
  );
  const skuMap = {};
  rows.forEach(r => {
    if (!skuMap[r.sku]) skuMap[r.sku] = { dailyMap: {}, orderQtys: [], dates: new Set() };
    skuMap[r.sku].dailyMap[r.date] = (skuMap[r.sku].dailyMap[r.date] || 0) + r.qty;
    skuMap[r.sku].orderQtys.push(r.qty);
    skuMap[r.sku].dates.add(r.date);
  });
  const activeMaster = Object.values(skuMaster).filter(s =>
    PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active"
  );
  return activeMaster.map(s => {
    const agg = skuMap[s.sku];
    const dailyTotals = agg ? Object.values(agg.dailyMap) : [];
    const nzd = agg ? agg.dates.size : 0;
    const dailyMedian = dailyTotals.length > 0 ? Math.ceil(median(dailyTotals)) : 0;
    const orderQtys = agg ? agg.orderQtys : [];
    const mm = inferThickness(s.name);
    const isLam = s.sku.toUpperCase().includes("LAM") || (mm !== null && mm <= 1);
    const thicknessCat = isLam ? "Laminate" : thicknessCategory(mm, 1);
    return { sku: s.sku, name: s.name, thicknessCat, mm, nzd, dailyMedian, orderQtys, dailyTotals, dailyMap: agg?.dailyMap || {} };
  }).filter(s => s.thicknessCat !== "Laminate");
}

function computeMinMax(sku, cfg) {
  const minQty = Math.ceil(sku.dailyMedian * cfg.minCoverDays);
  const maxQty = Math.ceil(sku.dailyMedian * cfg.coverDays * (1 + cfg.bufferPct / 100));
  const threshold = percentile(sku.orderQtys, cfg.thresholdPctl ?? 75);
  return { minQty, maxQty, threshold };
}

const TAG_STYLE = {padding:"1px 6px",borderRadius:3,fontSize:9,fontWeight:700,whiteSpace:"nowrap",display:"inline-block"};

function ConfigPanel({ type, cfg, onChange, isAdmin, onRun, dirty }) {
  const label = type === "thick" ? "Thick (>6mm) — Vertical Storage" : "Thin (≤6mm) — Bin Storage";
  const color = type === "thick" ? "#92400E" : "#0077A8";
  const fields = [
    { key:"tier1NZD",    label:"Running NZD",     hint:"Min NZD to stock at DS" },
    { key:"tier2NZD",    label:"Fallback NZD",    hint:"Below → Super Slow" },
    { key:"minCoverDays",label:"Min Cover Days",  hint:"Min × daily median" },
    { key:"coverDays",   label:"Max Cover Days",  hint:"Max × daily median × buffer" },
    { key:"bufferPct",      label:"Buffer %",           hint:"Safety margin on Max" },
    { key:"thresholdPctl",  label:"Fallback Threshold",hint:"Percentile (75 = P75)" },
    { key:"capacity",       label:"Capacity (units)",   hint:"Physical constraint" },
  ];
  return (
    <div style={{...S.card,marginBottom:8}}>
      <div style={{fontSize:11,fontWeight:700,color,marginBottom:10}}>{label}</div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-end",justifyContent:"space-between"}}>
        <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"flex-end"}}>
          {fields.map(f => (
            <div key={f.key}>
              <div style={{fontSize:9,color:HR.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:2}}>{f.label}</div>
              <input
                type="number"
                value={cfg[f.key]}
                disabled={!isAdmin}
                onChange={e => onChange({ ...cfg, [f.key]: parseFloat(e.target.value) || 0 })}
                onFocus={e => e.target.select()}
                style={{...S.input,color,fontWeight:700,border:`1px solid ${color}44`,opacity:isAdmin?1:0.7}}
              />
              <div style={{fontSize:9,color:HR.muted,marginTop:2}}>{f.hint}</div>
            </div>
          ))}
        </div>
        <button
          onClick={dirty ? onRun : undefined}
          style={{padding:"6px 20px",borderRadius:6,border:"none",background:dirty?HR.yellow:"#E5E5E5",color:dirty?HR.black:"#999",fontWeight:800,fontSize:12,cursor:dirty?"pointer":"default",alignSelf:"flex-end",marginBottom:2,flexShrink:0}}
        >
          ▶ Run
        </button>
      </div>
    </div>
  );
}

function CapacityBar({ used, total, label }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const over = used > total;
  const majorOver = used > total * 1.1;
  const barColor = majorOver ? "#B91C1C" : over ? "#C05A00" : "#16a34a";
  const barWidth = Math.min(100, pct);
  const statusText = majorOver ? " — OVER CAPACITY (>10%)" : over ? " — OVER CAPACITY" : "";
  return (
    <div style={{...S.card,marginBottom:8,padding:"8px 12px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <span style={{fontSize:11,fontWeight:600,color:"#555"}}>{label} Capacity</span>
        <span style={{fontSize:11,fontWeight:700,color:barColor}}>
          {used}/{total} units ({pct.toFixed(0)}%){statusText}
        </span>
      </div>
      <div style={{height:6,background:"#E5E5D0",borderRadius:3,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${barWidth}%`,background:barColor,borderRadius:3,transition:"width 0.3s"}}/>
      </div>
    </div>
  );
}

function SKUTable({ skus, cfg, onSelectSku, fallbackLabel }) {
  // skus already have minQty/maxQty/threshold baked in from runThick/runThin — use them directly
  const withTiers = skus.map(s => {
    const { minQty, maxQty, threshold } = s;
    const tier = s.nzd >= cfg.tier1NZD ? "Running" : s.nzd >= cfg.tier2NZD ? "Fallback" : "Super Slow";
    const minCov = s.dailyMedian > 0 ? (minQty / s.dailyMedian).toFixed(1) + "d" : "—";
    const maxCov = s.dailyMedian > 0 ? (maxQty / s.dailyMedian).toFixed(1) + "d" : "—";
    return { ...s, minQty, maxQty, threshold, tier, minCov, maxCov };
  }).sort((a, b) => {
    const order = { Running:0, Fallback:1, "Super Slow":2 };
    return order[a.tier] !== order[b.tier] ? order[a.tier] - order[b.tier] : b.nzd - a.nzd;
  });
  const TIER_STYLE = {
    "Running":    { bg:"#D1FAE5", color:"#065F46" },
    "Fallback":   { bg:"#FEF3C7", color:"#92400E" },
    "Super Slow": { bg:"#F1F5F9", color:"#64748B" },
  };
  const thL = {padding:"6px 8px",textAlign:"left",color:HR.muted,background:HR.surfaceLight,fontWeight:600,fontSize:10,whiteSpace:"nowrap",borderBottom:`1px solid ${HR.border}`};
  const thC = {...thL, textAlign:"center"};
  const tdC = {padding:"4px 8px",textAlign:"center"};
  return (
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
      <thead>
        <tr>
          <th style={thL}>#</th>
          <th style={thL}>SKU</th>
          <th style={thL}>Item Name</th>
          <th style={thC}>mm</th>
          <th style={thC}>NZD</th>
          <th style={thC}>Daily Med</th>
          <th style={thC}>Min</th>
          <th style={thC}>Min Cov</th>
          <th style={thC}>Max</th>
          <th style={thC}>Max Cov</th>
          <th style={thC}>Threshold</th>
          <th style={thL}>Stocking</th>
        </tr>
      </thead>
      <tbody>
        {withTiers.map((s, idx) => {
          const ts = TIER_STYLE[s.tier];
          return (
            <tr key={s.sku} onClick={() => onSelectSku(s)} style={{cursor:"pointer",borderTop:`1px solid ${HR.border}`}}
              onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
              onMouseLeave={e => e.currentTarget.style.background = ""}>
              <td style={{padding:"4px 8px",color:HR.muted}}>{idx+1}</td>
              <td style={{padding:"4px 8px",fontWeight:600}}>{s.sku}</td>
              <td style={{padding:"4px 8px",color:HR.muted}}>{s.name}</td>
              <td style={tdC}>{s.mm != null ? `${s.mm}` : "—"}</td>
              <td style={{...tdC,fontWeight:700}}>{s.nzd}</td>
              <td style={tdC}>{s.dailyMedian > 0 ? s.dailyMedian.toFixed(0) : "—"}</td>
              <td style={{...tdC,color:"#16a34a",fontWeight:700}}>{s.nzd > 0 ? s.minQty : "—"}</td>
              <td style={{...tdC,color:HR.muted}}>{s.nzd > 0 ? s.minCov : "—"}</td>
              <td style={{...tdC,color:"#0077A8",fontWeight:700}}>{s.nzd > 0 ? s.maxQty : "—"}</td>
              <td style={{...tdC,color:HR.muted}}>{s.nzd > 0 ? s.maxCov : "—"}</td>
              <td style={tdC}>{s.nzd > 0 ? <span style={{fontSize:10,color:"#555"}}>≥{s.threshold} → fallback</span> : "—"}</td>
              <td style={{padding:"4px 8px"}}>
                <span style={{...TAG_STYLE,background:ts.bg,color:ts.color,border:`1px solid ${ts.color}33`}}>
                  {s.tier === "Running" ? "Running — Stock at DS" : s.tier === "Fallback" ? `Fallback — ${fallbackLabel}` : "Super Slow"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SKUModal({ sku, cfg, onClose, invoiceDateRange }) {
  if (!sku) return null;
  const { minQty, maxQty, threshold } = computeMinMax(sku, cfg);
  const tier = sku.nzd >= cfg.tier1NZD ? "Running — Stock at DS" : sku.nzd >= cfg.tier2NZD ? "Fallback" : "Super Slow";
  const tierColor = sku.nzd >= cfg.tier1NZD ? "#16a34a" : sku.nzd >= cfg.tier2NZD ? "#92400E" : "#64748B";
  const minCov = sku.dailyMedian > 0 ? (minQty / sku.dailyMedian).toFixed(1) + "d" : "—";
  const maxCov = sku.dailyMedian > 0 ? (maxQty / sku.dailyMedian).toFixed(1) + "d" : "—";

  // Count orders below/above threshold
  const ordersAtDS = sku.orderQtys.filter(q => q <= threshold).length;
  const ordersFallback = sku.orderQtys.filter(q => q > threshold).length;

  // Histogram: bucket order qtys, color by threshold
  const qtyBuckets = {};
  sku.orderQtys.forEach(q => { const b = Math.ceil(q); qtyBuckets[b] = (qtyBuckets[b] || 0) + 1; });
  const histData = Object.entries(qtyBuckets)
    .sort((a,b) => +a[0] - +b[0])
    .map(([qty, count]) => ({ qty: +qty, count, fill: +qty <= threshold ? "#0077A8" : "#F5D77A" }));

  // Timeline: all dates in period
  const timelineData = invoiceDateRange.dates.map(date => ({
    date: date.slice(5), // MM-DD
    qty: sku.dailyMap[date] || 0,
  }));

  // Shared bar size: use NZD (actual sale days) not total dates — bars only appear on NZD days
  const sharedBarSize = Math.max(6, Math.min(32, Math.floor(420 / Math.max(histData.length, sku.nzd || 1))));

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:HR.surface,borderRadius:12,padding:24,width:"min(900px,96vw)",maxHeight:"88vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <span style={{fontSize:16,fontWeight:800,color:HR.text}}>{sku.name}</span>
            <span style={{fontSize:12,color:HR.muted,marginLeft:10}}>{sku.sku} · {sku.mm != null ? `${sku.mm}mm` : "—"}</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:`1px solid ${HR.border}`,borderRadius:6,padding:"4px 14px",cursor:"pointer",fontSize:12,color:HR.muted,fontWeight:600,whiteSpace:"nowrap"}}>Close ✕</button>
        </div>

        {/* Stats row */}
        <div style={{display:"flex",gap:20,flexWrap:"wrap",padding:"8px 12px",background:HR.surfaceLight,borderRadius:6,marginBottom:16,fontSize:12,color:"#555"}}>
          <span>Total Orders: <strong style={{color:"#1A1A1A"}}>{sku.orderQtys.length}</strong></span>
          <span>NZD: <strong style={{color:"#1A1A1A"}}>{sku.nzd}</strong></span>
          <span>Daily Median: <strong style={{color:"#0077A8"}}>{sku.dailyMedian > 0 ? sku.dailyMedian.toFixed(0) : "—"}</strong></span>
          <span>Min: <strong style={{color:"#B91C1C"}}>{minQty}</strong> <span style={{color:HR.muted}}>({minCov})</span></span>
          <span>Max: <strong style={{color:"#16a34a"}}>{maxQty}</strong> <span style={{color:HR.muted}}>({maxCov})</span></span>
          <span>Threshold (P{cfg.thresholdPctl ?? 75}): <strong style={{color:"#92400E"}}>{threshold}</strong></span>
        </div>

        {/* Charts */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginBottom:16}}>
          {/* Histogram */}
          <div>
            <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Order Qty Distribution</div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={histData} margin={{left:8,right:8,top:4,bottom:20}}>
                <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="qty" tick={{fontSize:10}} label={{value:"Order Qty",position:"insideBottom",offset:-10,fontSize:10}}/>
                <YAxis tick={{fontSize:10}} label={{value:"Frequency",angle:-90,position:"insideLeft",offset:10,fontSize:10}}/>
                <RTooltip formatter={(v) => [v,"Orders"]} labelFormatter={l=>`Qty: ${l}`}/>
                <ReferenceLine x={threshold} stroke="#C05A00" strokeDasharray="4 4" strokeWidth={2}
                  label={{value:`≤${threshold} → DS`,position:"insideTopRight",fontSize:9,fill:"#C05A00",fontWeight:700}}/>
                <Bar dataKey="count" barSize={sharedBarSize} radius={[2,2,0,0]}>
                  {histData.map((d,i) => <Cell key={i} fill={d.fill}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Daily Consumption */}
          <div>
            <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Daily Consumption</div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={timelineData} margin={{left:8,right:64,top:4,bottom:20}}>
                <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="date" tick={{fontSize:9}} interval={Math.floor(timelineData.length/6)} label={{value:"Date",position:"insideBottom",offset:-10,fontSize:10}}/>
                <YAxis tick={{fontSize:10}} label={{value:"Qty",angle:-90,position:"insideLeft",offset:10,fontSize:10}}/>
                <RTooltip/>
                {minQty > 0 && <ReferenceLine y={minQty} stroke="#B91C1C" strokeDasharray="5 4" label={{value:`Min=${minQty}`,position:"right",fontSize:9,fill:"#B91C1C"}}/>}
                {maxQty > 0 && <ReferenceLine y={maxQty} stroke="#16a34a" strokeDasharray="5 4" label={{value:`Max=${maxQty}`,position:"right",fontSize:9,fill:"#16a34a"}}/>}
                <Bar dataKey="qty" barSize={sharedBarSize} fill="#0077A8" radius={[2,2,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Classification footer */}
        <div style={{fontSize:11,color:HR.muted,lineHeight:1.8,borderTop:`1px solid ${HR.border}`,paddingTop:10}}>
          <div><strong style={{color:HR.text}}>Classification:</strong> <span style={{color:tierColor,fontWeight:600}}>{tier}</span> (NZD {sku.nzd} {sku.nzd >= cfg.tier1NZD ? "≥" : sku.nzd >= cfg.tier2NZD ? "≥" : "<"} {sku.nzd >= cfg.tier1NZD ? cfg.tier1NZD : cfg.tier2NZD})</div>
          <div><strong style={{color:HR.text}}>Min</strong> = ceil({sku.dailyMedian > 0 ? sku.dailyMedian.toFixed(0) : 0} daily median × {cfg.minCoverDays} min cover days) = <strong style={{color:"#B91C1C"}}>{minQty}</strong></div>
          <div><strong style={{color:HR.text}}>Max</strong> = ceil({sku.dailyMedian > 0 ? sku.dailyMedian.toFixed(0) : 0} daily median × {cfg.coverDays} max cover days × {(1+cfg.bufferPct/100).toFixed(2)} buffer) = <strong style={{color:"#16a34a"}}>{maxQty}</strong></div>
          <div><strong style={{color:HR.text}}>Threshold:</strong> Orders ≤ {threshold} fulfilled from DS ({ordersAtDS} orders) · Orders &gt; {threshold} → fallback ({ordersFallback} orders)</div>
        </div>
      </div>
    </div>
  );
}

function SummaryCards({ skuList, skuMaster, thickCfg, thinCfg }) {
  const plywoodActive = Object.values(skuMaster).filter(s =>
    PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active"
  );
  const masterThickCount = plywoodActive.filter(s => {
    if (s.sku.toUpperCase().includes("LAM")) return false;
    return thicknessCategory(inferThickness(s.name), 1) === "Thick";
  }).length;
  const masterThinCount = plywoodActive.filter(s => {
    if (s.sku.toUpperCase().includes("LAM")) return false;
    const cat = thicknessCategory(inferThickness(s.name), 1);
    return cat === "Thin" || cat === "Unknown";
  }).length;

  const totalActive = masterThickCount + masterThinCount;
  const withSales = skuList.filter(s => s.nzd > 0).length;

  const t1thick = thickCfg?.tier1NZD ?? 10;
  const t2thick = thickCfg?.tier2NZD ?? 2;
  const t1thin  = thinCfg?.tier1NZD  ?? 10;
  const t2thin  = thinCfg?.tier2NZD  ?? 2;

  const thickList = skuList.filter(s => s.thicknessCat === "Thick");
  const thinList  = skuList.filter(s => s.thicknessCat !== "Thick");

  const runThick  = thickList.filter(s => s.nzd >= t1thick).length;
  const runThin   = thinList.filter(s  => s.nzd >= t1thin).length;
  const fbThick   = thickList.filter(s => s.nzd >= t2thick && s.nzd < t1thick).length;
  const fbThin    = thinList.filter(s  => s.nzd >= t2thin  && s.nzd < t1thin).length;
  const ssThick   = thickList.filter(s => s.nzd < t2thick).length;
  const ssThin    = thinList.filter(s  => s.nzd < t2thin).length;

  const pct = (n, d) => d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
  const breakdown = (tk, tn) =>
    `Thick: ${tk} (${pct(tk, masterThickCount)} of ${masterThickCount}) · Thin: ${tn} (${pct(tn, masterThinCount)} of ${masterThinCount})`;

  const cards = [
    {
      num: withSales,
      lbl: `SKUs with ≥1 sale / ${totalActive} Active`,
      sub: `${pct(withSales, totalActive)} of active · Thick: ${masterThickCount} · Thin: ${masterThinCount}`,
      color: "#0077A8",
    },
    { num: runThick + runThin,  lbl: "Running — Stock at DS",      sub: breakdown(runThick, runThin),  color: "#16a34a" },
    { num: fbThick  + fbThin,   lbl: "Fallback — DC or Supplier",  sub: breakdown(fbThick,  fbThin),   color: "#92400E" },
    { num: ssThick  + ssThin,   lbl: "Super Slow — On Demand",     sub: breakdown(ssThick,  ssThin),   color: "#6B7280" },
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

export default function PlywoodNetworkTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin, networkConfigs, onSaveConfigs }) {
  const [dsFilter, setDsFilter] = useState("DS01");
  const [period, setPeriod] = useState(45);
  const [thickCfg, setThickCfg] = useState(null);
  const [thinCfg, setThinCfg] = useState(null);
  const [committedThickCfg, setCommittedThickCfg] = useState(null); // config at last Run — drives SummaryCards
  const [committedThinCfg, setCommittedThinCfg] = useState(null);
  const [thickResults, setThickResults] = useState(null);
  const [thinResults, setThinResults] = useState(null);
  const [resultsCache, setResultsCache] = useState({}); // per-DS result cache
  const [selectedSku, setSelectedSku] = useState(null);
  const [selectedSkuType, setSelectedSkuType] = useState(null);

  // Reload configs when DS or saved configs change
  useEffect(() => {
    const saved = networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter];
    setThickCfg({ ...DS_DEFAULTS[dsFilter].thick, ...saved.thick });
    setThinCfg({ ...DS_DEFAULTS[dsFilter].thin, ...saved.thin });
  }, [dsFilter, networkConfigs]);

  // On DS change: restore cached results if available, else clear
  useEffect(() => {
    const cached = resultsCache[dsFilter];
    setThickResults(cached?.thick || null);
    setThinResults(cached?.thin || null);
    setCommittedThickCfg(cached?.thickCfg || null);
    setCommittedThinCfg(cached?.thinCfg || null);
  }, [dsFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const r = { skus: withMM, capUsed };
    setThickResults(r);
    setCommittedThickCfg(thickCfg);
    setResultsCache(prev => ({ ...prev, [dsFilter]: { ...prev[dsFilter], thick: r, thickCfg } }));
    if (isAdmin) handleSaveConfig("thick", thickCfg);
  }, [thickSkus, thickCfg, dsFilter, isAdmin, handleSaveConfig]);

  const runThin = useCallback(() => {
    const withMM = thinSkus.map(s => ({ ...s, ...computeMinMax(s, thinCfg) }));
    const capUsed = withMM.filter(s => s.nzd >= thinCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const r = { skus: withMM, capUsed };
    setThinResults(r);
    setCommittedThinCfg(thinCfg);
    setResultsCache(prev => ({ ...prev, [dsFilter]: { ...prev[dsFilter], thin: r, thinCfg } }));
    if (isAdmin) handleSaveConfig("thin", thinCfg);
  }, [thinSkus, thinCfg, dsFilter, isAdmin, handleSaveConfig]);

  if (!invoiceData.length || !Object.keys(skuMaster).length) return (
    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
      Upload invoice CSV and SKU Master in the Upload Data tab to begin.
    </div>
  );
  if (!thickCfg || !thinCfg) return null;

  const thickDirty = !committedThickCfg || JSON.stringify(thickCfg) !== JSON.stringify(committedThickCfg);
  const thinDirty  = !committedThinCfg  || JSON.stringify(thinCfg)  !== JSON.stringify(committedThinCfg);
  const dsFallbackLabel = networkConfigs?.[dsFilter]?.fallbackLabel || DS_DEFAULTS[dsFilter]?.fallbackLabel || "DC";

  return (
    <div style={{fontFamily:"Inter,sans-serif",color:HR.text}}>
      {/* DS + Period selectors */}
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

      <SummaryCards skuList={baseSkus} skuMaster={skuMaster} thickCfg={committedThickCfg || thickCfg} thinCfg={committedThinCfg || thinCfg}/>

      {/* Thick section */}
      <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thick (&gt;6mm) — Vertical Storage</div>
        <ConfigPanel type="thick" cfg={thickCfg} onChange={setThickCfg} isAdmin={isAdmin} onRun={runThick} dirty={thickDirty}/>
        {thickResults ? (
          <>
            <CapacityBar used={thickResults.capUsed} total={thickCfg.capacity} label="Thick"/>
            <div style={S.card}>
              <SKUTable skus={thickResults.skus} cfg={committedThickCfg || thickCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }}/>
            </div>
          </>
        ) : (
          <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click ▶ Run</div>
        )}
      </div>

      {/* Thin section */}
      <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thin (≤6mm) — Bin Storage</div>
        <ConfigPanel type="thin" cfg={thinCfg} onChange={setThinCfg} isAdmin={isAdmin} onRun={runThin} dirty={thinDirty}/>
        {thinResults ? (
          <>
            <CapacityBar used={thinResults.capUsed} total={thinCfg.capacity} label="Thin"/>
            <div style={S.card}>
              <SKUTable skus={thinResults.skus} cfg={committedThinCfg || thinCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }}/>
            </div>
          </>
        ) : (
          <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click ▶ Run</div>
        )}
      </div>

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
