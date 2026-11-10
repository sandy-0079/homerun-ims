// Hyderabad Tool Output: one PO card. Targets only, frozen 9-column header.
import React from "react";
import { buildHydPoCsv, hydPoCsvFilename, HYD_PO_CSV_HEADERS } from "../../hyd/hydPoCsv.js";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { downloadCsvFile } from "../../downloadCsv.js";
import { card, h2, note, btn, banner, todayLocalIso } from "./hydStyles.js";

export default function HydToolOutput({ skuMaster, invoiceData, hydState, hydRun }) {
  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;
  const results = hydRun?.results;
  const masterEmpty = !Object.keys(skuMaster || {}).length;
  const disabled = !results || masterEmpty;
  const latest = (invoiceData || []).reduce((m, r) => (m === null || r.date > m ? r.date : m), null);
  const mode = isFloorsOnly(hydState.hydParams, "HYDS01") ? "Floors only" : "Engine";

  const onDownload = () => {
    const csv = buildHydPoCsv({ skuMaster, hydResults: results, floors: hydState.floors, hydParams: hydState.hydParams });
    if (!csv) { alert("No SKU Master loaded — nothing to download."); return; }
    downloadCsvFile(hydPoCsvFilename(todayLocalIso()), csv);
  };

  return (
    <div style={card}>
      <div style={h2}>PO — HYDERABAD (HYDS01 Pati)</div>
      <div style={note}>
        Every master SKU with Pati's Min/Max and Hyderabad's effective Purchase decision. Targets only — no stock.
        <br />Columns: {HYD_PO_CSV_HEADERS.join(" · ")}
      </div>
      {hydRun?.error && <div style={{ ...banner("error"), marginTop: 8 }}>Hyderabad engine failed: {hydRun.error}</div>}
      <div style={{ marginTop: 10 }}>
        <button style={btn(true, disabled)} disabled={disabled} onClick={onDownload}>
          ⬇ {hydPoCsvFilename(todayLocalIso())}
        </button>
      </div>
      <div style={{ ...note, marginTop: 6 }}>
        Mode: {mode} · demand through {latest || "unknown"} (computed when this page loaded — reload before downloading if it has been open since yesterday).
      </div>
    </div>
  );
}
