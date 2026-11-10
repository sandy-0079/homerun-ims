import React from "react";
import { DS_LIST, buildInvoiceCsv } from "../engine/index.js";
import { buildSkuCeilingCsv } from "../skuCeilingCsv";
import { normalisePolicy } from "../skuPolicy";
import { DC_COLOR } from "../dsColors";
import { HR, S } from "../appStyles";
import { TAG_STYLE } from "../appTagColors";

// ── Input provenance pill, Upload Data cards ─────────────────────────────────
// Colours are the file's existing pill vocabulary, not a new palette: ok reuses
// "Base Logic", ageing reuses "Brand Buffer", stale reuses the "Premium" price tag.
const FRESH_COLORS={
  ok:      {bg:"#DCFCE7",color:"#15803D",border:"#BBF7D0"},
  ageing:  {bg:"#FEF3C7",color:"#92400E",border:"#FDE68A"},
  stale:   {bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
  unknown: {bg:"#F8FAFC",color:"#94A3B8",border:"#E2E8F0"},
};
// "auto · 6h ago" / "manual · 2h ago". Age is what you act on; the absolute
// timestamp goes in the tooltip so the pill stays scannable.
const SourcePill=React.memo(({prov,note})=>{
  const c=FRESH_COLORS[prov.level]||FRESH_COLORS.unknown;
  const text=prov.source==="none"?"never loaded":`${prov.source} · ${prov.age}`;
  return (
    <span title={`${note||prov.note}\n${prov.at?new Date(prov.at).toLocaleString():"no timestamp recorded"}`}
      style={{...TAG_STYLE,background:c.bg,color:c.color,border:`1px solid ${c.border}`,cursor:"help"}}>
      {text}
    </span>
  );
});

// Hyderabad mode: a shared card is visibly inert, and says where it is managed.
const SHARED_CARD = {opacity:0.7};
const SHARED_NOTE = <div style={{fontSize:10,color:HR.muted,fontStyle:"italic"}}>Shared — managed in Bangalore</div>;

/**
 * Upload Data tab — moved verbatim out of App.jsx. App still owns the state and
 * every write: the upload handlers, clearData and applyAndRun (passed in as onApply)
 * are defined in App.jsx and passed in.
 */
export default function UploadDataTab({ onApply: applyAndRun, changeLog, clearData, deadStock,
  handleCeiling, handleDead, handleInvoice, handleMRQ, handleNSQ, handlePrice, handleSKU,
  infoCard, setInfoCard, inputProvenance, inputSummaries, invoiceData, invoiceDateRange,
  minReqQty, missing, modelDirty, modelRunSuccess, modelSnapshot, modelState, newSKUQty,
  params, priceData, provRaw, results, showRunConfirm, setShowRunConfirm, skuCeiling,
  skuMaster, uniqueSold, uploadedFiles, uploading, zeroSale,
  // Hyderabad (spec §9). Both default to today's Bangalore render.
  //   mode="hyd": the shared/Bangalore cards render inert — the "Shared — managed in
  //   Bangalore" note in place of their upload/template/data/clear buttons, so no file
  //   input and no path to a Bangalore handler (each one writes a Bangalore row). Also
  //   hides Apply & Re-run Model (applyAndRun writes Bangalore's params/toTargets), its
  //   confirm modal, the success banner and the model-run diagnostics below the cards.
  //   extraCards: rendered first in the cards area (Hyderabad's floors card).
  mode = "blr", extraCards = null }) {
  const shared = mode === "hyd";
  return (
  <div style={{display:"flex",flexDirection:"column",gap:12}}>

    {/* ── TOP BAR: title + data health strip + apply button ── */}
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <h2 style={{color:HR.yellowDark,margin:0,fontSize:16}}>Data Inputs</h2>
        {!shared&&<div style={{display:"flex",alignItems:"center",gap:10}}>
        {/* Model freshness, sitting left of the Apply button. NOT redundant with that
            button: it tracks `modelDirty`, a SESSION flag — did YOU change something
            since YOUR last Apply. This compares STORED timestamps, so it catches what
            the button structurally cannot — a nightly sync moving an input in another
            session or overnight, leaving toTargets genuinely behind while the button
            still reads "up to date". Relative, not absolute: toTargets changes only on
            Apply, so its age alone says little; what matters is whether an input moved
            after it. */}
        {/* ⚠ TWO FACTS, DELIBERATELY TOGETHER. "Last run" is when the engine ran;
            "demand through" is what it ran ON, from toTargets.inputs.invoiceDataThrough.
            The clock alone cannot expose a stale input — see the load effect above — and
            on 2026-08-03 it read a perfectly accurate 06:15 beside demand three days
            behind. Same line belongs in the TO tool footer, where the consequence is
            transfer quantities. */}
        <span title={provRaw.targetsThrough
                       ? `${modelState.note}\nEngine ran on invoice demand through ${provRaw.targetsThrough}`
                       : modelState.note}
          style={{
          padding:"3px 10px",borderRadius:12,fontSize:11,fontWeight:700,cursor:"help",whiteSpace:"nowrap",
          ...(modelState.level==="stale"?{background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA"}
            :modelState.level==="ok"?{background:"#DCFCE7",color:"#15803D",border:"1px solid #BBF7D0"}
            :{background:"#F8FAFC",color:"#94A3B8",border:"1px solid #E2E8F0"})}}>
          {modelState.lastRun ? `Last run: ${modelState.lastRun}` : "Last run: never"}
          {provRaw.targetsThrough ? ` · demand through ${provRaw.targetsThrough}` : ""}
        </span>
        {(() => {
          const hasData = invoiceData.length > 0 && Object.keys(skuMaster).length > 0 && Object.keys(priceData).length > 0;
          // Yellow only when something changed (data upload, clear, or params tweaked)
          const disabled2 = !hasData || !modelDirty;
          return (
            <button
              disabled={disabled2}
              title={!hasData?"Upload all required CSVs first":!modelDirty?"No changes since last run":""}
              style={{background:disabled2?"#E5E5E5":HR.yellow,color:disabled2?"#999":HR.black,border:"none",padding:"8px 20px",borderRadius:7,cursor:disabled2?"not-allowed":"pointer",fontSize:12,fontWeight:800,display:"flex",alignItems:"center",gap:6}}
              onClick={disabled2?undefined:()=>setShowRunConfirm(true)}>
              {modelDirty ? <><span>▶</span> Apply & Re-run Model</> : <><span>✓</span> Model up to date</>}
            </button>
          );
        })()}
        </div>}
      </div>
    </div>

    {/* ── Success banner ── */}
    {!shared && modelRunSuccess && (
      <div style={{background:"#D1FAE5",border:"1px solid #6EE7B7",borderRadius:8,padding:"10px 16px",display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18}}>✅</span>
        <div>
          <div style={{fontWeight:700,color:"#065F46",fontSize:12}}>Model ran successfully</div>
          <div style={{fontSize:11,color:"#047857"}}>Min/Max updated for all {Object.keys(results||{}).length.toLocaleString()} SKUs. All users will see new values on next load.</div>
        </div>
      </div>
    )}

    {/* ── Run confirm modal ── */}
    {!shared && showRunConfirm && (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999}}>
        <div style={{background:HR.white,borderRadius:12,padding:28,maxWidth:440,width:"90%",boxShadow:"0 8px 32px rgba(0,0,0,0.2)"}}>
          <div style={{fontWeight:800,color:HR.text,fontSize:15,marginBottom:4}}>Re-run Model?</div>
          <div style={{fontSize:12,color:HR.muted,marginBottom:16}}>This will recalculate Min/Max for all SKUs and update the values seen by all users.</div>
          {/* Changes since last run */}
          <div style={{background:HR.surfaceLight,borderRadius:8,padding:"10px 14px",marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Changes since last run</div>
            {changeLog.length === 0
              ? <div style={{fontSize:11,color:HR.muted,fontStyle:"italic"}}>No data changes — only param changes</div>
              : changeLog.map((msg, i) => (
                <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:11,color:HR.text}}>
                  <span style={{color:HR.green,fontSize:13}}>•</span>{msg}
                </div>
              ))
            }
          </div>
          {/* Current model inputs summary */}
          <div style={{background:HR.surfaceLight,borderRadius:8,padding:"10px 14px",marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Model will run with</div>
            {[
              {label:"Invoice Data", value:`${invoiceData.length.toLocaleString()} rows · ${invoiceDateRange.min||"—"} → ${invoiceDateRange.max||"—"}`},
              {label:"SKU Master",   value:`${Object.keys(skuMaster).length.toLocaleString()} SKUs`},
              {label:"Prices",       value:`${Object.keys(priceData).length.toLocaleString()} SKUs`},
              {label:"Dead Stock",   value:`${deadStock.size} SKUs flagged`},
              {label:"Overall Period",value:`${params.overallPeriod||45} days`},
            ].map(item=>(
              <div key={item.label} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:`1px solid ${HR.border}`,fontSize:11}}>
                <span style={{color:HR.muted}}>{item.label}</span>
                <span style={{fontWeight:600,color:HR.text}}>{item.value}</span>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:10}}>
            <button onClick={()=>{setShowRunConfirm(false);applyAndRun(params);}}
              style={{flex:1,background:HR.yellow,color:HR.black,border:"none",padding:"10px",borderRadius:7,cursor:"pointer",fontWeight:800,fontSize:13}}>
              ▶ Run Model
            </button>
            <button onClick={()=>setShowRunConfirm(false)}
              style={{flex:1,background:HR.white,color:HR.muted,border:`1px solid ${HR.border}`,padding:"10px",borderRadius:7,cursor:"pointer",fontWeight:600,fontSize:13}}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── MAIN: cards area ── */}
    <div style={{flex:"0 0 auto"}}>

      {(()=>{
        const dlCSV=(filename,csv)=>{
          const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=filename;a.click();
        };
        const dlTemplate=(filename,headers,rows)=>{
          dlCSV(filename,[headers.join(","),...rows.map(r=>r.join(","))].join("\n"));
        };
        const buildDataCSV=(key)=>{
          // ⚠ Was inline here and wrote an EMPTY Invoice Status, so ⬇ Data -> ⬆ Upload
          // parsed to ZERO rows and wiped invoice history (74,381 -> 0, measured
          // 2026-07-30). Now lives beside parseInvoiceCsv in engine/utils.js so the
          // writer and reader are visibly coupled, with the round trip under test.
          if(key==="invoiceData") return buildInvoiceCsv(invoiceData, skuMaster);
          if(key==="skuMaster"){
            if(!Object.keys(skuMaster).length) return null;
            const h=["Name","Inventorised At","SKU","Category","Brand","Status","Purchase","Move"];
            const q=v=>`"${(v||"").replace(/"/g,'""')}"`;
            const rows=Object.values(skuMaster).map(s=>[q(s.name),q(s.inventorisedAt||"DS"),q(s.sku),q(s.category),q(s.brand),q(s.status||"Active"),q(normalisePolicy(s.purchase)),q(normalisePolicy(s.move))].join(","));
            return h.map(v=>`"${v}"`).join(",")+"\n"+rows.join("\n");
          }
          if(key==="priceData"){
            if(!Object.keys(priceData).length) return null;
            const h=["sku","average_price"];
            const rows=Object.entries(priceData).map(([s,p])=>`"${s}",${p}`);
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="skuCeiling"){
            if(!Object.keys(skuCeiling).length) return null;
            // Shared writer, pinned by a round-trip test against parseSkuCeilingCsv.
            return buildSkuCeilingCsv(skuCeiling,[...DS_LIST,"DC"]);
          }
          if(key==="minReqQty"){
            if(!Object.keys(minReqQty).length) return null;
            const h=["SKU","Qty"];
            const rows=Object.entries(minReqQty).map(([s,q])=>`"${s}",${q}`);
            return h.join(",")+"\n"+rows.join("\n");
          }
          if(key==="newSKUQty"){
            if(!Object.keys(newSKUQty).length) return null;
            // ⚠ DC columns included, or this download would silently DROP the DC
            // floors and re-uploading it would wipe them — the invoice ⬇ Data bug,
            // exactly (a writer and its reader disagreeing, failing ok:true).
            const h=["SKU",...[...DS_LIST,"DC"].flatMap(ds=>[ds+" Min",ds+" Max"])];
            const rows=Object.entries(newSKUQty).map(([s,dsMap])=>{
              const vals=[...DS_LIST,"DC"].flatMap(ds=>{
                const fl=dsMap[ds];
                if(!fl) return [0,0];
                if(typeof fl==="number") return [fl,fl];
                return [fl.min||0,fl.max||0];
              });
              // ⚠ SKU emitted UNQUOTED. `parseFloorSheet` never strips quotes, so the
              // quoted form fed back through the sync returned ok:true with keys like
              // '"ATGRU"' matching nothing. SKUs are plain alphanumeric here.
              return `${s},${vals.join(",")}`;
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
          invoiceData:{file:"Invoice_Dump_Template.csv",headers:["Invoice Date","Invoice Number","Invoice Status","Shopify Order","Item Name","SKU","Category Name","Quantity","Line Item Location Name","Shipping Code"],rows:[["2026-01-01","INV001","Closed","HR/26/0001","Product Name A","SKU001","Paints",5,"DS01 Sarjapur","560035"],["2026-01-02","INV002","Closed","HR/26/0002","Product Name B","SKU002","Adhesives",3,"DS02 Bileshivale","560016"]]},
          skuMaster:  {file:"SKU_Master_Template.csv",  headers:["Name","Inventorised At","SKU","Category","Status","Brand","Purchase","Move"],rows:[["Product Name A","DS","SKU001","Paints","Active","Asian Paints","Yes","Yes"],["Product Name B","DS","SKU002","Adhesives","Active","MYK Laticrete","Yes","No"]]},
          priceData:{file:"Avg_Price_Template.csv",headers:["item_id","item_name","unit","is_combo_product","quantity_purchased","amount","average_price","location_name","sku"],rows:[["ITEM001","Product Name A","PCS","No",100,25000,250,"DS01 Warehouse","SKU001"],["ITEM002","Product Name B","PCS","No",10,18000,1800,"DS02 Warehouse","SKU002"]]},
          minReqQty:  {file:"New_DS_Floor_Template.csv",headers:["SKU","Qty"],rows:[["SKU001",10],["SKU002",5]]},
          newSKUQty:  {file:"SKU_Floors_Template.csv",headers:["SKU",...[...DS_LIST,"DC"].flatMap(ds=>[`${ds} Min`,`${ds} Max`])],rows:[["SKU001",3,5,2,3,0,0,5,7,0,0,0,0,0,0],["SKU002",0,0,1,2,2,3,0,0,3,4,1,2,4,6]]},
          deadStock:  {file:"Dead_Stock_Template.csv",  headers:["Dead Stock"],rows:[["SKU001"],["SKU002"]]},
          // ⚠ BLANK = no cap, 0 = stock nothing here. The template shows both so the
          // difference is visible before anyone fills it in; they are opposites.
          skuCeiling: {file:"SKU_Ceilings_Template.csv",headers:["SKU",...[...DS_LIST,"DC"].map(ds=>`${ds} Cap`)],rows:[["SKU001","","","","",5,"",""],["SKU002",0,0,0,"","","",8]]},
        };
        // ⚠ Counts come from inputSummary.js, never from Object.keys() inline. Two of
        // these were counting the wrong thing before 2026-07-30 — New DS Floor Qty
        // read 1,921 when only 1,021 SKUs had a floor, because 900 stored values are
        // `0` and a zero floor is the absence of a floor.
        const sum = inputSummaries;
        // SKU Floors is genuinely auto since Stage 8 (sync-sku-floors, 2026-07-31).
        //
        // ⚠ NO `note` HERE ON PURPOSE — for an auto-synced input the hardcoded note is
        // actively harmful, not just stale. SourcePill does `note || prov.note`, so a
        // literal string SUPPRESSES the state-derived note from assessSyncedInput —
        // including "Auto-sync has missed a night". This card carried
        // "Google Sheet sync is the next step" for three days after that sync went live,
        // so the one input whose overdue warning we most needed could not have shown it.
        // Leave `note` off anything with an auto writer; let the derived note through.
        const autoBucketCards=[
          {label:"SKU Floors - DS Level",desc:"Per-store Min/Max floors from the ops Google Sheet. Columns: SKU, DS01 Min, DS01 Max, ..., DS06 Max, DC Min, DC Max",handler:handleNSQ,key:"newSKUQty",required:true,
           count:`${sum.newSKUQty.count.toLocaleString()} ${sum.newSKUQty.unit}`,hasData:sum.newSKUQty.total>0},
        ];
        const opsCards=[
          {label:"Newly Launched Dark Store Floor Qty",desc:"Columns: SKU, Qty",handler:handleMRQ,key:"minReqQty",required:true,
           note:"Ops judgement — never auto-synced",
           count:`${sum.minReqQty.count.toLocaleString()} ${sum.minReqQty.unit}`,hasData:sum.minReqQty.total>0},
          {label:"Dead Stock List",desc:"Column: Dead Stock (SKU list)",handler:handleDead,key:"deadStock",required:false,
           note:"Ops judgement — never auto-synced",
           count:`${sum.deadStock.count.toLocaleString()} ${sum.deadStock.unit}`,hasData:sum.deadStock.total>0},
          {label:"SKU Ceilings - DS Level",desc:"Hard cap on Min/Max per store, whatever the strategy computed. Columns: SKU, DS01 Cap, ..., DS06 Cap. Blank = no cap, 0 = stock nothing there.",handler:handleCeiling,key:"skuCeiling",required:false,
           note:"Ops judgement — never auto-synced. Shows an impact preview before saving.",
           count:`${sum.skuCeiling.count.toLocaleString()} ${sum.skuCeiling.unit}`,hasData:sum.skuCeiling.total>0},
        ];

        // One card body, rendered for BOTH buckets so the two groups cannot
        // drift apart visually. `item.note` supplies the pill tooltip, which is what
        // lets SKU Floors sit in AUTO while honestly reporting itself as manual.
        const renderUploadCard = (item) => (
            <div style={{...S.card,display:"flex",flexDirection:"column",minHeight:130,...(shared?SHARED_CARD:{})}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <span style={{fontWeight:700,color:HR.text,fontSize:12}}>{item.label}</span>
                    {item.required&&<span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>}
                    <div style={{position:"relative",display:"inline-flex",alignItems:"center"}}>
                      <span onMouseEnter={()=>setInfoCard(item.key)} onMouseLeave={()=>setInfoCard(null)} style={{cursor:"help",color:HR.muted,fontSize:11,userSelect:"none"}}>ⓘ</span>
                      {infoCard===item.key&&<div style={{position:"absolute",top:"120%",left:0,zIndex:30,background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"6px 10px",fontSize:10,color:HR.text,whiteSpace:"normal",maxWidth:260,boxShadow:"0 2px 8px rgba(0,0,0,0.15)",lineHeight:1.6}}>{item.desc}</div>}
                    </div>
                  </div>
                  <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
                    <div style={{fontSize:11,color:HR.green,fontWeight:600}}>{item.count}</div>
                    {sum[item.key].total!==sum[item.key].count&&
                      <div style={{fontSize:9,color:HR.muted,marginTop:1}}>of {sum[item.key].total.toLocaleString()} rows</div>}
                    <div style={{marginTop:3}}><SourcePill prov={inputProvenance[item.key]} note={item.note}/></div>
                  </div>
                </div>
                <div style={{marginTop:"auto"}}>
                  {uploadedFiles[item.key]&&<div style={{fontSize:9,color:"#6B7280",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📄 {uploadedFiles[item.key]}</div>}
                  {uploading===item.key&&<div style={{height:3,background:"#E5E5E5",borderRadius:2,overflow:"hidden",marginBottom:6}}><div style={{height:"100%",width:"30%",background:HR.green,borderRadius:2,animation:"upload-progress 1.2s ease-in-out infinite"}}/></div>}
                  {shared?SHARED_NOTE:<div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={item.handler} style={{display:"none"}}/></label>
                    <button onClick={()=>{const t=templates[item.key];dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
                    {item.hasData&&<button onClick={()=>{const csv=buildDataCSV(item.key);if(csv)dlCSV(item.key+"_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
                    {item.hasData&&<button onClick={()=>clearData(item.key)} style={clrBtnS}>🗑 Clear</button>}
                  </div>}
                </div>
              </div>
        );

        const btnS = (color, text) => ({background:color,color:HR.white,padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,border:"none",whiteSpace:"nowrap"});
        const dlBtnS = {background:"#F3E8FF",color:"#7C3AED",border:"1px solid #D8B4FE",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"};
        const tplBtnS = {background:"#EAF9FF",color:"#0077A8",border:"1px solid #A5F3FC",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"};
        const clrBtnS = {background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FECACA",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"};

        return(<>
          {/* Hyderabad's own cards (its floors card) sit first; Bangalore passes none. */}
          {extraCards}
          {/* ── AUTO bucket. Tinted panel + accent border + solid badge, because a
                 small uppercase heading was too quiet to separate the two groups. ── */}
          <div style={{background:"#F7FCFF",border:`1px solid ${DC_COLOR.header}33`,borderLeft:`4px solid ${DC_COLOR.header}`,borderRadius:8,padding:"10px 12px 12px",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
              <span style={{background:DC_COLOR.header,color:HR.white,padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:800,letterSpacing:0.5}}>⟳ AUTO</span>
              <span style={{fontSize:12,fontWeight:700,color:DC_COLOR.text}}>Updated daily without anyone touching it</span>
              <span style={{fontSize:10,color:HR.muted}}>manual upload is the fallback when a sync breaks</span>
            </div>
          {/* ── Invoice + SKU Master + Prices + SKU Floors ── */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>

            {/* Invoice card */}
            <div style={{...S.card,display:"flex",flexDirection:"column",minHeight:130,...(shared?SHARED_CARD:{})}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontWeight:700,color:HR.text,fontSize:12}}>Invoice Data</span>
                  <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>
                  <div style={{position:"relative",display:"inline-flex",alignItems:"center"}}>
                    <span onMouseEnter={()=>setInfoCard("invoiceData")} onMouseLeave={()=>setInfoCard(null)} style={{cursor:"help",color:HR.muted,fontSize:11,userSelect:"none"}}>ⓘ</span>
                    {infoCard==="invoiceData"&&<div style={{position:"absolute",top:"120%",left:0,zIndex:30,background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"6px 10px",fontSize:10,color:HR.text,whiteSpace:"normal",maxWidth:260,boxShadow:"0 2px 8px rgba(0,0,0,0.15)",lineHeight:1.6}}>Invoice Date, Invoice Number, Invoice Status, Shopify Order, Item Name, SKU, Category Name, Quantity, Line Item Location Name, Shipping Code</div>}
                  </div>
                </div>
                <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
                  <div style={{fontSize:11,color:HR.green,fontWeight:600}}>{sum.invoiceData.count.toLocaleString()} {sum.invoiceData.unit}</div>
                  <div style={{fontSize:9,color:HR.muted,marginTop:1}}>{sum.invoiceData.days}d · to {sum.invoiceData.through||"—"}</div>
                  {/* No `note` — auto since Stage 5 (2026-08-03); see autoBucketCards. */}
                  <div style={{marginTop:3}}><SourcePill prov={inputProvenance.invoiceData}/></div>
                </div>
              </div>
              <div style={{marginTop:"auto"}}>
                {uploadedFiles.invoiceData&&<div style={{fontSize:9,color:"#6B7280",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📄 {uploadedFiles.invoiceData}</div>}
                {uploading==="invoiceData"&&<div style={{height:3,background:"#E5E5E5",borderRadius:2,overflow:"hidden",marginBottom:6}}><div style={{height:"100%",width:"30%",background:HR.green,borderRadius:2,animation:"upload-progress 1.2s ease-in-out infinite"}}/></div>}
                {shared?SHARED_NOTE:<div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={handleInvoice} style={{display:"none"}}/></label>
                  <button onClick={()=>{const t=templates.invoiceData;dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
                  {invoiceData.length>0&&<button onClick={()=>{const csv=buildDataCSV("invoiceData");if(csv)dlCSV("invoiceData_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
                  {invoiceData.length>0&&<button onClick={()=>clearData("invoiceData")} style={clrBtnS}>🗑 Clear</button>}
                </div>}
              </div>
            </div>

            {/* SKU Master card */}
            <div style={{...S.card,display:"flex",flexDirection:"column",minHeight:130,...(shared?SHARED_CARD:{})}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontWeight:700,color:HR.text,fontSize:12}}>SKU Master</span>
                  <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>
                  <div style={{position:"relative",display:"inline-flex",alignItems:"center"}}>
                    <span onMouseEnter={()=>setInfoCard("skuMaster")} onMouseLeave={()=>setInfoCard(null)} style={{cursor:"help",color:HR.muted,fontSize:11,userSelect:"none"}}>ⓘ</span>
                    {infoCard==="skuMaster"&&<div style={{position:"absolute",top:"120%",left:0,zIndex:30,background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"6px 10px",fontSize:10,color:HR.text,whiteSpace:"normal",maxWidth:260,boxShadow:"0 2px 8px rgba(0,0,0,0.15)",lineHeight:1.6}}>Name, Inventorised At, SKU, Category, Status, Brand, Purchase, Move</div>}
                  </div>
                </div>
                <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
                  <div style={{fontSize:11,color:HR.green,fontWeight:600}}>{sum.skuMaster.count.toLocaleString()} {sum.skuMaster.unit}</div>
                  <div style={{fontSize:9,color:HR.muted,marginTop:1}}>of {sum.skuMaster.total.toLocaleString()} total</div>
                  <div style={{marginTop:3}}><SourcePill prov={inputProvenance.skuMaster}/></div>
                </div>
              </div>
              <div style={{marginTop:"auto"}}>
                {uploadedFiles.skuMaster&&<div style={{fontSize:9,color:"#6B7280",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📄 {uploadedFiles.skuMaster}</div>}
                {uploading==="skuMaster"&&<div style={{height:3,background:"#E5E5E5",borderRadius:2,overflow:"hidden",marginBottom:6}}><div style={{height:"100%",width:"30%",background:HR.green,borderRadius:2,animation:"upload-progress 1.2s ease-in-out infinite"}}/></div>}
                {shared?SHARED_NOTE:<div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={handleSKU} style={{display:"none"}}/></label>
                  <button onClick={()=>{const t=templates.skuMaster;dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
                  {Object.keys(skuMaster).length>0&&<button onClick={()=>{
                    const q=v=>`"${(v||"").replace(/"/g,'""')}"`;
                    const h=["Name","Inventorised At","SKU","Category","Brand","Status","Purchase","Move"];
                    const rows=Object.values(skuMaster).map(s=>[q(s.name),q(s.inventorisedAt||"DS"),q(s.sku),q(s.category),q(s.brand),q(s.status||"Active"),q(normalisePolicy(s.purchase)),q(normalisePolicy(s.move))].join(","));
                    const blob=new Blob([[h.join(","),...rows].join("\n")],{type:"text/csv"});
                    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="skuMaster_data.csv";a.click();
                  }} style={dlBtnS}>⬇ Data</button>}
                  {Object.keys(skuMaster).length>0&&<button onClick={()=>clearData("skuMaster")} style={clrBtnS}>🗑 Clear</button>}
                </div>}
              </div>
            </div>

            {/* Purchase Prices card */}
            <div style={{...S.card,display:"flex",flexDirection:"column",minHeight:130,...(shared?SHARED_CARD:{})}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontWeight:700,color:HR.text,fontSize:12}}>Purchase Prices</span>
                  <span style={{color:"#B91C1C",fontSize:10,fontWeight:400}}>required</span>
                  <div style={{position:"relative",display:"inline-flex",alignItems:"center"}}>
                    <span onMouseEnter={()=>setInfoCard("priceData")} onMouseLeave={()=>setInfoCard(null)} style={{cursor:"help",color:HR.muted,fontSize:11,userSelect:"none"}}>ⓘ</span>
                    {infoCard==="priceData"&&<div style={{position:"absolute",top:"120%",left:0,zIndex:30,background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"6px 10px",fontSize:10,color:HR.text,whiteSpace:"normal",maxWidth:260,boxShadow:"0 2px 8px rgba(0,0,0,0.15)",lineHeight:1.6}}>item_id, item_name, unit, is_combo_product, quantity_purchased, amount, average_price, location_name, sku</div>}
                  </div>
                </div>
                <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
                  <div style={{fontSize:11,color:HR.green,fontWeight:600}}>{sum.priceData.count.toLocaleString()} {sum.priceData.unit}</div>
                  <div style={{fontSize:9,color:HR.muted,marginTop:1}}>of {sum.skuMaster.count.toLocaleString()} active</div>
                  <div style={{marginTop:3}}><SourcePill prov={inputProvenance.priceData}/></div>
                </div>
              </div>
              <div style={{marginTop:"auto"}}>
                {uploadedFiles.priceData&&<div style={{fontSize:9,color:"#6B7280",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📄 {uploadedFiles.priceData}</div>}
                {uploading==="priceData"&&<div style={{height:3,background:"#E5E5E5",borderRadius:2,overflow:"hidden",marginBottom:6}}><div style={{height:"100%",width:"30%",background:HR.green,borderRadius:2,animation:"upload-progress 1.2s ease-in-out infinite"}}/></div>}
                {shared?SHARED_NOTE:<div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  <label style={{...btnS(HR.green,""),cursor:"pointer"}}>⬆ Upload CSV<input type="file" accept=".csv" onChange={handlePrice} style={{display:"none"}}/></label>
                  <button onClick={()=>{const t=templates.priceData;dlTemplate(t.file,t.headers,t.rows);}} style={tplBtnS}>⬇ Template</button>
                  {Object.keys(priceData).length>0&&<button onClick={()=>{const csv=buildDataCSV("priceData");if(csv)dlCSV("priceData_data.csv",csv);}} style={dlBtnS}>⬇ Data</button>}
                  {Object.keys(priceData).length>0&&<button onClick={()=>clearData("priceData")} style={clrBtnS}>🗑 Clear</button>}
                </div>}
              </div>
            </div>

            {autoBucketCards.map(renderUploadCard)}
          </div>
          </div>

          {/* ── MANUAL bucket: ops judgement, never auto-synced ── */}
          <div style={{background:"#FFFDF5",border:`1px solid ${HR.yellowDark}33`,borderLeft:`4px solid ${HR.yellowDark}`,borderRadius:8,padding:"10px 12px 12px",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
              <span style={{background:HR.yellowDark,color:HR.white,padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:800,letterSpacing:0.5}}>✎ MANUAL</span>
              <span style={{fontSize:12,fontWeight:700,color:"#7A5800"}}>Set by ops, by hand</span>
              <span style={{fontSize:10,color:HR.muted}}>judgement calls, not Zoho data — these will never auto-sync</span>
            </div>
          {/* ── New DS Floor Qty + Dead Stock + SKU Ceilings ──
              ⚠ DERIVED from the card count, not hardcoded. This was `repeat(2,1fr)`
              from when there were exactly two cards, so adding SKU Ceilings wrapped
              the third onto its own row while the AUTO bucket sat on one line. Same
              class as the PO CSV column indices: a literal that silently stops
              matching the thing it describes. `minmax(0,1fr)` rather than `1fr`
              because `1fr` is `minmax(auto,1fr)` — a long unbreakable card title
              would otherwise widen its column and overflow the row. */}
          <div style={{display:"grid",gridTemplateColumns:`repeat(${opsCards.length},minmax(0,1fr))`,gap:12}}>
            {opsCards.map(renderUploadCard)}
          </div>
          </div>
        </>);
      })()}

      {/* ── What the model ran with. Moved down from above the inputs (2026-07-30):
             it is a diagnostic summary, so it belongs next to the Missing SKUs table
             it explains, after the cards it summarises.

             ⚠ Counts come from inputSummary.js — the same numbers the cards show. It
             used to read "Invoice Rows 74,381", which is line items, not invoices, and
             disagreed with the Invoice Data card. Values come from `modelSnapshot`
             (i.e. as of the last run) when one exists; a snapshot taken before
             `invoiceCount` was recorded falls back to rows AND relabels itself, rather
             than presenting rows under an "Invoices" heading. ── */}
      {!shared&&(<div style={{display:"flex",gap:0,background:HR.surface,border:`1px solid ${HR.border}`,borderRadius:8,overflow:"hidden",marginTop:4}}>
        {(()=>{
          const s=modelSnapshot;
          const mis=s?s.missingCount:missing.length;
          const iv=inputSummaries.invoiceData;
          return[
          {label:"Invoice Data",  value:s?`${s.dateMin} → ${s.dateMax}`:iv.from&&iv.through?`${iv.from} → ${iv.through}`:"No data", color:HR.muted, small:true},
          {label:(s&&s.invoiceCount===undefined)?"Invoice Rows":"Invoices",
                                  value:(s?(s.invoiceCount??s.rowCount):iv.count).toLocaleString(),      color:"#0077A8"},
          {label:"Active SKUs",   value:(s?s.activeSkus:inputSummaries.skuMaster.count).toLocaleString(),color:HR.green},
          {label:"SKUs Sold",     value:(s?s.uniqueSold:uniqueSold).toLocaleString(),                    color:HR.yellowDark},
          {label:"Zero Sale",     value:(s?s.zeroSale:zeroSale).toLocaleString(),                        color:"#C05A00"},
          {label:"Dead Stock",    value:(s?s.deadStockCount:inputSummaries.deadStock.count).toLocaleString(),color:"#B91C1C"},
          {label:"Price SKUs",    value:(s?s.priceSkus:inputSummaries.priceData.count).toLocaleString(), color:"#7A3DBF"},
          {label:"Missing SKUs",  value:mis.toLocaleString(),                                            color:mis>0?"#B91C1C":HR.green},
          ];})().map((c,i)=>(
          <div key={c.label} style={{flex:1,padding:"8px 10px",borderRight:i<7?`1px solid ${HR.border}`:"none",minWidth:0}}>
            <div style={{fontSize:9,color:HR.muted,fontWeight:600,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.label}</div>
            <div style={{fontSize:c.small?9:13,fontWeight:c.small?400:700,color:c.color,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.value}</div>
          </div>
        ))}
      </div>)}

      {/* ── Errors: missing SKUs ── */}
      {!shared&&missing.length>0&&(
        <div style={{...S.card,marginTop:8,border:`1px solid ${HR.yellow}`}}>
          <div style={{fontWeight:700,color:HR.yellowDark,marginBottom:3,fontSize:13}}>⚠ {missing.length} SKUs in Invoice not Active in SKU Master</div>
          <div style={{fontSize:11,color:HR.muted,marginBottom:10}}>These SKUs have sales but are missing or inactive in SKU Master. Each one is either absent from the catalogue or not Active in it, so the engine gives it no Min/Max.</div>
          {/* No maxHeight: the table runs to its natural length and the PAGE scrolls
              (S.pageWrap already owns overflowY). A 400px inner scroller left dead
              space below it and hid rows behind a second scrollbar. `sticky` keeps the
              header visible while scrolling the page instead. */}
          <div>
            <table style={S.table}><thead><tr style={{background:HR.surfaceLight}}><th style={{...S.th,position:"sticky",top:0,zIndex:1,background:HR.surfaceLight}}>SKU</th><th style={{...S.th,position:"sticky",top:0,zIndex:1,background:HR.surfaceLight}}>Status in Master</th></tr></thead>
              <tbody>{missing.map((s,i)=><tr key={s} style={{background:i%2===0?HR.white:HR.surfaceLight}}><td style={S.td}>{s}</td><td style={{...S.td,color:skuMaster[s]?HR.yellowDark:"#B91C1C",fontSize:11}}>{skuMaster[s]?skuMaster[s].status:"Not in SKU Master"}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  </div>
  );
}
