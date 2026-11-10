// The Hyderabad floors card — the one ACTIVE card on Hyderabad's Upload Data (spec §9),
// rendered first by the shared UploadDataTab (extraCards) in Bangalore's card style.
//
// Upload flow (src/hyd/hydFloorsReplace.js, unchanged from the first build's HydUploadPanel): parse with
// parseHydFloorsCsv → preview with a dry runHydEngine on the NEW floors → confirm
// "Replace HYDERABAD floors" → saveHydFloors (team_data/hyd_inputs only). A refused file
// writes nothing; Replace is disabled after a failed Hyderabad read.
//
// The "fix your floor sheet" lists for the CURRENT floors (hydRun.report) live here too —
// they used to be a notice above Pati's Stock Health, which is now identical to Bangalore's.
import React, { useState } from "react";
import { hydReadFailed } from "../../hyd/hydStore.js";
import { prepareHydFloors, replaceHydFloors, inRangeCount } from "../../hyd/hydFloorsReplace.js";
import { buildHydFloorsTemplateCsv, buildOutOfRangeTemplate, outOfRangeTemplateFilename, soldWithoutFloor } from "../../hyd/hydFloorsTemplate.js";
import { uniqueOverrideSkus } from "../../hyd/hydStats.js";
import { downloadCsvFile } from "../../downloadCsv.js";
import { HR, S } from "../../appStyles.js";
import { C, table, th, td, banner, fmtWhen, todayLocalIso } from "./hydStyles.js";
import { Collapsible, SkuList } from "./HydUi.jsx";

const BLUE = C.blue;

const REASON_TEXT = {
  empty: "The file is empty.",
  header_mismatch: "The header is not a Hyderabad floor sheet. It needs a SKU column and HYDS01 Min / HYDS01 Max columns.",
  foreign_columns: "This file has Bangalore or DC columns. Hyderabad floor sheets may only have HYDS01 Min / HYDS01 Max.",
  invalid_value: "Some cells are not whole numbers. Fix them and upload again.",
};

// Bangalore's Upload Data button styles (UploadDataTab's btnS / tplBtnS), same values.
const uploadBtn = { background: HR.green, color: HR.white, padding: "5px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, border: "none", whiteSpace: "nowrap" };
const tplBtn = { background: "#EAF9FF", color: "#0077A8", border: "1px solid #A5F3FC", padding: "5px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" };
// A failed Hyderabad read disables every download and save (the banner says so).
const tplBtnOff = { ...tplBtn, background: "#E5E5E5", color: "#999", border: `1px solid ${HR.border}`, cursor: "not-allowed" };
const READ_FAILED_TIP = "Hyderabad data could not be read — reload";
const actBtn = (primary, off) => ({ background: off ? "#E5E5E5" : primary ? BLUE : HR.white, color: off ? "#999" : primary ? HR.white : HR.text,
  border: primary && !off ? "none" : `1px solid ${HR.border}`, padding: "7px 16px", borderRadius: 7, cursor: off ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 800 });

export function Refusal({ parsed }) {
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

/** What the NEW file would do (dry engine run on it), before anything is written. */
export function Preview({ parsed, dry, skuMaster, currentFloors }) {
  const overrides = uniqueOverrideSkus(dry?.report?.overrides);
  return (
    <div>
      <div style={{ fontSize: 12, lineHeight: 1.8 }}>
        <div>SKU rows: <b>{parsed.skuCount.toLocaleString()}</b> · in range (Min/Max &gt; 0): <b>{inRangeCount(parsed.floors).toLocaleString()}</b>
          <span style={{ color: HR.muted }}> (currently {inRangeCount(currentFloors).toLocaleString()})</span></div>
        {parsed.blankSkuRows > 0 && <div style={{ color: HR.muted }}>{parsed.blankSkuRows} rows with a blank SKU were skipped.</div>}
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
      <Collapsible title="Pati sales outside the range" count={dry?.report?.outOfRangeSales?.length ?? 0}>
        <SkuList items={dry?.report?.outOfRangeSales || []} skuMaster={skuMaster} />
      </Collapsible>
    </div>
  );
}

/** The city-named confirm (spec §3.5). Replace is disabled after a failed read. */
export function ReplaceConfirm({ saving, readFailed, onReplace, onCancel }) {
  return (
    <div style={{ marginTop: 14, padding: "14px 16px", border: `2px solid ${BLUE}`, borderRadius: 8, background: C.blueBg }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: BLUE, letterSpacing: 1 }}>HYDERABAD</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button style={actBtn(true, saving || readFailed)} disabled={saving || readFailed} onClick={onReplace}>
          {saving ? "Saving…" : "Replace HYDERABAD floors"}
        </button>
        <button style={actBtn(false, saving)} disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
      <div style={{ fontSize: 12, color: HR.text, marginTop: 6 }}>Bangalore floors are not touched.</div>
    </div>
  );
}

/** One "fix your floor sheet" line: icon + count + text, the list expandable. */
function FloorList({ icon, tone, text, items, skuMaster, render, action }) {
  return (
    <details style={{ borderTop: `1px solid ${HR.border}`, padding: "6px 0" }}>
      <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: tone, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{icon} {items.length.toLocaleString()} {text}</span>
        {action}
      </summary>
      <div style={{ marginTop: 6 }}><SkuList items={items} skuMaster={skuMaster} render={render} /></div>
    </details>
  );
}

export default function HydFloorsCard({ invoiceData, skuMaster, priceData, deadStock, hydState, setHydState, hydRun }) {
  const [pending, setPending] = useState(null); // {fileName, parsed, dry}
  const [status, setStatus] = useState(null);   // {kind, text}
  const [saving, setSaving] = useState(false);

  const currentFloors = hydState?.floors || {};
  // A failed Hyderabad read: never replace floors over a row nobody read.
  const readFailed = hydReadFailed(hydState);

  const report = hydRun?.report || {};
  // Active in Zoho and in the SKU master only — inactive / unknown floor SKUs have their own lists.
  const noFloor = soldWithoutFloor(report.outOfRangeSales, skuMaster);
  const inactive = report.inactiveFloored || [];
  const overrides = uniqueOverrideSkus(report.overrides);
  const unknown = report.unknownFloorSkus || [];
  const anyList = noFloor.length || inactive.length || overrides.length || unknown.length;

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setStatus(null);
    const text = await file.text();
    const { parsed, dry } = prepareHydFloors(text, { invoiceData, skuMaster, priceData, deadStock, hydState });
    setPending({ fileName: file.name, parsed, dry });
  };

  // Writes team_data/hyd_inputs only; hydState changes only after a true save.
  const onReplace = async () => {
    const ok = await replaceHydFloors({ floors: pending.parsed.floors, hydState, setHydState, setSaving, setStatus });
    if (ok) setPending(null);
  };

  const downloadNoFloor = (e) => {
    e.preventDefault(); // inside <summary>: download, don't toggle the list
    if (readFailed) return;
    const csv = buildOutOfRangeTemplate(noFloor, skuMaster);
    if (csv) downloadCsvFile(outOfRangeTemplateFilename(todayLocalIso()), csv);
  };

  return (
    // Same bucket panel as Bangalore's AUTO / MANUAL groups, in the Hyderabad blue.
    <div style={{ background: "#F5F9FE", border: `1px solid ${BLUE}33`, borderLeft: `4px solid ${BLUE}`, borderRadius: 8, padding: "10px 12px 12px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ background: BLUE, color: HR.white, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, letterSpacing: 0.5 }}>✎ HYDERABAD</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: BLUE }}>Pati&apos;s own input</span>
        <span style={{ fontSize: 10, color: HR.muted }}>uploaded by hand — no nightly sync; everything below is shared with Bangalore</span>
      </div>
      <div style={{ ...S.card, display: "flex", flexDirection: "column", minHeight: 130 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div>
            <span style={{ fontWeight: 700, color: HR.text, fontSize: 12 }}>SKU Floors - HYDERABAD (HYDS01 Pati)</span>
            <span style={{ color: "#B91C1C", fontSize: 10, fontWeight: 400, marginLeft: 5 }}>required</span>
            <div style={{ fontSize: 10, color: HR.muted, marginTop: 3, lineHeight: 1.5, maxWidth: 640 }}>
              Columns: SKU · Item Name (ignored) · Category (ignored) · HYDS01 Min · HYDS01 Max. Blank = 0, whole numbers only,
              the last row wins for a repeated SKU, a 0/0 or deleted row takes the SKU out of range. The upload REPLACES all Hyderabad floors.
            </div>
          </div>
          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            <div style={{ fontSize: 11, color: HR.green, fontWeight: 600 }}>{inRangeCount(currentFloors).toLocaleString()} SKUs in range</div>
            <div style={{ fontSize: 9, color: HR.muted, marginTop: 1 }}>uploaded {fmtWhen(hydState?.floorsUploadedAt)}</div>
          </div>
        </div>

        <div style={{ margin: "6px 0" }}>
          {noFloor.length > 0 && (
            <FloorList icon="⚠" tone="#92400E" text="SKUs sold at Pati have no floor" items={noFloor} skuMaster={skuMaster}
              action={<button onClick={downloadNoFloor} style={readFailed ? tplBtnOff : tplBtn} disabled={readFailed}
                title={readFailed ? READ_FAILED_TIP : undefined}>⬇ Download as floor template</button>} />
          )}
          {inactive.length > 0 && <FloorList icon="⚠" tone="#B91C1C" text="floor SKUs are inactive in Zoho (they stay 0/0)" items={inactive} skuMaster={skuMaster} />}
          {overrides.length > 0 && (
            <FloorList icon="ℹ" tone={BLUE} text="floor SKUs override Bangalore flags" items={overrides} skuMaster={skuMaster} render={o => o.reasons.join(", ")} />
          )}
          {unknown.length > 0 && <FloorList icon="⚠" tone="#92400E" text="floor SKUs are not in the SKU master" items={unknown} skuMaster={skuMaster} />}
          {!anyList && hydRun?.report && <div style={{ fontSize: 11, color: HR.green }}>✓ Nothing to fix in the floor sheet.</div>}
        </div>

        <div style={{ marginTop: "auto", display: "flex", gap: 5, flexWrap: "wrap" }}>
          <label style={{ ...uploadBtn, cursor: "pointer" }}>⬆ Upload CSV<input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} /></label>
          <button onClick={() => downloadCsvFile("SKU_Floors_Hyderabad_template.csv", buildHydFloorsTemplateCsv(currentFloors, skuMaster))}
            style={readFailed ? tplBtnOff : tplBtn} disabled={readFailed} title={readFailed ? READ_FAILED_TIP : undefined}>
            ⬇ Template (current floors)
          </button>
        </div>
      </div>

      {status && <div style={{ ...banner(status.kind), marginTop: 10 }}>{status.text}</div>}

      {pending && (
        <div style={{ ...S.card, marginTop: 10 }}>
          <div style={{ fontSize: 11, color: HR.muted, marginBottom: 6 }}>File: {pending.fileName}</div>
          {!pending.parsed.ok
            ? <Refusal parsed={pending.parsed} />
            : (
              <>
                <Preview parsed={pending.parsed} dry={pending.dry} skuMaster={skuMaster} currentFloors={currentFloors} />
                <ReplaceConfirm saving={saving} readFailed={readFailed} onReplace={onReplace} onCancel={() => setPending(null)} />
              </>
            )}
        </div>
      )}
    </div>
  );
}
