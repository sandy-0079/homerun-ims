// Hyderabad tab bodies. Rendered by App.jsx in place of the Bangalore tab bodies
// when city === "hyd"; receives everything it needs as props and never touches a
// Bangalore row. Prop interface:
//   { tab, isAdmin, invoiceData, skuMaster, priceData, deadStock /*Set*/,
//     stockData, stockDataAccounting, uploadedAtPerDS,
//     hydState, setHydState, hydRun /* {results, report} | null */,
//     blrParams /* Bangalore's applied params, for "Reset to Bangalore" */ }
import React from "react";
import { card, note, banner } from "./hydStyles.js";
import HydOverview from "./HydOverview.jsx";
import HydSkuDetail from "./HydSkuDetail.jsx";
import HydToolOutput from "./HydToolOutput.jsx";
import HydUploadPanel from "./HydUploadPanel.jsx";
import HydLogicTweaker from "./HydLogicTweaker.jsx";
import HydPlywoodPanel from "./HydPlywoodPanel.jsx";

function Errors({ hydState, hydRun }) {
  const errors = [...(hydState?.loadErrors || []), ...(hydRun?.error ? [`engine: ${hydRun.error}`] : [])];
  if (!errors.length) return null;
  return <div style={banner("error")}>{errors.map(e => <div key={e}>{e}</div>)}</div>;
}

export default function HydShell(props) {
  const { tab, hydState, hydRun } = props;
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
      {tab === "stockHealth" && (
        <div style={card}><span style={note}>Stock Health — Hyderabad (coming next)</span></div>
      )}
    </div>
  );
}
