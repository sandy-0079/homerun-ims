// Hyderabad floor-sheet upload (admin). Parse → preview (with a dry engine run on
// the new floors) → "Replace HYDERABAD floors". A refused file writes nothing.
import React, { useState } from "react";
import { parseHydFloorsCsv } from "../../hyd/hydFloors.js";
import { runHydEngine } from "../../hyd/hydEngine.js";
import { saveHydFloors } from "../../hyd/hydStore.js";
import { buildHydFloorsTemplateCsv } from "../../hyd/hydFloorsTemplate.js";
import { uniqueOverrideSkus } from "../../hyd/hydStats.js";
import { HYD_DS_LIST } from "../../city.js";
import { downloadCsvFile } from "../../downloadCsv.js";
import { C, card, h2, note, table, th, td, btn, banner, fmtWhen } from "./hydStyles.js";
import { Collapsible, SkuList } from "./HydUi.jsx";

const REASON_TEXT = {
  empty: "The file is empty.",
  header_mismatch: "The header is not a Hyderabad floor sheet. It needs a SKU column and HYDS01 Min / HYDS01 Max columns.",
  foreign_columns: "This file has Bangalore or DC columns. Hyderabad floor sheets may only have HYDS01 Min / HYDS01 Max.",
  invalid_value: "Some cells are not whole numbers. Fix them and upload again.",
};

const inRangeCount = floors => Object.values(floors || {}).filter(f => (f?.HYDS01?.min || 0) > 0 || (f?.HYDS01?.max || 0) > 0).length;

function Refusal({ parsed }) {
  return (
    <div style={banner("error")}>
      <div style={{ fontWeight: 700 }}>Refused — nothing was written.</div>
      <div>{REASON_TEXT[parsed.reason] || parsed.reason}</div>
      {parsed.foreignColumns.length > 0 && <div>Columns: <b>{parsed.foreignColumns.join(", ")}</b></div>}
      {parsed.invalid.length > 0 && (
        <table style={{ ...table, marginTop: 6, background: C.white }}>
          <thead><tr><th style={th}>SKU</th><th style={th}>Column</th><th style={th}>Value</th></tr></thead>
          <tbody>
            {parsed.invalid.slice(0, 100).map((c, i) => (
              <tr key={i}><td style={td}><code>{c.sku}</code></td><td style={td}>{c.column}</td><td style={td}>{JSON.stringify(c.value)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {parsed.invalid.length > 100 && <div>…and {parsed.invalid.length - 100} more.</div>}
    </div>
  );
}

function Preview({ parsed, dry, skuMaster, currentFloors }) {
  const overrides = uniqueOverrideSkus(dry?.report?.overrides);
  return (
    <div>
      <div style={{ fontSize: 13, lineHeight: 1.8 }}>
        <div>SKU rows: <b>{parsed.skuCount.toLocaleString()}</b> · in range (Min/Max &gt; 0): <b>{inRangeCount(parsed.floors).toLocaleString()}</b>
          <span style={{ color: C.muted }}> (currently {inRangeCount(currentFloors).toLocaleString()})</span></div>
        {parsed.blankSkuRows > 0 && <div style={{ color: C.muted }}>{parsed.blankSkuRows} rows with a blank SKU were skipped.</div>}
      </div>
      {dry?.error && <div style={banner("error")}>Preview engine run failed: {dry.error}</div>}
      <Collapsible title="Unknown SKUs (not in the SKU master — kept, not blocking)" count={parsed.unknownSkus.length}>
        <SkuList items={parsed.unknownSkus} />
      </Collapsible>
      <Collapsible title="Repeated SKUs (last row wins)" count={parsed.duplicateSkus.length}>
        <SkuList items={parsed.duplicateSkus} skuMaster={skuMaster} />
      </Collapsible>
      <Collapsible title="Floor SKUs inactive in Zoho (stay 0/0)" count={dry?.report?.inactiveFloored?.length ?? 0}>
        <SkuList items={dry?.report?.inactiveFloored || []} skuMaster={skuMaster} />
      </Collapsible>
      <Collapsible title="Floor rows that override Purchase=OFF / Supplier / Dead Stock" count={overrides.length}>
        <SkuList items={overrides} skuMaster={skuMaster} render={o => o.reasons.join(", ")} />
      </Collapsible>
    </div>
  );
}

export default function HydUploadPanel({ isAdmin, invoiceData, skuMaster, priceData, deadStock, hydState, setHydState }) {
  const [pending, setPending] = useState(null); // {fileName, parsed, dry}
  const [status, setStatus] = useState(null);   // {kind, text}
  const [saving, setSaving] = useState(false);

  if (!isAdmin) return <div style={card}><span style={note}>Upload Data is admin-only.</span></div>;
  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;

  const currentFloors = hydState.floors || {};

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus(null);
    const text = await file.text();
    const parsed = parseHydFloorsCsv(text, { dsList: HYD_DS_LIST, knownSkus: new Set(Object.keys(skuMaster || {})) });
    let dry = null;
    if (parsed.ok) {
      try {
        dry = runHydEngine({ invoiceData, skuMaster, priceData, deadStock, floors: parsed.floors, hydParams: hydState.hydParams, hydPlywood: hydState.hydPlywood });
      } catch (err) {
        dry = { error: err?.message || String(err) };
      }
    }
    setPending({ fileName: file.name, parsed, dry });
  };

  const onReplace = async () => {
    const floors = pending.parsed.floors;
    setSaving(true);
    const ok = await saveHydFloors(floors);
    setSaving(false);
    if (!ok) { setStatus({ kind: "error", text: "Save failed — Hyderabad floors were NOT changed." }); return; }
    setHydState(s => ({ ...s, floors, floorsUploadedAt: new Date().toISOString() }));
    setPending(null);
    setStatus({ kind: "info", text: `Hyderabad floors replaced: ${inRangeCount(floors).toLocaleString()} SKUs in range.` });
  };

  return (
    <div>
      <div style={card}>
        <div style={h2}>SKU Floors — HYDERABAD (HYDS01 Pati)</div>
        <div style={note}>
          Current: <b>{inRangeCount(currentFloors).toLocaleString()}</b> SKUs in range · uploaded {fmtWhen(hydState.floorsUploadedAt)}.
          Columns: SKU · Item Name (ignored) · Category (ignored) · HYDS01 Min · HYDS01 Max. Blank = 0, whole numbers only,
          the last row wins for a repeated SKU, a 0/0 or deleted row takes the SKU out of range.
          The upload REPLACES all Hyderabad floors.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
          <label style={btn(true)}>
            Choose Hyderabad floor CSV
            <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
          </label>
          <button style={btn(false)} onClick={() => downloadCsvFile("SKU_Floors_Hyderabad_template.csv", buildHydFloorsTemplateCsv(currentFloors, skuMaster))}>
            ⬇ Template (current floors)
          </button>
        </div>
      </div>

      {status && <div style={banner(status.kind)}>{status.text}</div>}

      {pending && (
        <div style={card}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>File: {pending.fileName}</div>
          {!pending.parsed.ok
            ? <Refusal parsed={pending.parsed} />
            : (
              <>
                <Preview parsed={pending.parsed} dry={pending.dry} skuMaster={skuMaster} currentFloors={currentFloors} />
                <div style={{ marginTop: 14, padding: "14px 16px", border: `2px solid ${C.blue}`, borderRadius: 8, background: C.blueBg }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: C.blue, letterSpacing: 1 }}>HYDERABAD</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <button style={btn(true, saving)} disabled={saving} onClick={onReplace}>
                      {saving ? "Saving…" : "Replace HYDERABAD floors"}
                    </button>
                    <button style={btn(false, saving)} disabled={saving} onClick={() => setPending(null)}>Cancel</button>
                  </div>
                  <div style={{ fontSize: 12, color: C.text, marginTop: 6 }}>Bangalore floors are not touched.</div>
                </div>
              </>
            )}
        </div>
      )}
    </div>
  );
}
