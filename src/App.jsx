import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { loadFromSupabase, saveToSupabase } from "./supabase";

import {
  ROLLING_DAYS, DS_LIST,
  MOVEMENT_TIERS_DEFAULT,
  DC_MULT_DEFAULT, DC_DEAD_MULT_DEFAULT,
  RECENCY_WT_DEFAULT, BASE_MIN_DAYS_DEFAULT,
  DEFAULT_BRAND_BUFFER,
  DEFAULT_PARAMS,
} from "./engine/constants";
import { parseCSV, getPriceTag, getMovTag, getSpikeTag, computeStats, percentile, getInvSlice, aggStats } from "./engine/utils.js";

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
  "Zero Sale L90D":{bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
};
const TOPN_DISPLAY = { "T50":"Top 50","T150":"Top 150","T250":"Top 250","No":"Not Top","Zero Sale L90D":"Zero Sale L90D" };

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
function calcPeriodMinMax(stats,prTag,spTag,mvTag,abqMaxMult,maxDaysBuffer,baseMinDays){
  const bmd=baseMinDays||BASE_MIN_DAYS_DEFAULT,isSlow=["Slow","Super Slow"].includes(mvTag),lowPrice=["Low","Super Low","No Price"].includes(prTag);
  const base=bmd[mvTag]??3,useRatio=spTag==="Frequent"||spTag==="No Spike"||(["Once in a while","Rare"].includes(spTag)&&lowPrice);
  const baseMinQty=stats.dailyAvg*base,bufQty=maxDaysBuffer*stats.dailyAvg;
  let minQty=useRatio?Math.ceil(Math.max(baseMinQty,stats.spikeMedian)):Math.ceil(baseMinQty);
  let maxQty=useRatio?Math.ceil(Math.max(baseMinQty+bufQty,stats.spikeMedian+bufQty)):Math.ceil(baseMinQty+bufQty);
  if(isSlow&&["Medium","Low","Super Low"].includes(prTag)&&stats.abq>0){const abqCeil=Math.ceil(stats.abq);if(abqCeil>=minQty){minQty=Math.ceil(abqCeil);maxQty=Math.ceil(minQty*abqMaxMult);}}
  minQty=Math.ceil(minQty);maxQty=Math.ceil(Math.max(maxQty,minQty));
  return{minQty,maxQty};
}
function getDCStats(inv,skuId,activeDSCount,intervals,op){
  const nzd=Math.min(new Set(inv.filter(r=>r.sku===skuId&&r.qty>0).map(r=>r.date)).size,op);
  if(!nzd)return{mvTag:"Super Slow",nonZeroDays:0};
  const interval=op/nzd,dc=[...(intervals||MOVEMENT_TIERS_DEFAULT)].map(x=>x/activeDSCount);
  let mvTag="Super Slow";
  if(interval<=dc[0])mvTag="Super Fast";else if(interval<=dc[1])mvTag="Fast";else if(interval<=dc[2])mvTag="Moderate";else if(interval<=dc[3])mvTag="Slow";
  if(mvTag==="Fast")mvTag="Super Fast";
  return{mvTag,nonZeroDays:nzd};
}

function runEngine(inv,skuM,mrq,pd,deadStockSet,nsq,p){
  const op=p.overallPeriod||90,rw=Math.min(p.recencyWindow||15,op-1),recencyWt=p.recencyWt||RECENCY_WT_DEFAULT;
  const intervals=p.movIntervals||MOVEMENT_TIERS_DEFAULT,priceTiers=p.priceTiers||[3000,1500,400,100];
  const brandBuffer=p.brandBuffer||DEFAULT_BRAND_BUFFER,topN=p.newDSFloorTopN||150;
  const allDatesRaw=[...new Set(inv.map(r=>r.date))].sort(),allDates=allDatesRaw.slice(-op);
  const total=allDates.length,split=Math.max(0,total-rw),dLong=allDates.slice(0,split),dRecent=allDates.slice(split);
  const invSliced=inv.filter(r=>allDates.includes(r.date));
  const qMap={},oMap={};
  invSliced.forEach(r=>{const k=`${r.sku}||${r.ds}`;if(!qMap[k])qMap[k]={};if(!oMap[k])oMap[k]={};qMap[k][r.date]=(qMap[k][r.date]||0)+r.qty;oMap[k][r.date]=(oMap[k][r.date]||0)+1;});
  const skuTotals={};
  invSliced.forEach(r=>{skuTotals[r.sku]=(skuTotals[r.sku]||0)+r.qty;});
  const t150={};
  Object.entries(skuTotals).sort((a,b)=>b[1]-a[1]).forEach(([s],i)=>{t150[s]=i<50?"T50":i<150?"T150":i<250?"T250":"No";});
  Object.values(skuM).forEach(s=>{if((s.status||"").toLowerCase()==="active"&&!skuTotals[s.sku])t150[s.sku]="Zero Sale L90D";});
  const tags90={};
  [...new Set(invSliced.map(r=>r.sku))].forEach(skuId=>{
    DS_LIST.forEach(dsId=>{
      const k=`${skuId}||${dsId}`,qm=qMap[k]||{},om=oMap[k]||{};
      const q90=allDates.map(d=>qm[d]||0),o90=allDates.map(d=>om[d]||0);
      const s90=computeStats(q90,o90,op,p.spikeMultiplier);
      tags90[k]={mvTag:getMovTag(s90.nonZeroDays,op,intervals),spTag:getSpikeTag(s90.spikeDays,op,p.spikePctFrequent,p.spikePctOnce),dailyAvg:s90.dailyAvg,abq:s90.abq};
    });
  });
  const allSKUs=[...new Set([...invSliced.map(r=>r.sku),...Object.keys(skuM)])],activeDSCount=p.activeDSCount||4,res={};
  allSKUs.forEach(skuId=>{
    const meta=skuM[skuId]||{sku:skuId,name:skuId,category:"Unknown",brand:"",status:"Active",inventorisedAt:"DS"};
    const prTag=getPriceTag(pd[skuId]||0,priceTiers),t150Tag=t150[skuId]||"No",isDead=deadStockSet.has(skuId);
    const bufDays=brandBuffer[meta.brand]||0,hasBuf=bufDays>0,dsMinArr=[],dsMaxArr=[],stores={};
    DS_LIST.forEach(dsId=>{
      const k=`${skuId}||${dsId}`,qm=qMap[k]||{},om=oMap[k]||{};
      const qLong=dLong.map(d=>qm[d]||0),oLong=dLong.map(d=>om[d]||0);
      const qRecent=dRecent.map(d=>qm[d]||0),oRecent=dRecent.map(d=>om[d]||0);
      const q90=allDates.map(d=>qm[d]||0),o90=allDates.map(d=>om[d]||0);
      const hasData=q90.some(v=>v>0),isNewDS=(p.newDSList||[]).includes(dsId);
      const isEligible=(()=>{const rank=["T50","T150","T250"].indexOf(t150Tag);if(rank===-1)return false;return[50,150,250][rank]<=topN;})();

      // ── NO DATA PATH ──────────────────────────────────────────────────────
      if(!hasData){
        if(isNewDS){
          let nm=isEligible?(mrq[skuId]||0):0,nx=isEligible?nm:0;
          let logicTag="Base Logic";
          if(isEligible&&nm>0) logicTag="New DS Floor";
          if(nsq&&nsq[skuId]){
            const q=nsq[skuId][dsId]||0;
            if(q>0){nm=Math.max(nm,q);nx=nm;logicTag="New SKU Floor";}
          }
          if(isDead)nx=nm;
          stores[dsId]={min:nm,max:nx,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike",logicTag};
          dsMinArr.push(nm);dsMaxArr.push(nx);
        }else if(nsq&&nsq[skuId]){
          const q=nsq[skuId][dsId]||0;
          const logicTag=q>0?"New SKU Floor":"Base Logic";
          stores[dsId]={min:q,max:q,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike",logicTag};
          dsMinArr.push(q);dsMaxArr.push(q);
        }else{
          stores[dsId]={min:0,max:0,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike",logicTag:"Base Logic"};
        }
        return;
      }

      // ── HAS DATA PATH ─────────────────────────────────────────────────────
      const sLong=computeStats(qLong,oLong,op-rw,p.spikeMultiplier),sRecent=computeStats(qRecent,oRecent,rw,p.spikeMultiplier);
      const s90=computeStats(q90,o90,op,p.spikeMultiplier);
      const mvTagLong=getMovTag(sLong.nonZeroDays,op-rw,intervals),spTagLong=getSpikeTag(sLong.spikeDays,op-rw,p.spikePctFrequent,p.spikePctOnce);
      const mvTagRecent=getMovTag(sRecent.nonZeroDays,rw,intervals),spTagRecent=getSpikeTag(sRecent.spikeDays,rw,p.spikePctFrequent,p.spikePctOnce);
      const mvTag90=tags90[k].mvTag,wt=recencyWt[mvTag90]||1;
      const rLong=calcPeriodMinMax(sLong,prTag,spTagLong,mvTagLong,p.abqMaxMultiplier,p.maxDaysBuffer,p.baseMinDays);
      const rRecent=calcPeriodMinMax(sRecent,prTag,spTagRecent,mvTagRecent,p.abqMaxMultiplier,p.maxDaysBuffer,p.baseMinDays);
      let minQty=Math.ceil((rLong.minQty+rRecent.minQty*wt)/(1+wt)),maxQty=Math.ceil((rLong.maxQty+rRecent.maxQty*wt)/(1+wt));

      // Track what wins — start assuming base logic
      let logicTag="Base Logic";

      // New DS floor — only wins if floor actually exceeds the blend
      if(isNewDS&&isEligible){
        const floor=mrq[skuId]||0;
        if(floor>minQty){minQty=floor;maxQty=floor;logicTag="New DS Floor";}
        else maxQty=Math.max(maxQty,minQty);
      }

      // Brand buffer — physically overwrites minQty/maxQty, so it always wins
      // (unless NSQ later overrides it further — checked below)
      if(hasBuf){
        const dohMin=s90.dailyAvg>0?minQty/s90.dailyAvg:0;
        minQty=Math.ceil((dohMin+bufDays)*s90.dailyAvg);
        maxQty=minQty;
        logicTag="Brand Buffer";
      }

      minQty=Math.ceil(minQty);maxQty=Math.ceil(Math.max(maxQty,minQty));
      if(isDead)maxQty=minQty;maxQty=Math.max(maxQty,minQty);if(isDead)maxQty=minQty;

      // NSQ — runs last, wins if it raises minQty above everything so far
      if(nsq&&nsq[skuId]){
        const q=nsq[skuId][dsId]||0;
        if(q>minQty){minQty=q;maxQty=minQty;logicTag="New SKU Floor";}
      }

      stores[dsId]={min:Math.round(minQty),max:Math.round(maxQty),dailyAvg:s90.dailyAvg,abq:s90.abq,mvTag:mvTag90,spTag:tags90[k].spTag,logicTag};
      dsMinArr.push(Math.round(minQty));dsMaxArr.push(Math.round(maxQty));
    });
    const sumMin=dsMinArr.reduce((a,b)=>a+b,0),sumMax=dsMaxArr.reduce((a,b)=>a+b,0);
    const dcStats=getDCStats(invSliced,skuId,activeDSCount,intervals,op);
    const dcDeadMult=p.dcDeadMult||DC_DEAD_MULT_DEFAULT,dcM=isDead?dcDeadMult:(p.dcMult||DC_MULT_DEFAULT)[dcStats.mvTag]||DC_MULT_DEFAULT[dcStats.mvTag];
    res[skuId]={meta:{...meta,priceTag:prTag,t150Tag},stores,dc:{min:Math.round(sumMin*dcM.min),max:Math.round(sumMax*dcM.max),mvTag:dcStats.mvTag,nonZeroDays:dcStats.nonZeroDays}};
  });
  return res;
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

const COL_ITEM_W  = 150;
const COL_CAT_W   = 90;
const COL_PRICE_W = 72;
const COL_TOPN_W  = 76;
const COL_LOGIC_W = 90;
const FROZEN_TOTAL = COL_ITEM_W + COL_CAT_W + COL_PRICE_W + COL_TOPN_W + COL_LOGIC_W;

const frozenTh=(extra={})=>({...S.th,position:"sticky",top:0,zIndex:4,background:HR.surfaceLight,...extra});
const frozenTd=(left,bg,extra={})=>({...S.td,position:"sticky",left,background:bg,zIndex:2,...extra});

const LOGIC_TAG_STYLES={
  "Base Logic":     {bg:"#DCFCE7",color:"#15803D",border:"#BBF7D0"},
  "New DS Floor":   {bg:"#DBEAFE",color:"#1D4ED8",border:"#BFDBFE"},
  "New SKU Floor":  {bg:"#EDE9FE",color:"#6D28D9",border:"#C4B5FD"},
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

const DSCols=React.memo(({r,displayDS,coreOverrides})=>displayDS.map(ds=>{
  const s=r.stores[ds]||{min:0,max:0,dailyAvg:0,abq:0,mvTag:"—",logicTag:"Base Logic"};
  const di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];
  const logicTag=coreOverrides?.[r.meta?.sku]?.[ds]?"Manual Override":(s.logicTag||"Base Logic");
  return[
    <td key={ds+"mv"} style={{padding:"3px 6px",borderTop:`1px solid ${HR.border}`,textAlign:"center",background:dc.bg,borderLeft:`1px solid ${dc.header}22`}}>
      <div style={{display:"flex",flexDirection:"column",gap:2,alignItems:"center"}}>
        <MovTag value={s.mvTag}/>
        <LogicTag value={logicTag}/>
      </div>
    </td>,
    <td key={ds+"da"} style={{padding:"3px 6px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontSize:10,background:dc.bg}}>{s.dailyAvg>0?s.dailyAvg.toFixed(1):"—"}</td>,
    <td key={ds+"ab"} style={{padding:"3px 6px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontSize:10,background:dc.bg}}>{s.abq>0?s.abq.toFixed(1):"—"}</td>,
    <td key={ds+"mn"} style={{padding:"3px 6px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg}}>{s.min}</td>,
    <td key={ds+"mx"} style={{padding:"3px 6px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg}}>{s.max}</td>,
];
}));

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

function parseQACSV(text){try{return parseCSV(text);}catch(e){return[];}}
function buildDiff(qaRows,results){
  const diffs=[];
  qaRows.forEach(row=>{
    const sku=(row["SKU"]||row["sku"]||"").trim();
    if(!sku||!results[sku])return;
    const r=results[sku];
    DS_LIST.forEach(ds=>{
      const sMin=parseFloat(row[`${ds} Min`]||0),sMax=parseFloat(row[`${ds} Max`]||0);
      const tMin=r.stores[ds]?.min??0,tMax=r.stores[ds]?.max??0,dMin=tMin-sMin,dMax=tMax-sMax;
      if(dMin!==0||dMax!==0)diffs.push({sku,ds,sheetMin:sMin,sheetMax:sMax,toolMin:tMin,toolMax:tMax,dMin,dMax,mvTag:r.stores[ds]?.mvTag||"—",spTag:r.stores[ds]?.spTag||"—",prTag:r.meta.priceTag||"—",t150:r.meta.t150Tag||"—",brand:r.meta.brand||"—"});
    });
    const sDCMin=parseFloat(row["DC Min"]||0),sDCMax=parseFloat(row["DC Max"]||0),dMin=r.dc.min-sDCMin,dMax=r.dc.max-sDCMax;
    if(dMin!==0||dMax!==0)diffs.push({sku,ds:"DC",sheetMin:sDCMin,sheetMax:sDCMax,toolMin:r.dc.min,toolMax:r.dc.max,dMin,dMax,mvTag:r.dc.mvTag||"—",spTag:"—",prTag:r.meta.priceTag||"—",t150:r.meta.t150Tag||"—",brand:r.meta.brand||"—"});
  });
  diffs.sort((a,b)=>(Math.abs(b.dMin)+Math.abs(b.dMax))-(Math.abs(a.dMin)+Math.abs(a.dMax)));
  return diffs;
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
const MovDistBar=({rows,skuMaster,results,dsView})=>{
  const skus=[...new Set(rows.map(r=>r.sku))],counts={"Super Fast":0,"Fast":0,"Moderate":0,"Slow":0,"Super Slow":0};
  skus.forEach(s=>{const tag=(dsView&&dsView!=="All"&&dsView!=="Compare")?(results[s]?.stores[dsView]?.mvTag||"Super Slow"):(results[s]?.dc?.mvTag||"Super Slow");if(counts[tag]!==undefined)counts[tag]++;});
  const total=skus.length||1,movLabels=Object.keys(counts),movColors=["#16a34a","#2D7A3A","#B8860B","#C05A00","#C0392B"];
  return(
    <div style={{marginBottom:16}}>
      <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Movement Tag Distribution — {skus.length} SKUs</div>
      <div style={{display:"flex",gap:3,height:16,borderRadius:4,overflow:"hidden",border:`1px solid ${HR.border}`}}>
        {movLabels.map((l,i)=>{const pct=(counts[l]/total)*100;if(!pct)return null;return <div key={l} title={`${l}: ${counts[l]}`} style={{flex:pct,background:movColors[i]}}/>;})}</div>
      <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}>{movLabels.map((l,i)=><span key={l} style={{fontSize:10,color:movColors[i],fontWeight:700}}>{l}: {counts[l]}</span>)}</div>
    </div>
  );
};
const SingleFreqChart=({freq,ds,compact=false})=>{
  const entries=Object.entries(freq).map(([q,c])=>({qty:parseFloat(q),cnt:c})).sort((a,b)=>a.qty-b.qty);
  if(!entries.length)return <div style={{color:HR.muted,fontSize:11,padding:20,textAlign:"center"}}>No orders for {ds}</div>;
  const maxCnt=Math.max(...entries.map(e=>e.cnt)),padL=compact?32:44,padB=compact?28:36,padT=compact?16:20;
  const chartH=compact?100:180,barW=compact?Math.max(16,Math.min(40,Math.floor(220/entries.length))):Math.max(24,Math.min(60,Math.floor(480/entries.length)));
  const innerW=entries.length*(barW+4),svgW=Math.max(innerW+padL+16,compact?260:500),svgH=chartH+padB+padT;
  const di=DS_LIST.indexOf(ds),color=di>=0?DS_COLORS[di].header:HR.yellowDark;
  const totalOrders=entries.reduce((a,e)=>a+e.cnt,0),totalQty=entries.reduce((a,e)=>a+e.qty*e.cnt,0),abq=totalOrders>0?(totalQty/totalOrders).toFixed(1):"—";
  const yTicks=[0,1,2,3].map(i=>Math.round((maxCnt/3)*i));
  return(
    <div style={{background:HR.surface,borderRadius:8,padding:compact?8:14,border:`1px solid ${color}44`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:compact?4:8}}>
        <span style={{fontSize:compact?10:12,fontWeight:700,color}}>{ds}</span>
        {!compact&&<span style={{fontSize:10,color:HR.muted}}>{totalOrders} instances · ABQ {abq}</span>}
      </div>
      <div style={{overflowX:"auto"}}>
        <svg width={svgW} height={svgH} style={{display:"block"}}>
          {yTicks.map((tick,i)=>{const y=padT+chartH-(maxCnt>0?(tick/maxCnt)*chartH:0);return <g key={i}><line x1={padL} y1={y} x2={svgW-8} y2={y} stroke={i===0?"#C8C8B0":"#E8E8D8"} strokeWidth={i===0?1.5:1} strokeDasharray={i===0?"0":"3,3"}/><text x={padL-6} y={y+4} textAnchor="end" fill="#777760" fontSize={compact?8:10}>{tick}</text></g>;})}
          <text x={compact?10:14} y={padT+chartH/2} textAnchor="middle" fill="#777760" fontSize={compact?8:10} fontWeight="600" transform={`rotate(-90,${compact?10:14},${padT+chartH/2})`}>Orders</text>
          <line x1={padL} y1={padT} x2={padL} y2={padT+chartH} stroke="#A8A888" strokeWidth={1.5}/>
          <line x1={padL} y1={padT+chartH} x2={svgW-8} y2={padT+chartH} stroke="#A8A888" strokeWidth={1.5}/>
          {entries.map((e,i)=>{const barH=maxCnt>0?Math.max(2,(e.cnt/maxCnt)*chartH):2,x=padL+i*(barW+4)+2,y=padT+chartH-barH;return <g key={i}><rect x={x} y={y} width={barW} height={barH} fill={color} opacity={0.8} rx={2}/><text x={x+barW/2} y={y-4} textAnchor="middle" fill={color} fontSize={compact?8:10} fontWeight="700">{e.cnt}</text><text x={x+barW/2} y={padT+chartH+16} textAnchor="middle" fill="#555548" fontSize={compact?8:10} fontWeight="600">{e.qty}</text></g>;})}
          <text x={padL+innerW/2} y={svgH-2} textAnchor="middle" fill="#777760" fontSize={compact?8:10} fontWeight="600">Order Qty</text>
        </svg>
      </div>
    </div>
  );
};
const SKUFreqChart=({freqByDs,selectedDs})=>{
  const dsToShow=selectedDs==="Compare"?DS_LIST:selectedDs==="All"?DS_LIST:[selectedDs];
  if(selectedDs==="Compare")return <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>{dsToShow.map(ds=><SingleFreqChart key={ds} freq={freqByDs[ds]||{}} ds={ds} compact/>)}</div>;
  if(selectedDs==="All"){const merged={};dsToShow.forEach(ds=>{Object.entries(freqByDs[ds]||{}).forEach(([qty,cnt])=>{merged[qty]=(merged[qty]||0)+cnt;});});return <SingleFreqChart freq={merged} ds="All DS Combined"/>;}
  return <SingleFreqChart freq={freqByDs[selectedDs]||{}} ds={selectedDs}/>;
};
const PERIOD_OPTS=[{key:"90D",label:"90D"},{key:"75D",label:"75D (Long)"},{key:"15D",label:"15D (Recent)"}];
const DS_VIEW_OPTS=["All","DS01","DS02","DS03","DS04","DS05","Compare"];

function InsightsTab({
  invoiceData, skuMaster, results, params,
  period, setPeriod, customDays, setCustomDays,
  dsView, setDsView, drill, setDrill,
  catFilter, setCatFilter, globalSearch, setGlobalSearch,
}) {
  const rw = params.recencyWindow || 15;

  // Build the effective slice based on period
  const slice = useMemo(() => {
    if (period === "CUSTOM") {
      const allDates = [...new Set(invoiceData.map(r => r.date))].sort();
      const last = allDates.slice(-Math.min(customDays, 90));
      return invoiceData.filter(r => last.includes(r.date));
    }
    return getInvSlice(invoiceData, period, rw);
  }, [invoiceData, period, customDays, rw]);

  const sliceForDs = useMemo(
    () => dsView === "All" || dsView === "Compare" ? slice : slice.filter(r => r.ds === dsView),
    [slice, dsView]
  );
  const st = useMemo(() => aggStats(sliceForDs), [sliceForDs]);
  const skuCount = useMemo(() => [...new Set(sliceForDs.map(r => r.sku))].length, [sliceForDs]);

  const movCounts = useMemo(() => {
    const skus = [...new Set(sliceForDs.map(r => r.sku))];
    const counts = { "Super Fast": 0, "Fast": 0, "Moderate": 0, "Slow": 0, "Super Slow": 0 };
    skus.forEach(s => {
      const tag = (dsView && dsView !== "All" && dsView !== "Compare")
        ? (results[s]?.stores[dsView]?.mvTag || "Super Slow")
        : (results[s]?.dc?.mvTag || "Super Slow");
      if (counts[tag] !== undefined) counts[tag]++;
    });
    return counts;
  }, [sliceForDs, dsView, results]);

  // Global SKU search — jumps straight to SKU detail
  const allSKUs = useMemo(() => {
    const seen = new Set();
    return Object.values(skuMaster)
      .filter(s => { if (seen.has(s.sku)) return false; seen.add(s.sku); return true; })
      .map(s => ({ sku: s.sku, name: s.name || s.sku }));
  }, [skuMaster]);

  const searchResults = useMemo(() => {
    if (!globalSearch.trim()) return [];
    const q = globalSearch.toLowerCase();
    return allSKUs.filter(s =>
      s.sku.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [globalSearch, allSKUs]);

  const handleSearchSelect = skuId => {
    setGlobalSearch("");
    setDrill({ type: "sku", value: skuId, skuName: skuMaster[skuId]?.name || skuId,
      brand: skuMaster[skuId]?.brand || "", category: skuMaster[skuId]?.category || "" });
  };

  // Breadcrumb + back button
  const crumbs = [
    { label: "All Categories", onClick: () => { setDrill(null); setCatFilter(""); } },
    ...(drill?.type === "category" || drill?.type === "brand" || drill?.type === "sku"
      ? [{ label: drill.category || drill.value, onClick: () => setDrill({ type: "category", value: drill.category || drill.value, category: drill.category || drill.value }) }]
      : []),
    ...(drill?.type === "brand" || drill?.type === "sku"
      ? [{ label: drill.brand || drill.value, onClick: () => setDrill({ type: "brand", value: drill.brand || drill.value, brand: drill.brand || drill.value, category: drill.category }) }]
      : []),
    ...(drill?.type === "sku" ? [{ label: drill.skuName || drill.value }] : []),
  ];

  const handleBack = () => {
    if (!drill) return;
    if (drill.type === "sku")      setDrill({ type: "brand",    value: drill.brand,    brand: drill.brand,    category: drill.category });
    else if (drill.type === "brand")    setDrill({ type: "category", value: drill.category, category: drill.category });
    else if (drill.type === "category") { setDrill(null); setCatFilter(""); }
  };

  const movColors = ["#16a34a", "#2D7A3A", "#B8860B", "#C05A00", "#C0392B"];
  const movLabels = Object.keys(movCounts);
  const total = skuCount || 1;

  if (!invoiceData.length) return (
    <div style={{ textAlign: "center", padding: 80 }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
      <div style={{ color: HR.muted, fontSize: 14 }}>No data available</div>
    </div>
  );

  const periodLabel = period === "CUSTOM" ? `Last ${customDays}d` : period;

  return (
    <div>
      {/* ── Sticky control bar ── */}
      <div style={{ position: "sticky", top: -16, zIndex: 10, background: HR.bg, marginBottom: 12, paddingTop: 4, paddingBottom: 8, borderBottom: `1px solid ${HR.border}` }}>

        {/* Row 1 — period / DS / stats / search */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>

          {/* Period selector */}
<div style={{ display: "flex", gap: 0, border: `1px solid ${HR.border}`, borderRadius: 5, overflow: "visible", flexShrink: 0, position: "relative" }}>
  {[{ key: "90D", label: "90D" }, { key: "75D", label: "75D" }, { key: "15D", label: "15D" }].map(p => (
    <button key={p.key} onClick={() => setPeriod(p.key)}
      style={{ padding: "4px 10px", background: period === p.key ? HR.yellow : HR.white, color: period === p.key ? HR.black : HR.muted, border: "none", borderRight: `1px solid ${HR.border}`, cursor: "pointer", fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
      {p.label}
    </button>
  ))}
  <div style={{ position: "relative", display: "flex", alignItems: "stretch", cursor: "text" }}
    onClick={e => { e.currentTarget.querySelector("input")?.focus(); }}>
    <span style={{ position: "absolute", top: -11, left: "50%", transform: "translateX(-50%)", fontSize: 8, fontWeight: 500, color: period === "CUSTOM" ? "#C05A00" : HR.muted, letterSpacing: "0.6px", whiteSpace: "nowrap" }}>CUSTOM</span>
    <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "4px 10px", background: period === "CUSTOM" ? "#FFFBEA" : HR.white, borderLeft: `1px solid ${HR.border}`, borderRadius: "0 5px 5px 0" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: period === "CUSTOM" ? HR.yellowDark : HR.muted }}>Last</span>
<input type="number" min={1} max={90} value={customDays}
  onChange={e => { const v = Math.min(90, Math.max(1, parseInt(e.target.value) || 1)); setCustomDays(v); setPeriod("CUSTOM"); }}
  onFocus={e => { setPeriod("CUSTOM"); e.target.select(); }}
  style={{ width: 18, border: "none", background: "transparent", fontSize: 11, fontWeight: 700, color: period === "CUSTOM" ? HR.yellowDark : HR.muted, textAlign: "center", outline: "none", padding: 0, margin: 0, MozAppearance: "textfield" }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: period === "CUSTOM" ? HR.yellowDark : HR.muted }}>D</span>
    </div>
  </div>
</div>
            

          {/* DS selector */}
          <div style={{ display: "flex", gap: 0, border: `1px solid ${HR.border}`, borderRadius: 5, overflow: "hidden", flexShrink: 0 }}>
            {DS_VIEW_OPTS.map(d => {
              const di = DS_LIST.indexOf(d), col = di >= 0 ? DS_COLORS[di].header : HR.muted, isActive = dsView === d;
              return (
                <button key={d} onClick={() => setDsView(d)}
                  style={{ padding: "4px 9px", background: isActive ? (di >= 0 ? DS_COLORS[di].header : HR.yellow) : HR.white, color: isActive ? HR.white : col, border: "none", borderRight: `1px solid ${HR.border}`, cursor: "pointer", fontSize: 11, fontWeight: 700, lineHeight: 1.4 }}>
                  {d}
                </button>
              );
            })}
          </div>

          {/* Stats pills */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: 4 }}>
            {[
              { label: "SKUs", value: skuCount.toLocaleString(), color: HR.green },
              { label: "Instances", value: st.totalOrders.toLocaleString(), color: HR.yellowDark },
              { label: "Qty", value: st.totalQty.toLocaleString(), color: "#0077A8" },
              { label: "ABQ", value: st.avgOrderQty.toFixed(1), color: "#7A3DBF" },
            ].map(c => (
              <div key={c.label} style={{ background: HR.surface, border: `1px solid ${HR.border}`, borderRadius: 5, padding: "3px 10px", display: "flex", gap: 5, alignItems: "baseline" }}>
                <span style={{ fontWeight: 800, fontSize: 13, color: c.color }}>{c.value}</span>
                <span style={{ fontSize: 10, color: HR.muted }}>{c.label}</span>
              </div>
            ))}
          </div>

          {/* Global SKU search */}
          <div style={{ position: "relative", marginLeft: "auto" }}>
            <input
              placeholder="🔍 Search SKU or item name…"
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              style={{ ...S.input, width: 220, fontSize: 11, padding: "4px 10px" }}
            />
            {searchResults.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: HR.white, border: `1px solid ${HR.border}`, borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 20, marginTop: 2 }}>
                {searchResults.map(s => (
                  <div key={s.sku} onClick={() => handleSearchSelect(s.sku)}
                    style={{ padding: "7px 12px", cursor: "pointer", borderBottom: `1px solid ${HR.border}` }}
                    onMouseEnter={e => e.currentTarget.style.background = "#FFFBEA"}
                    onMouseLeave={e => e.currentTarget.style.background = HR.white}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: HR.text }}>{s.name}</div>
                    <div style={{ fontSize: 9, color: HR.muted }}>{s.sku}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Row 2 — movement bar + breadcrumb/back */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 260px", minWidth: 0 }}>
            <div style={{ display: "flex", gap: 2, height: 10, borderRadius: 3, overflow: "hidden", border: `1px solid ${HR.border}` }}>
              {movLabels.map((l, i) => { const pct = (movCounts[l] / total) * 100; if (!pct) return null; return <div key={l} title={`${l}: ${movCounts[l]}`} style={{ flex: pct, background: movColors[i] }} />; })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
              {movLabels.map((l, i) => movCounts[l] > 0 && <span key={l} style={{ fontSize: 9, color: movColors[i], fontWeight: 700 }}>{l.replace("Super ", "S.")}: {movCounts[l]}</span>)}
            </div>
          </div>

          {/* Back button + breadcrumb */}
          {drill && (
            <button onClick={handleBack}
              style={{ background: HR.white, border: `1px solid ${HR.border}`, borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontSize: 11, fontWeight: 700, color: HR.yellowDark, display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              ← Back
            </button>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {i > 0 && <span style={{ color: HR.muted, fontSize: 11 }}>›</span>}
                <span onClick={c.onClick} style={{ fontSize: 11, color: c.onClick ? HR.yellowDark : HR.text, cursor: c.onClick ? "pointer" : "default", fontWeight: i === crumbs.length - 1 ? 700 : 400, textDecoration: c.onClick ? "underline" : "none" }}>
                  {c.label}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Drill levels ── */}
      {!drill && (
        <OrgLevel
          slice={sliceForDs} skuMaster={skuMaster} results={results}
          dsView={dsView} catFilter={catFilter} setCatFilter={setCatFilter}
          onDrillCategory={cat => setDrill({ type: "category", value: cat, category: cat })}
        />
      )}
      {drill?.type === "category" && (
        <CategoryLevel slice={sliceForDs} skuMaster={skuMaster} results={results}
          category={drill.value} dsView={dsView}
          onDrillBrand={brand => setDrill({ type: "brand", value: brand, brand, category: drill.value })} />
      )}
      {drill?.type === "brand" && (
        <BrandLevel slice={sliceForDs} skuMaster={skuMaster} results={results}
          brand={drill.value} category={drill.category} dsView={dsView}
          onDrillSku={skuId => setDrill({ type: "sku", value: skuId, skuName: skuMaster[skuId]?.name || skuId, brand: drill.value, category: drill.category })} />
      )}
      {drill?.type === "sku" && (
        <SKULevel slice={sliceForDs} skuMaster={skuMaster} results={results} skuId={drill.value} dsView={dsView} />
      )}
    </div>
  );
}

function OrgLevel({ slice, skuMaster, results, dsView, catFilter, setCatFilter, onDrillCategory }) {
  const [localSearch, setLocalSearch] = useState("");
  const categories = useMemo(() => [...new Set(slice.map(r => skuMaster[r.sku]?.category || "Unknown"))].sort(), [slice, skuMaster]);

  const filtered = useMemo(() => {
    let cats = catFilter.trim()
      ? categories.filter(c => c.toLowerCase().includes(catFilter.toLowerCase()))
      : categories;
    if (localSearch.trim()) {
      const q = localSearch.toLowerCase();
      cats = cats.filter(c => {
        const catRows = slice.filter(r => (skuMaster[r.sku]?.category || "Unknown") === c);
        return catRows.some(r => r.sku.toLowerCase().includes(q) || (skuMaster[r.sku]?.name || "").toLowerCase().includes(q));
      });
    }
    return cats;
  }, [categories, catFilter, localSearch, slice, skuMaster]);

  return (
    <div>
      {/* Category filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
  <input
    placeholder="Search SKU or name..."
    value={localSearch} onChange={e => setLocalSearch(e.target.value)}
    style={{ ...S.input, fontSize: 11, padding: "4px 10px", width: 180 }}
  />
  <select
    value={catFilter}
    onChange={e => { setCatFilter(e.target.value); if (e.target.value) onDrillCategory(e.target.value); }}
    style={{ ...S.input, fontSize: 11, padding: "4px 8px", minWidth: 160 }}
  >
    <option value="">All Categories</option>
    {categories.map(c => <option key={c} value={c}>{c}</option>)}
  </select>
  {(catFilter || localSearch) && (
    <button onClick={() => { setCatFilter(""); setLocalSearch(""); }}
      style={{ background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
      ✕ Clear
    </button>
  )}
  <span style={{ fontSize: 11, color: HR.muted }}>{filtered.length} categories</span>
</div>

      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 8 }}>Drill into a Category</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
        {filtered.map(cat => {
          const catRows = slice.filter(r => (skuMaster[r.sku]?.category || "Unknown") === cat);
          const cs = aggStats(catRows);
          return (
            <div key={cat} onClick={() => onDrillCategory(cat)}
              style={{ ...S.card, cursor: "pointer", borderColor: HR.border }}
              onMouseEnter={e => e.currentTarget.style.borderColor = HR.yellow}
              onMouseLeave={e => e.currentTarget.style.borderColor = HR.border}>
              <div style={{ fontWeight: 700, color: HR.text, fontSize: 12, marginBottom: 4 }}>{cat}</div>
              <div style={{ fontSize: 10, color: HR.muted }}>{cs.skuCount} SKUs · {cs.totalOrders.toLocaleString()} instances</div>
              <div style={{ fontSize: 10, color: HR.muted }}>Qty: {cs.totalQty.toLocaleString()} · ABQ: {cs.avgOrderQty.toFixed(1)}</div>
              <div style={{ fontSize: 10, color: HR.yellowDark, marginTop: 4, fontWeight: 600 }}>Drill in →</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CategoryLevel({ slice, skuMaster, results, category, dsView, onDrillBrand }) {
  const [search, setSearch] = useState("");
  const catRows = slice.filter(r => (skuMaster[r.sku]?.category || "Unknown") === category);
  const st = aggStats(catRows);
  const brands = [...new Set(catRows.map(r => skuMaster[r.sku]?.brand || "Unknown"))].sort();

  const filteredBrands = useMemo(() =>
    search.trim()
      ? brands.filter(b => {
          // show brand if any of its SKUs match the search
          const skusInBrand = catRows.filter(r => (skuMaster[r.sku]?.brand || "Unknown") === b);
          return b.toLowerCase().includes(search.toLowerCase()) ||
            skusInBrand.some(r => r.sku.toLowerCase().includes(search.toLowerCase()) || (skuMaster[r.sku]?.name || "").toLowerCase().includes(search.toLowerCase()));
        })
      : brands,
    [brands, search, catRows, skuMaster]
  );

  return (
    <div>
      <StatStrip items={[
        { label: "Unique SKUs", value: st.skuCount, color: HR.green },
        { label: "Total Instances", value: st.totalOrders.toLocaleString(), color: HR.yellowDark },
        { label: "Total Qty", value: st.totalQty.toLocaleString(), color: "#0077A8" },
        { label: "Avg Order Qty", value: st.avgOrderQty.toFixed(1), color: "#7A3DBF" },
      ]} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input placeholder="Search brand or SKU…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...S.input, width: 220, fontSize: 11, padding: "4px 10px" }} />
        {search && <button onClick={() => setSearch("")} style={{ background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>✕</button>}
        <span style={{ fontSize: 11, color: HR.muted }}>{filteredBrands.length} brand{filteredBrands.length !== 1 ? "s" : ""}</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 8 }}>Drill into a Brand</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
        {filteredBrands.map(brand => {
          const bRows = catRows.filter(r => (skuMaster[r.sku]?.brand || "Unknown") === brand);
          const bs = aggStats(bRows);
          return (
            <div key={brand} onClick={() => onDrillBrand(brand)}
              style={{ ...S.card, cursor: "pointer", borderColor: HR.border }}
              onMouseEnter={e => e.currentTarget.style.borderColor = HR.yellow}
              onMouseLeave={e => e.currentTarget.style.borderColor = HR.border}>
              <div style={{ fontWeight: 700, color: HR.text, fontSize: 12, marginBottom: 4 }}>{brand}</div>
              <div style={{ fontSize: 10, color: HR.muted }}>{bs.skuCount} SKUs · {bs.totalOrders.toLocaleString()} instances</div>
              <div style={{ fontSize: 10, color: HR.muted }}>Qty: {bs.totalQty.toLocaleString()} · ABQ: {bs.avgOrderQty.toFixed(1)}</div>
              <div style={{ fontSize: 10, color: HR.yellowDark, marginTop: 4, fontWeight: 600 }}>Drill in →</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BrandLevel({ slice, skuMaster, results, brand, category, dsView, onDrillSku }) {
  const [search, setSearch] = useState("");
  const bRows = slice.filter(r =>
    (skuMaster[r.sku]?.brand || "Unknown") === brand &&
    (skuMaster[r.sku]?.category || "Unknown") === category
  );
  const st = aggStats(bRows);
  const skus = [...new Set(bRows.map(r => r.sku))].sort((a, b) => {
    const qa = bRows.filter(r => r.sku === a).reduce((s, r) => s + r.qty, 0);
    const qb = bRows.filter(r => r.sku === b).reduce((s, r) => s + r.qty, 0);
    return qb - qa;
  });

  const filteredSkus = useMemo(() =>
    search.trim()
      ? skus.filter(s => s.toLowerCase().includes(search.toLowerCase()) || (skuMaster[s]?.name || "").toLowerCase().includes(search.toLowerCase()))
      : skus,
    [skus, search, skuMaster]
  );

  return (
    <div>
      <StatStrip items={[
        { label: "SKUs", value: st.skuCount, color: HR.green },
        { label: "Total Instances", value: st.totalOrders.toLocaleString(), color: HR.yellowDark },
        { label: "Total Qty", value: st.totalQty.toLocaleString(), color: "#0077A8" },
        { label: "Avg Order Qty", value: st.avgOrderQty.toFixed(1), color: "#7A3DBF" },
      ]} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input placeholder="Search SKU or item name…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...S.input, width: 220, fontSize: 11, padding: "4px 10px" }} />
        {search && <button onClick={() => setSearch("")} style={{ background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA", padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>✕</button>}
        <span style={{ fontSize: 11, color: HR.muted }}>{filteredSkus.length} SKU{filteredSkus.length !== 1 ? "s" : ""}</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 8 }}>SKUs — click to see ordering behaviour</div>
      <div style={{ ...S.card, padding: 0, overflow: "auto", maxHeight: "50vh" }}>
        <table style={S.table}>
          <thead style={{ position: "sticky", top: 0 }}>
            <tr style={{ background: HR.surfaceLight }}>
              <th style={S.th}>SKU</th>
              <th style={{ ...S.th, textAlign: "center" }}>Movement</th>
              <th style={{ ...S.th, textAlign: "center" }}>Orders</th>
              <th style={{ ...S.th, textAlign: "center" }}>Total Qty</th>
              <th style={{ ...S.th, textAlign: "center" }}>ABQ</th>
              <th style={{ ...S.th, textAlign: "center" }}>Min</th>
              <th style={{ ...S.th, textAlign: "center" }}>Max</th>
            </tr>
          </thead>
          <tbody>
            {filteredSkus.map((skuId, i) => {
              const skuRows = bRows.filter(r => r.sku === skuId);
              const ss = aggStats(skuRows);
              const res = results[skuId];
              const mvTag = res ? Object.values(res.stores).find(s => s.mvTag !== "Super Slow")?.mvTag || "Super Slow" : "—";
              const dsMin = dsView === "All" || dsView === "Compare" ? DS_LIST.map(d => res?.stores[d]?.min || 0).reduce((a, b) => a + b, 0) : res?.stores[dsView]?.min || 0;
              const dsMax = dsView === "All" || dsView === "Compare" ? DS_LIST.map(d => res?.stores[d]?.max || 0).reduce((a, b) => a + b, 0) : res?.stores[dsView]?.max || 0;
              return (
                <tr key={skuId} style={{ background: i % 2 === 0 ? HR.white : HR.surfaceLight, cursor: "pointer" }}
                  onClick={() => onDrillSku(skuId)}>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600, color: HR.text, fontSize: 11 }}>{skuMaster[skuId]?.name || skuId}</div>
                    <div style={{ fontSize: 9, color: HR.muted }}>{skuId}</div>
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}><MovTag value={mvTag} /></td>
                  <td style={{ ...S.td, textAlign: "center", color: HR.yellowDark, fontWeight: 700 }}>{ss.totalOrders}</td>
                  <td style={{ ...S.td, textAlign: "center" }}>{ss.totalQty}</td>
                  <td style={{ ...S.td, textAlign: "center", color: "#7A3DBF", fontWeight: 600 }}>{ss.avgOrderQty.toFixed(1)}</td>
                  <td style={{ ...S.td, textAlign: "center", color: "#0077A8", fontWeight: 700 }}>{dsMin}</td>
                  <td style={{ ...S.td, textAlign: "center", color: "#0077A8", fontWeight: 700 }}>{dsMax}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SKULevel({ slice, skuMaster, results, skuId, dsView }) {
  const skuRows = slice.filter(r => r.sku === skuId);
  const meta = skuMaster[skuId] || {};
  const res = results[skuId];
  const st = aggStats(skuRows);
  const freqByDs = {};
  DS_LIST.forEach(ds => {
    const freq = {};
    skuRows.filter(r => r.ds === ds).forEach(r => { freq[r.qty] = (freq[r.qty] || 0) + 1; });
    freqByDs[ds] = freq;
  });
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
        <div>
          <h3 style={{ color: HR.yellowDark, margin: 0, fontSize: 14 }}>{meta.name || skuId}</h3>
          <div style={{ fontSize: 11, color: HR.muted, marginTop: 2 }}>{skuId} · {meta.category} · {meta.brand}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {res && <TagPill value={res.meta.priceTag} colorMap={PRICE_TAG_COLORS} />}
          {res && <TagPill value={res.meta.t150Tag} colorMap={TOPN_TAG_COLORS} />}
        </div>
      </div>
      <StatStrip items={[
        { label: "Total Instances", value: st.totalOrders, color: HR.yellowDark },
        { label: "Total Qty Sold", value: st.totalQty, color: "#0077A8" },
        { label: "Avg Order Qty (ABQ)", value: st.avgOrderQty.toFixed(1), color: "#7A3DBF" },
        { label: "Active Days", value: [...new Set(skuRows.map(r => r.date))].length, color: HR.green },
      ]} />
      {res && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 6, marginBottom: 16 }}>
          {DS_LIST.map((ds, di) => {
            const s = res.stores[ds] || { min: 0, max: 0, mvTag: "—", dailyAvg: 0 };
            const dc = DS_COLORS[di];
            return (
              <div key={ds} style={{ background: dc.bg, borderRadius: 8, padding: "8px 10px", border: `1px solid ${dc.header}44` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: dc.header, marginBottom: 3 }}>{ds}</div>
                <div style={{ fontSize: 10, color: HR.muted }}>Min <span style={{ color: dc.text, fontWeight: 700 }}>{s.min}</span> · Max <span style={{ color: dc.text, fontWeight: 700 }}>{s.max}</span></div>
                <div style={{ marginTop: 3 }}><MovTag value={s.mvTag} /></div>
                <div style={{ fontSize: 9, color: HR.muted, marginTop: 2 }}>Daily avg: {s.dailyAvg > 0 ? s.dailyAvg.toFixed(2) : "—"}</div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 12, fontWeight: 700, color: HR.text, marginBottom: 10 }}>Order Qty Frequency — X: order qty · Y: number of orders</div>
      <SKUFreqChart freqByDs={freqByDs} selectedDs={dsView} />
      {res && (
        <div style={{ ...S.card, marginTop: 12, borderColor: DC_COLOR.header + "44", background: DC_COLOR.bg }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: DC_COLOR.header, marginBottom: 4 }}>DC Level</div>
          <div style={{ fontSize: 11, color: HR.textSoft }}>
            Movement: <span style={{ color: DC_COLOR.text, fontWeight: 700 }}>{res.dc.mvTag}</span> · Non-Zero Days: <span style={{ color: DC_COLOR.text, fontWeight: 700 }}>{res.dc.nonZeroDays}</span> · Min: <span style={{ color: DC_COLOR.text, fontWeight: 700 }}>{res.dc.min}</span> · Max: <span style={{ color: DC_COLOR.text, fontWeight: 700 }}>{res.dc.max}</span>
          </div>
        </div>
      )}
    </div>
  );
}

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
              <input type="number" min={1} max={90} value={simDaysInput} onFocus={e => e.target.select()}
                onChange={e => setSimDaysInput(e.target.value)}
                onBlur={e => { const v=Math.min(90,Math.max(1,parseInt(e.target.value)||15)); setSimDaysInput(String(v)); setSimDays(v); setDrill(null); }}
                onKeyDown={e => { if(e.key==="Enter"){ const v=Math.min(90,Math.max(1,parseInt(e.target.value)||15)); setSimDaysInput(String(v)); setSimDays(v); setDrill(null); e.target.blur(); }}}
                style={{ width: 38, border: "none", background: "transparent", fontSize: 13, fontWeight: 800, color: HR.yellowDark, textAlign: "center", outline: "none", padding: "3px 2px", MozAppearance: "textfield" }}
              />
              <span style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, color: HR.yellowDark, borderLeft: `1px solid ${HR.yellow}`, whiteSpace: "nowrap" }}>days <span style={{ fontSize: 9, fontWeight: 500, color: HR.muted }}>(max 90)</span></span>
              <button onClick={() => { const v=Math.min(90,Math.max(1,parseInt(simDaysInput)||15)); setSimDaysInput(String(v)); setSimDays(v); setDrill(null); }}
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
function OverridesTab({ coreOverrides, saveCoreOverrides, priceData, results }) {
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("All");
  const [filterDS, setFilterDS] = useState("All");

  const allRows = useMemo(() => {
    const rows = [];
    Object.entries(coreOverrides).forEach(([sku, dsList]) => {
      Object.entries(dsList).forEach(([ds, ov]) => { rows.push({ sku, ds, ...ov }); });
    });
    return rows;
  }, [coreOverrides]);

  const categories = useMemo(() => ["All", ...new Set(allRows.map(r => r.category || "Unknown"))].sort(), [allRows]);
  const filtered = useMemo(() => allRows.filter(r => {
    if (filterCat !== "All" && (r.category || "Unknown") !== filterCat) return false;
    if (filterDS !== "All" && r.ds !== filterDS) return false;
    if (search && !r.sku.toLowerCase().includes(search.toLowerCase()) && !(r.skuName || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [allRows, filterCat, filterDS, search]);

  const overriddenSKUs = [...new Set(allRows.map(r => r.sku))];
  const toolMinVal = Math.round(overriddenSKUs.reduce((t, sku) => { const p = priceData[sku] || 0; return t + DS_LIST.reduce((s, ds) => s + (coreOverrides[sku]?.[ds]?.toolMin || 0) * p, 0); }, 0));
  const toolMaxVal = Math.round(overriddenSKUs.reduce((t, sku) => { const p = priceData[sku] || 0; return t + DS_LIST.reduce((s, ds) => s + (coreOverrides[sku]?.[ds]?.toolMax || 0) * p, 0); }, 0));
  const ovrMinVal  = Math.round(overriddenSKUs.reduce((t, sku) => { const p = priceData[sku] || 0; return t + DS_LIST.reduce((s, ds) => { const ov = coreOverrides[sku]?.[ds]; return s + (ov ? Math.max(ov.toolMin, ov.min) : 0) * p; }, 0); }, 0));
  const ovrMaxVal  = Math.round(overriddenSKUs.reduce((t, sku) => { const p = priceData[sku] || 0; return t + DS_LIST.reduce((s, ds) => { const ov = coreOverrides[sku]?.[ds]; return s + (ov ? Math.max(ov.toolMax, ov.max) : 0) * p; }, 0); }, 0));
  const deltaMin = ovrMinVal - toolMinVal, deltaMax = ovrMaxVal - toolMaxVal;

  const removeOverride = (sku, ds) => {
    const updated = { ...coreOverrides };
    if (updated[sku]) {
      updated[sku] = { ...updated[sku] };
      delete updated[sku][ds];
      if (Object.keys(updated[sku]).length === 0) delete updated[sku];
    }
    saveCoreOverrides(updated);
  };

  const th = (extra = {}) => ({ padding: "6px 10px", textAlign: "left", color: HR.muted, background: HR.surfaceLight, fontWeight: 600, whiteSpace: "nowrap", fontSize: 10, ...extra });
  const td = (extra = {}) => ({ padding: "5px 10px", borderTop: "1px solid #E0E0D0", verticalAlign: "middle", fontSize: 11, ...extra });

  if (!allRows.length) return (
    <div style={{ textAlign: "center", padding: 80 }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
      <div style={{ color: HR.muted, fontSize: 14 }}>No active overrides. Use the OOS Simulation tab to apply overrides to core.</div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h2 style={{ color: HR.yellowDark, margin: 0, fontSize: 15 }}>Active Core Overrides</h2>
        <span style={{ color: HR.muted, fontSize: 12 }}>Overrides are baked into core logic. Remove a row to revert to tool logic for that SKU×DS.</span>
      </div>

      {/* 4 KPI Cards — full width */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 12 }}>
        {[
          { label: "Tool Min Inv Value",      value: fmtInr(toolMinVal), sub: `${overriddenSKUs.length} overridden SKU${overriddenSKUs.length !== 1 ? "s" : ""}`, color: "#0077A8" },
          { label: "Override Min Inv Value",  value: fmtInr(ovrMinVal),  sub: `Delta: ${deltaMin >= 0 ? "+" : ""}${fmtInr(deltaMin)}`, color: deltaMin >= 0 ? "#C05A00" : HR.green, subColor: deltaMin >= 0 ? "#C05A00" : HR.green },
          { label: "Tool Max Inv Value",      value: fmtInr(toolMaxVal), sub: `${overriddenSKUs.length} overridden SKU${overriddenSKUs.length !== 1 ? "s" : ""}`, color: "#7A3DBF" },
          { label: "Override Max Inv Value",  value: fmtInr(ovrMaxVal),  sub: `Delta: ${deltaMax >= 0 ? "+" : ""}${fmtInr(deltaMax)}`, color: deltaMax >= 0 ? "#C05A00" : HR.green, subColor: deltaMax >= 0 ? "#C05A00" : HR.green },
        ].map(c => (
          <div key={c.label} style={{ background: HR.surface, borderRadius: 7, padding: "8px 12px", border: `1px solid ${HR.border}`, borderLeft: `3px solid ${c.color}` }}>
            <div style={{ fontSize: 9, color: HR.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 2 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c.color, lineHeight: 1.2 }}>{c.value}</div>
            <div style={{ fontSize: 10, color: c.subColor || HR.muted, marginTop: 2, fontWeight: c.subColor ? 700 : 400 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search SKU or item name..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 200 }} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...S.input, fontSize: 11, padding: "4px 8px" }}>
          {categories.map(c => <option key={c} value={c}>{c === "All" ? "All Categories" : c}</option>)}
        </select>
        <select value={filterDS} onChange={e => setFilterDS(e.target.value)} style={{ ...S.input, fontSize: 11, padding: "4px 8px" }}><option value="All">All Stores</option>{DS_LIST.map(d => <option key={d}>{d}</option>)}</select>
        <span style={{ fontSize: 11, color: HR.muted }}>{filtered.length} override{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Table — full width, grows naturally */}
      <div style={{ ...S.card, padding: 0, overflow: "auto" }}>
        <table style={{ ...S.table, minWidth: 900 }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
            <tr style={{ background: HR.surfaceLight }}>
              <th style={th({ minWidth: 180 })}>Item</th>
              <th style={th()}>Category</th>
              <th style={th()}>Brand</th>
              <th style={th()}>Movement</th>
              <th style={th()}>Price</th>
              <th style={th({ textAlign: "center" })}>DS</th>
              <th style={th({ textAlign: "center" })}>Tool Min</th>
              <th style={th({ textAlign: "center" })}>Tool Max</th>
              <th style={th({ textAlign: "center", background: "#FFFBEA" })}>Override Min</th>
              <th style={th({ textAlign: "center", background: "#FFFBEA" })}>Override Max</th>
              <th style={th({ textAlign: "center", background: "#FFFBEA" })}>Min Delta</th>
              <th style={th({ textAlign: "center", background: "#FFFBEA" })}>Max Delta</th>
              <th style={th()}>Applied Date</th>
              <th style={th()} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const p = priceData[r.sku] || 0;
              const finalMin = Math.max(r.toolMin, r.min), finalMax = Math.max(r.toolMax, r.max);
              const deltaMinRow = Math.round((finalMin - r.toolMin) * p), deltaMaxRow = Math.round((finalMax - r.toolMax) * p);
              const di = DS_LIST.indexOf(r.ds), dc = DS_COLORS[di >= 0 ? di : 0];
              const mvColor = MOV_COLORS[r.mvTag] || "#64748b";
              const priceC  = PRICE_TAG_COLORS[r.priceTag] || { bg: "#F1F5F9", color: "#64748B", border: "#CBD5E1" };
              return (
                <tr key={`${r.sku}||${r.ds}`} style={{ background: i % 2 === 0 ? HR.white : HR.surfaceLight }}>
                  <td style={td()}><div style={{ fontWeight: 700, color: HR.text, fontSize: 11 }}>{r.skuName || r.sku}</div><div style={{ fontSize: 9, color: HR.muted }}>{r.sku}</div></td>
                  <td style={{ ...td(), color: HR.muted, fontSize: 10 }}>{r.category || "—"}</td>
                  <td style={{ ...td(), color: HR.muted, fontSize: 10 }}>{r.brand || "—"}</td>
                  <td style={td()}><span style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: mvColor + "18", color: mvColor, border: `1px solid ${mvColor}33` }}>{r.mvTag || "—"}</span></td>
                  <td style={td()}><span style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: priceC.bg, color: priceC.color, border: `1px solid ${priceC.border}` }}>{r.priceTag || "—"}</span></td>
                  <td style={{ ...td(), textAlign: "center" }}><span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: dc.bg, color: dc.header, border: `1px solid ${dc.header}55` }}>{r.ds}</span></td>
                  <td style={{ ...td(), textAlign: "center", color: HR.muted }}>{r.toolMin}</td>
                  <td style={{ ...td(), textAlign: "center", color: HR.muted }}>{r.toolMax}</td>
                  <td style={{ ...td(), textAlign: "center", background: "#FFFDE7", fontWeight: 700, color: HR.yellowDark }}>{finalMin}</td>
                  <td style={{ ...td(), textAlign: "center", background: "#FFFDE7", fontWeight: 700, color: HR.yellowDark }}>{finalMax}</td>
                  <td style={{ ...td(), textAlign: "center", background: "#FFFDE7" }}><span style={{ fontWeight: 700, fontSize: 11, color: deltaMinRow >= 0 ? "#C05A00" : HR.green }}>{deltaMinRow >= 0 ? "+" : ""}{fmtInr(deltaMinRow)}</span></td>
                  <td style={{ ...td(), textAlign: "center", background: "#FFFDE7" }}><span style={{ fontWeight: 700, fontSize: 11, color: deltaMaxRow >= 0 ? "#C05A00" : HR.green }}>{deltaMaxRow >= 0 ? "+" : ""}{fmtInr(deltaMaxRow)}</span></td>
                  <td style={{ ...td(), color: HR.muted, fontSize: 10 }}>{r.appliedAt ? new Date(r.appliedAt).toLocaleDateString() : "—"}</td>
                  <td style={td()}><button onClick={() => removeOverride(r.sku, r.ds)} style={{ background: "#FEE2E2", color: "#B91C1C", border: "1px solid #FECACA", padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 700 }}>Remove</button></td>
                </tr>
              );
            })}
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
// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App(){
  const [tab,setTab]=useState("dashboard"),[pendingTab,setPending]=useState(null);
  const [invoiceData,setInv]=useState([]),[skuMaster,setSKU]=useState({});
  const [minReqQty,setMRQ]=useState({}),[newSKUQty,setNSQ]=useState({});
  const [deadStock,setDead]=useState(new Set()),[priceData,setPrice]=useState({});
  const [results,setResults]=useState(null),[loading,setLoading]=useState(false),[dataLoaded,setLoaded]=useState(false);
  const allUploaded=invoiceData.length>0&&Object.keys(skuMaster).length>0&&Object.keys(priceData).length>0&&Object.keys(minReqQty).length>0&&Object.keys(newSKUQty).length>0&&deadStock.size>0;
  const [filterDS,setFilterDS]=useState("All");
  const [filterCat,setFilterCat]=useState("");
  const [filterMov,setFilterMov]=useState("All");
  const [filterPriceTag,setFilterPriceTag]=useState("All");
  const [filterTopN,setFilterTopN]=useState("All");
  const [filterLogic,setFilterLogic]=useState("All");
  const [filterStatus,setFilterStatus]=useState("All");
  const [search,setSearch]=useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [catOpen,setCatOpen]=useState(false);
  const catRef=useRef(null);
  const [params,setParams]=useState(DEFAULT_PARAMS),[savedParams,setSaved]=useState(DEFAULT_PARAMS);
  const [newBrand,setNewBrand]=useState(""),[newBrandDays,setNBD]=useState(1);
  const [qaOpen,setQaOpen]=useState(false),[qaText,setQaText]=useState(""),[qaDiffs,setQaDiffs]=useState(null);
  const [qaFilterDS,setQaFDS]=useState("All"),[qaFilterMv,setQaFMv]=useState("All"),[qaFilterSp,setQaFSp]=useState("All"),[qaFilterPr,setQaFPr]=useState("All");
  const [isAdmin,setIsAdmin]=useState(()=>localStorage.getItem("adminSession")==="true");
  const [showLoginModal,setShowLoginModal]=useState(false);
  const [publishStatus,setPublishStatus]=useState(null);
  const [coreOverrides,setCoreOverrides]=useState({});
  const [simOverrides, setSimOverrides] = useState({});
  const [simOverrideCount, setSimOverrideCount] = useState(0);
  const [simResults, setSimResults] = useState({ tool: [], ovr: [] });
  const [simLoading, setSimLoading] = useState(true);
  const [simDays, setSimDays] = useState(15);
  const [syncStatus,setSyncStatus]=useState("idle"); // "idle" | "saving" | "saved" | "error"
  // ── Insights tab persistent state ──────────────────────────────────────────
  const [insightsPeriod,   setInsightsPeriod]   = useState("90D");
  const [insightsCustomD,  setInsightsCustomD]  = useState(30);
  const [insightsDsView,   setInsightsDsView]   = useState("All");
  const [insightsDrill,    setInsightsDrill]    = useState(null);
  const [insightsCatFilter,setInsightsCatFilter]= useState("");
  const [insightsSearch,   setInsightsSearch]   = useState("");
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

  const handleLogout=()=>{localStorage.removeItem("adminSession");setIsAdmin(false);setQaOpen(false);};

  const hasChanges=JSON.stringify(params)!==JSON.stringify(savedParams);
  const changedCount=[params.overallPeriod!==savedParams.overallPeriod,params.recencyWindow!==savedParams.recencyWindow,JSON.stringify(params.recencyWt)!==JSON.stringify(savedParams.recencyWt),JSON.stringify(params.movIntervals)!==JSON.stringify(savedParams.movIntervals),JSON.stringify(params.priceTiers)!==JSON.stringify(savedParams.priceTiers),params.spikeMultiplier!==savedParams.spikeMultiplier,params.spikePctFrequent!==savedParams.spikePctFrequent,params.spikePctOnce!==savedParams.spikePctOnce,params.maxDaysBuffer!==savedParams.maxDaysBuffer,params.abqMaxMultiplier!==savedParams.abqMaxMultiplier,JSON.stringify(params.baseMinDays)!==JSON.stringify(savedParams.baseMinDays),JSON.stringify(params.brandBuffer)!==JSON.stringify(savedParams.brandBuffer),JSON.stringify(params.newDSList)!==JSON.stringify(savedParams.newDSList),params.newDSFloorTopN!==savedParams.newDSFloorTopN,params.activeDSCount!==savedParams.activeDSCount,JSON.stringify(params.dcMult)!==JSON.stringify(savedParams.dcMult),JSON.stringify(params.dcDeadMult)!==JSON.stringify(savedParams.dcDeadMult)].filter(Boolean).length;

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
        setTab("dashboard");
      }catch(err){console.error(err);alert("Model error: "+err.message);}
      setLoading(false);
    },50);
  };

  // ── Publish: saves team data to Supabase (+ downloads JSON as backup) ───────
  const handlePublish=async()=>{
    setPublishStatus("saving");
    try{
      const bundle={invoiceData,skuMaster,minReqQty,newSKUQty,deadStock:[...deadStock],priceData,publishedAt:new Date().toISOString()};
      // Save to Supabase
      const ok = await saveToSupabase("team_data","global",bundle);
      if(ok){
        setPublishStatus("done");
        setTimeout(()=>setPublishStatus(null),8000);
      } else {
        throw new Error("Supabase save failed");
      }
      // Also download JSON as backup
      const blob=new Blob([JSON.stringify(bundle)],{type:"application/json"});
      const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="team-data.json";a.click();
    }catch(e){setPublishStatus("error");setTimeout(()=>setPublishStatus(null),5000);}
  };

  const handleInvoice=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;setLoading(true);
    const rows=parseCSV(await file.text());
    const newE=rows.filter(r=>["Closed","Overdue"].includes(r["Invoice Status"]||"")).map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0)})).filter(r=>r.date&&r.sku&&r.qty>0);
    const all=[...invoiceData,...newE],dates=[...new Set(all.map(r=>r.date))].sort();
    const cutoff=dates.length>ROLLING_DAYS?dates[dates.length-ROLLING_DAYS]:dates[0],filtered=all.filter(r=>r.date>=cutoff);
    setInv(filtered);LS.set("invoiceData",JSON.stringify(filtered));
    setLoading(false);
    e.target.value="";
  },[invoiceData,skuMaster,minReqQty,newSKUQty,deadStock,priceData,params]);

  const handleSKU=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;setLoading(true);
    const rows=parseCSV(await file.text());const master={};
    rows.forEach(r=>{const s=r["SKU"]||"";if(s)master[s]={sku:s,name:r["Name"]||"",category:r["Category"]||r["Category Name"]||"",brand:r["Brand"]||"",status:r["Status"]||"Active",inventorisedAt:r["Inventorised At"]||"DS"};});
    setSKU(master);LS.set("skuMaster",JSON.stringify(master));
    setLoading(false);
    e.target.value="";
  },[invoiceData,minReqQty,newSKUQty,deadStock,priceData,params]);

  const handleMRQ=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const mrq={};rows.forEach(r=>{if(r["SKU"])mrq[r["SKU"]]=parseFloat(r["Qty"]||0);});setMRQ(mrq);LS.set("minReqQty",JSON.stringify(mrq));e.target.value="";},[]);
  const handleNSQ=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const nsq={};rows.forEach(r=>{const s=r["SKU"]||"";if(!s)return;nsq[s]={};DS_LIST.forEach(ds=>{const v=parseFloat(r[ds]||0);if(v>0)nsq[s][ds]=v;});});setNSQ(nsq);LS.set("newSKUQty",JSON.stringify(nsq));e.target.value="";},[]);
  const handleDead=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const ds=new Set(rows.map(r=>r["Dead Stock"]||r["SKU"]||"").filter(Boolean));setDead(ds);LS.set("deadStock",JSON.stringify([...ds]));e.target.value="";},[]);
  const handlePrice=useCallback(async(e)=>{const file=e.target.files[0];if(!file)return;const rows=parseCSV(await file.text());const pd={};rows.forEach(r=>{const s=(r["sku"]||"").trim();const v=parseFloat(r["average_price"]||0);if(s&&v>0)pd[s]=v;});setPrice(pd);LS.set("priceData",JSON.stringify(pd));e.target.value="";},[]);

  const clearData=useCallback(async(key)=>{
    if(key==="invoiceData"){setInv([]);LS.delete("invoiceData");setLoaded(false);setResults(null);}
    if(key==="skuMaster"){setSKU({});LS.delete("skuMaster");setLoaded(false);setResults(null);}
    if(key==="priceData"){setPrice({});LS.delete("priceData");}
    if(key==="minReqQty"){setMRQ({});LS.delete("minReqQty");}
    if(key==="newSKUQty"){setNSQ({});LS.delete("newSKUQty");}
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
          setTab("dashboard");
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
  const runQA=()=>{if(!results||!qaText.trim()){alert("Upload data and run model first.");return;}const rows=parseQACSV(qaText);if(!rows.length){alert("Could not parse CSV.");return;}setQaDiffs(buildDiff(rows,results));setQaFDS("All");setQaFMv("All");setQaFSp("All");setQaFPr("All");};

  const soldSKUs=new Set(invoiceData.map(r=>r.sku));
  // trim + lowercase status check to handle trailing spaces / casing issues
  const activeMaster=Object.values(skuMaster).filter(s=>(s.status||"").trim().toLowerCase()==="active");
  const uniqueSold=[...soldSKUs].filter(s=>skuMaster[s]&&(skuMaster[s].status||"").trim().toLowerCase()==="active").length;
  const zeroSale=activeMaster.filter(s=>!soldSKUs.has(s.sku)).length;
  const dateRange=invoiceData.length>0?(()=>{const d=[...new Set(invoiceData.map(r=>r.date))].sort();return `${d[0]} → ${d[d.length-1]} (${d.length} days)`;})():"No data";
  const missing=[...soldSKUs].filter(s=>!skuMaster[s]||(skuMaster[s].status||"").trim().toLowerCase()!=="active");

  // ALL SKUs from master (all statuses) — so full 1920 shows when no status filter
  const allResultsWithSKU=useMemo(()=>{
    if(!dataLoaded)return[];
    return Object.values(skuMaster).map(sku=>{
      if(results&&results[sku.sku])return results[sku.sku];
      return{
        meta:{
          sku:sku.sku,name:sku.name||sku.sku,
          category:sku.category||"Unknown",brand:sku.brand||"",
          status:(sku.status||"").trim(),
          priceTag:getPriceTag(priceData[sku.sku]||0,params.priceTiers),
          t150Tag:"Zero Sale L90D",
        },
        stores:Object.fromEntries(DS_LIST.map(ds=>[ds,{min:0,max:0,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike",logicTag:"Base Logic"}])),
        dc:{min:0,max:0,mvTag:"Super Slow",nonZeroDays:0},
      };
    });
  },[skuMaster,results,dataLoaded,priceData,params.priceTiers]);const skusByCategory = useMemo(() => {
  const idx = {};
  allResultsWithSKU.forEach(r => {
    const cat = r.meta.category || "Unknown";
    if (!idx[cat]) idx[cat] = new Set();
    idx[cat].add(r.meta.sku);
  });
  return idx;
}, [allResultsWithSKU]);

const skusByMov = useMemo(() => {
  const idx = {};
  allResultsWithSKU.forEach(r => {
    const tag = r.dc?.mvTag || "Super Slow";
    if (!idx[tag]) idx[tag] = new Set();
    idx[tag].add(r.meta.sku);
  });
  return idx;
}, [allResultsWithSKU]);

  // Unique statuses for filter dropdown
  const allStatuses=useMemo(()=>["All",...new Set(Object.values(skuMaster).map(s=>(s.status||"").trim()).filter(Boolean))].sort(),[skuMaster]);

  // Autocomplete lists
  const allCategories=useMemo(()=>[...new Set(Object.values(skuMaster).map(s=>s.category||"Unknown"))].sort(),[skuMaster]);
  const suggestedCats=useMemo(()=>filterCat?allCategories.filter(c=>c.toLowerCase().includes(filterCat.toLowerCase())):allCategories,[filterCat,allCategories]);

  // Close dropdowns on outside click
  useEffect(()=>{
    const handler=e=>{
      if(catRef.current&&!catRef.current.contains(e.target))setCatOpen(false);
    };
    document.addEventListener("mousedown",handler);
    return()=>document.removeEventListener("mousedown",handler);
  },[]);

  const filtered = useMemo(() => {
  let candidates = allResultsWithSKU;
  if (filterCat) {
    const catSet = skusByCategory[filterCat] || new Set();
    candidates = candidates.filter(r => catSet.has(r.meta.sku));
  }
  if (filterMov !== "All") {
    const movSet = skusByMov[filterMov] || new Set();
    candidates = candidates.filter(r => movSet.has(r.meta.sku));
  }
  return candidates.filter(r => {
    if (debouncedSearch && !r.meta.sku.toLowerCase().includes(debouncedSearch.toLowerCase())
      && !r.meta.name.toLowerCase().includes(debouncedSearch.toLowerCase())) return false;
    if (filterCat && r.meta.category.toLowerCase() !== filterCat.toLowerCase()) return false;
    if (filterStatus !== "All" && (r.meta.status||"").trim() !== filterStatus) return false;
    if (filterPriceTag !== "All" && r.meta.priceTag !== filterPriceTag) return false;
    if (filterTopN !== "All" && r.meta.t150Tag !== filterTopN) return false;
    if (filterLogic !== "All") {
      const skuLogicTags = new Set(DS_LIST.map(ds =>
        coreOverrides[r.meta.sku]?.[ds] ? "Manual Override" : (r.stores[ds]?.logicTag || "Base Logic")
      ));
      if (!skuLogicTags.has(filterLogic)) return false;
    }
    return true;
  });
}, [allResultsWithSKU, skusByCategory, skusByMov, debouncedSearch,
    filterCat, filterStatus, filterPriceTag, filterTopN, filterMov, filterLogic, coreOverrides]);

    const [scrollTop, setScrollTop] = useState(0);
const ROW_HEIGHT = 44;
const VISIBLE_ROWS = 20;
const BUFFER = 5;

const visibleFiltered = useMemo(() => {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
  const end = Math.min(filtered.length, start + VISIBLE_ROWS + BUFFER * 2);
  return { rows: filtered.slice(start, end), startIndex: start };
}, [filtered, scrollTop]);
const outputRows = useMemo(() => results ? Object.values(results) : [], [results]);
const [outputScrollTop, setOutputScrollTop] = useState(0);
const visibleOutput = useMemo(() => {
  const ROW_HEIGHT_OUT = 36;
  const start = Math.max(0, Math.floor(outputScrollTop / ROW_HEIGHT_OUT) - 5);
  const end = Math.min(outputRows.length, start + 30);
  return { rows: outputRows.slice(start, end), startIndex: start };
}, [outputRows, outputScrollTop]);  
const displayDS=filterDS==="All"?DS_LIST:[filterDS];

  // Frozen column widths — add Status col
  const COL_STATUS_W=64;
  const FROZEN_COLS_LEFT={
    item:0,
    cat:COL_ITEM_W,
    status:COL_ITEM_W+COL_CAT_W,
    price:COL_ITEM_W+COL_CAT_W+COL_STATUS_W,
    topn:COL_ITEM_W+COL_CAT_W+COL_STATUS_W+COL_PRICE_W,
  };

  const qaDS=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.ds))]:["All"];
  const qaMv=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.mvTag))]:["All"];
  const qaSp=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.spTag))]:["All"];
  const qaPr=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.prTag))]:["All"];
  const qaFiltered=qaDiffs?qaDiffs.filter(d=>(qaFilterDS==="All"||d.ds===qaFilterDS)&&(qaFilterMv==="All"||d.mvTag===qaFilterMv)&&(qaFilterSp==="All"||d.spTag===qaFilterSp)&&(qaFilterPr==="All"||d.prTag===qaFilterPr)):[];

  const mi=params.movIntervals||[2,4,7,10],pt=params.priceTiers||[3000,1500,400,100],bb=params.brandBuffer||DEFAULT_BRAND_BUFFER;
  const rw2=params.recencyWt||RECENCY_WT_DEFAULT,dcM=params.dcMult||DC_MULT_DEFAULT;
  const movColors=["#16a34a","#2D7A3A","#B8860B","#C05A00","#C0392B"],priceColors=["#B91C1C","#C2410C","#A16207","#475569","#64748B"];

  const ADMIN_TABS=[["dashboard","Dashboard"],["insights","SKU Order Behaviour"],,["simulation","OOS Simulation"],["output","Tool Output Download"],["upload","Upload Data"],["logic","Logic Tweaker"],["overrides","Manual Overrides"]];
  const PUBLIC_TABS=[["dashboard","Dashboard"],["insights","SKU Order Behaviour"],,["simulation","OOS Simulation"],["output","Tool Output Download"]];
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
        <div style={{fontSize:10,color:HR.muted,marginLeft:4}}>{dateRange}</div>
        <SyncBadge/>
        <div style={{flex:1}}/>
        {NAV_TABS.map(([t,l])=><button key={t} onClick={()=>handleTabClick(t)} style={S.btn(tab===t)}>{l}</button>)}
        {isAdmin&&<button onClick={()=>setQaOpen(o=>!o)} style={{...S.btn(qaOpen),fontSize:11}}>🔬 QA</button>}
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

      {isAdmin&&qaOpen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:900,display:"flex",flexDirection:"column",padding:20,gap:12,overflow:"auto"}}>
          <div style={{background:HR.white,borderRadius:10,padding:20,flex:1,overflow:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.15)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <span style={{color:HR.yellowDark,fontWeight:800,fontSize:16}}>🔬 QA Mode</span>
              <button onClick={()=>setQaOpen(false)} style={{background:HR.white,border:`1px solid ${HR.border}`,color:HR.muted,padding:"5px 14px",borderRadius:5,cursor:"pointer",fontSize:12}}>Close</button>
            </div>
            {!qaDiffs?(
              <div style={{maxWidth:800}}>
                <div style={{fontWeight:700,color:HR.text,marginBottom:3,fontSize:13}}>Paste your sheet's Min/Max CSV output below</div>
                <div style={{fontSize:11,color:HR.muted,marginBottom:10}}>Required columns: <code style={{color:HR.yellowDark}}>SKU, DS01 Min, DS01 Max ... DS05 Min, DS05 Max, DC Min, DC Max</code></div>
                <textarea value={qaText} onChange={e=>setQaText(e.target.value)} placeholder="Paste CSV here..." style={{width:"100%",height:180,background:HR.surfaceLight,border:`1px solid ${HR.border}`,borderRadius:6,padding:10,color:HR.text,fontSize:11,fontFamily:"monospace",resize:"vertical",boxSizing:"border-box"}}/>
                <button onClick={runQA} style={{...S.runBtn,marginTop:10,width:"auto",padding:"9px 24px"}}>▶ Run QA Diff</button>
              </div>
            ):(
              <div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
                  <div style={{color:HR.yellowDark,fontWeight:700,fontSize:13}}>{qaFiltered.length} mismatches{qaFiltered.length!==qaDiffs.length?` (${qaDiffs.length} total)`:""}</div>
                  {[{val:qaFilterDS,set:setQaFDS,opts:qaDS},{val:qaFilterMv,set:setQaFMv,opts:qaMv},{val:qaFilterSp,set:setQaFSp,opts:qaSp},{val:qaFilterPr,set:setQaFPr,opts:qaPr}].map((f,i)=><select key={i} value={f.val} onChange={e=>f.set(e.target.value)} style={S.input}>{f.opts.map(v=><option key={v}>{v}</option>)}</select>)}
                  <button onClick={()=>setQaDiffs(null)} style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"6px 12px",borderRadius:5,cursor:"pointer",fontSize:12}}>↩ Re-paste CSV</button>
                </div>
                <div style={{...S.card,padding:0,overflow:"auto"}}>
                  <table style={S.table}>
                    <thead style={{position:"sticky",top:0}}><tr style={{background:HR.surfaceLight}}>{["SKU","DS","Mov Tag","Spike Tag","Price Tag","Top N","Brand","Sheet Min","Tool Min","Δ Min","Sheet Max","Tool Max","Δ Max"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {qaFiltered.map((d,i)=>{const minOk=d.dMin===0,maxOk=d.dMax===0;return <tr key={i} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{...S.td,fontWeight:600,fontSize:10}}>{d.sku}</td><td style={{...S.td,color:HR.muted,fontSize:10}}>{d.ds}</td><td style={S.td}><MovTag value={d.mvTag}/></td><td style={{...S.td,fontSize:10}}>{d.spTag}</td><td style={S.td}><TagPill value={d.prTag} colorMap={PRICE_TAG_COLORS}/></td><td style={S.td}><TagPill value={d.t150} colorMap={TOPN_TAG_COLORS}/></td><td style={{...S.td,fontSize:10,color:HR.muted}}>{d.brand||"—"}</td>
                        <td style={{...S.td,textAlign:"center"}}>{d.sheetMin}</td><td style={{...S.td,textAlign:"center",color:minOk?HR.text:"#C05A00",fontWeight:minOk?400:700}}>{d.toolMin}</td><td style={{...S.td,textAlign:"center",color:minOk?HR.green:d.dMin>0?"#C05A00":"#B91C1C",fontWeight:700}}>{minOk?"✓":d.dMin>0?`+${d.dMin}`:d.dMin}</td>
                        <td style={{...S.td,textAlign:"center"}}>{d.sheetMax}</td><td style={{...S.td,textAlign:"center",color:maxOk?HR.text:"#C05A00",fontWeight:maxOk?400:700}}>{d.toolMax}</td><td style={{...S.td,textAlign:"center",color:maxOk?HR.green:d.dMax>0?"#C05A00":"#B91C1C",fontWeight:700}}>{maxOk?"✓":d.dMax>0?`+${d.dMax}`:d.dMax}</td>
                      </tr>;})}
                    </tbody>
                  </table>
                  {qaFiltered.length===0&&<div style={{padding:28,textAlign:"center",color:HR.muted,fontSize:12}}>No mismatches with current filters.</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={S.pageWrap}>

        {tab==="upload"&&isAdmin&&(
  <div style={{display:"flex",gap:16,alignItems:"stretch"}}>

    {/* ── LEFT: cards + errors ── */}
    <div style={{flex:"0 0 auto"}}>
      <h2 style={{color:HR.yellowDark,marginBottom:4,fontSize:16}}>Upload Data</h2>
      <p style={{color:HR.muted,fontSize:13,marginBottom:14}}>Upload CSVs to power the model. Invoice data stored as rolling 90-day window.</p>

      {(()=>{
        const dlTemplate=(filename,headers,rows)=>{
          const csv=[headers.join(","),...rows.map(r=>r.join(","))].join("\n");
          const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=filename;a.click();
        };
        const templates={
          invoiceData:{file:"Invoice_Dump_Template.csv",headers:["Invoice Date","Invoice Number","Invoice Status","PurchaseOrder","Item Name","SKU","Category Name","Quantity","Line Item Location Name"],rows:[["2026-01-01","INV001","Confirmed","PO001","Product Name A","SKU001","Paints",5,"DS01 Warehouse"],["2026-01-02","INV002","Confirmed","PO002","Product Name B","SKU002","Adhesives",3,"DS02 Warehouse"]]},
          skuMaster:  {file:"SKU_Master_Template.csv",  headers:["Name","Inventorised At","SKU","Category","Status","Brand"],rows:[["Product Name A","DS","SKU001","Paints","Active","Asian Paints"],["Product Name B","DS","SKU002","Adhesives","Active","MYK Laticrete"]]},
          priceData:{file:"Avg_Price_Template.csv",headers:["item_id","item_name","unit","is_combo_product","quantity_purchased","amount","average_price","location_name","sku"],rows:[["ITEM001","Product Name A","PCS","No",100,25000,250,"DS01 Warehouse","SKU001"],["ITEM002","Product Name B","PCS","No",10,18000,1800,"DS02 Warehouse","SKU002"]]},
          minReqQty:  {file:"New_DS_Floor_Template.csv",headers:["SKU","Qty"],rows:[["SKU001",10],["SKU002",5]]},
          newSKUQty:  {file:"New_SKU_Floor_Template.csv",headers:["SKU","DS01","DS02","DS03","DS04","DS05"],rows:[["SKU001",3,2,0,5,0],["SKU002",0,1,2,0,3]]},
          deadStock:  {file:"Dead_Stock_Template.csv",  headers:["Dead Stock"],rows:[["SKU001"],["SKU002"]]},
        };
        const cards=[
          {label:"Invoice Dump L90D",desc:"Columns: Invoice Date, SKU, Line Item Location Name, Quantity",handler:handleInvoice,count:`${invoiceData.length.toLocaleString()} rows`,key:"invoiceData",required:true,hasData:invoiceData.length>0},
          {label:"SKU Master",desc:"Columns: Name, SKU, Category, Brand, Status, Inventorised At",handler:handleSKU,count:`${Object.keys(skuMaster).length.toLocaleString()} SKUs`,key:"skuMaster",required:true,hasData:Object.keys(skuMaster).length>0},
          {label:"Average Purchase Price of SKU",desc:"Columns: sku, average_price",handler:handlePrice,count:`${Object.keys(priceData).length.toLocaleString()} SKUs`,key:"priceData",required:true,hasData:Object.keys(priceData).length>0},
          {label:"Newly Launched Dark Store Floor Qty",desc:"Columns: SKU, Qty",handler:handleMRQ,count:`${Object.keys(minReqQty).length.toLocaleString()} SKUs`,key:"minReqQty",required:true,hasData:Object.keys(minReqQty).length>0},
          {label:"Newly Launched SKU Floor Qty - DS Level",desc:"Per-store manual floor qtys. Columns: SKU, DS01–DS05",handler:handleNSQ,count:`${Object.keys(newSKUQty).length.toLocaleString()} SKUs`,key:"newSKUQty",required:true,hasData:Object.keys(newSKUQty).length>0},
          {label:"Dead Stock List",desc:"Column: Dead Stock (SKU list)",handler:handleDead,count:`${deadStock.size.toLocaleString()} SKUs`,key:"deadStock",required:true,hasData:deadStock.size>0},
        ];
        return(
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:16}}>
            {cards.map(item=>(
              <div key={item.label} style={{...S.card}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:2}}>
                  <div style={{fontWeight:700,color:HR.text,fontSize:12,lineHeight:1.3,paddingRight:8}}>
                    {item.label}{" "}
                    {item.required&&<span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>}
                  </div>
                  <div style={{fontSize:11,color:HR.green,whiteSpace:"nowrap",fontWeight:600,flexShrink:0}}>{item.count}</div>
                </div>
                <div style={{fontSize:10,color:HR.muted,marginBottom:10,lineHeight:1.4}}>{item.desc}</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <label style={{background:HR.green,color:HR.white,padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>
                    ⬆ Upload CSV <input type="file" accept=".csv" onChange={item.handler} style={{display:"none"}}/>
                  </label>
                  <button onClick={()=>{const t=templates[item.key];dlTemplate(t.file,t.headers,t.rows);}}
                    style={{background:"#EAF9FF",color:"#0077A8",border:"1px solid #A5F3FC",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>
                    ⬇ Template
                  </button>
                  {item.hasData&&(
                    <button onClick={()=>clearData(item.key)}
                      style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>
                      🗑 Clear
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
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

    {/* ── RIGHT: sticky summary + re-run + publish ── */}
    <div style={{flex:1,minWidth:200,display:"flex",flexDirection:"column",gap:10,marginTop:74,minHeight:0}}>

      {/* Data Health Summary */}
      <div style={{...S.card,padding:"12px 14px"}}>
        <div style={{fontWeight:700,color:HR.text,fontSize:13,marginBottom:10}}>📋 Data Health</div>
        {[
          {label:"Date Range",   value:dateRange,                                        color:HR.text,   small:true},
          {label:"Invoice Rows", value:invoiceData.length.toLocaleString(),              color:"#0077A8"},
          {label:"Active SKUs",  value:activeMaster.length.toLocaleString(),             color:HR.green},
          {label:"SKUs Sold",    value:uniqueSold.toLocaleString(),                      color:HR.yellowDark},
          {label:"Zero Sale",    value:zeroSale.toLocaleString(),                        color:"#C05A00"},
          {label:"Dead Stock",   value:deadStock.size.toLocaleString(),                  color:"#B91C1C"},
          {label:"Price SKUs",   value:Object.keys(priceData).length.toLocaleString(),   color:"#7A3DBF"},
          {label:"Missing SKUs", value:missing.length.toLocaleString(),                  color:missing.length>0?"#B91C1C":HR.green},
        ].map(c=>(
          <div key={c.label} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"4px 0",borderBottom:`1px solid ${HR.border}`}}>
            <span style={{fontSize:11,color:HR.muted}}>{c.label}</span>
            <span style={{fontSize:c.small?10:13,fontWeight:c.small?400:700,color:c.color,maxWidth:160,textAlign:"right",wordBreak:"break-word"}}>{c.value}</span>
          </div>
        ))}
      </div>

      {/* Re-run Model */}
      {allUploaded&&(
  <button onClick={()=>{setLoaded(true);applyAndRun(params);}} style={{...S.runBtn,margin:0}}>
    ▶ Re-run Model
  </button>
)}

      {/* Publish to Team */}
      {dataLoaded&&results&&(
        <div style={{...S.card,borderColor:HR.yellow,background:"#FFFBEA",padding:"14px",flex:1,display:"flex",flexDirection:"column"}}>
  <div style={{fontWeight:700,color:HR.yellowDark,fontSize:14,marginBottom:10}}>📤 Publish to Team</div>
  <button onClick={handlePublish}
    style={{background:HR.white,color:HR.yellowDark,border:`2px solid ${HR.yellow}`,padding:"9px 24px",borderRadius:7,cursor:"pointer",fontWeight:700,fontSize:13,width:"100%",marginBottom:14}}>
    {publishStatus==="saving"?"Saving…":"☁ Publish to Team"}
</button>
  {/* What gets saved */}
  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
    {[
      {icon:"🧾",label:"Invoice Rows",   value:invoiceData.length.toLocaleString(),         color:"#0077A8"},
      {icon:"📦",label:"Active SKUs",    value:activeMaster.length.toLocaleString(),         color:HR.green},
      {icon:"💰",label:"Price SKUs",     value:Object.keys(priceData).length.toLocaleString(),color:"#7A3DBF"},
      {icon:"⚙️", label:"Logic Params",  value:`${changedCount>0?`${changedCount} unsaved changes`:"Up to date"}`, color:changedCount>0?"#B91C1C":HR.green},
    ].map(c=>(
      <div key={c.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:HR.white,borderRadius:5,padding:"6px 10px",border:`1px solid ${HR.border}`}}>
        <span style={{fontSize:11,color:HR.muted}}>{c.icon} {c.label}</span>
        <span style={{fontSize:12,fontWeight:700,color:c.color}}>{c.value}</span>
      </div>
    ))}
  </div>
  {/* Last published */}
  <div style={{fontSize:11,color:HR.muted,lineHeight:1.5,marginBottom:6}}>
    <span style={{fontWeight:600,color:HR.textSoft}}>What gets saved: </span>
    Invoice data, SKU master, price data, dead stock list, floor qty files, and all logic parameters.
  </div>
  <div style={{fontSize:11,color:HR.muted,marginTop:"auto",paddingTop:10,borderTop:`1px solid ${HR.border}`}}>
    {publishStatus==="done"
      ? <span style={{color:"#15803D",fontWeight:700}}>✅ Last published: just now</span>
      : <span>⏱ Not yet published this session</span>
    }
  </div>
  {publishStatus==="done"&&(
    <div style={{marginTop:8,background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:6,padding:"10px 12px",fontSize:12,color:"#15803D"}}>
      <div style={{fontWeight:700,marginBottom:2}}>✅ Published successfully!</div>
      <div style={{color:HR.muted}}>Team sees new data on next page load. Backup JSON downloaded.</div>
    </div>
  )}
  {publishStatus==="error"&&(
    <div style={{marginTop:8,color:"#B91C1C",fontSize:12}}>❌ Something went wrong. Check your connection and try again.</div>
  )}
</div>
      )}

    </div>
  </div>
)}

        {tab==="dashboard"&&(
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
            <div style={{display:"flex",flexDirection:"column",height:"100%"}}>

              {/* ── KPI Strip ── */}
              {(()=>{
                const invMin=results?Math.round(Object.entries(results).reduce((tot,[sku,r])=>{const p=priceData[sku]||0;return tot+DS_LIST.reduce((s,ds)=>s+(r.stores[ds]?.min||0)*p,0)+(r.dc.min||0)*p;},0)):0;
                const invMax=results?Math.round(Object.entries(results).reduce((tot,[sku,r])=>{const p=priceData[sku]||0;return tot+DS_LIST.reduce((s,ds)=>s+(r.stores[ds]?.max||0)*p,0)+(r.dc.max||0)*p;},0)):0;
                return(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6,marginBottom:8}}>
                    {[
                      {label:"Active SKUs",value:activeMaster.length,color:HR.green},
                      {label:"Active SKUs Sold",value:uniqueSold,color:HR.yellowDark},
                      {label:"Zero Sale SKUs",value:zeroSale,color:"#C05A00"},
                      {label:"Dead Stock SKUs",value:deadStock.size,color:"#B91C1C"},
                      {label:"Inv Value Min",value:fmtInr(invMin),color:"#0077A8"},
                      {label:"Inv Value Max",value:fmtInr(invMax),color:"#7A3DBF"},
                    ].map(c=>(
                      <div key={c.label} style={{...S.card,borderLeft:`3px solid ${c.color}`,padding:"6px 10px"}}>
                        <div style={{fontSize:18,fontWeight:800,color:c.color}}>{typeof c.value==="number"?c.value.toLocaleString():c.value}</div>
                        <div style={{fontSize:9,color:HR.muted,marginTop:1}}>{c.label}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* ── Filter Bar ── */}
              <div style={{display:"flex",gap:4,marginBottom:6,flexWrap:"wrap",alignItems:"center"}}>

                <input placeholder="Search SKU or name..." value={search} onChange={e=>setSearch(e.target.value)}
                  style={{...S.input,width:148,fontSize:11,padding:"3px 8px"}}/>

                {/* Category — dropdown */}
                <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  <option value="">All Categories</option>
                  {allCategories.map(c=><option key={c} value={c}>{c}</option>)}
                </select>

                {/* Status */}
                <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  {allStatuses.map(s=><option key={s}>{s}</option>)}
                </select>

                {/* Store */}
                <select value={filterDS} onChange={e=>setFilterDS(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  <option value="All">All Stores</option>
                  {DS_LIST.map(d=><option key={d}>{d}</option>)}
                </select>

                {/* Price Tag */}
                <select value={filterPriceTag} onChange={e=>setFilterPriceTag(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  <option value="All">All Price Tags</option>
                  {["Premium","High","Medium","Low","Super Low","No Price"].map(t=><option key={t}>{t}</option>)}
                </select>

                {/* Top N */}
                <select value={filterTopN} onChange={e=>setFilterTopN(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  <option value="All">All Top N</option>
                  {["T50","T150","T250","No","Zero Sale L90D"].map(t=><option key={t} value={t}>{TOPN_DISPLAY[t]||t}</option>)}
                </select>

                {/* Movement */}
                <select value={filterMov} onChange={e=>setFilterMov(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  <option value="All">All Movement</option>
                  {["Super Fast","Fast","Moderate","Slow","Super Slow"].map(t=><option key={t}>{t}</option>)}
                </select>

                {/* Logic */}
                <select value={filterLogic} onChange={e=>setFilterLogic(e.target.value)} style={{...S.input,fontSize:11,padding:"3px 6px"}}>
                  <option value="All">All Logic</option>
                  {["Base Logic","New DS Floor","New SKU Floor","Brand Buffer","Manual Override"].map(t=><option key={t}>{t}</option>)}
                </select>

                {(search||filterCat||filterStatus!=="All"||filterDS!=="All"||filterPriceTag!=="All"||filterTopN!=="All"||filterMov!=="All"||filterLogic!=="All")&&(
                  <button onClick={()=>{setSearch("");setFilterCat("");setFilterStatus("All");setFilterDS("All");setFilterPriceTag("All");setFilterTopN("All");setFilterMov("All");setFilterLogic("All");}}
                    style={{...S.btn(false),fontSize:10,padding:"3px 8px",color:"#B91C1C",borderColor:"#FECACA",background:"#FEE2E2"}}>✕ Clear</button>
                )}

                <span style={{fontSize:10,color:HR.muted}}>{filtered.length} SKUs</span>
              </div>

              {/* ── Table ── */}
              <div style={{...S.card,padding:0,overflow:"auto",flex:1,minHeight:0}}
  onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
ref={el => { if(el && scrollTop === 0) el.scrollTop = 0; }}>
                <table style={{...S.table,fontSize:10,tableLayout:"fixed"}}>
                  <colgroup>
  <col style={{width:150}}/>
  <col style={{width:90}}/>
  <col style={{width:64}}/>
  <col style={{width:72}}/>
  <col style={{width:76}}/>
  {displayDS.map(ds=>[
    <col key={ds+"mv"} style={{width:90}}/>,
    <col key={ds+"da"} style={{width:50}}/>,
    <col key={ds+"ab"} style={{width:50}}/>,
    <col key={ds+"mn"} style={{width:50}}/>,
    <col key={ds+"mx"} style={{width:50}}/>,
  ])}
  <col style={{width:80}}/>
  <col style={{width:50}}/>
  <col style={{width:50}}/>
  <col style={{width:50}}/>
</colgroup>
                  <thead style={{position:"sticky",top:0,zIndex:4}}>
                    <tr style={{background:HR.surfaceLight}}>
                      {/* Frozen cols — now includes Status */}
                      <th style={{...frozenTh({zIndex:6}),left:FROZEN_COLS_LEFT.item,minWidth:COL_ITEM_W,maxWidth:COL_ITEM_W}} rowSpan={2}>Item</th>
                      <th style={{...frozenTh({zIndex:6}),left:FROZEN_COLS_LEFT.cat,minWidth:COL_CAT_W,maxWidth:COL_CAT_W}} rowSpan={2}>Category</th>
                      <th style={{...frozenTh({zIndex:6}),left:FROZEN_COLS_LEFT.status,minWidth:COL_STATUS_W,maxWidth:COL_STATUS_W}} rowSpan={2}>Status</th>
                      <th style={{...frozenTh({zIndex:6}),left:FROZEN_COLS_LEFT.price,minWidth:COL_PRICE_W}} rowSpan={2}>Price</th>
                      <th style={{...frozenTh({zIndex:6}),left:FROZEN_COLS_LEFT.topn,minWidth:COL_TOPN_W,boxShadow:"2px 0 6px rgba(0,0,0,0.10)"}} rowSpan={2}>Top N</th>
                      {displayDS.map(ds=>{const di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];return <th key={ds} style={{...S.th,textAlign:"center",background:dc.bg,color:dc.header,borderLeft:`2px solid ${dc.header}44`,fontSize:10}} colSpan={5}>{ds}</th>;})}
                      <th style={{...S.th,textAlign:"center",background:DC_COLOR.bg,color:DC_COLOR.header,borderLeft:`2px solid ${DC_COLOR.header}44`,fontSize:10}} colSpan={4}>DC</th>
                    </tr>
                    <tr style={{background:HR.surfaceLight}}>
                      {displayDS.map(ds=>{const di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];return[
                        <th key={ds+"mv"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,borderLeft:`2px solid ${dc.header}44`,position:"sticky",top:24,zIndex:3,fontSize:9}}>Mov / Logic</th>,
                        <th key={ds+"da"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>DAvg</th>,
                        <th key={ds+"ab"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>ABQ</th>,
                        <th key={ds+"mn"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>Min</th>,
                        <th key={ds+"mx"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>Max</th>,
                      ];})}
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,borderLeft:`2px solid ${DC_COLOR.header}44`,position:"sticky",top:24,zIndex:3,fontSize:9}}>Mov</th>
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>NZD</th>
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>Min</th>
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:24,zIndex:3,fontSize:9}}>Max</th>
                    </tr>
                  </thead>
                  <tbody>
  <tr style={{height: visibleFiltered.startIndex * ROW_HEIGHT}}><td colSpan={999}/></tr>
  {visibleFiltered.rows.map((r,i)=>{
    const actualIndex = visibleFiltered.startIndex + i;
                      const isDead=deadStock.has(r.meta.sku),rowBg=actualIndex%2===0?HR.white:HR.surfaceLight;
                      const status=(r.meta.status||"").trim();
                      const statusColor=status.toLowerCase()==="active"?HR.green:status.toLowerCase()==="inactive"?"#B91C1C":"#92400E";
                      return(
                        <tr key={r.meta.sku} style={{background:rowBg,opacity:isDead?0.65:1}}>
                          {/* Item */}
                          <td style={{...frozenTd(FROZEN_COLS_LEFT.item,rowBg),minWidth:COL_ITEM_W,maxWidth:COL_ITEM_W,padding:"3px 6px"}}>
                            <div style={{color:HR.text,fontWeight:500,fontSize:10,lineHeight:1.3,whiteSpace:"normal"}}>{r.meta.name||r.meta.sku}</div>
                            <div style={{fontSize:8,marginTop:1,display:"flex",gap:3,alignItems:"center"}}>
                              <span style={{color:HR.muted}}>{r.meta.sku}</span>
                              {isDead&&<span style={{...TAG_STYLE,fontSize:8,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}}>Dead</span>}
                            </div>
                          </td>
                          {/* Category */}
                          <td style={{...frozenTd(FROZEN_COLS_LEFT.cat,rowBg),minWidth:COL_CAT_W,maxWidth:COL_CAT_W,color:HR.muted,fontSize:9,padding:"3px 6px"}}>{r.meta.category}</td>
                          {/* Status */}
                          <td style={{...frozenTd(FROZEN_COLS_LEFT.status,rowBg),minWidth:COL_STATUS_W,maxWidth:COL_STATUS_W,padding:"3px 6px"}}>
                            <span style={{fontSize:9,fontWeight:700,color:statusColor}}>{status||"—"}</span>
                          </td>
                          {/* Price Tag */}
                          <td style={{...frozenTd(FROZEN_COLS_LEFT.price,rowBg),minWidth:COL_PRICE_W,padding:"3px 6px"}}><TagPill value={r.meta.priceTag} colorMap={PRICE_TAG_COLORS}/></td>
                          {/* Top N */}
                          <td style={{...frozenTd(FROZEN_COLS_LEFT.topn,rowBg),minWidth:COL_TOPN_W,boxShadow:"2px 0 4px rgba(0,0,0,0.06)",padding:"3px 6px"}}><TagPill value={r.meta.t150Tag} colorMap={TOPN_TAG_COLORS}/></td>
                          {/* DS Columns — logic tag now lives inside each DS cell */}
                          <DSCols r={r} displayDS={displayDS} coreOverrides={coreOverrides}/>
                          {/* DC */}
                          <td style={{...S.td,padding:"3px 6px",textAlign:"center",background:DC_COLOR.bg,borderLeft:`1px solid ${DC_COLOR.header}22`}}><MovTag value={r.dc.mvTag}/></td>
                          <td style={{...S.td,padding:"3px 6px",textAlign:"center",color:DC_COLOR.text,fontSize:9,background:DC_COLOR.bg}}>{r.dc.nonZeroDays||"—"}</td>
                          <td style={{...S.td,padding:"3px 6px",textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg}}>{r.dc.min}</td>
                          <td style={{...S.td,padding:"3px 6px",textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg}}>{r.dc.max}</td>
                        </tr>
                      );
                    })}
  <tr style={{height: (filtered.length - visibleFiltered.startIndex - visibleFiltered.rows.length) * ROW_HEIGHT}}><td colSpan={999}/></tr>
</tbody>
                </table>
                {filtered.length>1500&&(
                  <div style={{padding:5,textAlign:"center",color:HR.muted,fontSize:9}}>
                    Showing all {filtered.length} SKUs — use filters to narrow down for better performance.
                  </div>
                )}
              </div>

            </div>
          )
        )}
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
                        const topN=res?.meta?.t150Tag||"Zero Sale L90D";
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
                    style={{background:results?"#0077A8":"#ccc",color:HR.white,border:"none",padding:"7px 18px",borderRadius:5,cursor:results?"pointer":"not-allowed",fontWeight:700,fontSize:12,opacity:results?1:0.6}}
                  >⬇ SKU Master CSV</button>

                  {/* ── Tool Output CSV ── */}
                  <button onClick={()=>{
                    const hdr=[
                      "Item Name","Inventorised At","SKU","Category","Status","Dead Stock (Y/N)",
                      ...DS_LIST.flatMap(d=>[`${d} Logic Applied`,`${d} Min`,`${d} Max`]),
                      "DC Min","DC Max"
                    ].join(",");
                    const rows=Object.values(skuMaster).map(s=>{
                      const r=results[s.sku];
                      const isDead=deadStock.has(s.sku)?"Y":"N";
                      const dsCols=DS_LIST.flatMap(d=>{
                        const st=r?.stores[d]||{min:0,max:0};
                        const ov=coreOverrides[s.sku]?.[d];
                        const min=ov?Math.max(st.min,ov.min):st.min;
                        const max=ov?Math.max(st.max,ov.max):st.max;
                        const logic=ov?"Manual Override":(st.logicTag||"Base Logic");
                        return[`"${logic}"`,min,max];
                      });
                      return[
                        `"${(s.name||s.sku).replace(/"/g,'""')}"`,
                        `"${(s.inventorisedAt||"").replace(/"/g,'""')}"`,
                        s.sku,
                        `"${(s.category||"").replace(/"/g,'""')}"`,
                        `"${(s.status||"").trim()}"`,
                        isDead,
                        ...dsCols,
                        r?.dc.min??0,
                        r?.dc.max??0,
                      ].join(",");
                    });
                    const blob=new Blob([[hdr,...rows].join("\n")],{type:"text/csv"});
                    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="IMS_Output.csv";a.click();
                  }} style={{background:HR.green,color:HR.white,border:"none",padding:"7px 18px",borderRadius:5,cursor:"pointer",fontWeight:700,fontSize:12}}>⬇ Tool Output CSV</button>

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
        {/* dashboard keep-alive: no change needed yet */}
        <div style={{display: tab==="simulation" ? "block" : "none"}}>
  <SimulationTab invoiceData={invoiceData} results={results} skuMaster={skuMaster} params={params} priceData={priceData} onApplyToCore={payload=>{const merged={...coreOverrides,...payload};Object.keys(payload).forEach(sku=>{merged[sku]={...coreOverrides[sku],...payload[sku]};});saveCoreOverrides(merged);}} simOverrides={simOverrides} setSimOverrides={setSimOverrides} simOverrideCount={simOverrideCount} setSimOverrideCount={setSimOverrideCount} simResults={simResults} setSimResults={setSimResults} simLoading={simLoading} setSimLoading={setSimLoading} simDays={simDays} setSimDays={setSimDays}/>
</div>
        {tab==="insights"&&(
        <InsightsTab
          invoiceData={invoiceData} skuMaster={skuMaster} results={results||{}} params={params}
          period={insightsPeriod}         setPeriod={setInsightsPeriod}
          customDays={insightsCustomD}    setCustomDays={setInsightsCustomD}
          dsView={insightsDsView}         setDsView={setInsightsDsView}
          drill={insightsDrill}           setDrill={setInsightsDrill}
          catFilter={insightsCatFilter}   setCatFilter={setInsightsCatFilter}
          globalSearch={insightsSearch}   setGlobalSearch={setInsightsSearch}
        />
      )}

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
{tab==="overrides"&&isAdmin&&<OverridesTab coreOverrides={coreOverrides} saveCoreOverrides={saveCoreOverrides} priceData={priceData} results={results}/>}
      </div>{/* end pageWrap */}
    </div>
  );
}