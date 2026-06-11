// Keep Score (spec §8): KeepScore = max(RentRatio [gated NZD≥2], ServiceRatio).
// Sales basis = window qty × purchase price (invoice rows carry no sale value;
// cost basis ≈ sale value at 6% margin — immaterial for the ratio).

export function computeKeepScores(inputs, cfg) {
  const { plan, dcPlan, priceData, windowQty, networkNZD, regularNZD } = inputs;
  const gm = cfg.grossMarginPct ?? 0.06;
  const carry = cfg.carryRateQuarterly ?? 0.05;
  const buffer = cfg.opsBuffer ?? 1.5;
  const svcTh = cfg.serviceNZDThreshold ?? 5;

  return Object.keys(plan).sort().map(sku => {
    const pp = priceData?.[sku] || 0;
    let avgPosition = 0;
    for (const p of Object.values(plan[sku])) avgPosition += (p.min + p.max) / 2;
    if (dcPlan?.[sku]) avgPosition += (dcPlan[sku].min + dcPlan[sku].max) / 2;
    const holdingValue = avgPosition * pp;
    const margin = (windowQty?.[sku] || 0) * pp * gm;
    const rentRaw = holdingValue > 0 ? margin / (holdingValue * carry * buffer) : 0;
    const rentRatio = (regularNZD?.[sku] || 0) >= 2 ? rentRaw : 0;
    const serviceRatio = (networkNZD?.[sku] || 0) / svcTh;
    const keepScore = Math.max(rentRatio, serviceRatio);
    const flag = keepScore < 1 ? 'Cut' : keepScore < 1.3 ? 'Watch' : 'Keep';
    return { sku, pp, avgPosition, holdingValue, rentRatio, serviceRatio, keepScore, flag };
  });
}
