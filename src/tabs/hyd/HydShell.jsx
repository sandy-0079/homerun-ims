// Hyderabad tab bodies. Rendered by App.jsx in place of the Bangalore tab bodies
// when city === "hyd"; receives everything it needs as props and never touches a
// Bangalore row. Prop interface:
//   { tab, isAdmin, invoiceData, skuMaster, priceData, deadStock /*Set*/,
//     stockData, stockDataAccounting, uploadedAtPerDS,
//     hydState, setHydState, hydRun /* {results, report} | null */,
//     blrParams /* Bangalore's applied params, for "Reset to Bangalore" */ }
import React, { useState } from "react";
import { card, note, banner } from "./hydStyles.js";
import HydOverview from "./HydOverview.jsx";
import HydSkuDetail from "./HydSkuDetail.jsx";
import HydToolOutput from "./HydToolOutput.jsx";
import HydUploadPanel from "./HydUploadPanel.jsx";
import HydLogicTweaker from "./HydLogicTweaker.jsx";
import HydPlywoodPanel from "./HydPlywoodPanel.jsx";
import StockHealthTab from "../StockHealthTab.jsx";
import HydStockNotice from "./HydStockNotice.jsx";
import { HYD_DS_LIST } from "../../city.js";

// Sync Now for Pati: its own group, never a branch added to a Bangalore group.
const HYD_SYNC_GROUPS = [["HYDS01"]];

function Errors({ hydState, hydRun }) {
  const errors = [...(hydState?.loadErrors || []), ...(hydRun?.error ? [`engine: ${hydRun.error}`] : [])];
  if (!errors.length) return null;
  return <div style={banner("error")}>{errors.map(e => <div key={e}>{e}</div>)}</div>;
}

export default function HydShell(props) {
  const { tab, hydState, hydRun } = props;
  // Stock Health notice dismissal: this page session only (survives tab switches,
  // not a reload). Before the early return — hooks must run on every render.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;
  return (
    <div>
      <Errors hydState={hydState} hydRun={hydRun} />
      {tab === "overview" && <HydOverview {...props} />}
      {tab === "skuDetail" && <HydSkuDetail {...props} />}
      {tab === "output" && <HydToolOutput {...props} />}
      {tab === "upload" && <HydUploadPanel {...props} />}
      {tab === "logic" && <HydLogicTweaker {...props} />}
      {tab === "plywood" && <HydPlywoodPanel {...props} />}
      {tab === "stockHealth" && !noticeDismissed && (
        <HydStockNotice report={hydRun?.report} skuMaster={props.skuMaster} onDismiss={() => setNoticeDismissed(true)} />
      )}
      {tab === "stockHealth" && (
        // One store, no DC. No poData/toData: Pati has no TOs, and its POs reach
        // Stock Health only once sync-orders covers HYDS01, so the PO columns read "—".
        <StockHealthTab results={hydRun?.results ?? null} skuMaster={props.skuMaster}
          stockData={props.stockData || {}} stockDataAccounting={props.stockDataAccounting || {}}
          uploadedAtPerDS={props.uploadedAtPerDS}
          dsList={HYD_DS_LIST} includeDC={false} syncGroups={HYD_SYNC_GROUPS}
          defaultDS="HYDS01" filePrefix="Hyderabad_" />
      )}
    </div>
  );
}
