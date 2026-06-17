// Plywood Network v2 tab — rebuilt to mirror v1 UX (spec §6b).
// Workflow: plan fitted on first 75 days; last 15 days are the out-of-window report
// card (per-DS service + OOS column). Tune sub-tab: knobs + Auto-tune Pareto frontier.
// Publish (admin) saves config — the engine refits the SAME formula on the FULL window.
// All computation client-side; only Publish writes to Supabase.
import React, { useState, useMemo, useEffect } from "react";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ReferenceLine, ReferenceArea, ResponsiveContainer, LineChart, Line,
} from "recharts";
import {
  V2_DEFAULTS, evaluatePlan, autoTune, deriveNZDBuckets, bucketOf,
  computePlywoodNetworkV2Results, dcEvaluate, dcSweep, replay, keepScoreAnalysis,
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

// top location-pick cards use a 90/80 band
function pillColor(s) { return s >= 0.9 ? HR.green : s >= 0.8 ? HR.amber : HR.red; }
// Hover note — wraps a (dotted-underlined) label; popover drops DOWNWARD so it never clips into
// the nav bar. align left/right anchors it to the trigger edge to avoid horizontal overflow.
function Hint({ text, align = "left", children }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{position:"relative",display:"inline-flex",alignItems:"center",cursor:"default"}}
      onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
      {children}
      {show && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",[align==="right"?"right":"left"]:0,
          background:"#1A1A1A",color:"#fff",borderRadius:6,padding:"8px 12px",fontSize:11,lineHeight:1.55,
          width:240,zIndex:300,boxShadow:"0 4px 14px rgba(0,0,0,0.3)",fontWeight:400,whiteSpace:"normal",textAlign:"left"}}>{text}</div>
      )}
    </span>
  );
}
const dotted = { borderBottom:"1px dotted #94A3B8" };

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtD = (iso) => { if (!iso) return "—"; const [, m, d] = iso.split("-"); return `${+d} ${MON[+m - 1]}`; };

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
const KNOB_KEYS = ["minLocalDayPercentile","minNetOrderPercentile","minDocCapDays","deadFloorMode","maxMode","capacityFit","lookbackDays","bulkOrderThreshold","leadDays","thickBoundaryMm","dcServicePct","dcBulkServicePct","allocMode"];
function sameKnobs(a, b) {
  if (!a || !b) return false;
  if (JSON.stringify(a.dsKnobs || {}) !== JSON.stringify(b.dsKnobs || {})) return false;
  if (JSON.stringify(a.dsCapacities ?? V2_DEFAULTS.dsCapacities) !== JSON.stringify(b.dsCapacities ?? V2_DEFAULTS.dsCapacities)) return false;
  if (JSON.stringify(a.dcCapacity ?? V2_DEFAULTS.dcCapacity) !== JSON.stringify(b.dcCapacity ?? V2_DEFAULTS.dcCapacity)) return false;
  return KNOB_KEYS.every(k => (a[k] ?? V2_DEFAULTS[k]) === (b[k] ?? V2_DEFAULTS[k]));
}
// effective per-DS knobs = global merged with that DS's override
function effKnobsFor(cfg, ds) {
  const o = cfg?.dsKnobs?.[ds] || {};
  const fields = ["minLocalDayPercentile","minNetOrderPercentile","minDocCapDays","deadFloorMode","maxMode"];
  return Object.fromEntries(fields.map(f => [f, o[f] ?? cfg?.[f] ?? V2_DEFAULTS[f]]));
}
function sameEffKnobs(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
const fmtLakh = (v) => v >= 100000 ? `₹${(v/100000).toFixed(1)}L` : `₹${Math.round(v/1000)}K`;
// frontier X-axis tick: sheet count on top, ₹ inventory value beneath (two constraints at a glance)
const sheetTick = (valuePerSheet) => (props) => {
  const { x, y, payload } = props;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} dy={13} textAnchor="middle" fontSize={10} fill="#555">{payload.value.toLocaleString()}</text>
      <text x={0} dy={25} textAnchor="middle" fontSize={8.5} fill="#94A3B8">{fmtLakh(payload.value * (valuePerSheet || 0))}</text>
    </g>
  );
};

// ── SKU modal: formula derivation + charts + misses ─────────────────────────
function SKUModalV2({ row, loc, ev, cfg, dcInfo, drainSeries, published, live, oosCounts, onClose }) {
  if (!row) return null;
  const isDC = loc === "DC";
  const d = live && ev.fullDemand ? ev.fullDemand : ev.fitDemand;
  const days = Object.entries(d.regularDaily[row.sku]?.[loc] || {}).sort();
  const dayVals = days.map(([, q]) => q).sort((a, b) => a - b);
  const netOrders = [...(d.regOrderQtys[row.sku] || [])].sort((a, b) => a - b);
  const localOrders = d.regOrderQtysByDS?.[row.sku]?.[loc] || [];
  const netAbq = netOrders.length ? Math.ceil(netOrders.reduce((a, b) => a + b, 0) / netOrders.length) : 1;
  // effective knobs at this location (per-DS override merged over globals)
  const eff = { ...cfg, ...(cfg.dsKnobs?.[loc] || {}) };
  const localPct = eff.minLocalDayPercentile ?? 90;
  const netPct = eff.minNetOrderPercentile ?? 90;
  const docCap = eff.minDocCapDays ?? 45;
  const span = d.windowDates.length;
  const p90Local = dayVals.length ? Math.ceil(percentile(dayVals, localPct)) : 0;
  const p90Net = netOrders.length ? Math.ceil(percentile(netOrders, netPct)) : 1;
  const qtySum = dayVals.reduce((a, b) => a + b, 0);
  const docVal = dayVals.length && docCap > 0 ? Math.ceil((qtySum / span) * docCap) : null;
  const localOrdAbq = dayVals.length ? Math.ceil(qtySum / dayVals.length) : 0;
  const misses = (oosCounts ?? (live ? ev.liveOosCounts : ev.oosCounts))?.[row.sku]?.[loc]?.events || [];
  const fullP = ev.fullPlan?.[row.sku]?.[loc];

  // timeline = fit window + test window (test days marked) with Min/Max reference lines
  const dailyMap = d.regularDaily[row.sku]?.[loc] || {};
  const testDailyMap = ev.testDemand?.regularDaily?.[row.sku]?.[loc] || {};
  const testDates = ev.testDemand?.windowDates || [];
  // live mode: d already spans the full window incl. test days — don't append twice
  const testSet = new Set(testDates);
  const timeline = live
    ? d.windowDates.map(dt => ({ date: dt.slice(5), qty: dailyMap[dt] || 0, test: testSet.has(dt) }))
    : [
        ...d.windowDates.map(dt => ({ date: dt.slice(5), qty: dailyMap[dt] || 0, test: false })),
        ...testDates.map(dt => ({ date: dt.slice(5), qty: testDailyMap[dt] || 0, test: true })),
      ];
  const testStartLabel = testDates[0]?.slice(5);
  const testEndLabel = testDates[testDates.length - 1]?.slice(5);
  const yMax = Math.ceil(Math.max(...timeline.map(t => t.qty), row.max || 0, 1) * 1.15);
  const barSize = Math.max(2, Math.min(16, Math.floor(420 / Math.max(timeline.length, 1))));

  // order-size histogram: local (blue) vs rest of network (grey)
  const hist = (() => {
    const b = {};
    netOrders.forEach(q => { const k = Math.ceil(q); if (!b[k]) b[k] = { qty: k, local: 0, network: 0 }; b[k].network++; });
    localOrders.forEach(q => { const k = Math.ceil(q); b[k].network--; b[k].local++; });
    return Object.values(b).sort((a, c) => a.qty - c.qty);
  })();

  // ── DC-specific data: reorder point + bulk buffer + TO-drain timeline + daily bulk timeline ──
  const sLevel = dcInfo?.s ?? row.min;
  const buffer = dcInfo?.buffer ?? Math.max(0, row.max - sLevel);   // = max(one bulk order, lead batch)
  const bulkUnit = dcInfo?.bulkUnit ?? 0, leadBatch = dcInfo?.leadBatch ?? 0;
  const bulkDrives = bulkUnit >= leadBatch;
  const trimmedDepth = dcInfo?.trimmedDepth || 0, drainNZD = dcInfo?.nzd ?? 0;
  // daily TO-drain (replenishment demand DC sees) over the window, vs DC Min/Max
  const drainMap = drainSeries?.[row.sku] || {};
  const dcTimeline = d.windowDates.map(dt => ({ date: dt.slice(5), qty: drainMap[dt] || 0 }));
  const dcDrainMax = Math.ceil(Math.max(...dcTimeline.map(t => t.qty), row.max || 0, 1) * 1.15);
  const dcBarSize = Math.max(2, Math.min(16, Math.floor(420 / Math.max(dcTimeline.length, 1))));
  // daily-summed bulk order qty for this SKU over the window — vs DC Min/Max
  const bulkDayMap = isDC ? (d.bulkDaily?.[row.sku] || {}) : {};
  const dcBulkTimeline = isDC ? d.windowDates.map(dt => ({ date: dt.slice(5), qty: bulkDayMap[dt] || 0 })) : [];
  const hasBulk = dcBulkTimeline.some(t => t.qty > 0);
  const dcBulkMax = Math.ceil(Math.max(...dcBulkTimeline.map(t => t.qty), row.max || 0, 1) * 1.15);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:10,padding:"16px 20px",width:"min(860px,96vw)",maxHeight:"88vh",overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.18)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,lineHeight:1.3}}>{row.name}</div>
            <div style={{fontSize:10,color:"#888",marginTop:2}}>
              {row.sku} · {row.mm != null ? `${row.mm}mm` : "—"} · {row.brand} · <b>{loc}</b>
              <span style={{marginLeft:12,color:"#333",fontWeight:600}}>
                Min: {row.min} · Max: {row.max} <span style={{color:"#888",fontWeight:400}}>{live ? "(live — full-window fit)" : "(preview — fitted without the last 15d)"}</span>{isDC ? ` · ${drainNZD} TO-drain days` : ` · ${row.nzd} NZD · ABQ: ${fmt1(row.abq)}`}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{background:"none",border:`1px solid ${HR.border}`,borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:11,color:"#888",flexShrink:0,marginLeft:12}}>Close ✕</button>
        </div>
        <div style={{borderTop:"1px solid #F0F0E8",marginBottom:10}}/>

        {/* Formula derivation */}
        {isDC ? (
          <div style={{fontSize:11,lineHeight:1.9,color:"#444",background:"#FAFAF8",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <div>DC Min = P{cfg.dcServicePct ?? 98} of {cfg.leadDays ?? 3}-day TO-drain = <b style={{color:"#B91C1C"}}>{row.min}</b> <span style={{color:"#888",fontSize:10}}>(lean reorder point — protects DS replenishment, never trimmed)</span></div>
            <div>DC Max = Min + max( one bulk order P{cfg.dcBulkServicePct ?? 90} = <b style={{color:bulkDrives?"#D97706":"#888"}}>{bulkUnit}</b>, lead-time drain = <b style={{color:bulkDrives?"#888":HR.green}}>{leadBatch}</b> ) = <b style={{color:HR.green}}>{row.max}</b> <span style={{color:"#888",fontSize:10}}>({bulkDrives?"one bulk order":"lead-time batch"} wins)</span></div>
            {/* breakdown bar: Min = reorder point · buffer = max(one bulk order, lead batch) */}
            {(sLevel + buffer) > 0 && (
              <>
                <div style={{display:"flex",height:18,borderRadius:4,overflow:"hidden",marginTop:6,fontSize:9,fontWeight:700,color:"#fff"}}>
                  {sLevel > 0 && <div style={{flex:sLevel,background:"#B91C1C",display:"flex",alignItems:"center",justifyContent:"center",minWidth:0}} title={`Reorder point = Min ${sLevel}`}>{sLevel}</div>}
                  {buffer > 0 && <div style={{flex:buffer,background:bulkDrives?"#D97706":HR.green,display:"flex",alignItems:"center",justifyContent:"center",minWidth:0}} title={`Buffer ${buffer} (${bulkDrives?"one bulk order":"lead-time batch"})`}>{buffer}</div>}
                </div>
                <div style={{fontSize:9,color:"#888",marginTop:2}}>
                  <span style={{color:"#B91C1C",fontWeight:700}}>■ Min</span> ({row.min}, reorder floor) · <span style={{color:bulkDrives?"#D97706":HR.green,fontWeight:700}}>■ buffer</span> up to Max ({row.max}) = {bulkDrives?"one bulk order":"lead-time batch"} — trimmed first; bulk served from this stock
                </div>
              </>
            )}
            {trimmedDepth > 0 && (
              <div style={{marginTop:4,fontSize:10,color:"#B45309",fontWeight:600}}>
                Capacity trim at DC: buffer −{trimmedDepth} (reorder floor never trimmed — it backs DS replenishment)
              </div>
            )}
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
              Min = {netPct > 0 ? <>max( P{localPct} of {row.nzd} local selling days = <b>{p90Local}</b>,
              &nbsp;P{netPct} of {netOrders.length} network orders = <b>{p90Net}</b> )</> : <>P{localPct} of {row.nzd} local selling days = <b>{p90Local}</b> <span style={{color:"#888",fontSize:10}}>(network floor off)</span></>}
              {docVal != null && (
                <span> → DOC cap: {qtySum} qty ÷ {span}d × {docCap}d = <b>{docVal}</b> (floor: local ABQ {localOrdAbq})</span>
              )}
              &nbsp;= <b style={{color:"#B91C1C"}}>{row.min}</b>
            </div>
            <div>
              {(eff.maxMode ?? "worstDay") === "minPlus1"
                ? <>Max = Min + 1 = <b style={{color:HR.green}}>{row.max}</b> <span style={{color:"#888",fontSize:10}}>(lean Max mode — worst local day was {dayVals.length ? dayVals[dayVals.length-1] : 0})</span></>
                : <>Max = max( worst local day = <b>{dayVals.length ? dayVals[dayVals.length-1] : 0}</b>, Min+1 ) = <b style={{color:HR.green}}>{row.max + (row.maxTrimmed || 0)}</b></>}
              {row.maxTrimmed > 0 && <span style={{marginLeft:6,fontSize:10,color:"#B45309",fontWeight:600}}>→ Max trimmed −{row.maxTrimmed} to <b>{row.max}</b> (NZD-ordered capacity fit at {loc})</span>}
            </div>
          </div>
        )}

        {/* Misses in the test window */}
        {!isDC && misses.length > 0 && (
          <div style={{fontSize:11,background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
            <b style={{color:HR.red}}>
              {live
                ? `${misses.length} order${misses.length>1?"s":""} in the last 15d that even the LIVE plan would miss:`
                : `${misses.length} OOS event${misses.length>1?"s":""} in the ${ev.testWindow.from} → ${ev.testWindow.to} test window:`}
            </b>
            {misses.map((e, i) => (
              <div key={i} style={{marginTop:3}}>
                {e.date} · order {e.orderId} · short <b>{e.short}</b> sheets
                {!live && !published && (e.selfCorrects
                  ? <span style={{marginLeft:8,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:"#DCFCE7",color:"#166534"}}>self-corrects on publish (refit Max {e.fullRefitMax})</span>
                  : <span style={{marginLeft:8,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:"#FEF3C7",color:"#92400E"}}>still uncovered after refit (Max {e.fullRefitMax})</span>)}
              </div>
            ))}
            {!live && fullP && <div style={{marginTop:4,color:"#888",fontSize:10}}>After publish (full-window refit): Min {fullP.min} / Max {fullP.max}</div>}
            {live && <div style={{marginTop:4,color:"#888",fontSize:10}}>These are residual gaps — orders larger than the full-window plan covers (in-sample check). Covering them means raising Max permanently.</div>}
          </div>
        )}

        {/* DC charts: TO-drain timeline (drives s & S) + daily bulk order qty vs Min/Max */}
        {isDC && (
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 380px",minWidth:320}}>
              <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:4}}>
                Daily TO-drain (DS replenishment demand) vs DC Min/Max — Min = P{cfg.dcServicePct ?? 98} of {cfg.leadDays ?? 3}-day drain; Max = Min + one bulk order (or lead-time batch)
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={dcTimeline} margin={{top:4,right:8,bottom:0,left:-22}}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
                  <XAxis dataKey="date" tick={{fontSize:8}} interval={Math.ceil(dcTimeline.length/10)}/>
                  <YAxis tick={{fontSize:9}} domain={[0, dcDrainMax]}/>
                  <RTooltip contentStyle={{fontSize:10}}/>
                  <Bar dataKey="qty" barSize={dcBarSize} fill={HR.blue}/>
                  <ReferenceLine y={row.min} stroke="#B91C1C" strokeDasharray="4 3" label={{value:`Min ${row.min}`,fontSize:9,fill:"#B91C1C",position:"insideTopRight"}}/>
                  <ReferenceLine y={row.max} stroke={HR.green} strokeDasharray="4 3" label={{value:`Max ${row.max}`,fontSize:9,fill:HR.green,position:"insideTopRight"}}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{flex:"1 1 380px",minWidth:320}}>
              <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:4}}>
                Daily bulk order qty vs DC Min/Max — the buffer (Max − Min) is sized to cover one typical bulk order
              </div>
              {hasBulk ? (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={dcBulkTimeline} margin={{top:4,right:8,bottom:0,left:-22}}>
                    <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
                    <XAxis dataKey="date" tick={{fontSize:8}} interval={Math.ceil(dcBulkTimeline.length/10)}/>
                    <YAxis tick={{fontSize:9}} domain={[0, dcBulkMax]}/>
                    <RTooltip contentStyle={{fontSize:10}}/>
                    <Bar dataKey="qty" barSize={dcBarSize} fill="#D97706"/>
                    <ReferenceLine y={row.min} stroke="#B91C1C" strokeDasharray="4 3" label={{value:`Min ${row.min}`,fontSize:9,fill:"#B91C1C",position:"insideTopRight"}}/>
                    <ReferenceLine y={row.max} stroke={HR.green} strokeDasharray="4 3" label={{value:`Max ${row.max}`,fontSize:9,fill:HR.green,position:"insideTopRight"}}/>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{fontSize:11,color:"#888",padding:"40px 0",textAlign:"center"}}>No bulk orders for this SKU in the window.</div>
              )}
              <div style={{fontSize:9,color:"#999",marginTop:3}}>
                Daily total — a day may combine orders, but the buffer sizes one order. Of bulk that fits, only the α≈{(cfg.bulkDcServedShare ?? 0.7).toFixed(2)} share routes to DC; the rest is supplier-direct by geography.
              </div>
            </div>
          </div>
        )}

        {/* Charts */}
        {!isDC && (
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 380px",minWidth:320}}>
              <div style={{fontSize:10,fontWeight:700,color:"#555",marginBottom:4}}>
                Daily regular demand at {loc} vs Min/Max — <span style={{color:HR.blue}}>fit window</span> · <span style={{color:HR.purple}}>test window (where OOS is scored)</span>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={timeline} margin={{top:4,right:8,bottom:0,left:-22}}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
                  <XAxis dataKey="date" tick={{fontSize:8}} interval={Math.ceil(timeline.length/10)}/>
                  <YAxis tick={{fontSize:9}} domain={[0, yMax]}/>
                  <RTooltip contentStyle={{fontSize:10}}/>
                  {testStartLabel && (
                    <ReferenceArea x1={testStartLabel} x2={testEndLabel} fill={HR.purple} fillOpacity={0.07}
                      label={{value:"test 15d",fontSize:8,fill:HR.purple,position:"insideTopLeft"}}/>
                  )}
                  <Bar dataKey="qty" barSize={barSize}>
                    {timeline.map((t, i) => <Cell key={i} fill={t.test ? HR.purple : HR.blue}/>)}
                  </Bar>
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
const knobLabel = (k) => `P${k.minLocalDayPercentile}/P${k.minNetOrderPercentile||"off"}/cap${k.minDocCapDays||"off"} · dead:${k.deadFloorMode==="lean1"?"1/2":"ABQ"} · max:${k.maxMode==="minPlus1"?"Min+1":"worst day"}`;
const KNOB_FIELDS = ["minLocalDayPercentile","minNetOrderPercentile","minDocCapDays","deadFloorMode","maxMode"];
const DC_KNOB_FIELDS = ["dcServicePct","dcBulkServicePct","bulkDcServedShare"];

// DC tune panel: dual-line frontier (bulk service + induced regular service) over the
// 27-config DC sweep. Drain derives from the current DS plans — publish DSes first.
function DCTunePanel({ cfgDraft, setCfgDraft, invoiceData, skuMaster, isAdmin, dcPub, onPublishDC, onRevertDC, hasSaved, allDSPublished, valuePerSheet, dcTune, setDcTune, locked, onUnpublish, onRelock }) {
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(true);

  if (locked) {
    return (
      <div style={{background:HR.surface,borderRadius:8,padding:"10px 14px",border:`1px solid #BFDBFE`,marginBottom:10,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <span style={{fontSize:12,fontWeight:700}}>DC</span>
        <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#DCFCE7",color:HR.green,fontWeight:700}}>✓ locked</span>
        <span style={{fontSize:10,color:HR.muted}}>bulk served & plan size are on the card and stat strip above</span>
        <div style={{flex:1}}/>
        {isAdmin && (
          <button style={{...btn(false),borderColor:HR.blue,color:HR.blue}} onClick={()=>onUnpublish("DC")}
            title="Unlock the DC for re-tuning — the published plan stays live in the engine until you publish again">
            Unpublish & tune
          </button>
        )}
      </div>
    );
  }

  const runSweep = () => {
    setRunning(true);
    setTimeout(() => {
      try {
        const ctx = dcEvaluate(invoiceData, skuMaster, { ...cfgDraft });
        if (ctx) setDcTune(dcSweep(ctx, { ...cfgDraft }));
      } catch (e) { console.error("dc sweep error:", e); }
      setRunning(false);
    }, 30);
  };

  const applyDC = (knobs) => setCfgDraft(d => ({ ...d, ...knobs }));
  const pointActive = (knobs) => ["dcBulkServicePct"].every(f => knobs[f] === cfgDraft[f]);

  const chartData = (dcTune?.points || []).map(p => ({
    footprint: p.footprint,
    bulk: +(p.bulk * 100).toFixed(2),
    regular: +(p.regular * 100).toFixed(2),
    toFill: +((p.toFill ?? 1) * 100).toFixed(2),
    toFillQty: +((p.toFillQty ?? 1) * 100).toFixed(2),
    poPerDay: +(p.poLinesPerDay ?? 0).toFixed(1),
    knobs: p.knobs, fits: p.fits, stillOver: p.stillOver,
    fpThick: p.fpThick, fpThin: p.fpThin,
    postTotal: p.postTotal, trimmed: p.trimmed,
  }));
  const activeIdx = chartData.findIndex(d => pointActive(d.knobs));
  // DS regular service is ~flat across DC depth — show it as one labeled reference line, not a series
  const dsRef = chartData.length ? Math.round(chartData.reduce((a, d) => a + d.regular, 0) / chartData.length) : null;

  return (
    <div style={{background:HR.surface,borderRadius:8,padding:"10px 14px",border:`1px solid ${HR.border}`,marginBottom:10}}>
      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <span style={{fontSize:12,fontWeight:700,cursor:"pointer"}} onClick={()=>setOpen(o=>!o)}>{open?"▾":"▸"} Tune DC — replenishment + bulk frontier</span>
        {dcPub ? (
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#DCFCE7",color:HR.green,fontWeight:700}}>✓ DC published</span>
        ) : (
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#FEF3C7",color:"#92400E",fontWeight:700}}>● DC testing</span>
        )}
        <button style={btn(true)} onClick={runSweep} disabled={running}>{running ? "Sweeping…" : dcTune ? "Re-run DC sweep" : "Run DC sweep"}</button>
        {isAdmin && !dcPub && <button style={{...btn(false),borderColor:HR.green,color:HR.green}} onClick={onPublishDC}>Publish DC only</button>}
        {isAdmin && !dcPub && hasSaved && <button style={btn(false)} onClick={onRevertDC}>Revert DC</button>}
        {isAdmin && dcPub && <button style={btn(false)} onClick={()=>onRelock("DC")} title="No changes made — lock back onto the published plan">Keep published plan</button>}
        {activeIdx >= 0 && (
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#EFF6FF",color:HR.blue,fontWeight:700}}>Selected: {chartData[activeIdx].footprint.toLocaleString()} sheets · {fmtLakh(chartData[activeIdx].footprint*valuePerSheet)} max inventory</span>
        )}
        <span style={{fontSize:11,display:"flex",alignItems:"center",gap:4,marginLeft:"auto"}}>
          α (bulk share routed to DC)
          <input type="number" step="0.05" min="0" max="1" style={{...sel,width:60,cursor:"text"}}
            value={cfgDraft.bulkDcServedShare ?? 1} onChange={e=>setCfgDraft(d=>({...d,bulkDcServedShare:Number(e.target.value)}))}/>
        </span>
        <span style={{fontSize:11,display:"flex",alignItems:"center",gap:4}}>
          DC capacity — thick
          <input type="number" style={{...sel,width:64,cursor:"text"}}
            value={cfgDraft.dcCapacity?.thick ?? 0}
            onChange={e=>setCfgDraft(d=>({...d,dcCapacity:{...d.dcCapacity,thick:Number(e.target.value)}}))}/>
          thin
          <input type="number" style={{...sel,width:64,cursor:"text"}}
            value={cfgDraft.dcCapacity?.thin ?? 0}
            onChange={e=>setCfgDraft(d=>({...d,dcCapacity:{...d.dcCapacity,thin:Number(e.target.value)}}))}/>
        </span>
      </div>
      {!allDSPublished && (
        <div style={{fontSize:10,color:"#92400E",background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:6,padding:"4px 10px",marginTop:6}}>
          DC sizing derives its TO drain from the DS plans — some DSes are still in testing; publish them first for stable DC numbers.
        </div>
      )}
      {open && dcTune && (
        <>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={chartData} margin={{top:8,right:16,bottom:2,left:14}}
              onClick={(st)=>{ const p = st?.activePayload?.[0]?.payload; if (p) applyDC(p.knobs); }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
              <XAxis dataKey="footprint" height={38} tick={sheetTick(valuePerSheet)}/>
              <YAxis tick={{fontSize:10,fill:"#555"}} domain={[0,100]} tickFormatter={v=>v.toFixed(0)}
                label={{value:"Bulk served from DC %",fontSize:11,fontWeight:600,fill:"#444",angle:-90,position:"insideLeft",offset:6,style:{textAnchor:"middle"}}}/>
              <RTooltip cursor={{stroke:"#CBD5E1",strokeWidth:1}} content={({active,payload})=>{
                if (!active || !payload?.length) return null;
                const p = payload[0].payload;
                return (
                  <div style={{background:"#1A1A1A",borderRadius:7,padding:"9px 13px",boxShadow:"0 4px 14px rgba(0,0,0,0.3)"}}>
                    <div style={{fontSize:17,fontWeight:800,color:pillColor(p.bulk/100),lineHeight:1.1}}>{p.bulk}% <span style={{fontSize:10,fontWeight:600,color:"#cbd5e1"}}>bulk served</span></div>
                    <div style={{fontSize:10.5,color:"#e2e8f0",marginTop:4}}>{p.footprint.toLocaleString()} sheets&nbsp; |&nbsp; {fmtLakh(p.footprint*valuePerSheet)} max inv{p.fits?"":" · over rack"}</div>
                    <div style={{fontSize:9,color:"#94a3b8",marginTop:4}}>DS service ~{p.regular}% (flat) · click to apply</div>
                  </div>
                );
              }}/>
              {dcTune.capacityTotal > 0 && (
                <ReferenceLine x={dcTune.capacityTotal} stroke={HR.red} strokeDasharray="4 3" label={{value:`current rack ${dcTune.capacityTotal}`,fontSize:9,fill:HR.red,position:"insideTopLeft"}}/>
              )}
              {dsRef != null && (
                <ReferenceLine y={dsRef} stroke="#94A3B8" strokeDasharray="5 4" label={{value:`DS service ~${dsRef}% (flat — not the DC's lever)`,fontSize:9,fill:"#64748B",position:"insideTopRight"}}/>
              )}
              <Line type="monotone" dataKey="bulk" name="Bulk served from DC" stroke={HR.blue} strokeWidth={2}
                dot={(props)=>{ const { cx, cy, payload, index } = props; return (
                  <circle key={"r"+index} cx={cx} cy={cy} r={index===activeIdx?7:5}
                    fill={index===activeIdx?HR.yellow:payload.fits?HR.green:HR.white}
                    stroke={payload.fits?HR.green:HR.blue} strokeWidth={2} style={{cursor:"pointer"}}
                    onClick={(e2)=>{e2.stopPropagation(); applyDC(payload.knobs);}}/>
                );}}
                activeDot={(props)=>{ const { cx, cy, payload } = props; return (
                  <circle cx={cx} cy={cy} r={8} fill={HR.yellow} stroke={HR.blue} strokeWidth={2} style={{cursor:"pointer"}}
                    onClick={(e2)=>{e2.stopPropagation(); applyDC(payload.knobs);}}/>
                );}}/>
            </LineChart>
          </ResponsiveContainer>
          <div style={{textAlign:"center",fontSize:11,fontWeight:600,color:"#444",marginTop:4}}>DC inventory — sheets (ΣMax, pre-trim) <span style={{color:"#94A3B8",fontWeight:400}}>/ ₹ value</span></div>
          <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"4px 16px",fontSize:9.5,color:HR.muted,marginTop:12,paddingTop:8,borderTop:`1px solid ${HR.surfaceLight}`}}>
            <span><span style={{color:HR.green,fontWeight:700}}>●</span> fits current rack</span>
            <span><span style={{color:HR.blue,fontWeight:700}}>○</span> over capacity</span>
            <span><span style={{color:HR.yellow,fontWeight:700}}>●</span> applied</span>
            <span><span style={{color:"#64748B",fontWeight:700}}>┄</span> DS service (flat — not the DC's lever)</span>
            <span style={{color:"#aaa"}}>Each point is a bulk-service level; richer = more bulk, more rack. Click to apply.</span>
          </div>
        </>
      )}
      {open && !dcTune && !running && <div style={{fontSize:11,color:HR.muted,padding:"10px 0 2px"}}>Run the DC sweep (5 bulk-service scenarios) to see the bulk-served vs DC-rack curve.</div>}
    </div>
  );
}

// Per-DS tune panel: lives at the top of the SKU view for the selected location.
// Clicking a point sets a per-DS knob OVERRIDE (dsKnobs[loc]); global knobs apply elsewhere.
function DSTunePanel({ loc, cfgDraft, setCfgDraft, invoiceData, skuMaster, isAdmin, onSaveConfig, tuneResult, setTuneResult, dsPub, onPublishDS, onRevertDS, hasSaved, valuePerSheet, locked, onUnpublish, onRelock }) {
  const [tuning, setTuning] = useState(false);
  const [open, setOpen] = useState(true);
  const [knobsOpen, setKnobsOpen] = useState(false);

  // Published & locked: frozen summary — the graph only returns via Unpublish & tune.
  if (locked) {
    return (
      <div style={{background:HR.surface,borderRadius:8,padding:"10px 14px",border:`1px solid #BFDBFE`,marginBottom:10,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <span style={{fontSize:12,fontWeight:700}}>{loc}</span>
        <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#DCFCE7",color:HR.green,fontWeight:700}}>✓ locked</span>
        <span style={{fontSize:10,color:HR.muted}}>service & plan size are on the card and stat strip above</span>
        <div style={{flex:1}}/>
        {isAdmin && (
          <button style={{...btn(false),borderColor:HR.blue,color:HR.blue}} onClick={()=>onUnpublish(loc)}
            title="Unlock this DS for re-tuning — the published plan stays live in the engine until you publish again">
            Unpublish & tune
          </button>
        )}
      </div>
    );
  }

  const runTune = () => {
    setTuning(true);
    setTimeout(() => {
      try { setTuneResult(autoTune(invoiceData, skuMaster, { ...cfgDraft })); }
      catch (e) { console.error("auto-tune error:", e); }
      setTuning(false);
    }, 30);
  };

  // effective knobs at this DS = global merged with the picked-point override (model-set, not shown)
  const effective = Object.fromEntries(KNOB_FIELDS.map(f => [f, cfgDraft.dsKnobs?.[loc]?.[f] ?? cfgDraft[f]]));
  const applyToDS = (knobs) => setCfgDraft(d => ({ ...d, dsKnobs: { ...(d.dsKnobs || {}), [loc]: Object.fromEntries(KNOB_FIELDS.map(f => [f, knobs[f]])) } }));
  const pointActive = (knobs) => KNOB_FIELDS.every(f => (knobs[f] ?? null) === (effective[f] ?? null));

  const frontier = tuneResult?.dsFrontiers?.[loc] || [];
  const capTotal = tuneResult?.dsCapacityTotals?.[loc] || 0;
  const chartData = frontier.map(r => ({
    footprint: r.perDS[loc].footprint,
    service: +(r.perDS[loc].service * 100).toFixed(2),
    serviceNet: +(r.service * 100).toFixed(2),
    knobs: r.knobs,
    fits: r.perDS[loc].fits,
    overNodes: r.perDS[loc].overNodes,
  }));
  const activeIdx = chartData.findIndex(d => pointActive(d.knobs));

  return (
    <div style={{background:HR.surface,borderRadius:8,padding:"10px 14px",border:`1px solid ${HR.border}`,marginBottom:10}}>
      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <span style={{fontSize:12,fontWeight:700,cursor:"pointer"}} onClick={()=>setOpen(o=>!o)}>{open?"▾":"▸"} Tune {loc} — service vs inventory frontier</span>
        {dsPub ? (
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#DCFCE7",color:HR.green,fontWeight:700}}>✓ {loc} published</span>
        ) : (
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#FEF3C7",color:"#92400E",fontWeight:700}}>● {loc} testing</span>
        )}
        <button style={btn(true)} onClick={runTune} disabled={tuning}>{tuning ? "Sweeping…" : tuneResult ? "Re-run Auto-tune" : "Run Auto-tune"}</button>
        {isAdmin && !dsPub && (
          <button style={{...btn(false),borderColor:HR.green,color:HR.green}} onClick={()=>onPublishDS(loc)}>Publish {loc} only</button>
        )}
        {isAdmin && !dsPub && hasSaved && (
          <button style={btn(false)} onClick={()=>onRevertDS(loc)} title={`Discard ${loc}'s draft changes — back to its published knobs`}>Revert {loc}</button>
        )}
        {isAdmin && dsPub && (
          <button style={btn(false)} onClick={()=>onRelock(loc)} title="No changes made — lock back onto the published plan">Keep published plan</button>
        )}
        {activeIdx >= 0 && (
          <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#EFF6FF",color:HR.blue,fontWeight:700}}>
            Selected: {chartData[activeIdx].footprint.toLocaleString()} sheets · {fmtLakh(chartData[activeIdx].footprint*valuePerSheet)} max inventory
          </span>
        )}
        <span style={{fontSize:11,display:"flex",alignItems:"center",gap:4,marginLeft:"auto"}}>
          {loc} capacity — thick
          <input type="number" style={{...sel,width:64,cursor:"text"}}
            value={cfgDraft.dsCapacities?.[loc]?.thick ?? 0}
            onChange={e=>setCfgDraft(d=>({...d,dsCapacities:{...d.dsCapacities,[loc]:{...d.dsCapacities?.[loc],thick:Number(e.target.value)}}}))}/>
          thin
          <input type="number" style={{...sel,width:64,cursor:"text"}}
            value={cfgDraft.dsCapacities?.[loc]?.thin ?? 0}
            onChange={e=>setCfgDraft(d=>({...d,dsCapacities:{...d.dsCapacities,[loc]:{...d.dsCapacities?.[loc],thin:Number(e.target.value)}}}))}/>
        </span>
      </div>
      {open && tuneResult && (
        <>
          <ResponsiveContainer width="100%" height={210}>
            <LineChart data={chartData} margin={{top:8,right:16,bottom:2,left:14}}
              onClick={(st)=>{ const p = st?.activePayload?.[0]?.payload; if (p) applyToDS(p.knobs); }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#eee"/>
              <XAxis dataKey="footprint" height={38} tick={sheetTick(valuePerSheet)}/>
              <YAxis dataKey="service" tick={{fontSize:10,fill:"#555"}} domain={["dataMin - 0.4","dataMax + 0.4"]} tickFormatter={v=>v.toFixed(0)}
                label={{value:"Service level (15d) %",fontSize:11,fontWeight:600,fill:"#444",angle:-90,position:"insideLeft",offset:6,style:{textAnchor:"middle"}}}/>
              <RTooltip cursor={{stroke:"#CBD5E1",strokeWidth:1}} content={({active,payload})=>{
                if (!active || !payload?.length) return null;
                const p = payload[0].payload;
                return (
                  <div style={{background:"#1A1A1A",borderRadius:7,padding:"9px 13px",boxShadow:"0 4px 14px rgba(0,0,0,0.3)"}}>
                    <div style={{fontSize:17,fontWeight:800,color:pillColor(p.service/100),lineHeight:1.1}}>{p.service}% <span style={{fontSize:10,fontWeight:600,color:"#cbd5e1"}}>service level</span></div>
                    <div style={{fontSize:10.5,color:"#e2e8f0",marginTop:4}}>{p.footprint.toLocaleString()} sheets&nbsp; |&nbsp; {fmtLakh(p.footprint*valuePerSheet)} max inv{p.fits?"":` · over ${p.overNodes.join("+")} rack`}</div>
                    <div style={{fontSize:9,color:"#94a3b8",marginTop:4}}>click to apply this scenario</div>
                  </div>
                );
              }}/>
              {capTotal > 0 && (
                <ReferenceLine x={capTotal} stroke={HR.red} strokeDasharray="4 3" label={{value:`${loc} rack ${capTotal}`,fontSize:9,fill:HR.red,position:"insideTopLeft"}}/>
              )}
              <Line type="monotone" dataKey="service" stroke={HR.purple} strokeWidth={2}
                dot={(props)=>{ const { cx, cy, payload, index } = props; return (
                  <circle key={index} cx={cx} cy={cy} r={index===activeIdx?7:5}
                    fill={index===activeIdx?HR.yellow:payload.fits?HR.green:HR.white}
                    stroke={payload.fits?HR.green:HR.purple} strokeWidth={2} style={{cursor:"pointer"}}
                    onClick={(e2)=>{e2.stopPropagation(); applyToDS(payload.knobs);}}/>
                );}}
                activeDot={(props)=>{ const { cx, cy, payload } = props; return (
                  <circle cx={cx} cy={cy} r={8} fill={HR.yellow} stroke={HR.purple} strokeWidth={2} style={{cursor:"pointer"}}
                    onClick={(e2)=>{e2.stopPropagation(); applyToDS(payload.knobs);}}/>
                );}}/>
            </LineChart>
          </ResponsiveContainer>
          <div style={{textAlign:"center",fontSize:11,fontWeight:600,color:"#444",marginTop:4}}>Inventory held at {loc} — sheets (ΣMax) <span style={{color:"#94A3B8",fontWeight:400}}>/ ₹ value</span></div>
          <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"4px 16px",fontSize:9.5,color:HR.muted,marginTop:12,paddingTop:8,borderTop:`1px solid ${HR.surfaceLight}`}}>
            <span><span style={{color:HR.green,fontWeight:700}}>●</span> fits {loc} rack</span>
            <span><span style={{color:HR.purple,fontWeight:700}}>○</span> over capacity</span>
            <span><span style={{color:HR.yellow,fontWeight:700}}>●</span> applied</span>
            <span style={{color:"#aaa"}}>Click any point to apply that scenario to {loc} (other DSes unchanged; Max is trimmed to fit the rack).</span>
          </div>
        </>
      )}
      {open && !tuneResult && !tuning && <div style={{fontSize:11,color:HR.muted,padding:"10px 0 2px"}}>Run Auto-tune to see {loc}'s own service-vs-inventory frontier.</div>}

      {/* Global knobs + publish (collapsible) */}
      <div style={{borderTop:`1px solid ${HR.surfaceLight}`,marginTop:8,paddingTop:8}}>
        <span style={{fontSize:11,fontWeight:700,cursor:"pointer",color:"#555"}} onClick={()=>setKnobsOpen(o=>!o)}>{knobsOpen?"▾":"▸"} Global knobs & publish</span>
        {knobsOpen && (
          <div style={{marginTop:8}}>
            <div style={{display:"flex",gap:"6px 24px",flexWrap:"wrap"}}>
              {[
                ["minLocalDayPercentile","Local day percentile"],
                ["minNetOrderPercentile","Network order pct (0 = off)"],
                ["minDocCapDays","DOC cap days (0 = off)"],
                ["lookbackDays","Lookback days"],
                ["bulkOrderThreshold","Bulk threshold (sheets)"],
                ["leadDays","Supplier lead days"],
                ["thickBoundaryMm","Thick boundary (mm)"],
                ["dcServicePct","DC reorder service pct (Min)"],
                ["dcBulkServicePct","DC bulk service pct (one order)"],
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
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,minWidth:240}}>
                <span style={{fontSize:11}}>Capacity fit (Max trim)</span>
                <select style={{...sel,width:110}} value={cfgDraft.capacityFit ?? "maxTrim"}
                  onChange={e=>setCfgDraft(d=>({...d,capacityFit:e.target.value}))}>
                  <option value="maxTrim">NZD-ordered trim</option>
                  <option value="off">Off</option>
                </select>
              </div>
            </div>
            {Object.keys(cfgDraft.dsKnobs || {}).length > 0 && (
              <div style={{fontSize:10,color:"#6D28D9",marginTop:6}}>
                Per-DS overrides active: {Object.entries(cfgDraft.dsKnobs).map(([d2,k]) => `${d2} (${knobLabel({...cfgDraft,...k})})`).join(" · ")}
                <span onClick={()=>setCfgDraft(d=>({...d,dsKnobs:{}}))} style={{marginLeft:8,cursor:"pointer",fontWeight:700,border:"1px solid #C4B5FD",borderRadius:4,padding:"1px 6px"}}>clear all</span>
              </div>
            )}
            <div style={{borderTop:`1px solid ${HR.border}`,marginTop:10,paddingTop:10,maxWidth:480}}>
              {isAdmin ? (
                <>
                  <button style={{...btn(true),width:"100%",padding:"8px 0"}} onClick={()=>onSaveConfig && onSaveConfig(cfgDraft)}>
                    Publish — save config & refit on FULL window
                  </button>
                  <div style={{fontSize:9,color:HR.muted,marginTop:5}}>
                    Publishes global knobs + all per-DS overrides. The tab previews a 75-day fit scored on the last 15 days; publishing refits on the entire window.
                  </div>
                </>
              ) : <div style={{fontSize:10,color:HR.muted}}>Read-only — admin login required to publish.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────
// ── Assortment / Keep Score view (network-level, recommend-only) ──────────────
const KS_FLAG_COLOR = { Keep: HR.green, Watch: HR.amber, Cut: HR.red };
function AssortmentView({ ks, cfgDraft, setCfgDraft, isAdmin }) {
  const [flagF, setFlagF] = useState("All");
  const [brandF, setBrandF] = useState("All");
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState("keepScore");
  const [sortDir, setSortDir] = useState(1);   // cuts (lowest score) first by default
  const [copiedSku, setCopiedSku] = useState(null);
  const copySku = (sku, e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sku).catch(() => {});
    setCopiedSku(sku);
    setTimeout(() => setCopiedSku(s => s === sku ? null : s), 1500);
  };

  if (!ks) return <div style={{textAlign:"center",padding:60,color:HR.muted,fontSize:13}}>No plywood SKUs to score.</div>;
  const { rows, summary, nodes } = ks;
  const ksCfg = cfgDraft.keepScore || {};
  const setKs = (k, v) => setCfgDraft(d => ({ ...d, keepScore: { ...(d.keepScore || {}), [k]: v } }));

  const brands = ["All", ...[...new Set(rows.map(r => r.brand).filter(Boolean))].sort()];
  const ql = q.toLowerCase();
  const filtered = rows
    .filter(r => (flagF === "All" || r.flag === flagF) && (brandF === "All" || r.brand === brandF)
      && (!ql || r.sku.toLowerCase().includes(ql) || r.name.toLowerCase().includes(ql)))
    .sort((a, b) => {
      const v = (x) => sortBy === "name" ? x.name : sortBy === "brand" ? x.brand : sortBy === "sku" ? x.sku : x[sortBy];
      const va = v(a), vb = v(b);
      if (typeof va === "string") return va.localeCompare(vb) * sortDir;
      return (va - vb) * sortDir;
    });
  const hSort = (col) => { if (sortBy === col) setSortDir(d => -d); else { setSortBy(col); setSortDir(col === "keepScore" ? 1 : -1); } };
  const th = (col, label, center) => (
    <th key={col} onClick={() => hSort(col)} style={{padding:"4px 6px",fontWeight:700,fontSize:10,color:sortBy===col?HR.purple:"#666",borderBottom:`1px solid ${HR.border}`,textAlign:center?"center":"left",whiteSpace:"nowrap",cursor:"pointer",userSelect:"none",background:"#F8F8F2",position:"sticky",top:0,zIndex:2}}>
      {label}{sortBy===col?(sortDir===-1?"↓":"↑"):<span style={{color:"#ccc",fontSize:8}}>↕</span>}</th>
  );

  const exportCsv = () => {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const hdr = ["SKU","Item Name","Brand","Class","Network NZD","Max Hold Qty","Sold Qty","Holding ₹ (avg, cost)","Sales ₹ (revenue)","Rent Ratio","Service Ratio","Keep Score","Flag"];
    const lines = rows.map(r => [r.sku, r.name, r.brand, r.tclass, r.networkNZD, r.maxHoldQty, r.windowQty, Math.round(r.holdingValue), Math.round(r.salesValue), r.rentRatio.toFixed(2), r.serviceRatio.toFixed(2), r.keepScore.toFixed(2), r.flag].map(esc).join(","));
    const blob = new Blob([[hdr.map(esc).join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "plywood-v2-keepscore.csv"; a.click();
  };
  const fmtL = v => v >= 100000 ? `₹${(v/100000).toFixed(1)}L` : `₹${Math.round(v/1000)}K`;
  const overNodes = nodes.filter(n => n.cap != null && n.before > n.cap);

  return (
    <div>
      {/* summary cards */}
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <div style={{padding:"8px 14px",background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8}}>
          <div style={{fontSize:9,color:HR.muted}}>Verdict (network-level, per SKU)</div>
          <div style={{fontSize:15,fontWeight:800}}>
            <span style={{color:HR.green}}>{summary.keep} Keep</span> · <span style={{color:HR.amber}}>{summary.watch} Watch</span> · <span style={{color:HR.red}}>{summary.cut} Cut</span>
          </div>
          <div style={{fontSize:9,color:HR.muted}}>of {summary.total} SKUs</div>
        </div>
        <div style={{padding:"8px 14px",background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8}}>
          <div style={{fontSize:9,color:HR.muted}}>Sales at risk (cutting all Cut)</div>
          <div style={{fontSize:15,fontWeight:800,color:HR.red}}>{fmtL(summary.salesAtRisk)}</div>
          <div style={{fontSize:9,color:HR.muted}}>{(summary.salesAtRisk/Math.max(summary.totalSales,1)*100).toFixed(1)}% of ₹{(summary.totalSales/10000000).toFixed(2)}Cr</div>
        </div>
        <div style={{padding:"8px 14px",background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8}}>
          <div style={{fontSize:9,color:HR.muted}}>Holding freed</div>
          <div style={{fontSize:15,fontWeight:800,color:HR.green}}>{fmtL(summary.holdingFreed)}</div>
          <div style={{fontSize:9,color:HR.muted}}>{(summary.holdingFreed/Math.max(summary.totalHolding,1)*100).toFixed(0)}% of plan capital</div>
        </div>
        <div style={{padding:"8px 14px",background:summary.flipsGreen.length?"#F0FDF4":HR.surface,border:`1px solid ${summary.flipsGreen.length?"#BBF7D0":HR.border}`,borderRadius:8,flex:1,minWidth:220}}>
          <div style={{fontSize:9,color:HR.muted}}>Capacity impact of the cut</div>
          {summary.flipsGreen.length
            ? <div style={{fontSize:12,fontWeight:700,color:HR.green}}>↳ flips green: {summary.flipsGreen.join(", ")}</div>
            : <div style={{fontSize:12,fontWeight:700,color:HR.muted}}>no over-capacity node flips on cuts alone</div>}
          {overNodes.length > 0 && (
            <div style={{fontSize:9,color:HR.muted,marginTop:2}}>
              {overNodes.map(n => `${n.node} ${n.tclass} ${n.before}→${n.after}/${n.cap}${n.flips?" ✓":n.stillOver?" (still over)":""}`).join(" · ")}
            </div>
          )}
        </div>
      </div>

      <div style={{fontSize:10,color:HR.muted,marginBottom:8,lineHeight:1.7}}>
        Recommend-only · Keep Score = max(Rent, Service) · Keep ≥1.3 · Watch 1.0–1.3 · Cut &lt;1. A SKU survives if it clears <b>either</b> ratio; Cut = fails both. Totals include bulk.<br/>
        <b>Rent Ratio</b> — does it earn enough to pay for the stock it ties up? ≈ (Sold Qty × Margin) ÷ (Avg Holding Qty × Carry Cost). Exactly: (Sales ₹ × {Math.round((ksCfg.grossMarginPct ?? 0.06)*100)}%) ÷ (Holding ₹ × {Math.round((ksCfg.carryRateQuarterly ?? 0.05)*100)}%/qtr × {ksCfg.opsBuffer ?? 1.5} buffer). ≥1 = its gross profit covers the carrying cost of the inventory it holds.<br/>
        <b>Service Ratio</b> — does it sell often enough that customers would miss it? = network selling-days ÷ {ksCfg.serviceNZDThreshold ?? 5}. ≥1 means it sold on ≥{ksCfg.serviceNZDThreshold ?? 5} days in the 90-day window (≈ once a fortnight or more) — a staple worth keeping on demand grounds alone, regardless of economics.<br/>
        Cutting happens via discontinuation → SKU master; the plan then re-runs on survivors.
      </div>

      {/* filters + knobs + export */}
      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8,flexWrap:"wrap"}}>
        <input type="text" placeholder="Search SKU or name…" value={q} onChange={e=>setQ(e.target.value)} style={{...sel,width:200,cursor:"text"}}/>
        {["All","Keep","Watch","Cut"].map(f => (
          <button key={f} style={btn(flagF===f)} onClick={()=>setFlagF(f)}>{f}{f!=="All"?` ${summary[f.toLowerCase()]}`:""}</button>
        ))}
        <select value={brandF} onChange={e=>setBrandF(e.target.value)} style={sel}>
          {brands.map(b => <option key={b} value={b}>{b==="All"?"All Brands":b}</option>)}
        </select>
        <div style={{flex:1}}/>
        <button style={btn(false)} onClick={exportCsv}>⬇ Export CSV</button>
      </div>

      {/* knobs (admin) */}
      {isAdmin && (
        <div style={{display:"flex",gap:"6px 20px",flexWrap:"wrap",marginBottom:8,padding:"8px 12px",background:"#FAFAF8",border:`1px solid ${HR.border}`,borderRadius:8}}>
          {[["grossMarginPct","Gross margin",0.06,"×100%"],["carryRateQuarterly","Carry /qtr",0.05,"×100%"],["opsBuffer","Ops buffer",1.5,""],["serviceNZDThreshold","Service NZD threshold",5,""]].map(([k,label,def]) => (
            <div key={k} style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:11}}>{label}</span>
              <input type="number" step="any" style={{...sel,width:64,cursor:"text"}} value={ksCfg[k] ?? def} onChange={e=>setKs(k, Number(e.target.value))}/>
            </div>
          ))}
          <span style={{fontSize:9,color:HR.muted,alignSelf:"center"}}>edits recompute the verdict live; saved on next Publish</span>
        </div>
      )}

      {/* table */}
      <div style={{overflow:"auto",maxHeight:"calc(100vh / 0.85 - 290px)",background:HR.surface,borderRadius:8,border:`1px solid ${HR.border}`}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
          <thead><tr>
            {th("sku","SKU")}{th("name","Item Name")}{th("brand","Brand")}{th("tclass","Class")}
            {th("networkNZD","Net NZD",true)}{th("maxHoldQty","Max Hol Qty",true)}{th("windowQty","Sold Qty",true)}
            {th("holdingValue","Holding ₹",true)}{th("salesValue","Sales ₹",true)}
            {th("rentRatio","Rent Ratio",true)}{th("serviceRatio","Service Ratio",true)}{th("keepScore","Keep Score",true)}{th("flag","Flag",true)}
          </tr></thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.sku} style={{background:r.flag==="Cut"?"#FEF2F2":r.flag==="Watch"?"#FFFBEB":"#fff"}}>
                <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",whiteSpace:"nowrap"}}>
                  <span style={{display:"flex",alignItems:"center",gap:4}}>
                    <span style={{fontFamily:"monospace",fontSize:10,color:"#555"}}>{r.sku}</span>
                    <span onClick={e=>copySku(r.sku,e)} title="Copy SKU"
                      style={{cursor:"pointer",flexShrink:0,color:copiedSku===r.sku?"#059669":"#BBAC97",lineHeight:1,display:"flex",alignItems:"center"}}>
                      {copiedSku===r.sku
                        ? <span style={{fontSize:9,fontWeight:700,color:"#059669"}}>✓</span>
                        : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                    </span>
                  </span>
                </td>
                <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={r.name}>{r.name}</td>
                <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555",whiteSpace:"nowrap"}}>{r.brand}</td>
                <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                  <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:r.tclass==="thick"?"#FEF3C7":"#DBEAFE",color:r.tclass==="thick"?"#92400E":HR.blue}}>{r.tclass==="thick"?"Thick":"Thin"}</span>
                </td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.networkNZD}</td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.maxHoldQty}</td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.windowQty}</td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.holdingValue?fmtL(r.holdingValue):"—"}</td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.salesValue?fmtL(r.salesValue):"—"}</td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)",color:r.rentRatio>=1?HR.green:"#555"}}>{r.rentRatio.toFixed(2)}</td>
                <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)",color:r.serviceRatio>=1?HR.green:"#555"}}>{r.serviceRatio.toFixed(2)}</td>
                <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,borderBottom:"1px solid rgba(0,0,0,0.05)"}}>{r.keepScore.toFixed(2)}</td>
                <td style={{padding:"3px 6px",textAlign:"center",fontWeight:700,borderBottom:"1px solid rgba(0,0,0,0.05)",color:KS_FLAG_COLOR[r.flag]}}>{r.flag}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PlywoodNetworkV2Tab({ invoiceData, skuMaster, priceData, isAdmin, plywoodNetworkV2Config, onSaveConfig, isActive, engineResults }) {
  const [loc, setLoc] = useState("DS01");
  const [cfgDraft, setCfgDraft] = useState(() => {
    const base = { ...V2_DEFAULTS, ...(plywoodNetworkV2Config || {}) };
    // hydrate Keep Score knobs from localStorage so edits survive reloads (recommend-only,
    // not part of the publish lifecycle — safe to persist in isolation)
    try {
      const saved = JSON.parse(localStorage.getItem("plywoodV2KeepScore") || "null");
      if (saved && typeof saved === "object") base.keepScore = { ...(base.keepScore || {}), ...saved };
    } catch { /* ignore */ }
    return base;
  });
  // persist Keep Score knob edits to localStorage
  useEffect(() => {
    try { localStorage.setItem("plywoodV2KeepScore", JSON.stringify(cfgDraft.keepScore || {})); } catch { /* ignore */ }
  }, [cfgDraft.keepScore]);
  const [tuneResult, setTuneResult] = useState(null);   // lifted: survives sub-tab switches
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState("location");          // 'location' | 'assortment'
  const [copiedSku, setCopiedSku] = useState(null);
  const copySku = (sku, e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sku).catch(() => {});
    setCopiedSku(sku);
    setTimeout(() => setCopiedSku(s => s === sku ? null : s), 1500);
  };
  // per-location edit state: published locations are LOCKED until explicitly unpublished
  const [editing, setEditing] = useState({});

  // Phase: published = saved config matches the draft (and a config exists)
  const savedCfg = { ...V2_DEFAULTS, ...(plywoodNetworkV2Config || {}) };
  const published = !!plywoodNetworkV2Config && sameKnobs(cfgDraft, savedCfg);
  // per-DS publish state: effective knobs AND that DS's capacity match the saved config
  const dsCapOf = (cfg, ds) => cfg?.dsCapacities?.[ds] ?? V2_DEFAULTS.dsCapacities[ds];
  const dsPublished = (ds) => !!plywoodNetworkV2Config
    && sameEffKnobs(effKnobsFor(cfgDraft, ds), effKnobsFor(savedCfg, ds))
    && JSON.stringify(dsCapOf(cfgDraft, ds)) === JSON.stringify(dsCapOf(savedCfg, ds));
  const publishedCount = DS_LIST.filter(dsPublished).length;

  // Publish ONE DS: materialize its effective draft knobs into the SAVED config's
  // dsKnobs — other DSes' saved state untouched. Draft pins the same override so the
  // DS stays 'published' even if global draft knobs keep moving.
  const publishDS = (ds) => {
    const eff = effKnobsFor(cfgDraft, ds);
    const cap = dsCapOf(cfgDraft, ds);
    const newCfg = {
      ...savedCfg,
      dsKnobs: { ...(savedCfg.dsKnobs || {}), [ds]: eff },
      dsCapacities: { ...(savedCfg.dsCapacities || V2_DEFAULTS.dsCapacities), [ds]: cap },
    };
    setCfgDraft(d => ({ ...d, dsKnobs: { ...(d.dsKnobs || {}), [ds]: eff } }));
    if (onSaveConfig) onSaveConfig(newCfg);
    lockLoc(ds);
  };
  // Revert ONE DS: snap the draft back to whatever is published for it (knobs + capacity).
  const revertDS = (ds) => {
    const eff = effKnobsFor(savedCfg, ds);
    const cap = dsCapOf(savedCfg, ds);
    setCfgDraft(d => ({
      ...d,
      dsKnobs: { ...(d.dsKnobs || {}), [ds]: eff },
      dsCapacities: { ...(d.dsCapacities || V2_DEFAULTS.dsCapacities), [ds]: cap },
    }));
  };

  // DC publish state + handlers (DC knobs are the global dc* fields)
  const dcPub = !!plywoodNetworkV2Config
    && DC_KNOB_FIELDS.every(f => (cfgDraft[f] ?? V2_DEFAULTS[f]) === (savedCfg[f] ?? V2_DEFAULTS[f]))
    && JSON.stringify(cfgDraft.dcCapacity ?? V2_DEFAULTS.dcCapacity) === JSON.stringify(savedCfg.dcCapacity ?? V2_DEFAULTS.dcCapacity);
  const publishDC = () => {
    const newCfg = { ...savedCfg, dcCapacity: cfgDraft.dcCapacity ?? V2_DEFAULTS.dcCapacity };
    for (const f of DC_KNOB_FIELDS) newCfg[f] = cfgDraft[f] ?? V2_DEFAULTS[f];
    if (onSaveConfig) onSaveConfig(newCfg);
    lockLoc("DC");
  };
  const revertDC = () => setCfgDraft(d => {
    const next = { ...d, dcCapacity: savedCfg.dcCapacity ?? V2_DEFAULTS.dcCapacity };
    for (const f of DC_KNOB_FIELDS) next[f] = savedCfg[f] ?? V2_DEFAULTS[f];
    return next;
  });
  const [dcTune, setDcTune] = useState(null);

  // Lifecycle: published → LOCKED (live view, frozen graph) until Unpublish & tune;
  // unpublished/editing → unlocked (evaluation view). No manual toggle.
  const locPublished = loc === "DC" ? dcPub : dsPublished(loc);
  const isEditing = (l) => editing[l] ?? !(l === "DC" ? dcPub : dsPublished(l));
  const locked = locPublished && !isEditing(loc);
  const unpublishLoc = (l) => setEditing(e => ({ ...e, [l]: true }));
  const lockLoc = (l) => setEditing(e => ({ ...e, [l]: false }));
  const [query, setQuery] = useState("");
  const [fBrand, setFBrand] = useState("All");
  const [fType, setFType] = useState("All");
  const [fBucket, setFBucket] = useState("All");
  const [fOOS, setFOOS] = useState(false);
  const [sortBy, setSortBy] = useState("nzd");
  const [sortDir, setSortDir] = useState(-1);

  const ready = invoiceData?.length > 0 && Object.keys(skuMaster || {}).length > 0;

  // Keep Score / assortment analysis — full effective plan, only when that view is open
  const ks = useMemo(() => {
    if (!ready || view !== "assortment") return null;
    try { return keepScoreAnalysis(invoiceData, skuMaster, priceData || {}, cfgDraft); }
    catch (e) { console.error("keep score error:", e); return null; }
  }, [ready, view, invoiceData, skuMaster, priceData, cfgDraft]);

  // 75/15 evaluation (the tab's core computation)
  const ev = useMemo(() => {
    if (!ready) return null;
    try { return evaluatePlan(invoiceData, skuMaster, cfgDraft, { testDays: 15 }); }
    catch (e) { console.error("v2 evaluate error:", e); return null; }
  }, [ready, invoiceData, skuMaster, cfgDraft]);

  // DC plan (full pipeline incl. drain-based DC) on the fit window
  // live mode only meaningful when the full plan exists
  const live = locked && !!ev?.fullPlan;
  const modeDemand = live ? ev.fullDemand : ev?.fitDemand;
  const modePlan = live ? ev.fullPlan : ev?.plan;

  const dcRes = useMemo(() => {
    if (!ev) return null;
    try {
      const dcInv = live ? invoiceData : invoiceData.filter(r => r.date <= ev.fitWindow.to);
      return computePlywoodNetworkV2Results(dcInv, skuMaster, { plywoodNetworkV2Config: cfgDraft });
    } catch (e) { console.error("v2 dc error:", e); return null; }
  }, [ev, live, invoiceData, skuMaster, cfgDraft]);

  // Honest live check: replay the last 15d against the FULL-WINDOW plans INCLUDING the
  // real DC plan (evaluatePlan's internal live numbers assume an infinite DC — wrong
  // for TO fulfilment / bulk; this replaces them wherever live numbers are shown).
  // DS service + OOS are DS-shelf metrics, evaluated with an infinite DC (DC assumed to keep DSes
  // stocked). A DC shortfall is the DC's failure and surfaces on the DC card (TO-fill), not in the
  // DS numbers — so every DS-side figure (strip cards, network card, OOS column) uses the same basis.
  const modeOos = live ? (ev?.liveOosCounts || {}) : ev?.oosCounts;

  // DC strip stats — replay current plan + REAL effective DC over the 15d test window.
  // Headline = bulk served from DC; TO qty-fill kept as a diagnostic.
  const dcStats = useMemo(() => {
    if (!ev?.testDemand || !dcRes || !modePlan) return null;
    try {
      const dcPlan = {};
      for (const sku of Object.keys(modePlan)) dcPlan[sku] = dcRes[sku]?.dcResult ? { ...dcRes[sku].dcResult } : { min: 0, max: 0 };
      const sim = replay(modePlan, dcPlan, ev.testDemand, { ...cfgDraft, lookbackDays: ev.testDemand.windowDates.length });
      const b = sim.serviceLevels.bulk;
      return { bulkServed: b.total ? 1 - b.oos / b.total : 1, toFill: sim.serviceLevels.toFill?.qtyRate ?? null };
    } catch (e) { console.error("dc strip stats error:", e); return null; }
  }, [ev, dcRes, modePlan, cfgDraft]);

  // DC LIVE bulk (full-window plan + real DC) — for the strip card when DC is published but a DS
  // is being tuned (so DC shows its live number, not the fit-window forecast). Reuses dcRes when
  // it's already full-window (live view); only runs the extra engine pass while tuning a DS.
  const dcResFull = useMemo(() => {
    if (!ev?.fullPlan) return null;
    if (live) return dcRes;
    try { return computePlywoodNetworkV2Results(invoiceData, skuMaster, { plywoodNetworkV2Config: cfgDraft }); }
    catch (e) { console.error("dc full error:", e); return null; }
  }, [ev, live, dcRes, invoiceData, skuMaster, cfgDraft]);
  const dcLive = useMemo(() => {
    if (!ev?.fullPlan || !ev?.testDemand || !dcResFull) return null;
    try {
      const dcPlan = {};
      for (const sku of Object.keys(ev.fullPlan)) dcPlan[sku] = dcResFull[sku]?.dcResult ? { ...dcResFull[sku].dcResult } : { min: 0, max: 0 };
      const sim = replay(ev.fullPlan, dcPlan, ev.testDemand, { ...cfgDraft, lookbackDays: ev.testDemand.windowDates.length });
      const b = sim.serviceLevels.bulk;
      return { bulkServed: b.total ? 1 - b.oos / b.total : 1, toFill: sim.serviceLevels.toFill?.qtyRate ?? null };
    } catch (e) { console.error("dc live error:", e); return null; }
  }, [ev, dcResFull, cfgDraft]);

  // Per-SKU TO-drain series for the DC modal chart — the same infinite-DC replay that
  // index.js runs for DC sizing, surfaced once here (kept out of the prod result payload).
  const drainSeries = useMemo(() => {
    if (!ev || !modePlan || !modeDemand) return {};
    try {
      return replay(modePlan, null, modeDemand, { ...cfgDraft, infiniteDC: true }).toDrain || {};
    } catch (e) { console.error("drain series error:", e); return {}; }
  }, [ev, modePlan, modeDemand, cfgDraft]);

  const buckets = useMemo(() => ev ? deriveNZDBuckets(modeDemand, ev.universe) : null, [ev, modeDemand]);

  // Build display rows for the selected location
  const rows = useMemo(() => {
    if (!ev) return [];
    const isDC = loc === "DC";
    // DC tab: network-wide demand (ALL orders, regular + bulk) + bulk-day counts
    const netNZD = {}, netQty = {}, bulkDays = {};
    if (isDC) {
      const seen = {};
      for (const o of modeDemand.orders) {
        for (const l of o.lines) {
          if (!ev.universe[l.sku]) continue;
          netQty[l.sku] = (netQty[l.sku] || 0) + l.qty;
          (seen[l.sku] || (seen[l.sku] = new Set())).add(o.date);
        }
      }
      for (const sku in seen) netNZD[sku] = seen[sku].size;
      for (const sku in (modeDemand.bulkDaily || {})) bulkDays[sku] = Object.keys(modeDemand.bulkDaily[sku]).length;
    }
    const out = [];
    for (const sku of Object.keys(ev.universe)) {
      const meta = ev.universe[sku];
      const mm = inferThickness(meta.name);
      const p = isDC ? null : modePlan[sku][loc];
      const dc = isDC ? dcRes?.[sku]?.dcResult : null;
      const dd = isDC ? {} : (modeDemand.regularDaily[sku]?.[loc] || {});
      const dayVals = Object.values(dd);
      // Qty/NZD scope: DS = regular orders only (local); DC = all orders (network)
      const nzd = isDC ? (netNZD[sku] || 0) : dayVals.length;
      const qty = isDC ? (netQty[sku] || 0) : dayVals.reduce((a, b) => a + b, 0);
      const oos = isDC ? null : (modeOos?.[sku]?.[loc]?.oosOrders || 0);
      const floored = engineResults?.[sku]?.stores?.[loc]?.logicTag === "SKU Floor";
      out.push({
        sku, name: meta.name, brand: meta.brand, mm,
        tclass: ev.tclass[sku],
        nzd, qty, abq: nzd ? qty / nzd : 0,
        bulkDays: isDC ? (bulkDays[sku] || 0) : 0,
        bucket: isDC ? null : bucketOf(nzd, buckets?.edges || [1]),
        min: isDC ? (dc?.min ?? 0) : p.min,
        max: isDC ? (dc?.max ?? 0) : p.max,
        maxTrimmed: isDC ? 0 : (p.maxTrimmed || 0),
        oos, floored,
        dcInfo: isDC ? dcRes?.[sku]?.v2?.dcDetail : null,
      });
    }
    return out;
  }, [ev, dcRes, loc, buckets, engineResults, modePlan, modeDemand, modeOos]);

  if (!ready) return <div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>Loading data, please wait...</div>;
  if (!ev) return <div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>No plywood SKUs found for v2 universe.</div>;

  const isDC = loc === "DC";
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
        case "mm": return ((a.mm ?? -1) - (b.mm ?? -1)) * sortDir;
        case "nzd": return (a.nzd - b.nzd) * sortDir;
        case "abq": return (a.abq - b.abq) * sortDir;
        case "bulkDays": return ((a.bulkDays || 0) - (b.bulkDays || 0)) * sortDir;
        case "min": return (a.min - b.min) * sortDir;
        case "max": return (a.max - b.max) * sortDir;
        case "oos": return ((a.oos || 0) - (b.oos || 0)) * sortDir;
        default: return 0;
      }
    });

  const handleSort = col => {
    if (sortBy === col) setSortDir(d => d * -1);
    else { setSortBy(col); setSortDir(["sku", "name", "brand"].includes(col) ? 1 : -1); }
  };
  const sh = (col, label, center, tip) => {
    const on = sortBy === col;
    return (
      <th key={col} onClick={() => handleSort(col)} title={tip}
        style={{padding:"4px 6px",fontWeight:700,fontSize:10,color:on?HR.purple:"#666",borderBottom:`1px solid ${HR.border}`,
          textAlign:center?"center":"left",whiteSpace:"nowrap",cursor:"pointer",userSelect:"none",background:"#F8F8F2",position:"sticky",top:0,zIndex:2}}>
        {label}{on ? (sortDir === -1 ? "↓" : "↑") : <span style={{color:"#ccc",fontSize:8}}>↕</span>}
      </th>
    );
  };
  const hasFilter = query || fBrand !== "All" || fType !== "All" || fBucket !== "All" || fOOS;
  // avg ₹ per sheet of the current location's plan — used to value each frontier point's footprint
  const valuePerSheet = (() => { const t = rows.reduce((a, r) => a + r.max, 0); return t ? rows.reduce((a, r) => a + r.max * (priceData?.[r.sku] || 0), 0) / t : 0; })();
  // network plan inventory: Σ target Min/Max levels × cost, over all DS + DC (NOT live stock) — for the Overall Network card
  const netInv = (() => {
    let minVal = 0, maxVal = 0, maxQty = 0;
    for (const sku of Object.keys(ev.universe)) {
      const pp = priceData?.[sku] || 0;
      for (const ds of DS_LIST) {
        const p = modePlan[sku]?.[ds]; if (!p) continue;
        minVal += p.min * pp; maxVal += p.max * pp; maxQty += p.max;
      }
      const dc = dcRes?.[sku]?.dcResult;
      if (dc) { minVal += dc.min * pp; maxVal += dc.max * pp; maxQty += dc.max; }
    }
    return { minVal, maxVal, maxQty };
  })();

  return (
    <div>
      {/* header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
        <h2 style={{margin:0,fontSize:16}}>Plywood Network v2</h2>
        {/* one status chip: view basis (LIVE/TUNING) folds in the global publish + engine status (in the ⓘ) */}
        {(() => {
          const liveView = view === "location" && locked;
          const tuningView = view === "location" && !locked;
          const label = liveView ? "✓ LIVE — published plan"
            : tuningView ? "● TUNING — preview"
            : published ? "✓ Published" : "⚠ Testing";
          const good = liveView || (view === "assortment" && published);
          const note = published
            ? `v2 config is published, but the engine strategy is ${isActive ? "ACTIVE" : "NOT switched on"} — the model keeps running the previous strategy until cutover.`
            : (plywoodNetworkV2Config ? `${publishedCount}/5 DSes published, the rest are preview only.` : "Nothing published yet — all locations are preview only.");
          const basisNote = tuningView ? " Previewing un-published changes: fit on the first 75 days, scored out-of-window on the last 15. Publish to make it live." : liveView ? " These numbers are the published plan, fit on the full window." : "";
          return (
            <Hint align="left" text={note + basisNote}>
              <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10,padding:"3px 10px",borderRadius:10,fontWeight:700,
                background:good?"#DCFCE7":tuningView?"#FEF9E7":"#FEF3C7",color:good?HR.green:"#92400E",border:`1px solid ${good?"#BBF7D0":"#FDE68A"}`}}>
                {label} <span style={{opacity:0.6,fontWeight:400}}>ⓘ</span>
              </span>
            </Hint>
          );
        })()}
        {/* clean, labeled date windows */}
        {view === "location" && (
          <span style={{fontSize:10,color:HR.muted}}>
            {live
              ? <>Fit: <b style={{color:"#555"}}>{fmtD(ev.fitWindow.from)} – {fmtD(ev.testWindow.to)}</b> (full window)</>
              : <>Fit: <b style={{color:"#555"}}>{fmtD(ev.fitWindow.from)} – {fmtD(ev.fitWindow.to)}</b> · Test: <b style={{color:HR.purple}}>{fmtD(ev.testWindow.from)} – {fmtD(ev.testWindow.to)}</b></>}
          </span>
        )}
        <div style={{flex:1}}/>
        <button style={btn(view==="location")} onClick={()=>setView("location")}>Locations</button>
        <button style={btn(view==="assortment")} onClick={()=>setView("assortment")}>Assortment / Keep Score</button>
      </div>

      {view === "assortment" ? (
        <AssortmentView ks={ks} cfgDraft={cfgDraft} setCfgDraft={setCfgDraft} isAdmin={isAdmin}/>
      ) : (
        <div>
          {/* tuning basis banner — these numbers are an out-of-window forecast; publish refits on the full window */}
          {!live && (
            <div style={{fontSize:10.5,color:"#92400E",background:"#FEFCE8",border:"1px solid #FDE68A",borderRadius:8,padding:"6px 12px",marginBottom:8}}>
              <b>Tuning {loc}</b> — its card shows an <b>out-of-window forecast</b> (plan fit on the first 75 days, scored on the unseen last 15). The other locations and the network show their <b>live</b> numbers. On <b>Publish</b>, {loc} refits on the full 90 days, so its live service reads higher.
            </div>
          )}
          {/* Overall-Network SUMMARY (filled, non-clickable) + the clickable location PICKER strip */}
          {(() => {
            // clickable picker segments: hover highlight signals interactivity (summary card has none)
            const seg = (sel) => ({
              flex:1, minWidth:0, textAlign:"center", padding:"7px 6px", cursor:"pointer",
              background:sel?"#FFFBEB":"transparent", borderTop:`3px solid ${sel?HR.yellow:"transparent"}`,
            });
            const div = { borderLeft:`1px solid ${HR.border}` };
            const onHov = (ds) => ({
              onMouseEnter:e=>{ if (loc!==ds) e.currentTarget.style.background = "#FAFAF8"; },
              onMouseLeave:e=>{ e.currentTarget.style.background = loc===ds ? "#FFFBEB" : "transparent"; },
            });
            // per-card basis: published & not-being-tuned → LIVE (full-window); the tuned one → forecast
            const oow = ev.serviceLevels.regular, liveSL = ev.liveServiceLevels?.regular;
            const dsCard = (ds) => {
              const useLive = dsPublished(ds) && !isEditing(ds) && !!liveSL;
              const c = (useLive ? liveSL : oow).perDS[ds] || { service: 1, oos: 0, total: 0 };
              return { service: c.service, oos: c.oos, total: c.total, live: useLive,
                proj: !useLive && liveSL ? liveSL.perDS[ds]?.service : null };  // live projection on the tuned card
            };
            const netSC = liveSL || oow;                          // network shown LIVE (reflects edits)
            const dcCardLive = dcPub && !isEditing("DC") && !!dcLive;
            const dcShown = dcCardLive ? dcLive : dcStats;
            const fcTag = <span style={{color:"#B45309",fontWeight:700}}>forecast</span>;
            return (
              <div style={{display:"flex",alignItems:"stretch",gap:8,marginBottom:10}}>
                {/* summary — a STAT, not a picker: filled card, accent bar, no hover/pointer; service | inventory side by side */}
                <div style={{flex:2.1,minWidth:0,padding:"7px 10px",borderRadius:10,background:HR.surfaceLight,border:`1px solid ${HR.border}`,borderLeft:`3px solid ${HR.black}`}}>
                  <div style={{fontSize:8.5,color:HR.muted,fontWeight:700,letterSpacing:0.4,textTransform:"uppercase",textAlign:"center"}}>Overall Network</div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,minWidth:0,textAlign:"center"}}>
                      <div style={{fontSize:16,fontWeight:800,color:pillColor(netSC.overall)}}>{(netSC.overall*100).toFixed(1)}%</div>
                      <div style={{fontSize:9,color:HR.muted}}>
                        <Hint align="left" text={liveSL
                          ? "Regular-order service across all DSes, scored on the last 15 days against the full-window plan (reflects your in-progress edits)."
                          : "Regular-order service across all DSes — out-of-window: fit on the first 75 days, scored on the unseen last 15."}>
                          <span style={dotted}>{liveSL ? "live service" : "service"}</span>
                        </Hint> · {netSC.oos}/{netSC.total} OOS
                      </div>
                    </div>
                    <div style={{width:1,alignSelf:"stretch",background:HR.border}}/>
                    <div style={{flex:1,minWidth:0,textAlign:"center"}}>
                      <div style={{fontSize:14,fontWeight:800,color:"#166534",whiteSpace:"nowrap"}}>{fmtLakh(netInv.minVal)} – {fmtLakh(netInv.maxVal)}</div>
                      <div style={{fontSize:9,color:HR.muted}}>
                        <Hint align="right" text="Target plan inventory across all DS + DC = Σ(Min) to Σ(Max) levels × cost price. Not live stock on hand.">
                          <span style={dotted}>plan inv</span>
                        </Hint> · Min–Max
                      </div>
                    </div>
                  </div>
                </div>
                {/* picker — the clickable locations, as one continuous segmented bar */}
                <div style={{flex:6,display:"flex",alignItems:"stretch",border:`1px solid ${HR.border}`,borderRadius:10,overflow:"hidden",background:HR.surface}}>
                  {DS_LIST.map((ds, i) => {
                    const cd = dsCard(ds);
                    return (
                      <div key={ds} style={{...seg(loc===ds),...(i>0?div:{})}} onClick={()=>setLoc(ds)} {...onHov(ds)}>
                        <div style={{fontSize:9,color:loc===ds?"#000":HR.muted,fontWeight:loc===ds?700:600}}>{ds}{loc===ds?" ●":""}</div>
                        <div style={{fontSize:16,fontWeight:800,color:pillColor(cd.service)}}>{(cd.service*100).toFixed(1)}%</div>
                        <div style={{fontSize:9,color:HR.muted}}>
                          {cd.live ? <>service · {cd.oos}/{cd.total}</>
                            : <>{fcTag}{cd.proj!=null && <> → <span style={{color:HR.green,fontWeight:700}}>~{(cd.proj*100).toFixed(0)}% live</span></>}</>}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{...seg(loc==="DC"),...div}} onClick={()=>setLoc("DC")} {...onHov("DC")}>
                    <div style={{fontSize:9,color:loc==="DC"?"#000":HR.muted,fontWeight:loc==="DC"?700:600}}>DC{loc==="DC"?" ●":""}</div>
                    <div style={{fontSize:16,fontWeight:800,color:dcShown?.bulkServed!=null?pillColor(dcShown.bulkServed):HR.muted}}>{dcShown?.bulkServed!=null?`${(dcShown.bulkServed*100).toFixed(1)}%`:"—"}</div>
                    <div style={{fontSize:9,color:HR.muted}}>
                      <Hint align="right" text="Share of bulk orders served off the DC shelf — the DC's own job. (DS customer service is on the DS cards and barely moves with DC depth.) TO qty-fill is a diagnostic only.">
                        <span style={dotted}>bulk{dcCardLive ? " served" : ""}</span>
                      </Hint>
                      {dcCardLive
                        ? <> · TO-fill {dcShown?.toFill!=null?`${(dcShown.toFill*100).toFixed(0)}%`:"—"}</>
                        : <> {fcTag}{dcLive?.bulkServed!=null && <> → <span style={{color:HR.green,fontWeight:700}}>~{(dcLive.bulkServed*100).toFixed(0)}% live</span></>}</>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* tune panel: per-DS frontier, or the DC dual-line frontier */}
          {!isDC ? (
            <DSTunePanel loc={loc} cfgDraft={cfgDraft} setCfgDraft={setCfgDraft}
              invoiceData={invoiceData} skuMaster={skuMaster} isAdmin={isAdmin}
              onSaveConfig={onSaveConfig} tuneResult={tuneResult} setTuneResult={setTuneResult}
              dsPub={dsPublished(loc)} onPublishDS={publishDS} onRevertDS={revertDS}
              hasSaved={!!plywoodNetworkV2Config} valuePerSheet={valuePerSheet}
              locked={locked} onUnpublish={unpublishLoc} onRelock={lockLoc}/>
          ) : (
            <DCTunePanel cfgDraft={cfgDraft} setCfgDraft={setCfgDraft}
              invoiceData={invoiceData} skuMaster={skuMaster} isAdmin={isAdmin}
              dcPub={dcPub} onPublishDC={publishDC} onRevertDC={revertDC}
              hasSaved={!!plywoodNetworkV2Config} allDSPublished={publishedCount === 5} valuePerSheet={valuePerSheet}
              dcTune={dcTune} setDcTune={setDcTune}
              locked={locked} onUnpublish={unpublishLoc} onRelock={lockLoc}/>
          )}

          {/* location stat cards + capacity bars (display-only) */}
          <div style={{display:"flex",gap:8,marginBottom:8,alignItems:"stretch",flexWrap:"wrap"}}>
            {(() => {
              const sumMin = rows.reduce((a, r) => a + r.min, 0);
              const sumMax = rows.reduce((a, r) => a + r.max, 0);
              const valMin = rows.reduce((a, r) => a + r.min * (priceData?.[r.sku] || 0), 0);
              const valMax = rows.reduce((a, r) => a + r.max * (priceData?.[r.sku] || 0), 0);
              return (
                <>
                  <div style={{padding:"5px 12px",background:"#FAFAF8",border:`1px solid ${HR.border}`,borderRadius:6}}>
                    <div style={{fontSize:9,color:HR.muted}}>{loc} Σ Min qty</div>
                    <div style={{fontSize:14,fontWeight:800,color:HR.blue}}>{sumMin}</div>
                  </div>
                  <div style={{padding:"5px 12px",background:"#FAFAF8",border:`1px solid ${HR.border}`,borderRadius:6}}>
                    <div style={{fontSize:9,color:HR.muted}}>{loc} Σ Max qty (sheets)</div>
                    <div style={{fontSize:14,fontWeight:800,color:"#166534"}}>{sumMax}</div>
                  </div>
                  <div style={{padding:"5px 12px",background:"#FAFAF8",border:`1px solid ${HR.border}`,borderRadius:6}}>
                    <div style={{fontSize:9,color:HR.muted}}>{loc} inventory value @ Min</div>
                    <div style={{fontSize:14,fontWeight:800,color:HR.blue}}>{fmtLakh(valMin)}</div>
                  </div>
                  <div style={{padding:"5px 12px",background:"#FAFAF8",border:`1px solid ${HR.border}`,borderRadius:6}}>
                    <div style={{fontSize:9,color:HR.muted}}>{loc} inventory value @ Max</div>
                    <div style={{fontSize:14,fontWeight:800,color:"#166534"}}>{fmtLakh(valMax)}</div>
                  </div>
                </>
              );
            })()}
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
          {/* bounded scroll box so the header sticks; offset adapts to the taller tuning header vs the compact published one */}
          <div style={{overflow:"auto",maxHeight:`calc(100vh / 0.85 - ${locked ? 290 : 470}px)`,background:HR.surface,borderRadius:8,border:`1px solid ${HR.border}`}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr>
                {sh("sku","SKU")}
                {sh("name","Item Name")}
                {sh("mm","Thickness",true)}
                {sh("brand","Brand")}
                {sh("nzd", isDC?"Net NZD":"NZD", true, isDC
                  ? "Distinct days this SKU sold anywhere in the network — all orders (regular + bulk)."
                  : "Local non-zero (selling) days at this DS — regular orders only.")}
                {isDC && sh("bulkDays","Bulk Days", true, "Distinct days with a bulk order (line ≥ bulk threshold) for this SKU, network-wide.")}
                {sh("abq","Qty/NZD", true, isDC
                  ? "Avg qty on a day it sells = total qty ÷ Net NZD. Considers ALL orders (regular + bulk) — not a daily average."
                  : "Avg qty on a day it sells = total qty ÷ NZD. Considers REGULAR orders only — not a daily average.")}
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
                      <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",whiteSpace:"nowrap"}} onClick={e=>e.stopPropagation()}>
                        <span style={{display:"flex",alignItems:"center",gap:4}}>
                          <span style={{fontFamily:"monospace",fontSize:10,color:"#555"}}>{r.sku}</span>
                          <span onClick={e=>copySku(r.sku,e)} title="Copy SKU"
                            style={{cursor:"pointer",flexShrink:0,color:copiedSku===r.sku?"#059669":"#BBAC97",lineHeight:1,display:"flex",alignItems:"center"}}>
                            {copiedSku===r.sku
                              ? <span style={{fontSize:9,fontWeight:700,color:"#059669"}}>✓</span>
                              : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                          </span>
                        </span>
                      </td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {r.name}
                        {r.floored && <span style={{marginLeft:5,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"#EDE9FE",color:"#6D28D9",border:"1px solid #C4B5FD"}}>Floor</span>}
                        {r.maxTrimmed > 0 && <span style={{marginLeft:5,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"#FEF3C7",color:"#B45309",border:"1px solid #FDE68A"}} title={`Max reduced by ${r.maxTrimmed} to fit ${loc} rack (NZD-ordered trim)`}>Max −{r.maxTrimmed}</span>}
                        {isDC && (r.dcInfo?.trimmedDepth || 0) > 0 && (
                          <span style={{marginLeft:5,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"#FEF3C7",color:"#B45309",border:"1px solid #FDE68A"}}
                            title={`DC capacity trim: order-up-to depth −${r.dcInfo?.trimmedDepth || 0} (reorder floor s never trimmed)`}>
                            DC trim −{r.dcInfo?.trimmedDepth || 0}
                          </span>
                        )}
                      </td>
                      <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                        <span style={{fontSize:10,color:"#555"}}>{r.mm != null ? `${r.mm}mm` : "—"}</span>
                        <span style={{marginLeft:5,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:r.tclass==="thick"?"#FEF3C7":"#DBEAFE",color:r.tclass==="thick"?"#92400E":HR.blue}}>
                          {r.tclass === "thick" ? "Thick" : "Thin"}
                        </span>
                      </td>
                      <td style={{padding:"3px 6px",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555",whiteSpace:"nowrap"}}>{r.brand || "—"}</td>
                      {!isDC ? (
                        <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                          <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,...bc.badge}}>{buckets?.labels[r.bucket] ?? r.nzd}</span>
                          <span style={{marginLeft:5,fontSize:10,color:"#555"}}>{r.nzd}</span>
                        </td>
                      ) : (
                        <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555"}}>{r.nzd}</td>
                      )}
                      {isDC && <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555"}}>{r.bulkDays || "—"}</td>}
                      <td style={{padding:"3px 6px",textAlign:"center",borderBottom:"1px solid rgba(0,0,0,0.05)",color:"#555"}}>{r.nzd ? fmt1(r.abq) : "—"}</td>
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
        <SKUModalV2 row={selected} loc={loc} ev={ev} cfg={cfgDraft} dcInfo={selected.dcInfo} drainSeries={drainSeries} published={published} live={live} oosCounts={modeOos} onClose={()=>setSelected(null)}/>
      )}
    </div>
  );
}
