import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const ROLLING_DAYS = 90;
const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];

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
const MOVEMENT_TIERS_DEFAULT = [2,4,7,10];
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

const DEFAULT_BRAND_BUFFER = {
  "Asian Paints":3,"VIP Extrusions":3,"MYK Laticrete":3,"Roff":3,
  "Supreme":3,"Saint-Gobain":2,"Alagar":3,"Legrand":1,"Archidply":1,
};
const DC_MULT_DEFAULT = {
  "Super Fast":{min:0.75,max:1.0},"Fast":{min:0.5,max:0.75},
  "Moderate":{min:0.5,max:0.75},"Slow":{min:0.25,max:0.5},"Super Slow":{min:0.25,max:0.5},
};
const DC_DEAD_MULT_DEFAULT = {min:0.25,max:0.25};
const RECENCY_WT_DEFAULT = {"Super Fast":2,"Fast":3,"Moderate":1.5,"Slow":1,"Super Slow":1};
const BASE_MIN_DAYS_DEFAULT = {"Super Fast":6,"Fast":5,"Moderate":3,"Slow":3,"Super Slow":3};
const DEFAULT_PARAMS = {
  overallPeriod:90,recencyWindow:15,recencyWt:RECENCY_WT_DEFAULT,movIntervals:[2,4,7,10],
  priceTiers:[3000,1500,400,100],spikeMultiplier:5,spikePctFrequent:10,spikePctOnce:5,
  maxDaysBuffer:2,abqMaxMultiplier:1.5,baseMinDays:BASE_MIN_DAYS_DEFAULT,
  brandBuffer:DEFAULT_BRAND_BUFFER,newDSList:["DS04","DS05"],newDSFloorTopN:150,
  activeDSCount:4,dcMult:DC_MULT_DEFAULT,dcDeadMult:DC_DEAD_MULT_DEFAULT,
};

const LS = {
  get:(key)=>{try{const v=localStorage.getItem(key);return v?{value:v}:null;}catch{return null;}},
  set:(key,value)=>{try{localStorage.setItem(key,value);return true;}catch{return null;}},
  delete:(key)=>{try{localStorage.removeItem(key);return true;}catch{return null;}},
};

function parseCSV(text){
  const lines=text.trim().split("\n");
  const headers=lines[0].split(",").map(h=>h.trim().replace(/^"|"$/g,""));
  return lines.slice(1).filter(l=>l.trim()).map(line=>{
    const vals=[];let cur="",inQ=false;
    for(let i=0;i<line.length;i++){
      if(line[i]==='"'){inQ=!inQ;continue;}
      if(line[i]===','&&!inQ){vals.push(cur.trim());cur="";continue;}
      cur+=line[i];
    }
    vals.push(cur.trim());
    const obj={};headers.forEach((h,i)=>{obj[h]=vals[i]||"";});
    return obj;
  });
}

function getPriceTag(p,tiers){const v=parseFloat(p)||0;const[t1,t2,t3,t4]=tiers||[3000,1500,400,100];if(v>=t1)return"Premium";if(v>=t2)return"High";if(v>=t3)return"Medium";if(v>=t4)return"Low";if(v>0)return"Super Low";return"No Price";}
function getMovTag(nzd,total,intervals){if(!nzd)return"Super Slow";const avg=total/nzd;const[i1,i2,i3,i4]=intervals||MOVEMENT_TIERS_DEFAULT;if(avg<=i1)return"Super Fast";if(avg<=i2)return"Fast";if(avg<=i3)return"Moderate";if(avg<=i4)return"Slow";return"Super Slow";}
function getSpikeTag(spikeDays,totalDays,pFreq,pOnce){const pct=totalDays>0?(spikeDays/totalDays)*100:0;if(pct>=pFreq)return"Frequent";if(pct>=pOnce)return"Once in a while";if(spikeDays>0)return"Rare";return"No Spike";}
function computeStats(qtys,ords,periodDays,spikeMult){
  const totalQty=qtys.reduce((a,b)=>a+b,0),totalOrders=ords.reduce((a,b)=>a+b,0),nonZeroDays=qtys.filter(q=>q>0).length;
  const dailyAvg=totalQty/periodDays,abq=totalOrders>0?totalQty/totalOrders:0,maxDayQty=Math.max(...qtys);
  let spikeDays=0,spikeVals=[];
  qtys.forEach(q=>{if(q>spikeMult*dailyAvg){spikeDays++;spikeVals.push(q);}});
  const sorted=[...spikeVals].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  const spikeMedian=sorted.length===0?0:sorted.length%2===1?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  const spikeRef=spikeDays===0?maxDayQty:spikeMedian,spikeRatio=dailyAvg>0?spikeRef/dailyAvg:0;
  return{totalQty,totalOrders,nonZeroDays,dailyAvg,abq,spikeDays,spikeRatio,spikeMedian:spikeRef};
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
  const allSKUs=[...new Set(invSliced.map(r=>r.sku))],activeDSCount=p.activeDSCount||4,res={};
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
      if(!hasData){
        if(isNewDS){
          let nm=isEligible?(mrq[skuId]||0):0,nx=isEligible?nm:0;
          if(nsq&&nsq[skuId]){const q=nsq[skuId][dsId]||0;if(q>0){nm=Math.max(nm,q);nx=nm;}}
          if(isDead)nx=nm;
          stores[dsId]={min:nm,max:nx,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike"};
          dsMinArr.push(nm);dsMaxArr.push(nx);
        }else if(nsq&&nsq[skuId]){
          const q=nsq[skuId][dsId]||0;
          stores[dsId]={min:q,max:q,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike"};
          dsMinArr.push(q);dsMaxArr.push(q);
        }else{stores[dsId]={min:0,max:0,dailyAvg:0,abq:0,mvTag:"Super Slow",spTag:"No Spike"};}
        return;
      }
      const sLong=computeStats(qLong,oLong,op-rw,p.spikeMultiplier),sRecent=computeStats(qRecent,oRecent,rw,p.spikeMultiplier);
      const s90=computeStats(q90,o90,op,p.spikeMultiplier);
      const mvTagLong=getMovTag(sLong.nonZeroDays,op-rw,intervals),spTagLong=getSpikeTag(sLong.spikeDays,op-rw,p.spikePctFrequent,p.spikePctOnce);
      const mvTagRecent=getMovTag(sRecent.nonZeroDays,rw,intervals),spTagRecent=getSpikeTag(sRecent.spikeDays,rw,p.spikePctFrequent,p.spikePctOnce);
      const mvTag90=tags90[k].mvTag,wt=recencyWt[mvTag90]||1;
      const rLong=calcPeriodMinMax(sLong,prTag,spTagLong,mvTagLong,p.abqMaxMultiplier,p.maxDaysBuffer,p.baseMinDays);
      const rRecent=calcPeriodMinMax(sRecent,prTag,spTagRecent,mvTagRecent,p.abqMaxMultiplier,p.maxDaysBuffer,p.baseMinDays);
      let minQty=Math.ceil((rLong.minQty+rRecent.minQty*wt)/(1+wt)),maxQty=Math.ceil((rLong.maxQty+rRecent.maxQty*wt)/(1+wt));
      if(isNewDS&&isEligible){const floor=mrq[skuId]||0;if(floor>minQty){minQty=floor;maxQty=floor;}else maxQty=Math.max(maxQty,minQty);}
      if(hasBuf){const dohMin=s90.dailyAvg>0?minQty/s90.dailyAvg:0;minQty=Math.ceil((dohMin+bufDays)*s90.dailyAvg);maxQty=minQty;}
      minQty=Math.ceil(minQty);maxQty=Math.ceil(Math.max(maxQty,minQty));
      if(isDead)maxQty=minQty;maxQty=Math.max(maxQty,minQty);if(isDead)maxQty=minQty;
      if(nsq&&nsq[skuId]){const q=nsq[skuId][dsId]||0;minQty=Math.max(minQty,q);maxQty=minQty;}
      stores[dsId]={min:Math.round(minQty),max:Math.round(maxQty),dailyAvg:s90.dailyAvg,abq:s90.abq,mvTag:mvTag90,spTag:tags90[k].spTag};
      dsMinArr.push(Math.round(minQty));dsMaxArr.push(Math.round(maxQty));
    });
    const sumMin=dsMinArr.reduce((a,b)=>a+b,0),sumMax=dsMaxArr.reduce((a,b)=>a+b,0);
    const dcStats=getDCStats(invSliced,skuId,activeDSCount,intervals,op);
    const dcDeadMult=p.dcDeadMult||DC_DEAD_MULT_DEFAULT,dcM=isDead?dcDeadMult:(p.dcMult||DC_MULT_DEFAULT)[dcStats.mvTag]||DC_MULT_DEFAULT[dcStats.mvTag];
    res[skuId]={meta:{...meta,priceTag:prTag,t150Tag},stores,dc:{min:Math.round(sumMin*dcM.min),max:Math.round(sumMax*dcM.max),mvTag:dcStats.mvTag,nonZeroDays:dcStats.nonZeroDays}};
  });
  return res;
}

function getInvSlice(invoiceData,period,recencyWindow){
  const allDates=[...new Set(invoiceData.map(r=>r.date))].sort(),full=allDates.slice(-90);
  if(period==="90D")return invoiceData.filter(r=>full.includes(r.date));
  const rw=Math.min(recencyWindow||15,full.length-1),split=full.length-rw;
  if(period==="15D")return invoiceData.filter(r=>full.slice(split).includes(r.date));
  if(period==="75D")return invoiceData.filter(r=>full.slice(0,split).includes(r.date));
  return invoiceData.filter(r=>full.includes(r.date));
}
function aggStats(rows){
  const skus=new Set(rows.map(r=>r.sku)),totalOrders=rows.length,totalQty=rows.reduce((a,r)=>a+r.qty,0),avgOrderQty=totalOrders>0?totalQty/totalOrders:0;
  return{skuCount:skus.size,totalOrders,totalQty,avgOrderQty};
}

const TAG_STYLE = {padding:"1px 6px",borderRadius:3,fontSize:10,fontWeight:600,whiteSpace:"nowrap",lineHeight:"16px",display:"inline-block"};

const TagPill=({value,colorMap})=>{
  const raw=colorMap[value]||{bg:"#F1F5F9",color:"#64748B",border:"#CBD5E1"};
  const displayVal=colorMap===TOPN_TAG_COLORS?(TOPN_DISPLAY[value]||value):value;
  return <span style={{...TAG_STYLE,background:raw.bg,color:raw.color,border:`1px solid ${raw.border}`}}>{displayVal||"—"}</span>;
};
const MovTag=({value})=>{
  const color=MOV_COLORS[value]||"#64748b",bg=color+"18";
  return <span style={{...TAG_STYLE,background:bg,color,border:`1px solid ${color}33`}}>{value||"—"}</span>;
};

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
const FROZEN_TOTAL = COL_ITEM_W + COL_CAT_W + COL_PRICE_W + COL_TOPN_W;

const frozenTh=(extra={})=>({...S.th,position:"sticky",top:0,zIndex:4,background:HR.surfaceLight,...extra});
const frozenTd=(left,bg,extra={})=>({...S.td,position:"sticky",left,background:bg,zIndex:2,...extra});

const DSCols=({r,displayDS})=>displayDS.map(ds=>{
  const s=r.stores[ds]||{min:0,max:0,dailyAvg:0,abq:0,mvTag:"—"},di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];
  return[
    <td key={ds+"mv"} style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,textAlign:"center",background:dc.bg,borderLeft:`1px solid ${dc.header}22`}}><MovTag value={s.mvTag}/></td>,
    <td key={ds+"da"} style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontSize:10,background:dc.bg}}>{s.dailyAvg>0?s.dailyAvg.toFixed(1):"—"}</td>,
    <td key={ds+"ab"} style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontSize:10,background:dc.bg}}>{s.abq>0?s.abq.toFixed(1):"—"}</td>,
    <td key={ds+"mn"} style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg}}>{s.min}</td>,
    <td key={ds+"mx"} style={{padding:"4px 8px",borderTop:`1px solid ${HR.border}`,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg}}>{s.max}</td>,
  ];
});

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

// ─── Insights ────────────────────────────────────────────────────────────────
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
        {!compact&&<span style={{fontSize:10,color:HR.muted}}>{totalOrders} orders · ABQ {abq}</span>}
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

function InsightsTab({invoiceData,skuMaster,results,params}){
  const [period,setPeriod]=useState("90D"),[dsView,setDsView]=useState("All"),[drill,setDrill]=useState(null);
  const rw=params.recencyWindow||15,slice=useMemo(()=>getInvSlice(invoiceData,period,rw),[invoiceData,period,rw]);
  const categories=useMemo(()=>[...new Set(slice.map(r=>skuMaster[r.sku]?.category||"Unknown"))].sort(),[slice,skuMaster]);
  const sliceForDs=useMemo(()=>dsView==="All"||dsView==="Compare"?slice:slice.filter(r=>r.ds===dsView),[slice,dsView]);
  const st=useMemo(()=>aggStats(sliceForDs),[sliceForDs]);
  const skuCount=useMemo(()=>[...new Set(sliceForDs.map(r=>r.sku))].length,[sliceForDs]);
  const movCounts=useMemo(()=>{
    const skus=[...new Set(sliceForDs.map(r=>r.sku))],counts={"Super Fast":0,"Fast":0,"Moderate":0,"Slow":0,"Super Slow":0};
    skus.forEach(s=>{const tag=(dsView&&dsView!=="All"&&dsView!=="Compare")?(results[s]?.stores[dsView]?.mvTag||"Super Slow"):(results[s]?.dc?.mvTag||"Super Slow");if(counts[tag]!==undefined)counts[tag]++;});
    return counts;
  },[sliceForDs,dsView,results]);
  const crumbs=[
    {label:"All Categories",onClick:()=>setDrill(null)},
    ...(drill?.type==="category"||drill?.type==="brand"||drill?.type==="sku"?[{label:drill.category||drill.value,onClick:()=>setDrill({type:"category",value:drill.category||drill.value})}]:[]),
    ...(drill?.type==="brand"||drill?.type==="sku"?[{label:drill.brand||drill.value,onClick:()=>setDrill({type:"brand",value:drill.brand||drill.value,category:drill.category})}]:[]),
    ...(drill?.type==="sku"?[{label:drill.skuName||drill.value}]:[]),
  ];
  if(!invoiceData.length)return <div style={{textAlign:"center",padding:80}}><div style={{fontSize:40,marginBottom:12}}>📊</div><div style={{color:HR.muted,fontSize:14}}>No data available</div></div>;
  const movColors=["#16a34a","#2D7A3A","#B8860B","#C05A00","#C0392B"];
  const movLabels=Object.keys(movCounts);
  const total=skuCount||1;
  return(
    <div>
      <div style={{position:"sticky",top:-16,zIndex:10,background:HR.bg,marginBottom:12,paddingTop:4,paddingBottom:8,borderBottom:`1px solid ${HR.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:6}}>
          <div style={{display:"flex",gap:0,border:`1px solid ${HR.border}`,borderRadius:5,overflow:"hidden",flexShrink:0}}>
            {PERIOD_OPTS.map(p=><button key={p.key} onClick={()=>setPeriod(p.key)} style={{padding:"4px 10px",background:period===p.key?HR.yellow:HR.white,color:period===p.key?HR.black:HR.muted,border:"none",borderRight:`1px solid ${HR.border}`,cursor:"pointer",fontSize:11,fontWeight:700,lineHeight:1.4}}>{p.label}</button>)}
          </div>
          <div style={{display:"flex",gap:0,border:`1px solid ${HR.border}`,borderRadius:5,overflow:"hidden",flexShrink:0}}>
            {DS_VIEW_OPTS.map(d=>{const di=DS_LIST.indexOf(d),col=di>=0?DS_COLORS[di].header:HR.muted,isActive=dsView===d;return <button key={d} onClick={()=>setDsView(d)} style={{padding:"4px 9px",background:isActive?(di>=0?DS_COLORS[di].header:HR.yellow):HR.white,color:isActive?HR.white:col,border:"none",borderRight:`1px solid ${HR.border}`,cursor:"pointer",fontSize:11,fontWeight:700,lineHeight:1.4}}>{d}</button>;})}
          </div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginLeft:4}}>
            {[{label:"SKUs",value:skuCount.toLocaleString(),color:HR.green},{label:"Orders",value:st.totalOrders.toLocaleString(),color:HR.yellowDark},{label:"Qty",value:st.totalQty.toLocaleString(),color:"#0077A8"},{label:"ABQ",value:st.avgOrderQty.toFixed(1),color:"#7A3DBF"}].map(c=>(
              <div key={c.label} style={{background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:5,padding:"3px 10px",display:"flex",gap:5,alignItems:"baseline"}}>
                <span style={{fontWeight:800,fontSize:13,color:c.color}}>{c.value}</span>
                <span style={{fontSize:10,color:HR.muted}}>{c.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{flex:"0 0 260px",minWidth:0}}>
            <div style={{display:"flex",gap:2,height:10,borderRadius:3,overflow:"hidden",border:`1px solid ${HR.border}`}}>
              {movLabels.map((l,i)=>{const pct=(movCounts[l]/total)*100;if(!pct)return null;return <div key={l} title={`${l}: ${movCounts[l]}`} style={{flex:pct,background:movColors[i]}}/>;})}</div>
            <div style={{display:"flex",gap:8,marginTop:3,flexWrap:"wrap"}}>
              {movLabels.map((l,i)=>movCounts[l]>0&&<span key={l} style={{fontSize:9,color:movColors[i],fontWeight:700}}>{l.replace("Super ","S.")}: {movCounts[l]}</span>)}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
            {crumbs.map((c,i)=><span key={i} style={{display:"flex",alignItems:"center",gap:5}}>{i>0&&<span style={{color:HR.muted,fontSize:11}}>›</span>}<span onClick={c.onClick} style={{fontSize:11,color:c.onClick?HR.yellowDark:HR.text,cursor:c.onClick?"pointer":"default",fontWeight:i===crumbs.length-1?700:400,textDecoration:c.onClick?"underline":"none"}}>{c.label}</span></span>)}
          </div>
        </div>
      </div>
      {!drill&&<OrgLevel slice={sliceForDs} skuMaster={skuMaster} results={results} categories={categories} dsView={dsView} onDrillCategory={cat=>setDrill({type:"category",value:cat,category:cat})}/>}
      {drill?.type==="category"&&<CategoryLevel slice={sliceForDs} skuMaster={skuMaster} results={results} category={drill.value} dsView={dsView} onDrillBrand={brand=>setDrill({type:"brand",value:brand,brand,category:drill.value})}/>}
      {drill?.type==="brand"&&<BrandLevel slice={sliceForDs} skuMaster={skuMaster} results={results} brand={drill.value} category={drill.category} dsView={dsView} onDrillSku={skuId=>setDrill({type:"sku",value:skuId,skuName:skuMaster[skuId]?.name||skuId,brand:drill.value,category:drill.category})}/>}
      {drill?.type==="sku"&&<SKULevel slice={sliceForDs} skuMaster={skuMaster} results={results} skuId={drill.value} dsView={dsView}/>}
    </div>
  );
}
function OrgLevel({slice,skuMaster,results,categories,dsView,onDrillCategory}){
  return <div>
    <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>Drill into a Category</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
      {categories.map(cat=>{const catRows=slice.filter(r=>(skuMaster[r.sku]?.category||"Unknown")===cat),cs=aggStats(catRows);return <div key={cat} onClick={()=>onDrillCategory(cat)} style={{...S.card,cursor:"pointer",borderColor:HR.border}} onMouseEnter={e=>e.currentTarget.style.borderColor=HR.yellow} onMouseLeave={e=>e.currentTarget.style.borderColor=HR.border}><div style={{fontWeight:700,color:HR.text,fontSize:12,marginBottom:4}}>{cat}</div><div style={{fontSize:10,color:HR.muted}}>{cs.skuCount} SKUs · {cs.totalOrders.toLocaleString()} orders</div><div style={{fontSize:10,color:HR.muted}}>Qty: {cs.totalQty.toLocaleString()} · ABQ: {cs.avgOrderQty.toFixed(1)}</div><div style={{fontSize:10,color:HR.yellowDark,marginTop:4,fontWeight:600}}>Drill in →</div></div>;})}
    </div>
  </div>;
}
function CategoryLevel({slice,skuMaster,results,category,dsView,onDrillBrand}){
  const catRows=slice.filter(r=>(skuMaster[r.sku]?.category||"Unknown")===category),st=aggStats(catRows),brands=[...new Set(catRows.map(r=>skuMaster[r.sku]?.brand||"Unknown"))].sort();
  return <div>
    <StatStrip items={[{label:"Unique SKUs",value:st.skuCount,color:HR.green},{label:"Total Orders",value:st.totalOrders.toLocaleString(),color:HR.yellowDark},{label:"Total Qty",value:st.totalQty.toLocaleString(),color:"#0077A8"},{label:"Avg Order Qty",value:st.avgOrderQty.toFixed(1),color:"#7A3DBF"}]}/>
    <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>Drill into a Brand</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
      {brands.map(brand=>{const bRows=catRows.filter(r=>(skuMaster[r.sku]?.brand||"Unknown")===brand),bs=aggStats(bRows);return <div key={brand} onClick={()=>onDrillBrand(brand)} style={{...S.card,cursor:"pointer",borderColor:HR.border}} onMouseEnter={e=>e.currentTarget.style.borderColor=HR.yellow} onMouseLeave={e=>e.currentTarget.style.borderColor=HR.border}><div style={{fontWeight:700,color:HR.text,fontSize:12,marginBottom:4}}>{brand}</div><div style={{fontSize:10,color:HR.muted}}>{bs.skuCount} SKUs · {bs.totalOrders.toLocaleString()} orders</div><div style={{fontSize:10,color:HR.muted}}>Qty: {bs.totalQty.toLocaleString()} · ABQ: {bs.avgOrderQty.toFixed(1)}</div><div style={{fontSize:10,color:HR.yellowDark,marginTop:4,fontWeight:600}}>Drill in →</div></div>;})}
    </div>
  </div>;
}
function BrandLevel({slice,skuMaster,results,brand,category,dsView,onDrillSku}){
  const bRows=slice.filter(r=>(skuMaster[r.sku]?.brand||"Unknown")===brand&&(skuMaster[r.sku]?.category||"Unknown")===category),st=aggStats(bRows);
  const skus=[...new Set(bRows.map(r=>r.sku))].sort((a,b)=>{const qa=bRows.filter(r=>r.sku===a).reduce((s,r)=>s+r.qty,0),qb=bRows.filter(r=>r.sku===b).reduce((s,r)=>s+r.qty,0);return qb-qa;});
  return <div>
    <StatStrip items={[{label:"SKUs",value:st.skuCount,color:HR.green},{label:"Total Orders",value:st.totalOrders.toLocaleString(),color:HR.yellowDark},{label:"Total Qty",value:st.totalQty.toLocaleString(),color:"#0077A8"},{label:"Avg Order Qty",value:st.avgOrderQty.toFixed(1),color:"#7A3DBF"}]}/>
    <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>SKUs — click to see ordering behaviour</div>
    <div style={{...S.card,padding:0,overflow:"auto",maxHeight:"50vh"}}>
      <table style={S.table}>
        <thead style={{position:"sticky",top:0}}><tr style={{background:HR.surfaceLight}}><th style={S.th}>SKU</th><th style={{...S.th,textAlign:"center"}}>Movement</th><th style={{...S.th,textAlign:"center"}}>Orders</th><th style={{...S.th,textAlign:"center"}}>Total Qty</th><th style={{...S.th,textAlign:"center"}}>ABQ</th><th style={{...S.th,textAlign:"center"}}>Min</th><th style={{...S.th,textAlign:"center"}}>Max</th></tr></thead>
        <tbody>
          {skus.map((skuId,i)=>{const skuRows=bRows.filter(r=>r.sku===skuId),ss=aggStats(skuRows),res=results[skuId],mvTag=res?Object.values(res.stores).find(s=>s.mvTag!=="Super Slow")?.mvTag||"Super Slow":"—",dsMin=dsView==="All"||dsView==="Compare"?DS_LIST.map(d=>res?.stores[d]?.min||0).reduce((a,b)=>a+b,0):res?.stores[dsView]?.min||0,dsMax=dsView==="All"||dsView==="Compare"?DS_LIST.map(d=>res?.stores[d]?.max||0).reduce((a,b)=>a+b,0):res?.stores[dsView]?.max||0;
            return <tr key={skuId} style={{background:i%2===0?HR.white:HR.surfaceLight,cursor:"pointer"}} onClick={()=>onDrillSku(skuId)}><td style={S.td}><div style={{fontWeight:600,color:HR.text,fontSize:11}}>{skuMaster[skuId]?.name||skuId}</div><div style={{fontSize:9,color:HR.muted}}>{skuId}</div></td><td style={{...S.td,textAlign:"center"}}><MovTag value={mvTag}/></td><td style={{...S.td,textAlign:"center",color:HR.yellowDark,fontWeight:700}}>{ss.totalOrders}</td><td style={{...S.td,textAlign:"center"}}>{ss.totalQty}</td><td style={{...S.td,textAlign:"center",color:"#7A3DBF",fontWeight:600}}>{ss.avgOrderQty.toFixed(1)}</td><td style={{...S.td,textAlign:"center",color:"#0077A8",fontWeight:700}}>{dsMin}</td><td style={{...S.td,textAlign:"center",color:"#0077A8",fontWeight:700}}>{dsMax}</td></tr>;
          })}
        </tbody>
      </table>
    </div>
  </div>;
}
function SKULevel({slice,skuMaster,results,skuId,dsView}){
  const skuRows=slice.filter(r=>r.sku===skuId),meta=skuMaster[skuId]||{},res=results[skuId],st=aggStats(skuRows),freqByDs={};
  DS_LIST.forEach(ds=>{const freq={};skuRows.filter(r=>r.ds===ds).forEach(r=>{freq[r.qty]=(freq[r.qty]||0)+1;});freqByDs[ds]=freq;});
  return <div>
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:6}}>
      <div><h3 style={{color:HR.yellowDark,margin:0,fontSize:14}}>{meta.name||skuId}</h3><div style={{fontSize:11,color:HR.muted,marginTop:2}}>{skuId} · {meta.category} · {meta.brand}</div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{res&&<TagPill value={res.meta.priceTag} colorMap={PRICE_TAG_COLORS}/>}{res&&<TagPill value={res.meta.t150Tag} colorMap={TOPN_TAG_COLORS}/>}</div>
    </div>
    <StatStrip items={[{label:"Total Orders",value:st.totalOrders,color:HR.yellowDark},{label:"Total Qty Sold",value:st.totalQty,color:"#0077A8"},{label:"Avg Order Qty (ABQ)",value:st.avgOrderQty.toFixed(1),color:"#7A3DBF"},{label:"Active Days",value:[...new Set(skuRows.map(r=>r.date))].length,color:HR.green}]}/>
    {res&&<div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6,marginBottom:16}}>
      {DS_LIST.map((ds,di)=>{const s=res.stores[ds]||{min:0,max:0,mvTag:"—",dailyAvg:0},dc=DS_COLORS[di];return <div key={ds} style={{background:dc.bg,borderRadius:8,padding:"8px 10px",border:`1px solid ${dc.header}44`}}><div style={{fontSize:10,fontWeight:700,color:dc.header,marginBottom:3}}>{ds}</div><div style={{fontSize:10,color:HR.muted}}>Min <span style={{color:dc.text,fontWeight:700}}>{s.min}</span> · Max <span style={{color:dc.text,fontWeight:700}}>{s.max}</span></div><div style={{marginTop:3}}><MovTag value={s.mvTag}/></div><div style={{fontSize:9,color:HR.muted,marginTop:2}}>Daily avg: {s.dailyAvg>0?s.dailyAvg.toFixed(2):"—"}</div></div>;})}
    </div>}
    <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:10}}>Order Qty Frequency — X: order qty · Y: number of orders</div>
    <SKUFreqChart freqByDs={freqByDs} selectedDs={dsView}/>
    {res&&<div style={{...S.card,marginTop:12,borderColor:DC_COLOR.header+"44",background:DC_COLOR.bg}}><div style={{fontSize:11,fontWeight:700,color:DC_COLOR.header,marginBottom:4}}>DC Level</div><div style={{fontSize:11,color:HR.textSoft}}>Movement: <span style={{color:DC_COLOR.text,fontWeight:700}}>{res.dc.mvTag}</span> · Non-Zero Days: <span style={{color:DC_COLOR.text,fontWeight:700}}>{res.dc.nonZeroDays}</span> · Min: <span style={{color:DC_COLOR.text,fontWeight:700}}>{res.dc.min}</span> · Max: <span style={{color:DC_COLOR.text,fontWeight:700}}>{res.dc.max}</span></div></div>}
  </div>;
}

// ─── Simulation ───────────────────────────────────────────────────────────────
const S2={
  card:{background:"#FFFFFF",borderRadius:8,padding:16,border:"1px solid #E0E0D0",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  tbl:{width:"100%",borderCollapse:"collapse",fontSize:11},
  th:{padding:"8px 10px",textAlign:"left",color:"#888870",background:"#F0F0E8",fontWeight:600,whiteSpace:"nowrap",fontSize:10},
  td:{padding:"6px 10px",borderTop:"1px solid #E0E0D0",verticalAlign:"middle"},
};
const MovTag2=({v})=>{const c=MOV_COLORS[v]||"#64748b";return <span style={{...TAG_STYLE,background:c+"18",color:c,border:`1px solid ${c}33`}}>{v||"—"}</span>;};
const PriceTag2=({v})=>{const c=PRICE_TAG_COLORS[v]||{bg:"#F1F5F9",color:"#64748B",border:"#CBD5E1"};return <span style={{...TAG_STYLE,background:c.bg,color:c.color,border:`1px solid ${c.border}`}}>{v||"—"}</span>;};
const DSBadge=({ds})=>{const di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];return <span style={{...TAG_STYLE,background:dc.bg,color:dc.header,border:`1px solid ${dc.header}55`}}>{ds}</span>;};
const oosColor=pct=>parseFloat(pct)>=30?"#B91C1C":parseFloat(pct)>=15?"#C05A00":parseFloat(pct)>=5?"#A16207":HR.green;

const DayStrip2=({orderLog,allDates})=>{
  const byDate={};
  orderLog.forEach(o=>{if(!byDate[o.date])byDate[o.date]={oos:0,ok:0};if(o.oos)byDate[o.date].oos++;else byDate[o.date].ok++;});
  return <div style={{display:"flex",gap:2}}>
    {allDates.map(date=>{
      const d=byDate[date],bg=!d?HR.border:d.oos>0&&d.ok===0?"#B91C1C":d.oos>0&&d.ok>0?"#F59E0B":"#16a34a";
      return <div key={date} title={date} style={{width:8,height:14,borderRadius:2,background:bg}}/>;
    })}
  </div>;
};

function OrderTable({r}){
  const days=[];let cur=null;
  r.orderLog.forEach(o=>{if(!cur||cur.date!==o.date){cur={date:o.date,orders:[]};days.push(cur);}cur.orders.push(o);});
  const di=DS_LIST.indexOf(r.dsId),dc=DS_COLORS[di>=0?di:0];
  return <div style={{padding:"12px 16px",background:"#FFFBEA",borderTop:`2px solid ${HR.yellow}`}}>
    <div style={{fontSize:11,fontWeight:700,color:HR.yellowDark,marginBottom:8}}>Order-by-order — {r.name} @ {r.dsId}</div>
    <div style={{overflowX:"auto"}}>
      <table style={{...S2.tbl,fontSize:10}}>
        <thead><tr style={{background:"#FFF9E0"}}>{["Date","Order #","Stock Before","Order Qty","Fulfilled","Short Qty","Stock After","Replenished?","Status"].map(h=><th key={h} style={{...S2.th,fontSize:9,background:"#FFF9E0"}}>{h}</th>)}</tr></thead>
        <tbody>
          {days.map(day=>[
            <tr key={day.date+"_hdr"}><td colSpan={9} style={{padding:"4px 10px",background:dc.bg,borderTop:`1px solid ${dc.header}33`,fontWeight:700,fontSize:10,color:dc.header}}>{day.date}</td></tr>,
            ...day.orders.map((o,oi)=>(
              <tr key={day.date+"_"+oi} style={{background:o.oos?"#FEE2E2":o.replenished&&oi===day.orders.length-1?"#F0FDF4":HR.white}}>
                <td style={{...S2.td,color:HR.muted,fontSize:9}}>{day.date}</td>
                <td style={{...S2.td,textAlign:"center",color:HR.muted}}>{oi+1}</td>
                <td style={{...S2.td,textAlign:"center"}}>{o.stockBefore}</td>
                <td style={{...S2.td,textAlign:"center",fontWeight:700}}>{o.qty}</td>
                <td style={{...S2.td,textAlign:"center",color:"#15803D",fontWeight:o.fulfilled>0?700:400}}>{o.fulfilled||"—"}</td>
                <td style={{...S2.td,textAlign:"center",color:"#B91C1C",fontWeight:700}}>{o.shortQty>0?o.shortQty:"—"}</td>
                <td style={{...S2.td,textAlign:"center",color:o.stockAfter===0?"#B91C1C":HR.text,fontWeight:o.stockAfter===0?700:400}}>{o.stockAfter}</td>
                <td style={{...S2.td,textAlign:"center"}}>{o.replenished&&oi===day.orders.length-1?<span style={{color:"#16a34a",fontWeight:700}}>↑ Max</span>:"—"}</td>
                <td style={{...S2.td,textAlign:"center"}}>{o.oos?<span style={{...TAG_STYLE,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}}>OOS</span>:<span style={{...TAG_STYLE,background:"#DCFCE7",color:"#15803D",border:"1px solid #BBF7D0"}}>OK</span>}</td>
              </tr>
            ))
          ])}
        </tbody>
      </table>
    </div>
  </div>;
}

function SimSKUTable({rows,allDates,skuOrdMap}){
  const [expSKU,setExpSKU]=useState(null),[expDS,setExpDS]=useState(null);
  const bySKU=useMemo(()=>{
    const m={};
    rows.forEach(r=>{if(!m[r.skuId])m[r.skuId]={skuId:r.skuId,name:r.name,category:r.category,brand:r.brand,priceTag:r.priceTag,dsRows:[]};m[r.skuId].dsRows.push(r);});
    Object.values(m).forEach(s=>s.dsRows.sort((a,b)=>b.oosInstances-a.oosInstances));
    return Object.values(m).sort((a,b)=>{const aOos=a.dsRows.reduce((s,r)=>s+r.oosInstances,0),bOos=b.dsRows.reduce((s,r)=>s+r.oosInstances,0);return bOos-aOos;});
  },[rows]);
  const toggleSKU=id=>{setExpSKU(p=>p===id?null:id);setExpDS(null);};
  const toggleDS=key=>setExpDS(p=>p===key?null:key);
  return <div style={{...S2.card,padding:0,overflow:"auto",maxHeight:"72vh"}}>
    <table style={S2.tbl}>
      <thead style={{position:"sticky",top:0,zIndex:2}}>
        <tr style={{background:HR.surfaceLight}}>
          <th style={{...S2.th,minWidth:200}}>SKU</th><th style={S2.th}>Category</th><th style={S2.th}>Movement</th><th style={S2.th}>Price</th>
          <th style={{...S2.th,textAlign:"center"}}>Failing DS</th><th style={{...S2.th,textAlign:"center"}}>OOS Instances</th>
          <th style={{...S2.th,textAlign:"center"}}>Total Instances</th><th style={{...S2.th,textAlign:"center"}}>OOS Rate</th><th style={{...S2.th,width:28}}/>
        </tr>
      </thead>
      <tbody>
        {bySKU.map((sku,i)=>{
          const isOpen=expSKU===sku.skuId,oosInst=sku.dsRows.reduce((s,r)=>s+r.oosInstances,0),totInst=sku.dsRows.reduce((s,r)=>s+r.totalInstances,0);
          const pct=totInst>0?((oosInst/totInst)*100).toFixed(1):"0.0",acc=oosColor(pct),rowBg=isOpen?"#FFFBEA":i%2===0?HR.white:HR.surfaceLight;
          return[
            <tr key={sku.skuId} style={{background:rowBg,cursor:"pointer"}} onClick={()=>toggleSKU(sku.skuId)} onMouseEnter={e=>e.currentTarget.style.background="#FFFBEA"} onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
              <td style={S2.td}><div style={{fontWeight:700,color:HR.text,fontSize:11}}>{sku.name}</div><div style={{fontSize:9,color:HR.muted,marginTop:1}}>{sku.skuId}</div></td>
              <td style={{...S2.td,color:HR.muted,fontSize:10,whiteSpace:"nowrap"}}>{sku.category}</td>
              <td style={S2.td}><MovTag2 v={sku.dsRows[0]?.mvTag}/></td>
              <td style={S2.td}><PriceTag2 v={sku.priceTag}/></td>
              <td style={{...S2.td,textAlign:"center"}}><div style={{display:"flex",gap:3,justifyContent:"center",flexWrap:"wrap"}}>{sku.dsRows.map(r=><DSBadge key={r.dsId} ds={r.dsId}/>)}</div></td>
              <td style={{...S2.td,textAlign:"center",color:"#B91C1C",fontWeight:700}}>{oosInst}</td>
              <td style={{...S2.td,textAlign:"center",color:HR.muted}}>{totInst}</td>
              <td style={{...S2.td,textAlign:"center"}}><span style={{background:acc+"18",color:acc,border:`1px solid ${acc}33`,padding:"2px 10px",borderRadius:4,fontSize:12,fontWeight:800}}>{pct}%</span></td>
              <td style={{...S2.td,textAlign:"center",color:HR.muted,fontSize:12,fontWeight:700,userSelect:"none"}}>{isOpen?"▲":"▶"}</td>
            </tr>,
            isOpen&&sku.dsRows.map(r=>{
              const dsKey=`${r.skuId}||${r.dsId}`,isDSOpen=expDS===dsKey;
              const di=DS_LIST.indexOf(r.dsId),dc=DS_COLORS[di>=0?di:0];
              const dsOosPct=r.totalInstances>0?((r.oosInstances/r.totalInstances)*100).toFixed(1):"0.0",dsAcc=oosColor(dsOosPct);
              return[
                <tr key={dsKey} style={{background:isDSOpen?"#EDF9FF":dc.bg,cursor:"pointer",borderLeft:`3px solid ${dc.header}`}} onClick={e=>{e.stopPropagation();toggleDS(dsKey);}} onMouseEnter={e=>e.currentTarget.style.background="#EDF9FF"} onMouseLeave={e=>e.currentTarget.style.background=isDSOpen?"#EDF9FF":dc.bg}>
                  <td style={{...S2.td,paddingLeft:28}}><div style={{display:"flex",alignItems:"center",gap:6}}><DSBadge ds={r.dsId}/><span style={{fontSize:9,color:HR.muted}}>Min {r.minQty} · Max {r.maxQty}</span></div></td>
                  <td style={S2.td}/><td style={S2.td}><MovTag2 v={r.mvTag}/></td><td style={S2.td}/>
                  <td style={{...S2.td,textAlign:"center"}}><DayStrip2 orderLog={r.orderLog} allDates={allDates}/></td>
                  <td style={{...S2.td,textAlign:"center",color:"#B91C1C",fontWeight:700}}>{r.oosInstances}</td>
                  <td style={{...S2.td,textAlign:"center",color:HR.muted}}>{r.totalInstances}</td>
                  <td style={{...S2.td,textAlign:"center"}}><span style={{background:dsAcc+"18",color:dsAcc,border:`1px solid ${dsAcc}33`,padding:"2px 10px",borderRadius:4,fontSize:12,fontWeight:800}}>{dsOosPct}%</span></td>
                  <td style={{...S2.td,textAlign:"center",color:HR.muted,fontSize:11,fontWeight:700,userSelect:"none"}}>{isDSOpen?"▲":"▼"}</td>
                </tr>,
                isDSOpen&&<tr key={dsKey+"_ord"}><td colSpan={9} style={{padding:0,borderTop:`2px solid ${HR.yellow}`}}><OrderTable r={r}/></td></tr>
              ];
            })
          ];
        })}
      </tbody>
    </table>
  </div>;
}

function RankTable({rows,nameLabel,nameKey,onClick}){
  const [sort,setSort]=useState({col:"oosInstances",dir:"desc"});
  const toggle=col=>setSort(s=>({col,dir:s.col===col&&s.dir==="desc"?"asc":"desc"}));
  const arrow=col=>sort.col===col?(sort.dir==="desc"?" ▼":" ▲"):" ↕";
  const sorted=useMemo(()=>{
    const enriched=rows.map(r=>({...r,pctSkus:r.totalOrderedSkus>0?(r.failSkus/r.totalOrderedSkus)*100:0,oosRate:r.totalInstances>0?(r.oosInstances/r.totalInstances)*100:0}));
    const{col,dir}=sort;
    enriched.sort((a,b)=>{const av=col===nameKey?a[nameKey]:a[col],bv=col===nameKey?b[nameKey]:b[col];if(typeof av==="string")return dir==="desc"?bv.localeCompare(av):av.localeCompare(bv);return dir==="desc"?bv-av:av-bv;});
    return enriched;
  },[rows,sort,nameKey]);
  const thS=col=>({...S2.th,textAlign:col===nameKey?"left":"center",cursor:"pointer",userSelect:"none",color:sort.col===col?HR.yellowDark:HR.muted,background:sort.col===col?"#FFFBEA":HR.surfaceLight});
  return <div style={{...S2.card,padding:0,overflow:"hidden"}}>
    <table style={S2.tbl}>
      <thead><tr>
        <th style={thS(nameKey)} onClick={()=>toggle(nameKey)}>{nameLabel}{arrow(nameKey)}</th>
        <th style={thS("failSkus")} onClick={()=>toggle("failSkus")}>Failing SKUs{arrow("failSkus")}</th>
        <th style={thS("pctSkus")} onClick={()=>toggle("pctSkus")}>% of SKUs{arrow("pctSkus")}</th>
        <th style={thS("oosInstances")} onClick={()=>toggle("oosInstances")}>OOS Instances{arrow("oosInstances")}</th>
        <th style={thS("totalInstances")} onClick={()=>toggle("totalInstances")}>Total Instances{arrow("totalInstances")}</th>
        <th style={thS("oosRate")} onClick={()=>toggle("oosRate")}>OOS Rate{arrow("oosRate")}</th>
      </tr></thead>
      <tbody>
        {sorted.map((r,i)=>{
          const oosRate=r.oosRate.toFixed(1),pctSkus=r.pctSkus.toFixed(1),acc=oosColor(oosRate);
          return <tr key={r[nameKey]} style={{background:i%2===0?HR.white:HR.surfaceLight,cursor:"pointer"}} onClick={()=>onClick(r[nameKey])} onMouseEnter={e=>e.currentTarget.style.background="#FFFBEA"} onMouseLeave={e=>e.currentTarget.style.background=i%2===0?HR.white:HR.surfaceLight}>
            <td style={{...S2.td,fontWeight:700,color:HR.text,fontSize:11}}>{r[nameKey]} <span style={{fontSize:10,color:HR.yellowDark}}>→</span></td>
            <td style={{...S2.td,textAlign:"center",color:"#B91C1C",fontWeight:700}}>{r.failSkus}</td>
            <td style={{...S2.td,textAlign:"center",color:HR.muted,fontWeight:600}}>{pctSkus}%</td>
            <td style={{...S2.td,textAlign:"center",color:"#B91C1C",fontWeight:700}}>{r.oosInstances}</td>
            <td style={{...S2.td,textAlign:"center",color:HR.muted}}>{r.totalInstances}</td>
            <td style={{...S2.td,textAlign:"center"}}><span style={{background:acc+"18",color:acc,border:`1px solid ${acc}33`,padding:"2px 10px",borderRadius:4,fontSize:12,fontWeight:800}}>{oosRate}%</span></td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

function SimSummaryCards({oosInstances,totalInstances,failSkus,totalOrderedSkus}){
  const oosRate=totalInstances>0?((oosInstances/totalInstances)*100).toFixed(1):"0.0",pctSkus=totalOrderedSkus>0?((failSkus/totalOrderedSkus)*100).toFixed(1):"0.0",acc=oosColor(oosRate);
  return <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
    <div style={{...S2.card,borderLeft:`4px solid ${acc}`}}><div style={{fontSize:32,fontWeight:900,color:acc}}>{oosRate}%</div><div style={{fontSize:12,color:acc,fontWeight:700,marginTop:2}}>OOS Rate — north star metric</div><div style={{fontSize:11,color:HR.muted,marginTop:3}}>{oosInstances} OOS instances out of {totalInstances} total</div></div>
    <div style={{...S2.card,borderLeft:"4px solid #C05A00"}}><div style={{fontSize:32,fontWeight:900,color:"#B91C1C"}}>{failSkus}<span style={{fontSize:14,opacity:0.5,marginLeft:4}}>/ {totalOrderedSkus}</span></div><div style={{fontSize:12,color:"#C05A00",fontWeight:700,marginTop:2}}>{pctSkus}% of SKUs with at least one OOS</div><div style={{fontSize:11,color:HR.muted,marginTop:3}}>SKUs ordered in the 15-day window</div></div>
  </div>;
}

function buildSimData(invoiceData,results){
  if(!invoiceData.length||!results)return[];
  const allDates=[...new Set(invoiceData.map(r=>r.date))].sort(),simDates=allDates.slice(-15);
  if(!simDates.length)return[];
  const out=[];
  Object.entries(results).forEach(([skuId,res])=>{
    DS_LIST.forEach(dsId=>{
      const maxQty=res.stores[dsId]?.max||0,minQty=res.stores[dsId]?.min||0;
      if(!maxQty)return;
      const lines=invoiceData.filter(r=>r.sku===skuId&&r.ds===dsId&&simDates.includes(r.date));
      if(!lines.length)return;
      let stock=maxQty,oosInstances=0;
      const finalLog=[];
      simDates.forEach(date=>{
        const dayLines=lines.filter(l=>l.date===date);
        dayLines.forEach((line,li)=>{
          const stockBefore=stock,fulfilled=Math.min(line.qty,stock),shortQty=line.qty-fulfilled,oos=shortQty>0;
          if(oos)oosInstances++;
          stock=Math.max(0,stock-line.qty);
          const isLastOfDay=li===dayLines.length-1,replenished=isLastOfDay&&stock<=minQty;
          finalLog.push({date:line.date,qty:line.qty,stockBefore,fulfilled,shortQty,oos,stockAfter:stock,replenished});
          if(replenished)stock=maxQty;
        });
      });
      if(oosInstances>0)out.push({skuId,dsId,name:res.meta.name||skuId,category:res.meta.category||"Unknown",brand:res.meta.brand||"Unknown",mvTag:res.stores[dsId]?.mvTag||"—",priceTag:res.meta.priceTag||"—",minQty,maxQty,oosInstances,totalInstances:lines.length,orderLog:finalLog});
    });
  });
  out.sort((a,b)=>b.oosInstances-a.oosInstances);
  return out;
}

function buildGroupRows(simData,windowRows,groupFn){
  const ordMap={},failMap={};
  windowRows.forEach(r=>{const g=groupFn(r,"ord");if(!g)return;if(!ordMap[g])ordMap[g]={skus:new Set(),instances:0};ordMap[g].skus.add(r.sku);ordMap[g].instances++;});
  simData.forEach(r=>{const g=groupFn(r,"fail");if(!g)return;if(!failMap[g])failMap[g]={skus:new Set(),oosInstances:0,totalInstances:0};failMap[g].skus.add(r.skuId);failMap[g].oosInstances+=r.oosInstances;failMap[g].totalInstances+=r.totalInstances;});
  return[...new Set([...Object.keys(ordMap),...Object.keys(failMap)])].map(g=>{const o=ordMap[g]||{skus:new Set(),instances:0},f=failMap[g]||{skus:new Set(),oosInstances:0,totalInstances:0};return{name:g,failSkus:f.skus.size,totalOrderedSkus:o.skus.size,oosInstances:f.oosInstances,totalInstances:f.totalInstances||o.instances};}).filter(r=>r.oosInstances>0).sort((a,b)=>b.oosInstances-a.oosInstances);
}
function buildSKUOrdMap(windowRows){const m={};windowRows.forEach(r=>{if(!m[r.sku])m[r.sku]={total:0};m[r.sku].total++;});return m;}

function ProblematicSKUs({simData,allDates}){
  const [topN,setTopN]=useState(10);
  const bySKU=useMemo(()=>{const m={};simData.forEach(r=>{if(!m[r.skuId])m[r.skuId]={skuId:r.skuId,name:r.name,category:r.category,brand:r.brand,priceTag:r.priceTag,mvTag:r.mvTag,oosInstances:0,totalInstances:0};m[r.skuId].oosInstances+=r.oosInstances;m[r.skuId].totalInstances+=r.totalInstances;});return Object.values(m).sort((a,b)=>b.oosInstances-a.oosInstances);},[simData]);
  const visible=topN==="All"?bySKU:bySKU.slice(0,topN);
  if(!bySKU.length)return null;
  const skuOrdMap=useMemo(()=>{const m={};simData.forEach(r=>{if(!m[r.skuId])m[r.skuId]={ordPairs:0};m[r.skuId].ordPairs+=r.totalInstances;});return m;},[simData]);
  const visibleSkuIds=new Set(visible.map(s=>s.skuId)),visibleRows=simData.filter(r=>visibleSkuIds.has(r.skuId));
  return <div style={{marginTop:24}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,flexWrap:"wrap",gap:6}}>
      <div style={{fontSize:12,fontWeight:700,color:HR.text}}>🚨 Problematic SKUs <span style={{fontSize:10,color:HR.muted,fontWeight:400,marginLeft:6}}>sorted by OOS Instances · click to expand</span></div>
      <div style={{display:"flex",gap:0,border:`1px solid ${HR.border}`,borderRadius:4,overflow:"hidden"}}>
        {[10,20,"All"].map(n=><button key={n} onClick={()=>setTopN(n)} style={{padding:"4px 10px",fontSize:10,fontWeight:700,border:"none",cursor:"pointer",background:topN===n?HR.yellow:HR.white,color:topN===n?HR.black:HR.muted,borderRight:`1px solid ${HR.border}`}}>Top {n}</button>)}
      </div>
    </div>
    <SimSKUTable rows={visibleRows} allDates={allDates} skuOrdMap={skuOrdMap}/>
    {topN!=="All"&&bySKU.length>topN&&<div style={{fontSize:10,color:HR.muted,textAlign:"center",marginTop:6}}>Showing {topN} of {bySKU.length} problematic SKUs</div>}
  </div>;
}

function SimOrgLevel({simData,allDates,invoiceData,skuMeta,onDrillCategory}){
  const win=invoiceData.filter(r=>allDates.includes(r.date)),oosInst=simData.reduce((s,r)=>s+r.oosInstances,0),failSkus=new Set(simData.map(r=>r.skuId)).size,totSkus=new Set(win.map(r=>r.sku)).size;
  const rows=buildGroupRows(simData,win,(r,m)=>m==="ord"?(r.category||"Unknown"):(r.category||"Unknown"));
  return <div><SimSummaryCards oosInstances={oosInst} totalInstances={win.length} failSkus={failSkus} totalOrderedSkus={totSkus}/><div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>Categories</div><RankTable rows={rows} nameLabel="Category" nameKey="name" onClick={onDrillCategory}/><ProblematicSKUs simData={simData} allDates={allDates}/></div>;
}
function SimCategoryLevel({simData,allDates,invoiceData,skuMeta,category,onDrillBrand}){
  const scope=simData.filter(r=>(r.category||"Unknown")===category),win=invoiceData.filter(r=>allDates.includes(r.date)&&(skuMeta[r.sku]?.category||"Unknown")===category);
  const oosInst=scope.reduce((s,r)=>s+r.oosInstances,0),failSkus=new Set(scope.map(r=>r.skuId)).size,totSkus=new Set(win.map(r=>r.sku)).size;
  const rows=buildGroupRows(scope,win,(r,m)=>m==="ord"?(skuMeta[r.sku]?.brand||"Unknown"):(r.brand||"Unknown"));
  return <div><SimSummaryCards oosInstances={oosInst} totalInstances={win.length} failSkus={failSkus} totalOrderedSkus={totSkus}/><div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>Brands in <span style={{color:HR.yellowDark}}>{category}</span></div><RankTable rows={rows} nameLabel="Brand" nameKey="name" onClick={onDrillBrand}/></div>;
}
function SimBrandLevel({simData,allDates,invoiceData,skuMeta,category,brand}){
  const scope=simData.filter(r=>(r.category||"Unknown")===category&&(r.brand||"Unknown")===brand),win=invoiceData.filter(r=>allDates.includes(r.date)&&(skuMeta[r.sku]?.category||"Unknown")===category&&(skuMeta[r.sku]?.brand||"Unknown")===brand);
  const oosInst=scope.reduce((s,r)=>s+r.oosInstances,0),failSkus=new Set(scope.map(r=>r.skuId)).size,totSkus=new Set(win.map(r=>r.sku)).size,skuOrdMap=buildSKUOrdMap(win);
  return <div><SimSummaryCards oosInstances={oosInst} totalInstances={win.length} failSkus={failSkus} totalOrderedSkus={totSkus}/><div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>Failing SKUs — <span style={{color:HR.yellowDark}}>{brand}</span><span style={{color:HR.muted,fontWeight:400}}> · {category}</span></div><SimSKUTable rows={scope} allDates={allDates} skuOrdMap={skuOrdMap}/></div>;
}
function SimSKULevel({simData,allDates,invoiceData,skuId}){
  const rows=simData.filter(r=>r.skuId===skuId);
  if(!rows.length)return <div style={{color:HR.muted,padding:32,textAlign:"center"}}>No OOS data.</div>;
  const win=invoiceData.filter(r=>allDates.includes(r.date)&&r.sku===skuId),skuOrdMap=buildSKUOrdMap(win),m=rows[0];
  return <div><div style={{marginBottom:12}}><div style={{fontWeight:800,fontSize:16,color:HR.text}}>{m.name}</div><div style={{fontSize:11,color:HR.muted,marginTop:2}}>{skuId} · {m.category} · {m.brand}</div></div><SimSKUTable rows={rows} allDates={allDates} skuOrdMap={skuOrdMap}/></div>;
}

function SimulationTab({invoiceData,results,skuMaster,params}){
  const [drill,setDrill]=useState(null),[dsFilter,setDsFilter]=useState("All");
  const simDataFull=useMemo(()=>buildSimData(invoiceData,results),[invoiceData,results]);
  const simData=useMemo(()=>dsFilter==="All"?simDataFull:simDataFull.filter(r=>r.dsId===dsFilter),[simDataFull,dsFilter]);
  const allDates=useMemo(()=>[...new Set(invoiceData.map(r=>r.date))].sort().slice(-15),[invoiceData]);
  const skuMeta=useMemo(()=>{const m={};Object.values(results||{}).forEach(r=>{m[r.meta.sku]=r.meta;});return m;},[results]);
  const handleDSFilter=ds=>{setDsFilter(ds);setDrill(null);};
  const inv=dsFilter==="All"?invoiceData:invoiceData.filter(r=>r.ds===dsFilter);
  const winRows=useMemo(()=>inv.filter(r=>allDates.includes(r.date)),[inv,allDates]);
  const oosInst=simData.reduce((s,r)=>s+r.oosInstances,0);
  const totInst=winRows.length;
  const failSkus=new Set(simData.map(r=>r.skuId)).size;
  const totSkus=new Set(winRows.map(r=>r.sku)).size;
  const oosRate=totInst>0?((oosInst/totInst)*100).toFixed(1):"0.0";
  const acc=oosColor(oosRate);
  if(!invoiceData.length||!results)return <div style={{textAlign:"center",padding:80}}><div style={{fontSize:40,marginBottom:12}}>🔬</div><div style={{color:HR.muted,fontSize:14}}>No data available</div></div>;
  const crumbs=[
    {label:"All Categories",onClick:drill?()=>setDrill(null):null},
    ...(drill?.type==="category"||drill?.type==="brand"||drill?.type==="sku"?[{label:drill.category||drill.value,onClick:drill.type!=="category"?()=>setDrill({type:"category",value:drill.category||drill.value,category:drill.category||drill.value}):null}]:[]),
    ...(drill?.type==="brand"||drill?.type==="sku"?[{label:drill.brand,onClick:drill.type!=="brand"?()=>setDrill({type:"brand",value:drill.brand,brand:drill.brand,category:drill.category}):null}]:[]),
    ...(drill?.type==="sku"?[{label:simData.find(r=>r.skuId===drill.value)?.name||drill.value}]:[]),
  ];
  return <div>
    <div style={{position:"sticky",top:-16,zIndex:10,background:HR.bg,paddingTop:4,paddingBottom:8,marginBottom:12,borderBottom:`1px solid ${HR.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:6}}>
        <span style={{fontWeight:800,fontSize:14,color:HR.yellowDark,whiteSpace:"nowrap"}}>Simulation — Last 15 Days</span>
        {allDates.length>0&&<span style={{fontSize:10,color:HR.muted,whiteSpace:"nowrap"}}>{allDates[0]} → {allDates[allDates.length-1]}</span>}
        <div style={{display:"flex",gap:0,border:`1px solid ${HR.border}`,borderRadius:5,overflow:"hidden",flexShrink:0}}>
          {["All",...DS_LIST].map(ds=>{const di=DS_LIST.indexOf(ds),dc=di>=0?DS_COLORS[di]:null,isActive=dsFilter===ds;return <button key={ds} onClick={()=>handleDSFilter(ds)} style={{padding:"4px 10px",background:isActive?(dc?dc.header:HR.yellow):(dc?dc.bg:HR.white),color:isActive?(dc?HR.white:HR.black):(dc?dc.header:HR.muted),border:"none",borderRight:`1px solid ${HR.border}`,cursor:"pointer",fontSize:11,fontWeight:700,lineHeight:1.4}}>{ds}</button>;})}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <div style={{background:acc+"18",border:`1px solid ${acc}44`,borderRadius:5,padding:"3px 10px",display:"flex",gap:5,alignItems:"baseline"}}>
          <span style={{fontWeight:800,fontSize:14,color:acc}}>{oosRate}%</span>
          <span style={{fontSize:10,color:acc,fontWeight:600}}>OOS Rate</span>
        </div>
        <div style={{background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:5,padding:"3px 10px",display:"flex",gap:5,alignItems:"baseline"}}>
          <span style={{fontWeight:800,fontSize:13,color:"#B91C1C"}}>{oosInst}</span>
          <span style={{fontSize:10,color:HR.muted}}>OOS instances</span>
          <span style={{fontSize:10,color:HR.muted}}>/ {totInst} total</span>
        </div>
        <div style={{background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:5,padding:"3px 10px",display:"flex",gap:5,alignItems:"baseline"}}>
          <span style={{fontWeight:800,fontSize:13,color:"#B91C1C"}}>{failSkus}</span>
          <span style={{fontSize:10,color:HR.muted}}>failing SKUs</span>
          <span style={{fontSize:10,color:HR.muted}}>/ {totSkus}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5,marginLeft:4,flexWrap:"wrap"}}>
          {crumbs.map((c,i)=><span key={i} style={{display:"flex",alignItems:"center",gap:5}}>{i>0&&<span style={{color:HR.muted,fontSize:11}}>›</span>}<span onClick={c.onClick||undefined} style={{fontSize:11,color:c.onClick?HR.yellowDark:HR.text,cursor:c.onClick?"pointer":"default",fontWeight:i===crumbs.length-1?700:400,textDecoration:c.onClick?"underline":"none"}}>{c.label}</span></span>)}
        </div>
      </div>
    </div>
    {simData.length===0
      ?<div style={{...S2.card,textAlign:"center",padding:40}}><div style={{fontSize:32,marginBottom:10}}>✅</div><div style={{fontWeight:700,color:HR.green,fontSize:14}}>No OOS instances detected</div><div style={{color:HR.muted,fontSize:12,marginTop:4}}>Every order line was fulfilled in the last 15 days.</div></div>
      :(()=>{return <>
        {!drill&&<SimOrgLevel simData={simData} allDates={allDates} invoiceData={inv} skuMeta={skuMeta} onDrillCategory={cat=>setDrill({type:"category",value:cat,category:cat})}/>}
        {drill?.type==="category"&&<SimCategoryLevel simData={simData} allDates={allDates} invoiceData={inv} skuMeta={skuMeta} category={drill.value} onDrillBrand={brand=>setDrill({type:"brand",value:brand,brand,category:drill.value})}/>}
        {drill?.type==="brand"&&<SimBrandLevel simData={simData} allDates={allDates} invoiceData={inv} skuMeta={skuMeta} category={drill.category} brand={drill.value}/>}
        {drill?.type==="sku"&&<SimSKULevel simData={simData} allDates={allDates} invoiceData={inv} skuId={drill.value}/>}
      </>;})()} 
  </div>;
}

// ─── Admin Login Modal ────────────────────────────────────────────────────────
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

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App(){
  const [tab,setTab]=useState("dashboard"),[pendingTab,setPending]=useState(null);
  const [invoiceData,setInv]=useState([]),[skuMaster,setSKU]=useState({});
  const [minReqQty,setMRQ]=useState({}),[newSKUQty,setNSQ]=useState({});
  const [deadStock,setDead]=useState(new Set()),[priceData,setPrice]=useState({});
  const [results,setResults]=useState(null),[loading,setLoading]=useState(false),[dataLoaded,setLoaded]=useState(false);
  const [filterDS,setFilterDS]=useState("All"),[filterCat,setFilterCat]=useState("All"),[filterMov,setFilterMov]=useState("All"),[search,setSearch]=useState("");
  const [params,setParams]=useState(DEFAULT_PARAMS),[savedParams,setSaved]=useState(DEFAULT_PARAMS);
  const [newBrand,setNewBrand]=useState(""),[newBrandDays,setNBD]=useState(1);
  const [qaOpen,setQaOpen]=useState(false),[qaText,setQaText]=useState(""),[qaDiffs,setQaDiffs]=useState(null);
  const [qaFilterDS,setQaFDS]=useState("All"),[qaFilterMv,setQaFMv]=useState("All"),[qaFilterSp,setQaFSp]=useState("All"),[qaFilterPr,setQaFPr]=useState("All");
  const [isAdmin,setIsAdmin]=useState(()=>localStorage.getItem("adminSession")==="true");
  const [showLoginModal,setShowLoginModal]=useState(false);
  // NEW: track whether team data was loaded from published file
  const [teamDataLoaded,setTeamDataLoaded]=useState(false);
  const [publishStatus,setPublishStatus]=useState(null); // "saving" | "done" | "error"

  const handleLogout=()=>{localStorage.removeItem("adminSession");setIsAdmin(false);setQaOpen(false);};

  const hasChanges=JSON.stringify(params)!==JSON.stringify(savedParams);
  const changedCount=[params.overallPeriod!==savedParams.overallPeriod,params.recencyWindow!==savedParams.recencyWindow,JSON.stringify(params.recencyWt)!==JSON.stringify(savedParams.recencyWt),JSON.stringify(params.movIntervals)!==JSON.stringify(savedParams.movIntervals),JSON.stringify(params.priceTiers)!==JSON.stringify(savedParams.priceTiers),params.spikeMultiplier!==savedParams.spikeMultiplier,params.spikePctFrequent!==savedParams.spikePctFrequent,params.spikePctOnce!==savedParams.spikePctOnce,params.maxDaysBuffer!==savedParams.maxDaysBuffer,params.abqMaxMultiplier!==savedParams.abqMaxMultiplier,JSON.stringify(params.baseMinDays)!==JSON.stringify(savedParams.baseMinDays),JSON.stringify(params.brandBuffer)!==JSON.stringify(savedParams.brandBuffer),JSON.stringify(params.newDSList)!==JSON.stringify(savedParams.newDSList),params.newDSFloorTopN!==savedParams.newDSFloorTopN,params.activeDSCount!==savedParams.activeDSCount,JSON.stringify(params.dcMult)!==JSON.stringify(savedParams.dcMult),JSON.stringify(params.dcDeadMult)!==JSON.stringify(savedParams.dcDeadMult)].filter(Boolean).length;

  // ── On mount: try loading published team data first, then fall back to localStorage ──
  useEffect(()=>{
    (async()=>{
      // 1. Try to load published data bundle from /public/team-data.json
      try{
        const res=await fetch("/team-data.json?v="+Date.now());
        if(res.ok){
          const bundle=await res.json();
          if(bundle.invoiceData?.length&&bundle.skuMaster){
            setInv(bundle.invoiceData);
            setSKU(bundle.skuMaster);
            if(bundle.minReqQty)setMRQ(bundle.minReqQty);
            if(bundle.newSKUQty)setNSQ(bundle.newSKUQty);
            if(bundle.deadStock)setDead(new Set(bundle.deadStock));
            if(bundle.priceData)setPrice(bundle.priceData);
            if(bundle.params){const p={...DEFAULT_PARAMS,...bundle.params};setParams(p);setSaved(p);}
            setLoaded(true);
            setTeamDataLoaded(true);
            return; // skip localStorage load
          }
        }
      }catch(e){}

      // 2. Fall back to localStorage (admin's own session)
      try{
        const keys=["invoiceData","skuMaster","minReqQty","newSKUQty","deadStock","priceData","params"];
        const vals=keys.map(k=>LS.get(k));
        const [inv,sku,mrq,nsq,ds,pd,lp]=vals;
        if(inv)setInv(JSON.parse(inv.value));
        if(sku)setSKU(JSON.parse(sku.value));
        if(mrq)setMRQ(JSON.parse(mrq.value));
        if(nsq)setNSQ(JSON.parse(nsq.value));
        if(ds)setDead(new Set(JSON.parse(ds.value)));
        if(pd)setPrice(JSON.parse(pd.value));
        if(lp){const p={...DEFAULT_PARAMS,...JSON.parse(lp.value)};setParams(p);setSaved(p);}
        if(inv&&sku)setLoaded(true);
      }catch(e){}
    })();
  },[]);

  useEffect(()=>{if(dataLoaded)triggerModel(invoiceData,skuMaster,minReqQty,newSKUQty,deadStock,priceData,params);},[dataLoaded]);

  const triggerModel=(inv,sku,mrq,nsq,ds,pd,p)=>{
    setLoading(true);
    setTimeout(()=>{try{const res=runEngine(inv,sku,mrq,pd,ds,nsq,p);setResults(res);setTab("dashboard");}catch(err){console.error(err);alert("Model error: "+err.message);}setLoading(false);},50);
  };

  // ── Publish: export all data as a JSON file for admin to place in /public ──
  const handlePublish=()=>{
    setPublishStatus("saving");
    try{
      const bundle={
        invoiceData,
        skuMaster,
        minReqQty,
        newSKUQty,
        deadStock:[...deadStock],
        priceData,
        params,
        publishedAt:new Date().toISOString(),
      };
      const blob=new Blob([JSON.stringify(bundle)],{type:"application/json"});
      const a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download="team-data.json";
      a.click();
      setPublishStatus("done");
      setTimeout(()=>setPublishStatus(null),8000);
    }catch(e){
      setPublishStatus("error");
      setTimeout(()=>setPublishStatus(null),5000);
    }
  };

  const handleInvoice=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;setLoading(true);
    const rows=parseCSV(await file.text());
    const newE=rows.map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0)})).filter(r=>r.date&&r.sku&&r.qty>0);
    const all=[...invoiceData,...newE],dates=[...new Set(all.map(r=>r.date))].sort();
    const cutoff=dates.length>ROLLING_DAYS?dates[dates.length-ROLLING_DAYS]:dates[0],filtered=all.filter(r=>r.date>=cutoff);
    setInv(filtered);LS.set("invoiceData",JSON.stringify(filtered));
    const hasSku=Object.keys(skuMaster).length>0;setLoaded(hasSku);
    if(hasSku)triggerModel(filtered,skuMaster,minReqQty,newSKUQty,deadStock,priceData,params);else setLoading(false);
    e.target.value="";
  },[invoiceData,skuMaster,minReqQty,newSKUQty,deadStock,priceData,params]);

  const handleSKU=useCallback(async(e)=>{
    const file=e.target.files[0];if(!file)return;setLoading(true);
    const rows=parseCSV(await file.text());const master={};
    rows.forEach(r=>{const s=r["SKU"]||"";if(s)master[s]={sku:s,name:r["Name"]||"",category:r["Category"]||r["Category Name"]||"",brand:r["Brand"]||"",status:r["Status"]||"Active",inventorisedAt:r["Inventorised At"]||"DS"};});
    setSKU(master);LS.set("skuMaster",JSON.stringify(master));
    const hasInv=invoiceData.length>0;setLoaded(hasInv);
    if(hasInv)triggerModel(invoiceData,master,minReqQty,newSKUQty,deadStock,priceData,params);else setLoading(false);
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
  const applyAndRun=async(p)=>{
    const np=p||params;setParams(np);setSaved(np);
    LS.set("params",JSON.stringify(np));
    if(dataLoaded)triggerModel(invoiceData,skuMaster,minReqQty,newSKUQty,deadStock,priceData,np);
  };
  const handleTabClick=t=>{if(tab==="logic"&&hasChanges&&isAdmin)setPending(t);else setTab(t);};
  const runQA=()=>{if(!results||!qaText.trim()){alert("Upload data and run model first.");return;}const rows=parseQACSV(qaText);if(!rows.length){alert("Could not parse CSV.");return;}setQaDiffs(buildDiff(rows,results));setQaFDS("All");setQaFMv("All");setQaFSp("All");setQaFPr("All");};

  const soldSKUs=new Set(invoiceData.map(r=>r.sku));
  const activeMaster=Object.values(skuMaster).filter(s=>(s.status||"").toLowerCase()==="active");
  const uniqueSold=[...soldSKUs].filter(s=>skuMaster[s]&&(skuMaster[s].status||"").toLowerCase()==="active").length;
  const zeroSale=activeMaster.filter(s=>!soldSKUs.has(s.sku)).length;
  const dateRange=invoiceData.length>0?(()=>{const d=[...new Set(invoiceData.map(r=>r.date))].sort();return `${d[0]} → ${d[d.length-1]} (${d.length} days)`;})():"No data";
  const missing=[...soldSKUs].filter(s=>!skuMaster[s]||(skuMaster[s].status||"").toLowerCase()!=="active");
  const allResults=results?Object.values(results):[];
  const categories=[...new Set(allResults.map(r=>r.meta.category))].sort();
  const displayDS=filterDS==="All"?DS_LIST:[filterDS];
  const filtered=allResults.filter(r=>{
    if(filterCat!=="All"&&r.meta.category!==filterCat)return false;
    if(filterMov!=="All"&&Object.values(r.stores).every(s=>s.mvTag!==filterMov))return false;
    if(search&&!r.meta.sku.toLowerCase().includes(search.toLowerCase())&&!r.meta.name.toLowerCase().includes(search.toLowerCase()))return false;
    return true;
  });

  const qaDS=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.ds))]:["All"];
  const qaMv=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.mvTag))]:["All"];
  const qaSp=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.spTag))]:["All"];
  const qaPr=qaDiffs?["All",...new Set(qaDiffs.map(d=>d.prTag))]:["All"];
  const qaFiltered=qaDiffs?qaDiffs.filter(d=>(qaFilterDS==="All"||d.ds===qaFilterDS)&&(qaFilterMv==="All"||d.mvTag===qaFilterMv)&&(qaFilterSp==="All"||d.spTag===qaFilterSp)&&(qaFilterPr==="All"||d.prTag===qaFilterPr)):[];

  const mi=params.movIntervals||[2,4,7,10],pt=params.priceTiers||[3000,1500,400,100],bb=params.brandBuffer||DEFAULT_BRAND_BUFFER;
  const rw2=params.recencyWt||RECENCY_WT_DEFAULT,dcM=params.dcMult||DC_MULT_DEFAULT;
  const movColors=["#16a34a","#2D7A3A","#B8860B","#C05A00","#C0392B"],priceColors=["#B91C1C","#C2410C","#A16207","#475569","#64748B"];

  // Nav tabs — non-admins only see 4 tabs
  const ADMIN_TABS=[["dashboard","Dashboard"],["insights","Insights"],["simulation","Simulation"],["output","Min/Max Output"],["upload","Upload Data"],["logic","Logic Tweaker"]];
  const PUBLIC_TABS=[["dashboard","Dashboard"],["insights","Insights"],["simulation","Simulation"],["output","Min/Max Output"]];
  const NAV_TABS=isAdmin?ADMIN_TABS:PUBLIC_TABS;

  return(
    <div style={S.app}>
      {/* Header */}
      <div style={S.header}>
        <HomeRunLogo/>
        <div style={{fontSize:10,color:HR.muted,marginLeft:4}}>{dateRange}</div>
        {teamDataLoaded&&<span style={{fontSize:9,color:HR.green,background:"#DCFCE7",border:"1px solid #BBF7D0",borderRadius:3,padding:"1px 6px",fontWeight:600}}>Team Data</span>}
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

      {/* QA Panel */}
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

        {/* UPLOAD TAB — admin only */}
        {tab==="upload"&&isAdmin&&(
          <div style={{maxWidth:680}}>
            <h2 style={{color:HR.yellowDark,marginBottom:4,fontSize:16}}>Upload Data</h2>
            <p style={{color:HR.muted,fontSize:13,marginBottom:14}}>Upload CSVs to power the model. Invoice data stored as rolling 90-day window.</p>

            {[
              {label:"Invoice Dump",desc:"Columns: Invoice Date, SKU, Line Item Location Name, Quantity",handler:handleInvoice,count:`${invoiceData.length.toLocaleString()} rows`,key:"invoiceData",required:true,hasData:invoiceData.length>0},
              {label:"SKU Master",desc:"Columns: Name, SKU, Category, Brand, Status, Inventorised At",handler:handleSKU,count:`${Object.keys(skuMaster).length.toLocaleString()} SKUs`,key:"skuMaster",required:true,hasData:Object.keys(skuMaster).length>0},
              {label:"Purchase by Item",desc:"Columns: sku, average_price",handler:handlePrice,count:`${Object.keys(priceData).length.toLocaleString()} SKUs`,key:"priceData",required:false,hasData:Object.keys(priceData).length>0},
              {label:"New DS Floor Qty",desc:"Columns: SKU, Qty",handler:handleMRQ,count:`${Object.keys(minReqQty).length.toLocaleString()} SKUs`,key:"minReqQty",required:false,hasData:Object.keys(minReqQty).length>0},
              {label:"New SKU Qty",desc:"Per-store manual floor qtys. Columns: SKU, DS01–DS05",handler:handleNSQ,count:`${Object.keys(newSKUQty).length.toLocaleString()} SKUs`,key:"newSKUQty",required:false,hasData:Object.keys(newSKUQty).length>0},
              {label:"Dead Stock List",desc:"Column: Dead Stock (SKU list)",handler:handleDead,count:`${deadStock.size.toLocaleString()} SKUs`,key:"deadStock",required:false,hasData:deadStock.size>0},
            ].map(item=>(
              <div key={item.label} style={{...S.card,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontWeight:700,color:HR.text,marginBottom:2,fontSize:13}}>{item.label} {item.required&&<span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>}</div>
                    <div style={{fontSize:11,color:HR.muted,marginBottom:10}}>{item.desc}</div>
                  </div>
                  <div style={{fontSize:11,color:HR.green,whiteSpace:"nowrap",marginLeft:12,fontWeight:600}}>{item.count}</div>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <label style={{background:HR.green,color:HR.white,padding:"6px 14px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:600}}>
                    Choose CSV <input type="file" accept=".csv" onChange={item.handler} style={{display:"none"}}/>
                  </label>
                  {item.hasData&&<button onClick={()=>clearData(item.key)} style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"6px 12px",borderRadius:5,cursor:"pointer",fontSize:12}}>🗑 Delete</button>}
                </div>
              </div>
            ))}

            {dataLoaded&&<button onClick={()=>applyAndRun(params)} style={{...S.runBtn,marginTop:6}}>▶ Re-run Model</button>}

            {/* ── Publish to Team ── */}
            {dataLoaded&&results&&(
              <div style={{...S.card,marginTop:20,borderColor:HR.yellow,background:"#FFFBEA"}}>
                <div style={{fontWeight:700,color:HR.yellowDark,fontSize:14,marginBottom:4}}>📤 Publish to Team</div>
                <div style={{fontSize:12,color:HR.textSoft,marginBottom:12}}>
                  Downloads a <code style={{color:HR.yellowDark}}>team-data.json</code> file bundling all current data. Place it in your project's <code style={{color:HR.yellowDark}}>public/</code> folder, then push to GitHub — your team will see it automatically.
                </div>
                <button onClick={handlePublish} style={{background:HR.yellow,color:HR.black,border:"none",padding:"9px 24px",borderRadius:7,cursor:"pointer",fontWeight:700,fontSize:13}}>
                  ⬇ Download team-data.json
                </button>
                {publishStatus==="done"&&(
                  <div style={{marginTop:12,background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:6,padding:"10px 14px",fontSize:12,color:"#15803D"}}>
                    <div style={{fontWeight:700,marginBottom:4}}>✅ File downloaded! Next steps:</div>
                    <div>1. Move <code>team-data.json</code> into your project's <code>public/</code> folder</div>
                    <div style={{marginTop:3}}>2. In terminal: <code style={{background:"#E0F7E9",padding:"1px 5px",borderRadius:3}}>git add . && git commit -m "Publish team data" && git push</code></div>
                    <div style={{marginTop:3}}>3. Vercel deploys in ~2 min — your team sees the new data 🎉</div>
                  </div>
                )}
                {publishStatus==="error"&&<div style={{marginTop:10,color:"#B91C1C",fontSize:12}}>❌ Something went wrong. Try again.</div>}
              </div>
            )}

            {missing.length>0&&(
              <div style={{...S.card,marginTop:20,border:`1px solid ${HR.yellow}`}}>
                <div style={{fontWeight:700,color:HR.yellowDark,marginBottom:3,fontSize:13}}>⚠ {missing.length} SKUs in Invoice not Active in SKU Master</div>
                <div style={{fontSize:11,color:HR.muted,marginBottom:10}}>These SKUs have sales but are missing or inactive in SKU Master.</div>
                <div style={{maxHeight:180,overflowY:"auto"}}>
                  <table style={S.table}><thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>SKU</th><th style={S.th}>Status in Master</th></tr></thead>
                    <tbody>{missing.map((s,i)=><tr key={s} style={{background:i%2===0?HR.white:HR.surfaceLight}}><td style={S.td}>{s}</td><td style={{...S.td,color:skuMaster[s]?HR.yellowDark:"#B91C1C",fontSize:11}}>{skuMaster[s]?skuMaster[s].status:"Not in SKU Master"}</td></tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* DASHBOARD TAB */}
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
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
                {[{label:"Active SKUs",value:activeMaster.length,color:HR.green},{label:"Active SKUs Sold",value:uniqueSold,color:HR.yellowDark},{label:"Zero Sale SKUs",value:zeroSale,color:"#C05A00"},{label:"Dead Stock SKUs",value:deadStock.size,color:"#B91C1C"}].map(c=>(
                  <div key={c.label} style={{...S.card,borderLeft:`3px solid ${c.color}`,padding:"8px 12px"}}><div style={{fontSize:22,fontWeight:800,color:c.color}}>{c.value.toLocaleString()}</div><div style={{fontSize:10,color:HR.muted,marginTop:2}}>{c.label}</div></div>
                ))}
              </div>
              <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
                <input placeholder="Search SKU or name..." value={search} onChange={e=>setSearch(e.target.value)} style={{...S.input,width:180}}/>
                <select value={filterDS} onChange={e=>setFilterDS(e.target.value)} style={S.input}><option value="All">All Stores</option>{DS_LIST.map(d=><option key={d}>{d}</option>)}</select>
                <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} style={S.input}><option value="All">All Categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select>
                <select value={filterMov} onChange={e=>setFilterMov(e.target.value)} style={S.input}><option value="All">All Movement Tags</option>{["Super Fast","Fast","Moderate","Slow","Super Slow"].map(t=><option key={t}>{t}</option>)}</select>
                <span style={{fontSize:11,color:HR.muted,alignSelf:"center"}}>{filtered.length} SKUs</span>
              </div>
              <div style={{...S.card,padding:0,overflow:"auto",flex:1,minHeight:0}}>
                <table style={S.table}>
                  <thead style={{position:"sticky",top:0,zIndex:4}}>
                    <tr style={{background:HR.surfaceLight}}>
                      <th style={{...frozenTh({zIndex:6}),left:0,minWidth:COL_ITEM_W,maxWidth:COL_ITEM_W}} rowSpan={2}>Item</th>
                      <th style={{...frozenTh({zIndex:6}),left:COL_ITEM_W,minWidth:COL_CAT_W,maxWidth:COL_CAT_W}} rowSpan={2}>Category</th>
                      <th style={{...frozenTh({zIndex:6}),left:COL_ITEM_W+COL_CAT_W,minWidth:COL_PRICE_W}} rowSpan={2}>Price</th>
                      <th style={{...frozenTh({zIndex:6}),left:COL_ITEM_W+COL_CAT_W+COL_PRICE_W,minWidth:COL_TOPN_W,boxShadow:"2px 0 6px rgba(0,0,0,0.10)"}} rowSpan={2}>Top N</th>
                      {displayDS.map(ds=>{const di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];return <th key={ds} style={{...S.th,textAlign:"center",background:dc.bg,color:dc.header,borderLeft:`2px solid ${dc.header}44`}} colSpan={5}>{ds}</th>;})}
                      <th style={{...S.th,textAlign:"center",background:DC_COLOR.bg,color:DC_COLOR.header,borderLeft:`2px solid ${DC_COLOR.header}44`}} colSpan={4}>DC</th>
                    </tr>
                    <tr style={{background:HR.surfaceLight}}>
                      {displayDS.map(ds=>{const di=DS_LIST.indexOf(ds),dc=DS_COLORS[di>=0?di:0];return[
                        <th key={ds+"mv"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,borderLeft:`2px solid ${dc.header}44`,position:"sticky",top:26,zIndex:3}}>Mov</th>,
                        <th key={ds+"da"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:26,zIndex:3}}>DAvg</th>,
                        <th key={ds+"ab"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:26,zIndex:3}}>ABQ</th>,
                        <th key={ds+"mn"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:26,zIndex:3}}>Min</th>,
                        <th key={ds+"mx"} style={{...S.th,textAlign:"center",color:dc.header,background:dc.bg,position:"sticky",top:26,zIndex:3}}>Max</th>,
                      ];})}
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,borderLeft:`2px solid ${DC_COLOR.header}44`,position:"sticky",top:26,zIndex:3}}>Mov</th>
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:26,zIndex:3}}>NZD</th>
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:26,zIndex:3}}>Min</th>
                      <th style={{...S.th,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg,position:"sticky",top:26,zIndex:3}}>Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0,500).map((r,i)=>{
                      const isDead=deadStock.has(r.meta.sku),rowBg=i%2===0?HR.white:HR.surfaceLight;
                      return <tr key={r.meta.sku} style={{background:rowBg,opacity:isDead?0.6:1}}>
                        <td style={{...frozenTd(0,rowBg),minWidth:COL_ITEM_W,maxWidth:COL_ITEM_W}}>
                          <div style={{color:HR.text,fontWeight:400,fontSize:10,lineHeight:1.3,whiteSpace:"normal"}}>{r.meta.name||r.meta.sku}</div>
                          <div style={{fontSize:9,marginTop:1,display:"flex",gap:4,alignItems:"center"}}>
                            <span style={{color:HR.muted}}>{r.meta.sku}</span>
                            {isDead&&<span style={{...TAG_STYLE,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}}>Dead</span>}
                          </div>
                        </td>
                        <td style={{...frozenTd(COL_ITEM_W,rowBg),minWidth:COL_CAT_W,maxWidth:COL_CAT_W,color:HR.muted,fontSize:10}}>{r.meta.category}</td>
                        <td style={{...frozenTd(COL_ITEM_W+COL_CAT_W,rowBg),minWidth:COL_PRICE_W}}><TagPill value={r.meta.priceTag} colorMap={PRICE_TAG_COLORS}/></td>
                        <td style={{...frozenTd(COL_ITEM_W+COL_CAT_W+COL_PRICE_W,rowBg),minWidth:COL_TOPN_W,boxShadow:"2px 0 4px rgba(0,0,0,0.06)"}}><TagPill value={r.meta.t150Tag} colorMap={TOPN_TAG_COLORS}/></td>
                        <DSCols r={r} displayDS={displayDS}/>
                        <td style={{...S.td,textAlign:"center",background:DC_COLOR.bg,borderLeft:`1px solid ${DC_COLOR.header}22`}}><MovTag value={r.dc.mvTag}/></td>
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontSize:10,background:DC_COLOR.bg}}>{r.dc.nonZeroDays||"—"}</td>
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg}}>{r.dc.min}</td>
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg}}>{r.dc.max}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
                {filtered.length>500&&<div style={{padding:6,textAlign:"center",color:HR.muted,fontSize:10}}>Showing 500 of {filtered.length} — use filters to narrow down.</div>}
              </div>
            </div>
          )
        )}

        {tab==="simulation"&&<SimulationTab invoiceData={invoiceData} results={results} skuMaster={skuMaster} params={params}/>}
        {tab==="insights"&&<InsightsTab invoiceData={invoiceData} skuMaster={skuMaster} results={results||{}} params={params}/>}

        {/* OUTPUT TAB */}
        {tab==="output"&&(
          !results?<div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>No data available.</div>:(
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <h2 style={{color:HR.yellowDark,margin:0,fontSize:16}}>Min/Max Output — All DS Req</h2>
                <button onClick={()=>{
                  const hdr=["Item Name","SKU","Category","Price Tag",...DS_LIST.flatMap(d=>[`${d} Min`,`${d} Max`]),"DC Min","DC Max"].join(",");
                  const rows=Object.values(results).map(r=>[`"${r.meta.name}"`,r.meta.sku,r.meta.category,r.meta.priceTag,...DS_LIST.flatMap(d=>{const s=r.stores[d]||{min:0,max:0};return[s.min,s.max];}),r.dc.min,r.dc.max].join(","));
                  const blob=new Blob([[hdr,...rows].join("\n")],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="IMS_Output.csv";a.click();
                }} style={{background:HR.green,color:HR.white,border:"none",padding:"7px 18px",borderRadius:5,cursor:"pointer",fontWeight:700,fontSize:12}}>⬇ Export CSV</button>
              </div>
              <div style={{...S.card,padding:0,overflow:"auto",maxHeight:"70vh"}}>
                <table style={S.table}>
                  <thead style={{position:"sticky",top:0}}>
                    <tr style={{background:HR.surfaceLight}}>
                      <th style={{...S.th,minWidth:160}}>Item</th><th style={S.th}>SKU</th><th style={S.th}>Category</th><th style={S.th}>Price Tag</th>
                      {DS_LIST.map((ds,di)=>{const dc=DS_COLORS[di];return <th key={ds} style={{...S.th,textAlign:"center",background:dc.bg,color:dc.header}} colSpan={2}>{ds}</th>;})}
                      <th style={{...S.th,textAlign:"center",background:DC_COLOR.bg,color:DC_COLOR.header}} colSpan={2}>DC</th>
                    </tr>
                    <tr style={{background:HR.surfaceLight}}>
                      <th colSpan={4}/>
                      {DS_LIST.map((ds,di)=>{const dc=DS_COLORS[di];return[<th key={ds+"m"} style={{...S.th,fontSize:10,textAlign:"center",color:dc.header,background:dc.bg}}>Min</th>,<th key={ds+"x"} style={{...S.th,fontSize:10,textAlign:"center",color:dc.header,background:dc.bg}}>Max</th>];})}
                      <th style={{...S.th,fontSize:10,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg}}>Min</th>
                      <th style={{...S.th,fontSize:10,textAlign:"center",color:DC_COLOR.header,background:DC_COLOR.bg}}>Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(results).map((r,i)=>(
                      <tr key={r.meta.sku} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{...S.td,color:HR.text,fontSize:10}}>{r.meta.name||r.meta.sku}</td><td style={{...S.td,color:HR.muted,fontSize:10}}>{r.meta.sku}</td><td style={{...S.td,color:HR.muted,fontSize:10}}>{r.meta.category}</td><td style={S.td}><TagPill value={r.meta.priceTag} colorMap={PRICE_TAG_COLORS}/></td>
                        {DS_LIST.map((ds,di)=>{const s=r.stores[ds]||{min:0,max:0},dc=DS_COLORS[di];return[<td key={ds+"m"} style={{...S.td,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg,fontSize:10}}>{s.min}</td>,<td key={ds+"x"} style={{...S.td,textAlign:"center",color:dc.text,fontWeight:700,background:dc.bg,fontSize:10}}>{s.max}</td>];})}
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg,fontSize:10}}>{r.dc.min}</td>
                        <td style={{...S.td,textAlign:"center",color:DC_COLOR.text,fontWeight:700,background:DC_COLOR.bg,fontSize:10}}>{r.dc.max}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {/* LOGIC TWEAKER TAB — admin only */}
        {tab==="logic"&&isAdmin&&(
          <div style={{maxWidth:620}}>
            {hasChanges&&(
              <div style={{background:"#FFFBEA",border:`1px solid ${HR.yellow}`,borderRadius:8,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                <div><span style={{color:HR.yellowDark,fontWeight:700,fontSize:13}}>⚠ {changedCount} unsaved change{changedCount!==1?"s":""}</span><span style={{color:HR.muted,fontSize:12,marginLeft:6}}>Re-run the model to apply</span></div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>setParams(savedParams)} style={{background:HR.white,color:HR.muted,border:`1px solid ${HR.border}`,padding:"6px 12px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:600}}>↩ Reset</button>
                  <button onClick={()=>applyAndRun(params)} style={{background:HR.yellow,color:HR.black,border:"none",padding:"6px 16px",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700}}>▶ Apply & Re-run</button>
                </div>
              </div>
            )}
            <h2 style={{color:HR.yellowDark,marginBottom:4,fontSize:16}}>Logic Tweaker</h2>
            <p style={{color:HR.muted,fontSize:13,marginBottom:16}}>Click any section to expand and adjust parameters.</p>

            <Section title="Analysis Period" icon="📅" accent="#0077A8" summary={`Overall: ${params.overallPeriod}d · Recency: ${params.recencyWindow}d · Long: ${params.overallPeriod-params.recencyWindow}d`}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:16}}>
                {[{label:"Overall Period (days)",key:"overallPeriod",min:15,max:90},{label:"Recency Window (days)",key:"recencyWindow",min:7,max:null}].map(({label,key,min,max})=>{
                  const maxVal=key==="recencyWindow"?Math.max(min,(params.overallPeriod||90)-1):max;
                  return <div key={key}><div style={{fontSize:11,color:HR.muted,marginBottom:4}}>{label}</div>
                    <NumInput value={params[key]} min={min} max={maxVal} step={1} onChange={v=>saveParams({...params,[key]:v})} style={{width:"100%",boxSizing:"border-box",color:HR.yellowDark,fontWeight:700}}/>
                  </div>;
                })}
                <div><div style={{fontSize:11,color:HR.muted,marginBottom:4}}>Long Period (auto)</div><div style={{...S.input,textAlign:"center",color:HR.muted,fontWeight:700,opacity:0.7}}>{params.overallPeriod-params.recencyWindow} days</div></div>
              </div>
              <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:8}}>Recency Weights by Movement Tag</div>
              <table style={S.table}>
                <thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>Movement Tag</th><th style={{...S.th,textAlign:"center"}}>Weight</th><th style={{...S.th,color:HR.muted,fontSize:10,fontWeight:400}}>Blend formula</th></tr></thead>
                <tbody>{["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{const wt=rw2[tier]||1,color=MOV_COLORS[tier];return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}><td style={S.td}><MovTag value={tier}/></td>
                  <td style={{...S.td,textAlign:"center"}}><NumInput value={wt} min={0.5} max={5} step={0.25} onChange={v=>saveParams({...params,recencyWt:{...rw2,[tier]:v}})} style={{width:72,color,fontWeight:700}}/></td>
                  <td style={{...S.td,fontSize:10,color:HR.muted}}>{`(Long + Recent × ${wt}) ÷ ${1+wt}`}</td></tr>;})}
                </tbody>
              </table>
            </Section>

            <Section title="DS Level Logic" icon="🏪" accent={HR.yellowDark} summary={`Mov: ${mi.join("/")} · Price: ₹${pt.join("/₹")} · Spike: ${params.spikeMultiplier}× · Brands: ${Object.keys(bb).length}`}>
              <Section title="Base Min Days" icon="📦" accent={HR.yellowDark} summary={`SF:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Super Fast"]} F:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Fast"]} M:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Moderate"]} Sl:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Slow"]} SS:${(params.baseMinDays||BASE_MIN_DAYS_DEFAULT)["Super Slow"]}`}>
                <div style={{...S.card,padding:0,overflow:"hidden"}}>
                  <table style={S.table}>
                    <thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>Movement Tag</th><th style={{...S.th,textAlign:"center"}}>Base Min Days</th></tr></thead>
                    <tbody>{["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{const bmd=params.baseMinDays||BASE_MIN_DAYS_DEFAULT,color=MOV_COLORS[tier];return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}><td style={S.td}><MovTag value={tier}/></td><td style={{...S.td,textAlign:"center"}}>
                      <NumInput value={bmd[tier]??3} min={1} max={30} step={1} onChange={v=>saveParams({...params,baseMinDays:{...(params.baseMinDays||BASE_MIN_DAYS_DEFAULT),[tier]:v}})} style={{width:72,color,fontWeight:700}}/>
                    </td></tr>;})}
                    </tbody>
                  </table>
                </div>
              </Section>
              <Section title="Movement Tag Boundaries" icon="🏃" accent={HR.yellowDark} summary={`≤${mi[0]}d / ≤${mi[1]}d / ≤${mi[2]}d / ≤${mi[3]}d`}>
                {[0,1,2,3].map(i=>{const labels=["Super Fast | Fast","Fast | Moderate","Moderate | Slow","Slow | Super Slow"],lo=i===0?1:mi[i-1]+1,hi=i===3?30:mi[i+1]-1;return <TierSlider key={i} label={labels[i]} value={mi[i]} min={lo} max={hi} color={movColors[i+1]} onChange={v=>{const next=[...mi];next[i]=v;saveParams({...params,movIntervals:next});}}/>;})}</Section>
              <Section title="Price Tag Boundaries" icon="💰" accent={HR.yellowDark} summary={`₹${pt[0]} / ₹${pt[1]} / ₹${pt[2]} / ₹${pt[3]}`}>
                {[0,1,2,3].map(i=>{const labels=["Premium | High","High | Medium","Medium | Low","Low | Super Low"],lo=i===3?1:pt[i+1]+1,hi=i===0?50000:pt[i-1]-1;return <TierSlider key={i} label={labels[i]} value={pt[i]} min={lo} max={hi} color={priceColors[i]} onChange={v=>{const next=[...pt];next[i]=v;saveParams({...params,priceTiers:next});}}/>;})}</Section>
              <Section title="Spike Parameters" icon="⚡" accent={HR.yellowDark} summary={`${params.spikeMultiplier}× · Frequent ≥${params.spikePctFrequent}% · Once ≥${params.spikePctOnce}%`}>
                {[{key:"spikeMultiplier",label:"Spike Definition",desc:"Day qty > X × daily avg = spike day",min:1,max:20,step:1},{key:"spikePctFrequent",label:"Frequent Spike Threshold (%)",desc:"Spike days ≥ X% of period = Frequent",min:1,max:50,step:1},{key:"spikePctOnce",label:"Once-in-a-while Threshold (%)",desc:"Spike days ≥ X% of period = Once in a while",min:1,max:20,step:1}].map(pm=>(
                  <div key={pm.key} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}><div style={{fontWeight:600,color:HR.text,fontSize:12}}>{pm.label}</div><div style={{fontWeight:800,color:HR.yellowDark,fontSize:18,minWidth:32,textAlign:"right"}}>{params[pm.key]}</div></div>
                    <div style={{fontSize:10,color:HR.muted,marginBottom:6}}>{pm.desc}</div>
                    <TierSlider label="" value={params[pm.key]} min={pm.min} max={pm.max} step={pm.step} onChange={v=>saveParams({...params,[pm.key]:v})}/>
                  </div>
                ))}
              </Section>
              <Section title="Max Days Buffer & ABQ" icon="📊" accent={HR.yellowDark} summary={`Buffer: +${params.maxDaysBuffer}d · ABQ mult: ${params.abqMaxMultiplier}×`}>
                {[{key:"maxDaysBuffer",label:"Max Days Buffer",desc:"Max Days = Min Days + X.",min:1,max:10,step:1},{key:"abqMaxMultiplier",label:"ABQ Max Multiplier",desc:"Max = CEILING(Min × X) for Slow items.",min:1,max:3,step:0.1}].map(pm=>(
                  <div key={pm.key} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}><div style={{fontWeight:600,color:HR.text,fontSize:12}}>{pm.label}</div><div style={{fontWeight:800,color:HR.yellowDark,fontSize:18,minWidth:32,textAlign:"right"}}>{params[pm.key]}</div></div>
                    <div style={{fontSize:10,color:HR.muted,marginBottom:6}}>{pm.desc}</div>
                    <TierSlider label="" value={params[pm.key]} min={pm.min} max={pm.max} step={pm.step} onChange={v=>saveParams({...params,[pm.key]:v})}/>
                  </div>
                ))}
              </Section>
              <Section title="Brand Buffer Days" icon="🏷️" accent={HR.yellowDark} summary={`${Object.keys(bb).length} brand${Object.keys(bb).length!==1?"s":""} configured`}>
                <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:10}}>
                  <table style={S.table}>
                    <thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>Brand</th><th style={{...S.th,textAlign:"center"}}>Buffer Days</th><th style={{...S.th,textAlign:"center"}}>Remove</th></tr></thead>
                    <tbody>{Object.entries(bb).map(([brand,days],i)=>(
                      <tr key={brand} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
                        <td style={{...S.td,fontWeight:600,fontSize:11}}>{brand}</td>
                        <td style={{...S.td,textAlign:"center"}}><NumInput value={days} min={1} max={30} step={1} onChange={v=>saveParams({...params,brandBuffer:{...bb,[brand]:v}})} style={{width:64,color:HR.yellowDark,fontWeight:700}}/></td>
                        <td style={{...S.td,textAlign:"center"}}><button onClick={()=>{const next={...bb};delete next[brand];saveParams({...params,brandBuffer:next});}} style={{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:11}}>✕</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <input placeholder="Brand name..." value={newBrand} onChange={e=>setNewBrand(e.target.value)} style={{...S.input,flex:1}}/>
                  <NumInput value={newBrandDays} min={1} max={30} step={1} onChange={v=>setNBD(v)} style={{width:70}}/>
                  <button onClick={()=>{const b=newBrand.trim();if(!b)return;saveParams({...params,brandBuffer:{...bb,[b]:newBrandDays}});setNewBrand("");setNBD(1);}} style={{background:HR.green,color:HR.white,border:"none",padding:"7px 14px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12,whiteSpace:"nowrap"}}>+ Add</button>
                </div>
              </Section>
              <Section title="New Dark Store Logic" icon="🆕" accent={HR.yellowDark} summary={`${(params.newDSList||[]).join(", ")||"None"} · Top ${params.newDSFloorTopN} SKUs`}>
                <div style={{...S.card,marginBottom:10,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}><div style={{fontWeight:600,color:HR.text,fontSize:12}}>Floor applies to Top N SKUs</div><div style={{fontWeight:800,color:HR.yellowDark,fontSize:18}}>{params.newDSFloorTopN}</div></div>
                  <TierSlider label="" value={params.newDSFloorTopN} min={50} max={250} step={50} onChange={v=>saveParams({...params,newDSFloorTopN:v})}/>
                </div>
                <div style={{...S.card,padding:"12px 14px"}}>
                  <div style={{fontSize:11,color:HR.muted,marginBottom:6,fontWeight:600}}>Stores designated as New DS</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                    {(params.newDSList||[]).map(ds=><span key={ds} style={{background:"#FFFBEA",color:HR.yellowDark,border:`1px solid ${HR.yellow}`,padding:"3px 10px",borderRadius:5,fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>{ds}<button onClick={()=>saveParams({...params,newDSList:(params.newDSList||[]).filter(d=>d!==ds)})} style={{background:"none",border:"none",color:HR.yellowDark,cursor:"pointer",fontSize:13,padding:0,lineHeight:1}}>×</button></span>)}
                    {(params.newDSList||[]).length===0&&<span style={{color:HR.muted,fontSize:12}}>No stores assigned</span>}
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <select id="newDSSelect" style={S.input}>{DS_LIST.filter(d=>!(params.newDSList||[]).includes(d)).map(d=><option key={d}>{d}</option>)}</select>
                    <button onClick={()=>{const sel=document.getElementById("newDSSelect").value;if(sel&&!(params.newDSList||[]).includes(sel))saveParams({...params,newDSList:[...(params.newDSList||[]),sel]});}} style={{background:HR.green,color:HR.white,border:"none",padding:"7px 14px",borderRadius:5,cursor:"pointer",fontWeight:600,fontSize:12}}>+ Add</button>
                  </div>
                </div>
              </Section>
            </Section>

            <Section title="DC Level Logic" icon="🏭" accent="#0077A8" summary={`Active DS: ${params.activeDSCount} · DC mults: SF ${(params.dcMult||DC_MULT_DEFAULT)["Super Fast"].min}–${(params.dcMult||DC_MULT_DEFAULT)["Super Fast"].max}`}>
              <div style={{...S.card,padding:"12px 14px",marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}><div style={{fontWeight:600,color:HR.text,fontSize:12}}>Active DS Count</div><div style={{fontWeight:800,color:HR.yellowDark,fontSize:18}}>{params.activeDSCount}</div></div>
                <TierSlider label="" value={params.activeDSCount} min={1} max={10} step={1} color="#0077A8" onChange={v=>saveParams({...params,activeDSCount:v})}/>
              </div>
              <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:6}}>Dead Stock DC Multiplier</div>
              <div style={{...S.card,padding:0,overflow:"hidden",marginBottom:14}}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>Condition</th><th style={{...S.th,textAlign:"center"}}>Min Mult</th><th style={{...S.th,textAlign:"center"}}>Max Mult</th></tr></thead>
                  <tbody><tr style={{background:HR.white}}><td style={S.td}><span style={{...TAG_STYLE,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}}>Dead Stock</span></td>
                    {["min","max"].map(field=><td key={field} style={{...S.td,textAlign:"center"}}>
                      <NumInput value={(params.dcDeadMult||DC_DEAD_MULT_DEFAULT)[field]} min={0} max={1} step={0.05} onChange={v=>saveParams({...params,dcDeadMult:{...(params.dcDeadMult||DC_DEAD_MULT_DEFAULT),[field]:v}})} style={{width:72,color:"#B91C1C",fontWeight:700}}/>
                    </td>)}
                  </tr></tbody>
                </table>
              </div>
              <div style={{fontSize:12,fontWeight:700,color:HR.text,marginBottom:6}}>DC Multipliers</div>
              <div style={{...S.card,padding:0,overflow:"hidden"}}>
                <table style={S.table}>
                  <thead><tr style={{background:HR.surfaceLight}}><th style={S.th}>Movement Tag</th><th style={{...S.th,textAlign:"center"}}>Min Mult</th><th style={{...S.th,textAlign:"center"}}>Max Mult</th></tr></thead>
                  <tbody>{["Super Fast","Fast","Moderate","Slow","Super Slow"].map((tier,i)=>{
                    const d=dcM[tier]||DC_MULT_DEFAULT[tier],color=MOV_COLORS[tier];
                    return <tr key={tier} style={{background:i%2===0?HR.white:HR.surfaceLight}}><td style={S.td}><MovTag value={tier}/></td>
                      <td style={{...S.td,textAlign:"center"}}><NumInput value={d.min} min={0} max={1} step={0.05} onChange={v=>saveParams({...params,dcMult:{...dcM,[tier]:{...d,min:v}}})} style={{width:72,color,fontWeight:700}}/></td>
                      <td style={{...S.td,textAlign:"center"}}><NumInput value={d.max} min={0} max={1} step={0.05} onChange={v=>saveParams({...params,dcMult:{...dcM,[tier]:{...d,max:v}}})} style={{width:72,color,fontWeight:700}}/></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            </Section>

            {hasChanges&&<button onClick={()=>applyAndRun(params)} style={{...S.runBtn,marginTop:14}}>▶ Apply & Re-run Model</button>}
          </div>
        )}
      </div>
    </div>
  );
}