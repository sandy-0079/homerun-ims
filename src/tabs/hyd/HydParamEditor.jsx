// Generic key/value editor over flattenParamRows output: numbers as numbers,
// strings as text, booleans as checkboxes; arrays (and nulls) read-only as JSON.
import React from "react";
import { S, HR } from "../../appStyles.js";
import { NumField, TextField } from "./HydUi.jsx";

export default function HydParamEditor({ rows, onChange, disabled }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: HR.muted }}>No parameters.</div>;
  return (
    <table style={S.table}>
      <thead><tr><th style={S.th}>Parameter</th><th style={S.th}>Value</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.path}>
            <td style={{ ...S.td, fontFamily: "monospace" }}>{r.path}</td>
            <td style={S.td}>
              {r.kind === "number" && <NumField value={r.value} disabled={disabled} step="any" onChange={v => onChange(r.keys, v)} />}
              {r.kind === "string" && <TextField value={r.value} disabled={disabled} onChange={v => onChange(r.keys, v)} />}
              {r.kind === "boolean" && <input type="checkbox" checked={r.value} disabled={disabled} onChange={e => onChange(r.keys, e.target.checked)} />}
              {(r.kind === "array" || r.kind === "readonly") && (
                <code style={{ color: HR.muted, fontSize: 11 }} title="read-only">{JSON.stringify(r.value)}</code>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
