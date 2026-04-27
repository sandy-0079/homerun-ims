import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import { saveToSupabase } from "../supabase";
import { computeNetworkNodeStats } from "../engine/strategies/plywoodNetwork.js";
import { PLYWOOD_NETWORK_CONFIG_DEFAULT } from "../engine/constants.js";

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

const GLOBAL_DEFAULTS = { thickBoundaryMm: 6 };

function thicknessCategory(mm, laminateThreshold = 1, thickBoundaryMm = 6) {
  if (mm === null) return "Unknown";
  if (mm <= laminateThreshold) return "Laminate";
  if (mm <= thickBoundaryMm) return "Thin";
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

function computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm = 6) {
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
    const thicknessCat = isLam ? "Laminate" : thicknessCategory(mm, 1, thickBoundaryMm);
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

function ConfigPanel({ type, cfg, onChange, isAdmin, onRun, dirty, boundary }) {
  const label = type === "thick" ? "Configs — Thick SKUs" : "Configs — Thin SKUs";
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
                onKeyDown={e => e.key === 'Enter' && dirty && onRun()}
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

function CapacityBar({ used, total, label, cfg }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const atLimit = used > total && used <= total * 1.1;
  const overCapacity = used > total * 1.1;
  const barColor = overCapacity ? "#DC2626" : atLimit ? "#F59E0B" : "#16a34a";
  const barWidth = Math.min(100, pct);
  const overText = overCapacity ? "Over Capacity" : atLimit ? "At Limit" : "Within Capacity";
  const formula = cfg
    ? `Max = Daily Median × ${cfg.coverDays}d × ${(1 + cfg.bufferPct / 100).toFixed(2)} · Min = × ${cfg.minCoverDays}d`
    : "";
  return (
    <div style={{...S.card,marginBottom:8,padding:"8px 12px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
        <span style={{fontSize:11,fontWeight:700,color:"#555"}}>
          {label}
          {formula && <span style={{fontSize:10,color:HR.muted,fontWeight:400,marginLeft:10}}>{formula}</span>}
        </span>
        <span style={{whiteSpace:"nowrap",marginLeft:16,display:"flex",alignItems:"baseline",gap:8}}>
          <span style={{fontSize:12,fontWeight:600,color:"#555"}}>{used} / {total}</span>
          <span style={{fontSize:15,fontWeight:800,color:barColor}}>{pct.toFixed(0)}%</span>
          <span style={{fontSize:10,color:barColor,fontWeight:600}}>{overText}</span>
        </span>
      </div>
      <div style={{height:6,background:"#E5E5D0",borderRadius:3,overflow:"hidden",marginTop:4}}>
        <div style={{height:"100%",width:`${barWidth}%`,background:barColor,borderRadius:3,transition:"width 0.3s"}}/>
      </div>
    </div>
  );
}

function SKUTable({ skus, cfg, onSelectSku, fallbackLabel }) {
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [superSlowOpen, setSuperSlowOpen] = useState(false);

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

  const runningSkus   = withTiers.filter(s => s.tier === "Running");
  const fallbackSkus  = withTiers.filter(s => s.tier === "Fallback");
  const superSlowSkus = withTiers.filter(s => s.tier === "Super Slow");

  const TIER_STYLE = {
    "Running":    { bg:"#D1FAE5", color:"#065F46" },
    "Fallback":   { bg:"#FEF3C7", color:"#92400E" },
    "Super Slow": { bg:"#F1F5F9", color:"#64748B" },
  };
  const thL = {padding:"6px 8px",textAlign:"left",color:HR.muted,background:HR.surfaceLight,fontWeight:600,fontSize:10,whiteSpace:"nowrap",borderBottom:`1px solid ${HR.border}`};
  const thC = {...thL, textAlign:"center"};
  const tdC = {padding:"4px 8px",textAlign:"center"};

  const renderRows = (tierSkus, offset = 0) => tierSkus.map((s, idx) => {
    const ts = TIER_STYLE[s.tier];
    return (
      <tr key={s.sku} onClick={() => onSelectSku(s)} style={{cursor:"pointer",borderTop:`1px solid ${HR.border}`}}
        onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
        onMouseLeave={e => e.currentTarget.style.background = ""}>
        <td style={{padding:"4px 8px",color:HR.muted}}>{offset + idx + 1}</td>
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
  });

  const TierHeader = ({ label, count, color, collapsible, open, onToggle }) => (
    <tr style={{background:HR.surfaceLight, borderTop:`2px solid ${HR.border}`, cursor: collapsible ? "pointer" : "default"}}
      onClick={collapsible ? onToggle : undefined}>
      <td colSpan={12} style={{padding:"6px 8px"}}>
        <span style={{fontSize:11,fontWeight:700,color}}>
          {collapsible ? (open ? "▼ " : "▶ ") : "▼ "}{label} — {count} SKU{count !== 1 ? "s" : ""}
        </span>
      </td>
    </tr>
  );

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
        <TierHeader label="Running" count={runningSkus.length} color="#065F46" collapsible={false}/>
        {renderRows(runningSkus, 0)}
        <TierHeader label="Fallback" count={fallbackSkus.length} color="#92400E" collapsible={true} open={fallbackOpen} onToggle={() => setFallbackOpen(o => !o)}/>
        {fallbackOpen && renderRows(fallbackSkus, runningSkus.length)}
        <TierHeader label="Super Slow" count={superSlowSkus.length} color="#64748B" collapsible={true} open={superSlowOpen} onToggle={() => setSuperSlowOpen(o => !o)}/>
        {superSlowOpen && renderRows(superSlowSkus, runningSkus.length + fallbackSkus.length)}
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

function SummaryCards({ skuList, skuMaster, thickCfg, thinCfg, thickBoundaryMm = 6 }) {
  const plywoodActive = Object.values(skuMaster).filter(s =>
    PLYWOOD_CATEGORIES.includes(s.category) && (s.status || "Active").toLowerCase() === "active"
  );
  const masterThickCount = plywoodActive.filter(s => {
    if (s.sku.toUpperCase().includes("LAM")) return false;
    return thicknessCategory(inferThickness(s.name), 1, thickBoundaryMm) === "Thick";
  }).length;
  const masterThinCount = plywoodActive.filter(s => {
    if (s.sku.toUpperCase().includes("LAM")) return false;
    const cat = thicknessCategory(inferThickness(s.name), 1, thickBoundaryMm);
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

function NetworkDesignSKUModal({ sku, onClose, invoiceDateRange }) {
  if (!sku) return null;
  const t = sku.trace || {};
  const capped = v => v !== sku.trace?.rawNonZero?.find((_, i) => sku.trace?.winsorized?.[i] !== v);

  // Timeline over full date range using aggregated dailyMap
  const timelineData = (invoiceDateRange?.dates || []).map(date => ({
    date: date.slice(5),
    qty: sku.dailyMap[date] || 0,
  }));
  const barSize = Math.max(4, Math.min(24, Math.floor(400 / Math.max(timelineData.length, 1))));

  const row = (label, value, note) => (
    <div style={{display:"flex",gap:8,alignItems:"baseline",padding:"4px 0",borderBottom:"1px solid #F0F0E8"}}>
      <span style={{width:200,fontSize:11,color:"#555",flexShrink:0}}>{label}</span>
      <span style={{fontSize:12,fontWeight:700,color:"#1A1A1A"}}>{value}</span>
      {note && <span style={{fontSize:10,color:"#888",marginLeft:4}}>{note}</span>}
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:12,padding:24,width:"min(860px,96vw)",maxHeight:"90vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div>
            <div style={{fontSize:16,fontWeight:800}}>{sku.name}</div>
            <div style={{fontSize:11,color:"#888",marginTop:2}}>
              {sku.sku} · {sku.mm != null ? `${sku.mm}mm` : "—"}
              {t.isDC ? " · DC stocking" : ` · Aggregated: ${(t.covers||[]).join(", ")}`}
            </div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"1px solid #E0E0D0",borderRadius:6,padding:"4px 14px",cursor:"pointer",fontSize:12,color:"#888",fontWeight:600}}>Close ✕</button>
        </div>

        {/* Result */}
        <div style={{display:"flex",gap:12,marginBottom:16}}>
          {(t.isDC
            ? [{label:"DC Min",val:sku.minQty,color:"#B91C1C"},{label:"DC Max",val:sku.maxQty,color:"#16a34a"}]
            : [{label:"Min",val:sku.minQty,color:"#B91C1C"},{label:"Max",val:sku.maxQty,color:"#16a34a"},{label:"NZD",val:t.nzd||0,color:"#0077A8"},{label:"Orders",val:t.orderQtyCount||0,color:"#555"}]
          ).map(c => (
            <div key={c.label} style={{background:"#F8F8F2",borderRadius:8,padding:"8px 16px",textAlign:"center",minWidth:64}}>
              <div style={{fontSize:20,fontWeight:800,color:c.color}}>{c.val}</div>
              <div style={{fontSize:10,color:"#888",fontWeight:600}}>{c.label}</div>
            </div>
          ))}
        </div>

        {/* Computation trace */}
        <div style={{fontSize:12,fontWeight:700,color:"#7C3AED",marginBottom:8,textTransform:"uppercase",letterSpacing:1}}>How DC Min &amp; Max were computed</div>
        <div style={{background:"#FAFAF8",borderRadius:8,padding:"10px 14px",marginBottom:t.isDC?0:16}}>
          {t.isDC ? (
            <>
              {t.dcP95 > 0
                ? row(`P95 direct-serving demand`, `${t.dcP95} sheets`, `aggregated from ${(t.dcCovers||[]).join(", ")}`)
                : row(`Direct-serving component`, `0`, `brand not directly served by DC`)
              }
              {row(`Σ DS_Min across stocking nodes`, `${t.sumMin} sheets`, `scales with demand — fast movers contribute more`)}
              {row(`DC Min = ${t.dcP95} + ceil(${t.sumMin} × ${t.dcMultMin})`, `= ${t.dcP95} + ${Math.ceil(t.sumMin * t.dcMultMin)} = ${sku.minQty}`, ``)}
              {row(`DC Max = ${t.dcP95} + ceil(${t.sumMin} × ${t.dcMultMax})`, `= ${t.dcP95} + ${Math.ceil(t.sumMin * t.dcMultMax)} = ${sku.maxQty}`, `(≥ DC Min)`)}
              <div style={{marginTop:10,padding:"6px 10px",background:"#F0FFF4",borderRadius:6,fontSize:11,color:"#166534",fontWeight:600}}>
                → DC Min = {sku.minQty} · DC Max = {sku.maxQty}
              </div>
            </>
          ) : t.belowMinNZD ? (
            <div style={{color:"#92400E",fontSize:12,fontWeight:600}}>
              ⚠ NZD ({t.nzd}) &lt; minNZD ({t.minNZDThreshold}) → Min = Max = 0 (insufficient demand history, sourced on demand)
            </div>
          ) : (
            <>
              {row(`Non-zero days (NZD)`, `${t.nzd} days`, `across ${(t.covers||[]).join(", ")}`)}
              {row(`Daily totals (non-zero)`, (t.rawNonZero||[]).join(", ") || "—", "sorted ascending")}
              {t.spikeCap != null && (t.rawNonZero||[]).some((v,i) => (t.winsorized||[])[i] < v) && (
                row(`Winsorized at ${t.dtMedian?.toFixed(1)} × ${(t.spikeCap/(t.dtMedian||1)).toFixed(1)} = ${t.spikeCap?.toFixed(1)}`, (t.winsorized||[]).join(", "), "outlier days capped")
              )}
              {t.spikeCap != null && !(t.rawNonZero||[]).some((v,i) => (t.winsorized||[])[i] < v) && (
                row(`Winsorize cap (${t.dtMedian?.toFixed(1)} × ${(t.spikeCap/(t.dtMedian||1)).toFixed(0)} = ${t.spikeCap?.toFixed(1)})`, "no days capped", "all within threshold")
              )}
              {row(`P${t.pMin} of winsorized series`, `${t.p95Raw?.toFixed(2)} → ceil = ${Math.ceil(t.p95Raw||0)}`, `→ raw Min before cap guard`)}
              {row(`P${t.pBuf} of order quantities`, `${t.orderBuf} sheets`, `buffer above Min`)}
              {row(`Raw Max (Min + buffer)`, `${t.rawMax}`, t.capApplied ? `> cap ${t.cap} → capped` : `≤ cap ${t.cap} ✓`)}
              {t.capApplied && row(`Cap applied`, `Max = ${t.cap}`, `Min stays at P95 = ${sku.minQty} (gap = ${t.cap} − ${sku.minQty} = ${t.cap - sku.minQty})`)}
              <div style={{marginTop:10,padding:"6px 10px",background:"#F0FFF4",borderRadius:6,fontSize:11,color:"#166534",fontWeight:600}}>
                → Min = {sku.minQty} · Max = {sku.maxQty}
              </div>
            </>
          )}
        </div>

        {/* Charts — DS nodes only, not DC */}
        {!t.isDC && <><div style={{fontSize:11,fontWeight:700,color:"#555",marginBottom:8,marginTop:16}}>Daily Consumption — Aggregated ({(t.covers||[]).join(" + ")})</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={timelineData} margin={{left:8,right:64,top:4,bottom:20}}>
            <CartesianGrid strokeDasharray="3 3" vertical={false}/>
            <XAxis dataKey="date" tick={{fontSize:9}} interval={Math.floor(timelineData.length/6)}
              label={{value:"Date",position:"insideBottom",offset:-10,fontSize:10}}/>
            <YAxis tick={{fontSize:10}} label={{value:"Qty",angle:-90,position:"insideLeft",offset:10,fontSize:10}}/>
            <RTooltip/>
            {sku.minQty > 0 && <ReferenceLine y={sku.minQty} stroke="#B91C1C" strokeDasharray="5 4"
              label={{value:`Min=${sku.minQty}`,position:"right",fontSize:9,fill:"#B91C1C"}}/>}
            {sku.maxQty > 0 && <ReferenceLine y={sku.maxQty} stroke="#16a34a" strokeDasharray="5 4"
              label={{value:`Max=${sku.maxQty}`,position:"right",fontSize:9,fill:"#16a34a"}}/>}
            <Bar dataKey="qty" barSize={barSize} fill="#0077A8" radius={[2,2,0,0]}/>
          </BarChart>
        </ResponsiveContainer>

        {/* Order qty histogram */}
        {(sku.orderQtys||[]).length > 0 && (() => {
          const buckets = {};
          sku.orderQtys.forEach(q => { const b = Math.ceil(q); buckets[b] = (buckets[b]||0) + 1; });
          const histData = Object.entries(buckets).sort((a,b)=>+a[0]-+b[0]).map(([qty,count])=>({qty:+qty,count}));
          const hs = Math.max(4, Math.min(24, Math.floor(400/Math.max(histData.length,1))));
          return (
            <>
              <div style={{fontSize:11,fontWeight:700,color:"#555",margin:"16px 0 8px"}}>Order Qty Distribution ({t.orderQtyCount} orders)</div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={histData} margin={{left:8,right:8,top:4,bottom:20}}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                  <XAxis dataKey="qty" tick={{fontSize:9}} label={{value:"Order Qty",position:"insideBottom",offset:-10,fontSize:10}}/>
                  <YAxis tick={{fontSize:10}}/>
                  <RTooltip formatter={v=>[v,"Orders"]} labelFormatter={l=>`Qty: ${l}`}/>
                  <Bar dataKey="count" barSize={hs} fill="#7C3AED" radius={[2,2,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            </>
          );
        })()}</>}
      </div>
    </div>
  );
}

function NetworkDesignSummaryCards({ thickSkus, thinSkus, maxCap, lookbackDays, skuMaster, stockedBrands, thickBoundaryMm }) {
  // Total active SKUs from stocked brands (to derive zero-demand count)
  const allStocked = Object.values(skuMaster).filter(m =>
    PLYWOOD_CATEGORIES.includes(m.category) &&
    stockedBrands.some(b => b.toLowerCase() === m.brand?.toLowerCase()) &&
    (m.status || "Active").toLowerCase() === "active"
  );
  const allThick = allStocked.filter(s => {
    const mm = inferThickness(s.name);
    if (mm !== null && mm <= 1) return false;
    return thicknessCategory(mm, 1, thickBoundaryMm) === "Thick";
  }).length;
  const allThin = allStocked.filter(s => {
    const mm = inferThickness(s.name);
    if (mm !== null && mm <= 1) return false;
    const cat = thicknessCategory(mm, 1, thickBoundaryMm);
    return cat === "Thin" || cat === "Unknown";
  }).length;

  const f = (list, fn) => list.filter(fn);
  const hasDemand   = s => s.nzd > 0;
  const isStocked   = s => s.minQty > 0;
  const isCapped    = s => s.maxQty >= maxCap;

  const demandTk = f(thickSkus, hasDemand).length, demandTn = f(thinSkus, hasDemand).length;
  const stockTk  = f(thickSkus, isStocked).length,  stockTn  = f(thinSkus, isStocked).length;
  const capTk    = f(thickSkus, isCapped).length,   capTn    = f(thinSkus, isCapped).length;
  const zeroTk   = Math.max(0, allThick - thickSkus.length);
  const zeroTn   = Math.max(0, allThin  - thinSkus.length);

  const sub = (tk, tn) => `Thick: ${tk} · Thin: ${tn}`;
  const cards = [
    { num: demandTk + demandTn, lbl: `SKUs with demand`,          sub: sub(demandTk, demandTn) + ` · ${lookbackDays}d lookback`, color: "#0077A8" },
    { num: stockTk  + stockTn,  lbl: "Stocked at this node",      sub: sub(stockTk, stockTn),                                    color: "#16a34a" },
    { num: capTk    + capTn,    lbl: `At cap (Max = ${maxCap})`,   sub: sub(capTk, capTn) + " · demand exceeds capacity",         color: "#D97706" },
    { num: zeroTk   + zeroTn,   lbl: "No demand in lookback",      sub: sub(zeroTk, zeroTn) + " · consider reviewing",           color: "#6B7280" },
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

// SKU table for Network Design mode — shows aggregated demand + P95-based min/max
function NetworkDesignSKUTable({ skus, onSelectSku, showNZD = true, isDC = false }) {
  if (!skus || skus.length === 0) return (
    <div style={{padding:16,color:"#888",fontSize:12,textAlign:"center"}}>No SKUs with demand in this period.</div>
  );
  const S2 = { th:{padding:"6px 8px",fontWeight:700,fontSize:10,color:"#555",borderBottom:"1px solid #E0E0D0",textAlign:"left",whiteSpace:"nowrap"}, td:{padding:"6px 8px",fontSize:11,borderBottom:"1px solid #F0F0E8",verticalAlign:"middle"} };
  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead>
          <tr style={{background:"#F8F8F2"}}>
            <th style={S2.th}>SKU</th>
            <th style={S2.th}>Name</th>
            <th style={{...S2.th,textAlign:"right"}}>mm</th>
            {showNZD && <th style={{...S2.th,textAlign:"right"}}>NZD</th>}
            <th style={{...S2.th,textAlign:"right"}}>{isDC ? "DC Min" : "Min"}</th>
            <th style={{...S2.th,textAlign:"right"}}>{isDC ? "DC Max" : "Max"}</th>
          </tr>
        </thead>
        <tbody>
          {skus.sort((a,b) => b.minQty - a.minQty).map((s,i) => (
            <tr key={s.sku} style={{background:i%2===0?"#fff":"#F8F8F2",cursor:"pointer"}} onClick={() => onSelectSku(s)}>
              <td style={{...S2.td,fontFamily:"monospace",fontSize:10,color:"#666"}}>{s.sku}</td>
              <td style={{...S2.td,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</td>
              <td style={{...S2.td,textAlign:"right",color:"#888"}}>{s.mm !== null ? `${s.mm}mm` : "—"}</td>
              {showNZD && <td style={{...S2.td,textAlign:"right"}}>{s.nzd}</td>}
              <td style={{...S2.td,textAlign:"right",fontWeight:700,color:"#1e40af"}}>{s.minQty}</td>
              <td style={{...S2.td,textAlign:"right",fontWeight:700,color:"#166534"}}>{s.maxQty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Shared formula: apply P95/winsorize/cap logic to a list of SKU stats.
// Used by both DS node view and DC computation.
function applyNetworkFormula(statsList, cfg, boundary) {
  const pMin  = cfg.minPercentile      || 95;
  const pBuf  = cfg.maxBufferPercentile || 75;
  const cap   = cfg.maxCap             || 20;
  const spike = cfg.spikeCapMultiplier  || 3;
  const nzdTh = cfg.minNZD             || 2;
  return statsList.map(s => {
    const mm = inferThickness(s.name);
    if (mm !== null && mm <= 1) return null; // laminate
    const thicknessCat = thicknessCategory(mm, 1, boundary);
    const dt = s.dailyTotals;
    const mid = Math.floor(dt.length / 2);
    const dtMedian = dt.length === 0 ? 0 : dt.length % 2 === 0 ? (dt[mid-1]+dt[mid])/2 : dt[mid];
    const belowMinNZD = dt.length < nzdTh;
    const spikeCap = dtMedian * spike;
    const winsorized = dt.map(v => Math.min(v, spikeCap));
    const minQty  = belowMinNZD || !winsorized.length ? 0 : Math.ceil(percentile(winsorized, pMin));
    // No buffer when below NZD threshold — both Min and Max must be 0
    const orderBuf = belowMinNZD ? 0 : (s.orderQtys.length ? Math.ceil(percentile(s.orderQtys, pBuf)) : 0);
    const maxQty  = Math.min(minQty + orderBuf, cap);
    const minFinal = Math.min(minQty, Math.max(0, maxQty - 1));
    const trace = {
      covers: s.covers || [], nzd: dt.length, belowMinNZD, minNZDThreshold: nzdTh,
      rawNonZero: dt, dtMedian, spikeCap: dtMedian > 0 ? spikeCap : null, winsorized,
      p95Raw: winsorized.length ? percentile(winsorized, pMin) : 0, pMin,
      orderBuf, pBuf, orderQtyCount: s.orderQtys.length,
      rawMax: minQty + orderBuf, capApplied: (minQty + orderBuf) > cap, cap,
    };
    return { ...s, mm, thicknessCat, minQty: minFinal, maxQty, dailyMedian: dtMedian, trace };
  }).filter(Boolean).filter(s => s.thicknessCat !== 'Laminate');
}

export default function PlywoodNetworkTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin, networkConfigs, onSaveConfigs, plywoodNetworkConfig, onSavePlywoodNetworkConfig, isNetworkDesignActive }) {
  const [dsFilter, setDsFilter] = useState("DS01");
  const [period, setPeriod] = useState(45);
  const [thickCfg, setThickCfg] = useState(null);
  const [thinCfg, setThinCfg] = useState(null);
  const [committedThickCfg, setCommittedThickCfg] = useState(null); // config at last Run — drives SummaryCards
  const [committedThinCfg, setCommittedThinCfg] = useState(null);
  const [thickResults, setThickResults] = useState(null);
  const [thinResults, setThinResults] = useState(null);
  const [resultsCache, setResultsCache] = useState({}); // keyed by "DS-period" e.g. "DS01-45"
  const [selectedSku, setSelectedSku] = useState(null);
  const [selectedSkuType, setSelectedSkuType] = useState(null);
  const [thickBoundaryMm, setThickBoundaryMm] = useState(GLOBAL_DEFAULTS.thickBoundaryMm);
  const [committedBoundaryMm, setCommittedBoundaryMm] = useState(null); // locked at last Run; null = use live value
  const autoRanRef = useRef(new Set()); // tracks which "DS-period" combos have been auto-computed

  // Network Design config — use saved config or fall back to defaults
  const effectiveNetCfg = plywoodNetworkConfig || PLYWOOD_NETWORK_CONFIG_DEFAULT;
  const [localNetCfg, setLocalNetCfg] = useState(null); // null = not editing
  const editingNetCfg = localNetCfg || effectiveNetCfg;
  const [netCfgDirty, setNetCfgDirty] = useState(false);

  // Reload configs when DS or saved configs change — skip for DC (no DS_DEFAULTS entry)
  useEffect(() => {
    if (!DS_LIST.includes(dsFilter)) return;
    const saved = networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter];
    setThickCfg({ ...DS_DEFAULTS[dsFilter].thick, ...saved.thick });
    setThinCfg({ ...DS_DEFAULTS[dsFilter].thin, ...saved.thin });
  }, [dsFilter, networkConfigs]);

  // Load global boundary from networkConfigs
  useEffect(() => {
    setThickBoundaryMm(networkConfigs?.global?.thickBoundaryMm ?? GLOBAL_DEFAULTS.thickBoundaryMm);
  }, [networkConfigs]);

  // On DS or period change: restore cached results for that combo, else clear
  useEffect(() => {
    const cached = resultsCache[`${dsFilter}-${period}`];
    setThickResults(cached?.thick || null);
    setThinResults(cached?.thin || null);
    setCommittedThickCfg(cached?.thickCfg || null);
    setCommittedThinCfg(cached?.thinCfg || null);
  }, [dsFilter, period]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveBoundary = useCallback((val) => {
    if (!isAdmin) return;
    setThickBoundaryMm(val);
    onSaveConfigs({ ...(networkConfigs || {}), global: { ...(networkConfigs?.global || {}), thickBoundaryMm: val } });
  }, [networkConfigs, onSaveConfigs, isAdmin]);

  const handleSaveConfig = useCallback((type, newCfg) => {
    if (!isAdmin || !DS_LIST.includes(dsFilter)) return;
    const merged = {
      ...(networkConfigs || {}),
      [dsFilter]: {
        ...(networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter]),
        [type]: newCfg,
      }
    };
    onSaveConfigs(merged);
  }, [dsFilter, networkConfigs, onSaveConfigs, isAdmin]);

  const appliedBoundary = committedBoundaryMm !== null ? committedBoundaryMm : thickBoundaryMm;
  const baseSkus = useMemo(() =>
    computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange, appliedBoundary),
    [invoiceData, skuMaster, dsFilter, period, invoiceDateRange, appliedBoundary] // eslint-disable-line
  );
  const thickSkus = useMemo(() => baseSkus.filter(s => s.thicknessCat === "Thick"), [baseSkus]);
  const thinSkus  = useMemo(() => baseSkus.filter(s => s.thicknessCat !== "Thick"), [baseSkus]);

  // Network Design: derive stocking info for selected DS
  const ndDsInfo = useMemo(() => {
    if (!isNetworkDesignActive || !effectiveNetCfg?.brands) return null;
    const brands = effectiveNetCfg.brands;
    const stocked = []; // [{brand, covers, dcServes}]
    const notStocked = []; // [{brand, fulfilledFrom}]
    Object.entries(brands).forEach(([brand, cfg]) => {
      const dsNode = cfg.nodes[dsFilter];
      if (dsNode) {
        stocked.push({ brand, covers: dsNode.covers });
      } else {
        // Find fulfillment sources for this DS from other nodes
        const sources = [];
        Object.entries(cfg.nodes).forEach(([nodeId, nodeCfg]) => {
          if (nodeId !== 'DC' && nodeCfg.covers.includes(dsFilter)) sources.push(nodeId);
        });
        if (cfg.nodes.DC?.covers.includes(dsFilter)) sources.push('DC');
        notStocked.push({ brand, fulfilledFrom: sources.join(' or ') || 'Supplier' });
      }
    });
    // Aggregate covered DSes across all stocked brands (for display)
    const coveredDSes = [...new Set(stocked.flatMap(s => s.covers))];
    return { stocked, notStocked, coveredDSes };
  }, [isNetworkDesignActive, effectiveNetCfg, dsFilter]);

  // Network Design: aggregated SKU stats for the selected DS stocking node
  const ndSkuStats = useMemo(() => {
    if (!ndDsInfo || !ndDsInfo.stocked.length) return { thick: [], thin: [] };
    const allStats = [];
    ndDsInfo.stocked.forEach(({ brand, covers }) => {
      const stats = computeNetworkNodeStats(invoiceData, skuMaster, brand, covers, effectiveNetCfg.lookbackDays || 90);
      allStats.push(...stats.map(s => ({ ...s, covers })));
    });
    const withMM = applyNetworkFormula(allStats, effectiveNetCfg, appliedBoundary);
    return { thick: withMM.filter(s => s.thicknessCat === 'Thick'), thin: withMM.filter(s => s.thicknessCat !== 'Thick') };
  }, [ndDsInfo, invoiceData, skuMaster, effectiveNetCfg, appliedBoundary]);

  // All DS stocking node results — needed by DC replenishment formula
  const allNodeStats = useMemo(() => {
    if (!isNetworkDesignActive || !effectiveNetCfg?.brands) return {};
    const result = {};
    Object.entries(effectiveNetCfg.brands).forEach(([brand, brandCfg]) => {
      result[brand] = {};
      Object.entries(brandCfg.nodes).forEach(([nodeId, nodeCfg]) => {
        if (nodeId === 'DC') return;
        const stats = computeNetworkNodeStats(invoiceData, skuMaster, brand, nodeCfg.covers, effectiveNetCfg.lookbackDays || 90);
        result[brand][nodeId] = applyNetworkFormula(stats.map(s => ({ ...s, covers: nodeCfg.covers })), effectiveNetCfg, appliedBoundary);
      });
    });
    return result;
  }, [isNetworkDesignActive, effectiveNetCfg, invoiceData, skuMaster, appliedBoundary]);

  // DC tab: per-SKU DC Min/Max = P95 direct-serving + Σ(Max−Min) × mult across DS stocking nodes
  const dcSkuStats = useMemo(() => {
    if (!isNetworkDesignActive || !effectiveNetCfg?.brands) return { thick: [], thin: [] };
    const allSkus = [];
    Object.entries(effectiveNetCfg.brands).forEach(([brand, brandCfg]) => {
      const { nodes, dcMultMin = 0.8, dcMultMax = 1.5 } = brandCfg;
      const brandMaster = Object.values(skuMaster).filter(m =>
        m.brand?.toLowerCase() === brand.toLowerCase() && m.category === PLYWOOD_CATEGORIES[0] && (m.status || 'Active').toLowerCase() === 'active'
      );
      brandMaster.forEach(meta => {
        // Direct-serving component
        let dcP95 = 0, dcCovers = [];
        if (nodes.DC) {
          dcCovers = nodes.DC.covers;
          const dcRaw = computeNetworkNodeStats(invoiceData, skuMaster, brand, dcCovers, effectiveNetCfg.lookbackDays || 90);
          const skuStat = dcRaw.find(s => s.sku === meta.sku);
          if (skuStat) {
            const computed = applyNetworkFormula([{ ...skuStat, covers: dcCovers }], effectiveNetCfg, appliedBoundary);
            if (computed.length) dcP95 = computed[0].minQty;
          }
        }
        // Replenishment component: Σ DS_Min × mult (scales with demand velocity)
        let sumMin = 0;
        Object.keys(nodes).filter(n => n !== 'DC').forEach(nodeId => {
          const match = (allNodeStats[brand]?.[nodeId] || []).find(s => s.sku === meta.sku);
          if (match) sumMin += match.minQty;
        });
        const dcMin = dcP95 + Math.ceil(sumMin * dcMultMin);
        const dcMax = Math.max(dcP95 + Math.ceil(sumMin * dcMultMax), dcMin);
        if (dcMin === 0 && dcMax === 0) return;
        const mm = inferThickness(meta.name);
        if (mm !== null && mm <= 1) return;
        const thicknessCat = thicknessCategory(mm, 1, appliedBoundary);
        if (thicknessCat === 'Laminate') return;
        allSkus.push({
          sku: meta.sku, name: meta.name, brand, mm, thicknessCat,
          minQty: dcMin, maxQty: dcMax, nzd: 0, dailyMedian: 0, orderQtys: [], dailyMap: {},
          trace: { dcP95, dcCovers, sumMin, dcMultMin, dcMultMax, isDC: true },
        });
      });
    });
    return { thick: allSkus.filter(s => s.thicknessCat === 'Thick'), thin: allSkus.filter(s => s.thicknessCat !== 'Thick') };
  }, [isNetworkDesignActive, effectiveNetCfg, invoiceData, skuMaster, allNodeStats, appliedBoundary]);

  // Auto-compute on first load for each DS (runs once per DS per session, covers page refresh)
  // Must be declared AFTER baseSkus/thickSkus/thinSkus to avoid TDZ error
  useEffect(() => {
    if (networkConfigs === null) return;
    if (!DS_LIST.includes(dsFilter)) return; // DC has no auto-compute
    if (!thickCfg || !thinCfg || !baseSkus.length) return;
    const expectedSaved = networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter];
    const expectedThick = { ...DS_DEFAULTS[dsFilter].thick, ...expectedSaved.thick };
    if (JSON.stringify(thickCfg) !== JSON.stringify(expectedThick)) return;
    const cacheKey = `${dsFilter}-${period}`;
    if (autoRanRef.current.has(cacheKey)) return;
    autoRanRef.current.add(cacheKey);

    const withThick = thickSkus.map(s => ({ ...s, ...computeMinMax(s, thickCfg) }));
    const thickCap  = withThick.filter(s => s.nzd >= thickCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const thickR    = { skus: withThick, capUsed: thickCap };

    const withThin = thinSkus.map(s => ({ ...s, ...computeMinMax(s, thinCfg) }));
    const thinCap  = withThin.filter(s => s.nzd >= thinCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const thinR    = { skus: withThin, capUsed: thinCap };

    setThickResults(thickR);
    setThinResults(thinR);
    setCommittedThickCfg(thickCfg);
    setCommittedThinCfg(thinCfg);
    setCommittedBoundaryMm(thickBoundaryMm);
    setResultsCache(prev => ({ ...prev, [cacheKey]: { thick: thickR, thin: thinR, thickCfg, thinCfg } }));
  }, [thickCfg, thinCfg, baseSkus, dsFilter, thickSkus, thinSkus, networkConfigs]); // eslint-disable-line react-hooks/exhaustive-deps

  const runBothSections = useCallback((freshBase) => {
    // Shared helper — recomputes both sections from an already-classified freshBase
    const k = `${dsFilter}-${period}`;
    const freshThick = freshBase.filter(s => s.thicknessCat === "Thick");
    const thickWithMM = freshThick.map(s => ({ ...s, ...computeMinMax(s, thickCfg) }));
    const thickCap = thickWithMM.filter(s => s.nzd >= thickCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const thickR = { skus: thickWithMM, capUsed: thickCap };

    const freshThin = freshBase.filter(s => s.thicknessCat !== "Thick");
    const thinWithMM = freshThin.map(s => ({ ...s, ...computeMinMax(s, thinCfg) }));
    const thinCap = thinWithMM.filter(s => s.nzd >= thinCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const thinR = { skus: thinWithMM, capUsed: thinCap };

    setThickResults(thickR); setThinResults(thinR);
    setCommittedThickCfg(thickCfg); setCommittedThinCfg(thinCfg);
    setCommittedBoundaryMm(thickBoundaryMm);
    setResultsCache(prev => ({ ...prev, [k]: { thick: thickR, thin: thinR, thickCfg, thinCfg } }));
    if (isAdmin) { handleSaveConfig("thick", thickCfg); handleSaveConfig("thin", thinCfg); }
  }, [dsFilter, period, thickCfg, thinCfg, thickBoundaryMm, isAdmin, handleSaveConfig]);

  const runThick = useCallback(() => {
    const freshBase = computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm);
    if (thickBoundaryMm !== committedBoundaryMm) {
      // Boundary changed — both sections reclassify together
      runBothSections(freshBase);
      return;
    }
    const freshThick = freshBase.filter(s => s.thicknessCat === "Thick");
    const withMM = freshThick.map(s => ({ ...s, ...computeMinMax(s, thickCfg) }));
    const capUsed = withMM.filter(s => s.nzd >= thickCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const r = { skus: withMM, capUsed };
    setThickResults(r); setCommittedThickCfg(thickCfg); setCommittedBoundaryMm(thickBoundaryMm);
    setResultsCache(prev => { const k=`${dsFilter}-${period}`; return { ...prev, [k]: { ...prev[k], thick: r, thickCfg } }; });
    if (isAdmin) handleSaveConfig("thick", thickCfg);
  }, [invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm, committedBoundaryMm, thickCfg, isAdmin, handleSaveConfig, runBothSections]);

  const runThin = useCallback(() => {
    const freshBase = computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm);
    if (thickBoundaryMm !== committedBoundaryMm) {
      // Boundary changed — both sections reclassify together
      runBothSections(freshBase);
      return;
    }
    const freshThin = freshBase.filter(s => s.thicknessCat !== "Thick");
    const withMM = freshThin.map(s => ({ ...s, ...computeMinMax(s, thinCfg) }));
    const capUsed = withMM.filter(s => s.nzd >= thinCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    const r = { skus: withMM, capUsed };
    setThinResults(r); setCommittedThinCfg(thinCfg); setCommittedBoundaryMm(thickBoundaryMm);
    setResultsCache(prev => { const k=`${dsFilter}-${period}`; return { ...prev, [k]: { ...prev[k], thin: r, thinCfg } }; });
    if (isAdmin) handleSaveConfig("thin", thinCfg);
  }, [invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm, committedBoundaryMm, thinCfg, isAdmin, handleSaveConfig, runBothSections]);

  if (!invoiceData.length || !Object.keys(skuMaster).length) return (
    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
      Upload invoice CSV and SKU Master in the Upload Data tab to begin.
    </div>
  );
  if (!thickCfg || !thinCfg) return null;

  const boundaryDirty = committedBoundaryMm !== null && thickBoundaryMm !== committedBoundaryMm;
  const thickDirty = boundaryDirty || !committedThickCfg || JSON.stringify(thickCfg) !== JSON.stringify(committedThickCfg);
  const thinDirty  = boundaryDirty || !committedThinCfg  || JSON.stringify(thinCfg)  !== JSON.stringify(committedThinCfg);
  const dsFallbackLabel = networkConfigs?.[dsFilter]?.fallbackLabel || DS_DEFAULTS[dsFilter]?.fallbackLabel || "DC";

  const handleNetCfgChange = (key, value) => {
    setLocalNetCfg(prev => {
      const base = prev || effectiveNetCfg;
      if (key.includes('.')) {
        const [parent, child] = key.split('.');
        return { ...base, [parent]: { ...(base[parent] || {}), [child]: value } };
      }
      return { ...base, [key]: value };
    });
    setNetCfgDirty(true);
  };
  const handleNetBrandCfgChange = (brand, key, value) => {
    setLocalNetCfg(prev => {
      const base = prev || effectiveNetCfg;
      return { ...base, brands: { ...base.brands, [brand]: { ...base.brands[brand], [key]: value } } };
    });
    setNetCfgDirty(true);
  };
  const saveNetCfg = () => {
    if (!onSavePlywoodNetworkConfig || !localNetCfg) return;
    onSavePlywoodNetworkConfig(localNetCfg);
    setNetCfgDirty(false);
  };

  return (
    <div style={{fontFamily:"Inter,sans-serif",color:HR.text}}>

      {/* ── Brand Strategy Transparency ─────────────────────────────────────── */}
      {effectiveNetCfg?.brands && (
        <div style={{background:"#1a2a1a",border:"1px solid #2d4a2d",borderRadius:8,padding:"10px 16px",marginBottom:16,display:"flex",gap:32,alignItems:"flex-start",flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:11,color:"#7aab7a",fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>
              Network Design Brands {isNetworkDesignActive ? "● Active" : "○ Inactive — enable in Logic Tweaker"}
            </div>
            {Object.keys(effectiveNetCfg.brands).map(b => (
              <div key={b} style={{fontSize:12,color:isNetworkDesignActive?"#c8e6c9":"#778877",marginBottom:2}}>● {b}</div>
            ))}
          </div>
          <div>
            <div style={{fontSize:11,color:"#ffe082",fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>PCT Strategy (this tab excluded)</div>
            <div style={{fontSize:12,color:"#ffe082",marginBottom:2}}>● Merino</div>
            <div style={{fontSize:12,color:"#888"}}>● All unrecognised plywood brands</div>
          </div>
        </div>
      )}

      {/* ── Network Design Config Editor (admin only) ────────────────────────── */}
      {isAdmin && effectiveNetCfg?.brands && (
        <details style={{marginBottom:16}} open={false}>
          <summary style={{cursor:"pointer",fontSize:12,fontWeight:700,color:"#7C3AED",padding:"6px 0",userSelect:"none"}}>
            ⚙ Network Design Config {netCfgDirty ? " · unsaved changes" : ""}
          </summary>
          <div style={{...S.card,marginTop:8,padding:12}}>
            <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:12}}>
              {[
                {label:"Lookback Days",key:"lookbackDays",min:30,max:365,step:1},
                {label:"Min Percentile",key:"minPercentile",min:50,max:99,step:1},
                {label:"Max Buffer Pct",key:"maxBufferPercentile",min:50,max:99,step:1},
                {label:"Max Cap / Location",key:"maxCap",min:1,max:100,step:1},
                {label:"Spike Cap ×Median",key:"spikeCapMultiplier",min:1,max:20,step:0.5},
                {label:"Min NZD to Stock",key:"minNZD",min:1,max:20,step:1},
                {label:"DC Thick Capacity",key:"dcCapacity.thick",min:1,max:2000,step:10},
                {label:"DC Thin Capacity",key:"dcCapacity.thin",min:1,max:2000,step:10},
              ].map(({label,key,min,max,step}) => (
                <label key={key} style={{fontSize:11,display:"flex",flexDirection:"column",gap:3}}>
                  {label}
                  <input type="number" min={min} max={max} step={step ?? 1}
                    value={(key.includes('.') ? key.split('.').reduce((o,k)=>o?.[k], editingNetCfg) : editingNetCfg[key]) ?? ""}
                    onChange={e => handleNetCfgChange(key, Number(e.target.value))}
                    style={{...S.input,width:70}}/>
                </label>
              ))}
            </div>
            <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>DC Multipliers per Brand</div>
            {Object.entries(editingNetCfg.brands || {}).map(([brand, cfg]) => (
              <div key={brand} style={{display:"flex",gap:12,alignItems:"center",marginBottom:6}}>
                <span style={{width:110,fontSize:12,fontWeight:600}}>{brand}</span>
                {[{label:"DC Mult Min",key:"dcMultMin"},{label:"DC Mult Max",key:"dcMultMax"}].map(({label,key}) => (
                  <label key={key} style={{fontSize:11,display:"flex",flexDirection:"column",gap:2}}>
                    {label}
                    <input type="number" min={0.1} max={5} step={0.1}
                      value={cfg[key] ?? ""}
                      onChange={e => handleNetBrandCfgChange(brand, key, Number(e.target.value))}
                      style={{...S.input,width:60}}/>
                  </label>
                ))}
              </div>
            ))}
            {/* Brand Network Assignments */}
            <div style={{borderTop:`1px solid ${HR.border}`,marginTop:14,paddingTop:12}}>
              <div style={{fontSize:11,color:"#555",fontWeight:700,marginBottom:10}}>Brand Network Assignments</div>
              {Object.entries(editingNetCfg.brands || {}).map(([brand, cfg]) => {
                const nodes = cfg.nodes || {};

                const toggleNode = (loc) => {
                  if (!isAdmin) return;
                  const next = { ...nodes };
                  if (next[loc]) { delete next[loc]; }
                  else { next[loc] = { covers: loc === 'DC' ? [] : [loc] }; }
                  handleNetBrandCfgChange(brand, 'nodes', next);
                };

                const toggleCover = (loc, ds) => {
                  if (!isAdmin) return;
                  const cur = nodes[loc]?.covers || [];
                  const next = { ...nodes, [loc]: { ...nodes[loc], covers: cur.includes(ds) ? cur.filter(d => d !== ds) : [...cur, ds] } };
                  handleNetBrandCfgChange(brand, 'nodes', next);
                };

                return (
                  <div key={brand} style={{marginBottom:14,border:`1px solid ${HR.border}`,borderRadius:6,overflow:"hidden"}}>
                    <div style={{background:HR.surfaceLight,padding:"5px 10px",fontSize:12,fontWeight:700,color:HR.text,borderBottom:`1px solid ${HR.border}`}}>
                      {brand}
                    </div>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                      <thead>
                        <tr style={{background:"#FAFAF8"}}>
                          <th style={{padding:"4px 8px",textAlign:"left",color:HR.muted,fontWeight:600,width:52}}>Node</th>
                          <th style={{padding:"4px 8px",textAlign:"center",color:HR.muted,fontWeight:600,width:64}}>Stocks here</th>
                          <th style={{padding:"4px 8px",textAlign:"left",color:HR.muted,fontWeight:600}}>Aggregates demand from</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...DS_LIST, 'DC'].map((loc, i) => {
                          const isNode = !!nodes[loc];
                          const covers = nodes[loc]?.covers || [];
                          return (
                            <tr key={loc} style={{background:i%2===0?"#fff":"#FAFAF8",borderTop:`1px solid ${HR.border}`}}>
                              <td style={{padding:"5px 8px",fontWeight:700,color:isNode?"#166534":"#aaa"}}>{loc}</td>
                              <td style={{padding:"5px 8px",textAlign:"center"}}>
                                <input type="checkbox" checked={isNode} disabled={!isAdmin}
                                  onChange={() => toggleNode(loc)}
                                  style={{cursor:isAdmin?"pointer":"default",accentColor:"#166534"}}/>
                              </td>
                              <td style={{padding:"5px 8px"}}>
                                {isNode ? (
                                  <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                                    {DS_LIST.map(ds => (
                                      <button key={ds} disabled={!isAdmin} onClick={() => toggleCover(loc, ds)}
                                        style={{padding:"2px 7px",borderRadius:10,fontSize:10,fontWeight:700,
                                          cursor:isAdmin?"pointer":"default",border:"1px solid",
                                          borderColor:covers.includes(ds)?"#166534":"#D0D0C0",
                                          background:covers.includes(ds)?"#D1FAE5":"#F8F8F2",
                                          color:covers.includes(ds)?"#166534":"#bbb"}}>
                                        {ds}
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <span style={{color:"#ccc",fontSize:10,fontStyle:"italic"}}>not stocked here</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>

            <button onClick={saveNetCfg} disabled={!netCfgDirty}
              style={{...S.btn(netCfgDirty),marginTop:8,background:netCfgDirty?"#7C3AED":HR.surfaceLight,color:netCfgDirty?HR.white:HR.muted,border:"none"}}>
              Save Network Design Config
            </button>
          </div>
        </details>
      )}

      {/* DS + Period selectors */}
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:4}}>
          {DS_LIST.map(ds => (
            <button key={ds} onClick={() => setDsFilter(ds)} style={S.btn(dsFilter===ds)}>{ds}</button>
          ))}
          {isNetworkDesignActive && (
            <button onClick={() => setDsFilter('DC')} style={{...S.btn(dsFilter==='DC'),background:dsFilter==='DC'?'#7C3AED':undefined,color:dsFilter==='DC'?'#fff':undefined,borderColor:dsFilter==='DC'?'#7C3AED':undefined}}>DC</button>
          )}
        </div>
        {!isNetworkDesignActive && (
          <div style={{display:"flex",gap:4,marginLeft:12}}>
            {[{v:45,l:"L45D"},{v:30,l:"L30D"},{v:15,l:"L15D"},{v:7,l:"L7D"}].map(p => (
              <button key={p.v} onClick={() => setPeriod(p.v)} style={S.btn(period===p.v)}>{p.l}</button>
            ))}
          </div>
        )}
        {isNetworkDesignActive && (
          <span style={{fontSize:10,color:"#7C3AED",marginLeft:12,fontWeight:600}}>
            Lookback: {effectiveNetCfg.lookbackDays || 90}d (set in Network Design Config ↑)
          </span>
        )}
        {!isAdmin && <span style={{fontSize:10,color:HR.muted,marginLeft:"auto"}}>Configs are view-only · Admin login to edit</span>}
      </div>

      {/* ── Per-DS brand stocking status (Network Design mode, DS nodes only) ── */}
      {isNetworkDesignActive && ndDsInfo && dsFilter !== 'DC' && (
        <div style={{...S.card,marginBottom:12,padding:"10px 14px",display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#166534",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Stocked at {dsFilter}</div>
            {ndDsInfo.stocked.length === 0
              ? <div style={{fontSize:12,color:HR.muted}}>No brands stocked here</div>
              : ndDsInfo.stocked.map(({brand, covers}) => (
                  <div key={brand} style={{fontSize:12,color:"#166534",marginBottom:2}}>
                    ● {brand} <span style={{color:HR.muted,fontWeight:400}}>(demand from {covers.join(", ")})</span>
                  </div>
                ))}
          </div>
          {ndDsInfo.notStocked.length > 0 && (
            <div>
              <div style={{fontSize:11,fontWeight:700,color:"#92400E",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Not stocked at {dsFilter}</div>
              {ndDsInfo.notStocked.map(({brand, fulfilledFrom}) => (
                <div key={brand} style={{fontSize:12,color:"#92400E",marginBottom:2}}>
                  ○ {brand} <span style={{color:HR.muted,fontWeight:400}}>→ fulfilled from {fulfilledFrom}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── DS Capacity inputs (Network Design mode, DS nodes only) ────────── */}
      {isNetworkDesignActive && dsFilter !== 'DC' && thickCfg && thinCfg && (
        <div style={{...S.card,marginBottom:12,padding:"8px 14px",display:"flex",gap:24,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:11,fontWeight:700,color:"#555"}}>Physical Capacity at {dsFilter}</span>
          {[{label:"Thick (sheets)",type:"thick",cfg:thickCfg,setCfg:setThickCfg},{label:"Thin (sheets)",type:"thin",cfg:thinCfg,setCfg:setThinCfg}].map(({label,type,cfg,setCfg}) => (
            <label key={type} style={{fontSize:11,display:"flex",alignItems:"center",gap:6}}>
              {label}
              <input type="number" min={1} max={2000} step={10}
                value={cfg.capacity ?? ''}
                disabled={!isAdmin}
                onChange={e => { const v = parseFloat(e.target.value)||0; setCfg(c=>({...c,capacity:v})); handleSaveConfig(type,{...cfg,capacity:v}); }}
                style={{...S.input,width:70,opacity:isAdmin?1:0.7}}/>
            </label>
          ))}
        </div>
      )}

      {isNetworkDesignActive && ndDsInfo && dsFilter !== 'DC'
        ? <NetworkDesignSummaryCards
            thickSkus={ndSkuStats.thick}
            thinSkus={ndSkuStats.thin}
            maxCap={effectiveNetCfg.maxCap || 20}
            lookbackDays={effectiveNetCfg.lookbackDays || 90}
            skuMaster={skuMaster}
            stockedBrands={ndDsInfo.stocked.map(s => s.brand)}
            thickBoundaryMm={appliedBoundary}
          />
        : !isNetworkDesignActive
          ? <SummaryCards skuList={baseSkus} skuMaster={skuMaster} thickCfg={committedThickCfg || thickCfg} thinCfg={committedThinCfg || thinCfg} thickBoundaryMm={thickBoundaryMm}/>
          : null
      }

      {/* ── DC Tab ──────────────────────────────────────────────────────────── */}
      {isNetworkDesignActive && dsFilter === 'DC' && (() => {
        const dcCap = effectiveNetCfg.dcCapacity || { thick: 400, thin: 400 };
        const directBrands = Object.entries(effectiveNetCfg.brands || {}).filter(([,c]) => c.nodes.DC).map(([b,c]) => ({ brand:b, covers:c.nodes.DC.covers }));
        const replenishBrands = Object.keys(effectiveNetCfg.brands || {}).filter(b => !effectiveNetCfg.brands[b].nodes.DC);
        return (
          <div>
            {/* DC brand status */}
            <div style={{...S.card,marginBottom:12,padding:"10px 14px",display:"flex",gap:24,flexWrap:"wrap"}}>
              {directBrands.length > 0 && (
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:"#166534",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Directly Serves</div>
                  {directBrands.map(({brand,covers}) => (
                    <div key={brand} style={{fontSize:12,color:"#166534",marginBottom:2}}>● {brand} <span style={{color:HR.muted,fontWeight:400}}>(from {covers.join(", ")})</span></div>
                  ))}
                </div>
              )}
              <div>
                <div style={{fontSize:11,fontWeight:700,color:"#7C3AED",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Replenishment Only</div>
                {replenishBrands.length === 0
                  ? <div style={{fontSize:12,color:HR.muted}}>All brands directly served</div>
                  : replenishBrands.map(b => <div key={b} style={{fontSize:12,color:"#7C3AED",marginBottom:2}}>● {b}</div>)
                }
              </div>
            </div>
            {/* DC Thick */}
            <div style={{marginBottom:24}}>
              <div style={{...S.sectionTitle,display:"flex",alignItems:"center",gap:8}}>
                DC Thick SKUs — Vertical Storage
                {isAdmin && (
                  <label style={{fontSize:11,fontWeight:400,display:"flex",alignItems:"center",gap:4,marginLeft:8}}>
                    Capacity
                    <input type="number" min={1} max={2000} step={10}
                      value={(localNetCfg||effectiveNetCfg).dcCapacity?.thick ?? 400}
                      onChange={e => handleNetCfgChange('dcCapacity.thick', Number(e.target.value))}
                      style={{width:60,padding:"0 4px",fontSize:12,fontWeight:700,border:"1px solid #7C3AED",borderRadius:4,color:"#7C3AED",background:HR.white,textAlign:"center"}}/>
                    sheets
                  </label>
                )}
              </div>
              <CapacityBar used={dcSkuStats.thick.reduce((s,x)=>s+x.maxQty,0)} total={dcCap.thick} label="DC Vertical Storage Capacity" cfg={null}/>
              <div style={S.card}>
                <NetworkDesignSKUTable skus={dcSkuStats.thick} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }} showNZD={false} isDC={true}/>
              </div>
            </div>
            {/* DC Thin */}
            <div style={{marginBottom:24}}>
              <div style={{...S.sectionTitle,display:"flex",alignItems:"center",gap:8}}>
                DC Thin SKUs — Tub Storage
                {isAdmin && (
                  <label style={{fontSize:11,fontWeight:400,display:"flex",alignItems:"center",gap:4,marginLeft:8}}>
                    Capacity
                    <input type="number" min={1} max={2000} step={10}
                      value={(localNetCfg||effectiveNetCfg).dcCapacity?.thin ?? 400}
                      onChange={e => handleNetCfgChange('dcCapacity.thin', Number(e.target.value))}
                      style={{width:60,padding:"0 4px",fontSize:12,fontWeight:700,border:"1px solid #7C3AED",borderRadius:4,color:"#7C3AED",background:HR.white,textAlign:"center"}}/>
                    sheets
                  </label>
                )}
              </div>
              <CapacityBar used={dcSkuStats.thin.reduce((s,x)=>s+x.maxQty,0)} total={dcCap.thin} label="DC Tub Storage Capacity" cfg={null}/>
              <div style={S.card}>
                <NetworkDesignSKUTable skus={dcSkuStats.thin} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }} showNZD={false} isDC={true}/>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Thick section */}
      {dsFilter !== 'DC' && <div style={{marginBottom:24}}>
        <div style={{...S.sectionTitle,display:"flex",alignItems:"center",gap:6}}>
          Thick SKUs — Vertical Storage: Greater than
          <input
            type="number"
            value={thickBoundaryMm}
            disabled={!isAdmin}
            min={1} max={30} step={1}
            onChange={e => handleSaveBoundary(parseFloat(e.target.value) || 6)}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === 'Enter' && boundaryDirty) { const freshBase = computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm); runBothSections(freshBase); } }}
            style={{width:40,padding:"0 4px",fontSize:12,fontWeight:700,border:`1px solid #C05A00`,borderRadius:4,color:"#92400E",background:isAdmin?HR.white:HR.surfaceLight,textAlign:"center"}}
          />
          mm {!isAdmin && <span style={{fontSize:9,color:HR.muted,fontWeight:400}}>(admin to edit)</span>}
          {isNetworkDesignActive && ndDsInfo?.coveredDSes?.length > 0 && (
            <span style={{fontSize:10,color:"#7C3AED",fontWeight:600,marginLeft:8}}>
              Aggregated: {ndDsInfo.coveredDSes.join(", ")}
            </span>
          )}
        </div>
        {isNetworkDesignActive && ndDsInfo ? (
          <>
            {ndDsInfo.stocked.length === 0
              ? <div style={{padding:16,color:HR.muted,fontSize:12}}>No brands stocked at {dsFilter} — see fulfillment above.</div>
              : <>
                  <CapacityBar used={ndSkuStats.thick.reduce((s,x)=>s+x.maxQty,0)} total={thickCfg.capacity} label="Vertical Storage — estimated Max load" cfg={null}/>
                  <div style={S.card}>
                    <NetworkDesignSKUTable skus={ndSkuStats.thick} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }}/>
                  </div>
                </>
            }
          </>
        ) : (
          <>
            <ConfigPanel type="thick" cfg={thickCfg} onChange={setThickCfg} isAdmin={isAdmin} onRun={runThick} dirty={thickDirty} boundary={thickBoundaryMm}/>
            {thickResults ? (
              <>
                <CapacityBar used={thickResults.capUsed} total={thickCfg.capacity} label="Vertical Storage Capacity" cfg={thickCfg}/>
                <div style={S.card}>
                  <SKUTable skus={thickResults.skus} cfg={committedThickCfg || thickCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }}/>
                </div>
              </>
            ) : (
              <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click ▶ Run</div>
            )}
          </>
        )}
      </div>}

      {/* Thin section */}
      {dsFilter !== 'DC' && <div style={{marginBottom:24}}>
        <div style={{...S.sectionTitle,display:"flex",alignItems:"center",gap:6}}>
          Thin SKUs — Tub Storage: Up to {thickBoundaryMm}mm
          {isNetworkDesignActive && ndDsInfo?.coveredDSes?.length > 0 && (
            <span style={{fontSize:10,color:"#7C3AED",fontWeight:600,marginLeft:8}}>
              Aggregated: {ndDsInfo.coveredDSes.join(", ")}
            </span>
          )}
        </div>
        {isNetworkDesignActive && ndDsInfo ? (
          <>
            {ndDsInfo.stocked.length === 0
              ? <div style={{padding:16,color:HR.muted,fontSize:12}}>No brands stocked at {dsFilter}.</div>
              : <>
                  <CapacityBar used={ndSkuStats.thin.reduce((s,x)=>s+x.maxQty,0)} total={thinCfg.capacity} label="Tub Storage — estimated Max load" cfg={null}/>
                  <div style={S.card}>
                    <NetworkDesignSKUTable skus={ndSkuStats.thin} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }}/>
                  </div>
                </>
            }
          </>
        ) : (
          <>
            <ConfigPanel type="thin" cfg={thinCfg} onChange={setThinCfg} isAdmin={isAdmin} onRun={runThin} dirty={thinDirty} boundary={thickBoundaryMm}/>
            {thinResults ? (
              <>
                <CapacityBar used={thinResults.capUsed} total={thinCfg.capacity} label="Tub Storage Capacity" cfg={thinCfg}/>
                <div style={S.card}>
                  <SKUTable skus={thinResults.skus} cfg={committedThinCfg || thinCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }}/>
                </div>
              </>
            ) : (
              <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click ▶ Run</div>
            )}
          </>
        )}
      </div>}

      {selectedSku && (
        isNetworkDesignActive && selectedSku.trace
          ? <NetworkDesignSKUModal sku={selectedSku} onClose={() => setSelectedSku(null)} invoiceDateRange={invoiceDateRange}/>
          : <SKUModal sku={selectedSku} cfg={selectedSkuType === "thick" ? thickCfg : thinCfg} onClose={() => setSelectedSku(null)} invoiceDateRange={invoiceDateRange}/>
      )}
    </div>
  );
}
