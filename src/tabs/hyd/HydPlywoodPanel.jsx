// Hyderabad Plywood: Pati's thick/thin
// capacity, Pati's plywood SKUs (targets + capacity used) and the global network
// params with Bangalore's labels (DC-only keys hidden). Saves only Hyderabad's own rows.
// Editable by admins; everyone else sees it read-only.
import React, { useMemo, useState } from "react";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { saveHydPlywood, hydReadFailed } from "../../hyd/hydStore.js";
import { setParamPath } from "../../hyd/hydParamRows.js";
import { hydPlywoodParamRows, HYD_PLYWOOD_GROUP_TITLE } from "../../hyd/hydPlywoodLabels.js";
import { buildHydPlywoodRows, capacityState, HYD_PLYWOOD_EMPTY } from "../../hyd/hydPlywoodRows.js";
import { isBrandOnAt, capacityOf, setCapacity } from "../../hyd/hydPlywoodEdit.js";
import { S, HR } from "../../appStyles.js";
import { banner, NOT_SAVED_BEFORE, SETTINGS_UNREADABLE } from "./hydStyles.js";
import { NumField } from "./HydUi.jsx";
import HydParamEditor from "./HydParamEditor.jsx";

// Bangalore's Plywood tab look: plain section titles, purple Network Design accents.
const PURPLE = "#7C3AED", PURPLE_BG = "#F5F3FF";
const note = { fontSize: 11, color: HR.muted, lineHeight: 1.5 };
const sectionTitle = { fontSize: 12, fontWeight: 700, color: "#555", borderBottom: `2px solid ${HR.yellow}`, paddingBottom: 4, marginBottom: 12 };

const STORE = "HYDS01";

function Capacity({ label, value, onChange, disabled }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span style={{ color: "#555" }}>{label}</span>
      <NumField value={value} onChange={onChange} disabled={disabled} />
      {value <= 0 && <span style={{ color: "#B91C1C", fontWeight: 700 }}>⚠ 0 = no cap — Pati's {label.toLowerCase()} would be unlimited</span>}
    </span>
  );
}

// Bangalore's NetworkDesignUnifiedTable inline capacity bar (PlywoodNetworkTab.jsx).
function CapBar({ used, total, label }) {
  const { pct, level } = capacityState(used, total);
  const col = level === "over" ? "#DC2626" : level === "atLimit" ? "#F59E0B" : level === "ok" ? "#16a34a" : HR.muted;
  const text = level === "unknown" ? "— (no engine results)"
    : level === "noCap" ? `${used} · no cap set`
    : `${used}/${total} · ${pct.toFixed(0)}%${level === "over" ? " Over" : level === "atLimit" ? " At Limit" : ""}`;
  return (
    <div style={{ flex: 1, minWidth: 220, padding: "5px 10px", border: "1px solid #E0E0D0", borderRadius: 6, background: "#FAFAF8" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3, gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#555" }}>{label}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: col }}>{text}</span>
      </div>
      <div style={{ height: 4, background: "#E5E5D0", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct == null ? 0 : Math.min(100, pct)}%`, background: col, borderRadius: 2 }} />
      </div>
    </div>
  );
}

const TH = { padding: "4px 6px", fontWeight: 700, fontSize: 10, color: "#666", borderBottom: "1px solid #E0E0D0", textAlign: "left", whiteSpace: "nowrap", background: "#F8F8F2" };
const TD = { padding: "3px 6px", borderBottom: "1px solid rgba(0,0,0,0.05)", fontSize: 11, whiteSpace: "nowrap" };
const NUM = { ...TD, textAlign: "center" };
const pair = (a, b) => (a == null ? "—" : `${a} / ${b}`);

function PatiSkuTable({ rows, capacity, thickCap, thinCap, boundary, floorsOnly, lookbackDays }) {
  const thick = rows.filter(r => r.thickness === "Thick").length;
  const thin = rows.filter(r => r.thickness !== "Thick" && r.thickness !== "Laminate").length;
  return (
    <div style={{ ...S.card, marginBottom: 12, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#333" }}>Pati plywood SKUs</span>
        <span style={{ fontSize: 10, color: "#888" }}>
          Thick: <b style={{ color: "#92400E" }}>{thick}</b> &nbsp;·&nbsp; Thin: <b style={{ color: "#1e40af" }}>{thin}</b> &nbsp;·&nbsp; boundary {boundary}mm
        </span>
        {capacity.thick != null && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#555", whiteSpace: "nowrap" }}>
            Max Ply Stock: <b style={{ color: "#1A1A1A" }}>{capacity.thick + capacity.thin}</b>
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <CapBar used={capacity.thick} total={thickCap} label="Vertical Storage — Thick" />
        <CapBar used={capacity.thin} total={thinCap} label="Tub Storage — Thin" />
      </div>
      {!rows.length ? (
        <div style={{ padding: 16, color: "#888", fontSize: 12, textAlign: "center" }}>{HYD_PLYWOOD_EMPTY}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={TH}>SKU</th><th style={TH}>Item Name</th><th style={TH}>Brand</th>
                <th style={{ ...TH, textAlign: "center" }}>Thickness</th>
                <th style={{ ...TH, textAlign: "center" }}>Floor Min / Max</th>
                <th style={{ ...TH, textAlign: "center" }} title={floorsOnly ? "Pati is on Floors only — the engine does not set targets" : "Engine + lead-time buffer, before the floor"}>Engine Min / Max</th>
                <th style={{ ...TH, textAlign: "center" }}>Final Min / Max</th>
                <th style={TH}>Logic</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isThick = r.thickness === "Thick";
                const badge = r.thickness === "Thick" || r.thickness === "Thin";
                return (
                  <tr key={r.sku} style={{ background: i % 2 === 0 ? "#fff" : "#F8F8F2" }}>
                    <td style={{ ...TD, fontFamily: "monospace", fontSize: 10, color: "#555" }}>{r.sku}</td>
                    <td style={{ ...TD, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={r.name}>{r.name}</td>
                    <td style={{ ...TD, color: "#555" }}>{r.brand || "—"}</td>
                    <td style={NUM}>
                      <span style={{ fontSize: 10, color: "#555", marginRight: 4 }}>{r.mm != null ? `${r.mm}mm` : "—"}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                        background: !badge ? "#F3F4F6" : isThick ? "#FEF3C7" : "#DBEAFE", color: !badge ? "#6B7280" : isThick ? "#92400E" : "#1e40af" }}>
                        {r.thickness}
                      </span>
                    </td>
                    <td style={NUM}>{pair(r.floorMin, r.floorMax)}</td>
                    <td style={{ ...NUM, color: "#555" }}>{pair(r.engineMin, r.engineMax)}</td>
                    <td style={{ ...NUM, fontWeight: 700, color: r.finalMax > 0 ? "#166534" : "#bbb" }}>{pair(r.finalMin, r.finalMax)}</td>
                    <td style={{ ...TD, color: "#555" }}>{r.logicTag || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ ...note, marginTop: 6 }}>
        Plywood SKUs with a Hyderabad floor, a Pati target, or Pati sales in the last {lookbackDays} days (History Window).
        Capacity used = Σ final Max (as in Bangalore); thin counts every non-thick sheet, laminates excluded.
        {floorsOnly && " Pati is on Floors only, so Engine reads —."}
      </div>
    </div>
  );
}

export default function HydPlywoodPanel({ isAdmin, hydState, setHydState, hydPlywoodDraft, setHydPlywoodDraft, hydRun, skuMaster, invoiceData }) {
  // The draft {base, value} is App's when it passes one (so leaving the tab or city with
  // unsaved edits is guarded, as for the Logic Tweaker); local state otherwise.
  const [localEdit, setLocalEdit] = useState(null);
  const lifted = typeof setHydPlywoodDraft === "function";
  const edit = lifted ? hydPlywoodDraft : localEdit;
  const setEdit = lifted ? setHydPlywoodDraft : setLocalEdit;
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const base = hydState?.hydPlywood;
  const draft = edit && edit.base === base ? edit.value : base;
  const setDraft = value => setEdit({ base, value });
  // The SKU table reads the SAVED config (the engine ran on it): boundary + lookback.
  const savedCfg = base?.plywoodNetworkConfig || {};
  const boundary = savedCfg.thickBoundaryMm || 9;
  const lookbackDays = savedCfg.lookbackDays || 90;
  const floorsOnly = isFloorsOnly(hydState?.hydParams, STORE);
  const results = hydRun?.results ?? null;
  const floors = hydState?.floors;
  const ply = useMemo(
    () => buildHydPlywoodRows({ skuMaster, results, floors, invoiceData, thickBoundaryMm: boundary, lookbackDays, floorsOnly }),
    [skuMaster, results, floors, invoiceData, boundary, lookbackDays, floorsOnly],
  );

  if (!hydState) return <div style={{ ...S.card, marginBottom: 12 }}><span style={note}>Loading Hyderabad…</span></div>;
  if (!draft) return <div style={{ ...S.card, marginBottom: 12 }}><span style={note}>{SETTINGS_UNREADABLE}</span></div>;

  const cfg = draft.plywoodNetworkConfig || {};
  const nc = draft.networkConfigs || {};
  // Read-only truth from the saved config: network brands with a node at Pati. Other
  // plywood brands follow the regular rule (plywoodNonNetworkStrategy).
  const patiBrands = Object.keys(cfg.brands || {}).filter(b => isBrandOnAt(cfg, b, STORE)).sort((a, b) => a.localeCompare(b));
  const brandsNote = `Brands on plywood logic at Pati: ${patiBrands.length ? patiBrands.join(", ") : "none"} — other plywood brands follow the regular rule.`;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // A first save is allowed unchanged: it creates the Hyderabad rows from today's copy.
  // Never after a failed read: the draft may be defaults over a row nobody read.
  const canSave = (dirty || !hydState.stored?.plywood) && !hydReadFailed(hydState);
  const ro = !isAdmin;
  const mode = floorsOnly ? "Floors only" : "Engine";

  const onSave = async () => {
    const msg = (hydState.stored?.plywood ? "" : NOT_SAVED_BEFORE + "\n\n")
      + "Save plywood settings for HYDERABAD (params/hydPlywoodNetworkConfig, params/hydNetworkConfigs)? Bangalore plywood is not touched.";
    if (!window.confirm(msg)) return;
    setSaving(true);
    const saved = draft;
    const ok = await saveHydPlywood(saved);
    setSaving(false);
    if (!ok) { setStatus({ kind: "error", text: "Save failed — Hyderabad plywood may be partly saved; reload and check before retrying." }); return; }
    setHydState(s => ({ ...s, hydPlywood: saved, stored: { ...s.stored, plywood: true } }));
    setStatus({ kind: "info", text: "Hyderabad plywood settings saved." });
  };

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 12, padding: "9px 14px", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, fontSize: 11 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#555" }}>Plywood — HYDERABAD (HYDS01 Pati)</div>
        <div style={note}>Network Design, no DC. Follows the Pati switch (now: {mode}).</div>
        <div style={{ flex: 1 }} />
        {isAdmin && (
          <button style={{ ...S.btn(canSave && !saving), border: "none", cursor: canSave && !saving ? "pointer" : "not-allowed", background: canSave && !saving ? PURPLE : HR.surfaceLight, color: canSave && !saving ? HR.white : HR.muted }} disabled={!canSave || saving} onClick={onSave}>
            {saving ? "Saving…" : "Save (Hyderabad)"}
          </button>
        )}
      </div>
      {status && <div style={banner(status.kind)}>{status.text}</div>}
      {dirty && <div style={banner("warn")}>Unsaved Hyderabad plywood changes.</div>}

      <div style={{ ...S.card, marginBottom: 12, padding: 0, overflow: "hidden" }}>
        <div style={{ background: PURPLE_BG, padding: "12px 14px 14px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, marginBottom: 10, letterSpacing: 0.2 }}>{HYD_PLYWOOD_GROUP_TITLE}</div>
        <div style={{ ...note, marginBottom: 10 }} data-testid="hyd-ply-brands-note">{brandsNote}</div>
        <HydParamEditor rows={hydPlywoodParamRows(cfg)} disabled={ro}
          onChange={(keys, v) => setDraft({ ...draft, plywoodNetworkConfig: setParamPath(cfg, keys, v) })} />
        </div>
      </div>

      <div style={{ ...S.card, marginBottom: 12, padding: "9px 14px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 11 }}>
        <span style={{ fontWeight: 700, color: "#555" }}>Pati capacity</span>
        <span style={{ color: HR.border }}>|</span>
        {["thick", "thin"].map(kind => (
          <Capacity key={kind} label={kind === "thick" ? "Thick sheets" : "Thin sheets"} disabled={ro}
            value={capacityOf(nc, STORE, kind)}
            onChange={v => setDraft({ ...draft, networkConfigs: setCapacity(nc, STORE, kind, v) })} />
        ))}
      </div>

      <PatiSkuTable rows={ply.rows} capacity={ply.capacity} boundary={boundary} floorsOnly={floorsOnly} lookbackDays={lookbackDays}
        thickCap={capacityOf(nc, STORE, "thick")} thinCap={capacityOf(nc, STORE, "thin")} />
    </div>
  );
}
