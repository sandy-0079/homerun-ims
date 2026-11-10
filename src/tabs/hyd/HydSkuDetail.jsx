// Hyderabad SKU Detail: how one SKU's HYDS01 target was reached, and Pati's
// daily sales over the engine window.
import React, { useMemo, useState } from "react";
import { hydPurchaseOf, networkWindowDates } from "../../hyd/hydEngine.js";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { patiDailySales } from "../../hyd/hydStats.js";
import { C, card, h2, note, table, th, td, input, fmtInr } from "./hydStyles.js";

const MAX_MATCHES = 30;

function Breakdown({ sku, meta, s, purchase, price }) {
  const rows = [
    ["Floor (Hyderabad sheet)", s.floorMin, s.floorMax],
    ["Engine (strategy)", s.rawEngineMin, s.rawEngineMax],
    [`Engine + buffer (lead ${s.leadTime}d, cycle ${s.orderCycleDays}d)`, s.engineMin, s.engineMax],
    ["Final", s.min, s.max],
  ];
  return (
    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 700 }}><code>{sku}</code> · {meta?.name || "(not in master)"}</div>
      <div style={{ ...note, marginBottom: 8 }}>
        {meta?.category || "–"} · {meta?.brand || "–"} · Zoho status {meta?.status || "–"} · Zoho Purchase {meta?.purchase || "–"} ·
        Inventorised At {meta?.inventorisedAt || "–"} · price {fmtInr(price)}
      </div>
      <table style={table}>
        <thead><tr><th style={th}>Step</th><th style={th}>Min</th><th style={th}>Max</th></tr></thead>
        <tbody>
          {rows.map(([label, mn, mx]) => (
            <tr key={label} style={label === "Final" ? { fontWeight: 700 } : undefined}>
              <td style={td}>{label}</td><td style={td}>{mn ?? 0}</td><td style={td}>{mx ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 12, marginTop: 8, lineHeight: 1.7 }}>
        Logic: <b>{s.logicTag}</b> (source {s.source}) · Hyderabad Purchase: <b>{purchase}</b> ·
        daily avg {(s.dailyAvg || 0).toFixed(2)} · strategy {s.strategyTag || "–"}{s.mvTag ? ` · ${s.mvTag}` : ""}
      </div>
    </div>
  );
}

export default function HydSkuDetail({ invoiceData, skuMaster, priceData, hydState, hydRun }) {
  const [query, setQuery] = useState("");
  const [sku, setSku] = useState(null);

  const matches = useMemo(() => {
    const qy = query.trim().toLowerCase();
    if (!qy) return [];
    const out = [];
    for (const [code, m] of Object.entries(skuMaster || {})) {
      if (code.toLowerCase().includes(qy) || String(m?.name || "").toLowerCase().includes(qy)) out.push(code);
      if (out.length >= MAX_MATCHES) break;
    }
    return out;
  }, [query, skuMaster]);

  const op = hydState?.hydParams?.overallPeriod || 45;
  const windowDates = useMemo(() => networkWindowDates(invoiceData || [], op), [invoiceData, op]);
  const sales = useMemo(() => (sku ? patiDailySales(invoiceData, sku, windowDates) : null), [invoiceData, sku, windowDates]);

  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;
  const s = sku ? hydRun?.results?.[sku]?.stores?.HYDS01 : null;
  const purchase = sku ? hydPurchaseOf(sku, { skuMaster, floors: hydState.floors, floorsOnly: isFloorsOnly(hydState.hydParams, "HYDS01") }) : null;

  return (
    <div>
      <div style={card}>
        <div style={h2}>SKU Detail — HYDERABAD (HYDS01 Pati)</div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search SKU code or name"
          style={{ ...input, width: 320 }} />
        {matches.length > 0 && (
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: "auto", fontSize: 12 }}>
            {matches.map(code => (
              <div key={code} onClick={() => setSku(code)}
                style={{ padding: "3px 6px", cursor: "pointer", background: code === sku ? C.blueBg : "transparent", borderRadius: 4 }}>
                <code>{code}</code> <span style={{ color: C.muted }}>{skuMaster[code]?.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {sku && !s && <div style={card}><span style={note}>No Hyderabad result for {sku}.</span></div>}
      {sku && s && <Breakdown sku={sku} meta={skuMaster?.[sku]} s={s} purchase={purchase} price={priceData?.[sku] || 0} />}
      {sku && sales && (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
            Pati daily sales · {windowDates[0] || "–"} → {windowDates[windowDates.length - 1] || "–"}
          </div>
          <div style={{ ...note, marginBottom: 6 }}>
            {sales.total.toLocaleString()} units on {sales.days.length} of {sales.windowDays} window days. Days with no sale are not listed.
          </div>
          {sales.days.length > 0 && (
            <table style={{ ...table, maxWidth: 320 }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Units</th></tr></thead>
              <tbody>{sales.days.map(d => <tr key={d.date}><td style={td}>{d.date}</td><td style={td}>{d.qty}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
