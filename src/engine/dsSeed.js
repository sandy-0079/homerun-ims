// DS Seed pass — seeds a new DS's Min/Max from the average of source DSes.
//
// Config: p.dsSeed = { "DS06": ["DS02", "DS04"] }  (equal-weight average of sources)
// Runs after all strategies/floors, before Inventorised-At normalization, so
// Supplier/DS-inv zeroing still wins and Dead Stock zeros propagate (0+0 → 0).
//
// Per field: target = max(existing value, ceil(avg of sources)) — "whichever wins".
// ceil gives union assortment: a SKU stocked at any source gets ≥1 at the target.
//
// DC is re-derived treating the seeded DS as a real sixth DS, using the deltas
// the seed added on top of whatever the target DS already had (organic/floor),
// so nothing is double-counted and the uplift self-decays as organic history
// builds and source values shrink post-carve-out. DC never decreases.
export function applyDSSeed(res, p) {
  const cfg = p?.dsSeed;
  if (!cfg || typeof cfg !== "object") return;

  for (const [targetDS, sources] of Object.entries(cfg)) {
    if (!Array.isArray(sources) || sources.length === 0) continue;

    for (const r of Object.values(res)) {
      const stores = r.stores;
      if (!stores) continue;

      const seedMin = Math.ceil(sources.reduce((s, ds) => s + (stores[ds]?.min || 0), 0) / sources.length);
      const seedMax = Math.ceil(sources.reduce((s, ds) => s + (stores[ds]?.max || 0), 0) / sources.length);
      const synthAvg = sources.reduce((s, ds) => s + (stores[ds]?.dailyAvg || 0), 0) / sources.length;

      const tgt = stores[targetDS];
      if (!tgt) continue;

      const beforeMin = tgt.min || 0, beforeMax = tgt.max || 0;
      const newMin = Math.max(beforeMin, seedMin);
      const newMax = Math.max(beforeMax, seedMax, newMin);
      const seedWon = newMin > beforeMin || newMax > beforeMax;

      if (seedWon) {
        tgt.min = newMin;
        tgt.max = newMax;
        tgt.logicTag = "DS Seed";
        if (!Array.isArray(tgt.postBlendSteps)) tgt.postBlendSteps = [];
        tgt.postBlendSteps.push({ rule: "DS Seed", sources: [...sources], seedMin, seedMax, beforeMin, beforeMax });
      }

      // ── DC re-derivation ────────────────────────────────────────────────
      const dc = r.dc, d = dc?.dcDetails;
      if (!dc || !d || d.isDead) continue;

      const dMin = newMin - beforeMin;               // what the seed added at the target DS
      const dMax = newMax - beforeMax;
      const rateAug = Math.max(0, synthAvg - (tgt.dailyAvg || 0)); // max semantics vs organic rate
      if (dMin <= 0 && dMax <= 0 && rateAug <= 0) continue;

      if (d.strategy === "network_design") {
        // v1 formula: DC = P95(direct) + ceil(Σ DS_Min × dcMult) — augment additively by the Min delta
        if (dMin > 0) {
          dc.min += Math.ceil(dMin * (d.dcMultMin ?? 0.8));
          dc.max = Math.max(dc.max + Math.ceil(dMin * (d.dcMultMax ?? 1.5)), dc.min);
        }
      } else if (d.isFlooredSKU) {
        // Floored formula: Σ DS targets × mult, recomputed with the seed deltas added to the sums
        const nm = Math.round(((d.sumMin || 0) + dMin) * (d.multMin ?? 0.2));
        const nx = Math.round(((d.sumMax || 0) + dMax) * (d.multMax ?? 0.3));
        dc.min = Math.max(dc.min, nm);
        dc.max = Math.max(dc.max, nx, dc.min);
      } else {
        // Rate-based formula, recomputed with the synthetic rate added
        const rate = (d.sumDailyAvg || 0) + rateAug;
        const lt = d.leadTime ?? 3;
        const nm = Math.ceil(rate * (lt + 1));
        dc.min = Math.max(dc.min, nm);
        dc.max = Math.max(dc.max, nm + Math.ceil(rate * 2), dc.min);
      }
      d.dsSeedAug = { targetDS, sources: [...sources], seedMin, seedMax, dMin, dMax, rateAug };
    }
  }
}
