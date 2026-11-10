// City model. Bangalore is "everything that is not Hyderabad" (deny-list), so
// DC01, HOMERUN and unknown values stay Bangalore and Bangalore code paths are
// unchanged when no Hyderabad row exists.
export const HYD_DS_LIST = ["HYDS01"];

export const CITIES = {
  blr: { key: "blr", label: "BANGALORE" },
  hyd: { key: "hyd", label: "HYDERABAD" },
};

const STORAGE_KEY = "ims.city";

export const cityOf = ds => (HYD_DS_LIST.includes(ds) ? "hyd" : "blr");

export const isHydRow = r => cityOf(r?.ds) === "hyd";

// Returns the SAME array reference when there is no Hyderabad row.
export const dropHydRows = inv => (inv.some(isHydRow) ? inv.filter(r => !isHydRow(r)) : inv);

export const hydRowsOnly = inv => inv.filter(isHydRow);

const validCity = v => (v === "blr" || v === "hyd" ? v : null);

export function readInitialCity(search, storage) {
  try {
    const fromUrl = validCity(new URLSearchParams(search || "").get("city"));
    if (fromUrl) return fromUrl;
  } catch { /* fall through */ }
  try {
    const fromStore = validCity(storage?.getItem(STORAGE_KEY));
    if (fromStore) return fromStore;
  } catch { /* storage blocked */ }
  return "blr";
}

export function persistCity(city, storage) {
  try { storage?.setItem(STORAGE_KEY, city); } catch { /* storage blocked */ }
}
