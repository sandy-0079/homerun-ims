// Hyderabad Logic Tweaker (admin). Edits a local draft of hydParams; only
// "Apply (Hyderabad)" writes, and only params/hydGlobal. Bangalore's Apply is not
// rendered here.
import React, { useMemo, useState } from "react";
import { runHydEngine } from "../../hyd/hydEngine.js";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { saveHydParams, hydReadFailed } from "../../hyd/hydStore.js";
import { flattenParamRows, setParamPath } from "../../hyd/hydParamRows.js";
import {
  HYD_EDITOR_EXCLUDED_KEYS, HYD_NON_NETWORK_OPTIONS, PLYWOOD_CATEGORY,
  strategyOptionsFor, setCategoryStrategy, withFloorsOnly, resetHydParamsToBangalore,
} from "../../hyd/hydSettings.js";
import { engineFlipImpact } from "../../hyd/hydStats.js";
import { C, card, h2, note, table, th, td, input, btn, banner, fmtInr, fmtWhen, NOT_SAVED_BEFORE, SETTINGS_UNREADABLE } from "./hydStyles.js";
import { Collapsible, NumField } from "./HydUi.jsx";
import HydParamEditor from "./HydParamEditor.jsx";

const STORE = "HYDS01";

function flipMessage(impact) {
  const z = impact.blockedByFlag, f = impact.flaggedByFlag;
  const line = k => `  ${k}: ${z[k].toLocaleString()}   (SKUs carrying the flag: ${f[k].toLocaleString()} — most have no Pati sales)`;
  return [
    "Switch Pati to ENGINE?",
    "",
    `SKUs with targets (now, as applied → with Engine): ${impact.before.withTargets.toLocaleString()} → ${impact.after.withTargets.toLocaleString()}`,
    "Pati demand blocked by a Bangalore flag (SKUs with Pati sales but no Hyderabad floor row):",
    line("Purchase=OFF"),
    line("Supplier"),
    line("Dead Stock"),
    `Inv Value Max (now → with Engine): ${fmtInr(impact.before.invMax)} → ${fmtInr(impact.after.invMax)}`,
    "",
    "Nothing is saved until you click Apply (Hyderabad).",
  ].join("\n");
}

function ModeSwitch({ draft, onFloorsOnly, onEngine }) {
  const floorsOnly = isFloorsOnly(draft, STORE);
  return (
    <div style={card}>
      <div style={h2}>Pati: Floors only ⇄ Engine</div>
      <div style={{ display: "flex", gap: 6 }}>
        <button style={btn(floorsOnly)} onClick={() => !floorsOnly && onFloorsOnly()}>Floors only</button>
        <button style={btn(!floorsOnly)} onClick={() => floorsOnly && onEngine()}>Engine</button>
      </div>
      <div style={{ ...note, marginTop: 6 }}>
        Floors only: Pati's range is the Hyderabad floor sheet. Engine: Bangalore rules on Pati's own sales, lifted by any floor row.
        Covers every category, plywood included.
      </div>
    </div>
  );
}

function LeadTimes({ map, onChange }) {
  const [brand, setBrand] = useState("");
  const entries = Object.entries(map || {}).sort(([a], [b]) => (a === "_default" ? -1 : b === "_default" ? 1 : a.localeCompare(b)));
  return (
    <div>
      <table style={{ ...table, maxWidth: 420 }}>
        <thead><tr><th style={th}>Brand</th><th style={th}>Lead time (days)</th><th style={th}></th></tr></thead>
        <tbody>
          {entries.map(([b, v]) => (
            <tr key={b}>
              <td style={td}>{b === "_default" ? "All other brands (_default)" : b}</td>
              <td style={td}><NumField value={v} onChange={n => onChange({ ...map, [b]: n })} /></td>
              <td style={td}>{b !== "_default" && (
                <button style={btn(false)} onClick={() => { const next = { ...map }; delete next[b]; onChange(next); }}>Remove</button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input value={brand} onChange={e => setBrand(e.target.value)} placeholder="Brand name" style={{ ...input, width: 180 }} />
        <button style={btn(false, !brand.trim())} disabled={!brand.trim()}
          onClick={() => { onChange({ ...map, [brand.trim()]: map?._default ?? 3 }); setBrand(""); }}>Add brand</button>
      </div>
    </div>
  );
}

function Strategies({ draft, categories, setDraft }) {
  const cs = draft.categoryStrategies || {};
  return (
    <table style={{ ...table, maxWidth: 560 }}>
      <thead><tr><th style={th}>Category</th><th style={th}>Strategy</th></tr></thead>
      <tbody>
        {categories.map(cat => (
          <React.Fragment key={cat}>
            <tr>
              <td style={td}>{cat}</td>
              <td style={td}>
                <select value={cs[cat] || "standard"} style={input} onChange={e => setDraft(setCategoryStrategy(draft, cat, e.target.value))}>
                  {strategyOptionsFor(cat).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </td>
            </tr>
            {cat === PLYWOOD_CATEGORY && cs[cat] === "network_design" && (
              <tr>
                <td style={{ ...td, paddingLeft: 24, color: C.muted }}>↳ Non-network brands</td>
                <td style={td}>
                  <select value={draft.plywoodNonNetworkStrategy || "percentile_cover"} style={input}
                    onChange={e => setDraft({ ...draft, plywoodNonNetworkStrategy: e.target.value })}>
                    {HYD_NON_NETWORK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

export default function HydLogicTweaker({ isAdmin, invoiceData, skuMaster, priceData, deadStock, hydState, setHydState, hydRun, blrParams }) {
  // The draft is tied to the hydParams object it was started from, so a save (or
  // any other hydState change) discards it without an effect.
  const [edit, setEdit] = useState(null); // {base, value}
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const base = hydState?.hydParams;
  const draft = edit && edit.base === base ? edit.value : base;
  const setDraft = value => setEdit({ base, value });

  const categories = useMemo(() => {
    const set = new Set(Object.values(skuMaster || {}).map(m => m?.category).filter(Boolean));
    for (const c of Object.keys(draft?.categoryStrategies || {})) set.add(c);
    return [...set].sort();
  }, [skuMaster, draft]);

  if (!isAdmin) return <div style={card}><span style={note}>Logic Tweaker is admin-only.</span></div>;
  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;
  if (!draft) return <div style={card}><span style={note}>{SETTINGS_UNREADABLE}</span></div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  // A first save is allowed unchanged: it creates the Hyderabad rows from today's copy.
  // Never after a failed read: the draft may be defaults over a row nobody read.
  const canSave = (dirty || !hydState.stored?.params) && !hydReadFailed(hydState);
  const editorRows = flattenParamRows(draft, HYD_EDITOR_EXCLUDED_KEYS);

  const onEngine = () => {
    const next = withFloorsOnly(draft, STORE, false);
    let impact;
    try {
      const after = runHydEngine({ invoiceData, skuMaster, priceData, deadStock, floors: hydState.floors, hydParams: next, hydPlywood: hydState.hydPlywood });
      impact = engineFlipImpact(hydRun, after, priceData);
    } catch (e) {
      alert(`Could not compute the impact of switching to Engine (${e?.message || e}). Not switched.`);
      return;
    }
    if (window.confirm(flipMessage(impact))) setDraft(next);
  };

  const onReset = () => {
    if (!blrParams) { alert("Bangalore settings are not loaded — cannot reset."); return; }
    if (!window.confirm("Reset Hyderabad settings to Bangalore's current values?\n\nThe Pati switch and the order cycle are kept. Nothing is saved until you click Apply (Hyderabad).")) return;
    setDraft(resetHydParamsToBangalore(draft, blrParams, new Date().toISOString()));
  };

  const onApply = async () => {
    const msg = (hydState.stored?.params ? "" : NOT_SAVED_BEFORE + "\n\n")
      + "Apply these settings to HYDERABAD (params/hydGlobal)? Bangalore settings are not touched.";
    if (!window.confirm(msg)) return;
    setSaving(true);
    const saved = draft;
    const ok = await saveHydParams(saved);
    setSaving(false);
    if (!ok) { setStatus({ kind: "error", text: "Save failed — Hyderabad settings were NOT changed." }); return; }
    setHydState(s => ({ ...s, hydParams: saved, stored: { ...s.stored, params: true } }));
    setStatus({ kind: "info", text: "Hyderabad settings applied." });
  };

  return (
    <div>
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ ...h2, marginBottom: 0 }}>Logic Tweaker — HYDERABAD</div>
        <div style={note}>
          Copied from Bangalore on {fmtWhen(draft.copiedFromBangaloreAt)}
          {!hydState.stored?.params && " (not saved yet — this is today's copy)"}
        </div>
        <div style={{ flex: 1 }} />
        <button style={btn(false)} onClick={onReset}>Reset to Bangalore's current values</button>
        <button style={btn(true, !canSave || saving)} disabled={!canSave || saving} onClick={onApply}>
          {saving ? "Saving…" : "Apply (Hyderabad)"}
        </button>
      </div>
      {status && <div style={banner(status.kind)}>{status.text}</div>}
      {dirty && <div style={banner("warn")}>Unsaved Hyderabad changes — screens still show the applied settings until you click Apply (Hyderabad).</div>}

      <ModeSwitch draft={draft} onFloorsOnly={() => setDraft(withFloorsOnly(draft, STORE, true))} onEngine={onEngine} />

      <div style={card}>
        <div style={h2}>Order cycle and lead-time buffer</div>
        <div style={{ ...note, marginBottom: 8 }}>
          Engine numbers only (floors get no buffer): Min += ⌈daily avg × lead time⌉; Max = max(Max + buffer, Min + ⌈daily avg × order cycle⌉).
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 12 }}>
          Order cycle (days) <NumField value={draft.orderCycleDays ?? 3} onChange={n => setDraft({ ...draft, orderCycleDays: n })} />
        </div>
        <LeadTimes map={draft.brandLeadTimeDays || {}} onChange={m => setDraft({ ...draft, brandLeadTimeDays: m })} />
      </div>

      <Collapsible title="Category → Strategy" count={categories.length}>
        <Strategies draft={draft} categories={categories} setDraft={setDraft} />
      </Collapsible>

      <Collapsible title="Other parameters" count={editorRows.length}>
        <HydParamEditor rows={editorRows} onChange={(keys, v) => setDraft(setParamPath(draft, keys, v))} />
      </Collapsible>
    </div>
  );
}
