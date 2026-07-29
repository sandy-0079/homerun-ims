import { describe, it, expect } from "vitest";
import { mapItemsToMaster, mapPricesReport, assessMasterChange, mergePrices } from "./catalogueMap.ts";

const item = (o: Record<string, unknown> = {}) => ({
  sku: "A", name: "Item A", category_name: "Cement", brand: "ACC", status: "active", ...o,
});

describe("mapItemsToMaster", () => {
  it("maps the fields Zoho is authoritative for", () => {
    const { master } = mapItemsToMaster([item()], {});
    expect(master.A).toMatchObject({ sku: "A", name: "Item A", category: "Cement", brand: "ACC", status: "active" });
  });

  it("skips items with no SKU", () => {
    expect(Object.keys(mapItemsToMaster([item({ sku: "" })], {}).master)).toEqual([]);
  });

  // ── inventorisedAt: the field Zoho does not have yet ──────────────────────
  // Live master is 2,004 DC / 58 Supplier / 12 DS. handleSKU defaults a missing
  // value to "DS", so taking Zoho as authoritative today would reclassify ~2,000
  // SKUs from DC to DS — which zeroes the entire DC plan via the Inventorised-At
  // normalization pass. So we keep the stored value whenever Zoho is silent.
  it("keeps the stored inventorisedAt when Zoho has no custom field", () => {
    const current = { A: { sku: "A", inventorisedAt: "DC" } };
    expect(mapItemsToMaster([item()], current).master.A.inventorisedAt).toBe("DC");
  });

  it("lets Zoho win once the custom field is populated", () => {
    const current = { A: { sku: "A", inventorisedAt: "DC" } };
    const withCf = item({ custom_fields: [{ api_name: "cf_inventorised_at", value: "Supplier" }] });
    expect(mapItemsToMaster([withCf], current).master.A.inventorisedAt).toBe("Supplier");
  });

  it("also reads the field from custom_field_hash, which some Zoho responses use instead", () => {
    const current = { A: { sku: "A", inventorisedAt: "DC" } };
    const withHash = item({ custom_field_hash: { cf_inventorised_at: "DS" } });
    expect(mapItemsToMaster([withHash], current).master.A.inventorisedAt).toBe("DS");
  });

  it("ignores a blank custom field rather than treating it as an answer", () => {
    const current = { A: { sku: "A", inventorisedAt: "DC" } };
    const blank = item({ custom_fields: [{ api_name: "cf_inventorised_at", value: "  " }] });
    expect(mapItemsToMaster([blank], current).master.A.inventorisedAt).toBe("DC");
  });

  it("falls back to DC for a brand-new SKU with no stored value and no Zoho field", () => {
    // DC is 96% of the live master, and a new SKU has no sales history so its
    // targets are near zero either way. Reported so it is never silent.
    const { master, report } = mapItemsToMaster([item({ sku: "NEW" })], {});
    expect(master.NEW.inventorisedAt).toBe("DC");
    expect(report.newSkusDefaulted).toEqual(["NEW"]);
  });

  // ── Status ownership, decided 2026-07-29: "we need Min and Max only for the active
  //    SKUs on Zoho. SKUs with any other status are immaterial to us."
  //
  //    So Zoho is authoritative for status and there is no local vocabulary to
  //    preserve — `Confirmation Pending` deliberately loses to Zoho. But that makes
  //    status the field that decides whether a SKU is stocked AT ALL, so absence must
  //    fail safe and disappearance must not be silent.
  describe("status ownership (Zoho authoritative)", () => {
    it("takes Zoho's status verbatim, including inactive", () => {
      const { master } = mapItemsToMaster([item({ status: "inactive" })], {});
      expect(master.A.status).toBe("inactive");
    });

    it("lets Zoho's active override a stored Confirmation Pending", () => {
      // The 5 live SKUs (29ZVW, E3MPF, TENX4, WUTDS, XP5EV). Sandy's call: Zoho wins.
      const { master } = mapItemsToMaster([item({ status: "active" })], {
        A: { sku: "A", status: "Confirmation Pending", inventorisedAt: "DC" },
      });
      expect(master.A.status).toBe("active");
    });

    it("treats a MISSING status as not-active rather than defaulting it in", () => {
      // Same principle as isSellableStatus rejecting an empty status: absent data is
      // not evidence. Defaulting to active would stock a SKU on no information, and
      // under the new rule that default decides whether it gets Min/Max at all.
      const { master } = mapItemsToMaster([item({ status: undefined })], {});
      expect(master.A.status.toLowerCase()).not.toBe("active");
    });
  });

  describe("SKUs absent from the Zoho pull", () => {
    const stored = {
      A: { sku: "A", name: "Item A", category: "Cement", brand: "ACC", status: "Active", inventorisedAt: "DC" },
      GONE: { sku: "GONE", name: "Old Item", category: "Tiling", brand: "MYK", status: "Active", inventorisedAt: "DC" },
    };

    it("retains a stored SKU that Zoho did not return", () => {
      // A partial /items response is indistinguishable from a deletion. Dropping the
      // SKU would also make its invoice rows unknown to assessCoverage, which is the
      // guard that refuses to write invoice data at all.
      const { master } = mapItemsToMaster([item()], stored);
      expect(master.GONE).toBeDefined();
      expect(master.GONE.category).toBe("Tiling");
    });

    it("marks the retained SKU not-active so it gets no Min/Max", () => {
      const { master } = mapItemsToMaster([item()], stored);
      expect(master.GONE.status.toLowerCase()).not.toBe("active");
    });

    it("names them in the report so a real deletion is visible", () => {
      const { report } = mapItemsToMaster([item()], stored);
      expect(report.absentFromZoho).toEqual(["GONE"]);
    });

    it("does not invent absences when Zoho returns everything", () => {
      const { report } = mapItemsToMaster([item(), item({ sku: "GONE" })], stored);
      expect(report.absentFromZoho).toEqual([]);
    });
  });

  it("reports where inventorisedAt came from, so the Zoho migration is observable", () => {
    const current = { A: { sku: "A", inventorisedAt: "DC" }, B: { sku: "B", inventorisedAt: "DC" } };
    const items = [
      item({ sku: "A", custom_fields: [{ api_name: "cf_inventorised_at", value: "DC" }] }),
      item({ sku: "B" }),
    ];
    const { report } = mapItemsToMaster(items, current);
    expect(report.invAtFromZoho).toBe(1);
    expect(report.invAtFromStored).toBe(1);
  });
});

describe("mapPricesReport", () => {
  // Shape of reports/purchasesbyitem: purchases_by_item[].purchase[].
  const page = (rows: Array<[string, number]>) => ({
    purchases_by_item: [{ purchase: rows.map(([sku, average_price]) => ({ item: { sku }, average_price })) }],
  });

  it("extracts sku -> average_price", () => {
    expect(mapPricesReport([page([["A", 910.87], ["B", 42]])]).prices).toEqual({ A: 910.87, B: 42 });
  });

  it("drops zero and negative prices, matching the CSV upload path", () => {
    expect(mapPricesReport([page([["A", 0], ["B", -5], ["C", 10]])]).prices).toEqual({ C: 10 });
  });

  it("drops rows with no sku", () => {
    const p = { purchases_by_item: [{ purchase: [{ item: {}, average_price: 10 }] }] };
    expect(mapPricesReport([p]).prices).toEqual({});
  });

  it("merges across pages", () => {
    expect(Object.keys(mapPricesReport([page([["A", 1]]), page([["B", 2]])]).prices).sort()).toEqual(["A", "B"]);
  });

  it("survives an empty or malformed page", () => {
    expect(mapPricesReport([{}, { purchases_by_item: null }]).prices).toEqual({});
  });
});

describe("assessMasterChange", () => {
  const m = (n: number, invAt: string) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`S${i}`, { sku: `S${i}`, inventorisedAt: invAt, status: "active" }]));

  it("passes a change that keeps the inventorisedAt mix stable", () => {
    expect(assessMasterChange(m(100, "DC"), m(102, "DC"), 5).safe).toBe(true);
  });

  it("FAILS the mass DC->DS reclassification this guard exists for", () => {
    expect(assessMasterChange(m(100, "DC"), m(100, "DS"), 5).safe).toBe(false);
  });

  it("fails if the master shrinks sharply", () => {
    expect(assessMasterChange(m(100, "DC"), m(50, "DC"), 5).safe).toBe(false);
  });

  it("fails on an empty result — a pull returning nothing is not a valid catalogue", () => {
    expect(assessMasterChange(m(100, "DC"), {}, 5).safe).toBe(false);
  });

  // Added 2026-07-29. Once Zoho owns `status`, it decides whether a SKU is stocked at
  // all — but this guard only ever watched the inventorisedAt mix and the row count.
  // A pull that flipped SKUs to inactive changes NEITHER, so it passed every check
  // and silently zeroed their Min/Max. 2,084 of 2,092 are active, so the exposure is
  // most of the catalogue.
  it("FAILS a mass flip of active SKUs to inactive", () => {
    const many = (n: number, status: string, from = 0) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i + from}`, { status, inventorisedAt: "DC" }]));
    const before = many(100, "Active");
    const after = { ...many(80, "Active"), ...many(20, "Inactive", 80) };
    expect(assessMasterChange(before, after, 5).safe).toBe(false);
  });

  it("allows a small, ordinary status change", () => {
    const many = (n: number, status: string, from = 0) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i + from}`, { status, inventorisedAt: "DC" }]));
    const before = many(100, "Active");
    const after = { ...many(98, "Active"), ...many(2, "Inactive", 98) };
    expect(assessMasterChange(before, after, 5).safe).toBe(true);
  });

  it("treats Active and active as the same status when measuring the shift", () => {
    // The CSV path writes "Active"; Zoho writes "active". A case difference must not
    // read as the entire catalogue being deactivated.
    const before = { A: { status: "Active", inventorisedAt: "DC" }, B: { status: "Active", inventorisedAt: "DC" } };
    const after = { A: { status: "active", inventorisedAt: "DC" }, B: { status: "active", inventorisedAt: "DC" } };
    expect(assessMasterChange(before, after, 5).safe).toBe(true);
  });

  it("passes on first run when there is no prior master to compare against", () => {
    expect(assessMasterChange({}, m(100, "DC"), 5).safe).toBe(true);
  });
});

describe("customField exposure shapes (caught by the 2026-07-28 dry run)", () => {
  const current = { A: { sku: "A", inventorisedAt: "DC" } };

  it("reads a TOP-LEVEL cf_* key — how the items LIST actually returns them", () => {
    // The live /items list exposes cf_dc01_rampura, cf_ds01_sarjapur etc. as
    // top-level keys. Reading only custom_fields[] / custom_field_hash meant
    // cf_inventorised_at would never have been found once created — a silent
    // permanent fallback that would look like the migration just wasn't working.
    const it = item({ cf_inventorised_at: "Supplier" });
    expect(mapItemsToMaster([it], current).master.A.inventorisedAt).toBe("Supplier");
  });

  it("still reads the custom_fields array shape", () => {
    const it = item({ custom_fields: [{ api_name: "cf_inventorised_at", value: "DS" }] });
    expect(mapItemsToMaster([it], current).master.A.inventorisedAt).toBe("DS");
  });

  it("prefers a populated top-level key over a blank array entry", () => {
    const it = item({ cf_inventorised_at: "Supplier", custom_fields: [{ api_name: "cf_inventorised_at", value: "" }] });
    expect(mapItemsToMaster([it], current).master.A.inventorisedAt).toBe("Supplier");
  });

  it("ignores a blank top-level key", () => {
    expect(mapItemsToMaster([item({ cf_inventorised_at: "" })], current).master.A.inventorisedAt).toBe("DC");
  });
});

describe("mergePrices", () => {
  it("keeps an existing price when Zoho has none for that SKU", () => {
    // purchasesbyitem can only see purchases made in the CURRENT org, i.e. since
    // the 2026-07-01 migration. Measured: 1,477 priced vs 1,822 stored. Replacing
    // wholesale would push 345 SKUs to "No Price", which the PCT strategy treats
    // as the 95th percentile — stocking them MORE, not less.
    const { prices, report } = mergePrices({ A: 100, B: 200 }, { A: 110 });
    expect(prices).toEqual({ A: 110, B: 200 });
    expect(report).toMatchObject({ updated: 1, retained: 1, added: 0 });
  });

  it("adds prices for SKUs that had none", () => {
    const { prices, report } = mergePrices({ A: 100 }, { B: 50 });
    expect(prices).toEqual({ A: 100, B: 50 });
    expect(report.added).toBe(1);
  });

  it("never lets a price go missing", () => {
    const current = Object.fromEntries(Array.from({ length: 1822 }, (_, i) => [`S${i}`, 10]));
    const incoming = Object.fromEntries(Array.from({ length: 1477 }, (_, i) => [`S${i}`, 20]));
    const { prices } = mergePrices(current, incoming);
    expect(Object.keys(prices)).toHaveLength(1822);
  });

  it("returns the current set unchanged when the report came back empty", () => {
    expect(mergePrices({ A: 100 }, {}).prices).toEqual({ A: 100 });
  });
});
