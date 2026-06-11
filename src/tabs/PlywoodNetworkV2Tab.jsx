// Plywood Network v2 tab — capacity-first allocation (spec: docs/superpowers/specs/2026-06-11-plywood-network-v2-design.md)
// Panels: Allocation | DC | Simulation | Keep Score | Config
// All computation is client-side and read-only; only the admin Save Config button writes to Supabase.
import React, { useState, useMemo } from "react";
import {
  computePlywoodNetworkV2Results, V2_DEFAULTS, buildUniverse, prepareDemand,
  replay, computeKeepScores,
} from "../engine/strategies/plywoodV2/index.js";
import { DS_LIST } from "../engine/constants.js";

const HR = {
  yellow:"#F5C400",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",green:"#15803D",red:"#DC2626",amber:"#D97706",purple:"#7C3AED",
};
const S = {
  card:{background:HR.surface,borderRadius:8,padding:12,border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  btn:(on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,whiteSpace:"nowrap",outline:"none"}),
  input:{background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"4px 8px",color:HR.text,fontSize:12,width:70},
  table:{width:"100%",borderCollapse:"collapse",fontSize:11},
  th:{padding:"5px 8px",textAlign:"left",color:HR.muted,background:HR.surfaceLight,fontWeight:600,fontSize:10,whiteSpace:"nowrap",position:"sticky",top:0},
  td:{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,whiteSpace:"nowrap"},
  sectionTitle:{fontSize:12,fontWeight:700,color:"#555",borderBottom:`2px solid ${HR.yellow}`,paddingBottom:4,marginBottom:12},
  kpi:{flex:1,background:HR.surface,borderRadius:8,padding:"10px 14px",border:`1px solid ${HR.border}`},
};

function csvDownload(filename, rows) {
  const txt = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

function CapacityBar({ used, capacity }) {
  if (capacity == null) return <span style={{color:HR.muted}}>∞</span>;
  const pct = capacity > 0 ? used / capacity * 100 : 0;
  const color = pct > 100 ? HR.red : pct >= 99 ? HR.amber : HR.green;
  return (
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <div style={{width:90,height:8,background:HR.surfaceLight,borderRadius:4,overflow:"hidden"}}>
        <div style={{width:`${Math.min(pct,100)}%`,height:"100%",background:color}}/>
      </div>
      <span style={{fontSize:10,color,fontWeight:600}}>{used}/{capacity} ({Math.round(pct)}%)</span>
    </div>
  );
}

export default function PlywoodNetworkV2Tab({ invoiceData, skuMaster, priceData, isAdmin, plywoodNetworkV2Config, onSaveConfig, isActive }) {
  const [panel, setPanel] = useState("allocation");
  const [dsSel, setDsSel] = useState("DS01");
  const [cfgDraft, setCfgDraft] = useState(() => ({ ...V2_DEFAULTS, ...(plywoodNetworkV2Config || {}) }));
  const [flagFilter, setFlagFilter] = useState("All");
  const [simFrom, setSimFrom] = useState("");
  const [simTo, setSimTo] = useState("");
  const [simResult, setSimResult] = useState(null);

  const ready = invoiceData?.length > 0 && Object.keys(skuMaster || {}).length > 0;

  const computed = useMemo(() => {
    if (!ready) return null;
    try {
      const params = { plywoodNetworkV2Config: cfgDraft };
      const res = computePlywoodNetworkV2Results(invoiceData, skuMaster, params);
      if (!Object.keys(res).length) return null;
      const universe = buildUniverse(skuMaster, cfgDraft);
      const demand = prepareDemand(invoiceData, universe, cfgDraft);
      const plan = {}, dcPlan = {};
      for (const [sku, r] of Object.entries(res)) {
        plan[sku] = {};
        for (const ds of DS_LIST) plan[sku][ds] = { min: r.storeResults[ds].min, max: r.storeResults[ds].max };
        dcPlan[sku] = { ...r.dcResult };
      }
      return { res, universe, demand, plan, dcPlan };
    } catch (e) { console.error("plywood v2 compute error:", e); return null; }
  }, [ready, invoiceData, skuMaster, cfgDraft]);

  const keepScores = useMemo(() => {
    if (!computed) return [];
    const { universe, demand, plan, dcPlan } = computed;
    const windowQty = {}, networkNZD = {}, regularNZD = {};
    const allDates = {};
    for (const sku of Object.keys(universe)) { windowQty[sku] = 0; }
    for (const o of demand.orders) for (const l of o.lines) {
      windowQty[l.sku] = (windowQty[l.sku] || 0) + l.qty;
      (allDates[l.sku] = allDates[l.sku] || new Set()).add(o.date);
    }
    for (const sku of Object.keys(universe)) {
      networkNZD[sku] = allDates[sku]?.size || 0;
      const rd = new Set();
      for (const ds of DS_LIST) for (const d of Object.keys(demand.regularDaily[sku]?.[ds] || {})) rd.add(d);
      regularNZD[sku] = rd.size;
    }
    return computeKeepScores({ plan, dcPlan, priceData: priceData || {}, windowQty, networkNZD, regularNZD }, cfgDraft.keepScore || {});
  }, [computed, priceData, cfgDraft]);

  const runSim = () => {
    if (!computed) return;
    const { universe, plan, dcPlan } = computed;
    const from = simFrom || computed.demand.cutoff;
    const to = simTo || computed.demand.windowDates[computed.demand.windowDates.length - 1];
    const slice = invoiceData.filter(r => r.date >= from && r.date <= to);
    const spanDays = Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000) + 1;
    const demand = prepareDemand(slice, universe, { ...cfgDraft, lookbackDays: spanDays });
    if (!demand) { setSimResult(null); return; }
    setSimResult({ sim: replay(plan, dcPlan, demand, cfgDraft), from, to, days: demand.windowDates.length });
  };

  if (!ready) return <div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>Loading data, please wait...</div>;
  if (!computed) return <div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>No plywood SKUs found for v2 universe.</div>;

  const { res, demand } = computed;
  const anySku = Object.keys(res)[0];
  const nodeReport = res[anySku].v2.nodeReport;
  const trimReport = res[anySku].v2.dcTrimReport;
  const skuRows = Object.entries(res).sort((a, b) => a[0] < b[0] ? -1 : 1);

  const PANELS = [["allocation","Allocation"],["dc","DC"],["sim","Simulation"],["keep","Keep Score"],["config","Config"]];

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <h2 style={{margin:0,fontSize:16}}>Plywood Network v2</h2>
        <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:isActive?"#DCFCE7":HR.surfaceLight,color:isActive?HR.green:HR.muted,fontWeight:700}}>
          {isActive ? "ACTIVE IN ENGINE" : "PREVIEW — not active"}
        </span>
        <span style={{fontSize:10,color:HR.muted}}>
          {Object.keys(res).length} SKUs · window {demand.cutoff} → {demand.windowDates[demand.windowDates.length-1]} ({demand.windowDates.length}d)
        </span>
        <div style={{flex:1}}/>
        {PANELS.map(([k, label]) => (
          <button key={k} style={S.btn(panel===k)} onClick={()=>setPanel(k)}>{label}</button>
        ))}
      </div>

      {panel === "allocation" && (
        <div>
          <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap"}}>
            {DS_LIST.map(ds => (
              <div key={ds} style={{...S.kpi,minWidth:170,cursor:"pointer",border:`1px solid ${dsSel===ds?HR.yellow:HR.border}`}} onClick={()=>setDsSel(ds)}>
                <div style={{fontSize:11,fontWeight:700,marginBottom:6}}>{ds}</div>
                {["thick","thin"].map(tc => (
                  <div key={tc} style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                    <span style={{fontSize:9,color:HR.muted,width:32}}>{tc}</span>
                    <CapacityBar used={nodeReport[ds][tc].used} capacity={nodeReport[ds][tc].capacity}/>
                  </div>
                ))}
                {(nodeReport[ds].thick.overCapacity || nodeReport[ds].thin.overCapacity) && (
                  <div style={{fontSize:9,color:HR.red,fontWeight:700,marginTop:2}}>⚠ floors alone exceed capacity</div>
                )}
              </div>
            ))}
          </div>
          <div style={{...S.card,maxHeight:520,overflowY:"auto"}}>
            <table style={S.table}>
              <thead><tr>
                {["SKU","Item Name","Brand","Class","Floor","Depth","Min","Max","Reg NZD"].map(h=><th key={h} style={S.th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {skuRows.map(([sku, r]) => {
                  const sr = r.storeResults[dsSel];
                  return (
                    <tr key={sku}>
                      <td style={S.td}>{sku}</td>
                      <td style={{...S.td,maxWidth:280,overflow:"hidden",textOverflow:"ellipsis"}} title={skuMaster[sku]?.name}>{skuMaster[sku]?.name}</td>
                      <td style={S.td}>{r.brand}</td>
                      <td style={S.td}>{sr.v2.tclass}</td>
                      <td style={S.td}>{sr.v2.floor}</td>
                      <td style={{...S.td,color:sr.v2.depth>0?HR.green:HR.muted,fontWeight:sr.v2.depth>0?700:400}}>{sr.v2.depth>0?`+${sr.v2.depth}`:"—"}</td>
                      <td style={{...S.td,fontWeight:700}}>{sr.min}</td>
                      <td style={{...S.td,fontWeight:700}}>{sr.max}</td>
                      <td style={S.td}>{sr.nonZeroCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {panel === "dc" && (
        <div>
          {trimReport?.steps?.length > 0 && (
            <div style={{...S.card,marginBottom:10,background:"#FEF3C7",border:"1px solid #FCD34D",fontSize:11}}>
              <b>DC capacity trim applied:</b> {trimReport.steps.join(" → ")}
              {trimReport.stillOver && <span style={{color:HR.red,fontWeight:700}}> — still over capacity after trim</span>}
            </div>
          )}
          <div style={{...S.card,maxHeight:560,overflowY:"auto"}}>
            <table style={S.table}>
              <thead><tr>
                {["SKU","Item Name","Class","Repl (P"+(cfgDraft.dcReplPercentile??98)+")","Bulk","Cycle","DC Min","DC Max"].map(h=><th key={h} style={S.th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {skuRows.map(([sku, r]) => (
                  <tr key={sku}>
                    <td style={S.td}>{sku}</td>
                    <td style={{...S.td,maxWidth:280,overflow:"hidden",textOverflow:"ellipsis"}} title={skuMaster[sku]?.name}>{skuMaster[sku]?.name}</td>
                    <td style={S.td}>{r.storeResults.DS01.v2.tclass}</td>
                    <td style={S.td}>{r.v2.dcDetail?.repl ?? "—"}</td>
                    <td style={S.td}>{r.v2.dcDetail?.bulk ?? "—"}</td>
                    <td style={S.td}>{r.v2.dcDetail?.cycle ?? "—"}</td>
                    <td style={{...S.td,fontWeight:700}}>{r.dcResult.min}</td>
                    <td style={{...S.td,fontWeight:700}}>{r.dcResult.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {panel === "sim" && (
        <div>
          <div style={{...S.card,marginBottom:10,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,fontWeight:600}}>Window:</span>
            <input type="date" style={{...S.input,width:130}} value={simFrom} onChange={e=>setSimFrom(e.target.value)} placeholder={demand.cutoff}/>
            <span style={{fontSize:11,color:HR.muted}}>to</span>
            <input type="date" style={{...S.input,width:130}} value={simTo} onChange={e=>setSimTo(e.target.value)}/>
            <button style={{...S.btn(true)}} onClick={runSim}>Run Simulation</button>
            <span style={{fontSize:10,color:HR.muted}}>Empty dates = full lookback window. Order-level scoring: any short line fails the whole order.</span>
          </div>
          {simResult && (() => {
            const sl = simResult.sim.serviceLevels;
            return (
              <div>
                <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                  <div style={S.kpi}>
                    <div style={{fontSize:10,color:HR.muted}}>Regular orders (DS)</div>
                    <div style={{fontSize:22,fontWeight:800,color:sl.regular.overall>=0.99?HR.green:sl.regular.overall>=0.95?HR.amber:HR.red}}>
                      {(sl.regular.overall*100).toFixed(2)}%
                    </div>
                    <div style={{fontSize:10,color:HR.muted}}>{sl.regular.oos} OOS of {sl.regular.total}</div>
                  </div>
                  <div style={S.kpi}>
                    <div style={{fontSize:10,color:HR.muted}}>Bulk orders (DC)</div>
                    <div style={{fontSize:22,fontWeight:800,color:sl.bulk.overall>=0.9?HR.green:sl.bulk.overall>=0.8?HR.amber:HR.red}}>
                      {(sl.bulk.overall*100).toFixed(2)}%
                    </div>
                    <div style={{fontSize:10,color:HR.muted}}>{sl.bulk.oos} OOS of {sl.bulk.total}</div>
                  </div>
                  {DS_LIST.map(ds => {
                    const c = sl.regular.perDS[ds];
                    if (!c) return null;
                    return (
                      <div key={ds} style={S.kpi}>
                        <div style={{fontSize:10,color:HR.muted}}>{ds}</div>
                        <div style={{fontSize:16,fontWeight:700,color:c.service>=0.99?HR.green:c.service>=0.95?HR.amber:HR.red}}>{(c.service*100).toFixed(1)}%</div>
                        <div style={{fontSize:10,color:HR.muted}}>{c.oos}/{c.total}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{fontSize:11,color:HR.muted,marginBottom:8}}>
                  Ops load: {simResult.sim.opsLoad.toLines} TO lines ({(simResult.sim.opsLoad.toLines/simResult.days).toFixed(1)}/day), {simResult.sim.opsLoad.poLines} PO lines · {simResult.from} → {simResult.to}
                </div>
                <div style={{...S.card,maxHeight:380,overflowY:"auto"}}>
                  <table style={S.table}>
                    <thead><tr>{["Type","Date","DS","SKU","Item Name","Order","Short"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {simResult.sim.oosEvents.map((e, i) => (
                        <tr key={i}>
                          <td style={{...S.td,color:e.type==="bulk"?HR.purple:HR.red,fontWeight:600}}>{e.type}</td>
                          <td style={S.td}>{e.date}</td>
                          <td style={S.td}>{e.ds}</td>
                          <td style={S.td}>{e.sku}</td>
                          <td style={{...S.td,maxWidth:240,overflow:"hidden",textOverflow:"ellipsis"}} title={skuMaster[e.sku]?.name}>{skuMaster[e.sku]?.name}</td>
                          <td style={S.td}>{e.orderId}</td>
                          <td style={{...S.td,fontWeight:700}}>{e.short}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
          {!simResult && <div style={{textAlign:"center",padding:40,color:HR.muted,fontSize:12}}>Run a simulation to see service levels.</div>}
        </div>
      )}

      {panel === "keep" && (
        <div>
          <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
            {["All","Keep","Watch","Cut"].map(f => (
              <button key={f} style={S.btn(flagFilter===f)} onClick={()=>setFlagFilter(f)}>
                {f}{f!=="All"?` (${keepScores.filter(s=>s.flag===f).length})`:""}
              </button>
            ))}
            <div style={{flex:1}}/>
            <button style={S.btn(false)} onClick={()=>csvDownload("plywood-v2-keepscore.csv", [
              ["SKU","Item Name","PP","Avg Position","Holding Val","Rent Ratio","Service Ratio","Keep Score","Flag"],
              ...keepScores.map(s=>[s.sku, skuMaster[s.sku]?.name, s.pp, s.avgPosition.toFixed(1), Math.round(s.holdingValue), s.rentRatio.toFixed(2), s.serviceRatio.toFixed(2), s.keepScore.toFixed(2), s.flag]),
            ])}>Export CSV</button>
          </div>
          <div style={{...S.card,maxHeight:540,overflowY:"auto"}}>
            <table style={S.table}>
              <thead><tr>{["SKU","Item Name","PP","Avg Position","Holding Val","Rent Ratio","Service Ratio","Keep Score","Flag"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {keepScores
                  .filter(s => flagFilter === "All" || s.flag === flagFilter)
                  .sort((a, b) => a.keepScore - b.keepScore)
                  .map(s => (
                  <tr key={s.sku}>
                    <td style={S.td}>{s.sku}</td>
                    <td style={{...S.td,maxWidth:280,overflow:"hidden",textOverflow:"ellipsis"}} title={skuMaster[s.sku]?.name}>{skuMaster[s.sku]?.name}</td>
                    <td style={S.td}>{s.pp ? Math.round(s.pp).toLocaleString() : "-"}</td>
                    <td style={S.td}>{s.avgPosition.toFixed(1)}</td>
                    <td style={S.td}>{Math.round(s.holdingValue).toLocaleString()}</td>
                    <td style={S.td}>{s.rentRatio.toFixed(2)}</td>
                    <td style={S.td}>{s.serviceRatio.toFixed(2)}</td>
                    <td style={{...S.td,fontWeight:700}}>{s.keepScore.toFixed(2)}</td>
                    <td style={{...S.td,fontWeight:700,color:s.flag==="Cut"?HR.red:s.flag==="Watch"?HR.amber:HR.green}}>{s.flag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {panel === "config" && (
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          <div style={{...S.card,flex:"1 1 320px"}}>
            <div style={S.sectionTitle}>Parameters</div>
            {[
              ["lookbackDays","Lookback days"],
              ["bulkOrderThreshold","Bulk order threshold (sheets)"],
              ["bulkDcServedShare","Bulk DC-served share (0–1)"],
              ["minDepthStopPercentile","Min depth stop percentile"],
              ["dcReplPercentile","DC replenishment percentile"],
              ["dcBulkPercentile","DC bulk percentile"],
              ["dcCoverDays","DC cycle cover days"],
              ["leadDays","Supplier lead days"],
              ["thickBoundaryMm","Thick boundary (mm)"],
            ].map(([key, label]) => (
              <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:11}}>{label}</span>
                <input type="number" step="any" style={S.input}
                  value={cfgDraft[key]}
                  onChange={e=>setCfgDraft(d=>({...d,[key]:Number(e.target.value)}))}/>
              </div>
            ))}
            <div style={{fontSize:10,color:HR.muted,marginTop:8}}>Changes recompute the preview live. Save (admin) persists + re-runs the engine.</div>
          </div>
          <div style={{...S.card,flex:"1 1 320px"}}>
            <div style={S.sectionTitle}>Capacities (sheets, ΣMax budget)</div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Node</th><th style={S.th}>Thick</th><th style={S.th}>Thin</th></tr></thead>
              <tbody>
                {DS_LIST.map(ds => (
                  <tr key={ds}>
                    <td style={{...S.td,fontWeight:600}}>{ds}</td>
                    {["thick","thin"].map(tc => (
                      <td key={tc} style={S.td}>
                        <input type="number" style={S.input}
                          value={cfgDraft.dsCapacities?.[ds]?.[tc] ?? 0}
                          onChange={e=>setCfgDraft(d=>({...d,dsCapacities:{...d.dsCapacities,[ds]:{...d.dsCapacities?.[ds],[tc]:Number(e.target.value)}}}))}/>
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td style={{...S.td,fontWeight:600}}>DC</td>
                  {["thick","thin"].map(tc => (
                    <td key={tc} style={S.td}>
                      <input type="number" style={S.input}
                        value={cfgDraft.dcCapacity?.[tc] ?? 0}
                        onChange={e=>setCfgDraft(d=>({...d,dcCapacity:{...d.dcCapacity,[tc]:Number(e.target.value)}}))}/>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <div style={{...S.sectionTitle,marginTop:14}}>Keep Score</div>
            {[
              ["grossMarginPct","Gross margin (0–1)"],
              ["carryRateQuarterly","Carrying cost /quarter (0–1)"],
              ["opsBuffer","Ops buffer ×"],
              ["serviceNZDThreshold","Service NZD threshold"],
            ].map(([key, label]) => (
              <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:11}}>{label}</span>
                <input type="number" step="any" style={S.input}
                  value={cfgDraft.keepScore?.[key] ?? ""}
                  onChange={e=>setCfgDraft(d=>({...d,keepScore:{...d.keepScore,[key]:Number(e.target.value)}}))}/>
              </div>
            ))}
            {isAdmin && (
              <button style={{...S.btn(true),marginTop:10,padding:"8px 16px"}}
                onClick={()=>onSaveConfig && onSaveConfig(cfgDraft)}>
                Save Config & Re-run Engine
              </button>
            )}
            {!isAdmin && <div style={{fontSize:10,color:HR.muted,marginTop:10}}>Read-only — admin login required to save.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
