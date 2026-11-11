// Labelled param editor over hydPlywoodParamRows output, laid out like Bangalore's
// Network Design "Global Settings" (src/tabs/PlywoodNetworkTab.jsx): a grid of
// label / input / hint. Numbers as numbers, strings as text, booleans as checkboxes;
// arrays (and nulls) read-only as JSON.
import React from "react";
import { HR } from "../../appStyles.js";
import { NumField, TextField } from "./HydUi.jsx";

const HINT = { fontSize: 9, color: "#9B8EC4", lineHeight: 1.4 };

export default function HydParamEditor({ rows, onChange, disabled }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: HR.muted }}>No parameters.</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "10px 24px" }}>
      {rows.map(r => (
        <label key={r.path} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#444" }}>{r.label}</span>
          {r.kind === "number" && <NumField value={r.value} disabled={disabled} step={r.step ?? "any"} width="100%" onChange={v => onChange(r.keys, v)} />}
          {r.kind === "string" && <TextField value={r.value} disabled={disabled} width="100%" onChange={v => onChange(r.keys, v)} />}
          {r.kind === "boolean" && <input type="checkbox" checked={r.value} disabled={disabled} onChange={e => onChange(r.keys, e.target.checked)} style={{ alignSelf: "flex-start" }} />}
          {(r.kind === "array" || r.kind === "readonly") && (
            <code style={{ color: HR.muted, fontSize: 11 }} title="read-only">{JSON.stringify(r.value)}</code>
          )}
          {r.hint && <span style={HINT}>{r.hint}</span>}
        </label>
      ))}
    </div>
  );
}
