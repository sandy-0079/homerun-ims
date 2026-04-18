import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  LineChart, Line, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { loadFromSupabase, saveToSupabase } from "../supabase";

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
    const dailyMedian = median(dailyTotals);
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
  const threshold = percentile(sku.orderQtys, 75);
  return { minQty, maxQty, threshold };
}

const TAG_STYLE = {padding:"1px 6px",borderRadius:3,fontSize:9,fontWeight:700,whiteSpace:"nowrap",display:"inline-block"};

function ConfigPanel({ type, cfg, onChange, isAdmin, onRun }) {
  const label = type === "thick" ? "Thick (>6mm) — Vertical Storage" : "Thin (≤6mm) — Bin Storage";
  const color = type === "thick" ? "#92400E" : "#0077A8";
  const fields = [
    { key:"tier1NZD",    label:"Running NZD",     hint:"Min NZD to stock at DS" },
    { key:"tier2NZD",    label:"Fallback NZD",    hint:"Below → Super Slow" },
    { key:"minCoverDays",label:"Min Cover Days",  hint:"Min × daily median" },
    { key:"coverDays",   label:"Max Cover Days",  hint:"Max × daily median × buffer" },
    { key:"bufferPct",   label:"Buffer %",        hint:"Safety margin on Max" },
    { key:"capacity",    label:"Capacity (units)",hint:"Physical constraint" },
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
            <tr key={s.sku} onClick={() => onSelectSku(s)} style={{cursor:"pointer",borderTop:`1px solid ${HR.border}`}}
              onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
              onMouseLeave={e => e.currentTarget.style.background = ""}>
              <td style={{padding:"4px 8px",fontWeight:600}}>{s.sku}</td>
              <td style={{padding:"4px 8px",color:HR.muted}}>{s.name}</td>
              <td style={{padding:"4px 8px"}}>{s.mm != null ? `${s.mm}mm` : "—"}</td>
              <td style={{padding:"4px 8px",fontWeight:700}}>{s.nzd}</td>
              <td style={{padding:"4px 8px"}}>{s.dailyMedian.toFixed(1)}</td>
              <td style={{padding:"4px 8px",color:"#16a34a",fontWeight:700}}>{s.nzd > 0 ? s.minQty : "—"}</td>
              <td style={{padding:"4px 8px",color:"#0077A8",fontWeight:700}}>{s.nzd > 0 ? s.maxQty : "—"}</td>
              <td style={{padding:"4px 8px"}}>{s.nzd > 0 ? <span style={{fontSize:10,color:"#555"}}>{">"}{s.threshold}</span> : "—"}</td>
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

function SKUModal({ sku, cfg, onClose, invoiceDateRange }) {
  if (!sku) return null;
  const { minQty, maxQty } = computeMinMax(sku, cfg);
  const qtyBuckets = {};
  sku.orderQtys.forEach(q => { const b = Math.ceil(q); qtyBuckets[b] = (qtyBuckets[b] || 0) + 1; });
  const histData = Object.entries(qtyBuckets).sort((a,b)=>+a[0]-+b[0]).map(([qty,count])=>({qty:+qty,count}));
  const timelineData = invoiceDateRange.dates.map(date => ({ date, qty: sku.dailyMap[date] || 0 }));
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
                <XAxis dataKey="qty" tick={{fontSize:10}}/>
                <YAxis tick={{fontSize:10}}/>
                <RTooltip formatter={(v) => [v, "Orders"]} labelFormatter={l => `Qty: ${l}`}/>
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

function SummaryCards({ skuList, skuMaster, thickCfg }) {
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
  const withSales = skuList.filter(s => s.nzd > 0).length;
  const tier1 = thickCfg?.tier1NZD ?? 10;
  const tier2 = thickCfg?.tier2NZD ?? 2;
  const cards = [
    { num: withSales, lbl: `SKUs with ≥1 sale / ${plywoodActive.length} Active`, sub: `Thick: ${masterThickCount} · Thin: ${masterThinCount} in master`, color:"#0077A8" },
    { num: skuList.filter(s => s.nzd >= tier1).length, lbl:"Running — Stock at DS", sub:`NZD ≥ ${tier1}`, color:"#16a34a" },
    { num: skuList.filter(s => s.nzd >= tier2 && s.nzd < tier1).length, lbl:"Fallback — DC or Supplier", sub:`NZD ${tier2}–${tier1}`, color:"#92400E" },
    { num: skuList.filter(s => s.nzd < tier2).length, lbl:"Super Slow — On Demand", sub:`NZD < ${tier2}`, color:"#6B7280" },
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
  const [thickResults, setThickResults] = useState(null);
  const [thinResults, setThinResults] = useState(null);
  const [selectedSku, setSelectedSku] = useState(null);
  const [selectedSkuType, setSelectedSkuType] = useState(null);

  useEffect(() => {
    const saved = networkConfigs?.[dsFilter] || DS_DEFAULTS[dsFilter];
    setThickCfg({ ...DS_DEFAULTS[dsFilter].thick, ...saved.thick });
    setThinCfg({ ...DS_DEFAULTS[dsFilter].thin, ...saved.thin });
    setThickResults(null);
    setThinResults(null);
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
    if (isAdmin) handleSaveConfig("thick", thickCfg);
  }, [thickSkus, thickCfg, isAdmin, handleSaveConfig]);

  const runThin = useCallback(() => {
    const withMM = thinSkus.map(s => ({ ...s, ...computeMinMax(s, thinCfg) }));
    const capUsed = withMM.filter(s => s.nzd >= thinCfg.tier1NZD).reduce((sum,s) => sum+s.maxQty, 0);
    setThinResults({ skus: withMM, capUsed });
    if (isAdmin) handleSaveConfig("thin", thinCfg);
  }, [thinSkus, thinCfg, isAdmin, handleSaveConfig]);

  if (!invoiceData.length || !Object.keys(skuMaster).length) return (
    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
      Upload invoice CSV and SKU Master in the Upload Data tab to begin.
    </div>
  );
  if (!thickCfg || !thinCfg) return null;

  const dsFallbackLabel = networkConfigs?.[dsFilter]?.fallbackLabel || DS_DEFAULTS[dsFilter]?.fallbackLabel || "DC";

  return (
    <div style={{fontFamily:"Inter,sans-serif",color:HR.text}}>
      {/* DS + Period selectors */}
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:4}}>
          {DS_LIST.map(ds => (
            <button key={ds} onClick={() => setDsFilter(ds)} style={S.btn(dsFilter===ds)}>{ds}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:4,marginLeft:12}}>
          {[{v:45,l:"L45D"},{v:30,l:"L30D"},{v:15,l:"L15D"},{v:7,l:"L7D"}].map(p => (
            <button key={p.v} onClick={() => { setPeriod(p.v); setThickResults(null); setThinResults(null); }} style={S.btn(period===p.v)}>{p.l}</button>
          ))}
        </div>
        {!isAdmin && <span style={{fontSize:10,color:HR.muted,marginLeft:"auto"}}>Configs are view-only · Admin login to edit</span>}
      </div>

      <SummaryCards skuList={baseSkus} skuMaster={skuMaster} thickCfg={thickCfg}/>

      {/* Thick section */}
      <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thick (&gt;6mm) — Vertical Storage</div>
        <ConfigPanel type="thick" cfg={thickCfg} onChange={setThickCfg} isAdmin={isAdmin} onRun={runThick}/>
        {thickResults ? (
          <>
            <CapacityBar used={thickResults.capUsed} total={thickCfg.capacity} label="Thick"/>
            <div style={S.card}>
              <SKUTable skus={thickResults.skus} cfg={thickCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thick"); }}/>
            </div>
          </>
        ) : (
          <div style={{padding:24,textAlign:"center",color:HR.muted,fontSize:12}}>Configure thresholds above and click ▶ Run</div>
        )}
      </div>

      {/* Thin section */}
      <div style={{marginBottom:24}}>
        <div style={S.sectionTitle}>Thin (≤6mm) — Bin Storage</div>
        <ConfigPanel type="thin" cfg={thinCfg} onChange={setThinCfg} isAdmin={isAdmin} onRun={runThin}/>
        {thinResults ? (
          <>
            <CapacityBar used={thinResults.capUsed} total={thinCfg.capacity} label="Thin"/>
            <div style={S.card}>
              <SKUTable skus={thinResults.skus} cfg={thinCfg} fallbackLabel={dsFallbackLabel} onSelectSku={s => { setSelectedSku(s); setSelectedSkuType("thin"); }}/>
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
