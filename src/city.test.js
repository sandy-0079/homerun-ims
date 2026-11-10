import { describe, it, expect } from "vitest";
import {
  HYD_DS_LIST, CITIES, cityOf, isHydRow, dropHydRows, hydRowsOnly,
  readInitialCity, persistCity,
} from "./city.js";

const fakeStore = (init = {}) => {
  const m = { ...init };
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m };
};
const throwingStore = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
};

describe("city model", () => {
  it("constants", () => {
    expect(HYD_DS_LIST).toEqual(["HYDS01"]);
    expect(CITIES.blr).toEqual({ key: "blr", label: "BANGALORE" });
    expect(CITIES.hyd).toEqual({ key: "hyd", label: "HYDERABAD" });
  });

  it("cityOf is deny-list: only HYDS01 is hyd", () => {
    expect(cityOf("HYDS01")).toBe("hyd");
    for (const v of ["DS01", "DC01", "HOMERUN", "", undefined, null, "hyds01"]) {
      expect(cityOf(v)).toBe("blr");
    }
  });

  it("isHydRow", () => {
    expect(isHydRow({ ds: "HYDS01" })).toBe(true);
    expect(isHydRow({ ds: "DS01" })).toBe(false);
    expect(isHydRow(null)).toBe(false);
    expect(isHydRow(undefined)).toBe(false);
  });

  it("dropHydRows removes only HYDS01 rows", () => {
    const rows = [{ ds: "DS01", q: 1 }, { ds: "HYDS01", q: 2 }, { ds: "DC01", q: 3 }];
    expect(dropHydRows(rows)).toEqual([{ ds: "DS01", q: 1 }, { ds: "DC01", q: 3 }]);
    expect(rows).toHaveLength(3);
  });

  it("dropHydRows returns the same reference when no Hyderabad row", () => {
    const blrOnly = [{ ds: "DS01" }, { ds: "DS02" }];
    expect(dropHydRows(blrOnly)).toBe(blrOnly);
    const empty = [];
    expect(dropHydRows(empty)).toBe(empty);
  });

  it("hydRowsOnly keeps only HYDS01 rows", () => {
    const rows = [{ ds: "DS01" }, { ds: "HYDS01", q: 2 }];
    expect(hydRowsOnly(rows)).toEqual([{ ds: "HYDS01", q: 2 }]);
  });

  it("readInitialCity precedence: URL, storage, default", () => {
    expect(readInitialCity("?city=hyd", null)).toBe("hyd");
    expect(readInitialCity("?city=blr", fakeStore({ "ims.city": "hyd" }))).toBe("blr");
    expect(readInitialCity("", throwingStore)).toBe("blr");
    expect(readInitialCity("?city=xyz", fakeStore({ "ims.city": "hyd" }))).toBe("hyd");
    expect(readInitialCity("", fakeStore({ "ims.city": "junk" }))).toBe("blr");
    expect(readInitialCity("", null)).toBe("blr");
    expect(readInitialCity(undefined, undefined)).toBe("blr");
  });

  it("persistCity writes ims.city and never throws", () => {
    const s = fakeStore();
    persistCity("hyd", s);
    expect(s._m["ims.city"]).toBe("hyd");
    expect(() => persistCity("hyd", throwingStore)).not.toThrow();
    expect(() => persistCity("hyd", null)).not.toThrow();
  });
});
