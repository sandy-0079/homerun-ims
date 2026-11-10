import React, { useState, useEffect, useRef } from "react";
import {
  DS_LIST, DC_DEAD_MULT_DEFAULT, RECENCY_WT_DEFAULT,
  BASE_MIN_DAYS_DEFAULT, DEFAULT_PARAMS, OPENING_DS_DEFAULT, summariseCoverage,
} from "../engine/index.js";
import { HR, S } from "../appStyles";
import { MOV_COLORS, PRICE_TAG_COLORS, TAG_STYLE } from "../appTagColors";
import { TagPill, MovTag } from "../appTags";

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

/**
 * Logic Tweaker tab — moved verbatim out of App.jsx. App still owns the state
 * (params draft, savedParams, the confirm modal and Advanced toggle) and the writes
 * (applyAndRun is passed in as onApply).
 */
export default function LogicTweakerTab({ params, savedParams, saveParams, setParams, onApply: applyAndRun,
  hasChanges, handlePincodeMap, blrInvoice, missing, skuMaster, uploading, isAdmin,
  advancedOpen, setAdvancedOpen, showLogicConfirm, setShowLogicConfirm,
  // Hyderabad props — every default is Bangalore's behaviour (Bangalore passes none of them):
  //   showNetworkSections=false hides the Bangalore-network settings (New DS, Store Status,
  //     pincode attribution, DC multipliers, plywood non-network picker + retired v2 option)
  //     and their changelog lines; topSlot renders above the first section;
  //   leadTimeLabel relabels Brand Lead Time; applyDisabled blocks Apply (failed read);
  //   extraChangelog lists changes to keys this changelog does not know (Hyderabad-only).
  showNetworkSections = true, topSlot = null, leadTimeLabel = "Brand Lead Time (DC)",
  applyDisabled = false, extraChangelog = null }) {
  // ── Changelog: diff params vs savedParams ──
  const logicChangelog=[];
  const s=savedParams,c=params;
  if(c.overallPeriod!==s.overallPeriod) logicChangelog.push(`Overall period: ${s.overallPeriod}D → ${c.overallPeriod}D`);
  if(c.recencyWindow!==s.recencyWindow) logicChangelog.push(`Recency window: ${s.recencyWindow}D → ${c.recencyWindow}D`);
  if(c.maxDaysBuffer!==s.maxDaysBuffer) logicChangelog.push(`Max days buffer: ${s.maxDaysBuffer}D → ${c.maxDaysBuffer}D`);
  if(c.abqMaxMultiplier!==s.abqMaxMultiplier) logicChangelog.push(`ABQ multiplier: ${s.abqMaxMultiplier} → ${c.abqMaxMultiplier}`);
  if(c.pctDocCap!==s.pctDocCap) logicChangelog.push(`PCT DOC cap (Premium/High): ${s.pctDocCap}D → ${c.pctDocCap}D`);
  if(c.pctDocCapLow!==s.pctDocCapLow) logicChangelog.push(`PCT DOC cap (Medium/Low): ${s.pctDocCapLow??60}D → ${c.pctDocCapLow}D`);
  if(c.pctMinNZD!==s.pctMinNZD) logicChangelog.push(`PCT min NZD: ${s.pctMinNZD} → ${c.pctMinNZD}`);
  if(showNetworkSections&&c.plywoodNonNetworkStrategy!==s.plywoodNonNetworkStrategy) logicChangelog.push(`Plywood non-network strategy: ${s.plywoodNonNetworkStrategy||"percentile_cover"} → ${c.plywoodNonNetworkStrategy||"percentile_cover"}`);
  if(showNetworkSections){
    const cm=(c.pincodeConfig||{}).mode||"location", sm=(s.pincodeConfig||{}).mode||"location";
    const label=m=>m==="shippingCode"?"customer pincode":"fulfilling location";
    if(cm!==sm) logicChangelog.push(`Demand attribution: ${label(sm)} → ${label(cm)}`);
    const cn=Object.keys((c.pincodeConfig||{}).map||{}).length, sn=Object.keys((s.pincodeConfig||{}).map||{}).length;
    if(cn!==sn) logicChangelog.push(`Pincode mapping: ${sn} → ${cn} pincodes`);
  }
  if(c.spikeMultiplier!==s.spikeMultiplier) logicChangelog.push(`Spike multiplier: ${s.spikeMultiplier}× → ${c.spikeMultiplier}×`);
  if(c.spikePctFrequent!==s.spikePctFrequent) logicChangelog.push(`Spike frequent: ${s.spikePctFrequent}% → ${c.spikePctFrequent}%`);
  if(c.spikePctOnce!==s.spikePctOnce) logicChangelog.push(`Spike once: ${s.spikePctOnce}% → ${c.spikePctOnce}%`);
  if(showNetworkSections&&c.skuFloorDCMultMin!==s.skuFloorDCMultMin) logicChangelog.push(`SKU floor DC min mult: ${s.skuFloorDCMultMin} → ${c.skuFloorDCMultMin}`);
  if(showNetworkSections&&c.skuFloorDCMultMax!==s.skuFloorDCMultMax) logicChangelog.push(`SKU floor DC max mult: ${s.skuFloorDCMultMax} → ${c.skuFloorDCMultMax}`);
  if(showNetworkSections&&JSON.stringify(c.dcDeadMult)!==JSON.stringify(s.dcDeadMult)) logicChangelog.push(`Dead stock DC multiplier changed`);
  if(JSON.stringify(c.movIntervals)!==JSON.stringify(s.movIntervals)) logicChangelog.push(`Movement tag boundaries changed`);
  if(JSON.stringify(c.priceTiers)!==JSON.stringify(s.priceTiers)) logicChangelog.push(`Price tag boundaries changed`);
  if(showNetworkSections&&JSON.stringify(c.newDSList)!==JSON.stringify(s.newDSList)) logicChangelog.push(`New DS list changed`);
  if(showNetworkSections){const co=c.openingDSList??OPENING_DS_DEFAULT, so=s.openingDSList??OPENING_DS_DEFAULT;
   if(JSON.stringify(co)!==JSON.stringify(so)){
     const opened=so.filter(d=>!co.includes(d)), closed=co.filter(d=>!so.includes(d));
     if(opened.length) logicChangelog.push(`${opened.join(", ")} went LIVE (was Opening Shortly)`);
     if(closed.length) logicChangelog.push(`${closed.join(", ")} set to Opening Shortly`);
   }}
  if(showNetworkSections&&c.newDSFloorTopN!==s.newDSFloorTopN) logicChangelog.push(`New DS floor top N: ${s.newDSFloorTopN} → ${c.newDSFloorTopN}`);
  const blt={...DEFAULT_PARAMS.brandLeadTimeDays,...(c.brandLeadTimeDays||{})};
  const sblt=s.brandLeadTimeDays||{};
  if(blt._default!==sblt._default) logicChangelog.push(`Brand lead time default: ${sblt._default??2}D → ${blt._default}D`);
  [...new Set([...Object.keys(blt),...Object.keys(sblt)].filter(k=>k!=='_default'))].forEach(brand=>{
    if(blt[brand]!==sblt[brand]){
      if(!sblt[brand]) logicChangelog.push(`Lead time added: ${brand} = ${blt[brand]}D`);
      else if(!blt[brand]) logicChangelog.push(`Lead time removed: ${brand}`);
      else logicChangelog.push(`Lead time ${brand}: ${sblt[brand]}D → ${blt[brand]}D`);
    }
  });
  const pbp=c.percentileCover?.percentileByPrice||{},spbp=s.percentileCover?.percentileByPrice||{};
  ["Premium","High","Medium","Low","Super Low","No Price"].forEach(tag=>{if(pbp[tag]!==spbp[tag])logicChangelog.push(`PCT ${tag} percentile: ${spbp[tag]} → ${pbp[tag]}`);});
  const cdm=c.percentileCover?.coverDaysByMovement||{},scdm=s.percentileCover?.coverDaysByMovement||{};
  ["Super Fast","Fast","Moderate","Slow","Super Slow"].forEach(tier=>{if(cdm[tier]!==scdm[tier])logicChangelog.push(`PCT ${tier} cover days: ${scdm[tier]} → ${cdm[tier]}`);});
  const csC=c.categoryStrategies||{},scs=s.categoryStrategies||{};
  [...new Set([...Object.keys(csC),...Object.keys(scs)])].forEach(cat=>{const cv=csC[cat]||"standard",sv=scs[cat]||"standard";if(cv!==sv)logicChangelog.push(`${cat}: ${sv} → ${cv}`);});
  const bmd=c.baseMinDays||{},sbmd=s.baseMinDays||{};
  ["Super Fast","Fast","Moderate","Slow","Super Slow"].forEach(tier=>{if(bmd[tier]!==sbmd[tier])logicChangelog.push(`Base min days ${tier}: ${sbmd[tier]} → ${bmd[tier]}`);});
  const rw=c.recencyWt||{},srw=s.recencyWt||{};
  ["Super Fast","Fast","Moderate","Slow","Super Slow"].forEach(tier=>{if(rw[tier]!==srw[tier])logicChangelog.push(`Recency weight ${tier}: ${srw[tier]} → ${rw[tier]}`);});
  const fu=c.fixedUnitFloor||{},sfu=s.fixedUnitFloor||{};
  if(fu.orderQtyPercentile!==sfu.orderQtyPercentile)logicChangelog.push(`Fixed floor percentile: ${sfu.orderQtyPercentile} → ${fu.orderQtyPercentile}`);
  if(fu.maxMultiplier!==sfu.maxMultiplier)logicChangelog.push(`Fixed floor max multiplier: ${sfu.maxMultiplier} → ${fu.maxMultiplier}`);
  if(fu.maxAdditive!==sfu.maxAdditive)logicChangelog.push(`Fixed floor max additive: ${sfu.maxAdditive} → ${fu.maxAdditive}`);
  if((fu.minNZD??2)!==(sfu.minNZD??2))logicChangelog.push(`Fixed floor min order-days: ${sfu.minNZD??2} → ${fu.minNZD??2}`);
  if((fu.spikeCapMult??5)!==(sfu.spikeCapMult??5))logicChangelog.push(`Fixed floor spike cap: ${sfu.spikeCapMult??5}× → ${fu.spikeCapMult??5}×`);
  if(extraChangelog) logicChangelog.push(...extraChangelog);

  // ── Shared locals ──
  const pc=params.percentileCover||DEFAULT_PARAMS.percentileCover;
  const pbpC=pc.percentileByPrice||DEFAULT_PARAMS.percentileCover.percentileByPrice;
  const cdmC=pc.coverDaysByMovement||DEFAULT_PARAMS.percentileCover.coverDaysByMovement;
  const bltC={...DEFAULT_PARAMS.brandLeadTimeDays,...(params.brandLeadTimeDays||{})};
  const fuC=params.fixedUnitFloor||DEFAULT_PARAMS.fixedUnitFloor;
  const rw2C=params.recencyWt||RECENCY_WT_DEFAULT;
  const miC=params.movIntervals||[2,4,7,10];
  const ptC=params.priceTiers||[3000,1500,400,100];
  const bmdC=params.baseMinDays||BASE_MIN_DAYS_DEFAULT;
  const cats=[...new Set(Object.values(skuMaster).map(s=>s.category||"Unknown"))].sort();
  const configuredBrands=Object.keys(bltC).filter(k=>k!=="_default");
  const availableBrands=[...new Set(Object.values(skuMaster).map(s=>s.brand).filter(Boolean))].sort().filter(b=>!configuredBrands.includes(b));
  const capDays=params.pctDocCap??30;
  const capDaysLow=params.pctDocCapLow??60;
  const minNZD=params.pctMinNZD??2;
  const skuFloorMultMin=params.skuFloorDCMultMin??0.2;
  const skuFloorMultMax=params.skuFloorDCMultMax??0.3;

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>

      {/* ── CONFIRM MODAL ── */}
      {showLogicConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999}}>
          <div style={{background:HR.white,borderRadius:12,padding:28,maxWidth:440,width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
            <div style={{fontWeight:800,color:HR.text,fontSize:15,marginBottom:4}}>Apply Logic Changes?</div>
            <div style={{fontSize:12,color:HR.muted,marginBottom:16}}>This will recalculate Min/Max for all SKUs using the updated parameters.</div>
            <div style={{background:HR.surfaceLight,borderRadius:8,padding:"10px 14px",marginBottom:16,maxHeight:240,overflowY:"auto"}}>
              <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Changes</div>
              {logicChangelog.length===0
                ? <div style={{fontSize:11,color:HR.muted,fontStyle:"italic"}}>No tracked changes detected</div>
                : logicChangelog.map((msg,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:11,color:HR.text}}>
                    <span style={{color:HR.green,fontSize:13}}>•</span>{msg}
                  </div>
                ))
              }
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{setShowLogicConfirm(false);applyAndRun(params);}}
                style={{flex:1,background:HR.yellow,color:HR.black,border:"none",padding:"10px",borderRadius:7,cursor:"pointer",fontWeight:800,fontSize:13}}>
                ▶ Run Model
              </button>
              <button onClick={()=>setShowLogicConfirm(false)}
                style={{flex:1,background:HR.white,color:HR.muted,border:`1px solid ${HR.border}`,padding:"10px",borderRadius:7,cursor:"pointer",fontWeight:600,fontSize:13}}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PERIOD STRIP ── */}
      <div style={{background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8,padding:"12px 16px",display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
        <div style={{fontWeight:800,color:HR.text,fontSize:14,marginRight:4}}>Logic Tweaker</div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:HR.muted,fontWeight:600}}>Overall Period</span>
          <NumInput value={params.overallPeriod} min={15} max={90} step={1}
            onChange={v=>saveParams({...params,overallPeriod:v})}
            style={{width:64,fontWeight:700,color:"#0077A8"}}/>
          <span style={{fontSize:11,color:HR.muted}}>days</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:HR.muted,fontWeight:600}}>Recency Window</span>
          <NumInput value={params.recencyWindow} min={7} max={params.overallPeriod-1} step={1}
            onChange={v=>saveParams({...params,recencyWindow:v})}
            style={{width:64,fontWeight:700,color:"#0077A8"}}/>
          <span style={{fontSize:11,color:HR.muted}}>days</span>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          {hasChanges&&<button onClick={()=>setParams(savedParams)}
            style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"7px 14px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>
            ↩ Reset
          </button>}
          <button
            disabled={!hasChanges||applyDisabled}
            onClick={hasChanges&&!applyDisabled?()=>setShowLogicConfirm(true):undefined}
            style={{background:hasChanges&&!applyDisabled?HR.yellow:"#E5E5E5",color:hasChanges&&!applyDisabled?HR.black:"#999",border:"none",padding:"7px 20px",borderRadius:7,cursor:hasChanges&&!applyDisabled?"pointer":"not-allowed",fontSize:12,fontWeight:800,display:"flex",alignItems:"center",gap:6}}>
            {hasChanges?<><span>▶</span> Apply {logicChangelog.length>0?`(${logicChangelog.length} changes)`:""}</>:<><span>✓</span> Up to date</>}
          </button>
        </div>
      </div>

      {topSlot}

      {/* ── STRATEGY ROUTING (full width) ── */}
      <Section title="Category → Strategy Map" icon="📋" accent="#7C3AED"
        summary={Object.values(csC).filter(v=>v&&v!=="standard").length>0?`${Object.values(csC).filter(v=>v&&v!=="standard").length} non-standard`:"All standard"}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[cats.slice(0,Math.ceil(cats.length/2)),cats.slice(Math.ceil(cats.length/2))].map((half,col)=>(
            <div key={col} style={{...S.card,padding:0,overflow:"hidden"}}>
              <table style={S.table}>
                <thead><tr style={{background:HR.surfaceLight}}>
                  <th style={S.th}>Category</th>
                  <th style={{...S.th,textAlign:"center"}}>Strategy</th>
                </tr></thead>
                <tbody>
                  {half.map((cat,i)=>(
                    <React.Fragment key={cat}>
                      <tr style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{...S.td,fontWeight:600,fontSize:11}}>{cat}</td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <select value={csC[cat]||"standard"}
                            onChange={e=>{const v=e.target.value;const next={...csC};if(v==="standard")delete next[cat];else next[cat]=v;saveParams({...params,categoryStrategies:next});}}
                            style={{...S.input,fontSize:11,padding:"3px 6px",fontWeight:600,color:csC[cat]&&csC[cat]!=="standard"?"#7C3AED":HR.muted}}>
                            <option value="standard">Standard</option>
                            <option value="percentile_cover">Percentile Cover</option>
                            <option value="fixed_unit_floor">Fixed Unit Floor</option>
                            <option value="manual">Manual</option>
                            {cat === "Plywood, MDF & HDHMR" && (
                              <option value="network_design">Network Design</option>
                            )}
                            {showNetworkSections && cat === "Plywood, MDF & HDHMR" && (
                              <option value="network_design_v2">Network Design v2</option>
                            )}
                          </select>
                        </td>
                      </tr>
                      {showNetworkSections && cat === "Plywood, MDF & HDHMR" && (csC[cat] === "network_design" || csC[cat] === "network_design_v2") && (
                        <tr style={{background:"#F5F0FF"}}>
                          <td style={{...S.td,fontSize:10,color:HR.muted,paddingLeft:24}}>↳ Non-network brands (e.g. Merino)</td>
                          <td style={{...S.td,textAlign:"center"}}>
                            <select value={params.plywoodNonNetworkStrategy||"percentile_cover"}
                              onChange={e=>saveParams({...params,plywoodNonNetworkStrategy:e.target.value})}
                              style={{...S.input,fontSize:11,padding:"3px 6px",fontWeight:600,color:"#7C3AED"}}>
                              <option value="standard">Standard</option>
                              <option value="percentile_cover">Percentile Cover</option>
                              <option value="fixed_unit_floor">Fixed Unit Floor</option>
                            </select>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Section>

      {/* ── PRIMARY 2-COL GRID ── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,alignItems:"start"}}>

        {/* LEFT: PCT Strategy */}
        <Section title="Percentile Cover Params" icon="📊" accent="#7C3AED"
          summary={`P${pbpC["Medium"]||85} mid · ${cdmC["Moderate"]||1}d mod cover`}>
          <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Percentile by Price Tag</div>
          <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:12}}>
            <table style={S.table}>
              <thead><tr style={{background:HR.surfaceLight}}>
                <th style={S.th}>Price Tag</th>
                <th style={{...S.th,textAlign:"center"}}>Percentile</th>
              </tr></thead>
              <tbody>
                {["Premium","High","Medium","Low","Super Low","No Price"].map((tag,i)=>(
                  <tr key={tag} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                    <td style={{...S.td,fontWeight:600,fontSize:11}}><TagPill value={tag} colorMap={PRICE_TAG_COLORS}/></td>
                    <td style={{...S.td,textAlign:"center"}}>
                      <NumInput value={pbpC[tag]||90} min={50} max={99} step={1}
                        onChange={v=>saveParams({...params,percentileCover:{...pc,percentileByPrice:{...pbpC,[tag]:v}}})}
                        style={{width:64,fontWeight:700,color:"#7C3AED"}}/>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Cover Days by Movement</div>
          <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:12}}>
            <table style={S.table}>
              <thead><tr style={{background:HR.surfaceLight}}>
                <th style={S.th}>Movement</th>
                <th style={{...S.th,textAlign:"center"}}>Cover Days</th>
              </tr></thead>
              <tbody>
                {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tag,i)=>(
                  <tr key={tag} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                    <td style={{...S.td,fontSize:11}}><MovTag value={tag}/></td>
                    <td style={{...S.td,textAlign:"center"}}>
                      <NumInput value={cdmC[tag]||1} min={1} max={7} step={1}
                        onChange={v=>saveParams({...params,percentileCover:{...pc,coverDaysByMovement:{...cdmC,[tag]:v}}})}
                        style={{width:64,fontWeight:700,color:"#7C3AED"}}/>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Guards</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            {/* Premium / High block */}
            <div style={{...S.card,borderLeft:"3px solid #C0392B"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#C0392B",marginBottom:8}}>Premium &amp; High price SKUs</div>
              <div style={{fontSize:9,color:HR.muted,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em"}}>Min NZD for PCT</div>
              <NumInput value={minNZD} min={1} max={10} step={1}
                onChange={v=>saveParams({...params,pctMinNZD:v})}
                style={{width:"100%",fontWeight:700,color:"#C0392B",marginBottom:4}}/>
              <div style={{fontSize:9,color:HR.muted,marginBottom:10}}>NZD below this → falls back to Standard strategy</div>
              <div style={{fontSize:9,color:HR.muted,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em"}}>DOC Cap (days)</div>
              <NumInput value={capDays} min={0} max={90} step={1}
                onChange={v=>saveParams({...params,pctDocCap:v})}
                style={{width:"100%",fontWeight:700,color:"#C0392B",marginBottom:4}}/>
              <div style={{fontSize:9,color:HR.muted}}>Prevents capital lock-up on expensive SKUs · 0 = no cap</div>
            </div>
            {/* Medium / Low / Super Low / No Price block */}
            <div style={{...S.card,borderLeft:"3px solid #B8860B"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#B8860B",marginBottom:8}}>Medium / Low / Super Low / No Price SKUs</div>
              <div style={{fontSize:9,color:HR.muted,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em"}}>Min NZD for PCT</div>
              <div style={{fontSize:13,fontWeight:700,color:"#B8860B",marginBottom:4,padding:"5px 10px",background:"#FEF9E7",borderRadius:4,textAlign:"center"}}>1 (fixed — any sale uses PCT)</div>
              <div style={{fontSize:9,color:HR.muted,marginBottom:10}}>Cheap items stocked aggressively — hard to emergency-source</div>
              <div style={{fontSize:9,color:HR.muted,marginBottom:4,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em"}}>DOC Cap (days)</div>
              <NumInput value={capDaysLow} min={0} max={180} step={5}
                onChange={v=>saveParams({...params,pctDocCapLow:v})}
                style={{width:"100%",fontWeight:700,color:"#B8860B",marginBottom:4}}/>
              <div style={{fontSize:9,color:HR.muted}}>Higher cap acceptable — cheap stock ties up less capital · 0 = no cap</div>
            </div>
          </div>
        </Section>

        {/* RIGHT: DC Inputs */}
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <Section title={leadTimeLabel} icon="🚚" accent="#7C3AED"
            summary={`Default ${bltC._default||3}d · ${configuredBrands.length} brand override${configuredBrands.length!==1?"s":""}`}>
            <div style={{...S.card,marginBottom:10,padding:"12px 14px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontWeight:600,color:HR.text,fontSize:12}}>Default Lead Time (days)</div>
                <NumInput value={bltC._default||3} min={1} max={10} step={1}
                  onChange={v=>saveParams({...params,brandLeadTimeDays:{...bltC,_default:v}})}
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
                          <NumInput value={bltC[brand]||3} min={1} max={10} step={1}
                            onChange={v=>saveParams({...params,brandLeadTimeDays:{...bltC,[brand]:v}})}
                            style={{width:64,color:"#7C3AED",fontWeight:700}}/>
                        </td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <button onClick={()=>{const next={...bltC};delete next[brand];saveParams({...params,brandLeadTimeDays:next});}}
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
                <button onClick={()=>{const sel=document.getElementById("newLeadBrand");if(!sel?.value)return;saveParams({...params,brandLeadTimeDays:{...bltC,[sel.value]:3}});}}
                  style={{background:HR.green,color:HR.white,border:"none",padding:"7px 14px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>+ Add</button>
              </div>
            )}
          </Section>

          <Section title="Fixed Unit Floor Params" icon="📐" accent="#7C3AED"
            summary={`P${fuC.orderQtyPercentile||90} · ${fuC.maxMultiplier||1.5}× + ${fuC.maxAdditive||1} · ≥${fuC.minNZD??2}d · cap ${fuC.spikeCapMult??5}×`}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
              <div style={S.card}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Order Qty Percentile</div>
                <NumInput value={fuC.orderQtyPercentile||90} min={50} max={99} step={1}
                  onChange={v=>saveParams({...params,fixedUnitFloor:{...fuC,orderQtyPercentile:v}})}
                  style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
              </div>
              <div style={S.card}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Max Multiplier</div>
                <NumInput value={fuC.maxMultiplier||1.5} min={1} max={3} step={0.1}
                  onChange={v=>saveParams({...params,fixedUnitFloor:{...fuC,maxMultiplier:v}})}
                  style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
              </div>
              <div style={S.card}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Max Additive</div>
                <NumInput value={fuC.maxAdditive||1} min={0} max={5} step={1}
                  onChange={v=>saveParams({...params,fixedUnitFloor:{...fuC,maxAdditive:v}})}
                  style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
              </div>
              <div style={S.card}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Min Order-Days (Premium/High)</div>
                <NumInput value={fuC.minNZD??2} min={1} max={5} step={1}
                  onChange={v=>saveParams({...params,fixedUnitFloor:{...fuC,minNZD:v}})}
                  style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
                <div style={{fontSize:10,color:HR.muted,marginTop:4}}>Below → falls back to Standard. 1 = off.</div>
              </div>
              <div style={S.card}>
                <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Spike Cap (× median)</div>
                <NumInput value={fuC.spikeCapMult??5} min={0} max={20} step={1}
                  onChange={v=>saveParams({...params,fixedUnitFloor:{...fuC,spikeCapMult:v}})}
                  style={{width:"100%",fontWeight:700,color:"#7C3AED"}}/>
                <div style={{fontSize:10,color:HR.muted,marginTop:4}}>Clips outlier orders before P90. 0 = off.</div>
              </div>
            </div>
          </Section>
        </div>

      </div>{/* end primary 2-col */}

      {/* ── ADVANCED ACCORDION ── */}
      <div style={{border:`1px solid ${HR.border}`,borderRadius:8,overflow:"hidden"}}>
        <button onClick={()=>setAdvancedOpen(o=>!o)}
          style={{width:"100%",background:HR.surfaceLight,border:"none",padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontWeight:700,color:HR.muted,fontSize:13}}>
          <span>⚙ Advanced</span>
          <span style={{fontSize:11}}>{advancedOpen?"▲ Collapse":"▼ Expand"}</span>
        </button>
        {advancedOpen&&(
          <div style={{padding:16,display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,alignItems:"start"}}>

            {/* Left adv col */}
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <Section title="Base Min Days" icon="" accent={HR.yellowDark}
                summary={`SF:${bmdC["Super Fast"]} F:${bmdC["Fast"]} M:${bmdC["Moderate"]} Sl:${bmdC["Slow"]} SS:${bmdC["Super Slow"]}`}>
                <div style={{...S.card,padding:0,overflow:"hidden"}}>
                  <table style={S.table}>
                    <thead><tr style={{background:HR.surfaceLight}}>
                      <th style={S.th}>Movement</th>
                      <th style={{...S.th,textAlign:"center"}}>Base Min Days</th>
                    </tr></thead>
                    <tbody>
                      {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>(
                        <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                          <td style={S.td}><MovTag value={tier}/></td>
                          <td style={{...S.td,textAlign:"center"}}>
                            <NumInput value={bmdC[tier]??3} min={1} max={30} step={1}
                              onChange={v=>saveParams({...params,baseMinDays:{...bmdC,[tier]:v}})}
                              style={{width:72,color:MOV_COLORS[tier],fontWeight:700}}/>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
              <Section title="Recency Weights" icon="" accent="#0077A8"
                summary={`SF:${rw2C["Super Fast"]} F:${rw2C["Fast"]} M:${rw2C["Moderate"]}`}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}>
                    <th style={S.th}>Movement</th>
                    <th style={{...S.th,textAlign:"center"}}>Weight</th>
                    <th style={{...S.th,color:HR.muted,fontSize:10,fontWeight:400}}>Formula</th>
                  </tr></thead>
                  <tbody>
                    {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{
                      const wt=rw2C[tier]||1;
                      return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={S.td}><MovTag value={tier}/></td>
                        <td style={{...S.td,textAlign:"center"}}>
                          <NumInput value={wt} min={0.5} max={5} step={0.25}
                            onChange={v=>saveParams({...params,recencyWt:{...rw2C,[tier]:v}})}
                            style={{width:72,color:MOV_COLORS[tier],fontWeight:700}}/>
                        </td>
                        <td style={{...S.td,fontSize:10,color:HR.muted}}>{`(L + R×${wt}) ÷ ${1+wt}`}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </Section>
              <Section title="Max Days Buffer & ABQ" icon="" accent={HR.yellowDark}
                summary={`Buffer: +${params.maxDaysBuffer}d · ABQ: ${params.abqMaxMultiplier}×`}>
                {[
                  {key:"maxDaysBuffer",label:"Max Days Buffer",desc:"Max = Min + (dailyAvg × buffer days)",min:1,max:10,step:1},
                  {key:"abqMaxMultiplier",label:"ABQ Max Multiplier",desc:"Max = CEILING(Min × X) for Slow low-price items",min:1,max:3,step:0.1}
                ].map(pm=>(
                  <div key={pm.key} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                      <div style={{fontWeight:600,color:HR.text,fontSize:12}}>{pm.label}</div>
                      <div style={{fontWeight:800,color:HR.yellowDark,fontSize:18}}>{params[pm.key]}</div>
                    </div>
                    <div style={{fontSize:10,color:HR.muted,marginBottom:6}}>{pm.desc}</div>
                    <TierSlider label="" value={params[pm.key]} min={pm.min} max={pm.max} step={pm.step}
                      onChange={v=>saveParams({...params,[pm.key]:v})}/>
                  </div>
                ))}
              </Section>
              <Section title="Spike Parameters" icon="" accent={HR.yellowDark}
                summary={`${params.spikeMultiplier}× · ${params.spikePctFrequent}% frequent`}>
                {[
                  {key:"spikeMultiplier",label:"Spike Definition",desc:"Day qty > X × daily avg = spike",min:1,max:20,step:1},
                  {key:"spikePctFrequent",label:"Frequent Spike (%)",desc:"Spike days ≥ X% of period = Frequent",min:1,max:50,step:1},
                  {key:"spikePctOnce",label:"Once-in-a-while (%)",desc:"Spike days ≥ X% of period = Once in a while",min:1,max:20,step:1}
                ].map(pm=>(
                  <div key={pm.key} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                      <div style={{fontWeight:600,color:HR.text,fontSize:12}}>{pm.label}</div>
                      <div style={{fontWeight:800,color:HR.yellowDark,fontSize:18}}>{params[pm.key]}</div>
                    </div>
                    <div style={{fontSize:10,color:HR.muted,marginBottom:6}}>{pm.desc}</div>
                    <TierSlider label="" value={params[pm.key]} min={pm.min} max={pm.max} step={pm.step}
                      onChange={v=>saveParams({...params,[pm.key]:v})}/>
                  </div>
                ))}
              </Section>
            </div>

            {/* Right adv col */}
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <Section title="Movement Tag Boundaries" icon="" accent={HR.yellowDark}
                summary={`≤${miC[0]}d / ≤${miC[1]}d / ≤${miC[2]}d / ≤${miC[3]}d`}>
                {[0,1,2,3].map(i=>{
                  const labels=["Super Fast | Fast","Fast | Moderate","Moderate | Slow","Slow | Super Slow"];
                  const lo=i===0?1:miC[i-1]+1,hi=i===3?30:miC[i+1]-1;
                  return <TierSlider key={i} label={labels[i]} value={miC[i]} min={lo} max={hi}
                    color={["#16a34a","#2D7A3A","#B8860B","#C05A00"][i]}
                    onChange={v=>{const next=[...miC];next[i]=v;saveParams({...params,movIntervals:next});}}/>;
                })}
              </Section>
              <Section title="Price Tag Boundaries" icon="" accent={HR.yellowDark}
                summary={`₹${ptC[0]} / ₹${ptC[1]} / ₹${ptC[2]} / ₹${ptC[3]}`}>
                {[0,1,2,3].map(i=>{
                  const labels=["Premium | High","High | Medium","Medium | Low","Low | Super Low"];
                  const lo=i===3?1:ptC[i+1]+1,hi=i===0?50000:ptC[i-1]-1;
                  return <TierSlider key={i} label={labels[i]} value={ptC[i]} min={lo} max={hi}
                    color={["#B91C1C","#C2410C","#A16207","#475569"][i]}
                    onChange={v=>{const next=[...ptC];next[i]=v;saveParams({...params,priceTiers:next});}}/>;
                })}
              </Section>
              {showNetworkSections&&<>
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
                          style={{background:"none",border:"none",color:HR.yellowDark,cursor:"pointer",fontSize:13,padding:0}}>×</button>
                      </span>
                    ))}
                    {(params.newDSList||[]).length===0&&<span style={{color:HR.muted,fontSize:12}}>None</span>}
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
              {(()=>{
                const pc=params.pincodeConfig||{mode:"location",map:{}};
                const map=pc.map||{};
                const mapCount=Object.keys(map).length;
                const on=pc.mode==="shippingCode";
                // Coverage against the invoice data actually loaded, so the number
                // reflects what a re-run would really do — not the sheet in isolation.
                const cov=summariseCoverage(blrInvoice,map);
                const topMissing=cov.unmapped.slice(0,6);
                return (
              <Section title="Demand Attribution — which DS gets credited" icon="" accent="#7C3AED"
                summary={on?`Customer pincode · ${mapCount} pincodes mapped`:"Fulfilling location (default)"}>
                <div style={{...S.card,padding:"12px 14px"}}>
                  <div style={{fontSize:12,color:HR.text,marginBottom:10,lineHeight:1.5}}>
                    When a DS is out of stock the order is invoiced from another store. Crediting the{" "}
                    <b>fulfilling location</b> inflates that store's demand and hides the real need at the
                    customer's own DS. Crediting the <b>customer's pincode</b> attributes demand to the
                    catchment that actually generated it.
                    <br/>
                    Pincodes are resolved at model-run time from the stored shipping code, so switching
                    mode is a re-run — no CSV re-upload needed.
                  </div>
                  {["location","shippingCode"].map(m=>(
                    <label key={m} style={{display:"flex",alignItems:"center",gap:8,cursor:isAdmin?"pointer":"default",fontSize:13,fontWeight:600,color:HR.text,marginBottom:6}}>
                      <input type="radio" name="attributionMode" disabled={!isAdmin} checked={pc.mode===m||(m==="location"&&!pc.mode)}
                        onChange={()=>saveParams({...params,pincodeConfig:{...pc,mode:m}})}/>
                      {m==="location"?"Fulfilling location (Line Item Location Name)":"Customer pincode (Shipping Code)"}
                    </label>
                  ))}
                  <div style={{display:"flex",alignItems:"center",gap:10,marginTop:10,paddingTop:10,borderTop:`1px solid ${HR.border}`}}>
                    <span style={{fontSize:12,fontWeight:600,color:HR.text}}>Pincode → DS mapping</span>
                    <span style={{fontSize:12,color:mapCount?HR.text:HR.muted}}>{mapCount?`${mapCount} pincodes`:"not uploaded"}</span>
                    {isAdmin&&(
                      <label style={{background:HR.white,border:`1px solid ${HR.border}`,padding:"5px 12px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12,color:HR.text}}>
                        {uploading==="pincodeMap"?"Reading…":"Upload CSV"}
                        <input type="file" accept=".csv" style={{display:"none"}} onChange={handlePincodeMap}/>
                      </label>
                    )}
                  </div>
                  {mapCount>0&&(
                    <div style={{marginTop:8,fontSize:11,color:HR.muted,lineHeight:1.6}}>
                      Invoice rows carrying a shipping code: <b style={{color:HR.text}}>{cov.pinPct}%</b>
                      {" · "}of those, mapped to a DS:{" "}
                      {cov.coveragePct===null
                        ? <b style={{color:HR.muted}}>—</b>
                        : <b style={{color:cov.coveragePct>=99?HR.green:cov.coveragePct>=95?HR.yellowDark:HR.red}}>{cov.coveragePct.toFixed(1)}%</b>}
                      {cov.pinPct<100&&<div style={{color:HR.yellowDark,marginTop:4}}>
                        Rows without a shipping code keep their fulfilling location. Re-upload the invoice CSV with a Shipping Code column to attribute them.
                      </div>}
                      {topMissing.length>0&&<div style={{marginTop:4}}>
                        Unmapped pincodes: {topMissing.map(([p,c])=>`${p} (${c})`).join(", ")}
                        {Object.keys(missing).length>topMissing.length?` +${Object.keys(missing).length-topMissing.length} more`:""}
                        {" — these fall back to the fulfilling location."}
                      </div>}
                    </div>
                  )}
                  {on&&mapCount===0&&(
                    <div style={{marginTop:8,fontSize:11,color:HR.red,fontWeight:600}}>
                      Pincode mode is selected but no mapping is loaded — every row will fall back to its fulfilling location.
                    </div>
                  )}
                </div>
              </Section>
                );
              })()}
              <Section title="Store Status — Opening Shortly" icon="" accent={HR.yellowDark}
                summary={(()=>{const o=params.openingDSList??OPENING_DS_DEFAULT;return o.length?`${o.join(", ")} not trading yet`:"All stores trading";})()}>
                <div style={{...S.card,padding:"12px 14px"}}>
                  <div style={{fontSize:12,color:HR.text,marginBottom:10,lineHeight:1.5}}>
                    A store ticked here is wired everywhere — Zoho branch, stock sync, floor and ceiling
                    columns, plywood node — and still holds <b>Min = Max = 0</b> at every SKU. It is absent
                    from the TO tool and contributes no columns to the PO Team download, so a store can be
                    built weeks ahead without moving a single number. <b>Untick it to go live</b>; that is
                    the whole action.
                  </div>
                  {DS_LIST.map(ds=>{
                    const opening=(params.openingDSList??OPENING_DS_DEFAULT).includes(ds);
                    const mapped=Object.values((params.pincodeConfig||{}).map||{}).filter(d=>d===ds).length;
                    const inNewDS=(params.newDSList||[]).includes(ds);
                    return (
                      <div key={ds} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderTop:`1px solid ${HR.border}`}}>
                        <label style={{display:"flex",alignItems:"center",gap:8,cursor:isAdmin?"pointer":"default",fontSize:13,fontWeight:600,color:HR.text,minWidth:150}}>
                          <input type="checkbox" disabled={!isAdmin} checked={opening}
                            onChange={e=>{const cur=params.openingDSList??OPENING_DS_DEFAULT;
                              saveParams({...params,openingDSList:e.target.checked?[...new Set([...cur,ds])]:cur.filter(d=>d!==ds)});}}/>
                          {ds} <span style={{fontWeight:500,color:opening?HR.yellowDark:HR.muted}}>{opening?"Opening Shortly":"Trading"}</span>
                        </label>
                        <span style={{fontSize:11,color:HR.muted}}>{mapped} pincode{mapped===1?"":"s"} mapped</span>
                        {/* The two states that silently produce wrong numbers. Neither blocks —
                            both are legitimate mid-changeover, and a modal on Monday morning is
                            the last thing anyone needs. */}
                        {opening&&mapped>0&&(
                          <span style={{fontSize:11,fontWeight:700,color:"#B91C1C"}}>
                            ⚠ catchment mapped but not trading — that demand has left the donor stores and nothing is sized for it
                          </span>)}
                        {!opening&&mapped===0&&(
                          <span style={{fontSize:11,fontWeight:700,color:"#B91C1C"}}>
                            ⚠ trading with no catchment — targets will come from floors alone
                          </span>)}
                        {!opening&&!inNewDS&&(
                          <span style={{fontSize:11,color:"#A16207"}}>
                            not in New DS list — SKUs with no attributed demand get no floor
                          </span>)}
                      </div>
                    );
                  })}
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
                      <td style={S.td}><span style={{...TAG_STYLE,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}}>Dead Stock</span></td>
                      {["min","max"].map(field=>(
                        <td key={field} style={{...S.td,textAlign:"center"}}>
                          <NumInput value={(params.dcDeadMult||DC_DEAD_MULT_DEFAULT)[field]} min={0} max={1} step={0.05}
                            onChange={v=>saveParams({...params,dcDeadMult:{...(params.dcDeadMult||DC_DEAD_MULT_DEFAULT),[field]:v}})}
                            style={{width:72,color:"#B91C1C",fontWeight:700}}/>
                        </td>
                      ))}
                    </tr></tbody>
                  </table>
                </div>
              </Section>
              <Section title="SKU Floor DC Multipliers" icon="🏭" accent="#0077A8"
                summary={`Min ×${skuFloorMultMin} · Max ×${skuFloorMultMax}`}>
                <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>
                  For SKUs in the "SKU Floors - DS Level" CSV, DC Min/Max use these multipliers instead of the lead-time-based formula.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>DC Min Multiplier</div>
                    <NumInput value={skuFloorMultMin} min={0.05} max={1} step={0.05}
                      onChange={v=>saveParams({...params,skuFloorDCMultMin:v})}
                      style={{width:"100%",fontWeight:700,color:"#0077A8"}}/>
                  </div>
                  <div style={S.card}>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>DC Max Multiplier</div>
                    <NumInput value={skuFloorMultMax} min={0.05} max={1} step={0.05}
                      onChange={v=>saveParams({...params,skuFloorDCMultMax:v})}
                      style={{width:"100%",fontWeight:700,color:"#0077A8"}}/>
                  </div>
                </div>
              </Section>
              </>}
            </div>

          </div>
        )}
      </div>{/* end advanced */}

    </div>
  );
}
