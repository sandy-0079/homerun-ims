// Engine utility functions — extracted from App.jsx
import { MOVEMENT_TIERS_DEFAULT } from "./constants.js";

export function parseCSV(text){
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

export function getPriceTag(p,tiers){const v=parseFloat(p)||0;const[t1,t2,t3,t4]=tiers||[3000,1500,400,100];if(v>=t1)return"Premium";if(v>=t2)return"High";if(v>=t3)return"Medium";if(v>=t4)return"Low";if(v>0)return"Super Low";return"No Price";}

export function getMovTag(nzd,total,intervals){if(!nzd)return"Super Slow";const avg=total/nzd;const[i1,i2,i3,i4]=intervals||MOVEMENT_TIERS_DEFAULT;if(avg<=i1)return"Super Fast";if(avg<=i2)return"Fast";if(avg<=i3)return"Moderate";if(avg<=i4)return"Slow";return"Super Slow";}

export function getSpikeTag(spikeDays,totalDays,pFreq,pOnce){const pct=totalDays>0?(spikeDays/totalDays)*100:0;if(pct>=pFreq)return"Frequent";if(pct>=pOnce)return"Once in a while";if(spikeDays>0)return"Rare";return"No Spike";}

export function computeStats(qtys,ords,periodDays,spikeMult){
  const totalQty=qtys.reduce((a,b)=>a+b,0),totalOrders=ords.reduce((a,b)=>a+b,0),nonZeroDays=qtys.filter(q=>q>0).length;
  const dailyAvg=totalQty/periodDays,abq=totalOrders>0?totalQty/totalOrders:0,maxDayQty=Math.max(...qtys);
  let spikeDays=0,spikeVals=[];
  qtys.forEach(q=>{if(q>spikeMult*dailyAvg){spikeDays++;spikeVals.push(q);}});
  const sorted=[...spikeVals].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  const spikeMedian=sorted.length===0?0:sorted.length%2===1?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  const spikeRef=spikeDays===0?maxDayQty:spikeMedian,spikeRatio=dailyAvg>0?spikeRef/dailyAvg:0;
  return{totalQty,totalOrders,nonZeroDays,dailyAvg,abq,spikeDays,spikeRatio,spikeMedian:spikeRef};
}

export function getInvSlice(invoiceData,period,recencyWindow){
  const allDates=[...new Set(invoiceData.map(r=>r.date))].sort(),full=allDates.slice(-90);
  if(period==="90D")return invoiceData.filter(r=>full.includes(r.date));
  const rw=Math.min(recencyWindow||15,full.length-1),split=full.length-rw;
  if(period==="15D")return invoiceData.filter(r=>full.slice(split).includes(r.date));
  if(period==="75D")return invoiceData.filter(r=>full.slice(0,split).includes(r.date));
  return invoiceData.filter(r=>full.includes(r.date));
}

export function aggStats(rows){
  const skus=new Set(rows.map(r=>r.sku)),totalOrders=rows.length,totalQty=rows.reduce((a,r)=>a+r.qty,0),avgOrderQty=totalOrders>0?totalQty/totalOrders:0;
  return{skuCount:skus.size,totalOrders,totalQty,avgOrderQty};
}

/** Compute the Xth percentile from a sorted array of numbers using linear interpolation */
export function percentile(sortedArr, pct) {
  if (sortedArr.length === 0) return 0;
  const idx = (pct / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
