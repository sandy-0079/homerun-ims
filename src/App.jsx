import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { loadFromSupabase, saveToSupabase } from "./supabase";

import {
  ROLLING_DAYS, DS_LIST, MOVEMENT_TIERS_DEFAULT,
  DC_MULT_DEFAULT, DC_DEAD_MULT_DEFAULT, RECENCY_WT_DEFAULT,
  BASE_MIN_DAYS_DEFAULT, DEFAULT_BRAND_BUFFER, DEFAULT_PARAMS,
  runEngine,
  parseCSV, getPriceTag,
} from "./engine/index.js";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";

const HR = {
  yellow:"#F5C400",yellowDark:"#D4A800",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",textSoft:"#444438",green:"#2D7A3A",
};
const DS_COLORS = [
  {bg:"#FFFBEA",header:"#B8860B",text:"#7A5800"},
  {bg:"#EDFFF3",header:"#1D6B30",text:"#0F4020"},
  {bg:"#FFF4EC",header:"#C05A00",text:"#7A3800"},
  {bg:"#F5EEFF",header:"#7A3DBF",text:"#4A1A8A"},
  {bg:"#FFF0F6",header:"#B5006A",text:"#7A0040"},
];
const DC_COLOR = {bg:"#EAF9FF",header:"#0077A8",text:"#004D70"};
const MOV_COLORS = {"Super Fast":"#16a34a","Fast":"#2D7A3A","Moderate":"#B8860B","Slow":"#C05A00","Super Slow":"#C0392B"};
const PRICE_TAG_COLORS = {
  "Premium":{bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
  "High":{bg:"#FFEDD5",color:"#C2410C",border:"#FED7AA"},
  "Medium":{bg:"#FEF9C3",color:"#A16207",border:"#FDE68A"},
  "Low":{bg:"#F1F5F9",color:"#475569",border:"#CBD5E1"},
  "Super Low":{bg:"#F8FAFC",color:"#64748B",border:"#E2E8F0"},
  "No Price":{bg:"#F8FAFC",color:"#94A3B8",border:"#E2E8F0"},
};
const TOPN_TAG_COLORS = {
  "T50":{bg:"#DCFCE7",color:"#15803D",border:"#BBF7D0"},
  "T150":{bg:"#D1FAE5",color:"#065F46",border:"#A7F3D0"},
  "T250":{bg:"#CFFAFE",color:"#0E7490",border:"#A5F3FC"},
  "No":{bg:"#F1F5F9",color:"#475569",border:"#CBD5E1"},
  "Zero Sale":{bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
};
const TOPN_DISPLAY = { "T50":"Top 50","T150":"Top 150","T250":"Top 250","No":"Not Top","Zero Sale":"Zero Sale" };

const LS = {
  get:(key)=>{try{const v=localStorage.getItem(key);return v?{value:v}:null;}catch{return null;}},
  set:(key,value)=>{try{localStorage.setItem(key,value);return true;}catch{return null;}},
  delete:(key)=>{try{localStorage.removeItem(key);return true;}catch{return null;}},
};
function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const TAG_STYLE = {padding:"1px 5px",borderRadius:3,fontSize:8,fontWeight:700,whiteSpace:"nowrap",lineHeight:"14px",display:"inline-block"};

const TagPill=React.memo(({value,colorMap})=>{
  const raw=colorMap[value]||{bg:"#F1F5F9",color:"#64748B",border:"#CBD5E1"};
  const displayVal=colorMap===TOPN_TAG_COLORS?(TOPN_DISPLAY[value]||value):value;
  return <span style={{...TAG_STYLE,background:raw.bg,color:raw.color,border:`1px solid ${raw.border}`}}>{displayVal||"—"}</span>;
});

const MovTag=React.memo(({value})=>{
  const color=MOV_COLORS[value]||"#64748b",bg=color+"18";
  return <span style={{...TAG_STYLE,background:bg,color,border:`1px solid ${color}33`}}>{value||"—"}</span>;
});

const S={
  app:{fontFamily:"Inter,sans-serif",background:HR.bg,height:"100vh",color:HR.text,width:"100%",boxSizing:"border-box",overflowX:"hidden",display:"flex",flexDirection:"column"},
  header:{background:HR.white,borderBottom:`2px solid ${HR.yellow}`,padding:"0 16px",display:"flex",alignItems:"center",gap:6,height:44,boxShadow:"0 1px 4px rgba(0,0,0,0.08)",flexShrink:0,flexWrap:"nowrap",overflowX:"auto"},
  card:{background:HR.surface,borderRadius:8,padding:12,border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:11},
  th:{padding:"6px 8px",textAlign:"left",color:HR.muted,background:HR.surfaceLight,fontWeight:600,fontSize:10,whiteSpace:"nowrap"},
  td:{padding:"4px 8px",borderTop:`1px solid ${HR.border}`},
  btn:(on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,transition:"all 0.15s",whiteSpace:"nowrap",outline:"none",flexShrink:0}),
  input:{background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"5px 10px",color:HR.text,fontSize:12},
  runBtn:{background:HR.yellow,color:HR.black,border:"none",padding:"10px 24px",borderRadius:8,cursor:"pointer",fontWeight:700,fontSize:13,width:"100%"},
  pageWrap:{flex:1,overflowY:"auto",overflowX:"hidden",padding:"16px 20px"},
};

/* Old dashboard frozen column width constants removed */

/* Old dashboard frozenTh/frozenTd helpers removed */

const LOGIC_TAG_STYLES={
  "Base Logic":     {bg:"#DCFCE7",color:"#15803D",border:"#BBF7D0"},
  "New DS Floor":   {bg:"#DBEAFE",color:"#1D4ED8",border:"#BFDBFE"},
  "SKU Floor":      {bg:"#EDE9FE",color:"#6D28D9",border:"#C4B5FD"},
  "Brand Buffer":   {bg:"#FEF3C7",color:"#92400E",border:"#FDE68A"},
  "Manual Override":{bg:"#FFFBEA",color:"#B8860B",border:"#F5C400"},
};

const LogicTag=({value})=>{
  const ts=LOGIC_TAG_STYLES[value]||LOGIC_TAG_STYLES["Base Logic"];
  return(
    <span style={{padding:"1px 5px",borderRadius:3,fontSize:8,fontWeight:700,
      background:ts.bg,color:ts.color,border:`1px solid ${ts.border}`,
      whiteSpace:"nowrap",display:"inline-block",lineHeight:"14px"}}>
      {value}
    </span>
  );
};

/* DSCols component removed — was only used by old Dashboard tab */

const Section=({title,icon,summary,children,accent="#B8860B"})=>{
  const [open,setOpen]=useState(false);
  return(
    <div style={{marginBottom:10,borderRadius:8,overflow:"hidden",border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.03)"}}>
      <div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:HR.surface,cursor:"pointer",borderLeft:`3px solid ${accent}`,userSelect:"none"}} onMouseEnter={e=>e.currentTarget.style.background=HR.surfaceLight} onMouseLeave={e=>e.currentTarget.style.background=HR.surface}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:15}}>{icon}</span>
          <span style={{fontWeight:700,color:HR.text,fontSize:13}}>{title}</span>
          {!open&&<span style={{fontSize:11,color:HR.muted,marginLeft:4}}>{summary}</span>}
        </div>
        <span style={{color:HR.muted,fontSize:15,display:"inline-block",transform:open?"rotate(90deg)":"rotate(0deg)",transition:"transform 0.15s"}}>{`›`}</span>
      </div>
      {open&&<div style={{padding:"16px",background:HR.bg,borderTop:`1px solid ${HR.border}`}}>{children}</div>}
    </div>
  );
};

function NumInput({value,min,max,step=1,onChange,disabled,style={}}){
  const [local,setLocal]=useState(String(value));
  const ref=useRef(null);
  useEffect(()=>{if(document.activeElement!==ref.current)setLocal(String(value));},[value]);
  const commit=v=>{
    let n=parseFloat(v);
    if(isNaN(n))return;
    if(min!==undefined)n=Math.max(min,n);
    if(max!==undefined)n=Math.min(max,n);
    onChange(n);
    setLocal(String(n));
  };
  return(
    <input ref={ref} type="number" min={min} max={max} step={step} value={local} disabled={disabled}
      onChange={e=>setLocal(e.target.value)} onBlur={e=>commit(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")commit(e.target.value);}}
      style={{...S.input,textAlign:"center",...style,opacity:disabled?0.5:1,cursor:disabled?"not-allowed":"text"}}
    />
  );
}

function TierSlider({label,value,min,max,step=1,onChange,color,disabled}){
  const [local,setLocal]=useState(value);
  useEffect(()=>setLocal(value),[value]);
  return(
    <div style={{marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
        <span style={{fontSize:12,color:HR.muted}}>{label}</span>
        <span style={{fontSize:13,fontWeight:700,color:color||HR.yellowDark,minWidth:32,textAlign:"right"}}>{local}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={local} disabled={disabled}
        onChange={e=>{const v=parseFloat(e.target.value);setLocal(v);onChange(v);}}
        style={{width:"100%",accentColor:color||HR.yellow,opacity:disabled?0.4:1,cursor:disabled?"not-allowed":"pointer"}}
      />
    </div>
  );
}


const HomeRunLogo=()=>(
  <div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{background:HR.yellow,borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
      <svg width="16" height="20" viewBox="0 0 18 26" fill="none"><path d="M11 1L2 15h7l-2 10L16 11H9L11 1z" fill="#1A1A1A"/></svg>
    </div>
    <div>
      <div style={{fontWeight:800,fontSize:14,color:HR.black,letterSpacing:"-0.2px",lineHeight:1.2}}>HomeRun</div>
      <div style={{fontSize:10,color:HR.muted,fontWeight:500,lineHeight:1.2}}>Inventory Management System</div>
    </div>
  </div>
);

const StatStrip=({items})=>(
  <div style={{display:"grid",gridTemplateColumns:`repeat(${items.length},1fr)`,gap:10,marginBottom:16}}>
    {items.map(c=>(
      <div key={c.label} style={{background:HR.surface,borderRadius:8,padding:"12px 14px",border:`1px solid ${HR.border}`}}>
        <div style={{fontSize:20,fontWeight:800,color:c.color||HR.yellowDark}}>{c.value}</div>
        <div style={{fontSize:11,color:HR.muted,marginTop:2}}>{c.label}</div>
      </div>
    ))}
  </div>
);
/* MovDistBar removed — unused */
/* ── Recharts-based chart components ──────────────────────────────────── */
const SingleFreqChart = ({ freq, color, minVal, maxVal }) => {
  let entries = Object.entries(freq).map(([q, c]) => ({ qty: parseFloat(q), count: c })).sort((a, b) => a.qty - b.qty);
  if (!entries.length) return <div style={{ color: HR.muted, fontSize: 11, padding: 20, textAlign: "center" }}>No order data</div>;
  const col = color || HR.yellowDark;
  // Add min/max as zero-count entries if not present, so ReferenceLine x= can find them
  [minVal, maxVal].forEach(v => {
    if (v != null && !entries.find(e => e.qty === v)) entries.push({ qty: v, count: 0 });
  });
  entries.sort((a, b) => a.qty - b.qty);
  const sameMinMax = minVal != null && maxVal != null && minVal === maxVal;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={entries} margin={{top:5, right:10, left:0, bottom:5}}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E8E8D8" />
        <XAxis dataKey="qty" tick={{fontSize:10, fill:"#666"}} />
        <YAxis tick={{fontSize:10, fill:"#666"}} allowDecimals={false} />
        <Tooltip formatter={(value, name, props) => [`${value} orders of qty ${props.payload.qty}`, null]} labelFormatter={() => ""} />
        <Bar dataKey="count" fill={col} radius={[2,2,0,0]} maxBarSize={40} isAnimationActive={false} />
        {sameMinMax && <ReferenceLine x={minVal} stroke="#C0392B" strokeDasharray="5 3" label={{value:`Min=Max=${minVal}`, fill:"#C0392B", fontSize:9, fontWeight:700, position:"insideTopRight"}} />}
        {!sameMinMax && minVal != null && <ReferenceLine x={minVal} stroke="#C0392B" strokeDasharray="5 3" label={{value:`Min ${minVal}`, fill:"#C0392B", fontSize:9, fontWeight:700, position:"insideTopRight"}} />}
        {!sameMinMax && maxVal != null && <ReferenceLine x={maxVal} stroke="#2D7A3A" strokeDasharray="5 3" label={{value:`Max ${maxVal}`, fill:"#2D7A3A", fontSize:9, fontWeight:700, position:"insideTopLeft"}} />}
      </BarChart>
    </ResponsiveContainer>
  );
};
/* Old InsightsTab and sub-components (OrgLevel, CategoryLevel, BrandLevel, SKULevel) removed — replaced by SKUDetailTab */

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function fmtInr(val) {
  const abs = Math.abs(val);
  if (abs >= 100000) return `₹${(val / 100000).toFixed(1)}L`;
  if (abs >= 1000)   return `₹${(val / 1000).toFixed(1)}K`;
  return `₹${val}`;
}
const oosColor = pct =>
  parseFloat(pct) >= 30 ? "#B91C1C" :
  parseFloat(pct) >= 15 ? "#C05A00" :
  parseFloat(pct) >= 5  ? "#A16207" : HR.green;

function parseOverrideCSV(text) {
  try {
    const rows = parseCSV(text);
    const overrides = {};
    rows.forEach(r => {
      const sku = (r["SKU"] || "").trim();
      const ds  = (r["DS"]  || "").trim();
      if (!sku || !ds) return;
      const rawMin = r["New Min"] !== undefined ? r["New Min"].trim() : "";
      const rawMax = r["New Max"] !== undefined ? r["New Max"].trim() : "";
      const parsedMin = rawMin === "" ? null : parseFloat(rawMin);
      const parsedMax = rawMax === "" ? null : parseFloat(rawMax);
      if (parsedMin === null && parsedMax === null) return;
      if (!overrides[sku]) overrides[sku] = {};
      overrides[sku][ds] = {
        min: (parsedMin !== null && !isNaN(parsedMin)) ? parsedMin : null,
        max: (parsedMax !== null && !isNaN(parsedMax)) ? parsedMax : null,
      };
    });
    return overrides;
  } catch { return {}; }
}

function runSim(invoiceData, results, overrides, simDays = 15) {
  if (!invoiceData.length || !results) return [];
  const allDates = [...new Set(invoiceData.map(r => r.date))].sort();
  const simDates = allDates.slice(-simDays);
  if (!simDates.length) return [];
  const simDateSet = new Set(simDates);
  const simIndex = {};
  invoiceData.forEach(r => {
  if (!simDateSet.has(r.date)) return;
  const k = `${r.sku}||${r.ds}`;
  if (!simIndex[k]) simIndex[k] = [];
  simIndex[k].push(r);
});
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
          const fulfilled   = Math.min(line.qty, stock);
          const shortQty    = line.qty - fulfilled;
          const oos         = shortQty > 0;
          if (oos) { oosInstances++; shortQtys.push(shortQty); }
          stock = Math.max(0, stock - line.qty);
          const isLastOfDay  = li === dayLines.length - 1;
          const replenished  = isLastOfDay && stock <= useMin;
          orderLog.push({ date: line.date, qty: line.qty, stockBefore, fulfilled, shortQty, oos, stockAfter: stock, replenished });
          if (replenished) stock = useMax;
        });
      });
      if (oosInstances > 0 || isOverridden) {
        out.push({
          skuId, dsId,
          name:      res.meta.name      || skuId,
          category:  res.meta.category  || "Unknown",
          brand:     res.meta.brand     || "Unknown",
          priceTag:  res.meta.priceTag  || "—",
          mvTag:     res.stores[dsId]?.mvTag || "—",
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

function calcInvValueDelta(simRows, priceData) {
  return Math.round(
    simRows.filter(r => r.isOverridden)
      .reduce((sum, r) => sum + (r.useMax - r.toolMax) * (priceData?.[r.skuId] || 0), 0)
  );
}

function downloadWhatIfCSV(toolRows) {
  const rows = toolRows.filter(r => r.oosInstances > 0).map(r => ({
    "Item Name":    r.name,
    "Category":     r.category,
    "Brand":        r.brand,
    "SKU":          r.skuId,
    "DS":           r.dsId,
    "Tool Min":     r.useMin,
    "Tool Max":     r.useMax,
    "OOS Instances":r.oosInstances,
    "Median Short": r.medianShort,
    "Max Short":    r.maxShort,
    "New Min":      "",
    "New Max":      "",
  }));
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(","),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      return typeof v === "string" && v.includes(",") ? `"${v}"` : (v ?? "");
    }).join(","))
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "WhatIf_Sim_Input.csv";
  a.click();
}

const TAG_SIM = { padding: "1px 6px", borderRadius: 3, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", lineHeight: "16px", display: "inline-block" };
const MovTag2 = ({ v }) => {
  const c = MOV_COLORS[v] || "#64748b";
  return <span style={{ ...TAG_SIM, background: c + "18", color: c, border: `1px solid ${c}33` }}>{v || "—"}</span>;
};
const DSBadgeSim = ({ ds }) => {
  const di = DS_LIST.indexOf(ds), dc = DS_COLORS[di >= 0 ? di : 0];
  return <span style={{ ...TAG_SIM, background: dc.bg, color: dc.header, border: `1px solid ${dc.header}55` }}>{ds}</span>;
};

function SimSummaryCards({ toolRows, ovrRows, ovrRowsFull, totInst, totSkus, hasOverrides, priceData }) {
  const toolOos  = toolRows.reduce((s, r) => s + r.oosInstances, 0);
  const ovrOos   = ovrRows.reduce((s,  r) => s + r.oosInstances, 0);
  const toolFail = new Set(toolRows.filter(r => r.oosInstances > 0).map(r => r.skuId)).size;
  const ovrFail  = new Set(ovrRows.filter(r  => r.oosInstances > 0).map(r => r.skuId)).size;
  const toolRate = totInst > 0 ? ((toolOos / totInst) * 100).toFixed(1) : "0.0";
  const ovrRate  = totInst > 0 ? ((ovrOos  / totInst) * 100).toFixed(1) : "0.0";
  const tAcc = oosColor(toolRate), oAcc = oosColor(ovrRate);
  const rateDelta = (parseFloat(ovrRate) - parseFloat(toolRate)).toFixed(1);
  const invDelta = calcInvValueDelta(ovrRowsFull, priceData);
  return (
    <div style={{ display: "grid", gridTemplateColumns: hasOverrides ? "1fr 1fr 1fr 1fr" : "1fr 1fr", gap: 10, marginBottom: 16 }}>
      <div style={{ background: "#FFF", borderRadius: 8, padding: "12px 14px", border: `1px solid ${tAcc}44`, borderLeft: `4px solid ${tAcc}` }}>
        <div style={{ fontSize: 9, color: HR.muted, fontWeight: 600, marginBottom: 2 }}>OOS RATE {hasOverrides ? "(TOOL)" : ""}</div>
        <div style={{ fontSize: 28, fontWeight: 900, color: tAcc }}>{toolRate}%</div>
        <div style={{ fontSize: 10, color: HR.muted, marginTop: 2 }}>{toolOos} OOS / {totInst} total</div>
      </div>
      <div style={{ background: "#FFF", borderRadius: 8, padding: "12px 14px", border: "1px solid #C05A0044", borderLeft: "4px solid #C05A00" }}>
        <div style={{ fontSize: 9, color: HR.muted, fontWeight: 600, marginBottom: 2 }}>FAILING SKUs {hasOverrides ? "(TOOL)" : ""}</div>
        <div style={{ fontSize: 28, fontWeight: 900, color: "#B91C1C" }}>
          {toolFail}<span style={{ fontSize: 13, opacity: 0.5, marginLeft: 4 }}>/ {totSkus}</span>
        </div>
        <div style={{ fontSize: 10, color: HR.muted, marginTop: 2 }}>
          {totSkus > 0 ? ((toolFail / totSkus) * 100).toFixed(1) : "0.0"}% of ordered SKUs
        </div>
      </div>
      {hasOverrides && (
        <>
          <div style={{ background: "#FFFBEA", borderRadius: 8, padding: "12px 14px", border: `2px solid ${HR.yellow}`, borderLeft: `4px solid ${oAcc}` }}>
            <div style={{ fontSize: 9, color: HR.yellowDark, fontWeight: 700, marginBottom: 2 }}>✏ OOS RATE (OVERRIDE)</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: oAcc }}>{ovrRate}%</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 10, color: HR.muted }}>{ovrOos} OOS / {totInst} total</span>
              {rateDelta !== "0.0" && (
                <span style={{ fontSize: 11, fontWeight: 800, color: parseFloat(rateDelta) < 0 ? HR.green : "#B91C1C" }}>
                  {parseFloat(rateDelta) > 0 ? "+" : ""}{rateDelta}%
                </span>
              )}
            </div>
          </div>
          <div style={{ background: "#FFFBEA", borderRadius: 8, padding: "12px 14px", border: `2px solid ${HR.yellow}`, borderLeft: `4px solid ${invDelta >= 0 ? "#C05A00" : HR.green}` }}>
            <div style={{ fontSize: 9, color: HR.yellowDark, fontWeight: 700, marginBottom: 2 }}>✏ INV VALUE DELTA (OVERRIDE)</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: invDelta >= 0 ? "#C05A00" : HR.green }}>
              {invDelta >= 0 ? "+" : ""}{fmtInr(invDelta)}
            </div>
            <div style={{ fontSize: 10, color: HR.muted, marginTop: 2 }}>
              {invDelta >= 0 ? "additional inventory cost" : "inventory cost saving"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function buildGroupRows(toolRows, ovrRows, winRows, groupFn, priceData) {
  // ── Step 1: Total instances per group from ALL sim-window rows (winRows)
  //    This is the same pool that produces the header's "6000 total" figure.
  const ordMap = {};
  winRows.forEach(r => {
    const g = groupFn(r, "ord");
    if (!g) return;
    if (!ordMap[g]) ordMap[g] = { skus: new Set(), instances: 0 };
    ordMap[g].skus.add(r.sku);
    ordMap[g].instances++;
  });

  // ── Step 2: OOS counts from toolRows (OOS-only SKUs — correct, unchanged)
  const toolMap = {};
  toolRows.filter(r => r.oosInstances > 0).forEach(r => {
    const g = groupFn(r, "fail");
    if (!g) return;
    if (!toolMap[g]) toolMap[g] = { skus: new Set(), oosInstances: 0 };
    toolMap[g].skus.add(r.skuId);
    toolMap[g].oosInstances += r.oosInstances;
  });

  // ── Step 3: Override OOS counts (unchanged)
  const ovrMap = {};
  ovrRows.forEach(r => {
    const g = groupFn(r, "fail");
    if (!g) return;
    if (!ovrMap[g]) ovrMap[g] = { skus: new Set(), oosInstances: 0, invDelta: 0 };
    if (r.oosInstances > 0) ovrMap[g].skus.add(r.skuId);
    ovrMap[g].oosInstances += r.oosInstances;
    if (r.isOverridden)
      ovrMap[g].invDelta += (r.useMax - r.toolMax) * (priceData?.[r.skuId] || 0);
  });

  // ── Step 4: Union of ALL groups that appear in winRows (so zero-OOS
  //    categories/brands are included and their full instance count shows).
  const allKeys = new Set(Object.keys(ordMap));
  // Also include any OOS groups not in winRows (edge case safety)
  Object.keys(toolMap).forEach(k => allKeys.add(k));

  return [...allKeys].map(g => {
    const o  = ordMap[g]  || { skus: new Set(), instances: 0 };
    const t  = toolMap[g] || { skus: new Set(), oosInstances: 0 };
    const ov = ovrMap[g]  || { skus: new Set(), oosInstances: 0, invDelta: 0 };
    return {
      name:             g,
      failSkus:         t.skus.size,
      ovrFailSkus:      ov.skus.size,
      totalOrderedSkus: o.skus.size,
      toolOos:          t.oosInstances,
      ovrOos:           ov.oosInstances,
      // ← Key fix: totalInstances now comes from ALL winRows for this group
      totalInstances:   o.instances,
      invDelta:         Math.round(ov.invDelta),
    };
  // ← No longer filtering out zero-OOS rows; keep all for rate comparison
  }).sort((a, b) => b.toolOos - a.toolOos);
}

function RankTable({ rows, nameLabel, nameKey, onClick, hasOverrides }) {
  const [sort, setSort] = useState({ col: "toolOos", dir: "desc" });
  const toggle = col => setSort(s => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  const arrow  = col => sort.col === col ? (sort.dir === "desc" ? " ▼" : " ▲") : " ↕";
  const sorted = useMemo(() => {
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (typeof av === "string") return dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
      return dir === "desc" ? bv - av : av - bv;
    });
  }, [rows, sort]);
  const thS = col => ({
    padding: "8px 10px", textAlign: col === nameKey ? "left" : "center",
    color: sort.col === col ? HR.yellowDark : HR.muted,
    background: sort.col === col ? "#FFFBEA" : HR.surfaceLight,
    fontWeight: 600, whiteSpace: "nowrap", fontSize: 10, cursor: "pointer", userSelect: "none",
  });
  const td = { padding: "6px 10px", borderTop: "1px solid #E0E0D0", verticalAlign: "middle" };
  const ovBg = "#FFFDE7";
  return (
    <div style={{ background: "#FFF", borderRadius: 8, border: "1px solid #E0E0D0", overflow: "hidden", marginBottom: 16 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr>
            <th style={thS(nameKey)}        onClick={() => toggle(nameKey)}>{nameLabel}{arrow(nameKey)}</th>
            <th style={thS("failSkus")}     onClick={() => toggle("failSkus")}>Failing SKUs (Tool){arrow("failSkus")}</th>
            <th style={thS("totalOrderedSkus")} onClick={() => toggle("totalOrderedSkus")}>% of SKUs{arrow("totalOrderedSkus")}</th>
            <th style={thS("toolOos")}      onClick={() => toggle("toolOos")}>OOS Inst (Tool){arrow("toolOos")}</th>
            {hasOverrides && <th style={{ ...thS("ovrOos"), background: "#FFFBEA" }} onClick={() => toggle("ovrOos")}>OOS Inst (Ovr){arrow("ovrOos")}</th>}
            <th style={thS("totalInstances")} onClick={() => toggle("totalInstances")}>Total Inst{arrow("totalInstances")}</th>
            <th style={thS("toolRate")}     onClick={() => toggle("toolRate")}>OOS Rate (Tool){arrow("toolRate")}</th>
            {hasOverrides && <th style={{ ...thS("ovrRate"), background: "#FFFBEA" }} onClick={() => toggle("ovrRate")}>OOS Rate (Ovr){arrow("ovrRate")}</th>}
            {hasOverrides && <th style={{ ...thS("invDelta"), background: "#FFFBEA" }} onClick={() => toggle("invDelta")}>Inv Value Δ{arrow("invDelta")}</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const toolRate = r.totalInstances > 0 ? ((r.toolOos / r.totalInstances) * 100).toFixed(1) : "0.0";
            const ovrRate  = r.totalInstances > 0 ? ((r.ovrOos  / r.totalInstances) * 100).toFixed(1) : "0.0";
            const pctSkus  = r.totalOrderedSkus > 0 ? ((r.failSkus / r.totalOrderedSkus) * 100).toFixed(1) : "0.0";
            const tAcc = oosColor(toolRate), oAcc = oosColor(ovrRate);
            const oosDelta  = r.ovrOos - r.toolOos;
            const rateDelta = (parseFloat(ovrRate) - parseFloat(toolRate)).toFixed(1);
            const bg = i % 2 === 0 ? HR.white : HR.surfaceLight;
            return (
              <tr key={r[nameKey]} style={{ background: bg, cursor: "pointer" }}
                onClick={() => onClick(r[nameKey])}
                onMouseEnter={e => e.currentTarget.style.background = "#FFFBEA"}
                onMouseLeave={e  => e.currentTarget.style.background = bg}>
                <td style={{ ...td, fontWeight: 700, color: HR.text }}>{r[nameKey]} <span style={{ fontSize: 10, color: HR.yellowDark }}>→</span></td>
                <td style={{ ...td, textAlign: "center", color: "#B91C1C", fontWeight: 700 }}>{r.failSkus}</td>
                <td style={{ ...td, textAlign: "center", color: HR.muted, fontWeight: 600 }}>{pctSkus}%</td>
                <td style={{ ...td, textAlign: "center", color: "#B91C1C", fontWeight: 700 }}>{r.toolOos}</td>
                {hasOverrides && (
                  <td style={{ ...td, textAlign: "center", background: ovBg }}>
                    <span style={{ fontWeight: 700, color: "#B91C1C" }}>{r.ovrOos}</span>
                    {oosDelta !== 0 && <span style={{ fontSize: 9, color: oosDelta < 0 ? HR.green : "#B91C1C", marginLeft: 4, fontWeight: 700 }}>{oosDelta > 0 ? "+" : ""}{oosDelta}</span>}
                  </td>
                )}
                <td style={{ ...td, textAlign: "center", color: HR.muted }}>{r.totalInstances}</td>
                <td style={{ ...td, textAlign: "center" }}>
                  <span style={{ background: tAcc + "18", color: tAcc, border: `1px solid ${tAcc}33`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>{toolRate}%</span>
                </td>
                {hasOverrides && (
                  <td style={{ ...td, textAlign: "center", background: ovBg }}>
                    <span style={{ background: oAcc + "18", color: oAcc, border: `1px solid ${oAcc}33`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>{ovrRate}%</span>
                    {rateDelta !== "0.0" && <span style={{ fontSize: 9, color: parseFloat(rateDelta) < 0 ? HR.green : "#B91C1C", marginLeft: 4, fontWeight: 700 }}>{parseFloat(rateDelta) > 0 ? "+" : ""}{rateDelta}%</span>}
                  </td>
                )}
                {hasOverrides && (
                  <td style={{ ...td, textAlign: "center", background: ovBg }}>
                    <span style={{ fontWeight: 700, fontSize: 11, color: r.invDelta >= 0 ? "#C05A00" : HR.green }}>{r.invDelta >= 0 ? "+" : ""}{fmtInr(r.invDelta)}</span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DayStrip2 = ({ orderLog, allDates }) => {
  const byDate = {};
  orderLog.forEach(o => {
    if (!byDate[o.date]) byDate[o.date] = { oos: 0, ok: 0 };
    if (o.oos) byDate[o.date].oos++; else byDate[o.date].ok++;
  });
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {allDates.map(date => {
        const d = byDate[date];
        const bg = !d ? HR.border : d.oos > 0 && d.ok === 0 ? "#B91C1C" : d.oos > 0 ? "#F59E0B" : "#16a34a";
        return <div key={date} title={date} style={{ width: 8, height: 14, borderRadius: 2, background: bg }} />;
      })}
    </div>
  );
};

function OrderTable({ r }) {
  const days = [];
  let cur = null;
  r.orderLog.forEach(o => {
    if (!cur || cur.date !== o.date) { cur = { date: o.date, orders: [] }; days.push(cur); }
    cur.orders.push(o);
  });
  const di = DS_LIST.indexOf(r.dsId), dc = DS_COLORS[di >= 0 ? di : 0];
  return (
    <div style={{ padding: "12px 16px", background: "#FFFBEA", borderTop: `2px solid ${HR.yellow}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: HR.yellowDark, marginBottom: 8 }}>Order-by-order — {r.name} @ {r.dsId}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr style={{ background: "#FFF9E0" }}>
              {["Date","Order #","Stock Before","Order Qty","Fulfilled","Short Qty","Stock After","Replenished?","Status"].map(h =>
                <th key={h} style={{ padding: "6px 8px", textAlign: "left", color: HR.muted, fontWeight: 600, fontSize: 9, whiteSpace: "nowrap" }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {days.map(day => [
              <tr key={day.date + "_hdr"}>
                <td colSpan={9} style={{ padding: "4px 10px", background: dc.bg, borderTop: `1px solid ${dc.header}33`, fontWeight: 700, fontSize: 10, color: dc.header }}>{day.date}</td>
              </tr>,
              ...day.orders.map((o, oi) => (
                <tr key={day.date + "_" + oi} style={{ background: o.oos ? "#FEE2E2" : o.replenished && oi === day.orders.length - 1 ? "#F0FDF4" : HR.white }}>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", color: HR.muted, fontSize: 9 }}>{day.date}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center", color: HR.muted }}>{oi + 1}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center" }}>{o.stockBefore}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center", fontWeight: 700 }}>{o.qty}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center", color: "#15803D", fontWeight: o.fulfilled > 0 ? 700 : 400 }}>{o.fulfilled || "—"}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center", color: "#B91C1C", fontWeight: 700 }}>{o.shortQty > 0 ? o.shortQty : "—"}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center", color: o.stockAfter === 0 ? "#B91C1C" : HR.text, fontWeight: o.stockAfter === 0 ? 700 : 400 }}>{o.stockAfter}</td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center" }}>
                    {o.replenished && oi === day.orders.length - 1 ? <span style={{ color: "#16a34a", fontWeight: 700 }}>↑ Max</span> : "—"}
                  </td>
                  <td style={{ padding: "4px 8px", borderTop: "1px solid #E0E0D0", textAlign: "center" }}>
                    {o.oos
                      ? <span style={{ ...TAG_SIM, background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA" }}>OOS</span>
                      : <span style={{ ...TAG_SIM, background: "#DCFCE7", color: "#15803D", border: "1px solid #BBF7D0" }}>OK</span>}
                  </td>
                </tr>
              ))
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SimSKUTable({ toolRows, ovrRows, allDates, hasOverrides, priceData, toolRowsFull, winRows }) {
  const [expSKU, setExpSKU] = useState(null);
  const [expDS,  setExpDS]  = useState(null);
  const ovBg = "#FFFDE7";
  const ovrMap = useMemo(() => {
    const m = {};
    ovrRows.forEach(r => { m[`${r.skuId}||${r.dsId}`] = r; });
    return m;
  }, [ovrRows]);
  const fullInstMap = useMemo(() => {
  const m = {};
  (winRows || []).forEach(r => {
    if (!m[r.sku]) m[r.sku] = 0;
    m[r.sku]++;
  });
  return m;
}, [winRows]);
const winRowsBySkuDs = useMemo(() => {
  const m = {};
  (winRows || []).forEach(r => {
    const k = `${r.sku}||${r.ds}`;
    if (!m[k]) m[k] = 0;
    m[k]++;
  });
  return m;
}, [winRows]);
const bySKU = useMemo(() => {
    const m = {};
    toolRows.forEach(r => {
      if (!m[r.skuId]) m[r.skuId] = { skuId: r.skuId, name: r.name, category: r.category, brand: r.brand, priceTag: r.priceTag, mvTag: r.mvTag, dsRows: [] };
      const ovrRow = ovrMap[`${r.skuId}||${r.dsId}`] || r;
      m[r.skuId].dsRows.push({ tool: r, ovr: ovrRow });
    });
    Object.values(m).forEach(s => s.dsRows.sort((a, b) => b.tool.oosInstances - a.tool.oosInstances));
    return Object.values(m).sort((a, b) => {
      const aT = a.dsRows.reduce((s, p) => s + p.tool.oosInstances, 0);
      const bT = b.dsRows.reduce((s, p) => s + p.tool.oosInstances, 0);
      return bT - aT;
    });
  }, [toolRows, ovrMap]);
  const th = (extra = {}) => ({ padding: "8px 10px", textAlign: "left", color: HR.muted, background: HR.surfaceLight, fontWeight: 600, whiteSpace: "nowrap", fontSize: 10, ...extra });
  const td = (extra = {}) => ({ padding: "6px 10px", borderTop: "1px solid #E0E0D0", verticalAlign: "middle", ...extra });
  return (
    <div style={{ background: "#FFF", borderRadius: 8, border: "1px solid #E0E0D0", overflow: "auto", maxHeight: "72vh" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
          <tr style={{ background: HR.surfaceLight }}>
            <th style={th({ minWidth: 200 })}>SKU</th>
            <th style={th()}>Category</th>
            <th style={th()}>Movement</th>
            <th style={th()}>Price</th>
            <th style={th({ textAlign: "center" })}>Failing DS{hasOverrides ? " (Tool)" : ""}</th>
            {hasOverrides && <th style={th({ textAlign: "center", background: ovBg })}>Failing DS (Ovr)</th>}
            <th style={th({ textAlign: "center" })}>OOS Inst{hasOverrides ? " (Tool)" : ""}</th>
            {hasOverrides && <th style={th({ textAlign: "center", background: ovBg })}>OOS Inst (Ovr)</th>}
            <th style={th({ textAlign: "center" })}>Total Inst</th>
            <th style={th({ textAlign: "center" })}>OOS Rate{hasOverrides ? " (Tool)" : ""}</th>
            {hasOverrides && <th style={th({ textAlign: "center", background: ovBg })}>OOS Rate (Ovr)</th>}
            {hasOverrides && <th style={th({ textAlign: "center", background: ovBg })}>Inv Value Δ</th>}
            <th style={th({ width: 28 })} />
          </tr>
        </thead>
        <tbody>
          {bySKU.map((sku, i) => {
            const isOpen = expSKU === sku.skuId;
            const toolOos = sku.dsRows.reduce((s, p) => s + p.tool.oosInstances, 0);
            const ovrOos  = sku.dsRows.reduce((s, p) => s + p.ovr.oosInstances,  0);
            const totInst = fullInstMap[sku.skuId] || sku.dsRows.reduce((s, p) => s + p.tool.totalInstances, 0);
            const toolRate = totInst > 0 ? ((toolOos / totInst) * 100).toFixed(1) : "0.0";
            const ovrRate  = totInst > 0 ? ((ovrOos  / totInst) * 100).toFixed(1) : "0.0";
            const tAcc = oosColor(toolRate), oAcc = oosColor(ovrRate);
            const hasAnyOverride = sku.dsRows.some(p => p.ovr.isOverridden);
            const skuInvDelta = Math.round(sku.dsRows.filter(p => p.ovr.isOverridden).reduce((s, p) => s + (p.ovr.useMax - p.ovr.toolMax) * (priceData?.[sku.skuId] || 0), 0));
            const toolFailDS = sku.dsRows.filter(p => p.tool.oosInstances > 0).map(p => p.tool.dsId);
            const ovrFailDS  = sku.dsRows.filter(p => p.ovr.oosInstances  > 0).map(p => p.ovr.dsId);
            const rowBg = isOpen ? "#FFFBEA" : hasAnyOverride ? ovBg : i % 2 === 0 ? HR.white : HR.surfaceLight;
            return [
              <tr key={sku.skuId}
                style={{ background: rowBg, cursor: "pointer", borderLeft: hasAnyOverride ? `3px solid ${HR.yellow}` : "3px solid transparent" }}
                onClick={() => { setExpSKU(p => p === sku.skuId ? null : sku.skuId); setExpDS(null); }}
                onMouseEnter={e => e.currentTarget.style.background = "#FFFBEA"}
                onMouseLeave={e  => e.currentTarget.style.background = rowBg}>
                <td style={td()}>
                  <div style={{ fontWeight: 700, color: HR.text, fontSize: 11 }}>{sku.name}</div>
                  <div style={{ fontSize: 9, color: HR.muted, marginTop: 1 }}>{sku.skuId}</div>
                  {hasAnyOverride && <span style={{ ...TAG_SIM, background: "#FFFBEA", color: HR.yellowDark, border: `1px solid ${HR.yellow}`, marginTop: 2 }}>overridden</span>}
                </td>
                <td style={{ ...td(), color: HR.muted, fontSize: 10 }}>{sku.category}</td>
                <td style={td()}><MovTag2 v={sku.mvTag} /></td>
                <td style={td()}>{(() => { const c = PRICE_TAG_COLORS[sku.priceTag] || { bg: "#F1F5F9", color: "#64748B", border: "#CBD5E1" }; return <span style={{ ...TAG_SIM, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{sku.priceTag || "—"}</span>; })()}</td>
                <td style={{ ...td(), textAlign: "center" }}>
                  <div style={{ display: "flex", gap: 3, justifyContent: "center", flexWrap: "wrap" }}>
                    {toolFailDS.length ? toolFailDS.map(ds => <DSBadgeSim key={ds} ds={ds} />) : <span style={{ color: HR.muted, fontSize: 10 }}>—</span>}
                  </div>
                </td>
                {hasOverrides && (
                  <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                    <div style={{ display: "flex", gap: 3, justifyContent: "center", flexWrap: "wrap" }}>
                      {ovrFailDS.length ? ovrFailDS.map(ds => <DSBadgeSim key={ds} ds={ds} />) : <span style={{ color: HR.green, fontSize: 10, fontWeight: 700 }}>None ✓</span>}
                    </div>
                  </td>
                )}
                <td style={{ ...td(), textAlign: "center", color: "#B91C1C", fontWeight: 700 }}>{toolOos}</td>
                {hasOverrides && (
                  <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                    <span style={{ fontWeight: 700, color: "#B91C1C" }}>{ovrOos}</span>
                    {ovrOos !== toolOos && <span style={{ fontSize: 9, color: ovrOos < toolOos ? HR.green : "#B91C1C", marginLeft: 4, fontWeight: 700 }}>{ovrOos - toolOos > 0 ? "+" : ""}{ovrOos - toolOos}</span>}
                  </td>
                )}
                <td style={{ ...td(), textAlign: "center", color: HR.muted }}>{totInst}</td>
                <td style={{ ...td(), textAlign: "center" }}>
                  <span style={{ background: tAcc + "18", color: tAcc, border: `1px solid ${tAcc}33`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>{toolRate}%</span>
                </td>
                {hasOverrides && (
                  <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                    <span style={{ background: oAcc + "18", color: oAcc, border: `1px solid ${oAcc}33`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>{ovrRate}%</span>
                    {ovrRate !== toolRate && <span style={{ fontSize: 9, color: parseFloat(ovrRate) < parseFloat(toolRate) ? HR.green : "#B91C1C", marginLeft: 4, fontWeight: 700 }}>{(parseFloat(ovrRate) - parseFloat(toolRate)) > 0 ? "+" : ""}{(parseFloat(ovrRate) - parseFloat(toolRate)).toFixed(1)}%</span>}
                  </td>
                )}
                {hasOverrides && (
                  <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                    <span style={{ fontWeight: 700, color: skuInvDelta >= 0 ? "#C05A00" : HR.green, fontSize: 11 }}>{skuInvDelta >= 0 ? "+" : ""}{fmtInr(skuInvDelta)}</span>
                  </td>
                )}
                <td style={{ ...td(), textAlign: "center", color: HR.muted, fontSize: 12, fontWeight: 700, userSelect: "none" }}>{isOpen ? "▲" : "▶"}</td>
              </tr>,
              isOpen && sku.dsRows.map(({ tool: r, ovr: ovrR }) => {
                const dsKey    = `${r.skuId}||${r.dsId}`;
                const isDSOpen = expDS === dsKey;
                const di = DS_LIST.indexOf(r.dsId), dc = DS_COLORS[di >= 0 ? di : 0];
                const dsToolRate = r.totalInstances  > 0 ? ((r.oosInstances  / r.totalInstances) * 100).toFixed(1) : "0.0";
                const dsOvrRate  = ovrR.totalInstances > 0 ? ((ovrR.oosInstances / ovrR.totalInstances) * 100).toFixed(1) : "0.0";
                const dsTAcc = oosColor(dsToolRate), dsOAcc = oosColor(dsOvrRate);
                const isOvr = ovrR.isOverridden;
                const dsInvDelta = isOvr ? Math.round((ovrR.useMax - ovrR.toolMax) * (priceData?.[r.skuId] || 0)) : 0;
                const dsBg = isDSOpen ? "#EDF9FF" : isOvr ? ovBg : dc.bg;
                return [
                  <tr key={dsKey}
                    style={{ background: dsBg, cursor: "pointer", borderLeft: isOvr ? `3px solid ${HR.yellow}` : `3px solid ${dc.header}` }}
                    onClick={e => { e.stopPropagation(); setExpDS(p => p === dsKey ? null : dsKey); }}
                    onMouseEnter={e => e.currentTarget.style.background = "#EDF9FF"}
                    onMouseLeave={e  => e.currentTarget.style.background = dsBg}>
                    <td style={{ ...td(), paddingLeft: 28 }} colSpan={4}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <DSBadgeSim ds={r.dsId} />
                        {isOvr ? (
                          <>
                            <span style={{ fontSize: 9, color: HR.muted }}>Min/Max: {r.toolMin}/{r.toolMax}</span>
                            <span style={{ fontSize: 9, color: HR.yellowDark, fontWeight: 700 }}>→ {ovrR.useMin}/{ovrR.useMax}</span>
                            <span style={{ ...TAG_SIM, background: "#FFFBEA", color: HR.yellowDark, border: `1px solid ${HR.yellow}`, fontSize: 9 }}>✏ overridden</span>
                          </>
                        ) : (
                          <span style={{ fontSize: 9, color: HR.muted }}>Min {r.useMin} · Max {r.useMax}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...td(), textAlign: "center" }} colSpan={hasOverrides ? 2 : 1}>
                      <DayStrip2 orderLog={r.orderLog} allDates={allDates} />
                    </td>
                    <td style={{ ...td(), textAlign: "center", color: "#B91C1C", fontWeight: 700 }}>{r.oosInstances}</td>
                    {hasOverrides && (
                      <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                        <span style={{ fontWeight: 700, color: "#B91C1C" }}>{ovrR.oosInstances}</span>
                        {ovrR.oosInstances !== r.oosInstances && <span style={{ fontSize: 9, color: ovrR.oosInstances < r.oosInstances ? HR.green : "#B91C1C", marginLeft: 4, fontWeight: 700 }}>{ovrR.oosInstances - r.oosInstances > 0 ? "+" : ""}{ovrR.oosInstances - r.oosInstances}</span>}
                      </td>
                    )}
                    <td style={{ ...td(), textAlign: "center", color: HR.muted }}>{r.totalInstances}</td>
                    <td style={{ ...td(), textAlign: "center" }}>
                      <span style={{ background: dsTAcc + "18", color: dsTAcc, border: `1px solid ${dsTAcc}33`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>{dsToolRate}%</span>
                    </td>
                    {hasOverrides && (
                      <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                        <span style={{ background: dsOAcc + "18", color: dsOAcc, border: `1px solid ${dsOAcc}33`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 800 }}>{dsOvrRate}%</span>
                        {dsOvrRate !== dsToolRate && <span style={{ fontSize: 9, color: parseFloat(dsOvrRate) < parseFloat(dsToolRate) ? HR.green : "#B91C1C", marginLeft: 4, fontWeight: 700 }}>{(parseFloat(dsOvrRate) - parseFloat(dsToolRate)) > 0 ? "+" : ""}{(parseFloat(dsOvrRate) - parseFloat(dsToolRate)).toFixed(1)}%</span>}
                      </td>
                    )}
                    {hasOverrides && (
                      <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                        {isOvr ? <span style={{ fontWeight: 700, color: dsInvDelta >= 0 ? "#C05A00" : HR.green, fontSize: 11 }}>{dsInvDelta >= 0 ? "+" : ""}{fmtInr(dsInvDelta)}</span> : <span style={{ color: HR.muted }}>—</span>}
                      </td>
                    )}
                    <td style={{ ...td(), textAlign: "center", color: HR.muted, fontSize: 11, fontWeight: 700, userSelect: "none" }}>{isDSOpen ? "▲" : "▼"}</td>
                  </tr>,
                  isDSOpen && (
                    <tr key={dsKey + "_ord"}>
                      <td colSpan={hasOverrides ? 12 : 9} style={{ padding: 0, borderTop: `2px solid ${HR.yellow}` }}>
                        <OrderTable r={r} />
                      </td>
                    </tr>
                  )
        ];
      }),
      isOpen && (() => {
        const oosDs = new Set(sku.dsRows.map(p => p.tool.dsId));
        const cleanDS = DS_LIST.filter(ds => !oosDs.has(ds));
        const cleanInst = cleanDS.reduce((s, ds) => s + (winRowsBySkuDs[`${sku.skuId}||${ds}`] || 0), 0);
        if (!cleanInst) return null;
        return (
          <tr key={sku.skuId + "_clean"}>
            <td colSpan={hasOverrides ? 13 : 10} style={{ padding: "4px 16px", background: "#F8FAFC", borderTop: `1px solid ${HR.border}` }}>
              <span style={{ fontSize: 10, color: HR.muted }}>
                {cleanDS.filter(ds => (winRowsBySkuDs[`${sku.skuId}||${ds}`] || 0) > 0).join(", ")}
                {" · "}{cleanInst} instance{cleanInst !== 1 ? "s" : ""} · <span style={{ color: HR.green, fontWeight: 700 }}>no OOS ✓</span>
              </span>
            </td>
          </tr>
        );
      })()
    ];
  })}
        </tbody>
      </table>
    </div>
  );
}

function ProblematicSKUs({ toolRows, ovrRows, allDates, hasOverrides, priceData, toolRowsFull, winRows }) {
  const [topN, setTopN] = useState(10);
  const bySKU = useMemo(() => {
    const m = {};
    toolRows.forEach(r => {
      if (!m[r.skuId]) m[r.skuId] = { skuId: r.skuId, name: r.name, toolOos: 0 };
      m[r.skuId].toolOos += r.oosInstances;
    });
    return Object.values(m).filter(s => s.toolOos > 0).sort((a, b) => b.toolOos - a.toolOos);
  }, [toolRows]);
  if (!bySKU.length) return null;
  const visible    = topN === "All" ? bySKU : bySKU.slice(0, topN);
  const visibleIds = new Set(visible.map(s => s.skuId));
  const visTool    = toolRows.filter(r => visibleIds.has(r.skuId) && r.oosInstances > 0);
  const visOvr     = ovrRows.filter(r  => visibleIds.has(r.skuId));
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: HR.text }}>
          🚨 Problematic SKUs
          <span style={{ fontSize: 10, color: HR.muted, fontWeight: 400, marginLeft: 6 }}>sorted by OOS Instances · click to expand</span>
        </div>
        <div style={{ display: "flex", gap: 0, border: `1px solid ${HR.border}`, borderRadius: 4, overflow: "hidden" }}>
          {[10, 20, "All"].map(n => (
            <button key={n} onClick={() => setTopN(n)}
              style={{ padding: "4px 10px", fontSize: 10, fontWeight: 700, border: "none", cursor: "pointer", background: topN === n ? HR.yellow : HR.white, color: topN === n ? HR.black : HR.muted, borderRight: `1px solid ${HR.border}` }}>
              Top {n}
            </button>
          ))}
        </div>
      </div>
      <SimSKUTable toolRows={visTool} ovrRows={visOvr} allDates={[]} hasOverrides={hasOverrides} priceData={priceData} toolRowsFull={toolRowsFull} winRows={winRows} />
      {topN !== "All" && bySKU.length > topN && (
        <div style={{ fontSize: 10, color: HR.muted, textAlign: "center", marginTop: 6 }}>Showing {topN} of {bySKU.length} problematic SKUs</div>
      )}
    </div>
  );
}

function OverriddenSKUsSection({ ovrRowsFull, priceData, results }) {
  const manualRows = useMemo(() => ovrRowsFull.filter(r => r.isOverridden), [ovrRowsFull]);
  if (!manualRows.length) return null;
  const ovBg = "#FFFDE7";
  const totalDelta = manualRows.reduce((sum, r) => sum + (r.useMax - r.toolMax) * (priceData?.[r.skuId] || 0), 0);
  const th = (extra = {}) => ({ padding: "8px 10px", textAlign: "left", color: HR.muted, background: HR.surfaceLight, fontWeight: 600, whiteSpace: "nowrap", fontSize: 10, ...extra });
  const td = (extra = {}) => ({ padding: "6px 10px", borderTop: "1px solid #E0E0D0", verticalAlign: "middle", ...extra });
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: HR.yellowDark }}>✏ Overridden SKUs</div>
        {totalDelta !== 0 && (
          <div style={{ fontSize: 12, fontWeight: 700, color: totalDelta >= 0 ? "#C05A00" : HR.green, background: "#FFFBEA", border: `1px solid ${HR.yellow}`, borderRadius: 4, padding: "3px 10px" }}>
            Total Inv Delta: {totalDelta >= 0 ? "+" : ""}{fmtInr(Math.round(totalDelta))}
          </div>
        )}
      </div>
      <div style={{ background: "#FFF", borderRadius: 8, border: "1px solid #E0E0D0", overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: HR.surfaceLight }}>
              <th style={th({ minWidth: 200 })}>SKU</th><th style={th()}>Category</th><th style={th()}>Brand</th>
              <th style={th()}>Movement</th><th style={th()}>Price</th><th style={th({ textAlign: "center" })}>DS</th>
              <th style={th({ textAlign: "center" })}>Tool Min</th><th style={th({ textAlign: "center" })}>Tool Max</th>
              <th style={th({ textAlign: "center", background: ovBg })}>Override Min</th>
              <th style={th({ textAlign: "center", background: ovBg })}>Override Max</th>
              <th style={th({ textAlign: "center", background: ovBg })}>Inv Delta</th>
            </tr>
          </thead>
          <tbody>
            {manualRows.map((r, i) => {
              const price = priceData?.[r.skuId] || 0;
              const delta = Math.round((r.useMax - r.toolMax) * price);
              const di = DS_LIST.indexOf(r.dsId), dc = DS_COLORS[di >= 0 ? di : 0];
              const mvColor = MOV_COLORS[r.mvTag] || "#64748b";
              const priceC  = PRICE_TAG_COLORS[r.priceTag] || { bg: "#F1F5F9", color: "#64748B", border: "#CBD5E1" };
              return (
                <tr key={`${r.skuId}||${r.dsId}`} style={{ background: i % 2 === 0 ? HR.white : HR.surfaceLight }}>
                  <td style={td()}><div style={{ fontWeight: 700, color: HR.text, fontSize: 11 }}>{r.name}</div><div style={{ fontSize: 9, color: HR.muted }}>{r.skuId}</div></td>
                  <td style={{ ...td(), color: HR.muted, fontSize: 10 }}>{r.category}</td>
                  <td style={{ ...td(), color: HR.muted, fontSize: 10 }}>{r.brand}</td>
                  <td style={td()}><span style={{ ...TAG_SIM, background: mvColor + "18", color: mvColor, border: `1px solid ${mvColor}33` }}>{r.mvTag}</span></td>
                  <td style={td()}><span style={{ ...TAG_SIM, background: priceC.bg, color: priceC.color, border: `1px solid ${priceC.border}` }}>{r.priceTag}</span></td>
                  <td style={{ ...td(), textAlign: "center" }}><DSBadgeSim ds={r.dsId} /></td>
                  <td style={{ ...td(), textAlign: "center", color: HR.muted }}>{r.toolMin}</td>
                  <td style={{ ...td(), textAlign: "center", color: HR.muted }}>{r.toolMax}</td>
                  <td style={{ ...td(), textAlign: "center", background: ovBg, fontWeight: 700, color: HR.yellowDark }}>{r.useMin}</td>
                  <td style={{ ...td(), textAlign: "center", background: ovBg, fontWeight: 700, color: HR.yellowDark }}>{r.useMax}</td>
                  <td style={{ ...td(), textAlign: "center", background: ovBg }}>
                    {price > 0 ? <span style={{ fontWeight: 700, color: delta >= 0 ? "#C05A00" : HR.green }}>{delta >= 0 ? "+" : ""}{fmtInr(delta)}</span> : <span style={{ color: HR.muted }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WhatIfUploadPanel({ onUpload, hasOverrides, onReset, overrideCount }) {
  const fileRef = useRef(null);
  const handleFile = async file => {
    if (!file) return;
    const text = await file.text();
    const overrides = parseOverrideCSV(text);
    const count = Object.values(overrides).reduce((s, ds) => s + Object.keys(ds).length, 0);
    if (!count) { alert("No valid overrides found. Make sure 'New Min' or 'New Max' columns are filled."); return; }
    onUpload(overrides, count);
  };
  return (
    <div style={{ background: HR.surface, border: `1px dashed ${hasOverrides ? HR.yellow : HR.border}`, borderRadius: 8, padding: "14px 18px", marginBottom: 14 }}>
      <div style={{ fontWeight: 700, color: HR.text, fontSize: 13, marginBottom: 4 }}>🔬 What-If Simulation</div>
      <div style={{ fontSize: 12, color: HR.muted, marginBottom: 10 }}>
        Download the OOS CSV, fill in your custom <strong>New Min / New Max</strong> for any SKU×DS rows, then re-upload to compare Tool vs Override side-by-side.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => fileRef.current?.click()}
          style={{ background: HR.yellow, color: HR.black, border: "none", padding: "7px 16px", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12 }}>
          ⬆ Upload Edited CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }}
          onChange={e => { handleFile(e.target.files[0]); e.target.value = ""; }} />
        {hasOverrides && (
          <>
            <button onClick={onReset}
              style={{ background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA", padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12 }}>
              ↩ Reset to Tool Logic
            </button>
            <span style={{ fontSize: 11, color: HR.yellowDark, fontWeight: 700, background: "#FFFBEA", border: `1px solid ${HR.yellow}`, padding: "3px 10px", borderRadius: 4 }}>
              {overrideCount} override{overrideCount !== 1 ? "s" : ""} active
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function SimOrgLevel({ toolRows, ovrRows, ovrRowsFull, winRows, skuMeta, hasOverrides, priceData, totInst, totSkus, onDrillCategory, toolRowsFull }) {
  const groupRows = buildGroupRows(toolRows, ovrRows, winRows, (r, mode) => mode === "ord" ? (skuMeta[r.sku]?.category || "Unknown") : (r.category || "Unknown"), priceData);
  return (
    <div>
      <SimSummaryCards toolRows={toolRows} ovrRows={ovrRows} ovrRowsFull={ovrRowsFull} totInst={totInst} totSkus={totSkus} hasOverrides={hasOverrides} priceData={priceData} />
      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 8 }}>Categories</div>
      <RankTable rows={groupRows} nameLabel="Category" nameKey="name" onClick={onDrillCategory} hasOverrides={hasOverrides} />
      <ProblematicSKUs toolRows={toolRows} ovrRows={ovrRows} allDates={[]} hasOverrides={hasOverrides} priceData={priceData} toolRowsFull={toolRowsFull} winRows={winRows} />
      <OverriddenSKUsSection ovrRowsFull={ovrRowsFull} priceData={priceData} />
    </div>
  );
}

function SimCategoryLevel({ toolRows, ovrRows, ovrRowsFull, winRows, skuMeta, category, hasOverrides, priceData, totInst, totSkus, allDates, onDrillBrand }) {
  const tScope = toolRows.filter(r => (r.category || "Unknown") === category);
  const oScope = ovrRows.filter(r  => (r.category || "Unknown") === category);
  const wScope = winRows.filter(r  => (skuMeta[r.sku]?.category || "Unknown") === category);
  const oScopeFull = ovrRowsFull.filter(r => (r.category || "Unknown") === category);
  const groupRows = buildGroupRows(tScope, oScope, wScope, (r, mode) => mode === "ord" ? (skuMeta[r.sku]?.brand || "Unknown") : (r.brand || "Unknown"), priceData);
  return (
    <div>
      <SimSummaryCards toolRows={tScope} ovrRows={oScope} ovrRowsFull={oScopeFull} totInst={wScope.length} totSkus={new Set(wScope.map(r => r.sku)).size} hasOverrides={hasOverrides} priceData={priceData} />
      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 8 }}>Brands in <span style={{ color: HR.yellowDark }}>{category}</span></div>
      <RankTable rows={groupRows} nameLabel="Brand" nameKey="name" onClick={onDrillBrand} hasOverrides={hasOverrides} />
    </div>
  );
}

function SimBrandLevel({ toolRows, ovrRows, ovrRowsFull, winRows, skuMeta, category, brand, hasOverrides, priceData, allDates, toolRowsFull }) {
  const tScope = toolRows.filter(r => (r.category || "Unknown") === category && (r.brand || "Unknown") === brand);
  const oScope = ovrRows.filter(r  => (r.category || "Unknown") === category && (r.brand || "Unknown") === brand);
  const wScope = winRows.filter(r  => (skuMeta[r.sku]?.category || "Unknown") === category && (skuMeta[r.sku]?.brand || "Unknown") === brand);
  const oScopeFull = ovrRowsFull.filter(r => (r.category || "Unknown") === category && (r.brand || "Unknown") === brand);
  return (
    <div>
      <SimSummaryCards toolRows={tScope} ovrRows={oScope} ovrRowsFull={oScopeFull} totInst={wScope.length} totSkus={new Set(wScope.map(r => r.sku)).size} hasOverrides={hasOverrides} priceData={priceData} />
      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 8 }}>Failing SKUs — <span style={{ color: HR.yellowDark }}>{brand}</span><span style={{ color: HR.muted, fontWeight: 400 }}> · {category}</span></div>
      <SimSKUTable toolRows={tScope} ovrRows={oScope} allDates={allDates} hasOverrides={hasOverrides} priceData={priceData} toolRowsFull={toolRowsFull} winRows={wScope} />
    </div>
  );
}

function SimulationTab({ invoiceData, results, skuMaster, params, priceData, onApplyToCore, simOverrides, setSimOverrides, simOverrideCount, setSimOverrideCount, simResults, setSimResults, simLoading, setSimLoading, simDays, setSimDays }) {
  const [drill, setDrill] = useState(null);
  const [dsFilter, setDsFilter] = useState("All");
  const overrides = simOverrides;
  const setOverrides = setSimOverrides;
  const overrideCount = simOverrideCount;
  const setOverrideCount = setSimOverrideCount;
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [showApplyPwModal, setShowApplyPwModal] = useState(false);
  const [applyPw, setApplyPw] = useState("");
  const [applyPwErr, setApplyPwErr] = useState(false);
  const [simDaysInput, setSimDaysInput] = useState("15");
  const ADMIN_PW = import.meta.env.VITE_ADMIN_PASSWORD || "";
  const hasOverrides = overrideCount > 0;

  // ── All hooks must come before any early returns ──
  const handleApplyPwSubmit = () => {
    if (applyPw === ADMIN_PW && ADMIN_PW !== "") {
      setShowApplyPwModal(false);
      setApplyPw("");
      setApplyPwErr(false);
      setShowApplyConfirm(true);
    } else {
      setApplyPwErr(true);
      setApplyPw("");
    }
  };

  const handleApplyToCore = () => {
    const payload = {};
    Object.entries(overrides).forEach(([sku, dsList]) => {
      Object.entries(dsList).forEach(([ds, ov]) => {
        const toolMin = results[sku]?.stores[ds]?.min ?? 0;
        const toolMax = results[sku]?.stores[ds]?.max ?? 0;
        if (!payload[sku]) payload[sku] = {};
        payload[sku][ds] = {
          min: ov.min !== null ? ov.min : toolMin,
          max: ov.max !== null ? ov.max : toolMax,
          toolMin, toolMax,
          appliedAt: new Date().toISOString(),
          skuName: results[sku]?.meta?.name || sku,
          category: results[sku]?.meta?.category || "",
          brand: results[sku]?.meta?.brand || "",
          mvTag: results[sku]?.stores[ds]?.mvTag || "—",
          priceTag: results[sku]?.meta?.priceTag || "—",
        };
      });
    });
    onApplyToCore(payload);
    setOverrides({});
    setOverrideCount(0);
    setDrill(null);
    setShowApplyConfirm(false);
  };

  const allDates = useMemo(() => [...new Set(invoiceData.map(r => r.date))].sort().slice(-simDays), [invoiceData, simDays]);
  const skuMeta  = useMemo(() => {
    const m = {};
    Object.values(results || {}).forEach(r => { m[r.meta.sku] = r.meta; });
    return m;
  }, [results]);

  useEffect(() => {
    if (!invoiceData.length || !results) return;
    setSimLoading(true);
    setSimResults({ tool: [], ovr: [] });
    const worker = new Worker(
  new URL("./simWorker.js", import.meta.url)
);
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

  const toolRowsFull = simResults.tool;
  const ovrRowsFull  = simResults.ovr;

  const toolRows = useMemo(() => toolRowsFull.filter(r => r.oosInstances > 0), [toolRowsFull]);
  const ovrRows  = useMemo(() => {
    const toolKeys = new Set(toolRows.map(r => `${r.skuId}||${r.dsId}`));
    return ovrRowsFull.filter(r => r.oosInstances > 0 || toolKeys.has(`${r.skuId}||${r.dsId}`));
  }, [toolRows, ovrRowsFull]);

  const toolRowsView = useMemo(() => simLoading ? [] : dsFilter === "All" ? toolRows : toolRows.filter(r => r.dsId === dsFilter), [toolRows, dsFilter, simLoading]);
  const ovrRowsView  = useMemo(() => simLoading ? [] : dsFilter === "All" ? ovrRows  : ovrRows.filter(r => r.dsId === dsFilter),  [ovrRows,  dsFilter, simLoading]);
  const inv          = useMemo(() => dsFilter === "All" ? invoiceData : invoiceData.filter(r => r.ds === dsFilter), [invoiceData, dsFilter]);
  const winRows      = useMemo(() => simLoading ? [] : inv.filter(r => allDates.includes(r.date)), [inv, allDates, simLoading]);
  const totInst      = winRows.length;
  const totSkus      = useMemo(() => simLoading ? 0 : new Set(winRows.map(r => r.sku)).size, [winRows, simLoading]);

  const handleDSFilter = ds => { setDsFilter(ds); setDrill(null); };
  const handleUpload   = (ov, cnt) => { setOverrides(ov); setOverrideCount(cnt); setDrill(null); };
  const handleReset    = () => { setOverrides({}); setOverrideCount(0); setDrill(null); };

  // ── Early returns AFTER all hooks ──
  if (!invoiceData.length || !results) return (
  <div style={{ textAlign: "center", padding: 80 }}>
    <div style={{ fontSize: 40, marginBottom: 12 }}>⚡</div>
    <div style={{ color: HR.yellowDark, fontWeight: 700, fontSize: 14 }}>Loading data...</div>
    <div style={{ color: HR.muted, fontSize: 12, marginTop: 4 }}>Please wait a moment</div>
  </div>
);

  if (simLoading) return (
    <div style={{ textAlign: "center", padding: 80 }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>⚡</div>
      <div style={{ color: HR.yellowDark, fontWeight: 700, fontSize: 14 }}>Running Simulation...</div>
      <div style={{ color: HR.muted, fontSize: 12, marginTop: 4 }}>This takes a few seconds</div>
    </div>
  );

  // ── Heavy calculations only run after loading is done ──
  const toolOos  = toolRowsView.reduce((s, r) => s + r.oosInstances, 0);
  const ovrOos   = ovrRowsView.reduce((s, r) => s + r.oosInstances, 0);
  const toolRate = totInst > 0 ? ((toolOos / totInst) * 100).toFixed(1) : "0.0";
  const ovrRate  = totInst > 0 ? ((ovrOos  / totInst) * 100).toFixed(1) : "0.0";
  const tAcc     = oosColor(toolRate), oAcc = oosColor(ovrRate);
  const failSkus = new Set(toolRowsView.filter(r => r.oosInstances > 0).map(r => r.skuId)).size;

  const crumbs = [
    { label: "All Categories", onClick: drill ? () => setDrill(null) : null },
    ...(drill?.type === "category" || drill?.type === "brand"
      ? [{ label: drill.category || drill.value, onClick: drill.type !== "category" ? () => setDrill({ type: "category", value: drill.category, category: drill.category }) : null }]
      : []),
    ...(drill?.type === "brand" ? [{ label: drill.brand }] : []),
  ];

  return (
    <div>
      <div style={{ position: "sticky", top: -16, zIndex: 10, background: HR.bg, paddingTop: 4, paddingBottom: 8, marginBottom: 12, borderBottom: `1px solid ${HR.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, fontSize: 14, color: HR.yellowDark, whiteSpace: "nowrap" }}>OOS Simulation</span>
            <div style={{ display: "flex", alignItems: "center", gap: 0, border: `2px solid ${HR.yellow}`, borderRadius: 6, background: "#FFFBEA", overflow: "hidden", flexShrink: 0 }}>
              <span style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, color: HR.yellowDark, borderRight: `1px solid ${HR.yellow}`, whiteSpace: "nowrap" }}>Last</span>
              <input type="number" min={1} max={params.overallPeriod||90} value={simDaysInput} onFocus={e => e.target.select()}
                onChange={e => setSimDaysInput(e.target.value)}
                onBlur={e => { const mx=params.overallPeriod||90; const v=Math.min(mx,Math.max(1,parseInt(e.target.value)||15)); setSimDaysInput(String(v)); setSimDays(v); setDrill(null); }}
                onKeyDown={e => { if(e.key==="Enter"){ const mx=params.overallPeriod||90; const v=Math.min(mx,Math.max(1,parseInt(e.target.value)||15)); setSimDaysInput(String(v)); setSimDays(v); setDrill(null); e.target.blur(); }}}
                style={{ width: 38, border: "none", background: "transparent", fontSize: 13, fontWeight: 800, color: HR.yellowDark, textAlign: "center", outline: "none", padding: "3px 2px", MozAppearance: "textfield" }}
              />
              <span style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, color: HR.yellowDark, borderLeft: `1px solid ${HR.yellow}`, whiteSpace: "nowrap" }}>days <span style={{ fontSize: 9, fontWeight: 500, color: HR.muted }}>(max 90)</span></span>
              <button onClick={() => { const mx=params.overallPeriod||90; const v=Math.min(mx,Math.max(1,parseInt(simDaysInput)||15)); setSimDaysInput(String(v)); setSimDays(v); setDrill(null); }}
                style={{ padding:"0 10px", background:HR.yellow, color:HR.black, border:"none", fontWeight:700, fontSize:11, cursor:"pointer", alignSelf:"stretch" }}>▶ Run</button>
            </div>
            {allDates.length > 0 && <span style={{ fontSize: 10, color: HR.muted }}>{allDates[0]} → {allDates[allDates.length - 1]}</span>}
          </div>
          {hasOverrides && <span style={{ fontSize: 10, fontWeight: 700, color: HR.yellowDark, background: "#FFFBEA", border: `1px solid ${HR.yellow}`, borderRadius: 4, padding: "2px 8px" }}>✏ What-If Mode — {overrideCount} overrides</span>}
          <div style={{ display: "flex", gap: 0, border: `1px solid ${HR.border}`, borderRadius: 5, overflow: "hidden", flexShrink: 0 }}>
            {["All", ...DS_LIST].map(ds => {
              const di = DS_LIST.indexOf(ds), dc = di >= 0 ? DS_COLORS[di] : null, isActive = dsFilter === ds;
              return (
                <button key={ds} onClick={() => handleDSFilter(ds)}
                  style={{ padding: "4px 10px", background: isActive ? (dc ? dc.header : HR.yellow) : (dc ? dc.bg : HR.white), color: isActive ? (dc ? HR.white : HR.black) : (dc ? dc.header : HR.muted), border: "none", borderRight: `1px solid ${HR.border}`, cursor: "pointer", fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
                  {ds}
                </button>
              );
            })}
          </div>
          {showApplyPwModal && (
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
              <div style={{background:HR.white,padding:28,borderRadius:10,border:`2px solid ${HR.yellow}`,maxWidth:360,width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.15)"}}>
                <div style={{fontSize:16,fontWeight:800,color:HR.yellowDark,marginBottom:4}}>🔐 Admin Password Required</div>
                <div style={{fontSize:12,color:HR.muted,marginBottom:16}}>Applying overrides to core affects all users. Enter the admin password to continue.</div>
                <input type="password" value={applyPw} autoFocus onChange={e=>{setApplyPw(e.target.value);setApplyPwErr(false);}} onKeyDown={e=>e.key==="Enter"&&handleApplyPwSubmit()} placeholder="Password" style={{...S.input,width:"100%",boxSizing:"border-box",marginBottom:applyPwErr?6:14,borderColor:applyPwErr?"#B91C1C":HR.border}}/>
                {applyPwErr && <div style={{fontSize:11,color:"#B91C1C",marginBottom:10}}>Incorrect password. Try again.</div>}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={handleApplyPwSubmit} style={{flex:1,background:HR.yellow,color:HR.black,border:"none",padding:"9px",borderRadius:6,cursor:"pointer",fontWeight:700,fontSize:13}}>Continue</button>
                  <button onClick={()=>{setShowApplyPwModal(false);setApplyPw("");setApplyPwErr(false);}} style={{flex:1,background:HR.white,color:HR.muted,border:`1px solid ${HR.border}`,padding:"9px",borderRadius:6,cursor:"pointer",fontWeight:600,fontSize:13}}>Cancel</button>
                </div>
              </div>
            </div>
          )}
          {showApplyConfirm && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
              <div style={{ background: HR.white, padding: 28, borderRadius: 10, border: `2px solid ${HR.yellow}`, maxWidth: 400, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.15)" }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: HR.yellowDark, marginBottom: 8 }}>⚠ Apply Overrides to Core?</div>
                <div style={{ fontSize: 13, color: HR.text, marginBottom: 6 }}>This will update Min/Max values for <strong>{overrideCount} override{overrideCount !== 1 ? "s" : ""}</strong> across the entire tool.</div>
                <div style={{ fontSize: 12, color: HR.muted, marginBottom: 20 }}>Dashboard, Output, and all tabs will reflect the new values. The simulation sandbox will reset. This cannot be undone except from the Overrides tab.</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleApplyToCore} style={{ flex: 1, background: HR.yellow, color: HR.black, border: "none", padding: "10px", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 13 }}>✓ Apply to Core</button>
                  <button onClick={() => setShowApplyConfirm(false)} style={{ flex: 1, background: HR.white, color: HR.muted, border: `1px solid ${HR.border}`, padding: "10px", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Cancel</button>
                </div>
              </div>
            </div>
          )}
          {hasOverrides && (
            <button onClick={() => setShowApplyPwModal(true)} style={{ background: HR.yellowDark, color: HR.white, border: "none", padding: "5px 14px", borderRadius: 5, cursor: "pointer", fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>
              ✓ Apply Overrides to Core
            </button>
          )}
          <button onClick={() => downloadWhatIfCSV(toolRowsFull.filter(r => r.oosInstances > 0))}
            style={{ background: HR.green, color: HR.white, border: "none", padding: "5px 14px", borderRadius: 5, cursor: "pointer", fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>
            ⬇ Download What-If CSV
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ background: tAcc + "18", border: `1px solid ${tAcc}44`, borderRadius: 5, padding: "3px 10px", display: "flex", gap: 5, alignItems: "baseline" }}>
            <span style={{ fontWeight: 800, fontSize: 14, color: tAcc }}>{toolRate}%</span>
            <span style={{ fontSize: 10, color: tAcc, fontWeight: 600 }}>OOS {hasOverrides ? "(Tool)" : ""}</span>
          </div>
          {hasOverrides && (
            <div style={{ background: oAcc + "18", border: `2px solid ${HR.yellow}`, borderRadius: 5, padding: "3px 10px", display: "flex", gap: 5, alignItems: "baseline" }}>
              <span style={{ fontWeight: 800, fontSize: 14, color: oAcc }}>{ovrRate}%</span>
              <span style={{ fontSize: 10, color: HR.yellowDark, fontWeight: 700 }}>OOS (Override)</span>
              {toolRate !== ovrRate && <span style={{ fontSize: 11, fontWeight: 800, color: parseFloat(ovrRate) < parseFloat(toolRate) ? HR.green : "#B91C1C" }}>{(parseFloat(ovrRate) - parseFloat(toolRate)) > 0 ? "+" : ""}{(parseFloat(ovrRate) - parseFloat(toolRate)).toFixed(1)}%</span>}
            </div>
          )}
          <div style={{ background: HR.surface, border: `1px solid ${HR.border}`, borderRadius: 5, padding: "3px 10px", display: "flex", gap: 5, alignItems: "baseline" }}>
            <span style={{ fontWeight: 800, fontSize: 13, color: "#B91C1C" }}>{failSkus}</span>
            <span style={{ fontSize: 10, color: HR.muted }}>failing SKUs / {totSkus}</span>
          </div>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {i > 0 && <span style={{ color: HR.muted, fontSize: 11 }}>›</span>}
              <span onClick={c.onClick || undefined} style={{ fontSize: 11, color: c.onClick ? HR.yellowDark : HR.text, cursor: c.onClick ? "pointer" : "default", fontWeight: i === crumbs.length - 1 ? 700 : 400, textDecoration: c.onClick ? "underline" : "none" }}>{c.label}</span>
            </span>
          ))}
        </div>
      </div>

      <WhatIfUploadPanel onUpload={handleUpload} hasOverrides={hasOverrides} onReset={handleReset} overrideCount={overrideCount} />

      {toolRowsView.filter(r => r.oosInstances > 0).length === 0 && !hasOverrides ? (
        <div style={{ background: "#FFF", borderRadius: 8, padding: 40, textAlign: "center", border: "1px solid #E0E0D0" }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
          <div style={{ fontWeight: 700, color: HR.green, fontSize: 14 }}>No OOS instances detected</div>
          <div style={{ color: HR.muted, fontSize: 12, marginTop: 4 }}>Every order line was fulfilled in the last 15 days.</div>
        </div>
      ) : (
        <>
          {!drill && <SimOrgLevel toolRows={toolRowsView} ovrRows={ovrRowsView} ovrRowsFull={ovrRowsFull} winRows={winRows} skuMeta={skuMeta} hasOverrides={hasOverrides} priceData={priceData} totInst={totInst} totSkus={totSkus} onDrillCategory={cat => setDrill({ type: "category", value: cat, category: cat })} />}
          {drill?.type === "category" && <SimCategoryLevel toolRows={toolRowsView} ovrRows={ovrRowsView} ovrRowsFull={ovrRowsFull} winRows={winRows} skuMeta={skuMeta} category={drill.value} hasOverrides={hasOverrides} priceData={priceData} totInst={totInst} totSkus={totSkus} allDates={allDates} onDrillBrand={brand => setDrill({ type: "brand", value: brand, brand, category: drill.value })} />}
          {drill?.type === "brand" && <SimBrandLevel toolRows={toolRowsView} ovrRows={ovrRowsView} ovrRowsFull={ovrRowsFull} winRows={winRows} skuMeta={skuMeta} category={drill.category} brand={drill.value} hasOverrides={hasOverrides} priceData={priceData} allDates={allDates} toolRowsFull={toolRowsFull} />}
        </>
      )}
    </div>
  );
}
function OverridesTab({ coreOverrides, saveCoreOverrides, priceData, results, newSKUQty, skuMaster, params }) {
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("All");
  const [filterSource, setFilterSource] = useState("All");

  /* ---------- Build unified rows: one per SKU ---------- */
  const allRows = useMemo(() => {
    const skuSet = new Set([...Object.keys(coreOverrides || {}), ...Object.keys(newSKUQty || {})]);
    const rows = [];
    skuSet.forEach(sku => {
      const hasCoreOvr = !!(coreOverrides && coreOverrides[sku]);
      const hasFloor   = !!(newSKUQty && newSKUQty[sku]);
      const source = hasCoreOvr && hasFloor ? "Both" : hasCoreOvr ? "OOS Simulation" : "SKU Floor";
      const meta = results?.[sku]?.meta || {};
      const sm = skuMaster?.[sku] || {};
      const name = meta.name || sm.name || sm.Name || sku;
      const category = meta.category || sm.category || sm.Category || "Unknown";
      const price = priceData?.[sku] || 0;

      /* Determine timestamp */
      let timestamp = null;
      if (hasCoreOvr) {
        const dsEntries = Object.values(coreOverrides[sku]);
        const dates = dsEntries.map(e => e.appliedAt).filter(Boolean);
        if (dates.length) timestamp = dates.sort().pop(); /* latest */
      }

      /* Per-DS values — use preFloorMin/Max for "before" (engine output without SKU floors) */
      const dsData = {};
      DS_LIST.forEach(ds => {
        const store = results?.[sku]?.stores?.[ds];
        const toolMin = store?.preFloorMin ?? store?.min ?? 0;
        const toolMax = store?.preFloorMax ?? store?.max ?? 0;
        const effectiveMin = store?.min || 0;
        const effectiveMax = store?.max || 0;
        const coreMin = coreOverrides?.[sku]?.[ds]?.min || 0;
        const coreMax = coreOverrides?.[sku]?.[ds]?.max || 0;
        const fl = newSKUQty?.[sku]?.[ds];
        const floorMin = fl == null ? 0 : (typeof fl === "number" ? fl : (fl?.min || 0));
        const floorMax = fl == null ? 0 : (typeof fl === "number" ? fl : (fl?.max || floorMin));
        const ovrMin = Math.max(coreMin, floorMin);
        const ovrMax = Math.max(coreMax, floorMax);
        dsData[ds] = { toolMin, toolMax, ovrMin: ovrMin || 0, ovrMax: ovrMax || 0, effectiveMin, effectiveMax };
      });

      /* DC values — tool = pre-floor, effective = with floors */
      const dcToolMin = results?.[sku]?.dc?.preFloorMin ?? results?.[sku]?.dc?.min ?? 0;
      const dcToolMax = results?.[sku]?.dc?.preFloorMax ?? results?.[sku]?.dc?.max ?? 0;
      const dcEffMin = results?.[sku]?.dc?.min || 0;
      const dcEffMax = results?.[sku]?.dc?.max || 0;

      /* Inventory values: Before = pre-floor engine output, After = with floors + overrides */
      let minBefore = 0, minAfter = 0, maxBefore = 0, maxAfter = 0;
      DS_LIST.forEach(ds => {
        minBefore += dsData[ds].toolMin * price;
        minAfter  += Math.max(dsData[ds].effectiveMin, dsData[ds].ovrMin) * price;
        maxBefore += dsData[ds].toolMax * price;
        maxAfter  += Math.max(dsData[ds].effectiveMax, dsData[ds].ovrMax) * price;
      });
      minBefore += dcToolMin * price; minAfter += dcEffMin * price;
      maxBefore += dcToolMax * price; maxAfter += dcEffMax * price;
      const deltaMin = Math.round(minAfter - minBefore);
      const deltaMax = Math.round(maxAfter - maxBefore);

      rows.push({ sku, name, category, price, source, timestamp, dsData, dcToolMin, dcToolMax, dcEffMin, dcEffMax, deltaMin, deltaMax });
    });
    return rows;
  }, [coreOverrides, newSKUQty, results, skuMaster, priceData]);

  /* ---------- Derived ---------- */
  const categories = useMemo(() => ["All", ...new Set(allRows.map(r => r.category))].sort(), [allRows]);
  const filtered = useMemo(() => allRows.filter(r => {
    if (filterCat !== "All" && r.category !== filterCat) return false;
    if (filterSource !== "All" && r.source !== filterSource && !(filterSource === "OOS Simulation" && r.source === "Both") && !(filterSource === "SKU Floor" && r.source === "Both")) return false;
    if (search) { const q = search.toLowerCase(); if (!r.sku.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false; }
    return true;
  }), [allRows, filterCat, filterSource, search]);

  /* ---------- KPIs ---------- */
  const kpiMinBefore = filtered.reduce((s, r) => {
    const p = r.price || 0;
    return s + DS_LIST.reduce((ds, d) => ds + (r.dsData[d]?.toolMin || 0) * p, 0) + (r.dcToolMin || 0) * p;
  }, 0);
  const kpiMinAfter = filtered.reduce((s, r) => {
    const p = r.price || 0;
    return s + DS_LIST.reduce((ds, d) => ds + Math.max(r.dsData[d]?.effectiveMin || 0, r.dsData[d]?.ovrMin || 0) * p, 0) + (r.dcEffMin || 0) * p;
  }, 0);
  const kpiMaxBefore = filtered.reduce((s, r) => {
    const p = r.price || 0;
    return s + DS_LIST.reduce((ds, d) => ds + (r.dsData[d]?.toolMax || 0) * p, 0) + (r.dcToolMax || 0) * p;
  }, 0);
  const kpiMaxAfter = filtered.reduce((s, r) => {
    const p = r.price || 0;
    return s + DS_LIST.reduce((ds, d) => ds + Math.max(r.dsData[d]?.effectiveMax || 0, r.dsData[d]?.ovrMax || 0) * p, 0) + (r.dcEffMax || 0) * p;
  }, 0);
  const kpiMinDelta = Math.round(kpiMinAfter - kpiMinBefore);
  const kpiMaxDelta = Math.round(kpiMaxAfter - kpiMaxBefore);

  /* ---------- Actions ---------- */
  const removeOverride = (sku) => {
    const updated = { ...coreOverrides };
    delete updated[sku];
    saveCoreOverrides(updated);
  };

  /* ---------- Styles ---------- */
  const th = (extra = {}) => ({ padding: "6px 6px", textAlign: "center", color: HR.muted, background: HR.surfaceLight, fontWeight: 600, whiteSpace: "nowrap", fontSize: 9, ...extra });
  const td = (extra = {}) => ({ padding: "4px 6px", borderTop: "1px solid #E0E0D0", verticalAlign: "middle", fontSize: 10, textAlign: "center", ...extra });
  const pill = (bg, color) => ({ display: "inline-block", padding: "1px 6px", borderRadius: 8, fontSize: 9, fontWeight: 600, background: bg, color, marginRight: 2 });

  /* ---------- Empty state ---------- */
  if (!allRows.length) return (
    <div style={{ textAlign: "center", padding: 80 }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>&#x2705;</div>
      <div style={{ color: HR.muted, fontSize: 14 }}>No active overrides or SKU floors.</div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h2 style={{ color: HR.yellowDark, margin: 0, fontSize: 15 }}>Manual Overrides</h2>
        <span style={{ color: HR.muted, fontSize: 12 }}>One row per SKU. Shows OOS Simulation overrides and SKU Floor entries across all DS.</span>
      </div>

      {/* 2 KPI Cards — Min and Max, each with Before / After / Delta */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        {[
          { label: "Inventory Value (Min)", before: kpiMinBefore, after: kpiMinAfter, delta: kpiMinDelta, color: "#0077A8" },
          { label: "Inventory Value (Max)", before: kpiMaxBefore, after: kpiMaxAfter, delta: kpiMaxDelta, color: "#7A3DBF" },
        ].map(c => (
          <div key={c.label} style={{ background: HR.surface, borderRadius: 7, padding: "10px 14px", border: `1px solid ${HR.border}`, borderLeft: `3px solid ${c.color}` }}>
            <div style={{ fontSize: 9, color: HR.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 6 }}>{c.label}</div>
            <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
              <div>
                <div style={{ fontSize: 9, color: HR.muted, marginBottom: 1 }}>Before</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: HR.text }}>{fmtInr(Math.round(c.before))}</div>
              </div>
              <div style={{ fontSize: 16, color: HR.muted }}>→</div>
              <div>
                <div style={{ fontSize: 9, color: HR.muted, marginBottom: 1 }}>After</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: c.color }}>{fmtInr(Math.round(c.after))}</div>
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <div style={{ fontSize: 9, color: HR.muted, marginBottom: 1 }}>Delta</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: c.delta >= 0 ? "#C05A00" : HR.green }}>{c.delta >= 0 ? "+" : ""}{fmtInr(c.delta)}</div>
              </div>
            </div>
            <div style={{ fontSize: 9, color: HR.muted, marginTop: 4 }}>{filtered.length} SKU{filtered.length !== 1 ? "s" : ""} · DS + DC</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search SKU or item name..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 200 }} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...S.input, fontSize: 11, padding: "4px 8px" }}>
          {categories.map(c => <option key={c} value={c}>{c === "All" ? "All Categories" : c}</option>)}
        </select>
        <select value={filterSource} onChange={e => setFilterSource(e.target.value)} style={{ ...S.input, fontSize: 11, padding: "4px 8px" }}>
          <option value="All">All Sources</option>
          <option value="OOS Simulation">OOS Simulation</option>
          <option value="SKU Floor">SKU Floor</option>
        </select>
        <span style={{ fontSize: 11, color: HR.muted }}>{filtered.length} SKU{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Table */}
      <div style={{ ...S.card, padding: 0, overflow: "auto" }}>
        <table style={{ ...S.table, minWidth: 1400 }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
            {/* Row 1: group headers */}
            <tr style={{ background: HR.surfaceLight }}>
              <th style={th({ textAlign: "left", minWidth: 150 })} rowSpan={2}>SKU</th>
              <th style={th({ textAlign: "left" })} rowSpan={2}>Item</th>
              <th style={th({ textAlign: "left" })} rowSpan={2}>Category</th>
              <th style={th()} rowSpan={2}>Price</th>
              <th style={th()} rowSpan={2}>Delta Min</th>
              <th style={th()} rowSpan={2}>Delta Max</th>
              <th style={th()} rowSpan={2}>Source</th>
              <th style={th()} rowSpan={2}>Timestamp</th>
              {DS_LIST.map((ds, i) => (
                <th key={ds} colSpan={4} style={th({ background: DS_COLORS[i].bg, color: DS_COLORS[i].header, borderLeft: `2px solid ${DS_COLORS[i].header}44` })}>{ds}</th>
              ))}
              <th colSpan={4} style={th({ background: DC_COLOR.bg, color: DC_COLOR.header, borderLeft: `2px solid ${DC_COLOR.header}44` })}>DC</th>
              <th style={th()} rowSpan={2}>Actions</th>
            </tr>
            {/* Row 2: sub-headers */}
            <tr style={{ background: HR.surfaceLight }}>
              {DS_LIST.map((ds, i) => (
                <React.Fragment key={ds}>
                  <th style={th({ background: DS_COLORS[i].bg, color: DS_COLORS[i].text, fontSize: 8, borderLeft: `2px solid ${DS_COLORS[i].header}44` })}>TMin</th>
                  <th style={th({ background: DS_COLORS[i].bg, color: DS_COLORS[i].text, fontSize: 8 })}>TMax</th>
                  <th style={th({ background: DS_COLORS[i].bg, color: DS_COLORS[i].text, fontSize: 8 })}>OMin</th>
                  <th style={th({ background: DS_COLORS[i].bg, color: DS_COLORS[i].text, fontSize: 8 })}>OMax</th>
                </React.Fragment>
              ))}
              <th style={th({ background: DC_COLOR.bg, color: DC_COLOR.text, fontSize: 8, borderLeft: `2px solid ${DC_COLOR.header}44` })}>TMin</th>
              <th style={th({ background: DC_COLOR.bg, color: DC_COLOR.text, fontSize: 8 })}>TMax</th>
              <th style={th({ background: DC_COLOR.bg, color: DC_COLOR.text, fontSize: 8 })}>OMin</th>
              <th style={th({ background: DC_COLOR.bg, color: DC_COLOR.text, fontSize: 8 })}>OMax</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={r.sku} style={{ background: i % 2 === 0 ? HR.white : HR.surfaceLight }}>
                <td style={td({ textAlign: "left", fontWeight: 700, color: HR.text, fontSize: 10 })}>{r.sku}</td>
                <td style={td({ textAlign: "left", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })} title={r.name}>{r.name}</td>
                <td style={td({ textAlign: "left", color: HR.muted })}>{r.category}</td>
                <td style={td({ color: HR.muted })}>{r.price ? fmtInr(r.price) : "—"}</td>
                <td style={td()}><span style={{ fontWeight: 700, color: r.deltaMin > 0 ? "#C05A00" : r.deltaMin < 0 ? HR.green : HR.muted }}>{r.deltaMin !== 0 ? (r.deltaMin > 0 ? "+" : "") + fmtInr(r.deltaMin) : "—"}</span></td>
                <td style={td()}><span style={{ fontWeight: 700, color: r.deltaMax > 0 ? "#C05A00" : r.deltaMax < 0 ? HR.green : HR.muted }}>{r.deltaMax !== 0 ? (r.deltaMax > 0 ? "+" : "") + fmtInr(r.deltaMax) : "—"}</span></td>
                <td style={td()}>
                  {(r.source === "OOS Simulation" || r.source === "Both") && <span style={pill("#DBEAFE", "#1D4ED8")}>OOS Sim</span>}
                  {(r.source === "SKU Floor" || r.source === "Both") && <span style={pill("#EDE9FE", "#7C3AED")}>SKU Floor</span>}
                </td>
                <td style={td({ color: HR.muted, fontSize: 9 })}>{r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "—"}</td>
                {DS_LIST.map((ds, di) => {
                  const d = r.dsData[ds];
                  const hasOvr = d.ovrMin > 0 || d.ovrMax > 0;
                  const oMinHigher = d.ovrMin > d.toolMin;
                  const oMaxHigher = d.ovrMax > d.toolMax;
                  return (
                    <React.Fragment key={ds}>
                      <td style={td({ color: HR.muted, borderLeft: `2px solid ${DS_COLORS[di].header}22` })}>{d.toolMin}</td>
                      <td style={td({ color: HR.muted })}>{d.toolMax}</td>
                      <td style={td(hasOvr && oMinHigher ? { background: "#FFFDE7", fontWeight: 700, color: HR.yellowDark } : { color: "#ccc" })}>{hasOvr ? d.ovrMin : "—"}</td>
                      <td style={td(hasOvr && oMaxHigher ? { background: "#FFFDE7", fontWeight: 700, color: HR.yellowDark } : { color: "#ccc" })}>{hasOvr ? d.ovrMax : "—"}</td>
                    </React.Fragment>
                  );
                })}
                <td style={td({ color: HR.muted, borderLeft: `2px solid ${DC_COLOR.header}22` })}>{r.dcToolMin}</td>
                <td style={td({ color: HR.muted })}>{r.dcToolMax}</td>
                <td style={td(r.dcEffMin > r.dcToolMin ? { background: "#FFFDE7", fontWeight: 700, color: HR.yellowDark } : { color: "#ccc" })}>{r.dcEffMin > r.dcToolMin ? r.dcEffMin : "—"}</td>
                <td style={td(r.dcEffMax > r.dcToolMax ? { background: "#FFFDE7", fontWeight: 700, color: HR.yellowDark } : { color: "#ccc" })}>{r.dcEffMax > r.dcToolMax ? r.dcEffMax : "—"}</td>
                <td style={td()}>
                  {(r.source === "OOS Simulation" || r.source === "Both") && (
                    <button onClick={() => removeOverride(r.sku)} style={{ background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA", padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 9, fontWeight: 700 }}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div style={{ padding: 20, textAlign: "center", color: HR.muted, fontSize: 12 }}>No overrides match the current filters.</div>}
      </div>
    </div>
  );
}

function AdminLoginModal({onClose,onSuccess}){
  const [pw,setPw]=useState(""),[err,setErr]=useState(false);
  const ADMIN_PW=import.meta.env.VITE_ADMIN_PASSWORD||"";
  const attempt=()=>{if(pw===ADMIN_PW&&ADMIN_PW!==""){localStorage.setItem("adminSession","true");onSuccess();}else{setErr(true);setPw("");}};
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
      <div style={{background:HR.white,padding:28,borderRadius:10,border:`2px solid ${HR.yellow}`,maxWidth:360,width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.15)"}}>
        <div style={{fontSize:16,fontWeight:800,color:HR.yellowDark,marginBottom:4}}>🔐 Admin Login</div>
        <div style={{fontSize:12,color:HR.muted,marginBottom:16}}>Enter the admin password to unlock data uploads and logic editing.</div>
        <input type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr(false);}} onKeyDown={e=>e.key==="Enter"&&attempt()} placeholder="Password" autoFocus style={{...S.input,width:"100%",boxSizing:"border-box",marginBottom:err?6:14,borderColor:err?"#B91C1C":HR.border}}/>
        {err&&<div style={{fontSize:11,color:"#B91C1C",marginBottom:10}}>Incorrect password. Try again.</div>}
        <div style={{display:"flex",gap:8}}>
          <button onClick={attempt} style={{flex:1,background:HR.yellow,color:HR.black,border:"none",padding:"9px",borderRadius:6,cursor:"pointer",fontWeight:700,fontSize:13}}>Log In</button>
          <button onClick={onClose} style={{flex:1,background:HR.white,color:HR.muted,border:`1px solid ${HR.border}`,padding:"9px",borderRadius:6,cursor:"pointer",fontWeight:600,fontSize:13}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ImpactPreviewPanel({ params, savedParams, invoiceData, skuMaster, minReqQty, newSKUQty, deadStock, priceData, hasChanges }) {
  const [status, setStatus] = useState("idle");
  const [diff,   setDiff]   = useState(null);
  const prevParamsRef = useRef(null);

  useEffect(() => {
    if (!hasChanges) { setStatus("idle"); setDiff(null); }
  }, [hasChanges]);

  useEffect(() => {
    if (prevParamsRef.current && JSON.stringify(prevParamsRef.current) !== JSON.stringify(params)) {
      setStatus("idle"); setDiff(null);
    }
    prevParamsRef.current = params;
  }, [params]);

  const run = useCallback(() => {
    setStatus("running");
    setTimeout(() => {
      try {
        const baseRes = runEngine(invoiceData, skuMaster, minReqQty, priceData, deadStock, newSKUQty, savedParams);
        const newRes  = runEngine(invoiceData, skuMaster, minReqQty, priceData, deadStock, newSKUQty, params);
        let skusImpacted = 0;
        let baseInvMin = 0, newInvMin = 0, baseInvMax = 0, newInvMax = 0;
        const byMov = {};
        Object.entries(newRes).forEach(([sku, nr]) => {
          const br = baseRes[sku];
          if (!br) return;
          const p = priceData[sku] || 0;
          let skuChanged = false;
          DS_LIST.forEach(ds => {
            const bs = br.stores[ds] || { min: 0, max: 0 };
            const ns = nr.stores[ds] || { min: 0, max: 0 };
            baseInvMin += bs.min * p; baseInvMax += bs.max * p;
            newInvMin  += ns.min * p; newInvMax  += ns.max * p;
            if (bs.min !== ns.min || bs.max !== ns.max) skuChanged = true;
          });
          baseInvMin += (br.dc?.min || 0) * p; baseInvMax += (br.dc?.max || 0) * p;
          newInvMin  += (nr.dc?.min || 0) * p; newInvMax  += (nr.dc?.max || 0) * p;
          if (skuChanged) {
            skusImpacted++;
            const mvTag = nr.dc?.mvTag || "Super Slow";
            if (!byMov[mvTag]) byMov[mvTag] = { skus: 0, deltaMin: 0, deltaMax: 0 };
            byMov[mvTag].skus++;
            DS_LIST.forEach(ds => {
              const bs = br.stores[ds] || { min: 0, max: 0 };
              const ns = nr.stores[ds] || { min: 0, max: 0 };
              byMov[mvTag].deltaMin += (ns.min - bs.min) * p;
              byMov[mvTag].deltaMax += (ns.max - bs.max) * p;
            });
          }
        });
        setDiff({ skusImpacted, totalSKUs: Object.keys(newRes).length, deltaMin: Math.round(newInvMin - baseInvMin), deltaMax: Math.round(newInvMax - baseInvMax), byMov });
        setStatus("done");
      } catch (err) { console.error(err); setStatus("error"); }
    }, 60);
  }, [params, savedParams, invoiceData, skuMaster, minReqQty, newSKUQty, deadStock, priceData]);

  const MOV_ORDER = ["Super Fast", "Fast", "Moderate", "Slow", "Super Slow"];
  const noData = !invoiceData.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700, color: HR.text, fontSize: 13 }}>🔍 Impact Preview</span>
        {status === "done" && <button onClick={() => { setStatus("idle"); setDiff(null); }} style={{ background: "none", border: `1px solid ${HR.border}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 10, color: HR.muted }}>↩ Reset</button>}
      </div>
      {noData && <div style={{ background: HR.surfaceLight, borderRadius: 6, padding: "14px 12px", textAlign: "center", border: `1px solid ${HR.border}` }}><div style={{ fontSize: 20, marginBottom: 4 }}>📂</div><div style={{ fontSize: 11, color: HR.muted }}>Upload data to enable preview</div></div>}
      {!noData && !hasChanges && status !== "done" && <div style={{ background: HR.surfaceLight, borderRadius: 6, padding: "14px 12px", textAlign: "center", border: `1px solid ${HR.border}` }}><div style={{ fontSize: 20, marginBottom: 4 }}>✅</div><div style={{ fontSize: 11, color: HR.muted }}>No unsaved changes.<br/>Tweak a parameter to preview its impact.</div></div>}
      {!noData && hasChanges && status === "idle" && (
        <div style={{ background: HR.surfaceLight, borderRadius: 6, padding: "14px 12px", border: `1px solid ${HR.border}` }}>
          <div style={{ fontSize: 11, color: HR.muted, marginBottom: 10, lineHeight: 1.5 }}>Runs a shadow model against your saved results — no live data is touched until you hit <strong>Apply & Re-run</strong>.</div>
          <button onClick={run} style={{ background: HR.yellow, color: HR.black, border: "none", padding: "7px 18px", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12, width: "100%" }}>▶ Run Preview</button>
        </div>
      )}
      {status === "running" && <div style={{ background: HR.surfaceLight, borderRadius: 6, padding: "20px 12px", textAlign: "center", border: `1px solid ${HR.border}` }}><div style={{ fontSize: 24, marginBottom: 6 }}>⚡</div><div style={{ fontSize: 11, color: HR.muted }}>Running shadow model…</div></div>}
      {status === "error" && <div style={{ background: "#FEE2E2", borderRadius: 6, padding: "12px", border: "1px solid #FECACA" }}><div style={{ fontSize: 11, color: "#B91C1C", marginBottom: 8 }}>❌ Preview failed. Check console for details.</div><button onClick={() => setStatus("idle")} style={{ background: HR.white, border: `1px solid ${HR.border}`, borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 11, color: HR.muted }}>Retry</button></div>}
      {status === "done" && diff && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { label: "SKUs Affected", value: `${diff.skusImpacted}`, sub: `of ${diff.totalSKUs} · ${diff.totalSKUs > 0 ? ((diff.skusImpacted / diff.totalSKUs) * 100).toFixed(1) : 0}%`, color: diff.skusImpacted > 0 ? HR.yellowDark : HR.green, icon: "📦" },
            { label: "Inv Value Min Δ", value: `${diff.deltaMin >= 0 ? "+" : ""}${fmtInr(diff.deltaMin)}`, sub: diff.deltaMin === 0 ? "No change" : diff.deltaMin > 0 ? "↑ increase" : "↓ saving", color: diff.deltaMin > 0 ? "#C05A00" : diff.deltaMin < 0 ? HR.green : HR.muted, icon: "📉" },
            { label: "Inv Value Max Δ", value: `${diff.deltaMax >= 0 ? "+" : ""}${fmtInr(diff.deltaMax)}`, sub: diff.deltaMax === 0 ? "No change" : diff.deltaMax > 0 ? "↑ increase" : "↓ saving", color: diff.deltaMax > 0 ? "#C05A00" : diff.deltaMax < 0 ? HR.green : HR.muted, icon: "📈" },
          ].map(c => (
            <div key={c.label} style={{ background: HR.white, borderRadius: 6, padding: "10px 12px", border: `1px solid ${HR.border}`, borderLeft: `3px solid ${c.color}` }}>
              <div style={{ fontSize: 9, color: HR.muted, fontWeight: 600, textTransform: "uppercase", marginBottom: 2 }}>{c.icon} {c.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: c.color, lineHeight: 1.2 }}>{c.value}</div>
              <div style={{ fontSize: 10, color: HR.muted, marginTop: 2 }}>{c.sub}</div>
            </div>
          ))}
          {diff.skusImpacted === 0 && <div style={{ fontSize: 11, color: HR.green, fontWeight: 600, background: "#DCFCE7", border: "1px solid #BBF7D0", borderRadius: 6, padding: "8px 12px" }}>✅ No Min/Max values change with these parameters.</div>}
          {Object.keys(diff.byMov).length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: HR.muted, textTransform: "uppercase", marginBottom: 5, marginTop: 4 }}>By Movement Tag</div>
              <div style={{ background: HR.white, borderRadius: 6, border: `1px solid ${HR.border}`, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                  <thead><tr style={{ background: HR.surfaceLight }}><th style={{ padding: "5px 8px", textAlign: "left", color: HR.muted, fontWeight: 600 }}>Tag</th><th style={{ padding: "5px 8px", textAlign: "center", color: HR.muted, fontWeight: 600 }}>SKUs</th><th style={{ padding: "5px 8px", textAlign: "center", color: HR.muted, fontWeight: 600 }}>Min Δ</th><th style={{ padding: "5px 8px", textAlign: "center", color: HR.muted, fontWeight: 600 }}>Max Δ</th></tr></thead>
                  <tbody>
                    {MOV_ORDER.filter(t => diff.byMov[t]).map((tier, i) => {
                      const row = diff.byMov[tier], c = MOV_COLORS[tier] || "#64748b";
                      return (
                        <tr key={tier} style={{ background: i % 2 === 0 ? HR.white : HR.surfaceLight }}>
                          <td style={{ padding: "4px 8px", borderTop: `1px solid ${HR.border}` }}><span style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: c + "18", color: c, border: `1px solid ${c}33` }}>{tier}</span></td>
                          <td style={{ padding: "4px 8px", borderTop: `1px solid ${HR.border}`, textAlign: "center", fontWeight: 700, color: HR.yellowDark }}>{row.skus}</td>
                          <td style={{ padding: "4px 8px", borderTop: `1px solid ${HR.border}`, textAlign: "center", fontWeight: 700, fontSize: 10, color: row.deltaMin > 0 ? "#C05A00" : row.deltaMin < 0 ? HR.green : HR.muted }}>{row.deltaMin >= 0 ? "+" : ""}{fmtInr(Math.round(row.deltaMin))}</td>
                          <td style={{ padding: "4px 8px", borderTop: `1px solid ${HR.border}`, textAlign: "center", fontWeight: 700, fontSize: 10, color: row.deltaMax > 0 ? "#C05A00" : row.deltaMax < 0 ? HR.green : HR.muted }}>{row.deltaMax >= 0 ? "+" : ""}{fmtInr(Math.round(row.deltaMax))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div style={{ fontSize: 10, color: HR.muted, background: HR.surfaceLight, borderRadius: 5, padding: "7px 10px", lineHeight: 1.5 }}>Happy with the impact? Hit <strong style={{ color: HR.yellowDark }}>Apply & Re-run</strong> below to commit.</div>
        </div>
      )}
    </div>
  );
}
// ─── ImpactStickyBar ──────────────────────────────────────────────────────────
function ImpactStickyBar({ changedCount, onReset, onApply, previewState, runPreview }) {
  const ran = previewState === "done";
  return (
    <div style={{
      position:"sticky", top:-16, zIndex:20,
      background:"#FFFBEA", border:`1px solid ${HR.yellow}`,
      borderRadius:8, padding:"10px 16px", marginBottom:14,
      display:"flex", alignItems:"center", justifyContent:"space-between", gap:12,
      boxShadow:"0 2px 8px rgba(0,0,0,0.08)",
    }}>
      {/* Left: change count */}
      <div style={{flexShrink:0}}>
        <span style={{color:HR.yellowDark, fontWeight:800, fontSize:14}}>
          ⚠ {changedCount} unsaved change{changedCount!==1?"s":""}
        </span>
        <div style={{fontSize:10, color:HR.muted, marginTop:1}}>
          {ran ? "Preview ran — apply when ready" : "Run preview first to see impact, then apply"}
        </div>
      </div>

      {/* Right: action buttons */}
      <div style={{display:"flex", gap:8, alignItems:"center", flexShrink:0}}>
        {/* Reset — always red/destructive */}
        <button onClick={onReset} style={{
          background:"#FEE2E2", color:"#B91C1C",
          border:"1px solid #FECACA",
          padding:"7px 16px", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:700,
        }}>↩ Reset</button>

        {/* Run Preview — primary before run, secondary after */}
        <button onClick={runPreview} style={{
          background: ran ? HR.white : HR.yellow,
          color:       ran ? HR.muted : HR.black,
          border:      ran ? `1px solid ${HR.border}` : "none",
          padding:"7px 18px", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:700,
          opacity: previewState === "running" ? 0.6 : 1,
        }} disabled={previewState==="running"}>
          {previewState==="running" ? "⚡ Running…" : ran ? "↻ Re-run Preview" : "▶ Run Preview"}
        </button>

        {/* Apply & Re-run — secondary before run, primary after */}
        <button onClick={onApply} style={{
          background: ran ? HR.yellow : HR.white,
          color:       ran ? HR.black  : HR.muted,
          border:      ran ? "none"    : `1px solid ${HR.border}`,
          padding:"7px 20px", borderRadius:6, cursor:"pointer", fontSize:13, fontWeight:700,
        }}>▶ Apply & Re-run</button>
      </div>
    </div>
  );
}

// ─── ImpactPreviewPanelV2 ─────────────────────────────────────────────────────
function ImpactPreviewPanelV2({
  params, savedParams, invoiceData, skuMaster,
  minReqQty, newSKUQty, deadStock, priceData, hasChanges,
  previewState, setPreviewState, onSetRunFn,
}) {
  const [diff, setDiff] = useState(null);
  const prevParamsRef   = useRef(null);

  // Reset diff when changes are discarded
  useEffect(() => {
    if (!hasChanges) { setPreviewState("idle"); setDiff(null); }
  }, [hasChanges]);

  // Reset diff when params change after a completed run
  useEffect(() => {
    if (
      prevParamsRef.current &&
      JSON.stringify(prevParamsRef.current) !== JSON.stringify(params) &&
      previewState === "done"
    ) {
      setPreviewState("idle"); setDiff(null);
    }
    prevParamsRef.current = params;
  }, [params]);

  const MOV_ORDER = ["Super Fast","Fast","Moderate","Slow","Super Slow"];

  const run = useCallback(() => {
    setPreviewState("running");
    setTimeout(() => {
      try {
        const baseRes = runEngine(invoiceData, skuMaster, minReqQty, priceData, deadStock, newSKUQty, savedParams);
        const newRes  = runEngine(invoiceData, skuMaster, minReqQty, priceData, deadStock, newSKUQty, params);

        let skusImpacted = 0;
        let baseInvMin = 0, newInvMin = 0, baseInvMax = 0, newInvMax = 0;
        const byMov = {};
        const byDS  = Object.fromEntries(DS_LIST.map(ds=>[ds,{baseMin:0,newMin:0,baseMax:0,newMax:0,skus:new Set()}]));
        const byCat = {};

        Object.entries(newRes).forEach(([sku, nr]) => {
          const br = baseRes[sku]; if (!br) return;
          const p   = priceData[sku] || 0;
          const cat = skuMaster[sku]?.category || "Unknown";
          let skuChanged = false;

          DS_LIST.forEach(ds => {
            const bs = br.stores[ds]||{min:0,max:0}, ns = nr.stores[ds]||{min:0,max:0};
            baseInvMin += bs.min*p; baseInvMax += bs.max*p;
            newInvMin  += ns.min*p; newInvMax  += ns.max*p;
            byDS[ds].baseMin += bs.min*p; byDS[ds].newMin  += ns.min*p;
            byDS[ds].baseMax += bs.max*p; byDS[ds].newMax  += ns.max*p;
            if (bs.min!==ns.min||bs.max!==ns.max) { skuChanged=true; byDS[ds].skus.add(sku); }
          });
          baseInvMin += (br.dc?.min||0)*p; baseInvMax += (br.dc?.max||0)*p;
          newInvMin  += (nr.dc?.min||0)*p; newInvMax  += (nr.dc?.max||0)*p;

          if (skuChanged) {
            skusImpacted++;
            const mvTag = nr.dc?.mvTag||"Super Slow";
            if (!byMov[mvTag]) byMov[mvTag]={skus:0,deltaMin:0,deltaMax:0};
            byMov[mvTag].skus++;
            if (!byCat[cat]) byCat[cat]={deltaMin:0,deltaMax:0,skus:0};
            byCat[cat].skus++;
            DS_LIST.forEach(ds=>{
              const bs=br.stores[ds]||{min:0,max:0},ns=nr.stores[ds]||{min:0,max:0};
              byMov[mvTag].deltaMin += (ns.min-bs.min)*p;
              byMov[mvTag].deltaMax += (ns.max-bs.max)*p;
              byCat[cat].deltaMin   += (ns.min-bs.min)*p;
              byCat[cat].deltaMax   += (ns.max-bs.max)*p;
            });
          }
        });

        const topCats = Object.entries(byCat)
          .map(([name,v])=>({name,...v,deltaMin:Math.round(v.deltaMin),deltaMax:Math.round(v.deltaMax)}))
          .sort((a,b)=>Math.abs(b.deltaMax)-Math.abs(a.deltaMax)).slice(0,5);
        const dsSummary = DS_LIST.map(ds=>({
          ds,
          deltaMin:Math.round(byDS[ds].newMin-byDS[ds].baseMin),
          deltaMax:Math.round(byDS[ds].newMax-byDS[ds].baseMax),
          skus:byDS[ds].skus.size,
        }));

        setDiff({skusImpacted,totalSKUs:Object.keys(newRes).length,
          deltaMin:Math.round(newInvMin-baseInvMin),deltaMax:Math.round(newInvMax-baseInvMax),
          byMov,byDS:dsSummary,topCats});
        setPreviewState("done");
      } catch(err) { console.error(err); setPreviewState("error"); }
    }, 60);
  }, [params, savedParams, invoiceData, skuMaster, minReqQty, newSKUQty, deadStock, priceData]);

  // Expose run function to sticky bar
  useEffect(() => { onSetRunFn && onSetRunFn(run); }, [run]);

  const deltaColor = v => v>0?"#C05A00":v<0?HR.green:HR.muted;
  const deltaFmt   = v => `${v>=0?"+":""}${fmtInr(v)}`;
  const thS = {padding:"6px 8px",fontSize:10,fontWeight:600,color:HR.muted,background:HR.surfaceLight,textAlign:"center"};
  const tdS = (right) => ({padding:"5px 8px",borderTop:`1px solid ${HR.border}`,fontSize:11,textAlign:right?"right":"left"});

  // ── Blank ──
  if (!hasChanges && previewState!=="done") return (
    <div style={{textAlign:"center",padding:"40px 16px"}}>
      <div style={{fontSize:36,marginBottom:10}}>✅</div>
      <div style={{color:HR.muted,fontSize:13,fontWeight:600}}>No unsaved changes</div>
      <div style={{color:HR.muted,fontSize:11,marginTop:4}}>Tweak any parameter to preview its impact here.</div>
    </div>
  );

  if (!invoiceData.length&&hasChanges) return (
    <div style={{textAlign:"center",padding:"40px 16px"}}>
      <div style={{fontSize:32,marginBottom:10}}>📂</div>
      <div style={{fontSize:12,color:HR.muted}}>Upload data first to enable preview.</div>
    </div>
  );

  // ── Idle (changes exist, not yet run) ──
  if (previewState==="idle"&&hasChanges) return (
    <div style={{textAlign:"center",padding:"40px 16px"}}>
      <div style={{fontSize:32,marginBottom:10}}>🔍</div>
      <div style={{color:HR.muted,fontSize:13,fontWeight:600}}>Ready to preview</div>
      <div style={{color:HR.muted,fontSize:11,marginTop:4}}>Hit <strong>Run Preview</strong> in the bar above.</div>
    </div>
  );

  // ── Running ──
  if (previewState==="running") return (
    <div style={{textAlign:"center",padding:"40px 16px"}}>
      <div style={{fontSize:28,marginBottom:8}}>⚡</div>
      <div style={{fontSize:12,color:HR.muted}}>Running shadow model…</div>
    </div>
  );

  // ── Error ──
  if (previewState==="error") return (
    <div style={{background:"#FEE2E2",borderRadius:6,padding:"12px",border:"1px solid #FECACA"}}>
      <div style={{fontSize:12,color:"#B91C1C",marginBottom:4}}>❌ Preview failed. Check console.</div>
    </div>
  );

  // ── Results ──
  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Summary cards */}
      {[
        {label:"SKUs Affected",icon:"📦",value:`${diff.skusImpacted}`,
          sub:`of ${diff.totalSKUs} · ${diff.totalSKUs>0?((diff.skusImpacted/diff.totalSKUs)*100).toFixed(1):0}%`,
          color:diff.skusImpacted>0?HR.yellowDark:HR.green},
        {label:"Inv Value Min Δ",icon:"📉",value:deltaFmt(diff.deltaMin),
          sub:diff.deltaMin===0?"No change":diff.deltaMin>0?"↑ increase":"↓ saving",
          color:deltaColor(diff.deltaMin)},
        {label:"Inv Value Max Δ",icon:"📈",value:deltaFmt(diff.deltaMax),
          sub:diff.deltaMax===0?"No change":diff.deltaMax>0?"↑ increase":"↓ saving",
          color:deltaColor(diff.deltaMax)},
      ].map(c=>(
        <div key={c.label} style={{background:HR.white,borderRadius:6,padding:"10px 12px",
          border:`1px solid ${HR.border}`,borderLeft:`3px solid ${c.color}`}}>
          <div style={{fontSize:9,color:HR.muted,fontWeight:600,textTransform:"uppercase",marginBottom:2}}>{c.icon} {c.label}</div>
          <div style={{fontSize:24,fontWeight:800,color:c.color,lineHeight:1.2}}>{c.value}</div>
          <div style={{fontSize:10,color:HR.muted,marginTop:2}}>{c.sub}</div>
        </div>
      ))}

      {diff.skusImpacted===0&&(
        <div style={{fontSize:11,color:HR.green,fontWeight:600,background:"#DCFCE7",
          border:"1px solid #BBF7D0",borderRadius:6,padding:"8px 12px"}}>
          ✅ No Min/Max values change with these parameters.
        </div>
      )}

      {/* Movement breakdown */}
      {Object.keys(diff.byMov).length>0&&(
        <div>
          <div style={{fontSize:11,fontWeight:700,color:HR.muted,textTransform:"uppercase",marginBottom:5,letterSpacing:"0.4px"}}>By Movement Tag</div>
          <div style={{background:HR.white,borderRadius:6,border:`1px solid ${HR.border}`,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
              <thead><tr style={{background:HR.surfaceLight}}>
                <th style={{...thS,textAlign:"left"}}>Tag</th>
                <th style={thS}>SKUs</th><th style={thS}>Min Δ</th><th style={thS}>Max Δ</th>
              </tr></thead>
              <tbody>
                {MOV_ORDER.filter(t=>diff.byMov[t]).map((tier,i)=>{
                  const row=diff.byMov[tier],c=MOV_COLORS[tier]||"#64748b";
                  return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                    <td style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`}}>
                      <span style={{padding:"1px 5px",borderRadius:3,fontSize:9,fontWeight:600,
                        background:c+"18",color:c,border:`1px solid ${c}33`}}>{tier}</span>
                    </td>
                    <td style={tdS(true)}><span style={{fontWeight:700,color:HR.yellowDark}}>{row.skus}</span></td>
                    <td style={tdS(true)}><span style={{fontWeight:700,color:deltaColor(row.deltaMin)}}>{deltaFmt(Math.round(row.deltaMin))}</span></td>
                    <td style={tdS(true)}><span style={{fontWeight:700,color:deltaColor(row.deltaMax)}}>{deltaFmt(Math.round(row.deltaMax))}</span></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Per-DS breakdown */}
      <div>
        <div style={{fontSize:11,fontWeight:700,color:HR.muted,textTransform:"uppercase",marginBottom:5,letterSpacing:"0.4px"}}>By Dark Store</div>
        <div style={{background:HR.white,borderRadius:6,border:`1px solid ${HR.border}`,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
            <thead><tr style={{background:HR.surfaceLight}}>
              <th style={{...thS,textAlign:"left"}}>Store</th>
              <th style={thS}>SKUs Δ</th><th style={thS}>Min Δ</th><th style={thS}>Max Δ</th>
            </tr></thead>
            <tbody>
              {diff.byDS.map((row,i)=>{
                const di=DS_LIST.indexOf(row.ds),dc=DS_COLORS[di>=0?di:0];
                return <tr key={row.ds} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                  <td style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`}}>
                    <span style={{padding:"1px 6px",borderRadius:3,fontSize:9,fontWeight:700,
                      background:dc.bg,color:dc.header,border:`1px solid ${dc.header}44`}}>{row.ds}</span>
                  </td>
                  <td style={tdS(true)}><span style={{fontWeight:700,color:row.skus>0?HR.yellowDark:HR.muted}}>{row.skus}</span></td>
                  <td style={tdS(true)}><span style={{fontWeight:700,color:deltaColor(row.deltaMin)}}>{deltaFmt(row.deltaMin)}</span></td>
                  <td style={tdS(true)}><span style={{fontWeight:700,color:deltaColor(row.deltaMax)}}>{deltaFmt(row.deltaMax)}</span></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top categories */}
      {diff.topCats.length>0&&(
        <div>
          <div style={{fontSize:11,fontWeight:700,color:HR.muted,textTransform:"uppercase",marginBottom:5,letterSpacing:"0.4px"}}>Top Categories by Impact</div>
          <div style={{background:HR.white,borderRadius:6,border:`1px solid ${HR.border}`,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
              <thead><tr style={{background:HR.surfaceLight}}>
                <th style={{...thS,textAlign:"left"}}>Category</th>
                <th style={thS}>SKUs</th><th style={thS}>Min Δ</th><th style={thS}>Max Δ</th>
              </tr></thead>
              <tbody>
                {diff.topCats.map((row,i)=>(
                  <tr key={row.name} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                    <td style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,fontWeight:600,color:HR.text,fontSize:10}}>{row.name}</td>
                    <td style={tdS(true)}><span style={{fontWeight:700,color:HR.yellowDark}}>{row.skus}</span></td>
                    <td style={tdS(true)}><span style={{fontWeight:700,color:deltaColor(row.deltaMin)}}>{deltaFmt(row.deltaMin)}</span></td>
                    <td style={tdS(true)}><span style={{fontWeight:700,color:deltaColor(row.deltaMax)}}>{deltaFmt(row.deltaMax)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
// ─── Overview Tab Helpers ────────────────────────────────────────────────────
const OV_PERIODS = [
  { key: "L90D", label: "L90D", days: 90 },
  { key: "L60D", label: "L60D", days: 60 },
  { key: "L45D", label: "L45D", days: 45 },
  { key: "L30D", label: "L30D", days: 30 },
  { key: "L15D", label: "L15D", days: 15 },
  { key: "L7D",  label: "L7D",  days: 7 },
  { key: "CUSTOM", label: "Custom" },
];

// ─── SKU Detail Tab Helpers ─────────────────────────────────────────────────
const SD_PERIODS = [
  { key: "L90D", label: "L90D", days: 90 },
  { key: "L60D", label: "L60D", days: 60 },
  { key: "L45D", label: "L45D", days: 45 },
  { key: "L30D", label: "L30D", days: 30 },
  { key: "L15D", label: "L15D", days: 15 },
  { key: "L7D",  label: "L7D",  days: 7 },
  { key: "CUSTOM", label: "Custom" },
];
const SD_DS_OPTS = ["All", "DS01", "DS02", "DS03", "DS04", "DS05"];

function filterInvoiceByPeriod(invoiceData, periodKey, dateFrom, dateTo, invoiceDateRange) {
  if (!invoiceData || !invoiceData.length) return [];
  const allDates = invoiceDateRange.dates;
  if (periodKey === "CUSTOM" && dateFrom && dateTo) {
    return invoiceData.filter(r => r.date >= dateFrom && r.date <= dateTo);
  }
  const preset = OV_PERIODS.find(p => p.key === periodKey);
  if (preset && preset.days) {
    const last = allDates.slice(-preset.days);
    return invoiceData.filter(r => last.includes(r.date));
  }
  return invoiceData;
}

function fmtVal(v) {
  if (v == null || isNaN(v)) return "–";
  if (v >= 10000000) return "₹" + (v / 10000000).toFixed(2) + "Cr";
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1) + "L";
  if (v >= 1000) return "₹" + (v / 1000).toFixed(1) + "K";
  return "₹" + Math.round(v).toLocaleString();
}
function fmtNum(v) {
  if (v == null || isNaN(v)) return "–";
  return Number(v).toLocaleString();
}
function fmtCov(v) {
  if (v == null) return "No Sale";
  return v.toFixed(1) + "D";
}

// ─── SKU Detail Tab Components ──────────────────────────────────────────────

const SPIKE_TAG_COLORS = {
  "Frequent":{bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
  "Once in a while":{bg:"#FFEDD5",color:"#C2410C",border:"#FED7AA"},
  "Rare":{bg:"#FEF9C3",color:"#A16207",border:"#FDE68A"},
  "No Spike":{bg:"#F1F5F9",color:"#64748B",border:"#CBD5E1"},
};

const StrategyCard = ({ dsId, dsIndex, storeData, meta, params }) => {
  const dc = DS_COLORS[dsIndex] || DS_COLORS[0];
  const s = storeData || {};
  const det = s.strategyDetails || null;
  const stratTag = s.strategyTag || "standard";
  const mvTag = s.mvTag || "Super Slow";
  const priceTag = meta?.priceTag || "No Price";
  const spTag = s.spTag || "No Spike";
  const logicTag = s.logicTag || "Base Logic";
  const steps = s.postBlendSteps || [];

  const v = (val, suffix = "") => <span style={{fontWeight:700, color:dc.text}}>{val}{suffix}</span>;
  const line = (...children) => <div style={{fontSize:10, color:HR.muted, padding:"1.5px 0", lineHeight:1.5}}>{children}</div>;
  const head = (text) => <div style={{fontSize:10, fontWeight:700, color:dc.header, marginTop:6, marginBottom:3}}>{text}</div>;

  return (
    <div style={{background:dc.bg, borderRadius:10, border:`1px solid ${dc.header}33`, overflow:"hidden"}}>
      <div style={{background:dc.header, color:"#fff", padding:"6px 10px", fontSize:12, fontWeight:700, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
        <span>{dsId}</span>
      </div>
      <div style={{padding:"8px 10px"}}>
        {/* Tags + Min/Max row */}
        <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:6, flexWrap:"wrap"}}>
          <div style={{display:"flex", gap:12}}>
            <span style={{fontSize:18, fontWeight:800, color:dc.header}}>Min {s.min ?? "—"}</span>
            <span style={{fontSize:18, fontWeight:800, color:dc.text}}>Max {s.max ?? "—"}</span>
          </div>
          <div style={{display:"flex", gap:3, marginLeft:"auto"}}>
            <MovTag value={mvTag} />
            <TagPill value={priceTag} colorMap={PRICE_TAG_COLORS} />
            {spTag && spTag !== "No Spike" && <TagPill value={spTag} colorMap={SPIKE_TAG_COLORS} />}
          </div>
        </div>

        {/* Standard strategy — narrative flow */}
        {stratTag === "standard" && det && (() => {
          const renderPeriod = (label, days, stats, r) => {
            const ex = r?.explain;
            if (!stats || !r) return line(`${label} (${days}D): no data`);
            return <>
              {line(label, " (", v(days, "D"), "): avg ", v(stats.dailyAvg?.toFixed(2)), "/day, ", v(stats.nonZeroDays), " NZD, spike median ", v(stats.spikeMedian?.toFixed(1)))}
              {ex && line("  Base min days (", ex.mvTag, ") = ", v(ex.base), " × avg ", v(stats.dailyAvg?.toFixed(2)), " = ", v(ex.baseMinQty?.toFixed(2)))}
              {ex && ex.useRatio && line("  Spike override: max(base ", ex.baseMinQty?.toFixed(1), ", spike ", stats.spikeMedian?.toFixed(1), ") = ", v(Math.max(ex.baseMinQty || 0, stats.spikeMedian || 0).toFixed(1)), " → Min, + buffer ", v(ex.buffer), "D → Max")}
              {ex && ex.abqApplied && line("  ABQ floor: ⌈ABQ ", v(ex.abq?.toFixed(1)), "⌉ ≥ min → Min = ", v(Math.ceil(ex.abq)), ", Max = ⌈Min × ", v(ex.abqMaxMult), "⌉")}
              {line("  → ", label, " Min ", v(r.minQty), " / Max ", v(r.maxQty))}
            </>;
          };
          return <>
            {det.pctFallback && line("⚠ PCT fallback: NZD ", v(det.pctFallback.nzd), " < threshold ", v(det.pctFallback.threshold), " → using Standard")}
            {head("Standard Strategy")}
            {renderPeriod("Long", det.longDays, det.sLong, det.rLong)}
            {renderPeriod("Recent", det.recentDays, det.sRecent, det.rRecent)}
            {line("Blending: (Long + Recent × ", v(`${det.wt}`), ") / (1 + ", v(`${det.wt}`), ") → Min ", v(det.blendedMin), " / Max ", v(det.blendedMax))}
          </>;
        })()}

        {/* Percentile Cover — narrative flow */}
        {stratTag === "percentile_cover" && det && (<>
          {head("Percentile Cover")}
          {line("Full period ", v(det.periodDays, "D"), ", ", v(det.nonZeroCount), " non-zero days")}
          {line("Price ", v(priceTag), " → ", v(`P${det.pctUsed}`), ", Movement ", v(mvTag), " → Cover ", v(det.coverDays, "D"))}
          {line("P", det.pctUsed, " value = ", v(det.pctQty?.toFixed(2)), " → Min = ⌈", det.pctQty?.toFixed(2), " × ", det.coverDays, "⌉ = ", v(Math.ceil((det.pctQty || 0) * (det.coverDays || 1))))}
          {line("Max = ⌈Min + ", det.dailyAvg?.toFixed(2), " avg × ", det.buffer, " buffer⌉ = ", v(Math.ceil(Math.ceil((det.pctQty || 0) * (det.coverDays || 1)) + (det.dailyAvg || 0) * (det.buffer || 2))))}
          {det.docCap?.applied && line(
            "DOC Cap (", v(det.docCap.capDays, "D"), ", ", det.docCap.priceTag, "): Min capped ",
            v(det.docCap.uncappedMin), " → ", v(det.docCap.cappedMin),
            ", Max recalculated ", v(det.docCap.uncappedMax), " → ", v(det.docCap.cappedMax)
          )}
        </>)}

        {/* Fixed Unit Floor — narrative flow */}
        {stratTag === "fixed_unit_floor" && det && (<>
          {head("Fixed Unit Floor")}
          {line(v(det.orderCount), " orders in period")}
          {line("P", det.pctile, " of order quantities = ", v(det.pctQty?.toFixed(2)), " → Min = ", v(Math.ceil(det.pctQty || 0)))}
          {line("Max = ⌈max(", Math.ceil(det.pctQty || 0), "+", det.maxAdd, ", ", Math.ceil(det.pctQty || 0), "×", det.maxMult, ")⌉ = ", v(Math.ceil(Math.max(Math.ceil(det.pctQty || 0) + (det.maxAdd || 1), Math.ceil(det.pctQty || 0) * (det.maxMult || 1.5)))))}
        </>)}

        {!det && (<>
          {head(stratTag === "percentile_cover" ? "Percentile Cover" : stratTag === "fixed_unit_floor" ? "Fixed Unit Floor" : "Standard")}
          <div style={{fontSize:10, color:HR.muted, fontStyle:"italic"}}>No details available</div>
        </>)}

        {/* Post-blend adjustments */}
        {steps.length > 0 && (<>
          {head("Adjustments")}
          {steps.map((step, i) => (
            <div key={i} style={{fontSize:10, color:dc.text, padding:"1px 0"}}>
              {step.rule === "New DS Floor" && <>New DS Floor: floor {v(step.floor)} {">"} computed {step.beforeMin} → Min=Max={v(step.floor)}</>}
              {step.rule === "Brand Buffer" && <>Brand Buffer: +{v(step.bufDays, "D")} (DOH {step.dohMin?.toFixed(1)}D) → Min=Max={v(s.min)}</>}
              {step.rule === "SKU Floor" && <>SKU Floor: {v(`${step.floorMin}/${step.floorMax}`)} {">"} computed {step.beforeMin}/{step.beforeMax}</>}
            </div>
          ))}
        </>)}

        {logicTag && logicTag !== "Base Logic" && (
          <div style={{marginTop:4}}><LogicTag value={logicTag} /></div>
        )}
      </div>
    </div>
  );
};

const DCCard = ({ dcData, meta, params, horizontal }) => {
  const dc = dcData || {};
  const det = dc.dcDetails || null;
  const mvTag = dc.mvTag || "Super Slow";

  const pill = (label, val) => (
    <div style={{fontSize:10,padding:"3px 0"}}>
      <span style={{color:HR.muted}}>{label}: </span>
      <span style={{fontWeight:600,color:DC_COLOR.text}}>{val}</span>
    </div>
  );

  return (
    <div style={{background:DC_COLOR.bg,borderRadius:10,border:`1px solid ${DC_COLOR.header}33`,overflow:"hidden"}}>
      <div style={{background:DC_COLOR.header,color:"#fff",padding:"6px 10px",fontSize:12,fontWeight:700}}>DC</div>
      <div style={{padding:horizontal?"10px 14px":"10px",display:horizontal?"flex":"block",gap:horizontal?24:0,alignItems:"flex-start",flexWrap:"wrap"}}>
        {/* Left: Min/Max + movement */}
        <div style={{display:"flex",gap:16,alignItems:"center",marginBottom:horizontal?0:8,minWidth:horizontal?180:0}}>
          <MovTag value={mvTag} />
          <div style={{display:"flex",gap:16}}>
            <div>
              <div style={{fontSize:9,color:HR.muted,fontWeight:600}}>Min</div>
              <div style={{fontSize:22,fontWeight:800,color:DC_COLOR.header}}>{dc.min ?? "—"}</div>
            </div>
            <div>
              <div style={{fontSize:9,color:HR.muted,fontWeight:600}}>Max</div>
              <div style={{fontSize:22,fontWeight:800,color:DC_COLOR.text}}>{dc.max ?? "—"}</div>
            </div>
          </div>
        </div>
        {/* Details */}
        {det ? (
          <div style={{display:horizontal?"flex":"block",gap:horizontal?20:0,flexWrap:"wrap",flex:1}}>
            <div style={{minWidth:140}}>
              {pill("Non-Zero Days", det.nonZeroDays ?? dc.nonZeroDays ?? "—")}
              {pill("Sum DS Mins", det.sumMin ?? "—")}
              {pill("Sum DS Maxes", det.sumMax ?? "—")}
            </div>
            <div style={{minWidth:160}}>
              {pill("Sum Daily Avg", det.sumDailyAvg != null ? det.sumDailyAvg.toFixed(2) : "—")}
              {pill("Brand Lead Time", `${det.leadTime ?? 2}D`)}
              {det.isDead
                ? <>{pill("Dead Mult", `${det.multMin}/${det.multMax}`)}</>
                : <>{pill("DC Mult", `${det.multMin}/${det.multMax}`)}</>
              }
            </div>
            {!det.isDead && (
              <div style={{minWidth:200}}>
                {det.leadTimeMin != null && pill("Lead Time Min", det.leadTimeMin)}
                {pill("DC Min", `max(${det.leadTimeMin ?? "?"}, ${det.sumMin} × ${det.multMin}) = ${dc.min}`)}
                {pill("DC Max", `max(⌈${dc.min} × ${(det.multMax/det.multMin).toFixed(2)}⌉, ${det.sumMax} × ${det.multMax}) = ${dc.max}`)}
              </div>
            )}
          </div>
        ) : (
          <div>
            {pill("Non-Zero Days", dc.nonZeroDays ?? "—")}
            <div style={{fontSize:10,color:HR.muted,fontStyle:"italic",marginTop:4}}>No DC details available</div>
          </div>
        )}
      </div>
    </div>
  );
};

const DateOrderChart = ({ data, color, minVal, maxVal }) => {
  if (!data || !data.length) return <div style={{ color: HR.muted, fontSize: 11, padding: 20, textAlign: "center" }}>No order data</div>;
  const col = color || HR.yellowDark;
  const maxQty = Math.max(...data.map(d => d.qty), 1);
  const yDomainMax = Math.max(maxQty, minVal || 0, maxVal || 0) * 1.08; // 8% headroom for labels
  const tickInterval = data.length <= 15 ? 0 : data.length <= 30 ? 1 : data.length <= 60 ? 4 : 6;
  const sameMinMax = minVal != null && maxVal != null && minVal === maxVal;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{top:5, right:60, left:0, bottom:5}}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E8E8D8" />
        <XAxis dataKey="date" tickFormatter={v => v.slice(5)} tick={{fontSize:8, fill:"#666", angle:-45, textAnchor:"end"}} interval={tickInterval} />
        <YAxis tick={{fontSize:10, fill:"#666"}} allowDecimals={false} domain={[0, yDomainMax]} />
        <Tooltip formatter={(value) => [`Qty: ${value}`, null]} labelFormatter={(label) => `Date: ${label}`} />
        <Bar dataKey="qty" fill={col} radius={[1,1,0,0]} maxBarSize={16} isAnimationActive={false} />
        {sameMinMax && <ReferenceLine y={minVal} stroke="#C0392B" strokeDasharray="5 3" label={{value:`Min=Max=${minVal}`, fill:"#C0392B", fontSize:9, position:"right"}} />}
        {!sameMinMax && minVal != null && <ReferenceLine y={minVal} stroke="#C0392B" strokeDasharray="5 3" label={{value:`Min ${minVal}`, fill:"#C0392B", fontSize:9, position:"right"}} />}
        {!sameMinMax && maxVal != null && <ReferenceLine y={maxVal} stroke="#2D7A3A" strokeDasharray="5 3" label={{value:`Max ${maxVal}`, fill:"#2D7A3A", fontSize:9, position:"right"}} />}
      </BarChart>
    </ResponsiveContainer>
  );
};

function SKUDetailTab({ invoiceData, skuMaster, results, params, invoiceDateRange,
  skuId, setSkuId, searchVal, setSearchVal,
  period, setPeriod, dateFrom, setDateFrom, dateTo, setDateTo,
  dsView, setDsView }) {

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [hlIdx, setHlIdx] = useState(-1);
  const searchRef = useRef(null);

  const skuList = useMemo(() => {
    if (!skuMaster || typeof skuMaster !== "object") return [];
    return Object.values(skuMaster).map(s => ({ sku: s.SKU || s.sku, name: s.Name || s.name || "" }));
  }, [skuMaster]);

  const matches = useMemo(() => {
    if (!searchVal || searchVal.length < 1) return [];
    const q = searchVal.toLowerCase();
    return skuList.filter(s => s.sku?.toLowerCase().includes(q) || s.name?.toLowerCase().includes(q)).slice(0, 8);
  }, [searchVal, skuList]);

  const doSearch = useCallback((val) => {
    const v = (val || searchVal || "").trim();
    if (!v) return;
    const exact = skuList.find(s => s.sku === v);
    if (exact) { setSkuId(v); setDropdownOpen(false); return; }
    const match = skuList.find(s => s.sku?.toLowerCase() === v.toLowerCase() || s.name?.toLowerCase() === v.toLowerCase());
    if (match) { setSkuId(match.sku); setSearchVal(match.sku); setDropdownOpen(false); return; }
    if (matches.length > 0) { setSkuId(matches[0].sku); setSearchVal(matches[0].sku); setDropdownOpen(false); return; }
    setSkuId(v);
    setDropdownOpen(false);
  }, [searchVal, skuList, matches, setSkuId, setSearchVal]);

  const res = skuId ? results?.[skuId] : null;

  const filteredInv = useMemo(() => {
    if (!invoiceData || !skuId) return [];
    let rows = invoiceData.filter(r => r.sku === skuId);
    if (dsView !== "All") rows = rows.filter(r => r.ds === dsView);
    return filterInvoiceByPeriod(rows, period, dateFrom, dateTo, invoiceDateRange);
  }, [invoiceData, skuId, dsView, period, dateFrom, dateTo, invoiceDateRange]);

  const stats = useMemo(() => {
    if (!filteredInv.length) return { instances: 0, qty: 0, abq: "—", activeDays: 0 };
    const instances = filteredInv.length;
    const qty = filteredInv.reduce((a, r) => a + (r.qty || 0), 0);
    const abq = instances > 0 ? (qty / instances).toFixed(1) : "—";
    const activeDays = new Set(filteredInv.map(r => r.date)).size;
    return { instances, qty, abq, activeDays };
  }, [filteredInv]);

  const freqData = useMemo(() => {
    const freq = {};
    filteredInv.forEach(r => { const q = r.qty || 0; freq[q] = (freq[q] || 0) + 1; });
    return freq;
  }, [filteredInv]);

  const dateData = useMemo(() => {
    if (!invoiceDateRange?.dates?.length) return [];
    const allDates = invoiceDateRange.dates;
    let dates = allDates;
    if (period === "CUSTOM" && dateFrom && dateTo) {
      dates = allDates.filter(d => d >= dateFrom && d <= dateTo);
    } else {
      const preset = SD_PERIODS.find(p => p.key === period);
      if (preset && preset.days) dates = allDates.slice(-preset.days);
    }
    const qtyByDate = {};
    filteredInv.forEach(r => { qtyByDate[r.date] = (qtyByDate[r.date] || 0) + (r.qty || 0); });
    return dates.map(d => ({ date: d, qty: qtyByDate[d] || 0 }));
  }, [invoiceDateRange, period, dateFrom, dateTo, filteredInv]);

  const dsCards = useMemo(() => {
    if (dsView === "All") return DS_LIST;
    return [dsView];
  }, [dsView]);

  // Compute period label showing actual date range
  const periodLabel = useMemo(() => {
    if (!dateData.length) return "";
    const fmt = d => { const dt = new Date(d + "T00:00:00"); return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }); };
    const from = fmt(dateData[0].date);
    const to = fmt(dateData[dateData.length - 1].date);
    return `${from} → ${to} (${dateData.length}D)`;
  }, [dateData]);

  return (
    <div>
      {/* Search bar */}
      <div style={{display:"flex",gap:8,marginBottom:16,position:"relative"}}>
        <div style={{position:"relative",flex:1,maxWidth:420}}>
          <input
            ref={searchRef}
            value={searchVal}
            onChange={e => { setSearchVal(e.target.value); setDropdownOpen(true); setHlIdx(-1); }}
            onKeyDown={e => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHlIdx(i => Math.min(i + 1, matches.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHlIdx(i => Math.max(i - 1, -1)); }
              else if (e.key === "Enter") {
                if (hlIdx >= 0 && hlIdx < matches.length) {
                  setSearchVal(matches[hlIdx].sku); setSkuId(matches[hlIdx].sku); setDropdownOpen(false); setHlIdx(-1);
                } else { doSearch(); }
              }
              else if (e.key === "Escape") { setDropdownOpen(false); setHlIdx(-1); }
            }}
            onFocus={() => { if (searchRef.current) searchRef.current.select(); if (searchVal) setDropdownOpen(true); }}
            onBlur={() => setTimeout(() => setDropdownOpen(false), 200)}
            placeholder="Search by SKU ID or name..."
            style={{...S.input, width:"100%", paddingRight:36}}
          />
          {dropdownOpen && matches.length > 0 && (
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,zIndex:10,boxShadow:"0 4px 12px rgba(0,0,0,0.1)",maxHeight:240,overflowY:"auto"}}>
              {matches.map((m, i) => (
                <div key={m.sku}
                  onMouseDown={() => { setSearchVal(m.sku); setSkuId(m.sku); setDropdownOpen(false); setHlIdx(-1); }}
                  onMouseEnter={() => setHlIdx(i)}
                  style={{padding:"6px 10px",cursor:"pointer",fontSize:11,borderBottom:`1px solid ${HR.border}`,display:"flex",justifyContent:"space-between",
                    background: i === hlIdx ? HR.surfaceLight : ""}}
                >
                  <span style={{fontWeight:600,color:HR.text}}>{m.sku}</span>
                  <span style={{color:HR.muted,fontSize:10,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => { if (searchRef.current) searchRef.current.select(); doSearch(); }} style={{...S.btn(true),padding:"5px 16px"}}>Search</button>
      </div>

      {/* Empty states */}
      {!skuId && (
        <div style={{textAlign:"center",padding:60,color:HR.muted}}>
          <div style={{fontSize:32,marginBottom:8}}>🔍</div>
          <div style={{fontSize:14}}>Enter a SKU ID or name to see details</div>
        </div>
      )}

      {skuId && !res && (
        <div style={{textAlign:"center",padding:60,color:HR.muted}}>
          <div style={{fontSize:32,marginBottom:8}}>⚠️</div>
          <div style={{fontSize:14}}>SKU not found in results</div>
          <div style={{fontSize:11,marginTop:4}}>Check the SKU ID or try searching again</div>
        </div>
      )}

      {skuId && res && (
        <>
          {/* SKU Header */}
          <div style={{...S.card,marginBottom:12,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:200}}>
              <div style={{fontSize:16,fontWeight:800,color:HR.text}}>{res.meta?.name || skuId}</div>
              <div style={{fontSize:11,color:HR.muted,marginTop:2}}>
                {res.meta?.sku || skuId} <span onClick={e => { e.stopPropagation(); copyText(res.meta?.sku || skuId); }} style={{cursor:"pointer",opacity:0.4,verticalAlign:"middle",marginLeft:2}} title="Copy SKU ID"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>
                {res.meta?.category && <> · {res.meta.category}</>}
                {res.meta?.brand && <> · {res.meta.brand}</>}
              </div>
            </div>
            <div style={{display:"flex",gap:4}}>
              {res.meta?.priceTag && <TagPill value={res.meta.priceTag} colorMap={PRICE_TAG_COLORS} />}
              {res.meta?.t150Tag && <TagPill value={res.meta.t150Tag} colorMap={TOPN_TAG_COLORS} />}
            </div>
          </div>

          {/* Period + DS pickers */}
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:`1px solid ${HR.border}`}}>
              {SD_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
                <button key={p.key} onClick={() => setPeriod(p.key)}
                  style={{padding:"4px 9px",background:period===p.key?HR.yellow:HR.white,color:period===p.key?HR.black:HR.muted,border:"none",borderRight:`1px solid ${HR.border}`,cursor:"pointer",fontSize:11,fontWeight:700}}>
                  {p.label}
                </button>
              ))}
            </div>
            {period === "CUSTOM" && (
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{...S.input,fontSize:10,padding:"3px 6px"}} />
                <span style={{color:HR.muted,fontSize:10}}>→</span>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{...S.input,fontSize:10,padding:"3px 6px"}} />
              </div>
            )}
            <button onClick={() => setPeriod(period === "CUSTOM" ? "L90D" : "CUSTOM")}
              style={S.btn(period === "CUSTOM")}>
              Custom
            </button>
            <div style={{width:1,height:20,background:HR.border,margin:"0 4px"}} />
            <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:`1px solid ${HR.border}`}}>
              {SD_DS_OPTS.map(d => {
                const di = DS_LIST.indexOf(d), col = di >= 0 ? DS_COLORS[di].header : HR.muted;
                const isActive = dsView === d;
                return (
                  <button key={d} onClick={() => setDsView(d)}
                    style={{padding:"4px 9px",background:isActive?(di>=0?DS_COLORS[di].header:HR.yellow):HR.white,color:isActive?HR.white:col,border:"none",borderRight:`1px solid ${HR.border}`,cursor:"pointer",fontSize:11,fontWeight:700}}>
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Period range label */}
          {periodLabel && (
            <div style={{fontSize:11,color:HR.muted,marginBottom:8,fontWeight:500}}>
              Showing: {periodLabel}
            </div>
          )}

          {/* Stats strip */}
          <StatStrip items={[
            { label: "Orders", value: stats.instances.toLocaleString(), color: HR.yellowDark },
            { label: "Quantity Sold", value: stats.qty.toLocaleString(), color: HR.green },
            { label: "Rate of Sale (qty sold on avg per day)", value: dateData.length > 0 ? (stats.qty / dateData.length).toFixed(2) : "—", color: HR.yellowDark },
            { label: "ABQ (qty sold on avg per order)", value: stats.abq, color: HR.yellowDark },
            { label: "Active Days", value: stats.activeDays, color: HR.yellowDark },
          ]} />

          {/* Charts section */}
          {(() => {
            const dsLabel = dsView === "All" ? "All DS Combined" : dsView;
            const di = DS_LIST.indexOf(dsView);
            const chartColor = di >= 0 ? DS_COLORS[di].header : HR.yellowDark;
            const storeMin = dsView !== "All" && res.stores?.[dsView] ? res.stores[dsView].min : null;
            const storeMax = dsView !== "All" && res.stores?.[dsView] ? res.stores[dsView].max : null;
            const totalOrders = Object.values(freqData).reduce((a, b) => a + b, 0);
            const totalQty = Object.entries(freqData).reduce((a, [q, c]) => a + parseFloat(q) * c, 0);
            const abq = totalOrders > 0 ? (totalQty / totalOrders).toFixed(1) : "—";
            return (
              <div style={{...S.card,marginBottom:16}}>
                {/* Shared chart header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:13,fontWeight:700,color:chartColor}}>{dsLabel}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                  <div>
                    <div style={{fontSize:11,fontWeight:600,color:HR.text,marginBottom:4}}>Order Qty Frequency</div>
                    <SingleFreqChart freq={freqData} color={chartColor} minVal={storeMin} maxVal={storeMax} />
                  </div>
                  <div>
                    <div style={{fontSize:11,fontWeight:600,color:HR.text,marginBottom:4}}>Daily Order Qty</div>
                    <DateOrderChart data={dateData} color={chartColor} minVal={storeMin} maxVal={storeMax} />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* DS Computation Cards + DC Card — all 5 DS in one row */}
          <div style={{display:"grid",gridTemplateColumns:`repeat(${dsCards.length}, 1fr)`,gap:10,marginBottom:12}}>
            {dsCards.map(ds => {
              const di = DS_LIST.indexOf(ds);
              return <StrategyCard key={ds} dsId={ds} dsIndex={di} storeData={res.stores?.[ds]} meta={res.meta} params={params} />;
            })}
          </div>
          <div style={{marginBottom:12}}>
            <DCCard dcData={res.dc} meta={res.meta} params={params} horizontal />
          </div>
        </>
      )}
    </div>
  );
}

function OverviewTab({ invoiceData, results, priceData, params, invoiceDateRange,
  period, setPeriod, dateFrom, setDateFrom, dateTo, setDateTo,
  store, setStore, drill, setDrill, onNavigateToSKU }) {

  const [sortKey, setSortKey] = useState("invMax");
  const [sortAsc, setSortAsc] = useState(false);

  const filteredInv = useMemo(() =>
    filterInvoiceByPeriod(invoiceData, period, dateFrom, dateTo, invoiceDateRange),
    [invoiceData, period, dateFrom, dateTo, invoiceDateRange]);

  const periodDays = useMemo(() => {
    const dates = new Set(filteredInv.map(r => r.date));
    return dates.size;
  }, [filteredInv]);

  // Build sold qty/value maps from filtered invoices
  const soldMaps = useMemo(() => {
    const qtyBySku = {}, valBySku = {}, qtyBySkuDs = {};
    filteredInv.forEach(r => {
      const key = r.sku;
      qtyBySku[key] = (qtyBySku[key] || 0) + r.qty;
      valBySku[key] = (valBySku[key] || 0) + r.qty * (priceData[key] || 0);
      const dsKey = key + "||" + r.ds;
      qtyBySkuDs[dsKey] = (qtyBySkuDs[dsKey] || 0) + r.qty;
    });
    return { qtyBySku, valBySku, qtyBySkuDs };
  }, [filteredInv, priceData]);

  // All result entries as array
  const allEntries = useMemo(() => {
    if (!results) return [];
    return Object.entries(results).map(([sku, r]) => ({ sku, ...r }));
  }, [results]);

  // Active SKUs from engine results
  const activeSkus = useMemo(() =>
    allEntries.filter(r => (r.meta?.status || "").trim().toLowerCase() === "active"),
    [allEntries]);

  // KPI computations
  const kpis = useMemo(() => {
    const activeCt = activeSkus.length;
    const soldSkus = new Set(filteredInv.map(r => r.sku));
    const skusSold = activeSkus.filter(r => soldSkus.has(r.sku)).length;
    const zeroSale = activeCt - skusSold;

    let invMin = 0, invMax = 0;
    if (results) {
      Object.entries(results).forEach(([sku, r]) => {
        const p = priceData[sku] || 0;
        DS_LIST.forEach(ds => {
          invMin += (r.stores[ds]?.min || 0) * p;
          invMax += (r.stores[ds]?.max || 0) * p;
        });
        invMin += (r.dc?.min || 0) * p;
        invMax += (r.dc?.max || 0) * p;
      });
    }
    return { activeCt, skusSold, zeroSale, invMin: Math.round(invMin), invMax: Math.round(invMax) };
  }, [activeSkus, filteredInv, results, priceData]);

  // Helper: get inv min/max for a SKU given store selection
  const getInv = useCallback((r, field) => {
    if (!r) return 0;
    if (store === "DC") return r.dc?.[field] || 0;
    if (store !== "All") return r.stores[store]?.[field] || 0;
    return DS_LIST.reduce((s, ds) => s + (r.stores[ds]?.[field] || 0), 0);
  }, [store]);

  // Helper: get sold qty for a SKU given store selection
  const getSoldQty = useCallback((sku) => {
    if (store === "DC") return 0; // DC has no direct sales
    if (store !== "All") return soldMaps.qtyBySkuDs[sku + "||" + store] || 0;
    return soldMaps.qtyBySku[sku] || 0;
  }, [store, soldMaps]);

  // Helper: get sold value for a SKU given store selection
  const getSoldVal = useCallback((sku) => {
    if (store === "DC") return 0;
    if (store !== "All") return (soldMaps.qtyBySkuDs[sku + "||" + store] || 0) * (priceData[sku] || 0);
    return soldMaps.valBySku[sku] || 0;
  }, [store, soldMaps, priceData]);

  // Coverage helper
  const getCov = useCallback((invVal, soldVal) => {
    if (!soldVal || soldVal <= 0 || !periodDays) return null;
    const dailySoldVal = soldVal / periodDays;
    return invVal / dailySoldVal;
  }, [periodDays]);

  // Build table rows based on drill level
  const tableData = useMemo(() => {
    if (!results) return [];

    if (drill === null) {
      // Category level
      const catMap = {};
      allEntries.forEach(r => {
        const cat = r.meta?.category || "Unknown";
        if (!catMap[cat]) catMap[cat] = { category: cat, skus: [] };
        catMap[cat].skus.push(r);
      });
      return Object.values(catMap).map(c => {
        const activeSks = c.skus.filter(r => (r.meta?.status || "").trim().toLowerCase() === "active");
        const soldSkuSet = new Set(filteredInv.map(r => r.sku));
        const skusSold = activeSks.filter(r => soldSkuSet.has(r.sku)).length;
        const zeroSale = activeSks.length - skusSold;
        let soldQty = 0, soldVal = 0, invMin = 0, invMax = 0;
        c.skus.forEach(r => {
          soldQty += getSoldQty(r.sku);
          soldVal += getSoldVal(r.sku);
          invMin += getInv(r, "min") * (priceData[r.sku] || 0);
          invMax += getInv(r, "max") * (priceData[r.sku] || 0);
        });
        const covMin = getCov(invMin, soldVal);
        const covMax = getCov(invMax, soldVal);
        return { key: c.category, label: c.category, activeSks: activeSks.length, skusSold, zeroSale, soldQty, soldVal, invMin, invMax, covMin, covMax, soldPerDay: periodDays > 0 ? soldVal / periodDays : 0 };
      }).sort((a, b) => { const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0; return sortAsc ? av - bv : bv - av; });
    }

    if (drill.type === "category") {
      // Brand level within a category
      const brandMap = {};
      allEntries.filter(r => (r.meta?.category || "Unknown") === drill.value).forEach(r => {
        const brand = r.meta?.brand || "Unknown";
        if (!brandMap[brand]) brandMap[brand] = { brand, skus: [] };
        brandMap[brand].skus.push(r);
      });
      return Object.values(brandMap).map(b => {
        const activeSks = b.skus.filter(r => (r.meta?.status || "").trim().toLowerCase() === "active");
        const soldSkuSet = new Set(filteredInv.map(r => r.sku));
        const skusSold = activeSks.filter(r => soldSkuSet.has(r.sku)).length;
        const zeroSale = activeSks.length - skusSold;
        let soldQty = 0, soldVal = 0, invMin = 0, invMax = 0;
        b.skus.forEach(r => {
          soldQty += getSoldQty(r.sku);
          soldVal += getSoldVal(r.sku);
          invMin += getInv(r, "min") * (priceData[r.sku] || 0);
          invMax += getInv(r, "max") * (priceData[r.sku] || 0);
        });
        const covMin = getCov(invMin, soldVal);
        const covMax = getCov(invMax, soldVal);
        return { key: b.brand, label: b.brand, activeSks: activeSks.length, skusSold, zeroSale, soldQty, soldVal, invMin, invMax, covMin, covMax, soldPerDay: periodDays > 0 ? soldVal / periodDays : 0 };
      }).sort((a, b) => { const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0; return sortAsc ? av - bv : bv - av; });
    }

    if (drill.type === "brand") {
      // SKU level within a brand+category
      return allEntries
        .filter(r => (r.meta?.category || "Unknown") === drill.category && (r.meta?.brand || "Unknown") === drill.value)
        .map(r => {
          const soldQty = getSoldQty(r.sku);
          const soldVal = getSoldVal(r.sku);
          const invMin = getInv(r, "min") * (priceData[r.sku] || 0);
          const invMax = getInv(r, "max") * (priceData[r.sku] || 0);
          const covMin = getCov(invMin, soldVal);
          const covMax = getCov(invMax, soldVal);
          const dailyAvg = store === "DC" ? 0 : store !== "All" ? (r.stores[store]?.dailyAvg || 0) : DS_LIST.reduce((s, ds) => s + (r.stores[ds]?.dailyAvg || 0), 0);
          const abq = store !== "All" && store !== "DC" ? (r.stores[store]?.abq || 0) : 0;
          const mvTag = store === "DC" ? (r.dc?.mvTag || "—") : store !== "All" ? (r.stores[store]?.mvTag || "—") : (r.dc?.mvTag || "—");
          return { key: r.sku, sku: r.sku, label: r.meta?.name || r.sku, meta: r.meta, mvTag, priceTag: r.meta?.priceTag || "No Price", dailyAvg, abq, soldQty, soldVal, invMin, invMax, covMin, covMax, stores: r.stores, dc: r.dc, soldPerDay: periodDays > 0 ? soldVal / periodDays : 0 };
        }).sort((a, b) => { const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0; return sortAsc ? av - bv : bv - av; });
    }
    return [];
  }, [results, allEntries, drill, filteredInv, getSoldQty, getSoldVal, getInv, getCov, priceData, store, sortKey, sortAsc]);

  const thS = { ...S.th, fontSize: 10, padding: "6px 8px", textAlign: "center", position: "sticky", top: 0, zIndex: 2, background: "#F5E6C8", color: HR.text, borderBottom: "2px solid " + HR.yellow };
  const sortTh = (label, key) => (
    <th style={{...thS, cursor: "pointer"}} onClick={() => { if (sortKey === key) setSortAsc(!sortAsc); else { setSortKey(key); setSortAsc(false); } }}>
      {label} {sortKey === key ? (sortAsc ? "▲" : "▼") : ""}
    </th>
  );
  const tdC = { ...S.td, fontSize: 11, padding: "5px 8px", textAlign: "center", fontVariantNumeric: "tabular-nums" };

  // Period label for "Showing" display
  const ovPeriodLabel = useMemo(() => {
    if (!filteredInv.length) return "";
    const dates = [...new Set(filteredInv.map(r => r.date))].sort();
    if (!dates.length) return "";
    const fmt = d => { const dt = new Date(d + "T00:00:00"); return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }); };
    return `${fmt(dates[0])} → ${fmt(dates[dates.length - 1])} (${dates.length}D)`;
  }, [filteredInv]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 6, marginBottom: 8 }}>
        {[
          { label: "Active SKUs", value: kpis.activeCt, color: HR.green },
          { label: "SKUs Sold", value: kpis.skusSold, color: HR.yellowDark },
          { label: "Zero Sale SKUs", value: kpis.zeroSale, color: "#C0392B" },
          { label: "Inv Value Min", value: fmtVal(kpis.invMin), color: HR.green },
          { label: "Inv Value Max", value: fmtVal(kpis.invMax), color: HR.yellowDark },
        ].map(c => (
          <div key={c.label} style={{ background: HR.surface, borderRadius: 8, padding: "12px 14px", border: `1px solid ${HR.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 11, color: HR.muted, marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Period picker row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {OV_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            style={S.btn(period === p.key)}>{p.label}</button>
        ))}
        <button onClick={() => setPeriod("CUSTOM")} style={S.btn(period === "CUSTOM")}>Custom</button>
        {period === "CUSTOM" && (
          <>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ ...S.input, fontSize: 11, padding: "3px 6px" }} />
            <span style={{ color: HR.muted, fontSize: 11 }}>to</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ ...S.input, fontSize: 11, padding: "3px 6px" }} />
          </>
        )}
        <span style={{ fontSize: 10, color: HR.muted, marginLeft: 4 }}>
          Data: {invoiceDateRange.min || "—"} → {invoiceDateRange.max || "—"}
        </span>
        <select value={store} onChange={e => setStore(e.target.value)}
          style={{ ...S.input, fontSize: 11, padding: "4px 8px", marginLeft: "auto" }}>
          <option value="All">All Stores</option>
          {DS_LIST.map(ds => <option key={ds} value={ds}>{ds}</option>)}
          <option value="DC">DC</option>
        </select>
        <span style={{ fontSize: 10, color: HR.muted, fontWeight: 600 }}>{periodDays}D</span>
      </div>

      {/* Showing period label */}
      {ovPeriodLabel && (
        <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:500}}>Showing: {ovPeriodLabel}</div>
      )}

      {/* Breadcrumb */}
      {drill !== null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13 }}>
          <button onClick={() => {
            if (drill.type === "brand") setDrill({ type: "category", value: drill.category });
            else setDrill(null);
          }}
            style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${HR.yellow}`, background: HR.yellow, color: HR.black, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>← Back</button>
          <span style={{ color: HR.yellowDark, cursor: "pointer", fontWeight: 600 }} onClick={() => setDrill(null)}>All Categories</span>
          {drill.type === "category" && (
            <><span style={{ color: HR.muted, fontSize: 16 }}>›</span><span style={{ fontWeight: 700, color: HR.text }}>{drill.value}</span></>
          )}
          {drill.type === "brand" && (
            <>
              <span style={{ color: HR.muted, fontSize: 16 }}>›</span>
              <span style={{ color: HR.yellowDark, cursor: "pointer", fontWeight: 600 }} onClick={() => setDrill({ type: "category", value: drill.category })}>{drill.category}</span>
              <span style={{ color: HR.muted, fontSize: 16 }}>›</span>
              <span style={{ fontWeight: 700, color: HR.text }}>{drill.value}</span>
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", borderRadius: 8, border: `1px solid ${HR.border}` }}>
        <table style={S.table}>
          <thead>
            {drill?.type === "brand" ? (
              <tr>
                <th style={{...thS, textAlign:"left"}}>SKU</th>
                <th style={thS}>Movement</th>
                <th style={thS}>Price Tag</th>
                {sortTh("Sold Val/Day", "soldPerDay")}
                {sortTh("Inv Min", "invMin")}
                {sortTh("Inv Max", "invMax")}
                {sortTh("Cov Min", "covMin")}
                {sortTh("Cov Max", "covMax")}
              </tr>
            ) : (
              <tr>
                <th style={{...thS, textAlign:"left"}}>{drill === null ? "Category" : "Brand"}</th>
                {sortTh("Active SKUs", "activeSks")}
                {sortTh("SKUs Sold", "skusSold")}
                {sortTh("Zero Sale", "zeroSale")}
                {sortTh("Sold Val/Day", "soldPerDay")}
                {sortTh("Inv Min", "invMin")}
                {sortTh("Inv Max", "invMax")}
                {sortTh("Cov Min", "covMin")}
                {sortTh("Cov Max", "covMax")}
              </tr>
            )}
          </thead>
          <tbody>
            {tableData.length === 0 && (
              <tr><td colSpan={10} style={{ ...tdC, color: HR.muted, padding: 30 }}>No data available</td></tr>
            )}
            {drill?.type === "brand" ? (
              tableData.map(row => {
                return (
                  <tr key={row.key} style={{ cursor: "pointer" }} onClick={() => onNavigateToSKU(row.sku)}
                    onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
                    onMouseLeave={e => e.currentTarget.style.background = ""}>
                    <td style={{...tdC, textAlign:"left"}}>
                      <div style={{ fontWeight: 600, fontSize: 11 }}>{row.label}</div>
                      <div style={{ fontSize: 9, color: HR.muted }}>{row.sku} <span onClick={e => { e.stopPropagation(); copyText(row.sku); }} style={{cursor:"pointer",opacity:0.4,verticalAlign:"middle",marginLeft:2}} title="Copy SKU ID"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span></div>
                    </td>
                    <td style={tdC}><MovTag value={row.mvTag} /></td>
                    <td style={tdC}><TagPill value={row.priceTag} colorMap={PRICE_TAG_COLORS} /></td>
                    <td style={tdC}>{fmtVal(row.soldPerDay)}</td>
                    <td style={tdC}>{fmtVal(row.invMin)}</td>
                    <td style={tdC}>{fmtVal(row.invMax)}</td>
                    <td style={tdC}>{fmtCov(row.covMin)}</td>
                    <td style={tdC}>{fmtCov(row.covMax)}</td>
                  </tr>
                );
              })
            ) : (
              tableData.map(row => {
                return (
                  <tr key={row.key} style={{ cursor: "pointer" }}
                    onClick={() => {
                      if (drill === null) setDrill({ type: "category", value: row.key });
                      else if (drill.type === "category") setDrill({ type: "brand", value: row.key, category: drill.value });
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
                    onMouseLeave={e => e.currentTarget.style.background = ""}>
                    <td style={{ ...tdC, fontWeight: 600, textAlign:"left" }}>{row.label}</td>
                    <td style={tdC}>{fmtNum(row.activeSks)}</td>
                    <td style={tdC}>{fmtNum(row.skusSold)}</td>
                    <td style={{ ...tdC, color: row.zeroSale > 0 ? "#C0392B" : HR.muted }}>{fmtNum(row.zeroSale)}</td>
                    <td style={tdC}>{fmtVal(row.soldPerDay)}</td>
                    <td style={tdC}>{fmtVal(row.invMin)}</td>
                    <td style={tdC}>{fmtVal(row.invMax)}</td>
                    <td style={tdC}>{fmtCov(row.covMin)}</td>
                    <td style={tdC}>{fmtCov(row.covMax)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Stock Health Monitor ────────────────────────────────────────────────────
const HEALTH_ORDER = { red: 0, amber: 1, green: 2, blue: 3 };
const HEALTH_COLOR = {
  red:   { bg: "#FEE2E2", text: "#B91C1C", label: "🔴 Below Min" },
  amber: { bg: "#FEF3C7", text: "#92400E", label: "🟡 Approaching Min" },
  green: { bg: "#D1FAE5", text: "#065F46", label: "🟢 Healthy" },
  blue:  { bg: "#DBEAFE", text: "#1E40AF", label: "🔵 Overstocked" },
};

function getHealth(effective, min, max) {
  if (effective <= min) return "red";
  if (max > min && effective <= min + (max - min) * 0.3) return "amber";
  if (effective > max) return "blue";
  return "green";
}

function StockHealthTab({ results, params, stockData, setStockData, uploadedAt, setUploadedAt, saveTeamData }) {
  const [selectedDS, setSelectedDS] = useState("DS01");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterCat, setFilterCat] = useState("All");
  const [filterBrand, setFilterBrand] = useState("All");
  const [sortField, setSortField] = useState("health");
  const [sortAsc, setSortAsc] = useState(true);

  const DS_AND_DC = [...DS_LIST, "DC"];

  // Location name → DS mapping (for CSV parsing)
  const LOCATION_CSV_MAP = {
    "DS01 Sarjapur": "DS01", "DS02 Bileshivale": "DS02", "DS03 Kengeri": "DS03",
    "DS04 Chikkabanavara": "DS04", "DS05 Basavanapura": "DS05", "DC01 Rampura": "DC",
    "DS01": "DS01", "DS02": "DS02", "DS03": "DS03", "DS04": "DS04", "DS05": "DS05", "DC": "DC",
  };

  // Handle CSV upload — supports Zoho Inventory Summary format
  const handleStockCSV = useCallback(async (e, dsOverride) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCSV(text);
    const newData = { ...stockData };
    let count = 0;
    for (const row of rows) {
      const sku = (row['sku'] || row['SKU'] || '').trim();
      if (!sku) continue;
      // Determine location from row or from dsOverride
      const locName = row['location_name'] || row['Location'] || dsOverride || '';
      const ds = LOCATION_CSV_MAP[locName] || (dsOverride ? LOCATION_CSV_MAP[dsOverride] || dsOverride : null);
      if (!ds) continue;
      const stockOnHand = Math.max(0, parseFloat(row['quantity_available'] || row['stock_on_hand'] || 0));
      const inTransit = Math.max(0, parseFloat(row['quantity_in_transit'] || 0));
      if (!newData[sku]) newData[sku] = {};
      newData[sku][ds] = { stock_on_hand: stockOnHand, quantity_in_transit: inTransit };
      count++;
    }
    const ts = new Date();
    setStockData(newData);
    setUploadedAt(ts);
    saveTeamData({ stockData: newData, stockUploadedAt: ts.toISOString() });
    e.target.value = '';
    return count;
  }, [stockData, saveTeamData]);

  // Build per-DS summary counts
  const summary = useMemo(() => {
    const s = {};
    for (const ds of DS_AND_DC) s[ds] = { red: 0, amber: 0, green: 0, blue: 0 };
    if (!results) return s;
    for (const [sku, res] of Object.entries(results)) {
      for (const ds of DS_LIST) {
        const storeRes = res.stores?.[ds];
        if (!storeRes || (!storeRes.min && !storeRes.max)) continue;
        const liveData = stockData[sku]?.[ds] || { stock_on_hand: 0, quantity_in_transit: 0 };
        const effective = liveData.stock_on_hand + liveData.quantity_in_transit;
        s[ds][getHealth(effective, storeRes.min, storeRes.max)]++;
      }
      const dcRes = res.dc;
      if (dcRes?.min || dcRes?.max) {
        const liveData = stockData[sku]?.["DC"] || { stock_on_hand: 0, quantity_in_transit: 0 };
        const effective = liveData.stock_on_hand + liveData.quantity_in_transit;
        s["DC"][getHealth(effective, dcRes.min || 0, dcRes.max || 0)]++;
      }
    }
    return s;
  }, [stockData, results]);

  // Build SKU rows for selected DS
  const skuRows = useMemo(() => {
    if (!results) return [];
    const isDC = selectedDS === "DC";
    return Object.entries(results).flatMap(([sku, res]) => {
      const minMax = isDC ? res.dc : res.stores?.[selectedDS];
      if (!minMax || (!minMax.min && !minMax.max)) return [];
      const liveData = stockData[sku]?.[selectedDS] || { stock_on_hand: 0, quantity_in_transit: 0 };
      const physical = liveData.stock_on_hand;
      const inTransit = liveData.quantity_in_transit;
      const effective = physical + inTransit;
      const dailyAvg = isDC ? 0 : (res.stores?.[selectedDS]?.dailyAvg || 0);
      const doc = dailyAvg > 0 ? effective / dailyAvg : null;
      const health = getHealth(effective, minMax.min || 0, minMax.max || 0);
      return [{ sku, health, physical, inTransit, effective, min: minMax.min || 0, max: minMax.max || 0, dailyAvg, doc, name: res.meta?.name || sku, category: res.meta?.category || "—", brand: res.meta?.brand || "—" }];
    });
  }, [results, selectedDS, stockData]);

  const categories = useMemo(() => ["All", ...new Set(skuRows.map(r => r.category).filter(Boolean).sort())], [skuRows]);
  const brands = useMemo(() => ["All", ...new Set(skuRows.map(r => r.brand).filter(Boolean).sort())], [skuRows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return skuRows.filter(r => {
      if (filterStatus !== "All" && r.health !== filterStatus.toLowerCase()) return false;
      if (filterCat !== "All" && r.category !== filterCat) return false;
      if (filterBrand !== "All" && r.brand !== filterBrand) return false;
      if (q && !r.sku.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      if (sortField === "health") {
        const hDiff = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
        if (hDiff !== 0) return hDiff;
        return (a.doc ?? Infinity) - (b.doc ?? Infinity);
      }
      const av = a[sortField] ?? 0, bv = b[sortField] ?? 0;
      return sortAsc ? av - bv : bv - av;
    });
  }, [skuRows, search, filterStatus, filterCat, filterBrand, sortField, sortAsc]);

  const toggleSort = (field) => { if (sortField === field) setSortAsc(!sortAsc); else { setSortField(field); setSortAsc(true); } };
  const sortArrow = (field) => sortField === field ? (sortAsc ? " ▲" : " ▼") : "";
  const th = (label, field, right) => (
    <th onClick={() => field && toggleSort(field)} style={{ padding: "6px 8px", fontSize: 10, fontWeight: 600, color: HR.muted, background: "#F5E6C8", textAlign: right ? "right" : "left", cursor: field ? "pointer" : "default", borderBottom: "2px solid " + HR.yellow, whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 2 }}>
      {label}{sortArrow(field)}
    </th>
  );

  const hasStock = Object.keys(stockData).length > 0;
  const uploadLabel = uploadedAt ? uploadedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>

      {/* ── Sticky top: DS cards + upload ── */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: HR.bg, paddingBottom: 8 }}>
        {/* Upload row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: HR.muted }}>
            {uploadLabel ? <>Stock snapshot: <span style={{ fontWeight: 600, color: HR.text }}>{uploadLabel}</span></> : <span style={{ color: "#B91C1C" }}>No stock data — upload Inventory Summary CSVs below</span>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: HR.muted }}>Upload Zoho Inventory Summary per location:</span>
            {DS_AND_DC.map((ds) => {
              const di = DS_LIST.indexOf(ds);
              const accent = di >= 0 ? DS_COLORS[di].header : DC_COLOR.header;
              return (
                <label key={ds} title={`Upload ${ds} Inventory Summary CSV`}
                  style={{ background: accent, color: "#fff", padding: "4px 8px", borderRadius: 5, cursor: "pointer", fontSize: 10, fontWeight: 700 }}>
                  ⬆ {ds}<input type="file" accept=".csv" style={{ display: "none" }} onChange={e => handleStockCSV(e, ds)} />
                </label>
              );
            })}
          </div>
        </div>

        {/* DS summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 6 }}>
          {DS_AND_DC.map(ds => {
            const s = summary[ds] || { red: 0, amber: 0, green: 0, blue: 0 };
            const isSelected = selectedDS === ds;
            const di = DS_LIST.indexOf(ds);
            const accent = di >= 0 ? DS_COLORS[di].header : DC_COLOR.header;
            return (
              <div key={ds} onClick={() => setSelectedDS(ds)}
                style={{ background: isSelected ? accent + "18" : HR.surface, border: `2px solid ${isSelected ? accent : HR.border}`, borderRadius: 8, padding: "8px 10px", cursor: "pointer" }}>
                <div style={{ fontWeight: 800, fontSize: 12, color: accent, marginBottom: 4 }}>{ds}</div>
                {[["red","🔴"],["amber","🟡"],["green","🟢"],["blue","🔵"]].map(([h, icon]) => (
                  <div key={h} style={{ fontSize: 10, display: "flex", justifyContent: "space-between", lineHeight: 1.6 }}>
                    <span>{icon}</span>
                    <span style={{ fontWeight: s[h] > 0 && h === "red" ? 700 : 400, color: s[h] > 0 && h === "red" ? "#B91C1C" : HR.muted }}>{s[h]}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU ID or name…" style={{ ...S.input, flex: 1, minWidth: 200, fontSize: 11 }} />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...S.input, fontSize: 11 }}>
          <option>All</option>
          <option value="red">🔴 Below Min</option>
          <option value="amber">🟡 Approaching</option>
          <option value="green">🟢 Healthy</option>
          <option value="blue">🔵 Overstocked</option>
        </select>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...S.input, fontSize: 11 }}>
          {categories.map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} style={{ ...S.input, fontSize: 11 }}>
          {brands.map(b => <option key={b}>{b}</option>)}
        </select>
        <span style={{ fontSize: 11, color: HR.muted, whiteSpace: "nowrap" }}>{filtered.length} SKUs</span>
      </div>

      {/* ── SKU table ── */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", borderRadius: 8, border: `1px solid ${HR.border}` }}>
        <table style={{ ...S.table, minWidth: 720 }}>
          <thead>
            <tr>
              {th("SKU / Name", null, false)}
              {th("Physical", "physical", true)}
              {th("In Transit", "inTransit", true)}
              {th("Effective", "effective", true)}
              {th("Min", "min", true)}
              {th("Max", "max", true)}
              {th("DOC", "doc", true)}
              {th("Status", "health", false)}
            </tr>
          </thead>
          <tbody>
            {!results && <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", color: HR.muted }}>Run the model first to see stock health.</td></tr>}
            {results && !hasStock && <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", color: HR.muted }}>Upload Inventory Summary CSVs (one per location) to see stock health.</td></tr>}
            {filtered.map(row => {
              const hc = HEALTH_COLOR[row.health];
              return (
                <tr key={row.sku} onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight} onMouseLeave={e => e.currentTarget.style.background = ""}>
                  <td style={{ padding: "5px 8px", borderTop: `1px solid ${HR.border}`, maxWidth: 260 }}>
                    <div style={{ fontWeight: 600, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</div>
                    <div style={{ fontSize: 9, color: HR.muted }}>{row.sku}</div>
                  </td>
                  {[row.physical, row.inTransit, row.effective, row.min, row.max].map((v, i) => (
                    <td key={i} style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11, borderTop: `1px solid ${HR.border}`, fontWeight: i === 2 ? 700 : 400 }}>{v}</td>
                  ))}
                  <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, borderTop: `1px solid ${HR.border}`, fontWeight: 600, color: row.doc !== null && row.doc < 1 ? "#B91C1C" : HR.text }}>
                    {row.doc !== null ? row.doc.toFixed(1) + "D" : "—"}
                  </td>
                  <td style={{ padding: "5px 8px", borderTop: `1px solid ${HR.border}` }}>
                    <span style={{ background: hc.bg, color: hc.text, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" }}>{hc.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
// Lightweight copy-to-clipboard with toast feedback
let _toastTimer = null;
let _setToastMsg = null;
function copyText(text) {
  navigator.clipboard.writeText(text);
  if (_setToastMsg) { _setToastMsg("Copied to clipboard"); clearTimeout(_toastTimer); _toastTimer = setTimeout(() => _setToastMsg(""), 1500); }
}

export default function App(){
  const [tab,setTab]=useState("overview"),[pendingTab,setPending]=useState(null);
  const [toastMsg, setToastMsg] = useState("");
  _setToastMsg = setToastMsg;
  const [invoiceData,setInv]=useState([]),[skuMaster,setSKU]=useState({});
  const [minReqQty,setMRQ]=useState({}),[newSKUQty,setNSQ]=useState({});
  const [deadStock,setDead]=useState(new Set()),[priceData,setPrice]=useState({});
  const [results,setResults]=useState(null),[loading,setLoading]=useState(false),[dataLoaded,setLoaded]=useState(false);
  const allUploaded=invoiceData.length>0&&Object.keys(skuMaster).length>0&&Object.keys(priceData).length>0&&Object.keys(minReqQty).length>0&&Object.keys(newSKUQty).length>0&&deadStock.size>0;
  /* Old dashboard filter state removed — old Dashboard tab code was removed */
  const [params,setParams]=useState(DEFAULT_PARAMS),[savedParams,setSaved]=useState(DEFAULT_PARAMS);
  const [newBrand,setNewBrand]=useState(""),[newBrandDays,setNBD]=useState(1);
  const [isAdmin,setIsAdmin]=useState(()=>localStorage.getItem("adminSession")==="true");
  const [showLoginModal,setShowLoginModal]=useState(false);
  const [publishStatus,setPublishStatus]=useState(null);
  const [coreOverrides,setCoreOverrides]=useState({});
  const [simOverrides, setSimOverrides] = useState({});
  const [simOverrideCount, setSimOverrideCount] = useState(0);
  const [simResults, setSimResults] = useState({ tool: [], ovr: [] });
  const [simLoading, setSimLoading] = useState(true);
  const [simDays, setSimDays] = useState(15);
  const [stockData, setStockData] = useState({});       // persists across tab switches
  const [stockUploadedAt, setStockUploadedAt] = useState(null);
  const [zohoSync, setZohoSync] = useState({ invoices: null, skuMaster: null, prices: null }); // {status, message, ts}
  const [invoiceUploadedThisSession, setInvoiceUploadedThisSession] = useState(false);
  const [zohoInvFrom, setZohoInvFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 5); return d.toISOString().slice(0,10);
  });
  const [zohoInvTo, setZohoInvTo] = useState(() => new Date().toISOString().slice(0,10));
  const [syncStatus,setSyncStatus]=useState("idle"); // "idle" | "saving" | "saved" | "error"
  /* Old Insights tab state removed — replaced by SKU Detail tab */
  // ── Overview tab state ────────────────────────────────────────────────────
  const [ovPeriod, setOvPeriod] = useState("L90D");
  const [ovDateFrom, setOvDateFrom] = useState("");
  const [ovDateTo, setOvDateTo] = useState("");
  const [ovStore, setOvStore] = useState("All");
  const [ovDrill, setOvDrill] = useState(null);
  // ── SKU Detail tab state ──────────────────────────────────────────────────
  const [sdSku, setSdSku] = useState("");
  const [sdSearch, setSdSearch] = useState("");
  const [sdPeriod, setSdPeriod] = useState("L90D");
  const [sdDateFrom, setSdDateFrom] = useState("");
  const [sdDateTo, setSdDateTo] = useState("");
  const [sdDsView, setSdDsView] = useState("All");
  const [previewState, setPreviewState] = useState("idle");
  const runPreviewRef = useRef(()=>{});
  const runPreviewFn = runPreviewRef.current;

  // ── Supabase: load params + overrides on mount ──────────────────────────────
  useEffect(()=>{
    (async()=>{
      // Load params from Supabase
      const sbParams = await loadFromSupabase("params","global");
      if(sbParams){
        const p={...DEFAULT_PARAMS,...sbParams};
        setParams(p);setSaved(p);
        LS.set("params",JSON.stringify(p));
      } else {
        // Fallback to localStorage
        const lp=LS.get("params");
        if(lp){const p={...DEFAULT_PARAMS,...JSON.parse(lp.value)};setParams(p);setSaved(p);}
      }

      // Load overrides from Supabase
      const sbOverrides = await loadFromSupabase("overrides","global");
      if(sbOverrides){
        setCoreOverrides(sbOverrides);
        LS.set("coreOverrides",JSON.stringify(sbOverrides));
      } else {
        // Fallback to localStorage
        try{const v=localStorage.getItem("coreOverrides");if(v)setCoreOverrides(JSON.parse(v));}catch{}
      }
    })();
  },[]);

  // ── saveCoreOverrides: writes to both Supabase + localStorage ───────────────
  const saveCoreOverrides = useCallback(async(ov)=>{
    setCoreOverrides(ov);
    LS.set("coreOverrides",JSON.stringify(ov));
    setSyncStatus("saving");
    const ok = await saveToSupabase("overrides","global",ov);
    setSyncStatus(ok?"saved":"error");
    setTimeout(()=>setSyncStatus("idle"),3000);
  },[]);

  const handleLogout=()=>{localStorage.removeItem("adminSession");setIsAdmin(false);};

  const hasChanges=JSON.stringify(params)!==JSON.stringify(savedParams);
  const changedCount=[params.overallPeriod!==savedParams.overallPeriod,params.recencyWindow!==savedParams.recencyWindow,JSON.stringify(params.recencyWt)!==JSON.stringify(savedParams.recencyWt),JSON.stringify(params.movIntervals)!==JSON.stringify(savedParams.movIntervals),JSON.stringify(params.priceTiers)!==JSON.stringify(savedParams.priceTiers),params.spikeMultiplier!==savedParams.spikeMultiplier,params.spikePctFrequent!==savedParams.spikePctFrequent,params.spikePctOnce!==savedParams.spikePctOnce,params.maxDaysBuffer!==savedParams.maxDaysBuffer,params.abqMaxMultiplier!==savedParams.abqMaxMultiplier,JSON.stringify(params.baseMinDays)!==JSON.stringify(savedParams.baseMinDays),JSON.stringify(params.brandBuffer)!==JSON.stringify(savedParams.brandBuffer),JSON.stringify(params.newDSList)!==JSON.stringify(savedParams.newDSList),params.newDSFloorTopN!==savedParams.newDSFloorTopN,params.activeDSCount!==savedParams.activeDSCount,JSON.stringify(params.dcMult)!==JSON.stringify(savedParams.dcMult),JSON.stringify(params.dcDeadMult)!==JSON.stringify(savedParams.dcDeadMult),JSON.stringify(params.categoryStrategies)!==JSON.stringify(savedParams.categoryStrategies),JSON.stringify(params.percentileCover)!==JSON.stringify(savedParams.percentileCover),JSON.stringify(params.fixedUnitFloor)!==JSON.stringify(savedParams.fixedUnitFloor),JSON.stringify(params.brandLeadTimeDays)!==JSON.stringify(savedParams.brandLeadTimeDays)].filter(Boolean).length;

  // ── Load team data (invoice, SKU master etc.) ───────────────────────────────
  useEffect(()=>{
    (async()=>{
      // Try Supabase team_data first
      const sbData = await loadFromSupabase("team_data","global");
if(sbData?.invoiceData?.length&&sbData?.skuMaster){
  setInv(sbData.invoiceData);setSKU(sbData.skuMaster);
  if(sbData.minReqQty)setMRQ(sbData.minReqQty);
  if(sbData.newSKUQty)setNSQ(sbData.newSKUQty);
  if(sbData.deadStock)setDead(new Set(sbData.deadStock));
  if(sbData.priceData)setPrice(sbData.priceData);
  if(sbData.stockData)setStockData(sbData.stockData);
  if(sbData.stockUploadedAt)setStockUploadedAt(new Date(sbData.stockUploadedAt));
  setLoaded(true);

  // Load params first, then run engine with correct params
  const sbParams = await loadFromSupabase("params","global");
  const activeParams = sbParams ? {...DEFAULT_PARAMS,...sbParams} : DEFAULT_PARAMS;
  setParams(activeParams);setSaved(activeParams);

  setTimeout(()=>{
    try{
      const raw=runEngine(sbData.invoiceData,sbData.skuMaster,sbData.minReqQty||{},sbData.priceData||{},new Set(sbData.deadStock||[]),sbData.newSKUQty||{},activeParams);
      setResults(raw);
    }catch(err){console.error("Auto-run error:",err);}
  },100);
  return;
}
      // Fallback: try public/team-data.json
      try{
  const res=await fetch("/team-data.json?v="+Date.now());
  if(res.ok){
    const bundle=await res.json();
    if(bundle.invoiceData?.length&&bundle.skuMaster){
      setInv(bundle.invoiceData);setSKU(bundle.skuMaster);
      if(bundle.minReqQty)setMRQ(bundle.minReqQty);
      if(bundle.newSKUQty)setNSQ(bundle.newSKUQty);
      if(bundle.deadStock)setDead(new Set(bundle.deadStock));
      if(bundle.priceData)setPrice(bundle.priceData);
      setLoaded(true);

      // Load params first, then run engine with correct params
      const sbParams = await loadFromSupabase("params","global");
      const activeParams = sbParams ? {...DEFAULT_PARAMS,...sbParams} : DEFAULT_PARAMS;
      setParams(activeParams);setSaved(activeParams);

      setTimeout(()=>{
        try{
          const raw=runEngine(bundle.invoiceData,bundle.skuMaster,bundle.minReqQty||{},bundle.priceData||{},new Set(bundle.deadStock||[]),bundle.newSKUQty||{},activeParams);
          setResults(raw);
        }catch(err){console.error("Auto-run error:",err);}
      },100);
      return;
    }
  }
}catch(e){}
      // Fallback: localStorage
      try{
        const keys=["invoiceData","skuMaster","minReqQty","newSKUQty","deadStock","priceData"];
        const vals=keys.map(k=>LS.get(k));
        const [inv,sku,mrq,nsq,ds,pd]=vals;
        if(inv)setInv(JSON.parse(inv.value));
        if(sku)setSKU(JSON.parse(sku.value));
        if(mrq)setMRQ(JSON.parse(mrq.value));
        if(nsq)setNSQ(JSON.parse(nsq.value));
        if(ds)setDead(new Set(JSON.parse(ds.value)));
        if(pd)setPrice(JSON.parse(pd.value));
        if(inv&&sku)setLoaded(true);
      }catch(e){}
    })();
  },[]);


  const triggerModel=(inv,sku,mrq,nsq,ds,pd,p)=>{
    setLoading(true);
    setTimeout(()=>{
      try{
        const raw=runEngine(inv,sku,mrq,pd,ds,nsq,p);
        const merged={...raw};
        Object.entries(coreOverrides).forEach(([skuId,dsList])=>{
          if(!merged[skuId])return;
          const newStores={...merged[skuId].stores};
          Object.entries(dsList).forEach(([dsId,ov])=>{
            if(!newStores[dsId])return;
            newStores[dsId]={...newStores[dsId],
              min:Math.max(newStores[dsId].min,ov.min),
              max:Math.max(newStores[dsId].max,ov.max)
            };
          });
          merged[skuId]={...merged[skuId],stores:newStores};
        });
        setResults(merged);
        setTab("overview");
      }catch(err){console.error(err);alert("Model error: "+err.message);}
      setLoading(false);
    },50);
  };

  // ── Auto-save: saves team data to Supabase immediately on any data change ────
  // Pass overrides for whichever field just changed (state hasn't updated yet)
  const saveTeamData = useCallback(async (overrides = {}) => {
    const bundle = {
      invoiceData: overrides.invoiceData ?? invoiceData,
      skuMaster:   overrides.skuMaster   ?? skuMaster,
      minReqQty:   overrides.minReqQty   ?? minReqQty,
      newSKUQty:   overrides.newSKUQty   ?? newSKUQty,
      deadStock:   [...(overrides.deadStock ?? deadStock)],
      priceData:   overrides.priceData   ?? priceData,
      stockData:   overrides.stockData   ?? stockData,
      stockUploadedAt: overrides.stockUploadedAt ?? stockUploadedAt?.toISOString() ?? null,
      publishedAt: new Date().toISOString(),
    };
    await saveToSupabase("team_data", "global", bundle);
  }, [invoiceData, skuMaster, minReqQty, newSKUQty, deadStock, priceData, stockData, stockUploadedAt]);

  const handleInvoice=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;setLoading(true);
    const rows=parseCSV(await file.text());
    // Replace entirely — no merge, no rolling cap. Store all data Admin provides.
    const filtered=rows.filter(r=>["Closed","Overdue"].includes(r["Invoice Status"]||"")).map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0)})).filter(r=>r.date&&r.sku&&r.qty>0);
    setInv(filtered);LS.set("invoiceData",JSON.stringify(filtered));
    await saveTeamData({invoiceData:filtered});
    setLoading(false);
    e.target.value="";
  },[invoiceData,skuMaster,minReqQty,newSKUQty,deadStock,priceData,params,saveTeamData]);

  const handleSKU=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;setLoading(true);
    const rows=parseCSV(await file.text());const master={};
    rows.forEach(r=>{const s=r["SKU"]||"";if(s)master[s]={sku:s,name:r["Name"]||"",category:r["Category"]||r["Category Name"]||"",brand:r["Brand"]||"",status:r["Status"]||"Active",inventorisedAt:r["Inventorised At"]||"DS"};});
    setSKU(master);LS.set("skuMaster",JSON.stringify(master));
    await saveTeamData({skuMaster:master});
    setLoading(false);
    e.target.value="";
  },[invoiceData,minReqQty,newSKUQty,deadStock,priceData,params,saveTeamData]);

  const handleMRQ=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const mrq={};rows.forEach(r=>{if(r["SKU"])mrq[r["SKU"]]=parseFloat(r["Qty"]||0);});setMRQ(mrq);LS.set("minReqQty",JSON.stringify(mrq));saveTeamData({minReqQty:mrq});e.target.value="";},[saveTeamData]);
  const handleNSQ=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;
    const rows=parseCSV(await file.text());
    const nsq={};
    rows.forEach(r=>{
      const s=r["SKU"]||"";if(!s)return;
      nsq[s]={};
      DS_LIST.forEach(ds=>{
        const mn=parseFloat(r[ds+" Min"]||r[ds]||0);
        const mx=parseFloat(r[ds+" Max"]||r[ds]||0);
        if(mn>0||mx>0) nsq[s][ds]={min:mn,max:Math.max(mn,mx)};
      });
    });
    setNSQ(nsq);LS.set("newSKUQty",JSON.stringify(nsq));saveTeamData({newSKUQty:nsq});e.target.value="";
  },[saveTeamData]);
  const handleDead=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const ds=new Set(rows.map(r=>r["Dead Stock"]||r["SKU"]||"").filter(Boolean));setDead(ds);LS.set("deadStock",JSON.stringify([...ds]));saveTeamData({deadStock:ds});e.target.value="";},[saveTeamData]);
  const handlePrice=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const pd={};rows.forEach(r=>{const s=(r["sku"]||"").trim();const v=parseFloat(r["average_price"]||0);if(s&&v>0)pd[s]=v;});setPrice(pd);LS.set("priceData",JSON.stringify(pd));saveTeamData({priceData:pd});e.target.value="";},[saveTeamData]);

  // ── Zoho sync constants ──────────────────────────────────────────────────
  const SUPABASE_URL = "https://rgyupnrogkbugsadwlye.supabase.co";
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
      setZohoSync(s => ({ ...s, skuMaster: { status: "ok", message: `✓ ${Object.keys(master).length} SKUs`, ts: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) } }));
    } catch (err) {
      setZohoSync(s => ({ ...s, skuMaster: { status: "error", message: `✗ ${err.message}` } }));
    }
  }, [callZoho, saveTeamData]);

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
      setZohoSync(s => ({ ...s, prices: { status: "ok", message: `✓ ${Object.keys(pd).length} SKUs`, ts: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) } }));
    } catch (err) {
      setZohoSync(s => ({ ...s, prices: { status: "error", message: `✗ ${err.message}` } }));
    }
  }, [callZoho, saveTeamData]);

  const clearData=useCallback(async(key)=>{
    if(key==="invoiceData"){setInv([]);LS.delete("invoiceData");setLoaded(false);setResults(null);saveTeamData({invoiceData:[]});}
    if(key==="skuMaster"){setSKU({});LS.delete("skuMaster");setLoaded(false);setResults(null);saveTeamData({skuMaster:{}});}
    if(key==="priceData"){setPrice({});LS.delete("priceData");saveTeamData({priceData:{}});}
    if(key==="minReqQty"){setMRQ({});LS.delete("minReqQty");saveTeamData({minReqQty:{}});}
    if(key==="newSKUQty"){setNSQ({});LS.delete("newSKUQty");saveTeamData({newSKUQty:{}});}
    if(key==="deadStock"){setDead(new Set());LS.delete("deadStock");}
  },[]);

  const saveParams=p=>setParams(p);

  const applyAndRun = async (p) => {
    const np = p || params;
    setParams(np);
    setSaved(np);
    // Save params to Supabase + localStorage
    LS.set("params", JSON.stringify(np));
    setSyncStatus("saving");
    const ok = await saveToSupabase("params","global",np);
    setSyncStatus(ok?"saved":"error");
    setTimeout(()=>setSyncStatus("idle"),3000);
    if (dataLoaded) {
      setLoading(true);
      setTimeout(() => {
        try {
          const raw = runEngine(invoiceData, skuMaster, minReqQty, priceData, deadStock, newSKUQty, np);
          const merged = { ...raw };
          Object.entries(coreOverrides).forEach(([sku, dsList]) => {
            if (!merged[sku]) return;
            const newStores = { ...merged[sku].stores };
            Object.entries(dsList).forEach(([ds, ov]) => {
              if (!newStores[ds]) return;
              newStores[ds] = { ...newStores[ds], min: Math.max(newStores[ds].min, ov.min), max: Math.max(newStores[ds].max, ov.max) };
            });
            merged[sku] = { ...merged[sku], stores: newStores };
          });
          setResults(merged);
          setTab("overview");
        } catch (err) { console.error(err); alert("Model error: " + err.message); }
        setLoading(false);
      }, 50);
    }
  };

  const handleTabClick=t=>{
  if(tab==="logic"&&hasChanges&&isAdmin){setPending(t);return;}
  setTab(t);
  setScrollTop(0);
  setOutputScrollTop(0);
};

  const periodDates=useMemo(()=>{const d=[...new Set(invoiceData.map(r=>r.date))].sort();return new Set(d.slice(-(params.overallPeriod||90)));},[invoiceData,params.overallPeriod]);
  const soldSKUs=new Set(invoiceData.filter(r=>periodDates.has(r.date)).map(r=>r.sku));
  // trim + lowercase status check to handle trailing spaces / casing issues
  const activeMaster=Object.values(skuMaster).filter(s=>(s.status||"").trim().toLowerCase()==="active");
  const uniqueSold=[...soldSKUs].filter(s=>skuMaster[s]&&(skuMaster[s].status||"").trim().toLowerCase()==="active").length;
  const zeroSale=activeMaster.filter(s=>!soldSKUs.has(s.sku)).length;
  const dateRange=invoiceData.length>0?(()=>{
    const d=[...new Set(invoiceData.map(r=>r.date))].sort().slice(-(params.overallPeriod||90));
    const fmt=dt=>{const p=dt.split("-");const m=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(p[1],10)-1];return `${parseInt(p[2],10)} ${m} '${p[0].slice(2)}`;};
    return `Period Considered: ${fmt(d[0])} → ${fmt(d[d.length-1])} (${d.length}D)`;
  })():"No data";
  const missing=[...soldSKUs].filter(s=>!skuMaster[s]||(skuMaster[s].status||"").trim().toLowerCase()!=="active");

  /* allResultsWithSKU, skusByCategory removed — were only used by old Dashboard filtering */

const invoiceDateRange = useMemo(() => {
  if (!invoiceData || !invoiceData.length) return { min: "", max: "", dates: [] };
  const dates = [...new Set(invoiceData.map(r => r.date))].sort();
  return { min: dates[0], max: dates[dates.length - 1], dates };
}, [invoiceData]);

  /* skusByMov removed — was only used by old Dashboard filtering */

const outputRows = useMemo(() => results ? Object.values(results) : [], [results]);
const [outputScrollTop, setOutputScrollTop] = useState(0);
const visibleOutput = useMemo(() => {
  const ROW_HEIGHT_OUT = 36;
  const start = Math.max(0, Math.floor(outputScrollTop / ROW_HEIGHT_OUT) - 5);
  const end = Math.min(outputRows.length, start + 30);
  return { rows: outputRows.slice(start, end), startIndex: start };
}, [outputRows, outputScrollTop]);


  const mi=params.movIntervals||[2,4,7,10],pt=params.priceTiers||[3000,1500,400,100],bb=params.brandBuffer||DEFAULT_BRAND_BUFFER;
  const rw2=params.recencyWt||RECENCY_WT_DEFAULT,dcM=params.dcMult||DC_MULT_DEFAULT;
  const movColors=["#16a34a","#2D7A3A","#B8860B","#C05A00","#C0392B"],priceColors=["#B91C1C","#C2410C","#A16207","#475569","#64748B"];

  const ADMIN_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["stockHealth","Stock Health"],["simulation","OOS Simulation"],["output","Tool Output Download"],["upload","Upload Data"],["logic","Logic Tweaker"],["overrides","Manual Overrides"]];
  const PUBLIC_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["stockHealth","Stock Health"],["simulation","OOS Simulation"],["output","Tool Output Download"]];
  const NAV_TABS=isAdmin?ADMIN_TABS:PUBLIC_TABS;

  // Sync status indicator
  const SyncBadge = () => {
    if(syncStatus==="idle") return null;
    const cfg = {
      saving:{bg:"#FFFBEA",color:HR.yellowDark,text:"Syncing…"},
      saved: {bg:"#DCFCE7",color:"#15803D",text:"✓ Saved to cloud"},
      error: {bg:"#FEE2E2",color:"#B91C1C",text:"⚠ Sync failed"},
    }[syncStatus];
    return <span style={{fontSize:10,fontWeight:700,background:cfg.bg,color:cfg.color,border:`1px solid ${cfg.color}33`,borderRadius:4,padding:"2px 8px"}}>{cfg.text}</span>;
  };

  return(
    <div style={S.app}>
      <div style={S.header}>
        <HomeRunLogo/>
        <SyncBadge/>
        <div style={{flex:1}}/>
        <div style={{fontSize:10,color:HR.muted,marginRight:8,whiteSpace:"nowrap"}}>{dateRange}</div>
        {NAV_TABS.map(([t,l])=><button key={t} onClick={()=>handleTabClick(t)} style={S.btn(tab===t)}>{l}</button>)}
        {isAdmin
          ?<button onClick={handleLogout} style={{...S.btn(false),fontSize:11,color:"#B91C1C",borderColor:"#FECACA"}}>🔓 Logout</button>
          :<button onClick={()=>setShowLoginModal(true)} style={{...S.btn(false),fontSize:11}}>🔐 Admin</button>
        }
      </div>

      {showLoginModal&&<AdminLoginModal onClose={()=>setShowLoginModal(false)} onSuccess={()=>{setIsAdmin(true);setShowLoginModal(false);}}/>}

      {pendingTab&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:998}}>
          <div style={{background:HR.white,padding:28,borderRadius:10,border:`2px solid ${HR.yellow}`,maxWidth:380,width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.15)"}}>
            <div style={{fontSize:16,fontWeight:700,color:HR.yellowDark,marginBottom:6}}>Unsaved Changes</div>
            <div style={{fontSize:13,color:HR.text,marginBottom:20}}>You have {changedCount} unsaved logic change{changedCount!==1?"s":""}. What would you like to do?</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <button onClick={()=>{applyAndRun(params);setPending(null);}} style={{background:HR.yellow,color:HR.black,border:"none",padding:"9px 20px",borderRadius:6,cursor:"pointer",fontWeight:700,fontSize:13}}>▶ Apply & Continue</button>
              <button onClick={()=>{setParams(savedParams);setTab(pendingTab);setPending(null);}} style={{background:HR.white,color:HR.muted,border:`1px solid ${HR.border}`,padding:"9px 20px",borderRadius:6,cursor:"pointer",fontWeight:600,fontSize:13}}>↩ Discard & Continue</button>
              <button onClick={()=>setPending(null)} style={{background:"transparent",color:HR.muted,border:"none",padding:"7px",cursor:"pointer",fontSize:12}}>Stay on Logic Tweaker</button>
            </div>
          </div>
        </div>
      )}

      {loading&&(
        <div style={{position:"fixed",inset:0,background:"rgba(255,255,255,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999}}>
          <div style={{background:HR.white,padding:28,borderRadius:10,textAlign:"center",border:`2px solid ${HR.yellow}`,boxShadow:"0 8px 32px rgba(0,0,0,0.12)"}}>
            <div style={{fontSize:32,marginBottom:10}}>⚡</div>
            <div style={{color:HR.yellowDark,fontWeight:700,fontSize:14}}>Running Model...</div>
            <div style={{color:HR.muted,fontSize:12,marginTop:3}}>Calculating Min/Max for all SKUs</div>
          </div>
        </div>
      )}


      <div style={S.pageWrap}>

        {tab==="upload"&&isAdmin&&(
  <div style={{display:"flex",flexDirection:"column",gap:12}}>

    {/* ── TOP BAR: title + data health strip + apply button ── */}
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <h2 style={{color:HR.yellowDark,margin:0,fontSize:16}}>Data Inputs</h2>
        {(() => {
          const hasData = invoiceData.length > 0 && Object.keys(skuMaster).length > 0 && Object.keys(priceData).length > 0;
          const isSyncing2 = zohoSync.skuMaster?.status==="syncing" || zohoSync.prices?.status==="syncing";
          // Grey out only while Zoho is mid-sync after a fresh invoice upload
          const disabled2 = !hasData || isSyncing2;
          return (
            <button
              disabled={disabled2}
              title={!hasData?"Upload invoice CSV first":isSyncing2?"Syncing SKU Master + Prices from Zoho…":""}
              style={{background:disabled2?"#E5E5E5":HR.yellow,color:disabled2?"#999":HR.black,border:"none",padding:"8px 20px",borderRadius:7,cursor:disabled2?"not-allowed":"pointer",fontSize:12,fontWeight:800,display:"flex",alignItems:"center",gap:6}}
              onClick={disabled2?undefined:()=>{
                if(window.confirm(`Re-run model with:\n• ${invoiceData.length.toLocaleString()} invoice rows (${invoiceDateRange.min} → ${invoiceDateRange.max})\n• ${Object.keys(skuMaster).length.toLocaleString()} SKUs\n• ${Object.keys(priceData).length.toLocaleString()} price entries\n\nThis will update Min/Max for all users. Continue?`)){
                  setLoaded(true); applyAndRun(params);
                }
              }}>
              {isSyncing2 ? <><span style={{fontSize:14}}>⏳</span> Syncing Zoho…</> : <><span>▶</span> Apply & Re-run Model</>}
            </button>
          );
        })()}
      </div>
      {/* Data Health — horizontal strip */}
      <div style={{display:"flex",gap:0,background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8,overflow:"hidden"}}>
        {[
          {label:"Invoice Data",  value:invoiceDateRange.min&&invoiceDateRange.max?`${invoiceDateRange.min} → ${invoiceDateRange.max}`:"No data", color:HR.muted, small:true},
          {label:"Invoice Rows", value:invoiceData.length.toLocaleString(),             color:"#0077A8"},
          {label:"Active SKUs",  value:activeMaster.length.toLocaleString(),            color:HR.green},
          {label:"SKUs Sold",    value:uniqueSold.toLocaleString(),                     color:HR.yellowDark},
          {label:"Zero Sale",    value:zeroSale.toLocaleString(),                       color:"#C05A00"},
          {label:"Dead Stock",   value:deadStock.size.toLocaleString(),                 color:"#B91C1C"},
          {label:"Price SKUs",   value:Object.keys(priceData).length.toLocaleString(),  color:"#7A3DBF"},
          {label:"Missing SKUs", value:missing.length.toLocaleString(),                 color:missing.length>0?"#B91C1C":HR.green},
        ].map((c,i)=>(
          <div key={c.label} style={{flex:1,padding:"8px 10px",borderRight:i<7?`1px solid ${HR.border}`:"none",minWidth:0}}>
            <div style={{fontSize:9,color:HR.muted,fontWeight:600,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.label}</div>
            <div style={{fontSize:c.small?9:13,fontWeight:c.small?400:700,color:c.color,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>

    {/* ── MAIN: cards area ── */}
    <div style={{flex:"0 0 auto"}}>
      <p style={{color:HR.muted,fontSize:12,marginBottom:12,margin:"0 0 12px"}}>Upload invoice CSV — SKU Master and Prices sync from Zoho automatically. Manual CSVs for floors and dead stock.</p>

      {(()=>{
        const dlCSV=(filename,csv)=>{
          const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=filename;a.click();
        };
        const dlTemplate=(filename,headers,rows)=>{
          dlCSV(filename,[headers.join(","),...rows.map(r=>r.join(","))].join("\n"));
        };
        const buildDataCSV=(key)=>{
          if(key==="invoiceData"){
            if(!invoiceData.length) return null;
            const h=["Invoice Date","Invoice Number","Invoice Status","Shopify Order","Item Name","SKU","Category Name","Quantity","Line Item Location Name"];
            const rows=invoiceData.map(r=>[r.date,r.invoiceNumber||"",r.status||"",r.shopifyOrder||"",r.itemName||"",r.sku,r.category||"",r.qty,r.locationName||r.ds||""].map(v=>`"${v}"`).join(","));
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="skuMaster"){
            if(!Object.keys(skuMaster).length) return null;
            const h=["Name","SKU","Category","Brand","Status"];
            const rows=Object.values(skuMaster).map(s=>[s.name||"",s.sku,s.category||"",s.brand||"",s.status||""].map(v=>`"${v}"`).join(","));
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="priceData"){
            if(!Object.keys(priceData).length) return null;
            const h=["sku","average_price"];
            const rows=Object.entries(priceData).map(([s,p])=>`"${s}",${p}`);
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="minReqQty"){
            if(!Object.keys(minReqQty).length) return null;
            const h=["SKU","Qty"];
            const rows=Object.entries(minReqQty).map(([s,q])=>`"${s}",${q}`);
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="newSKUQty"){
            if(!Object.keys(newSKUQty).length) return null;
            const h=["SKU",...DS_LIST.flatMap(ds=>[ds+" Min",ds+" Max"])];
            const rows=Object.entries(newSKUQty).map(([s,dsMap])=>{
              const vals=DS_LIST.flatMap(ds=>{
                const fl=dsMap[ds];
                if(!fl) return [0,0];
                if(typeof fl==="number") return [fl,fl];
                return [fl.min||0,fl.max||0];
              });
              return `"${s}",${vals.join(",")}`;
            });
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="deadStock"){
            if(!deadStock.size) return null;
            return "Dead Stock\n"+[...deadStock].map(s=>`"${s}"`).join("\n");
          }
          return null;
        };
        const templates={
          invoiceData:{file:"Invoice_Dump_Template.csv",headers:["Invoice Date","Invoice Number","Invoice Status","PurchaseOrder","Item Name","SKU","Category Name","Quantity","Line Item Location Name"],rows:[["2026-01-01","INV001","Confirmed","PO001","Product Name A","SKU001","Paints",5,"DS01 Warehouse"],["2026-01-02","INV002","Confirmed","PO002","Product Name B","SKU002","Adhesives",3,"DS02 Warehouse"]]},
          skuMaster:  {file:"SKU_Master_Template.csv",  headers:["Name","Inventorised At","SKU","Category","Status","Brand"],rows:[["Product Name A","DS","SKU001","Paints","Active","Asian Paints"],["Product Name B","DS","SKU002","Adhesives","Active","MYK Laticrete"]]},
          priceData:{file:"Avg_Price_Template.csv",headers:["item_id","item_name","unit","is_combo_product","quantity_purchased","amount","average_price","location_name","sku"],rows:[["ITEM001","Product Name A","PCS","No",100,25000,250,"DS01 Warehouse","SKU001"],["ITEM002","Product Name B","PCS","No",10,18000,1800,"DS02 Warehouse","SKU002"]]},
          minReqQty:  {file:"New_DS_Floor_Template.csv",headers:["SKU","Qty"],rows:[["SKU001",10],["SKU002",5]]},
          newSKUQty:  {file:"SKU_Floors_Template.csv",headers:["SKU","DS01 Min","DS01 Max","DS02 Min","DS02 Max","DS03 Min","DS03 Max","DS04 Min","DS04 Max","DS05 Min","DS05 Max"],rows:[["SKU001",3,5,2,3,0,0,5,7,0,0],["SKU002",0,0,1,2,2,3,0,0,3,4]]},
          deadStock:  {file:"Dead_Stock_Template.csv",  headers:["Dead Stock"],rows:[["SKU001"],["SKU002"]]},
        };
        const csvOnlyCards=[
          {label:"Newly Launched Dark Store Floor Qty",desc:"Columns: SKU, Qty",handler:handleMRQ,count:`${Object.keys(minReqQty).length.toLocaleString()} SKUs`,key:"minReqQty",required:true,hasData:Object.keys(minReqQty).length>0},
          {label:"SKU Floors - DS Level",desc:"Per-store manual Min/Max floors. Columns: SKU, DS01 Min, DS01 Max, ..., DS05 Max",handler:handleNSQ,count:`${Object.keys(newSKUQty).length.toLocaleString()} SKUs`,key:"newSKUQty",required:true,hasData:Object.keys(newSKUQty).length>0},
          {label:"Dead Stock List",desc:"Column: Dead Stock (SKU list)",handler:handleDead,count:`${deadStock.size.toLocaleString()} SKUs`,key:"deadStock",required:false,hasData:deadStock.size>0},
        ];

        const ZohoStatusBadge = ({syncState}) => {
          if (!syncState) return null;
          const color = syncState.status === "ok" ? HR.green : syncState.status === "error" ? "#B91C1C" : HR.yellowDark;
          return <div style={{fontSize:10,color,marginTop:4,fontWeight:500}}>{syncState.message}{syncState.ts && <span style={{color:HR.muted,fontWeight:400}}> · {syncState.ts}</span>}</div>;
        };

        const dlBtn = (key, handler, hasData, label) => (
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {hasData && <button onClick={()=>{const csv=buildDataCSV(key);if(csv)dlCSV(key+"_data.csv",csv);}}
              style={{background:"#F3E8FF",color:"#7C3AED",border:"1px solid #D8B4FE",padding:"4px 8px",borderRadius:5,cursor:"pointer",fontSize:10,fontWeight:600}}>
              ⬇ {label||"Data"}
            </button>}
            {hasData && <button onClick={()=>clearData(key)}
              style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"4px 8px",borderRadius:5,cursor:"pointer",fontSize:10,fontWeight:600}}>
              🗑 Clear
            </button>}
          </div>
        );

        const isSyncingZoho = zohoSync.skuMaster?.status==="syncing" || zohoSync.prices?.status==="syncing";

        // Auto-sync SKU master + prices when invoice is uploaded
        const handleInvoiceAndSync = async (e) => {
          // Reset sync state so button greys out until Zoho completes
          setZohoSync(s => ({ ...s, skuMaster: { status: "syncing", message: "Syncing…" }, prices: { status: "syncing", message: "Syncing…" } }));
          setInvoiceUploadedThisSession(true);
          await handleInvoice(e);
          await Promise.all([syncZohoSKUMaster(), syncZohoPrices()]);
        };

        const btnS = (color, text) => ({background:color,color:HR.white,padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,border:"none",whiteSpace:"nowrap"});
        const dlBtnS = {background:"#F3E8FF",color:"#7C3AED",border:"1px solid #D8B4FE",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"};
        const tplBtnS = {background:"#EAF9FF",color:"#0077A8",border:"1px solid #A5F3FC",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"};
        const clrBtnS = {background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"};

        return(<>
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
              <div style={{fontWeight:700,color:HR.text,fontSize:12,marginBottom:4}}>SKU Master + Prices <span style={{fontSize:10,fontWeight:400,color:"#0077A8"}}>auto-synced from Zoho</span></div>
              <div style={{fontSize:10,color:HR.muted,marginBottom:10}}>Syncs automatically after invoice upload. Both required before re-running model.</div>

              {/* Status rows */}
              {[
                { label:"SKU Master", sync: zohoSync.skuMaster, count: Object.keys(skuMaster).length, dlKey:"skuMaster", clearKey:"skuMaster", handler:handleSKU, label2:"⬆ SKU Master CSV" },
                { label:"Purchase Prices", sync: zohoSync.prices, count: Object.keys(priceData).length, dlKey:"priceData", clearKey:"priceData", handler:handlePrice, label2:"⬆ Prices CSV" },
              ].map(item => {
                const ready = item.count > 0;
                const syncing = item.sync?.status === "syncing";
                const err = item.sync?.status === "error";
                return (
                  <div key={item.label} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:`1px solid ${HR.border}`}}>
                    <span style={{fontSize:16,flexShrink:0}}>{syncing?"⏳":ready?"✅":"⬜"}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,fontWeight:600,color:HR.text}}>{item.label}</div>
                      <div style={{fontSize:9,color:err?"#B91C1C":HR.muted}}>
                        {syncing ? "Syncing from Zoho…" : ready ? `${item.count.toLocaleString()} items${item.sync?.ts?" · "+item.sync.ts:""}` : err ? `Sync failed — upload CSV manually` : "Not synced"}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:4,flexShrink:0}}>
                      {ready && <button onClick={()=>{const csv=buildDataCSV(item.dlKey);if(csv)dlCSV(item.dlKey+"_data.csv",csv);}} style={{...dlBtnS,padding:"3px 7px",fontSize:10}}>⬇</button>}
                      {ready && <button onClick={()=>clearData(item.clearKey)} style={{...clrBtnS,padding:"3px 7px",fontSize:10}}>🗑</button>}
                    </div>
                  </div>
                );
              })}

              {/* Fallback CSV uploads */}
              <div style={{marginTop:10,paddingTop:8,borderTop:`1px dashed ${HR.border}`}}>
                <div style={{fontSize:9,color:HR.muted,marginBottom:5,fontWeight:600}}>FALLBACK — if Zoho unavailable:</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {[{label:"⬆ SKU Master CSV",handler:handleSKU},{label:"⬆ Prices CSV",handler:handlePrice}].map(c=>(
                    <label key={c.label} style={{...btnS(HR.green,""),cursor:"pointer",fontSize:10,padding:"4px 8px"}}>
                      {c.label}<input type="file" accept=".csv" onChange={c.handler} style={{display:"none"}}/>
                    </label>
                  ))}
                  <button onClick={()=>Promise.all([syncZohoSKUMaster(),syncZohoPrices()])}
                    style={{background:"#EAF9FF",color:"#0077A8",border:"1px solid #A5F3FC",padding:"4px 8px",borderRadius:5,cursor:"pointer",fontSize:10,fontWeight:600}}>
                    ⟳ Retry Zoho sync
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── ROW 2: 3 manual CSV cards ── */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
            {csvOnlyCards.map(item=>(
              <div key={item.label} style={{...S.card}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                  <div style={{fontWeight:700,color:HR.text,fontSize:12}}>
                    {item.label} {item.required&&<span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>}
                  </div>
                  <div style={{fontSize:11,color:HR.green,fontWeight:600,whiteSpace:"nowrap"}}>{item.count}</div>
                </div>
                <div style={{fontSize:10,color:HR.muted,marginBottom:8,lineHeight:1.4}}>{item.desc}</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <label style={{...btnS(HR.green,""),cursor:"pointer"}}> ⬆ Upload CSV<input type="file" accept=".csv" onChange={item.handler} style={{display:"none"}}/></label>
                  <button onClick={()=>{const t=templates[item.key];dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
                  {item.hasData&&<button onClick={()=>{const csv=buildDataCSV(item.key);if(csv)dlCSV(item.key+"_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
                  {item.hasData&&<button onClick={()=>clearData(item.key)} style={clrBtnS}>🗑 Clear</button>}
                </div>
              </div>
            ))}
          </div>
        </>);
      })()}

      {/* ── Errors: missing SKUs ── */}
      {missing.length>0&&(
        <div style={{...S.card,marginTop:8,border:`1px solid ${HR.yellow}`}}>
          <div style={{fontWeight:700,color:HR.yellowDark,marginBottom:3,fontSize:13}}>⚠ {missing.length} SKUs in Invoice not Active in SKU Master</div>
          <div style={{fontSize:11,color:HR.muted,marginBottom:10}}>These SKUs have sales but are missing or inactive in SKU Master.</div>
          <div style={{maxHeight:400,overflowY:"auto"}}>
            <table style={S.table}><thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>SKU</th><th style={S.th}>Status in Master</th></tr></thead>
              <tbody>{missing.map((s,i)=><tr key={s} style={{background:i%2===0?HR.white:HR.surfaceLight}}><td style={S.td}>{s}</td><td style={{...S.td,color:skuMaster[s]?HR.yellowDark:"#B91C1C",fontSize:11}}>{skuMaster[s]?skuMaster[s].status:"Not in SKU Master"}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  </div>
)}

        {tab==="overview"&&(
          !dataLoaded?(
            <div style={{textAlign:"center",padding:60}}>
              <div style={{fontSize:36,marginBottom:10}}>⚡</div>
              <div style={{color:HR.muted,fontSize:14,marginBottom:6}}>No data loaded yet</div>
              {isAdmin
                ?<button onClick={()=>setTab("upload")} style={{...S.runBtn,width:"auto",padding:"7px 20px"}}>Upload Data →</button>
                :<div style={{color:HR.muted,fontSize:12}}>Data is being prepared. Check back soon.</div>
              }
            </div>
          ):(
            <OverviewTab
              invoiceData={invoiceData} results={results} priceData={priceData} params={params}
              invoiceDateRange={invoiceDateRange}
              period={ovPeriod} setPeriod={setOvPeriod}
              dateFrom={ovDateFrom} setDateFrom={setOvDateFrom}
              dateTo={ovDateTo} setDateTo={setOvDateTo}
              store={ovStore} setStore={setOvStore}
              drill={ovDrill} setDrill={setOvDrill}
              onNavigateToSKU={(skuId) => { setSdSku(skuId); setSdSearch(skuId); setTab("skuDetail"); }}
            />
          )
        )}

        {tab==="skuDetail"&&(
          !dataLoaded?(
            <div style={{textAlign:"center",padding:60}}>
              <div style={{fontSize:36,marginBottom:10}}>🔍</div>
              <div style={{color:HR.muted,fontSize:14,marginBottom:6}}>No data loaded yet</div>
              {isAdmin
                ?<button onClick={()=>setTab("upload")} style={{...S.runBtn,width:"auto",padding:"7px 20px"}}>Upload Data →</button>
                :<div style={{color:HR.muted,fontSize:12}}>Data is being prepared. Check back soon.</div>
              }
            </div>
          ):(
            <SKUDetailTab
              invoiceData={invoiceData} skuMaster={skuMaster} results={results} params={params}
              invoiceDateRange={invoiceDateRange}
              skuId={sdSku} setSkuId={setSdSku}
              searchVal={sdSearch} setSearchVal={setSdSearch}
              period={sdPeriod} setPeriod={setSdPeriod}
              dateFrom={sdDateFrom} setDateFrom={setSdDateFrom}
              dateTo={sdDateTo} setDateTo={setSdDateTo}
              dsView={sdDsView} setDsView={setSdDsView}
            />
          )
        )}

        {/* Old dashboard tab removed — replaced by OverviewTab */}
        {tab==="output"&&(
          !results?<div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>Loading data, please wait...</div>:(
            <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <h2 style={{color:HR.yellowDark,margin:0,fontSize:16}}>Tool Output Download</h2>
                <div style={{display:"flex",gap:8}}>

                  {/* ── SKU Master Download ── */}
                  <button
                    disabled={!results}
                    onClick={()=>{
                      const hdr=["Item Name","Inventorised At","SKU","Category","Status","Brand","Price Tag","Top N"].join(",");
                      const rows=Object.values(skuMaster).map(s=>{
                        const res=results[s.sku];
                        const priceTag=res?.meta?.priceTag||getPriceTag(priceData[s.sku]||0,params.priceTiers);
                        const topN=res?.meta?.t150Tag||"Zero Sale";
                        return[
                          `"${(s.name||"").replace(/"/g,'""')}"`,
                          `"${(s.inventorisedAt||"").replace(/"/g,'""')}"`,
                          s.sku,
                          `"${(s.category||"").replace(/"/g,'""')}"`,
                          `"${(s.status||"").trim()}"`,
                          `"${(s.brand||"").replace(/"/g,'""')}"`,
                          priceTag,
                          topN,
                        ].join(",");
                      });
                      const blob=new Blob([[hdr,...rows].join("\n")],{type:"text/csv"});
                      const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="SKU_Master.csv";a.click();
                    }}
                    style={{background:results?"#7C3AED":"#ccc",color:HR.white,border:"none",padding:"7px 18px",borderRadius:5,cursor:results?"pointer":"not-allowed",fontWeight:700,fontSize:12,opacity:results?1:0.6}}
                  >⬇ SKU Master CSV</button>

                  {/* ── Tool Output DS Level CSV ── */}
                  <button onClick={()=>{
                    const hdr=["Item Name","SKU","Category",...DS_LIST.flatMap(d=>[`${d} Min`,`${d} Max`])].join(",");
                    const rows=Object.values(skuMaster).map(s=>{
                      const r=results[s.sku];
                      const dsCols=DS_LIST.flatMap(d=>{
                        const st=r?.stores[d]||{min:0,max:0};
                        const ov=coreOverrides[s.sku]?.[d];
                        const min=ov?Math.max(st.min,ov.min):st.min;
                        const max=ov?Math.max(st.max,ov.max):st.max;
                        return[min,max];
                      });
                      return[
                        `"${(s.name||s.sku).replace(/"/g,'""')}"`,
                        s.sku,
                        `"${(s.category||"").replace(/"/g,'""')}"`,
                        ...dsCols,
                      ].join(",");
                    });
                    const blob=new Blob([[hdr,...rows].join("\n")],{type:"text/csv"});
                    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="IMS_Output_DS.csv";a.click();
                  }} style={{background:HR.green,color:HR.white,border:"none",padding:"7px 18px",borderRadius:5,cursor:"pointer",fontWeight:700,fontSize:12}}>⬇ Tool Output DS Level</button>

                  {/* ── Tool Output DC CSV ── */}
                  <button onClick={()=>{
                    const hdr=["Item Name","SKU","Category","DC Min","DC Max"].join(",");
                    const rows=Object.values(skuMaster).map(s=>{
                      const r=results[s.sku];
                      return[
                        `"${(s.name||s.sku).replace(/"/g,'""')}"`,
                        s.sku,
                        `"${(s.category||"").replace(/"/g,'""')}"`,
                        r?.dc.min??0,
                        r?.dc.max??0,
                      ].join(",");
                    });
                    const blob=new Blob([[hdr,...rows].join("\n")],{type:"text/csv"});
                    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="IMS_Output_DC.csv";a.click();
                  }} style={{background:"#0077A8",color:HR.white,border:"none",padding:"7px 18px",borderRadius:5,cursor:"pointer",fontWeight:700,fontSize:12}}>⬇ Tool Output DC</button>

                </div>
              </div>

              {/* ── Table — fills remaining height, no blank space ── */}
              <div style={{...S.card,padding:0,overflow:"auto",flex:1,minHeight:0,width:"100%",boxSizing:"border-box"}} onScroll={e => setOutputScrollTop(e.currentTarget.scrollTop)}
ref={el => { if(el && outputScrollTop === 0) el.scrollTop = 0; }}>
                <table style={{...S.table}}>
                  <thead style={{position:"sticky",top:0,zIndex:4}}>
                    <tr style={{background:HR.surfaceLight}}>
                      <th style={{...S.th,minWidth:160}} rowSpan={2}>Item</th>
                      <th style={S.th} rowSpan={2}>SKU</th>
                      <th style={S.th} rowSpan={2}>Category</th>
                      <th style={S.th} rowSpan={2}>Price Tag</th>
                      {DS_LIST.map((ds,di)=>{const dc=DS_COLORS[di];return <th key={ds} style={{...S.th,textAlign:"center",background:dc.bg,color:dc.header}} colSpan={2}>{ds}</th>;})}
                      <th style={{...S.th,textAlign:"center",background:DC_COLOR.bg,color:DC_COLOR.header}} colSpan={2}>DC</th>
                    </tr>
                    <tr style={{background:HR.surfaceLight}}>
                      {DS_LIST.map((ds,di)=>{const dc=DS_COLORS[di];return[
                        <th key={ds+"m"} style={{...S.th,fontSize:10,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:24,zIndex:3}}>Min</th>,
                        <th key={ds+"x"} style={{...S.th,fontSize:10,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:24,zIndex:3}}>Max</th>,
                      ];})}
                      <th style={{...S.th,fontSize:10,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:24,zIndex:3}}>Min</th>
                      <th style={{...S.th,fontSize:10,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:24,zIndex:3}}>Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{height: visibleOutput.startIndex * 36}}><td colSpan={999}/></tr>
{visibleOutput.rows.map((r,i)=>{
  const actualIndex = visibleOutput.startIndex + i;
  return(
                      <tr key={r.meta.sku} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{...S.td,color:HR.text,fontSize:10}}>{r.meta.name||r.meta.sku}</td>
                        <td style={{...S.td,color:HR.muted,fontSize:10}}>{r.meta.sku}</td>
                        <td style={{...S.td,color:HR.muted,fontSize:10}}>{r.meta.category}</td>
                        <td style={S.td}><TagPill value={r.meta.priceTag} colorMap={PRICE_TAG_COLORS}/></td>
                        {DS_LIST.map((ds,di)=>{
                          const s=r.stores[ds]||{min:0,max:0},dc=DS_COLORS[di];
                          const ov=coreOverrides[r.meta.sku]?.[ds];
                          const min=ov?Math.max(s.min,ov.min):s.min;
                          const max=ov?Math.max(s.max,ov.max):s.max;
                          return[
                            <td key={ds+"m"} style={{...S.td,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg,fontSize:10}}>{min}</td>,
                            <td key={ds+"x"} style={{...S.td,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg,fontSize:10}}>{max}</td>,
                          ];
                        })}
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg,fontSize:10}}>{r.dc.min}</td>
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg,fontSize:10}}>{r.dc.max}</td>
                      </tr>
                    );
  })}
  <tr style={{height: (outputRows.length - visibleOutput.startIndex - visibleOutput.rows.length) * 36}}><td colSpan={999}/></tr>
                  </tbody>
                </table>
              </div>

            </div>
          )
        )}
        {tab==="stockHealth"&&(
          <StockHealthTab results={results} params={params} stockData={stockData} setStockData={setStockData} uploadedAt={stockUploadedAt} setUploadedAt={setStockUploadedAt} saveTeamData={saveTeamData} />
        )}
        <div style={{display: tab==="simulation" ? "block" : "none"}}>
  <SimulationTab invoiceData={invoiceData} results={results} skuMaster={skuMaster} params={params} priceData={priceData} onApplyToCore={payload=>{const merged={...coreOverrides,...payload};Object.keys(payload).forEach(sku=>{merged[sku]={...coreOverrides[sku],...payload[sku]};});saveCoreOverrides(merged);}} simOverrides={simOverrides} setSimOverrides={setSimOverrides} simOverrideCount={simOverrideCount} setSimOverrideCount={setSimOverrideCount} simResults={simResults} setSimResults={setSimResults} simLoading={simLoading} setSimLoading={setSimLoading} simDays={simDays} setSimDays={setSimDays}/>
</div>

        {tab==="logic"&&isAdmin&&(
  <div style={{display:"flex",flexDirection:"column",gap:0}}>

    {/* ── STICKY TOP BAR ── */}
    {hasChanges&&(
      <ImpactStickyBar
        changedCount={changedCount}
        onReset={()=>setParams(savedParams)}
        onApply={()=>applyAndRun(params)}
        previewState={previewState}
        setPreviewState={setPreviewState}
        runPreview={runPreviewFn}
      />
    )}

    {/* ── 3-COLUMN GRID ── */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,alignItems:"start"}}>

      {/* ══════════════ COLUMN 1 ══════════════ */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>

        {/* Analysis Period */}
        <div>
          <div style={{
            background:"#EAF9FF",border:"1px solid #B0E0F5",borderRadius:8,
            padding:"12px 16px",marginBottom:4,
            display:"flex",alignItems:"center",gap:10,
          }}>
            <span style={{fontSize:20}}>📅</span>
            <span style={{fontWeight:800,fontSize:16,color:"#0077A8",letterSpacing:"-0.3px"}}>
              Analysis Period Tweaks
            </span>
          </div>
          <div>
            <Section title="Period & Recency Window" icon="" accent="#0077A8"
              summary={`Overall: ${params.overallPeriod}d · Recency: ${params.recencyWindow}d · Long: ${params.overallPeriod-params.recencyWindow}d`}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
                {[{label:"Overall Period (days)",key:"overallPeriod",min:15,max:90},
                  {label:"Recency Window (days)",key:"recencyWindow",min:7,max:null}].map(({label,key,min,max})=>{
                  const maxVal=key==="recencyWindow"?Math.max(min,(params.overallPeriod||90)-1):max;
                  return <div key={key}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:4}}>{label}</div>
                    <NumInput value={params[key]} min={min} max={maxVal} step={1}
                      onChange={v=>saveParams({...params,[key]:v})}
                      style={{width:"100%",boxSizing:"border-box",color:"#0077A8",fontWeight:700}}/>
                  </div>;
                })}
                <div>
                  <div style={{fontSize:11,color:HR.muted,marginBottom:4}}>Long Period (auto)</div>
                  <div style={{...S.input,textAlign:"center",color:HR.muted,fontWeight:700,opacity:0.7}}>
                    {params.overallPeriod-params.recencyWindow} days
                  </div>
                </div>
              </div>
            </Section>
            <Section title="Recency Weights" icon="" accent="#0077A8"
              summary={`SF:${rw2["Super Fast"]} F:${rw2["Fast"]} M:${rw2["Moderate"]} Sl:${rw2["Slow"]} SS:${rw2["Super Slow"]}`}>
              <table style={S.table}>
                <thead><tr style={{background:HR.surfaceLight}}>
                  <th style={S.th}>Movement Tag</th>
                  <th style={{...S.th,textAlign:"center"}}>Weight</th>
                  <th style={{...S.th,color:HR.muted,fontSize:10,fontWeight:400}}>Blend formula</th>
                </tr></thead>
                <tbody>
                  {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{
                    const wt=rw2[tier]||1,color=MOV_COLORS[tier];
                    return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                      <td style={S.td}><MovTag value={tier}/></td>
                      <td style={{...S.td,textAlign:"center"}}>
                        <NumInput value={wt} min={0.5} max={5} step={0.25}
                          onChange={v=>saveParams({...params,recencyWt:{...rw2,[tier]:v}})}
                          style={{width:72,color,fontWeight:700}}/>
                      </td>
                      <td style={{...S.td,fontSize:10,color:HR.muted}}>
                        {`(Long + Recent × ${wt}) ÷ ${1+wt}`}
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </Section>
          </div>
        </div>

        {/* DC Level Logic */}
        <div>
          <div style={{
            background:"#EAF9FF",border:"1px solid #B0E0F5",borderRadius:8,
            padding:"12px 16px",marginBottom:4,
            display:"flex",alignItems:"center",gap:10,
          }}>
            <span style={{fontSize:20}}>🏭</span>
            <span style={{fontWeight:800,fontSize:16,color:"#0077A8",letterSpacing:"-0.3px"}}>
              DC Level Logic Tweaks
            </span>
          </div>
          <div>
            <Section title="Active DS Count" icon="" accent="#0077A8"
              summary={`Active DS: ${params.activeDSCount}`}>
              <div style={{...S.card,padding:"12px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <div style={{fontWeight:600,color:HR.text,fontSize:12}}>Active DS Count</div>
                  <div style={{fontWeight:800,color:"#0077A8",fontSize:18}}>{params.activeDSCount}</div>
                </div>
                <TierSlider label="" value={params.activeDSCount} min={1} max={10} step={1}
                  color="#0077A8" onChange={v=>saveParams({...params,activeDSCount:v})}/>
              </div>
            </Section>
            <Section title="Dead Stock DC Multiplier" icon="" accent="#0077A8"
              summary={`Min: ${(params.dcDeadMult||DC_DEAD_MULT_DEFAULT).min} · Max: ${(params.dcDeadMult||DC_DEAD_MULT_DEFAULT).max}`}>
              <div style={{...S.card,padding:0,overflow:"hidden"}}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}>
                    <th style={S.th}>Condition</th>
                    <th style={{...S.th,textAlign:"center"}}>Min Mult</th>
                    <th style={{...S.th,textAlign:"center"}}>Max Mult</th>
                  </tr></thead>
                  <tbody><tr style={{background:HR.white}}>
                    <td style={S.td}>
                      <span style={{...TAG_STYLE,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}}>Dead Stock</span>
                    </td>
                    {["min","max"].map(field=>(
                      <td key={field} style={{...S.td,textAlign:"center"}}>
                        <NumInput value={(params.dcDeadMult||DC_DEAD_MULT_DEFAULT)[field]}
                          min={0} max={1} step={0.05}
                          onChange={v=>saveParams({...params,dcDeadMult:{...(params.dcDeadMult||DC_DEAD_MULT_DEFAULT),[field]:v}})}
                          style={{width:72,color:"#B91C1C",fontWeight:700}}/>
                      </td>
                    ))}
                  </tr></tbody>
                </table>
              </div>
            </Section>
            <Section title="DC Multipliers by Movement" icon="" accent="#0077A8"
              summary={`SF ${(params.dcMult||DC_MULT_DEFAULT)["Super Fast"].min}–${(params.dcMult||DC_MULT_DEFAULT)["Super Fast"].max}`}>
              <div style={{...S.card,padding:0,overflow:"hidden"}}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}>
                    <th style={S.th}>Movement Tag</th>
                    <th style={{...S.th,textAlign:"center"}}>Min Mult</th>
                    <th style={{...S.th,textAlign:"center"}}>Max Mult</th>
                  </tr></thead>
                  <tbody>
                    {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{
                      const d=dcM[tier]||DC_MULT_DEFAULT[tier],color=MOV_COLORS[tier];
                      return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={S.td}><MovTag value={tier}/></td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <NumInput value={d.min} min={0} max={1} step={0.05}
                            onChange={v=>saveParams({...params,dcMult:{...dcM,[tier]:{...d,min:v}}})}
                            style={{width:72,color,fontWeight:700}}/>
                        </td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <NumInput value={d.max} min={0} max={1} step={0.05}
                            onChange={v=>saveParams({...params,dcMult:{...dcM,[tier]:{...d,max:v}}})}
                            style={{width:72,color,fontWeight:700}}/>
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        </div>

      </div>{/* end col 1 */}

      {/* ══════════════ COLUMN 2 ══════════════ */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div>
          <div style={{
            background:"#FFFBEA",border:`1px solid ${HR.yellow}`,borderRadius:8,
            padding:"12px 16px",marginBottom:4,
            display:"flex",alignItems:"center",gap:10,
          }}>
            <span style={{fontSize:20}}>🏪</span>
            <span style={{fontWeight:800,fontSize:16,color:HR.yellowDark,letterSpacing:"-0.3px"}}>
              DS Level Logic Tweaks
            </span>
          </div>
          <div>
            <Section title="Base Min Days" icon="" accent={HR.yellowDark}
              summary={`SF:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Super Fast"]} F:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Fast"]} M:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Moderate"]} Sl:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Slow"]} SS:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Super Slow"]}`}>
              <div style={{...S.card,padding:0,overflow:"hidden"}}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}>
                    <th style={S.th}>Movement Tag</th>
                    <th style={{...S.th,textAlign:"center"}}>Base Min Days</th>
                  </tr></thead>
                  <tbody>
                    {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{
                      const bmd=params.baseMinDays||BASE_MIN_DAYS_DEFAULT,color=MOV_COLORS[tier];
                      return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={S.td}><MovTag value={tier}/></td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <NumInput value={bmd[tier]??3} min={1} max={30} step={1}
                            onChange={v=>saveParams({...params,baseMinDays:{...(params.baseMinDays||BASE_MIN_DAYS_DEFAULT),[tier]:v}})}
                            style={{width:72,color,fontWeight:700}}/>
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section title="Movement Tag Boundaries" icon="" accent={HR.yellowDark}
              summary={`≤${mi[0]}d / ≤${mi[1]}d / ≤${mi[2]}d / ≤${mi[3]}d`}>
              {[0,1,2,3].map(i=>{
                const labels=["Super Fast | Fast","Fast | Moderate","Moderate | Slow","Slow | Super Slow"];
                const lo=i===0?1:mi[i-1]+1,hi=i===3?30:mi[i+1]-1;
                return <TierSlider key={i} label={labels[i]} value={mi[i]} min={lo} max={hi}
                  color={movColors[i+1]} onChange={v=>{const next=[...mi];next[i]=v;saveParams({...params,movIntervals:next});}}/>;
              })}
            </Section>
            <Section title="Price Tag Boundaries" icon="" accent={HR.yellowDark}
              summary={`₹${pt[0]} / ₹${pt[1]} / ₹${pt[2]} / ₹${pt[3]}`}>
              {[0,1,2,3].map(i=>{
                const labels=["Premium | High","High | Medium","Medium | Low","Low | Super Low"];
                const lo=i===3?1:pt[i+1]+1,hi=i===0?50000:pt[i-1]-1;
                return <TierSlider key={i} label={labels[i]} value={pt[i]} min={lo} max={hi}
                  color={priceColors[i]} onChange={v=>{const next=[...pt];next[i]=v;saveParams({...params,priceTiers:next});}}/>;
              })}
            </Section>
            <Section title="Spike Parameters" icon="" accent={HR.yellowDark}
              summary={`${params.spikeMultiplier}× · Frequent ≥${params.spikePctFrequent}% · Once ≥${params.spikePctOnce}%`}>
              {[
                {key:"spikeMultiplier",label:"Spike Definition",desc:"Day qty > X × daily avg = spike day",min:1,max:20,step:1},
                {key:"spikePctFrequent",label:"Frequent Spike Threshold (%)",desc:"Spike days ≥ X% of period = Frequent",min:1,max:50,step:1},
                {key:"spikePctOnce",label:"Once-in-a-while Threshold (%)",desc:"Spike days ≥ X% of period = Once in a while",min:1,max:20,step:1}
              ].map(pm=>(
                <div key={pm.key} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <div style={{fontWeight:600,color:HR.text,fontSize:12}}>{pm.label}</div>
                    <div style={{fontWeight:800,color:HR.yellowDark,fontSize:18,minWidth:32,textAlign:"right"}}>{params[pm.key]}</div>
                  </div>
                  <div style={{fontSize:10,color:HR.muted,marginBottom:6}}>{pm.desc}</div>
                  <TierSlider label="" value={params[pm.key]} min={pm.min} max={pm.max} step={pm.step}
                    onChange={v=>saveParams({...params,[pm.key]:v})}/>
                </div>
              ))}
            </Section>
            <Section title="Max Days Buffer & ABQ" icon="" accent={HR.yellowDark}
              summary={`Buffer: +${params.maxDaysBuffer}d · ABQ mult: ${params.abqMaxMultiplier}×`}>
              {[
                {key:"maxDaysBuffer",label:"Max Days Buffer",desc:"Max Days = Min Days + X.",min:1,max:10,step:1},
                {key:"abqMaxMultiplier",label:"ABQ Max Multiplier",desc:"Max = CEILING(Min × X) for Slow items.",min:1,max:3,step:0.1}
              ].map(pm=>(
                <div key={pm.key} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <div style={{fontWeight:600,color:HR.text,fontSize:12}}>{pm.label}</div>
                    <div style={{fontWeight:800,color:HR.yellowDark,fontSize:18,minWidth:32,textAlign:"right"}}>{params[pm.key]}</div>
                  </div>
                  <div style={{fontSize:10,color:HR.muted,marginBottom:6}}>{pm.desc}</div>
                  <TierSlider label="" value={params[pm.key]} min={pm.min} max={pm.max} step={pm.step}
                    onChange={v=>saveParams({...params,[pm.key]:v})}/>
                </div>
              ))}
            </Section>
            <Section title="Brand Buffer Days" icon="" accent={HR.yellowDark}
              summary={`${Object.keys(bb).length} brand${Object.keys(bb).length!==1?"s":""} configured`}>
              <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:10}}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}>
                    <th style={S.th}>Brand</th>
                    <th style={{...S.th,textAlign:"center"}}>Buffer Days</th>
                    <th style={{...S.th,textAlign:"center"}}>Remove</th>
                  </tr></thead>
                  <tbody>
                    {Object.entries(bb).map(([brand,days],i)=>(
                      <tr key={brand} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{...S.td,fontWeight:600,fontSize:11}}>{brand}</td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <NumInput value={days} min={1} max={30} step={1}
                            onChange={v=>saveParams({...params,brandBuffer:{...bb,[brand]:v}})}
                            style={{width:64,color:HR.yellowDark,fontWeight:700}}/>
                        </td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <button onClick={()=>{const next={...bb};delete next[brand];saveParams({...params,brandBuffer:next});}}
                            style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:11}}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <input placeholder="Brand name..." value={newBrand} onChange={e=>setNewBrand(e.target.value)} style={{...S.input,flex:1}}/>
                <NumInput value={newBrandDays} min={1} max={30} step={1} onChange={v=>setNBD(v)} style={{width:70}}/>
                <button onClick={()=>{const b=newBrand.trim();if(!b)return;saveParams({...params,brandBuffer:{...bb,[b]:newBrandDays}});setNewBrand("");setNBD(1);}}
                  style={{background:HR.green,color:HR.white,border:"none",padding:"7px 14px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>+ Add</button>
              </div>
            </Section>
            <Section title="New Dark Store Logic" icon="" accent={HR.yellowDark}
              summary={`${(params.newDSList||[]).join(", ")||"None"} · Top ${params.newDSFloorTopN} SKUs`}>
              <div style={{...S.card,marginBottom:10,padding:"12px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <div style={{fontWeight:600,color:HR.text,fontSize:12}}>Floor applies to Top N SKUs</div>
                  <div style={{fontWeight:800,color:HR.yellowDark,fontSize:18}}>{params.newDSFloorTopN}</div>
                </div>
                <TierSlider label="" value={params.newDSFloorTopN} min={50} max={250} step={50}
                  onChange={v=>saveParams({...params,newDSFloorTopN:v})}/>
              </div>
              <div style={{...S.card,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Stores designated as New DS</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                  {(params.newDSList||[]).map(ds=>(
                    <span key={ds} style={{background:"#FFFBEA",color:HR.yellowDark,border:`1px solid ${HR.yellow}`,padding:"3px 10px",borderRadius:5,fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
                      {ds}
                      <button onClick={()=>saveParams({...params,newDSList:(params.newDSList||[]).filter(d=>d!==ds)})}
                        style={{background:"none",border:"none",color:HR.yellowDark,cursor:"pointer",fontSize:13,padding:0,lineHeight:1}}>×</button>
                    </span>
                  ))}
                  {(params.newDSList||[]).length===0&&<span style={{color:HR.muted,fontSize:12}}>No stores assigned</span>}
                </div>
                <div style={{display:"flex",gap:6}}>
                  <select id="newDSSelect" style={S.input}>
                    {DS_LIST.filter(d=>!(params.newDSList||[]).includes(d)).map(d=><option key={d}>{d}</option>)}
                  </select>
                  <button onClick={()=>{const sel=document.getElementById("newDSSelect").value;if(sel&&!(params.newDSList||[]).includes(sel))saveParams({...params,newDSList:[...(params.newDSList||[]),sel]});}}
                    style={{background:HR.green,color:HR.white,border:"none",padding:"7px 14px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12}}>+ Add</button>
                </div>
              </div>
            </Section>
          </div>
        </div>

        {/* ── Strategy Config Sections ── */}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginTop:16}}>
          <div style={{
            background:"#F3E8FF",border:"1px solid #D8B4FE",borderRadius:8,
            padding:"12px 16px",marginBottom:4,
            display:"flex",alignItems:"center",gap:10,
          }}>
            <span style={{fontSize:20}}>🎯</span>
            <span style={{fontWeight:800,fontSize:16,color:"#7C3AED",letterSpacing:"-0.3px"}}>
              Category Strategy Engine
            </span>
          </div>

          {/* Section A: Category Strategy Assignment */}
          {(()=>{
            const cats=[...new Set(Object.values(skuMaster).map(s=>s.category||"Unknown"))].sort();
            const cs=params.categoryStrategies||{};
            const nonStd=Object.values(cs).filter(v=>v&&v!=="standard").length;
            return(
              <Section title="Category → Strategy Map" icon="📋" accent="#7C3AED"
                summary={nonStd>0?`${nonStd} non-standard`:"All standard"}>
                <div style={{...S.card,padding:0,overflow:"hidden",maxHeight:360,overflowY:"auto"}}>
                  <table style={S.table}>
                    <thead><tr style={{background:HR.surfaceLight}}>
                      <th style={{...S.th,position:"sticky",top:0,zIndex:2,background:HR.surfaceLight}}>Category</th>
                      <th style={{...S.th,textAlign:"center",position:"sticky",top:0,zIndex:2,background:HR.surfaceLight}}>Strategy</th>
                    </tr></thead>
                    <tbody>
                      {cats.map((cat,i)=>(
                        <tr key={cat} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                          <td style={{...S.td,fontWeight:600,fontSize:11}}>{cat}</td>
                          <td style={{...S.td,textAlign:"center"}}>
                            <select value={cs[cat]||"standard"}
                              onChange={e=>{
                                const v=e.target.value;
                                const next={...cs};
                                if(v==="standard") delete next[cat]; else next[cat]=v;
                                saveParams({...params,categoryStrategies:next});
                              }}
                              style={{...S.input,fontSize:11,padding:"3px 6px",fontWeight:600,
                                color:cs[cat]&&cs[cat]!=="standard"?"#7C3AED":HR.muted}}>
                              <option value="standard">Standard</option>
                              <option value="percentile_cover">Percentile Cover</option>
                              <option value="fixed_unit_floor">Fixed Unit Floor</option>
                              <option value="manual">Manual</option>
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            );
          })()}

          {/* Section B: Percentile Cover Params */}
          {(()=>{
            const pc=params.percentileCover||DEFAULT_PARAMS.percentileCover;
            const pbp=pc.percentileByPrice||DEFAULT_PARAMS.percentileCover.percentileByPrice;
            const cdm=pc.coverDaysByMovement||DEFAULT_PARAMS.percentileCover.coverDaysByMovement;
            const priceTags=["Premium","High","Medium","Low","Super Low","No Price"];
            const movTags=["Super Fast","Fast","Moderate","Slow","Super Slow"];
            return(
              <Section title="Percentile Cover Params" icon="📊" accent="#7C3AED"
                summary={`P${pbp["Medium"]||90} mid · ${cdm["Moderate"]||3}d mod cover`}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:8,fontWeight:600}}>Percentile by Price Tag</div>
                <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:12}}>
                  <table style={S.table}>
                    <thead><tr style={{background:HR.surfaceLight}}>
                      <th style={S.th}>Price Tag</th>
                      <th style={{...S.th,textAlign:"center"}}>Percentile</th>
                    </tr></thead>
                    <tbody>
                      {priceTags.map((tag,i)=>(
                        <tr key={tag} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                          <td style={{...S.td,fontWeight:600,fontSize:11}}>
                            <TagPill value={tag} colorMap={PRICE_TAG_COLORS}/>
                          </td>
                          <td style={{...S.td,textAlign:"center"}}>
                            <NumInput value={pbp[tag]||90} min={50} max={99} step={1}
                              onChange={v=>saveParams({...params,percentileCover:{...pc,percentileByPrice:{...pbp,[tag]:v}}})}
                              style={{width:64,fontWeight:700,color:"#7C3AED"}}/>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{fontSize:11,color:HR.muted,marginBottom:8,fontWeight:600}}>Cover Days by Movement</div>
                <div style={{...S.card,padding:0,overflow:"hidden"}}>
                  <table style={S.table}>
                    <thead><tr style={{background:HR.surfaceLight}}>
                      <th style={S.th}>Movement</th>
                      <th style={{...S.th,textAlign:"center"}}>Cover Days</th>
                    </tr></thead>
                    <tbody>
                      {movTags.map((tag,i)=>(
                        <tr key={tag} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                          <td style={{...S.td,fontSize:11}}><MovTag value={tag}/></td>
                          <td style={{...S.td,textAlign:"center"}}>
                            <NumInput value={cdm[tag]||2} min={1} max={7} step={1}
                              onChange={v=>saveParams({...params,percentileCover:{...pc,coverDaysByMovement:{...cdm,[tag]:v}}})}
                              style={{width:64,fontWeight:700,color:"#7C3AED"}}/>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            );
          })()}

          {/* Section B2: PCT Guards */}
          {(()=>{
            const capDays = params.pctDocCap ?? 30;
            const capTags = params.pctDocCapPriceTags || ["High","Premium"];
            const minNZD = params.pctMinNZD ?? 2;
            const allPriceTags = ["Premium","High","Medium","Low","Super Low","No Price"];
            return(
              <Section title="PCT Guards" icon="📏" accent="#C0392B"
                summary={`Min NZD ${minNZD} · ${capDays}D DOC cap on ${capTags.join(", ") || "none"}`}>
                <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>
                  Guards against PCT over-stocking: NZD threshold falls back to Standard for sparse data. DOC cap limits inventory days for selected price tags.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 2fr",gap:12}}>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Min NZD for PCT</div>
                    <NumInput value={minNZD} min={1} max={10} step={1}
                      onChange={v=>saveParams({...params,pctMinNZD:v})}
                      style={{width:"100%",fontWeight:700,color:"#C0392B"}}/>
                    <div style={{fontSize:9,color:HR.muted,marginTop:4}}>Below this → Standard fallback</div>
                  </div>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>DOC Cap (days)</div>
                    <NumInput value={capDays} min={0} max={90} step={1}
                      onChange={v=>saveParams({...params,pctDocCap:v})}
                      style={{width:"100%",fontWeight:700,color:"#C0392B"}}/>
                    <div style={{fontSize:9,color:HR.muted,marginTop:4}}>0 = disabled</div>
                  </div>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>DOC Cap Price Tags</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {allPriceTags.map(tag=>{
                        const isOn = capTags.includes(tag);
                        return <button key={tag} onClick={()=>{
                          const next = isOn ? capTags.filter(t=>t!==tag) : [...capTags, tag];
                          saveParams({...params,pctDocCapPriceTags:next});
                        }} style={{padding:"4px 8px",borderRadius:4,fontSize:10,fontWeight:600,cursor:"pointer",
                          border:`1px solid ${isOn?"#C0392B":HR.border}`,
                          background:isOn?"#FEE2E2":"#fff",color:isOn?"#C0392B":HR.muted}}>{tag}</button>;
                      })}
                    </div>
                  </div>
                </div>
              </Section>
            );
          })()}

          {/* Section C: Fixed Unit Floor Params */}
          {(()=>{
            const fu=params.fixedUnitFloor||DEFAULT_PARAMS.fixedUnitFloor;
            return(
              <Section title="Fixed Unit Floor Params" icon="📐" accent="#7C3AED"
                summary={`P${fu.orderQtyPercentile||90} · ${fu.maxMultiplier||1.5}× + ${fu.maxAdditive||1}`}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Order Qty Percentile</div>
                    <NumInput value={fu.orderQtyPercentile||90} min={50} max={99} step={1}
                      onChange={v=>saveParams({...params,fixedUnitFloor:{...fu,orderQtyPercentile:v}})}
                      style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
                  </div>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Max Multiplier</div>
                    <NumInput value={fu.maxMultiplier||1.5} min={1} max={3} step={0.1}
                      onChange={v=>saveParams({...params,fixedUnitFloor:{...fu,maxMultiplier:v}})}
                      style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
                  </div>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Max Additive</div>
                    <NumInput value={fu.maxAdditive||1} min={0} max={5} step={1}
                      onChange={v=>saveParams({...params,fixedUnitFloor:{...fu,maxAdditive:v}})}
                      style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
                  </div>
                </div>
              </Section>
            );
          })()}

          {/* Section D: Brand Lead Time (DC) */}
          {(()=>{
            const blt=params.brandLeadTimeDays||{_default:2};
            const allBrands=[...new Set(Object.values(skuMaster).map(s=>s.brand).filter(Boolean))].sort();
            const configuredBrands=Object.keys(blt).filter(k=>k!=="_default");
            const availableBrands=allBrands.filter(b=>!configuredBrands.includes(b));
            return(
              <Section title="Brand Lead Time (DC)" icon="🚚" accent="#7C3AED"
                summary={`Default ${blt._default||2}d · ${configuredBrands.length} brand override${configuredBrands.length!==1?"s":""}`}>
                <div style={{...S.card,marginBottom:10,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <div style={{fontWeight:600,color:HR.text,fontSize:12}}>Default Lead Time (days)</div>
                    <NumInput value={blt._default||2} min={1} max={10} step={1}
                      onChange={v=>saveParams({...params,brandLeadTimeDays:{...blt,_default:v}})}
                      style={{width:64,fontWeight:700,color:"#7C3AED"}}/>
                  </div>
                </div>
                {configuredBrands.length>0&&(
                  <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:10}}>
                    <table style={S.table}>
                      <thead><tr style={{background:HR.surfaceLight}}>
                        <th style={S.th}>Brand</th>
                        <th style={{...S.th,textAlign:"center"}}>Lead Days</th>
                        <th style={{...S.th,textAlign:"center"}}>Remove</th>
                      </tr></thead>
                      <tbody>
                        {configuredBrands.map((brand,i)=>(
                          <tr key={brand} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                            <td style={{...S.td,fontWeight:600,fontSize:11}}>{brand}</td>
                            <td style={{...S.td,textAlign:"center"}}>
                              <NumInput value={blt[brand]||2} min={1} max={10} step={1}
                                onChange={v=>saveParams({...params,brandLeadTimeDays:{...blt,[brand]:v}})}
                                style={{width:64,color:"#7C3AED",fontWeight:700}}/>
                            </td>
                            <td style={{...S.td,textAlign:"center"}}>
                              <button onClick={()=>{const next={...blt};delete next[brand];saveParams({...params,brandLeadTimeDays:next});}}
                                style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:11}}>✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {availableBrands.length>0&&(
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <select id="newLeadBrand" style={{...S.input,fontSize:11,flex:1}}>
                      {availableBrands.map(b=><option key={b} value={b}>{b}</option>)}
                    </select>
                    <button onClick={()=>{
                      const sel=document.getElementById("newLeadBrand");
                      if(!sel?.value)return;
                      saveParams({...params,brandLeadTimeDays:{...(params.brandLeadTimeDays||{_default:2}),[sel.value]:5}});
                    }} style={{background:HR.green,color:HR.white,border:"none",padding:"7px 14px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>+ Add</button>
                  </div>
                )}
              </Section>
            );
          })()}

        </div>
      </div>{/* end col 2 */}

      {/* ══════════════ COLUMN 3 ══════════════ */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div style={{
          background:"#DCFCE7",border:"1px solid #86EFAC",borderRadius:8,
          padding:"12px 16px",marginBottom:4,
          display:"flex",alignItems:"center",gap:10,
        }}>
          <span style={{fontSize:20}}>🔍</span>
          <span style={{fontWeight:800,fontSize:16,color:HR.green,letterSpacing:"-0.3px"}}>
            Preview Section — Impact of the Tweaks
          </span>
        </div>
        <div style={{paddingLeft:0}}>
          <div style={{background:HR.surface,borderRadius:8,border:`1px solid ${HR.border}`,padding:"14px 16px"}}>
            <ImpactPreviewPanelV2
              params={params}
              savedParams={savedParams}
              invoiceData={invoiceData}
              skuMaster={skuMaster}
              minReqQty={minReqQty}
              newSKUQty={newSKUQty}
              deadStock={deadStock}
              priceData={priceData}
              hasChanges={hasChanges}
              previewState={previewState}
              setPreviewState={setPreviewState}
              onSetRunFn={fn=>{ runPreviewRef.current = fn; }}
            />
          </div>
        </div>
      </div>{/* end col 3 */}

    </div>{/* end 3-col grid */}
  </div>
)}{/* end logic tab */}
{tab==="overrides"&&isAdmin&&<OverridesTab coreOverrides={coreOverrides} saveCoreOverrides={saveCoreOverrides} priceData={priceData} results={results} newSKUQty={newSKUQty} skuMaster={skuMaster} params={params}/>}
      </div>{/* end pageWrap */}
      {/* Toast notification */}
      {toastMsg && (
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:HR.black,color:HR.white,padding:"8px 20px",borderRadius:8,fontSize:12,fontWeight:600,zIndex:9999,boxShadow:"0 4px 12px rgba(0,0,0,0.2)"}}>{toastMsg}</div>
      )}
    </div>
  );
}