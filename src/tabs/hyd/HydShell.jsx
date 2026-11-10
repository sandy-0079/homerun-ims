// Hyderabad tab bodies. Rendered by App.jsx in place of the Bangalore tab bodies
// when city === "hyd"; receives everything it needs as props and never touches a
// Bangalore row. Task 9 wires the shell (placeholders + a wiring summary); the
// real tabs replace the placeholders in Task 10 behind this same prop interface:
//   { tab, isAdmin, invoiceData, skuMaster, priceData, deadStock /*Set*/,
//     stockData, stockDataAccounting, uploadedAtPerDS,
//     hydState, setHydState, hydRun /* {results, report} | null */ }
import React from "react";
import { isFloorsOnly } from "../../hyd/hydParams.js";

const C = {
  text: "#1A1A1A", muted: "#6B6B6B", border: "#E5E5E5", white: "#FFFFFF",
  blue: "#1F5FA8", red: "#B91C1C", redBg: "#FEE2E2",
};

const card = {
  background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
  padding: "16px 18px", marginBottom: 12,
};

const TAB_LABEL = {
  overview: "Overview", skuDetail: "SKU Detail", stockHealth: "Stock Health",
  output: "Tool Output Download", plywood: "Plywood", upload: "Upload Data", logic: "Logic Tweaker",
};

function WiringSummary({ hydState, hydRun }) {
  if (!hydState) return <div style={card}><span style={{ color: C.muted, fontSize: 13 }}>Loading Hyderabad…</span></div>;
  const results = hydRun?.results || {};
  const inRange = Object.values(results).filter(r => (r?.stores?.HYDS01?.max || 0) > 0).length;
  const mode = isFloorsOnly(hydState.hydParams || {}, "HYDS01") ? "Floors only" : "Engine";
  const errors = [...(hydState.loadErrors || []), ...(hydRun?.error ? [`engine: ${hydRun.error}`] : [])];
  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.blue, marginBottom: 8 }}>Hyderabad — HYDS01 Pati</div>
      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.7 }}>
        <div>SKUs in range: <b>{inRange.toLocaleString()}</b></div>
        <div>Mode: <b>{mode}</b></div>
      </div>
      {errors.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.red, background: C.redBg, borderRadius: 6, padding: "8px 10px" }}>
          {errors.map(e => <div key={e}>{e}</div>)}
        </div>
      )}
    </div>
  );
}

export default function HydShell({
  tab, isAdmin, invoiceData, skuMaster, priceData, deadStock,
  stockData, stockDataAccounting, uploadedAtPerDS,
  hydState, setHydState, hydRun,
}) {
  const label = TAB_LABEL[tab] || tab;
  return (
    <div>
      {tab === "overview" && <WiringSummary hydState={hydState} hydRun={hydRun} />}
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.muted }}>{label} — Hyderabad (coming next)</div>
      </div>
    </div>
  );
}
