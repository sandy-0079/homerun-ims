// The Hyderabad-only section at the top of the shared Logic Tweaker (spec §9): the
// Pati Floors only ⇄ Engine switch (with its dry-run impact confirm), the order cycle,
// "Copied from Bangalore on <date>" and "Reset to Bangalore's current values".
// Edits only the draft; Apply (in LogicTweakerTab) writes params/hydGlobal.
import React from "react";
import { HR, S } from "../../appStyles";
import { runHydEngine } from "../../hyd/hydEngine.js";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { withFloorsOnly, resetHydParamsToBangalore } from "../../hyd/hydSettings.js";
import { engineFlipImpact } from "../../hyd/hydStats.js";
import { banner, fmtInr, fmtWhen } from "./hydStyles.js";
import { NumField } from "./HydUi.jsx";

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
    "Nothing is saved until you click Apply.",
  ].join("\n");
}

const label = { fontSize: 11, color: HR.muted, fontWeight: 600 };

export default function HydLogicTop({ draft, setDraft, dirty, status, hydState, hydRun, blrParams,
  invoiceData, skuMaster, priceData, deadStock }) {
  const floorsOnly = isFloorsOnly(draft, STORE);

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
    if (!window.confirm("Reset Hyderabad settings to Bangalore's current values?\n\nThe Pati switch and the order cycle are kept. Nothing is saved until you click Apply.")) return;
    setDraft(resetHydParamsToBangalore(draft, blrParams, new Date().toISOString()));
  };

  return (
    <div style={{ background: HR.surface, border: `1px solid ${HR.border}`, borderLeft: "3px solid #1F5FA8", borderRadius: 8, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, color: HR.text, fontSize: 13 }}>Hyderabad — HYDS01 Pati</div>
        <span style={{ fontSize: 11, color: HR.muted }}>
          Copied from Bangalore on {fmtWhen(draft.copiedFromBangaloreAt)}
          {!hydState.stored?.params && " (not saved yet — this is today's copy)"}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onReset} style={S.btn(false)}>Reset to Bangalore&apos;s current values</button>
      </div>
      {status && <div style={{ ...banner(status.kind), marginBottom: 0 }}>{status.text}</div>}
      {dirty && <div style={{ ...banner("warn"), marginBottom: 0 }}>Unsaved Hyderabad changes — screens still show the applied settings until you click Apply.</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={label}>Pati: Floors only ⇄ Engine</span>
        <button style={S.btn(floorsOnly)} onClick={() => !floorsOnly && setDraft(withFloorsOnly(draft, STORE, true))}>Floors only</button>
        <button style={S.btn(!floorsOnly)} onClick={() => floorsOnly && onEngine()}>Engine</button>
        <span style={{ fontSize: 10, color: HR.muted }}>
          Floors only: Pati&apos;s range is the Hyderabad floor sheet. Engine: Bangalore rules on Pati&apos;s own sales, lifted by any floor row. Covers every category, plywood included.
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={label}>Order cycle</span>
        <NumField value={draft.orderCycleDays ?? 3} width={64} onChange={n => setDraft({ ...draft, orderCycleDays: n })} />
        <span style={{ fontSize: 11, color: HR.muted }}>days</span>
        <span style={{ fontSize: 10, color: HR.muted }}>
          Engine numbers only (floors get no buffer): Min += ⌈daily avg × lead time⌉ (Brand Lead Time below); Max = max(Max + buffer, Min + ⌈daily avg × order cycle⌉).
        </span>
      </div>
    </div>
  );
}
