// Flattening for the Hyderabad Logic Tweaker's generic param editor. Nested
// objects become `a.b` rows; `keys` carries the real path so a key that itself
// contains a dot is never mis-split. Pure.

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

function kindOf(v) {
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "array";
  return "readonly";
}

/**
 * @param {object} params
 * @param {string[]} excludeKeys top-level keys to leave out
 * @returns {{path:string, keys:string[], kind:"number"|"string"|"boolean"|"array"|"readonly", value:any}[]}
 *   sorted by path; only number/string/boolean are editable
 */
export function flattenParamRows(params, excludeKeys = []) {
  const rows = [];
  const walk = (obj, keys) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = [...keys, k];
      if (isPlainObject(v) && Object.keys(v).length) walk(v, path);
      else rows.push({ path: path.join("."), keys: path, kind: kindOf(v), value: v });
    }
  };
  const top = {};
  for (const [k, v] of Object.entries(params || {})) if (!excludeKeys.includes(k)) top[k] = v;
  walk(top, []);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** Immutable deep set along `keys`; creates intermediate objects as needed. */
export function setParamPath(obj, keys, value) {
  const [k, ...rest] = keys;
  const base = isPlainObject(obj) ? obj : {};
  return { ...base, [k]: rest.length ? setParamPath(base[k], rest, value) : value };
}
