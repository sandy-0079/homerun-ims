// Small shared pieces for the Hyderabad tabs.
import React, { useState } from "react";
import { C, card, input } from "./hydStyles.js";

export function Collapsible({ title, count, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", cursor: "pointer", borderLeft: `3px solid ${C.blue}`, userSelect: "none" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{title}{count != null && <span style={{ color: C.muted, fontWeight: 600 }}> · {count.toLocaleString()}</span>}</span>
        <span style={{ color: C.muted, transform: open ? "rotate(90deg)" : "none", display: "inline-block" }}>›</span>
      </div>
      {open && <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}` }}>{children}</div>}
    </div>
  );
}

/** A number input that commits on blur/Enter; non-numbers are ignored. */
export function NumField({ value, onChange, disabled, width = 80, step = 1 }) {
  const [local, setLocal] = useState(null); // null = not editing, show `value`
  const commit = () => {
    if (local === null) return;
    const n = parseFloat(local);
    setLocal(null);
    if (!Number.isNaN(n) && n !== value) onChange(n);
  };
  return (
    <input type="number" step={step} disabled={disabled}
      value={local ?? String(value ?? "")}
      onChange={e => setLocal(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); }}
      style={{ ...input, width, textAlign: "center", opacity: disabled ? 0.5 : 1 }} />
  );
}

export function TextField({ value, onChange, disabled, width = 160 }) {
  const [local, setLocal] = useState(null);
  const commit = () => {
    if (local === null) return;
    const v = local;
    setLocal(null);
    if (v !== value) onChange(v);
  };
  return (
    <input type="text" disabled={disabled} value={local ?? String(value ?? "")}
      onChange={e => setLocal(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); }}
      style={{ ...input, width, opacity: disabled ? 0.5 : 1 }} />
  );
}

export function SkuList({ items, skuMaster, render }) {
  if (!items.length) return <div style={{ fontSize: 12, color: C.muted }}>None.</div>;
  return (
    <div style={{ maxHeight: 260, overflowY: "auto", fontSize: 12, lineHeight: 1.7 }}>
      {items.map(it => {
        const sku = typeof it === "string" ? it : it.sku;
        return (
          <div key={sku}>
            <code>{sku}</code> <span style={{ color: C.muted }}>{skuMaster?.[sku]?.name || ""}</span>
            {render && <span> — {render(it)}</span>}
          </div>
        );
      })}
    </div>
  );
}
