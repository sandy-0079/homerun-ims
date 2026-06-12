// Plywood Network v2 tab — rebuilt to mirror v1 UX (spec §6b).
// Workflow: plan fitted on first 75 days; last 15 days are the out-of-window report
// card (per-DS service + OOS column). Tune sub-tab: knobs + Auto-tune Pareto frontier.
// Publish (admin) saves config — the engine refits the SAME formula on the FULL window.
// All computation client-side; only Publish writes to Supabase.
import React, { useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ReferenceLine, ResponsiveContainer, LineChart, Line,
} from "recharts";
import {
  V2_DEFAULTS, evaluatePlan, autoTune, deriveNZDBuckets, bucketOf, planFootprint,
  computePlywoodNetworkV2Results,
} from "../engine/strategies/plywoodV2/index.js";
import { percentile, inferThickness } from "../engine/utils.js";
import { DS_LIST } from "../engine/constants.js";

const HR = {
  yellow:"#F5C400",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",green:"#16a34a",red:"#DC2626",amber:"#F59E0B",purple:"#7C3AED",blue:"#1e40af",
};
const BUCKET_COLORS = [
  { bg:"#F8F8F8", badge:{background:"#F1F5F9",color:"#64748B"} },        // NZD 0
  { bg:"#FFFBEB", badge:{background:"#FEF3C7",color:"#92400E"} },        // low
  { bg:"#F0F9FF", badge:{background:"#DBEAFE",color:"#1e40af"} },        // mid
  { bg:"#F0FDF4", badge:{background:"#DCFCE7",color:"#166534"} },        // high
];
const sel = {fontSize:11,padding:"4px 8px",border:`1px solid ${HR.border}`,borderRadius:5,background:"#fff",color:"#555",cursor:"pointer",outline:"none"};
const btn = (on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,whiteSpace:"nowrap",outline:"none"});

const LOCATIONS = [...DS_LIST, "DC"];

function fmt1(v) { return v == null ? "—" : (Math.round(v * 10) / 10).toString(); }

function svcColor(s) { return s >= 0.99 ? HR.green : s >= 0.95 ? HR.amber : HR.red; }

function capBar(used, total, label) {
  const pct = total > 0 ? used / total * 100 : 0;
  const col = pct > 110 ? HR.red : pct > 100 ? HR.amber : HR.green;
  return (
    <div key={label} style={{flex:1,padding:"5px 10px",border:`1px solid ${HR.border}`,borderRadius:6,background:"#FAFAF8"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:3}}>
        <span style={{fontSize:10,fontWeight:600,color:"#555"}}>{label}</span>
        <span style={{fontSize:10,fontWeight:700,color:col}}>{used}/{total} · {pct.toFixed(0)}%{pct>100?" Over":""}</span>
      </div>
      <div style={{height:4,background:"#E5E5D0",borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${Math.min(100,pct)}%`,background:col,borderRadius:2}}/>
      </div>
    </div>
  );
}

// knob keys that define the formula — used for the testing/published phase check
const KNOB_KEYS = ["minLocalDayPercentile","minNetOrderPercentile","minDocCapDays","deadFloorMode","maxMode","lookbackDays","bulkOrderThreshold","leadDays","thickBoundaryMm","dcReplPercentile","dcBulkPercentile","dcCoverDays","allocMode"];
function sameKnobs(a, b) {
  if (!a || !b) return false;
  return KNOB_KEYS.every(k => (a[k] ?? V2_DEFAULTS[k]) === (b[k] ?? V2_DEFAULTS[k]));
}

// ── SKU modal: formula derivation + charts + misses ─────────────────────────
function SKUModalV2({ row, loc, ev, cfg, dcInfo, published, onClose }) {
  if (!row) return null;
  const isDC = loc === "DC";
  const d = ev.fitDemand;
  const days = Object.entries(d.regularDaily[row.sku]?.[loc] || {}).sort();
  const dayVals = days.map(([, q]) => q).sort((a, b) => a - b);
  const netOrders = [...(d.regOrderQtys[row.sku] || [])].sort((a, b) => a - b);
  const localOrders = d.regOrderQtysByDS?.[row.sku]?.[loc] || [];
  const netAbq = netOrders.length ? Math.ceil(netOrders.reduce((a, b) => a + b, 0) / netOrders.length) : 1;
  const localPct = cfg.minLocalDayPercentile ?? 90;
  const netPct = cfg.minNetOrderPercentile ?? 90;
  const docCap = cfg.minDocCapDays ?? 45;
  const span = d.windowDates.length;
  const p90Local = dayVals.length ? Math.ceil(percentile(dayVals, localPct)) : 0;
  const p90Net = netOrders.length ? Math.ceil(percentile(netOrders, netPct)) : 1;
  const qtySum = dayVals.reduce((a, b) => a + b, 0);
  const docVal = dayVals.length && docCap > 0 ? Math.ceil((qtySum / span) * docCap) : null;
  const localOrdAbq = dayVals.length ? Math.ceil(qtySum / dayVals.length) : 0;
  const misses = ev.oosCounts[row.sku]?.[loc]?.events || [];
  const fullP = ev.fullPlan?.[row.sku]?.[loc];

  // timeline (fit window) with Min/Max reference lines
  const dailyMap = d.regularDaily[row.sku]?.[loc] || {};
  const timeline = d.windowDates.map(dt => ({ date: dt.slice(5), qty: dailyMap[dt] || 0 }));
  const yMax = Math.ceil(Math.max(...timeline.map(t => t.qty), row.max || 0, 1) * 1.15);
  const barSize = Math.max(2, Math.min(16, Math.floor(420 / Math.max(timeline.length, 1))));

  // order-size histogram: local (blue) vs rest of network (grey)
  const hist = (() => {
    const b = {};
    netOrders.forEach(q => { const k = Math.ceil(q); if (!b[k]) b[k] = { qty: k, local: 0, network: 0 }; b[k].network++; });
    localOrders.forEach(q => { const k = Math.ceil(q); b[k].network--; b[k].local++; });
    return Object.values(b).sort((a, c) => a.qty - c.qty);
  })();

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:10,padding:"16px 20px",width:"min(860px,96vw)",maxHeight:"88vh",overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.18)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,lineHeight:1.3}}>{row.name}</div>
            <div style={{fontSize:10,color:"#888",marginTop:2}}>
              {row.sku} · {row.mm != null ? `${row.mm}mm` : "—"} · {row.brand} · <b>{loc}</b>
              <span style={{marginLeft:12,color:"#333",fontWeight:600}}>
                Min: {row.min} · Max: {row.max} · {row.nzd} NZD · ABQ: {fmt1(row.abq)}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{background:"none",border:`1px solid ${HR.border}`,borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:11,color:"#888",flexShrink:0,marginLeft:12}}>Close ✕</button>
        </div>
        <div style={{borderTop:"1px solid #F0F0E8",marginBottom:10}}/>

        {/* Formula derivation */}
        {isDC ? (
          <div style={{fontSize:11,lineHeight:1.9,color:"#444",background:"#FAFAF8",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <div>DC Min = Replenishment P{cfg.dcReplPercentile ?? 98} of TO drain (<b>{dcInfo?.repl ?? "—"}</b>) + Bulk P{cfg.dcBulkPercentile ?? 90} (<b>{dcInfo?.bulk ?? "—"}</b>) = <b style={{color:"#B91C1C"}}>{row.min}</b></div>
            <div>DC Max = Min + cycle stock ({cfg.dcCoverDays ?? 2}d × mean drain = <b>{dcInfo?.cycle ?? "—"}</b>) = <b style={{color:HR.green}}>{row.max}</b></div>
          </div>
        ) : row.nzd === 0 ? (
          <div style={{fontSize:11,lineHeight:1.9,color:"#444",background:"#F8F8F8",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <span style={{...BUCKET_COLORS[0].badge,padding:"1px 6px",borderRadius:3,fontSize:9,fontWeight:700,marginRight:8}}>NZD 0</span>
            No regular selling days at {loc} in the fit window.
            <div>Network ABQ = {netOrders.reduce((a,b)=>a+b,0)} qty ÷ {netOrders.length} orders = <b>{netAbq}</b> → <b style={{color:"#B91C1C"}}>Min = {row.min}</b> · Max = Min+1 = <b style={{color:HR.green}}>{row.max}</b></div>
          </div>
        ) : (
          <div style={{fontSize:11,lineHeight:1.9,color:"#444",background:"#FAFAF8",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <div>
              Min = max( P{localPct} of {row.nzd} local selling days = <b>{p90Local}</b>,
              &nbsp;P{netPct} of {netOrders.length} network orders = <b>{p90Net}</b> )
              {docVal != null && (
                <span> → DOC cap: {qtySum} qty ÷ {span}d × {docCap}d = <b>{docVal}</b> (floor: local ABQ {localOrdAbq})</span>
              )}
              &nbsp;= <b style={{color:"#B91C1C"}}>{row.min}</b>
            </div>
            <div>Max = max( worst local day = <b>{dayVals.length ? dayVals[dayVals.length-1] : 0}</b>, Min+1 ) = <b style={{color:HR.green}}>{row.max}</b></div>
          </div>
        )}

        {/* Misses in the test window */}
        {!isDC && misses.length > 0 && (
          <div style={{fontSize:11,background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <b style={{color:HR.red}}>{misses.length} OOS event{misses.length>1?"s":""} in the {ev.testWindow.from} → {ev.testWindow.to} test window:</b>
            {misses.map((e, i) => (
              <div key={i} style={{marginTop:3}}>
                {e.date} · order {e.orderId} · short <b>{e.short}</b> sheets
                {!published && (e.selfCorrects
                  ? <span style={{marginLeft:8,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:"#DCFCE7",color:"#166534"}}>self-corrects on publish (refit Max {e.fullRefitMax})</span>
                  : <span style={{marginLeft:8,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:"#FEF3C7",color:"#92400E"}}>still uncovered after refit (Max {e.fullRefitMax})</span>)}
              </div>
            ))}
            {!published && fullP && <div style={{marginTop:4,color:"#888",fontSize:10}}>After publish (full-window refit): Min {fullP.min} / Max {fullP.max}</div>}
            {published && fullP && <div style={{marginTop:4,color:"#888",fontSize:10}}>Published plan (full-window fit): Min {fullP.min} / Max {fullP.max}</div>}
          </div>
        )}

        {/* Charts */}
        {!isDC && (
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 380px",minWidth:320}}>
              <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:4}}>Daily regular demand at {loc} (fit window) vs Min/Max</div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={timeline} margin={{top:4,right:8,bottom:0,left:-22}}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
                  <XAxis dataKey="date" tick={{fontSize:8}} interval={Math.ceil(timeline.length/10)}/>
                  <YAxis tick={{fontSize:9}} domain={[0, yMax]}/>
                  <RTooltip contentStyle={{fontSize:10}}/>
                  <Bar dataKey="qty" fill={HR.blue} barSize={barSize}/>
                  <ReferenceLine y={row.min} stroke="#B91C1C" strokeDasharray="4 3" label={{value:`Min ${row.min}`,fontSize:9,fill:"#B91C1C",position:"insideTopRight"}}/>
                  <ReferenceLine y={row.max} stroke={HR.green} strokeDasharray="4 3" label={{value:`Max ${row.max}`,fontSize:9,fill:HR.green,position:"insideTopRight"}}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{flex:"1 1 320px",minWidth:280}}>
              <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:4}}>Order sizes — {loc} (blue) vs rest of network (grey)</div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={hist} margin={{top:4,right:8,bottom:0,left:-22}}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
                  <XAxis dataKey="qty" tick={{fontSize:9}}/>
                  <YAxis tick={{fontSize:9}} allowDecimals={false}/>
                  <RTooltip contentStyle={{fontSize:10}}/>
                  <Bar dataKey="local" stackId="a" fill={HR.blue} barSize={14}/>
                  <Bar dataKey="network" stackId="a" fill="#CBD5E1" barSize={14}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tune sub-tab (state lifted to parent so results survive sub-tab switches) ──
function TunePanel({ cfgDraft, setCfgDraft, invoiceData, skuMaster, isAdmin, onSaveConfig, tuneResult, setTuneResult }) {
  const [tuning, setTuning] = useState(false);

  const runTune = () => {
    setTuning(true);
    setTimeout(() => {
      try {
        const r = autoTune(invoiceData, skuMaster, { ...cfgDraft });
        setTuneResult(r);
      } catch (e) { console.error("auto-tune error:", e); }
      setTuning(false);
    }, 30);
  };

  const applyKnobs = (knobs) => setCfgDraft(d => ({ ...d, ...knobs }));
  const knobsActive = (knobs) =>
    knobs.minLocalDayPercentile === cfgDraft.minLocalDayPercentile &&
    knobs.minNetOrderPercentile === cfgDraft.minNetOrderPercentile &&
    knobs.minDocCapDays === cfgDraft.minDocCapDays &&
    (knobs.deadFloorMode ?? "abq") === (cfgDraft.deadFloorMode ?? "abq") &&
    (knobs.maxMode ?? "worstDay") === (cfgDraft.maxMode ?? "worstDay");

  const chartData = (tuneResult?.frontier || []).map(r => ({
    footprint: r.footprint, service: +(r.service * 100).toFixed(2),
    serviceAvg: +(r.serviceAvg * 100).toFixed(2),
    knobs: r.knobs, overCount: r.overCount, overNodes: r.overNodes,
  }));
  const activeIdx = chartData.findIndex(d => knobsActive(d.knobs));
  const dotColor = (oc) => oc === 0 ? HR.green : oc <= 2 ? HR.amber : HR.white;
  const knobLabel = (k) => `P${k.minLocalDayPercentile}/P${k.minNetOrderPercentile||"off"}/cap${k.minDocCapDays||"off"} · dead:${k.deadFloorMode==="lean1"?"1/2":"ABQ"} · max:${k.maxMode==="minPlus1"?"Min+1":"worst day"}`;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Full-width frontier chart */}
      <div style={{background:HR.surface,borderRadius:8,padding:14,border:`1px solid ${HR.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,flexWrap:"wrap"}}>
          <span style={{fontSize:12,fontWeight:700}}>Auto-tune — service vs inventory frontier</span>
          <button style={btn(true)} onClick={runTune} disabled={tuning}>{tuning ? "Sweeping…" : tuneResult ? "Re-run Auto-tune" : "Run Auto-tune"}</button>
          <span style={{fontSize:10,color:HR.muted}}>240 configs (knobs + dead-floor + Max modes) × 2 folds · Y-axis = same 15d service the SKUs tab shows · click any point to apply & preview</span>
        </div>
        {tuneResult && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{top:8,right:16,bottom:4,left:6}}
                onClick={(st)=>{ const p = st?.activePayload?.[0]?.payload; if (p) applyKnobs(p.knobs); }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
                <XAxis dataKey="footprint" tick={{fontSize:9}} label={{value:"Total sheets (ΣMax, all DSes)",fontSize:9,position:"insideBottom",offset:-2}}/>
                <YAxis dataKey="service" tick={{fontSize:9}} domain={["dataMin - 0.3","dataMax + 0.3"]} tickFormatter={v=>v.toFixed(1)} label={{value:"15d service %",fontSize:9,angle:-90,position:"insideLeft",offset:8}}/>
                <RTooltip contentStyle={{fontSize:10}}
                  formatter={(v,n,p)=>[
                    `15d: ${v}% · 2-fold avg: ${p.payload.serviceAvg}% · ${p.payload.overCount===0?"all DSes within capacity":`over at: ${p.payload.overNodes.join(", ")}`} · ${knobLabel(p.payload.knobs)} · click to apply`,
                    "service"]}/>
                {tuneResult.capacityTotal > 0 && (
                  <ReferenceLine x={tuneResult.capacityTotal} stroke={HR.red} strokeDasharray="4 3" label={{value:`Σ capacity ${tuneResult.capacityTotal}`,fontSize:9,fill:HR.red,position:"insideTopLeft"}}/>
                )}
                <Line type="monotone" dataKey="service" stroke={HR.purple} strokeWidth={2}
                  dot={(props)=>{ const { cx, cy, payload, index } = props; return (
                    <circle key={index} cx={cx} cy={cy} r={index===activeIdx?7:5}
                      fill={index===activeIdx?HR.yellow:dotColor(payload.overCount)}
                      stroke={payload.overCount===0?HR.green:HR.purple} strokeWidth={2} style={{cursor:"pointer"}}
                      onClick={(e2)=>{e2.stopPropagation(); applyKnobs(payload.knobs);}}/>
                  );}}
                  activeDot={(props)=>{ const { cx, cy, payload } = props; return (
                    <circle cx={cx} cy={cy} r={8} fill={HR.yellow} stroke={HR.purple} strokeWidth={2} style={{cursor:"pointer"}}
                      onClick={(e2)=>{e2.stopPropagation(); applyKnobs(payload.knobs);}}/>
                  );}}/>
              </LineChart>
            </ResponsiveContainer>
            <div style={{fontSize:9,color:HR.muted,marginTop:2}}>
              <span style={{color:HR.green,fontWeight:700}}>● green</span> = every DS within capacity ·
              <span style={{color:HR.amber,fontWeight:700}}> ● amber</span> = 1–2 nodes over ·
              <span style={{color:HR.purple,fontWeight:700}}> ○ white</span> = 3+ nodes over ·
              <span style={{color:HR.yellow,fontWeight:700}}> ● yellow</span> = currently applied. Hover any point for which nodes are over.
            </div>
            <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
              {(tuneResult.presets.fitsCapacity
                ? [["Fits capacity ●","fitsCapacity"],["Balanced","balanced"],["Service-first","serviceFirst"]]
                : [["Closest to green","closest"],["Balanced","balanced"],["Service-first","serviceFirst"]]
              ).map(([label,key]) => {
                const p = tuneResult.presets[key];
                if (!p) return null;
                const active = knobsActive(p.knobs);
                return (
                  <div key={key} onClick={()=>applyKnobs(p.knobs)}
                    style={{flex:1,minWidth:170,cursor:"pointer",border:`2px solid ${active?HR.yellow:HR.border}`,borderRadius:8,padding:"8px 10px",background:active?"#FFFDF0":HR.white}}>
                    <div style={{fontSize:11,fontWeight:700}}>{label}{active && " ✓"}</div>
                    <div style={{fontSize:14,fontWeight:800,color:svcColor(p.service)}}>{(p.service*100).toFixed(2)}%</div>
                    <div style={{fontSize:9,color:HR.muted}}>{p.footprint} sheets · {knobLabel(p.knobs)}{p.overCount > 0 ? ` · over at: ${p.overNodes.join(", ")}` : " · all DSes within capacity"}</div>
                  </div>
                );
              })}
            </div>
            {!tuneResult.presets.fitsCapacity && tuneResult.presets.closest && (
              <div style={{fontSize:10,color:"#92400E",background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:6,padding:"6px 10px",marginTop:6}}>
                No configuration keeps every DS within capacity — even the leanest plan exceeds {tuneResult.presets.closest.overNodes.join(" and ")}.
                Holding minimum presence for every SKU physically exceeds those racks: getting to green needs assortment cuts (Keep Score) or added racking at those nodes.
              </div>
            )}
            <div style={{fontSize:10,color:HR.muted,marginTop:6}}>
              {tuneResult.bucketSplit
                ? <span>Bucket-split DOC cap adopted: slow {tuneResult.bucketSplit.low}d / fast {tuneResult.bucketSplit.high || "off"}</span>
                : <span>Bucket-split DOC cap tested — did not clear the +0.3pt out-of-fold gate; simple formula stands.</span>}
            </div>
          </>
        )}
        {!tuneResult && !tuning && <div style={{fontSize:11,color:HR.muted,padding:"18px 0"}}>Run the sweep to see the service-vs-inventory frontier and pick an operating point.</div>}
      </div>

      {/* Knobs + publish below the chart */}
      <div style={{background:HR.surface,borderRadius:8,padding:14,border:`1px solid ${HR.border}`}}>
        <div style={{fontSize:12,fontWeight:700,borderBottom:`2px solid ${HR.yellow}`,paddingBottom:4,marginBottom:10}}>Knobs</div>
        <div style={{display:"flex",gap:"6px 24px",flexWrap:"wrap"}}>
          {[
            ["minLocalDayPercentile","Local day percentile"],
            ["minNetOrderPercentile","Network order pct (0 = off)"],
            ["minDocCapDays","DOC cap days (0 = off)"],
            ["lookbackDays","Lookback days"],
            ["bulkOrderThreshold","Bulk threshold (sheets)"],
            ["leadDays","Supplier lead days"],
            ["thickBoundaryMm","Thick boundary (mm)"],
            ["dcReplPercentile","DC replenishment pct"],
            ["dcBulkPercentile","DC bulk pct"],
            ["dcCoverDays","DC cycle cover days"],
          ].map(([key,label]) => (
            <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,minWidth:240}}>
              <span style={{fontSize:11}}>{label}</span>
              <input type="number" step="any" style={{...sel,width:70,cursor:"text"}}
                value={cfgDraft[key]} onChange={e=>setCfgDraft(d=>({...d,[key]:Number(e.target.value)}))}/>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,minWidth:240}}>
            <span style={{fontSize:11}}>Dead-combo floor</span>
            <select style={{...sel,width:110}} value={cfgDraft.deadFloorMode ?? "abq"}
              onChange={e=>setCfgDraft(d=>({...d,deadFloorMode:e.target.value}))}>
              <option value="abq">Network ABQ</option>
              <option value="lean1">Lean (1/2)</option>
            </select>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,minWidth:240}}>
            <span style={{fontSize:11}}>Active-combo Max</span>
            <select style={{...sel,width:110}} value={cfgDraft.maxMode ?? "worstDay"}
              onChange={e=>setCfgDraft(d=>({...d,maxMode:e.target.value}))}>
              <option value="worstDay">Worst local day</option>
              <option value="minPlus1">Min + 1</option>
            </select>
          </div>
        </div>
        <div style={{borderTop:`1px solid ${HR.border}`,marginTop:10,paddingTop:10,maxWidth:480}}>
          {isAdmin ? (
            <>
              <button style={{...btn(true),width:"100%",padding:"8px 0"}} onClick={()=>onSaveConfig && onSaveConfig(cfgDraft)}>
                Publish — save config & refit on FULL window
              </button>
              <div style={{fontSize:9,color:HR.muted,marginTop:5}}>
                The tab previews a 75-day fit scored on the last 15 days. Publishing re-runs the engine with the same knobs on the entire window, absorbing the test days into the fit.
              </div>
            </>
          ) : <div style={{fontSize:10,color:HR.muted}}>Read-only — admin login required to publish.</div>}
        </div>
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────
export default function PlywoodNetworkV2Tab({ invoiceData, skuMaster, isAdmin, plywoodNetworkV2Config, onSaveConfig, isActive, engineResults }) {
  const [subTab, setSubTab] = useState("skus");
  const [loc, setLoc] = useState("DS01");
  const [cfgDraft, setCfgDraft] = useState(() => ({ ...V2_DEFAULTS, ...(plywoodNetworkV2Config || {}) }));
  const [tuneResult, setTuneResult] = useState(null);   // lifted: survives sub-tab switches
  const [selected, setSelected] = useState(null);

  // Phase: published = saved config matches the draft (and a config exists)
  const published = !!plywoodNetworkV2Config && sameKnobs(cfgDraft, { ...V2_DEFAULTS, ...plywoodNetworkV2Config });
  const [query, setQuery] = useState("");
  const [fBrand, setFBrand] = useState("All");
  const [fType, setFType] = useState("All");
  const [fBucket, setFBucket] = useState("All");
  const [fOOS, setFOOS] = useState(false);
  const [sortBy, setSortBy] = useState("nzd");
  const [sortDir, setSortDir] = useState(-1);

  const ready = invoiceData?.length > 0 && Object.keys(skuMaster || {}).length > 0;

  // 75/15 evaluation (the tab's core computation)
  const ev = useMemo(() => {
    if (!ready) return null;
    try { return evaluatePlan(invoiceData, skuMaster, cfgDraft, { testDays: 15 }); }
    catch (e) { console.error("v2 evaluate error:", e); return null; }
  }, [ready, invoiceData, skuMaster, cfgDraft]);

  // DC plan (full pipeline incl. drain-based DC) on the fit window
  const dcRes = useMemo(() => {
    if (!ev) return null;
    try {
      const fitInv = invoiceData.filter(r => r.date <= ev.fitWindow.to);
      return computePlywoodNetworkV2Results(fitInv, skuMaster, { plywoodNetworkV2Config: cfgDraft });
    } catch (e) { console.error("v2 dc error:", e); return null; }
  }, [ev, invoiceData, skuMaster, cfgDraft]);

  const buckets = useMemo(() => ev ? deriveNZDBuckets(ev.fitDemand, ev.universe) : null, [ev]);

  // Build display rows for the selected location
  const rows = useMemo(() => {
    if (!ev) return [];
    const out = [];
    for (const sku of Object.keys(ev.universe)) {
      const meta = ev.universe[sku];
      const mm = inferThickness(meta.name);
      const isDC = loc === "DC";
      const p = isDC ? null : ev.plan[sku][loc];
      const dc = isDC ? dcRes?.[sku]?.dcResult : null;
      const dd = isDC ? {} : (ev.fitDemand.regularDaily[sku]?.[loc] || {});
      const dayVals = Object.values(dd);
      const nzd = dayVals.length;
      const qty = dayVals.reduce((a, b) => a + b, 0);
      const oos = isDC ? null : (ev.oosCounts[sku]?.[loc]?.oosOrders || 0);
      const floored = engineResults?.[sku]?.stores?.[loc]?.logicTag === "SKU Floor";
      out.push({
        sku, name: meta.name, brand: meta.brand, mm,
        tclass: ev.tclass[sku],
        nzd, qty, abq: nzd ? qty / nzd : 0,
        bucket: isDC ? null : bucketOf(nzd, buckets?.edges || [1]),
        min: isDC ? (dc?.min ?? 0) : p.min,
        max: isDC ? (dc?.max ?? 0) : p.max,
        oos, floored,
        dcInfo: isDC ? dcRes?.[sku]?.v2?.dcDetail : null,
      });
    }
    return out;
  }, [ev, dcRes, loc, buckets, engineResults]);

  if (!ready) return <div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>Loading data, please wait...</div>;
  if (!ev) return <div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>No plywood SKUs found for v2 universe.</div>;

  const isDC = loc === "DC";
  const svc = ev.serviceLevels.regular;
  const fp = planFootprint(ev.plan);
  const caps = cfgDraft.dsCapacities || {};
  const brands = ["All", ...[...new Set(rows.map(r => r.brand).filter(Boolean))].sort()];

  // location-scoped capacity (thick/thin)
  const thickUsed = rows.filter(r => r.tclass === "thick").reduce((a, r) => a + r.max, 0);
  const thinUsed = rows.filter(r => r.tclass === "thin").reduce((a, r) => a + r.max, 0);
  const thickCap = isDC ? (cfgDraft.dcCapacity?.thick ?? 0) : (caps[loc]?.thick ?? 0);
  const thinCap = isDC ? (cfgDraft.dcCapacity?.thin ?? 0) : (caps[loc]?.thin ?? 0);

  const q = query.toLowerCase();
  const filtered = rows
    .filter(r => {
      if (fBrand !== "All" && r.brand !== fBrand) return false;
      if (fType === "Thick" && r.tclass !== "thick") return false;
      if (fType === "Thin" && r.tclass !== "thin") return false;
      if (!isDC && fBucket !== "All" && (buckets?.labels[r.bucket] !== fBucket)) return false;
      if (fOOS && !(r.oos > 0)) return false;
      if (q && !r.sku.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case "sku": return a.sku.localeCompare(b.sku) * sortDir;
        case "name": return a.name.localeCompare(b.name) * sortDir;
        case "brand": return (a.brand || "").localeCompare(b.brand || "") * sortDir;
        case "mm": return ((b.mm ?? -1) - (a.mm ?? -1)) * sortDir;
        case "nzd": return (b.nzd - a.nzd) * sortDir;
        case "abq": return (b.abq - a.abq) * sortDir;
        case "min": return (b.min - a.min) * sortDir;
        case "max": return (b.max - a.max) * sortDir;
        case "oos": return ((b.oos || 0) - (a.oos || 0)) * sortDir;
        default: return 0;
      }
    });

  const handleSort = col => {
    if (sortBy === col) setSortDir(d => d * -1);
    else { setSortBy(col); setSortDir(["sku", "name", "brand"].includes(col) ? 1 : -1); }
  };
  const sh = (col, label, center) => {
    const on = sortBy === col;
    return (
      <th key={col} onClick={() => handleSort(col)}
        style={{padding:"4px 6px",fontWeight:700,fontSize:10,color:on?HR.purple:"#666",borderBottom:`1px solid ${HR.border}`,
          textAlign:center?"center":"left",whiteSpace:"nowrap",cursor:"pointer",userSelect:"none",background:"#F8F8F2"}}>
        {label}{on ? (sortDir === -1 ? "↓" : "↑") : <span style={{color:"#ccc",fontSize:8}}>↕</span>}
      </th>
    );
  };
  const hasFilter = query || fBrand !== "All" || fType !== "All" || fBucket !== "All" || fOOS;

  return (
    <div>
      {/* header */}
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <h2 style={{margin:0,fontSize:16}}>Plywood Network v2</h2>
        {published ? (
          <span style={{fontSize:10,padding:"2px 10px",borderRadius:10,background:"#DCFCE7",color:HR.green,fontWeight:700,border:"1px solid #BBF7D0"}}>
            ✓ PUBLISHED{isActive ? " · ACTIVE IN ENGINE" : " · engine strategy not switched on"}
          </span>
        ) : (
          <span style={{fontSize:10,padding:"2px 10px",borderRadius:10,background:"#FEF3C7",color:"#92400E",fontWeight:700,border:"1px solid #FDE68A"}}>
            ⚠ TESTING — unsaved knobs, preview only{plywoodNetworkV2Config ? " (differs from published)" : " (nothing published yet)"}
          </span>
        )}
        <span style={{fontSize:10,color:HR.muted}}>
          fit {ev.fitWindow.from} → {ev.fitWindow.to} · tested on {ev.testWindow.from} → {ev.testWindow.to}
        </span>
        <div style={{flex:1}}/>
        <button style={btn(subTab==="skus")} onClick={()=>setSubTab("skus")}>SKUs</button>
        <button style={btn(subTab==="tune")} onClick={()=>setSubTab("tune")}>Tune</button>
      </div>

      {subTab === "tune" ? (
        <TunePanel cfgDraft={cfgDraft} setCfgDraft={setCfgDraft} invoiceData={invoiceData} skuMaster={skuMaster} isAdmin={isAdmin} onSaveConfig={onSaveConfig}
          tuneResult={tuneResult} setTuneResult={setTuneResult}/>
      ) : (
        <div>
          {/* service strip — the 15-day report card */}
          <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap",alignItems:"stretch"}}>
            <div style={{padding:"6px 14px",background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8}}>
              <div style={{fontSize:9,color:HR.muted}}>Regular service — last 15d (out-of-window)</div>
              <div style={{fontSize:20,fontWeight:800,color:svcColor(svc.overall)}}>{(svc.overall*100).toFixed(2)}%</div>
              <div style={{fontSize:9,color:HR.muted}}>{svc.oos} OOS of {svc.total} orders</div>
            </div>
            {DS_LIST.map(ds => {
              const c = svc.perDS[ds];
              const s = c ? c.service : 1;
              return (
                <div key={ds} style={{padding:"6px 12px",background:HR.surface,border:`1px solid ${loc===ds?HR.yellow:HR.border}`,borderRadius:8,cursor:"pointer"}} onClick={()=>setLoc(ds)}>
                  <div style={{fontSize:9,color:HR.muted}}>{ds}</div>
                  <div style={{fontSize:15,fontWeight:700,color:svcColor(s)}}>{(s*100).toFixed(1)}%</div>
                  <div style={{fontSize:9,color:HR.muted}}>{c ? `${c.oos}/${c.total}` : "0 orders"}</div>
                </div>
              );
            })}
            <div style={{padding:"6px 12px",background:HR.surface,border:`1px solid ${loc==="DC"?HR.yellow:HR.border}`,borderRadius:8,cursor:"pointer"}} onClick={()=>setLoc("DC")}>
              <div style={{fontSize:9,color:HR.muted}}>DC</div>
              <div style={{fontSize:15,fontWeight:700,color:HR.text}}>{isDC ? "viewing" : "view"}</div>
              <div style={{fontSize:9,color:HR.muted}}>drain + bulk</div>
            </div>
            <div style={{padding:"6px 14px",background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8,marginLeft:"auto"}}>
              <div style={{fontSize:9,color:HR.muted}}>Total plan footprint (ΣMax, 5 DS)</div>
              <div style={{fontSize:20,fontWeight:800}}>{fp.total}</div>
              <div style={{fontSize:9,color:HR.muted}}>{DS_LIST.map(ds=>`${ds.slice(2)}:${fp.perDS[ds]}`).join(" ")}</div>
            </div>
          </div>

          {/* capacity bars (display-only) */}
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            {capBar(thickUsed, thickCap, `${loc} — Thick (>${cfgDraft.thickBoundaryMm}mm)`)}
            {capBar(thinUsed, thinCap, `${loc} — Thin`)}
          </div>

          {/* filters */}
          <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
            <input type="text" placeholder="Search SKU or name…" value={query} onChange={e=>setQuery(e.target.value)} style={{...sel,width:200,cursor:"text"}}/>
            <select value={fBrand} onChange={e=>setFBrand(e.target.value)} style={sel}>
              {brands.map(b => <option key={b} value={b}>{b==="All"?"All Brands":b}</option>)}
            </select>
            <select value={fType} onChange={e=>setFType(e.target.value)} style={sel}>
              <option value="All">Thick & Thin</option><option value="Thick">Thick only</option><option value="Thin">Thin only</option>
            </select>
            {!isDC && buckets && (
              <select value={fBucket} onChange={e=>setFBucket(e.target.value)} style={sel}>
                <option value="All">All NZD buckets</option>
                {buckets.labels.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            {!isDC && (
              <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,cursor:"pointer",color:HR.red,fontWeight:600}}>
                <input type="checkbox" checked={fOOS} onChange={e=>setFOOS(e.target.checked)}/> OOS only
              </label>
            )}
            {hasFilter && (
              <button onClick={()=>{setQuery("");setFBrand("All");setFType("All");setFBucket("All");setFOOS(false);}}
                style={{fontSize:10,color:HR.purple,background:"none",border:`1px solid ${HR.purple}`,borderRadius:4,padding:"3px 8px",cursor:"pointer"}}>Clear</button>
            )}
            <span style={{fontSize:10,color:"#bbb",marginLeft:"auto"}}>{filtered.length} SKUs</span>
          </div>

          {/* table */}
          <div style={{overflowX:"auto",background:HR.surface,borderRadius:8,border:`1px solid ${HR.border}`}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr>
                {sh("sku","SKU")}
                {sh("name","Item Name")}
                {sh("mm","Thickness",true)}
                {sh("brand","Brand")}
                {!isDC && sh("nzd","NZD",true)}
                {!isDC && sh("abq","ABQ",true)}
                {sh("min", isDC?"DC Min":"Min", true)}
                {sh("max", isDC?"DC Max":"Max", true)}
                {!isDC && sh("oos","OOS (15d)",true)}
              </tr></thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={9} style={{padding:16,textAlign:"center",color:"#aaa"}}>No SKUs match the current filters</td></tr>
                ) : filtered.map(r => {
                  const bc = BUCKET_COLORS[Math.min(r.bucket ?? 0, BUCKET_COLORS.length-1)];
                  return (
                    <tr key={r.sku} onClick={()=>setSelected(r)} style={{background:isDC?"#fff":bc.bg,cursor:"pointer"}}>
                      <td style={{padding:"3px 6px",fontFamily:"monospace",fontSize:10,color:"#555",borderBottom:"1px solid rgba(0,0,0,0.05)",whiteSpace:"nowrap"}}>{r.sku}</td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {r.name}
                        {r.floored && <span style={{marginLeft:5,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"#EDE9FE",color:"#6D28D9",border:"1px solid #C4B5FD"}}>Floor</span>}
                      </td>
                      <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                        <span style={{fontSize:10,color:"#555"}}>{r.mm != null ? `${r.mm}mm` : "—"}</span>
                        <span style={{marginLeft:5,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:r.tclass==="thick"?"#FEF3C7":"#DBEAFE",color:r.tclass==="thick"?"#92400E":HR.blue}}>
                          {r.tclass === "thick" ? "Thick" : "Thin"}
                        </span>
                      </td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555",whiteSpace:"nowrap"}}>{r.brand || "—"}</td>
                      {!isDC && (
                        <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                          <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,...bc.badge}}>{buckets?.labels[r.bucket] ?? r.nzd}</span>
                          <span style={{marginLeft:5,fontSize:10,color:"#555"}}>{r.nzd}</span>
                        </td>
                      )}
                      {!isDC && <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555"}}>{r.nzd ? fmt1(r.abq) : "—"}</td>}
                      <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,color:HR.blue,borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.min}</td>
                      <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,color:"#166534",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.max}</td>
                      {!isDC && (
                        <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,borderBottom:"1px solid rgba(0,0,0,0.05)",color:r.oos>0?HR.red:"#ccc"}}>
                          {r.oos > 0 ? r.oos : "—"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && (
        <SKUModalV2 row={selected} loc={loc} ev={ev} cfg={cfgDraft} dcInfo={selected.dcInfo} published={published} onClose={()=>setSelected(null)}/>
      )}
    </div>
  );
}
