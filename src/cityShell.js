// App-shell helpers for the city switch: header label/tint, the Hyderabad tab
// list, and the ?city= URL. Pure, so App.jsx carries only the wiring.
import { CITIES } from "./city.js";

export const CITY_THEME = {
  blr: { headerBg: "#FFF8DC", underline: "#F5C400", label: "#7A5C00", title: "IMS · Bangalore" },
  hyd: { headerBg: "#E6F0FA", underline: "#1F5FA8", label: "#1F5FA8", title: "IMS · Hyderabad" },
};

const themeOf = city => CITY_THEME[city] || CITY_THEME.blr;

// Rendered next to the "HomeRun" logo, so the header reads "HomeRun · HYDERABAD ▾".
export const cityHeaderLabel = city => `· ${(CITIES[city] || CITIES.blr).label} ▾`;

// The tint replaces only the background and the bottom border; height and layout stay.
export const cityHeaderStyle = (base, city) => ({
  ...base,
  background: themeOf(city).headerBg,
  borderBottom: `3px solid ${themeOf(city).underline}`,
});

// Hyderabad hides Baskets and Manual Overrides; labels match Bangalore's.
const HYD_PUBLIC_TABS = [
  ["overview", "Overview"], ["skuDetail", "SKU Detail"], ["stockHealth", "Stock Health"],
  ["output", "Tool Output Download"], ["plywood", "Plywood"],
];
const HYD_ADMIN_TABS = [...HYD_PUBLIC_TABS, ["upload", "Upload Data"], ["logic", "Logic Tweaker"]];

export const hydTabsFor = isAdmin => (isAdmin ? HYD_ADMIN_TABS : HYD_PUBLIC_TABS);

export const tabForCity = (tab, tabs) => (tabs.some(([t]) => t === tab) ? tab : "overview");

export const otherCity = city => (city === "hyd" ? "blr" : "hyd");

// Relative URL with ?city= set, for history.replaceState.
export function cityUrl(href, city) {
  const u = new URL(href);
  u.searchParams.set("city", city);
  return u.pathname + u.search + u.hash;
}

// localStorage access itself can throw (blocked site data); city.js handles a null store.
export function safeLocalStorage() {
  try { return window.localStorage; } catch { return null; }
}

// The Hyderabad run must never white-page the app (it runs inside render via useMemo).
export function safeHydRun(run) {
  try {
    return run();
  } catch (e) {
    return { results: null, report: null, error: e?.message || String(e) };
  }
}
