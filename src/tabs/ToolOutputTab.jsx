import React from "react";
import { loadFromSupabase } from "../supabase";
import { buildPoTargetsCsv, poCsvFilename, buildPoCsvHeaders } from "../poTargetsCsv";
import { normaliseStatus } from "../skuStatus";
import { normalisePolicy } from "../skuPolicy";
import { buildZeroSaleCsv, zeroSaleFilename, ZERO_SALE_CSV_HEADERS } from "../zeroSaleCsv";
import { buildInnerCasePackCsv, buildPurchasePriceCsv, innerCasePackFilename, purchasePriceFilename,
  countPricedSkus, INNER_CASE_PACK_CSV_HEADERS, PURCHASE_PRICE_CSV_HEADERS } from "../refDataCsv";
import { DS_LIST, liveDsList, getPriceTag } from "../engine/index.js";
import { downloadCsvFile } from "../downloadCsv";
import { HR, S } from "../appStyles";

/**
 * One download on the Tool Output tab.
 *
 * Replaced a full-width Min/Max table there on 2026-08-03. The table was virtualised so
 * it cost little to render, but the tab is called "Tool Output Download" and a read-only
 * viewer was not what anyone opened it for — every number it showed is available in SKU
 * Detail, Overview, Stock Health or Manual Overrides.
 *
 * `footnote` exists for the one thing a button row had no room for: how current the
 * numbers are. These files serialise a client-side recompute from page load, so a tab
 * left open overnight produces yesterday's targets in a file that looks entirely normal.
 */
const DownloadCard=React.memo(({title,accent,blurb,shape,cta,footnote,primary,disabled,onClick,hint,actions})=>{
  // ONE button style, shared by both paths, so the multi-button row cannot drift from
  // the single button the other cards use the first time anyone restyles a card. That
  // drift is why a separate MultiDownloadCard was rejected: it would have duplicated
  // the border, accent, blurb, shape, footnote and disabled styling as well.
  const btn=(off)=>({background:off?"#E5E5E5":accent,color:off?"#999":HR.white,border:"none",
    padding:"9px 12px",borderRadius:6,cursor:off?"not-allowed":"pointer",
    fontWeight:primary?800:700,fontSize:12,width:"100%"});
  return(
  <div style={{...S.card,display:"flex",flexDirection:"column",gap:8,borderTop:`3px solid ${disabled?"#ccc":accent}`,
    ...(primary&&!disabled?{boxShadow:`0 2px 12px ${accent}38`}:{})}}>
    <div style={{fontWeight:800,fontSize:13,color:HR.text,letterSpacing:0.2}}>{title}</div>
    <div style={{fontSize:11,color:HR.muted,lineHeight:1.5,flex:1}}>{blurb}</div>
    <div style={{fontSize:10,color:HR.muted,fontFamily:"monospace"}}>{shape}</div>
    {/* `actions` is OPTIONAL and the four original cards pass nothing, so they take the
        single-button path below unchanged — that is the acceptance bar for this prop.
        A per-action `disabled` lets one button refuse (a window with too few invoice
        dates) while its siblings stay live. */}
    {actions?.length?(
      <div style={{display:"flex",gap:6}}>
        {actions.map(a=>(
          <button key={a.label} disabled={disabled||a.disabled} onClick={a.onClick} title={a.hint}
            style={{...btn(disabled||a.disabled),padding:"9px 4px"}}>{a.label}</button>
        ))}
      </div>
    ):(
      <button disabled={disabled} onClick={onClick} title={hint}
        style={btn(disabled)}>{cta}</button>
    )}
    <div style={{fontSize:10,color:HR.muted,textAlign:"center",minHeight:13}}>{footnote||""}</div>
  </div>
);});

/**
 * Tool Output Download tab — moved verbatim out of App.jsx. App still owns the state
 * (packsAt and its on-open fetch, the freshness gate, zero-sale lists) and passes it in.
 */
export default function ToolOutputTab({ results, skuMaster, params, priceData, coreOverrides, provRaw,
  outputDemandThrough, outputFreshness, zeroSaleLists, packsAt, setPacksAt, fmtStamp }) {
  return (
          !results?<div style={{textAlign:"center",padding:80,color:HR.muted,fontSize:13}}>Loading data, please wait...</div>:(
            <div style={{display:"flex",flexDirection:"column",height:"100%",gap:12}}>
              <div>
                <h2 style={{color:HR.yellowDark,margin:0,fontSize:16}}>Tool Output Download</h2>
                <div style={{fontSize:11,color:HR.muted,marginTop:4}}>
                  Every file below is generated from the data and model held in <b>this browser tab</b>.
                  If it has been open a while, hard-reload before downloading.
                  {outputDemandThrough&&<> Currently showing demand through <b>{outputDemandThrough}</b>.</>}
                </div>
              </div>

              {/* ⚠ Blocks EVERY download on this tab, but only on positive evidence that newer
                  demand data was published (assessOutputFreshness). A failed or unknown
                  check leaves every download working — a blocked download at 06:00 IST
                  stops purchasing, which is worse than a slightly stale file. */}
              {outputFreshness.blocked&&(
                <div style={{background:"#FEF3C7",border:"1px solid #FCD34D",borderRadius:8,padding:"12px 14px",
                  display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
                  <div style={{flex:1,minWidth:280}}>
                    <div style={{fontWeight:800,fontSize:12,color:"#92400E"}}>⚠ Newer demand data is available — downloads are disabled</div>
                    <div style={{fontSize:11,color:"#92400E",marginTop:3,lineHeight:1.5}}>
                      This page computed Min/Max from demand through <b>{outputFreshness.pageThrough}</b>,
                      but <b>{outputFreshness.liveThrough}</b> has since been published.
                      Reload to recompute, then download.
                    </div>
                  </div>
                  <button onClick={()=>window.location.reload()}
                    style={{background:"#92400E",color:HR.white,border:"none",padding:"9px 18px",borderRadius:6,
                      cursor:"pointer",fontWeight:800,fontSize:12,whiteSpace:"nowrap"}}>↻ Reload now</button>
                </div>
              )}

              <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,alignItems:"stretch"}}>

                {/* ── PO Team Download ─────────────────────────────────────────────
                    Column order is a FROZEN CONTRACT (src/poTargetsCsv.js): the PO
                    team's sheet formulas key on position, so a reorder produces wrong
                    POs rather than an error. Anything new goes AFTER DS06 Max. */}
                <DownloadCard
                  primary
                  title="PO Team Download"
                  accent="#F97316"
                  blurb={<>Min/Max targets for raising POs. One row per SKU with <b>DC and DS01–DS06 side by side</b>, plus Inventorised At and Status so the sheet can filter out Supplier and inactive items.</>}
                  shape={`${buildPoCsvHeaders(liveDsList(params)).length} columns · ${Object.keys(skuMaster).length.toLocaleString()} SKUs`}
                  cta="⬇ PO Team Download"
                  footnote={outputDemandThrough?`demand through ${outputDemandThrough}`:null}
                  hint="Filter on Status = Active and Inventorised At ≠ Supplier in your sheet."
                  disabled={!results||outputFreshness.blocked}
                  onClick={async ()=>{
                    const csv=buildPoTargetsCsv({skuMaster,results,coreOverrides,dsList:liveDsList(params)});
                    if(!csv){alert("No SKU Master loaded — nothing to download.");return;}

                    // No staleness check here — the banner above gates every download
                    // on this tab before the click, so reaching this point means the page
                    // is fresh or the check could not prove otherwise.
                    const d=new Date(),p=n=>String(n).padStart(2,"0");
                    downloadCsvFile(poCsvFilename({
                      refreshedOn:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`,
                      demandThrough:outputDemandThrough,
                    }),csv);
                  }}
                />

                {/* ── Tool Output DS Level ── */}
                <DownloadCard
                  title="Tool Output — DS Level"
                  accent={HR.green}
                  blurb="Per-store Min/Max only, no DC column. Manual overrides are applied, so this matches what the stores are actually stocked to."
                  shape={`15 columns · ${Object.keys(skuMaster).length.toLocaleString()} SKUs`}
                  cta="⬇ Download DS Level"
                  disabled={!results||outputFreshness.blocked}
                  onClick={()=>{
                    const hdr=["Item Name","SKU","Category",...DS_LIST.flatMap(d=>[`${d} Min`,`${d} Max`])].join(",");
                    const rows=Object.values(skuMaster).map(s=>{
                      const r=results[s.sku];
                      const dsCols=DS_LIST.flatMap(d=>{
                        const st=r?.stores[d]||{min:0,max:0};
                        const ov=coreOverrides[s.sku]?.[d];
                        const min=ov?Math.max(st.min,ov.min):st.min;
                        const max=ov?Math.max(st.max,ov.max):st.max;
                        return[min,max];
                      });
                      return[
                        `"${(s.name||s.sku).replace(/"/g,'""')}"`,
                        `"${s.sku.replace(/"/g,'""')}"`,
                        `"${(s.category||"").replace(/"/g,'""')}"`,
                        ...dsCols,
                      ].join(",");
                    });
                    downloadCsvFile("IMS_Output_DS.csv",[hdr,...rows].join("\n"));
                  }}
                />

                {/* ── Tool Output DC ── */}
                <DownloadCard
                  title="Tool Output — DC"
                  accent="#0077A8"
                  blurb="DC Min/Max only. Note DS-inventorised and Supplier SKUs read 0/0 here by design — they never flow through the DC."
                  shape={`5 columns · ${Object.keys(skuMaster).length.toLocaleString()} SKUs`}
                  cta="⬇ Download DC"
                  disabled={!results||outputFreshness.blocked}
                  onClick={()=>{
                    const hdr=["Item Name","SKU","Category","DC Min","DC Max"].join(",");
                    const rows=Object.values(skuMaster).map(s=>{
                      const r=results[s.sku];
                      return[
                        `"${(s.name||s.sku).replace(/"/g,'""')}"`,
                        `"${s.sku.replace(/"/g,'""')}"`,
                        `"${(s.category||"").replace(/"/g,'""')}"`,
                        r?.dc.min??0,
                        r?.dc.max??0,
                      ].join(",");
                    });
                    downloadCsvFile("IMS_Output_DC.csv",[hdr,...rows].join("\n"));
                  }}
                />

                {/* ── SKU Master ── */}
                <DownloadCard
                  title="SKU Master"
                  accent="#7C3AED"
                  blurb="The catalogue as the model sees it — category, brand and status, plus the Price Tag and Top-N volume tag the engine assigned to each SKU."
                  shape={`8 columns · ${Object.keys(skuMaster).length.toLocaleString()} SKUs`}
                  cta="⬇ Download SKU Master"
                  disabled={!results||outputFreshness.blocked}
                  onClick={()=>{
                    const hdr=["Item Name","Inventorised At","SKU","Category","Status","Purchase","Move","Brand","Price Tag","Top N"].join(",");
                    const rows=Object.values(skuMaster).map(s=>{
                      const res=results[s.sku];
                      const priceTag=res?.meta?.priceTag||getPriceTag(priceData[s.sku]||0,params.priceTiers);
                      const topN=res?.meta?.t150Tag||"Zero Sale";
                      return[
                        `"${(s.name||"").replace(/"/g,'""')}"`,
                        `"${(s.inventorisedAt||"").replace(/"/g,'""')}"`,
                        `"${s.sku.replace(/"/g,'""')}"`,
                        `"${(s.category||"").replace(/"/g,'""')}"`,
                        // Shared with the PO Team Download so the two files can never
                        // disagree on how a status is spelled — Zoho sends four
                        // spellings (see skuStatus.js).
                        `"${normaliseStatus(s.status)}"`,
                        // Canonicalised for the same reason Status is: the two Zoho
                        // fields speak DIFFERENT vocabularies (cf_purchase_status is
                        // ON/OFF, cf_move is Yes/No), so the raw values would put two
                        // spellings in one column and a sheet formula would match
                        // neither. normalisePolicy is the one writer all three CSVs
                        // share, so they cannot disagree.
                        `"${normalisePolicy(s.purchase)}"`,
                        `"${normalisePolicy(s.move)}"`,
                        `"${(s.brand||"").replace(/"/g,'""')}"`,
                        priceTag,
                        topN,
                      ].join(",");
                    });
                    downloadCsvFile("SKU_Master.csv",[hdr,...rows].join("\n"));
                  }}
                />

                {/* ── Zero Sale SKUs ───────────────────────────────────────────────
                    The FIFTH child of a 4-column grid, so it flows to row 2 column 1 —
                    directly below the PO card, at identical width. No grid change, no
                    wrapper, no explicit placement: if you find yourself editing
                    gridTemplateColumns, the requirement is already satisfied by append
                    order.

                    Unlike the four above, this file does NOT serialise engine output —
                    it reads invoice history directly, so it is unaffected by the
                    params the model was last run with. It is gated on the same banner
                    anyway: one live button under "downloads are disabled" reads as a
                    bug, and the gate costs nothing here. */}
                <DownloadCard
                  title="Zero Sale SKUs"
                  accent="#DC2626"
                  blurb={<>Active SKUs that sold <b>nothing, anywhere</b>, across the trailing window — a delisting shortlist. Supplier, Dead Stock and DC-only SKUs are all kept in; filter them in the sheet on <b>Inventorised At</b> and <b>Status</b>. ⚠ The master holds no created-date, so a <b>SKU added last week looks identical to one dead for a year</b> — check age before delisting.</>}
                  shape={`${ZERO_SALE_CSV_HEADERS.length} columns · ${zeroSaleLists.windows.map(w=>w.available?w.skus.length.toLocaleString():"—").join(" / ")} SKUs`}
                  footnote={zeroSaleLists.activeCount?`of ${zeroSaleLists.activeCount.toLocaleString()} active SKUs`:null}
                  disabled={!results||outputFreshness.blocked}
                  actions={zeroSaleLists.windows.map(w=>({
                    label:`${w.days} Days`,
                    // ⚠ RETENTION_DAYS = 90 trims the invoice row nightly, so L90D sits
                    // permanently at the edge of the data. After a bad night or a
                    // restore this button refuses rather than emitting 84 days of rows
                    // under a filename claiming 90.
                    disabled:!w.available,
                    hint:w.available
                      ?`${w.skus.length.toLocaleString()} Active SKUs with zero sales · ${w.from} → ${w.to}`
                      :`Needs ${w.days} invoice dates — only ${zeroSaleLists.dateCount} are held.`,
                    onClick:()=>{
                      const csv=buildZeroSaleCsv({skus:w.skus,priceData,priceTiers:params.priceTiers});
                      if(!csv){alert(`No Active SKUs had zero sales over the last ${w.days} days.`);return;}
                      // Filename carries the RESOLVED range, not just the duration: a
                      // window is "the last N dates PRESENT", so "L90D" is a claim the
                      // data can fail to back.
                      downloadCsvFile(zeroSaleFilename(w),csv);
                    },
                  }))}
                />

                {/* ── Inner Case Pack - Mid Mile ─────────────────────────────────────
                    Reads params/innerCasePacks, which the TO tool (homerun-to) writes from
                    the DC team's Google Sheet — this repo never writes it. Fetched ON CLICK,
                    so a tab open for hours still downloads what the TO tool is using now.
                    Not engine output; gated on the banner only so no button stays live
                    under "downloads are disabled". See src/refDataCsv.js. */}
                <DownloadCard
                  title="Inner Case Pack - Mid Mile"
                  accent="#0F766E"
                  blurb={<>The inner case pack each SKU ships in from DC. The TO tool rounds every transfer up to a whole pack. SKUs not in the team&apos;s sheet read <b>1</b> — exactly what the TO tool applies to them.</>}
                  shape={`${INNER_CASE_PACK_CSV_HEADERS.length} columns · ${Object.keys(skuMaster).length.toLocaleString()} SKUs`}
                  cta="⬇ Download Inner Case Pack"
                  footnote={packsAt?`updated ${fmtStamp(packsAt)}`:null}
                  disabled={outputFreshness.blocked}
                  onClick={async ()=>{
                    const row=await loadFromSupabase("params","innerCasePacks");
                    if(!row?.packs){alert("Could not load inner case packs — try again in a minute.");return;}
                    const csv=buildInnerCasePackCsv({skuMaster,packs:row.packs});
                    if(!csv){alert("No SKU Master loaded — nothing to download.");return;}
                    setPacksAt(row.refreshedAt??null);
                    downloadCsvFile(innerCasePackFilename(),csv);
                  }}
                />

                {/* ── Purchase Prices ────────────────────────────────────────────────
                    priceData = Zoho's 12-MONTH AVERAGE purchase price (sync-catalogue
                    nightly), the same figure the engine prices with — NOT the current
                    purchase rate, hence the column name. Blank, never 0, when unpriced. */}
                <DownloadCard
                  title="Purchase Prices"
                  accent="#B45309"
                  blurb={<>Each SKU&apos;s <b>average purchase price over the last 12 months</b>, from Zoho — the price the model uses for price tags and inventory value. Not the latest purchase rate. Blank where Zoho has no purchase in the window.</>}
                  shape={`${PURCHASE_PRICE_CSV_HEADERS.length} columns · ${countPricedSkus(skuMaster,priceData).toLocaleString()} priced of ${Object.keys(skuMaster).length.toLocaleString()} SKUs`}
                  cta="⬇ Download Purchase Prices"
                  footnote={provRaw.catalogueAt?`catalogue synced ${fmtStamp(provRaw.catalogueAt)}`:null}
                  disabled={outputFreshness.blocked}
                  onClick={()=>{
                    const csv=buildPurchasePriceCsv({skuMaster,priceData});
                    if(!csv){alert("No SKU Master loaded — nothing to download.");return;}
                    downloadCsvFile(purchasePriceFilename(),csv);
                  }}
                />

              </div>
            </div>
          )
  );
}
