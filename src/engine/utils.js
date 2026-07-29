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

// Parse a Zoho invoice CSV into the invoiceData row shape used by the engine.
// Mirrors App.jsx's invoice upload mapping — shared so the OOS Simulation can parse the same format.
// ⚠ DATE FORMAT IS LOAD-BEARING — this guard exists because of a live outage.
//
// 2026-07-29: an export wrote the two newest days as DD/MM/YYYY while the older 88
// were ISO. This function stored `Invoice Date` verbatim with no validation, so the
// mixed row set reached Supabase. Then:
//
//   1. String-sorting puts "28/07/2026" AFTER "2026-07-26" ('0' < '8' at index 1),
//      so the malformed date becomes `allDates[allDates.length - 1]`.
//   2. plywoodNetwork.js does `new Date(latest).toISOString()` — and
//      new Date("28/07/2026") is an Invalid Date, so toISOString throws
//      RangeError: Invalid time value.
//   3. That threw inside runEngine during App.jsx's page-load effect, so the React
//      tree unmounted and EVERY user got a blank page — the engine recomputes
//      client-side on every load, so it was not one bad session.
//   4. Nobody could fix it from the UI, because the app crashed before rendering the
//      Upload tab. Recovery required restoring team_data/invoice_data from a backup.
//
// So a bad file must be refused BEFORE it is stored, not tolerated downstream.
//
// Deliberately REJECTING rather than auto-correcting: DD/MM vs MM/DD is genuinely
// ambiguous for days <= 12 ("07/08/2026" is either 7 Aug or 8 Jul), and guessing
// wrong would shift demand by weeks with no visible symptom. A refused upload costs
// one re-export; a silently misdated one corrupts Min/Max invisibly.
//
// Callers MUST catch this — see handleInvoice in App.jsx. An uncaught throw here
// would leave the upload spinner stuck forever.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseInvoiceCsv(text){
  const rows = parseCSV(text)
    .filter(r=>["Closed","Overdue"].includes(r["Invoice Status"]||""))
    .map(r=>({date:r["Invoice Date"]||"",sku:r["SKU"]||"",ds:(r["Line Item Location Name"]||"").trim().split(/\s+/)[0].toUpperCase(),qty:parseFloat(r["Quantity"]||0),shopifyOrder:r["Shopify Order"]||"",pin:(r["Shipping Code"]||"").trim()}))
    .filter(r=>r.date&&r.sku&&r.qty>0);

  // Checked only on rows the engine will actually use — a blank date on an unnamed
  // charge line was already dropped above and is not an error.
  const bad = new Map();
  for (const r of rows) {
    // Regex alone is not enough: "2026-13-45" matches the shape but is not a real
    // day, and new Date() would still yield Invalid Date downstream.
    if (!ISO_DATE.test(r.date) || Number.isNaN(Date.parse(`${r.date}T00:00:00Z`))) {
      bad.set(r.date, (bad.get(r.date) || 0) + 1);
    }
  }
  if (bad.size) {
    const affected = [...bad.values()].reduce((a, b) => a + b, 0);
    const shown = [...bad.keys()].slice(0, 5).map(d => `"${d}"`).join(", ");
    throw new Error(
      `Invoice dates must be in YYYY-MM-DD format. Found ${bad.size} unrecognised ` +
      `date value(s) across ${affected} row(s): ${shown}${bad.size > 5 ? ", …" : ""}. ` +
      `Nothing has been saved. Re-export from Zoho with the date format set to ` +
      `YYYY-MM-DD and upload again.`
    );
  }

  return rows;
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

export function getInvSlice(invoiceData,period,recencyWindow,overallPeriod){
  const op=overallPeriod||90;
  const allDates=[...new Set(invoiceData.map(r=>r.date))].sort(),full=allDates.slice(-op);
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

/** Parse thickness in mm from a SKU name string (e.g. "12mm" → 12) */
export function inferThickness(name) {
  if (!name) return null;
  const m = name.match(/(\d+(?:\.\d+)?)\s*mm/i);
  return m ? parseFloat(m[1]) : null;
}

/** Classify a SKU as Thick, Thin, or Laminate based on mm and boundary */
export function thicknessCategory(mm, laminateThreshold = 1, thickBoundaryMm = 9) {
  if (mm === null || mm === undefined) return 'Unknown';
  if (mm <= laminateThreshold) return 'Laminate';
  if (mm > thickBoundaryMm) return 'Thick';
  return 'Thin';
}

/** Compute the Xth percentile from a sorted array of numbers using linear interpolation */
export function percentile(sortedArr, pct) {
  if (sortedArr.length === 0) return 0;
  const idx = (pct / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
