// Hyderabad Plywood: which network brands Pati stocks, Pati's thick/thin
// capacity, and the global network params. Saves only Hyderabad's own rows.
// Editable by admins; everyone else sees it read-only.
import React, { useState } from "react";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { saveHydPlywood, hydReadFailed } from "../../hyd/hydStore.js";
import { flattenParamRows, setParamPath } from "../../hyd/hydParamRows.js";
import { isBrandOnAt, setBrandOnAt, capacityOf, setCapacity } from "../../hyd/hydPlywoodEdit.js";
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

export default function HydPlywoodPanel({ isAdmin, hydState, setHydState }) {
  const [edit, setEdit] = useState(null); // {base, value}
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const base = hydState?.hydPlywood;
  const draft = edit && edit.base === base ? edit.value : base;
  const setDraft = value => setEdit({ base, value });

  if (!hydState) return <div style={{ ...S.card, marginBottom: 12 }}><span style={note}>Loading Hyderabad…</span></div>;
  if (!draft) return <div style={{ ...S.card, marginBottom: 12 }}><span style={note}>{SETTINGS_UNREADABLE}</span></div>;

  const cfg = draft.plywoodNetworkConfig || {};
  const nc = draft.networkConfigs || {};
  const brands = Object.keys(cfg.brands || {}).sort();
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // A first save is allowed unchanged: it creates the Hyderabad rows from today's copy.
  // Never after a failed read: the draft may be defaults over a row nobody read.
  const canSave = (dirty || !hydState.stored?.plywood) && !hydReadFailed(hydState);
  const ro = !isAdmin;
  const mode = isFloorsOnly(hydState.hydParams, STORE) ? "Floors only" : "Engine";

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

      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={sectionTitle}>Brands stocked at Pati</div>
        <table style={{ ...S.table, maxWidth: 360 }}>
          <thead><tr><th style={S.th}>Brand</th><th style={S.th}>HYDS01</th></tr></thead>
          <tbody>
            {brands.map(b => (
              <tr key={b}>
                <td style={S.td}>{b}</td>
                <td style={S.td}>
                  <input type="checkbox" disabled={ro} checked={isBrandOnAt(cfg, b, STORE)}
                    onChange={e => setDraft({ ...draft, plywoodNetworkConfig: setBrandOnAt(cfg, b, STORE, e.target.checked) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!brands.length && <div style={note}>No network brands configured.</div>}
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

      <div style={{ ...S.card, marginBottom: 12, padding: 0, overflow: "hidden" }}>
        <div style={{ background: PURPLE_BG, padding: "12px 14px 14px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, marginBottom: 10, letterSpacing: 0.2 }}>Network parameters</div>
        <HydParamEditor rows={flattenParamRows(cfg, ["brands"])} disabled={ro}
          onChange={(keys, v) => setDraft({ ...draft, plywoodNetworkConfig: setParamPath(cfg, keys, v) })} />
        </div>
      </div>
    </div>
  );
}
