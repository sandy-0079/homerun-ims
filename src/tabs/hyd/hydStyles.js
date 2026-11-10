// Minimal inline styles for the Hyderabad tabs, matching App.jsx's `S` card/table/
// button look without touching it. Hyderabad accents use the city blue.
export const C = {
  text: "#1A1A1A", muted: "#6B6B6B", border: "#E0E0D0", white: "#FFFFFF", surfaceLight: "#F0F0E8",
  blue: "#1F5FA8", blueBg: "#E6F0FA", red: "#B91C1C", redBg: "#FEE2E2", green: "#2D7A3A",
  amber: "#92400E", amberBg: "#FEF3C7",
};

export const card = {
  background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
  padding: "14px 16px", marginBottom: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

export const h2 = { fontSize: 14, fontWeight: 700, color: C.blue, marginBottom: 8 };
export const note = { fontSize: 11, color: C.muted, lineHeight: 1.5 };

export const table = { width: "100%", borderCollapse: "collapse", fontSize: 11 };
export const th = { padding: "6px 8px", textAlign: "left", color: C.muted, background: C.surfaceLight, fontWeight: 600, fontSize: 10, whiteSpace: "nowrap" };
export const td = { padding: "4px 8px", borderTop: `1px solid ${C.border}` };

export const input = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 12 };

export const btn = (primary, disabled) => ({
  padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  border: `1px solid ${primary ? C.blue : C.border}`,
  background: primary ? C.blue : C.white, color: primary ? C.white : C.text,
});

export const banner = (kind) => ({
  fontSize: 12, borderRadius: 6, padding: "8px 10px", marginBottom: 10, lineHeight: 1.5,
  color: kind === "error" ? C.red : kind === "warn" ? C.amber : C.blue,
  background: kind === "error" ? C.redBg : kind === "warn" ? C.amberBg : C.blueBg,
});

export const fmtInr = (v) => {
  if (v == null || Number.isNaN(v)) return "–";
  if (v >= 10000000) return "₹" + (v / 10000000).toFixed(2) + "Cr";
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1) + "L";
  if (v >= 1000) return "₹" + (v / 1000).toFixed(1) + "K";
  return "₹" + Math.round(v).toLocaleString();
};

/** Local calendar date YYYY-MM-DD, as Bangalore's PO download names its file. */
export const todayLocalIso = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const fmtWhen = (iso) => {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
};

// Task 8 carry-in: a missing (or unreadable) stored row must not be overwritten silently.
export const NOT_SAVED_BEFORE =
  "Hyderabad settings have not been saved before (or could not be read). Saving will create them from what you see. Continue?";

// hydState exists but its settings are null (App.jsx's load .catch path).
export const SETTINGS_UNREADABLE = "Hyderabad settings could not be loaded — see the error above.";
