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

  // Timeline: filter to lookback window only
  const allDates = invoiceDateRange?.dates || [];
  const latestDate = allDates[allDates.length - 1];
  const lookbackDates = (() => {
    if (!latestDate || !t.lookbackDays) return allDates;
    const cutoff = new Date(latestDate);
    cutoff.setDate(cutoff.getDate() - t.lookbackDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return allDates.filter(d => d >= cutoffStr);
  })();
  const timelineData = lookbackDates.map(d => ({ date: d.slice(5), qty: sku.dailyMap[d] || 0 }));
  const tBarSize = Math.max(3, Math.min(20, Math.floor(340 / Math.max(timelineData.length, 1))));

  // Order qty histogram
  const histData = (() => {
    const b = {};
    (sku.orderQtys||[]).forEach(q => { const k = Math.ceil(q); b[k] = (b[k]||0)+1; });
    return Object.entries(b).sort((a,c)=>+a[0]-+c[0]).map(([qty,count])=>({qty:+qty,count}));
  })();
  const hBarSize = Math.max(3, Math.min(20, Math.floor(340 / Math.max(histData.length, 1))));

  // Winsorisation note
  const winsorised = t.spikeCap != null && (t.rawNonZero||[]).some((v,i) => (t.winsorized||[])[i] < v);

  const fmtCovers = (arr) => (arr||[]).join(', ');
  const statLine = t.isDC
    ? `DC Min: ${sku.minQty} · DC Max: ${sku.maxQty}`
    : `Min: ${sku.minQty} · Max: ${sku.maxQty} · ${t.nzd||0} NZD · ${t.orderQtyCount||0} orders`;

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:10,padding:"16px 20px",width:"min(860px,96vw)",maxHeight:"88vh",overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.18)"}} onClick={e=>e.stopPropagation()}>

        {/* Compact header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#1A1A1A",lineHeight:1.3}}>{sku.name}</div>
            <div style={{fontSize:10,color:"#888",marginTop:2}}>
              {sku.sku} · {sku.mm != null ? `${sku.mm}mm` : "—"}
              <span style={{marginLeft:12,color:"#333",fontWeight:600}}>{statLine}</span>
              {!t.isDC && (t.covers||[]).length > 0 && (
                <div style={{marginTop:1,color:"#7C3AED",fontWeight:600}}>
                  Order Behaviour: {(t.covers||[]).join(" and ")} combined
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"1px solid #E0E0D0",borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:11,color:"#888",flexShrink:0,marginLeft:12}}>Close ✕</button>
        </div>

        <div style={{borderTop:"1px solid #F0F0E8",marginBottom:10}}/>

        {/* Computation — compact formula lines */}
        {t.isDC ? (
          <div style={{fontSize:11,lineHeight:1.8,color:"#444",background:"#FAFAF8",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            {t.dcP95 > 0
              ? <div>Direct serving: <b>P{t.pMin ?? 95}(demand from {fmtCovers(t.dcCovers)}) = {t.dcP95} sheets</b></div>
              : <div style={{color:"#888"}}>Direct serving: 0 (brand not directly served by DC)</div>
            }
            <div>Replenishment: <b>Σ DS_Min × {t.dcMultMin}</b> = {Math.ceil((t.sumMin||0) * (t.dcMultMin||0.3))} sheets &nbsp;|&nbsp; DC Min = {t.dcP95} + {Math.ceil((t.sumMin||0)*(t.dcMultMin||0.3))} = <b style={{color:"#B91C1C"}}>{sku.minQty}</b></div>
            <div>Replenishment: <b>Σ DS_Min × {t.dcMultMax}</b> = {Math.ceil((t.sumMin||0) * (t.dcMultMax||0.5))} sheets &nbsp;|&nbsp; DC Max = {t.dcP95} + {Math.ceil((t.sumMin||0)*(t.dcMultMax||0.5))} = <b style={{color:"#16a34a"}}>{sku.maxQty}</b></div>
          </div>
        ) : t.belowMinNZD ? (
          <div style={{fontSize:11,color:"#92400E",background:"#FFF7ED",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            ⚠ Only {t.nzd} NZD day{t.nzd!==1?"s":""} in lookback — below minimum threshold ({t.minNZDThreshold}). Not stocked (Min = Max = 0).
          </div>
        ) : (
          <div style={{fontSize:11,lineHeight:1.9,color:"#444",background:"#FAFAF8",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <div>
              <b>P{t.pMin}</b> of daily demand ({t.nzd} NZD days, median <b>{t.dtMedian?.toFixed(1)}</b> sheets)
              {winsorised && <span style={{color:"#888",marginLeft:6}}>— outliers winsorised at {t.dtMedian?.toFixed(1)} × {((t.spikeCap||0)/(t.dtMedian||1)).toFixed(0)}</span>}
              {" "}&nbsp;=&nbsp; {t.p95Raw?.toFixed(1)} &nbsp;→&nbsp; <b style={{color:"#B91C1C"}}>Min = {sku.minQty}</b>
            </div>
            <div>
              <b>P{t.pBuf}</b> of {t.orderQtyCount} orders &nbsp;=&nbsp; {t.orderBuf} sheets (Max buffer) &nbsp;→&nbsp;
              {" "}{sku.minQty} + {t.orderBuf} = {t.rawMax}
              {t.capApplied
                ? <span> → capped to {t.cap} &nbsp;<b style={{color:"#16a34a"}}>Max = {sku.maxQty}</b></span>
                : <span> ≤ cap {t.cap} ✓ &nbsp;<b style={{color:"#16a34a"}}>Max = {sku.maxQty}</b></span>
              }
            </div>
          </div>
        )}

        {/* Charts side by side — DS nodes only */}
        {!t.isDC && (timelineData.length > 0 || histData.length > 0) && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {/* Timeline */}
            <div>
              <div style={{fontSize:10,fontWeight:600,color:"#555",marginBottom:4}}>
                Daily Demand — {fmtCovers(t.covers)} ({t.lookbackDays||90}d lookback)
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={timelineData} margin={{left:0,right:52,top:4,bottom:16}}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                  <XAxis dataKey="date" tick={{fontSize:8}} interval={Math.max(0,Math.floor(timelineData.length/5)-1)}/>
                  <YAxis tick={{fontSize:8}} width={24}/>
                  <RTooltip contentStyle={{fontSize:10}}/>
                  {sku.dailyMedian > 0 && <ReferenceLine y={sku.dailyMedian} stroke="#888" strokeDasharray="3 2"
                    label={{value:`Median=${sku.dailyMedian.toFixed(0)}`,position:"right",fontSize:8,fill:"#888"}}/>}
                  {sku.minQty > 0 && <ReferenceLine y={sku.minQty} stroke="#B91C1C" strokeDasharray="4 3"
                    label={{value:`Min=${sku.minQty}`,position:"right",fontSize:8,fill:"#B91C1C"}}/>}
                  {sku.maxQty > 0 && <ReferenceLine y={sku.maxQty} stroke="#16a34a" strokeDasharray="4 3"
                    label={{value:`Max=${sku.maxQty}`,position:"right",fontSize:8,fill:"#16a34a"}}/>}
                  <Bar dataKey="qty" barSize={tBarSize} fill="#0077A8" radius={[2,2,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* Histogram */}
            {histData.length > 0 && (
              <div>
                <div style={{fontSize:10,fontWeight:600,color:"#555",marginBottom:4}}>
                  Order Qty Distribution ({t.orderQtyCount} orders)
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={histData} margin={{left:0,right:8,top:4,bottom:16}}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                    <XAxis dataKey="qty" type="number" domain={[0, 'auto']} tick={{fontSize:8}}/>
                    <YAxis tick={{fontSize:8}} width={24}/>
                    <RTooltip contentStyle={{fontSize:10}} formatter={v=>[v,"orders"]} labelFormatter={l=>`Qty: ${l}`}/>
                    {sku.minQty > 0 && <ReferenceLine x={sku.minQty} stroke="#B91C1C" strokeDasharray="4 3"
                      label={{value:`Min=${sku.minQty}`,position:"top",fontSize:8,fill:"#B91C1C"}}/>}
                    {sku.maxQty > 0 && <ReferenceLine x={sku.maxQty} stroke="#16a34a" strokeDasharray="4 3"
                      label={{value:`Max=${sku.maxQty}`,position:"top",fontSize:8,fill:"#16a34a"}}/>}
                    <Bar dataKey="count" barSize={hBarSize} fill="#7C3AED" radius={[2,2,0,0]}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NetworkDesignSummaryCards({ thickSkus, thinSkus, maxCap, minNZD }) {
  // All active SKUs now included (zero-demand ones have NZD=0, Min=Max=0)
  const allTk = thickSkus.length;
  const allTn = thinSkus.length;
  const total = allTk + allTn;

  const stockTk = thickSkus.filter(s => s.minQty > 0).length;
  const stockTn = thinSkus.filter(s => s.minQty > 0).length;
  const stocked = stockTk + stockTn;

  const capCount = [...thickSkus, ...thinSkus].filter(s => s.minQty > 0 && s.maxQty >= maxCap).length;

  const notStocked = total - stocked;
  const nzd1    = [...thickSkus, ...thinSkus].filter(s => s.minQty === 0 && s.trace?.nzd === 1).length;
  const noSales = [...thickSkus, ...thinSkus].filter(s => s.minQty === 0 && (s.trace?.nzd || 0) === 0).length;

  const pct = (n, d) => d > 0 ? ` (${Math.round(n / d * 100)}%)` : "";
  const sep = <span style={{color:HR.border,margin:"0 10px"}}>|</span>;

  return (
    <div style={{...S.card,padding:"9px 14px",marginBottom:12,display:"flex",alignItems:"center",flexWrap:"wrap",gap:4,fontSize:11}}>
      <span>
        <span style={{fontWeight:700,color:"#0077A8"}}>{total}</span>
        <span style={{color:"#555",marginLeft:5}}>Total Active</span>
      </span>
      {sep}
      <span>
        <span style={{fontWeight:700,color:"#16a34a"}}>{stocked}{pct(stocked,total)}</span>
        <span style={{color:"#555",marginLeft:5}}>Stocked</span>
        <span style={{color:HR.muted,marginLeft:5}}>· NZD ≥ {minNZD} · Thick: {stockTk} · Thin: {stockTn}</span>
        {capCount > 0 && <span style={{color:"#D97706",marginLeft:5}}>· {capCount} at cap</span>}
      </span>
      {sep}
      <span>
        <span style={{fontWeight:700,color:"#6B7280"}}>{notStocked}{pct(notStocked,total)}</span>
        <span style={{color:"#555",marginLeft:5}}>Not stocked</span>
        <span style={{color:HR.muted,marginLeft:5}}>· 1 NZD: {nzd1} · No sales: {noSales}</span>
      </span>
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

// Unified DS SKU table for Network Design — flat list, filterable, sortable
function NetworkDesignUnifiedTable({ thickSkus, thinSkus, thickCap, thinCap, onSelectSku }) {
  const [query,       setQuery]       = React.useState('');
  const [filterBrand, setFilterBrand] = React.useState('All');
  const [filterType,  setFilterType]  = React.useState('All');
  const [filterMm,    setFilterMm]    = React.useState('All');
  const [sortBy,      setSortBy]      = React.useState('nzd');
  const [sortDir,     setSortDir]     = React.useState(-1);

  const allSkus = [...thickSkus, ...thinSkus];
  const thickUsed = thickSkus.reduce((s,x) => s + x.maxQty, 0);
  const thinUsed  = thinSkus.reduce((s,x)  => s + x.maxQty, 0);

  // All active SKUs are now in thickSkus/thinSkus — no skuMaster lookup needed
  const activeThick  = thickSkus.length;
  const activeThin   = thinSkus.length;
  const stockedThick = thickSkus.filter(s => s.minQty > 0).length;
  const stockedThin  = thinSkus.filter(s  => s.minQty > 0).length;

  // Dropdown options
  const brands   = ['All', ...[...new Set(allSkus.map(s=>s.brand).filter(Boolean))].sort()];
  const mmOpts   = ['All', ...[...new Set(allSkus.map(s=>s.mm).filter(v=>v!=null))].sort((a,b)=>a-b).map(v=>`${v}mm`)];

  const handleSort = col => {
    if (sortBy === col) setSortDir(d => d*-1);
    else { setSortBy(col); setSortDir(['sku','name','brand'].includes(col) ? 1 : -1); }
  };

  const q = query.toLowerCase();
  const filtered = allSkus
    .filter(s => {
      if (filterBrand !== 'All' && s.brand !== filterBrand) return false;
      if (filterType  === 'Thick' && s.thicknessCat !== 'Thick') return false;
      if (filterType  === 'Thin'  && s.thicknessCat === 'Thick') return false;
      if (filterMm    !== 'All'   && `${s.mm}mm` !== filterMm)   return false;
      if (q && !s.sku.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a,b) => {
      switch(sortBy) {
        case 'sku':   return a.sku.localeCompare(b.sku) * sortDir;
        case 'name':  return a.name.localeCompare(b.name) * sortDir;
        case 'brand': return (a.brand||'').localeCompare(b.brand||'') * sortDir;
        case 'mm':    return ((b.mm??-1) - (a.mm??-1)) * sortDir;
        case 'nzd':   return (b.nzd - a.nzd) * sortDir;
        case 'min':   return (b.minQty - a.minQty) * sortDir;
        case 'max':   return (b.maxQty - a.maxQty) * sortDir;
        default: return 0;
      }
    });

  const sel = {fontSize:11,padding:"4px 8px",border:"1px solid #E0E0D0",borderRadius:5,background:"#fff",color:"#555",cursor:"pointer",outline:"none"};
  const sh = (col, label, center) => {
    const on = sortBy === col;
    return (
      <th onClick={() => handleSort(col)}
        style={{padding:"4px 6px",fontWeight:700,fontSize:10,color:on?"#7C3AED":"#666",
          borderBottom:"1px solid #E0E0D0",textAlign:center?"center":"left",
          whiteSpace:"nowrap",cursor:"pointer",userSelect:"none",background:"#F8F8F2"}}>
        {label}{on?(sortDir===-1?"↓":"↑"):<span style={{color:"#ccc",fontSize:8}}>↕</span>}
      </th>
    );
  };

  const inlineCapBar = (used, total, label) => {
    const pct = total > 0 ? used/total*100 : 0;
    const over = pct>110, atLim = pct>100;
    const col = over?"#DC2626":atLim?"#F59E0B":"#16a34a";
    return (
      <div style={{flex:1,padding:"5px 10px",border:"1px solid #E0E0D0",borderRadius:6,background:"#FAFAF8"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:3}}>
          <span style={{fontSize:10,fontWeight:600,color:"#555"}}>{label}</span>
          <span style={{fontSize:10,fontWeight:700,color:col}}>{used}/{total} · {pct.toFixed(0)}%{over?" Over":atLim?" At Limit":""}</span>
        </div>
        <div style={{height:4,background:"#E5E5D0",borderRadius:2,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${Math.min(100,pct)}%`,background:col,borderRadius:2}}/>
        </div>
      </div>
    );
  };

  const hasFilter = query || filterBrand!=='All' || filterType!=='All' || filterMm!=='All';

  return (
    <div>
      {/* Heading */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
        <span style={{fontSize:12,fontWeight:700,color:"#333"}}>SKU Level Stocking</span>
        <span style={{fontSize:10,color:"#888"}}>
          Thick: <b style={{color:"#92400E"}}>{stockedThick} stocked</b> / {activeThick} active
          &nbsp;·&nbsp;
          Thin: <b style={{color:"#1e40af"}}>{stockedThin} stocked</b> / {activeThin} active
        </span>
      </div>

      {/* Capacity bars — side by side at 50% each */}
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        {inlineCapBar(thickUsed, thickCap, "Vertical Storage — Thick")}
        {inlineCapBar(thinUsed,  thinCap,  "Tub Storage — Thin")}
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
        <input type="text" placeholder="Search SKU or name…" value={query}
          onChange={e => setQuery(e.target.value)}
          style={{...sel,width:200,padding:"4px 10px"}}/>
        <select value={filterBrand} onChange={e=>setFilterBrand(e.target.value)} style={sel}>
          {brands.map(b => <option key={b} value={b}>{b==='All'?'All Brands':b}</option>)}
        </select>
        <select value={filterType} onChange={e=>setFilterType(e.target.value)} style={sel}>
          <option value="All">Thick &amp; Thin</option>
          <option value="Thick">Thick only</option>
          <option value="Thin">Thin only</option>
        </select>
        <select value={filterMm} onChange={e=>setFilterMm(e.target.value)} style={sel}>
          {mmOpts.map(v => <option key={v} value={v}>{v==='All'?'All mm':v}</option>)}
        </select>
        {hasFilter && (
          <button onClick={() => {setQuery('');setFilterBrand('All');setFilterType('All');setFilterMm('All');}}
            style={{fontSize:10,color:"#7C3AED",background:"none",border:"1px solid #7C3AED",borderRadius:4,padding:"3px 8px",cursor:"pointer"}}>
            Clear
          </button>
        )}
        <span style={{fontSize:10,color:"#bbb",marginLeft:"auto"}}>{filtered.length} SKUs</span>
      </div>

      {/* Table */}
      <div style={{overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed",fontSize:11}}>
          <colgroup>
            <col style={{width:"22%"}}/><col style={{width:"33%"}}/><col style={{width:"11%"}}/><col style={{width:"12%"}}/><col style={{width:"7%"}}/><col style={{width:"7%"}}/><col style={{width:"8%"}}/>
          </colgroup>
          <thead>
            <tr>
              {sh('sku','SKU',false)}
              {sh('name','Item Name',false)}
              {sh('mm','Thickness',true)}
              {sh('brand','Brand',false)}
              {sh('nzd','NZD',true)}
              {sh('min','Min',true)}
              {sh('max','Max',true)}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} style={{padding:16,textAlign:"center",color:"#aaa",fontSize:11}}>No SKUs match the current filters</td></tr>
            ) : filtered.map((s,i) => {
              const isThick = s.thicknessCat === 'Thick';
              return (
                <tr key={s.sku} onClick={() => onSelectSku(s)}
                  style={{background:i%2===0?"#fff":"#FAFAF8",cursor:"pointer"}}>
                  <td style={{padding:"3px 6px",fontFamily:"monospace",fontSize:10,color:"#666",borderBottom:"1px solid #F5F5F0",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.sku}</td>
                  <td style={{padding:"3px 6px",borderBottom:"1px solid #F5F5F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</td>
                  <td style={{padding:"3px 6px",borderBottom:"1px solid #F5F5F0"}}>
                    <div style={{display:"flex",alignItems:"center",gap:4,justifyContent:"center"}}>
                      <span style={{display:"inline-block",width:28,textAlign:"right",fontSize:10,color:"#555",flexShrink:0}}>{s.mm!=null?s.mm:"—"}</span>
                      <span style={{fontSize:10,color:"#888",flexShrink:0}}>mm</span>
                      <span style={{display:"inline-block",width:34,textAlign:"center",fontSize:9,fontWeight:700,padding:"1px 0",borderRadius:3,flexShrink:0,
                        background:isThick?"#FEF3C7":"#DBEAFE",color:isThick?"#92400E":"#1e40af"}}>
                        {isThick?"Thick":"Thin"}
                      </span>
                    </div>
                  </td>
                  <td style={{padding:"3px 6px",borderBottom:"1px solid #F5F5F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#555"}}>{s.brand||"—"}</td>
                  <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid #F5F5F0"}}>{s.nzd}</td>
                  <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,color:"#1e40af",borderBottom:"1px solid #F5F5F0"}}>{s.minQty}</td>
                  <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,color:"#166534",borderBottom:"1px solid #F5F5F0"}}>{s.maxQty}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
      lookbackDays: cfg.lookbackDays || 90,
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
  const [expandedCell, setExpandedCell] = useState(null); // {brand, loc} for matrix covers editor

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
      allStats.push(...stats.map(s => ({ ...s, covers, brand })));
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
  // Matrix assignment helpers — defined at component level so they work across brands
  const toggleNodeForBrand = (brand, loc) => {
    if (!isAdmin) return;
    const nodes = { ...(editingNetCfg.brands?.[brand]?.nodes || {}) };
    if (nodes[loc]) { delete nodes[loc]; setExpandedCell(null); }
    else { nodes[loc] = { covers: loc === 'DC' ? [] : [loc] }; setExpandedCell({ brand, loc }); }
    handleNetBrandCfgChange(brand, 'nodes', nodes);
  };
  const toggleCoverForBrand = (brand, loc, ds) => {
    if (!isAdmin) return;
    const nodes = editingNetCfg.brands?.[brand]?.nodes || {};
    const cur = nodes[loc]?.covers || [];
    handleNetBrandCfgChange(brand, 'nodes', { ...nodes, [loc]: { ...nodes[loc], covers: cur.includes(ds) ? cur.filter(d => d !== ds) : [...cur, ds] } });
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
        <div style={{background:"#edf7ed",border:"1px solid #b7ddb7",borderRadius:6,padding:"7px 14px",marginBottom:12,display:"flex",gap:24,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:11,fontWeight:700,color:"#2d6a2d",whiteSpace:"nowrap"}}>
            Network Design {isNetworkDesignActive ? "● Active" : "○ Inactive"}
          </span>
          <span style={{fontSize:11,color:"#3a803a"}}>
            {Object.keys(effectiveNetCfg.brands).join(" · ")}
          </span>
          <span style={{color:"#b7ddb7",fontSize:12}}>|</span>
          <span style={{fontSize:11,fontWeight:700,color:"#92400E",whiteSpace:"nowrap"}}>Excluded</span>
          <span style={{fontSize:11,color:"#92400E"}}>Merino</span>
        </div>
      )}

      {/* ── Network Design Config Editor (admin only) ────────────────────────── */}
      {isAdmin && effectiveNetCfg?.brands && (
        <details style={{marginBottom:16}} open={false}>
          <summary style={{cursor:"pointer",fontSize:12,fontWeight:700,color:"#7C3AED",padding:"6px 0",userSelect:"none"}}>
            ⚙ Network Design Configuration {netCfgDirty ? " · unsaved changes" : ""}
          </summary>
          <div style={{...S.card,marginTop:8,padding:0,overflow:"hidden"}}>

            {/* ── Global Settings — tinted background to distinguish from brand table ── */}
            <div style={{background:"#F5F3FF",padding:"12px 14px 14px",borderBottom:`1px solid #E5E0F8`}}>
              <div style={{fontSize:11,fontWeight:700,color:"#7C3AED",marginBottom:10,letterSpacing:0.2}}>Global Settings</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"10px 24px"}}>
                {[
                  {label:"History Window",key:"lookbackDays",min:30,max:365,step:1,hint:"Days of sales history used to compute Min & Max"},
                  {label:"Min Qty Percentile",key:"minPercentile",min:50,max:99,step:1,hint:"P95 = stock enough for 95% of peak demand days"},
                  {label:"Max Buffer Percentile",key:"maxBufferPercentile",min:50,max:99,step:1,hint:"P75 = buffer of ~one typical large order above Min"},
                  {label:"Min Sales Days to Stock",key:"minNZD",min:1,max:20,step:1,hint:"Skip SKUs with fewer non-zero demand days than this"},
                  {label:"Outlier Cap (× median)",key:"spikeCapMultiplier",min:1,max:20,step:0.5,hint:"Winsorise spike days at N × median before P95"},
                  {label:"Max Sheets per Location",key:"maxCap",min:1,max:100,step:1,hint:"Hard ceiling on Max per SKU per location"},
                ].map(({label,key,min,max,step,hint}) => (
                  <label key={key} style={{display:"flex",flexDirection:"column",gap:2}}>
                    <span style={{fontSize:11,fontWeight:600,color:"#444"}}>{label}</span>
                    <input type="number" min={min} max={max} step={step}
                      value={editingNetCfg[key] ?? ""}
                      onChange={e => handleNetCfgChange(key, Number(e.target.value))}
                      style={{...S.input,width:"100%",background:"#fff"}}/>
                    <span style={{fontSize:9,color:"#9B8EC4",lineHeight:1.4}}>{hint}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* ── Brand table section — default white background ── */}
            <div style={{padding:"12px 14px 14px"}}>

            {/* ── Brand Network Assignments — matrix (DC mult columns on right) ── */}
            <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:8}}>
              <span style={{fontSize:11,fontWeight:700,color:"#555",flexShrink:0}}>Brand Network Assignments</span>
              <span style={{fontSize:10,color:HR.muted,display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
                <span><span style={{color:"#166534",fontWeight:600}}>☑ Stocked</span> — caters to demand of selected DSes</span>
                <span style={{color:HR.border}}>|</span>
                <span><span style={{fontWeight:600}}>☐ Not stocked</span> — fulfillment source shown below</span>
              </span>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{borderCollapse:"collapse",fontSize:11,width:"100%"}}>
                <thead>
                  <tr style={{background:HR.surfaceLight}}>
                    <th style={{padding:"5px 10px",textAlign:"left",color:HR.muted,fontWeight:600,borderBottom:`1px solid ${HR.border}`,minWidth:110}}>Brand</th>
                    {[...DS_LIST,"DC"].map(loc => (
                      <th key={loc} style={{padding:"5px 10px",textAlign:"center",color:loc==="DC"?"#7C3AED":HR.muted,fontWeight:700,borderBottom:`1px solid ${HR.border}`,minWidth:72}}>{loc}</th>
                    ))}
                    <th style={{padding:"5px 10px",textAlign:"center",color:HR.muted,fontWeight:600,borderBottom:`1px solid ${HR.border}`,minWidth:72,borderLeft:`1px solid ${HR.border}`}}>DC Mult Min</th>
                    <th style={{padding:"5px 10px",textAlign:"center",color:HR.muted,fontWeight:600,borderBottom:`1px solid ${HR.border}`,minWidth:72}}>DC Mult Max</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(editingNetCfg.brands || {}).flatMap(([brand, cfg], bi) => {
                    const nodes = cfg.nodes || {};
                    const isExpanded = expandedCell?.brand === brand;
                    const expandedLoc = expandedCell?.loc;
                    const brandRow = (
                      <tr key={brand} style={{background:bi%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{padding:"6px 10px",fontWeight:700,color:HR.text,borderBottom:`1px solid ${HR.border}`}}>{brand}</td>
                        {[...DS_LIST,"DC"].map(loc => {
                          const isNode = !!nodes[loc];
                          const isDCCol = loc === "DC";
                          const isThisExpanded = isExpanded && expandedLoc === loc;
                          // For unchecked DS cells: which stocking nodes cover this DS?
                          const servedBy = (!isNode && !isDCCol)
                            ? Object.entries(nodes)
                                .filter(([, nCfg]) => nCfg.covers?.includes(loc))
                                .map(([nId]) => nId)
                            : [];
                          return (
                            <td key={loc} style={{padding:"6px 10px",textAlign:"center",borderBottom:`1px solid ${HR.border}`,background:isThisExpanded?(isDCCol?"#F5F3FF":"#F0FFF4"):undefined}}>
                              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                                <input type="checkbox" checked={isNode} disabled={!isAdmin}
                                  onChange={() => toggleNodeForBrand(brand, loc)}
                                  style={{cursor:isAdmin?"pointer":"default",accentColor:isDCCol?"#7C3AED":"#166534"}}/>
                                {isNode ? (
                                  <button onClick={() => setExpandedCell(isThisExpanded ? null : {brand,loc})}
                                    style={{fontSize:9,color:isDCCol?"#7C3AED":"#166534",background:"none",border:"none",cursor:"pointer",padding:0,fontWeight:600}}>
                                    {isThisExpanded ? "▲ close" : `${(nodes[loc]?.covers||[]).length} DSes ▾`}
                                  </button>
                                ) : isDCCol ? (
                                  <span style={{fontSize:9,color:"#7C3AED",lineHeight:1.3,textAlign:"center"}}>Replenishment only</span>
                                ) : servedBy.length > 0 ? (
                                  <span style={{fontSize:9,color:HR.muted,lineHeight:1.3,textAlign:"center"}}>
                                    {servedBy.join(' · ')}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                          );
                        })}
                        {["dcMultMin","dcMultMax"].map((key, ki) => (
                          <td key={key} style={{padding:"5px 8px",textAlign:"center",borderBottom:`1px solid ${HR.border}`,borderLeft:ki===0?`1px solid ${HR.border}`:undefined}}>
                            <input type="number" min={0.1} max={5} step={0.1}
                              value={cfg[key] ?? ""}
                              disabled={!isAdmin}
                              onChange={e => handleNetBrandCfgChange(brand, key, Number(e.target.value))}
                              style={{...S.input,width:52,textAlign:"center",opacity:isAdmin?1:0.7}}/>
                          </td>
                        ))}
                      </tr>
                    );
                    if (!isExpanded) return [brandRow];
                    const isDCExpanded = expandedLoc === "DC";
                    const coversRow = (
                      <tr key={`${brand}-covers`}>
                        <td style={{padding:"8px 10px",fontSize:10,color:HR.muted,fontStyle:"italic",borderBottom:`1px solid ${HR.border}`}}>
                          {brand} · {expandedLoc}
                        </td>
                        <td colSpan={8} style={{padding:"8px 10px",borderBottom:`1px solid ${HR.border}`,background:isDCExpanded?"#F5F3FF":"#F0FFF4"}}>
                          <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
                            <span style={{fontSize:10,fontWeight:600,color:isDCExpanded?"#7C3AED":"#166534",marginRight:4}}>
                              {isDCExpanded ? "Fulfils customer orders from:" : "Aggregates demand from:"}
                            </span>
                            {DS_LIST.map(ds => {
                              const covers = nodes[expandedLoc]?.covers || [];
                              const on = covers.includes(ds);
                              return (
                                <button key={ds} disabled={!isAdmin} onClick={() => toggleCoverForBrand(brand, expandedLoc, ds)}
                                  style={{padding:"3px 9px",borderRadius:10,fontSize:10,fontWeight:700,cursor:isAdmin?"pointer":"default",
                                    border:"1px solid",borderColor:on?(isDCExpanded?"#7C3AED":"#166534"):"#D0D0C0",
                                    background:on?(isDCExpanded?"#EDE9FE":"#D1FAE5"):"#F8F8F2",
                                    color:on?(isDCExpanded?"#7C3AED":"#166534"):"#bbb"}}>
                                  {ds}
                                </button>
                              );
                            })}
                            {isDCExpanded && <span style={{fontSize:9,color:HR.muted,marginLeft:4}}>· also replenishes all DS stocking nodes</span>}
                          </div>
                        </td>
                      </tr>
                    );
                    return [brandRow, coversRow];
                  })}
                </tbody>
              </table>
            </div>

            <button onClick={saveNetCfg} disabled={!netCfgDirty}
              style={{...S.btn(netCfgDirty),marginTop:12,background:netCfgDirty?"#7C3AED":HR.surfaceLight,color:netCfgDirty?HR.white:HR.muted,border:"none"}}>
              Save Network Design Configuration
            </button>
            </div>{/* end brand section */}
          </div>
        </details>
      )}

      {/* DS + Period selectors + inline brand stocking info */}
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:4,flexShrink:0}}>
          {DS_LIST.map(ds => (
            <button key={ds} onClick={() => setDsFilter(ds)} style={S.btn(dsFilter===ds)}>{ds}</button>
          ))}
          {isNetworkDesignActive && (
            <button onClick={() => setDsFilter('DC')} style={{...S.btn(dsFilter==='DC'),background:dsFilter==='DC'?'#7C3AED':undefined,color:dsFilter==='DC'?'#fff':undefined,borderColor:dsFilter==='DC'?'#7C3AED':undefined}}>DC</button>
          )}
        </div>
        {!isNetworkDesignActive && (
          <div style={{display:"flex",gap:4,marginLeft:4}}>
            {[{v:45,l:"L45D"},{v:30,l:"L30D"},{v:15,l:"L15D"},{v:7,l:"L7D"}].map(p => (
              <button key={p.v} onClick={() => setPeriod(p.v)} style={S.btn(period===p.v)}>{p.l}</button>
            ))}
          </div>
        )}
        {/* Brand stocking info inline — replaces separate card */}
        {isNetworkDesignActive && ndDsInfo && dsFilter !== 'DC' && (
          <span style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",fontSize:11,marginLeft:8}}>
            {ndDsInfo.stocked.length > 0 && (
              <span>
                <span style={{fontWeight:700,color:"#166534"}}>Stocked: </span>
                {ndDsInfo.stocked.map(({brand}) => (
                  <span key={brand} style={{color:"#166534",marginRight:6}}>● {brand}</span>
                ))}
              </span>
            )}
            {ndDsInfo.stocked.length > 0 && ndDsInfo.notStocked.length > 0 && (
              <span style={{color:HR.border}}>|</span>
            )}
            {ndDsInfo.notStocked.length > 0 && (
              <span>
                <span style={{fontWeight:700,color:"#92400E"}}>Fulfilled elsewhere: </span>
                {ndDsInfo.notStocked.map(({brand, fulfilledFrom}) => (
                  <span key={brand} style={{color:HR.muted,marginRight:8}}>
                    {brand} <span style={{color:"#92400E"}}>→ {fulfilledFrom}</span>
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
        {!isAdmin && <span style={{fontSize:10,color:HR.muted,marginLeft:"auto"}}>Configs are view-only · Admin login to edit</span>}
      </div>

      {isNetworkDesignActive && ndDsInfo && dsFilter !== 'DC'
        ? <NetworkDesignSummaryCards
            thickSkus={ndSkuStats.thick}
            thinSkus={ndSkuStats.thin}
            maxCap={effectiveNetCfg.maxCap || 20}
            minNZD={effectiveNetCfg.minNZD || 2}
          />
        : !isNetworkDesignActive
          ? <SummaryCards skuList={baseSkus} skuMaster={skuMaster} thickCfg={committedThickCfg || thickCfg} thinCfg={committedThinCfg || thinCfg} thickBoundaryMm={thickBoundaryMm}/>
          : null
      }

      {/* ── DS Physical Capacity — between summary cards and Thick/Thin sections ── */}
      {isNetworkDesignActive && dsFilter !== 'DC' && thickCfg && thinCfg && (
        <div style={{...S.card,marginBottom:12,padding:"9px 14px",display:"flex",gap:16,alignItems:"center",flexWrap:"wrap",fontSize:11}}>
          <span style={{fontWeight:700,color:"#555"}}>Physical Capacity at {dsFilter}</span>
          {isNetworkDesignActive && isAdmin && (
            <><span style={{color:HR.border}}>|</span>
            <label style={{fontSize:11,display:"flex",alignItems:"center",gap:4}}>
              Thick boundary
              <input type="number" value={thickBoundaryMm} min={1} max={30} step={1}
                onChange={e => handleSaveBoundary(parseFloat(e.target.value)||6)}
                style={{width:32,padding:"0 3px",fontSize:11,fontWeight:700,border:`1px solid #C05A00`,borderRadius:4,color:"#92400E",background:HR.white,textAlign:"center"}}/>
              mm
            </label></>
          )}
          <span style={{color:HR.border}}>|</span>
          {[{label:"Thick (sheets)",type:"thick",cfg:thickCfg,setCfg:setThickCfg},{label:"Thin (sheets)",type:"thin",cfg:thinCfg,setCfg:setThinCfg}].map(({label,type,cfg,setCfg},i) => (
            <span key={type} style={{display:"flex",alignItems:"center",gap:6}}>
              {i > 0 && <span style={{color:HR.border,marginRight:6}}>·</span>}
              <span style={{color:"#555"}}>{label}</span>
              <input type="number" min={1} max={2000} step={10}
                value={cfg.capacity ?? ''}
                disabled={!isAdmin}
                onChange={e => { const v = parseFloat(e.target.value)||0; setCfg(c=>({...c,capacity:v})); handleSaveConfig(type,{...cfg,capacity:v}); }}
                style={{...S.input,width:60,fontSize:11,opacity:isAdmin?1:0.7}}/>
            </span>
          ))}
        </div>
      )}

      {/* ── DC Tab ──────────────────────────────────────────────────────────── */}
      {isNetworkDesignActive && dsFilter === 'DC' && (() => {
        const dcCap = effectiveNetCfg.dcCapacity || { thick: 400, thin: 400 };
        const directBrands = Object.entries(effectiveNetCfg.brands || {}).filter(([,c]) => c.nodes.DC).map(([b,c]) => ({ brand:b, covers:c.nodes.DC.covers }));
        const replenishBrands = Object.keys(effectiveNetCfg.brands || {}).filter(b => !effectiveNetCfg.brands[b].nodes.DC);
        return (
          <div>
            {/* DC brand status + capacity in one card */}
            <div style={{...S.card,marginBottom:12,padding:"10px 14px",display:"flex",gap:24,flexWrap:"wrap",alignItems:"flex-start"}}>
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
              {/* DC Capacity — same card, right-aligned */}
              <div style={{marginLeft:"auto"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#555",marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>Physical Capacity</div>
                {[{label:"Thick (sheets)",key:"dcCapacity.thick"},{label:"Thin (sheets)",key:"dcCapacity.thin"}].map(({label,key}) => (
                  <label key={key} style={{fontSize:11,display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    {label}
                    <input type="number" min={1} max={2000} step={10}
                      value={(localNetCfg||effectiveNetCfg).dcCapacity?.[key.split('.')[1]] ?? ""}
                      disabled={!isAdmin}
                      onChange={e => handleNetCfgChange(key, Number(e.target.value))}
                      style={{...S.input,width:70,opacity:isAdmin?1:0.7}}/>
                  </label>
                ))}
                {netCfgDirty && isAdmin && (
                  <button onClick={saveNetCfg} style={{fontSize:10,color:"#7C3AED",background:"none",border:"1px solid #7C3AED",borderRadius:4,padding:"2px 8px",cursor:"pointer",marginTop:2}}>
                    Save
                  </button>
                )}
              </div>
            </div>
            {/* DC Thick */}
            <div style={{marginBottom:24}}>
              <div style={S.sectionTitle}>DC Thick SKUs — Vertical Storage</div>
              <CapacityBar used={dcSkuStats.thick.reduce((s,x)=>s+x.maxQty,0)} total={dcCap.thick} label="DC Vertical Storage Capacity" cfg={null}/>
              <div style={S.card}>
                <NetworkDesignSKUTable skus={dcSkuStats.thick} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }} showNZD={false} isDC={true}/>
              </div>
            </div>
            {/* DC Thin */}
            <div style={{marginBottom:24}}>
              <div style={S.sectionTitle}>DC Thin SKUs — Tub Storage</div>
              <CapacityBar used={dcSkuStats.thin.reduce((s,x)=>s+x.maxQty,0)} total={dcCap.thin} label="DC Tub Storage Capacity" cfg={null}/>
              <div style={S.card}>
                <NetworkDesignSKUTable skus={dcSkuStats.thin} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }} showNZD={false} isDC={true}/>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Thick section */}
      {/* Thick section — PCT mode only; heading + boundary moved to capacity card in ND mode */}
      {dsFilter !== 'DC' && !isNetworkDesignActive && <div style={{marginBottom:24}}>
        <div style={{...S.sectionTitle,display:"flex",alignItems:"center",gap:6}}>
          Thick SKUs — Vertical Storage: Greater than
          <input type="number" value={thickBoundaryMm} disabled={!isAdmin} min={1} max={30} step={1}
            onChange={e => handleSaveBoundary(parseFloat(e.target.value) || 6)}
            onFocus={e => e.target.select()}
            onKeyDown={e => { if (e.key === 'Enter' && boundaryDirty) { const freshBase = computePlywoodSKUs(invoiceData, skuMaster, dsFilter, period, invoiceDateRange, thickBoundaryMm); runBothSections(freshBase); } }}
            style={{width:40,padding:"0 4px",fontSize:12,fontWeight:700,border:`1px solid #C05A00`,borderRadius:4,color:"#92400E",background:isAdmin?HR.white:HR.surfaceLight,textAlign:"center"}}
          />
          mm {!isAdmin && <span style={{fontSize:9,color:HR.muted,fontWeight:400}}>(admin to edit)</span>}
        </div>
        {(
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

      {/* Thin section — PCT mode only; ND mode uses unified table below */}
      {dsFilter !== 'DC' && !isNetworkDesignActive && <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thin SKUs — Tub Storage: Up to {thickBoundaryMm}mm</div>
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

      {/* ── Network Design unified Thick+Thin table ─────────────────────────── */}
      {isNetworkDesignActive && dsFilter !== 'DC' && ndDsInfo?.stocked.length > 0 && (
        <div style={{...S.card,padding:12,marginBottom:24}}>
          <NetworkDesignUnifiedTable
            thickSkus={ndSkuStats.thick}
            thinSkus={ndSkuStats.thin}
            thickCap={thickCfg?.capacity || 150}
            thinCap={thinCfg?.capacity || 60}
            onSelectSku={s => { setSelectedSku(s); setSelectedSkuType(s.thicknessCat === 'Thick' ? 'thick' : 'thin'); }}
          />
        </div>
      )}

      {selectedSku && (
        isNetworkDesignActive && selectedSku.trace
          ? <NetworkDesignSKUModal sku={selectedSku} onClose={() => setSelectedSku(null)} invoiceDateRange={invoiceDateRange}/>
          : <SKUModal sku={selectedSku} cfg={selectedSkuType === "thick" ? thickCfg : thinCfg} onClose={() => setSelectedSku(null)} invoiceDateRange={invoiceDateRange}/>
      )}
    </div>
  );
}
