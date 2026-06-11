// DC sizing (spec §6): repl P98 of rolling (L+1)-day TO drain + bulk P90 (additive)
// + cycle stock (mean drain × coverDays). Optional thick/thin capacity trim.

import { percentile } from '../../utils.js';

export function rollingSums(series, windowDates, span) {
  const vals = windowDates.map(d => series?.[d] || 0);
  const out = [];
  for (let i = 0; i + span <= vals.length; i++) {
    let s = 0;
    for (let j = i; j < i + span; j++) s += vals[j];
    out.push(s);
  }
  return out;
}

export function sizeDC(toDrain, bulkDaily, windowDates, cfg) {
  const L = (cfg.leadDays ?? 3) + 1;
  const replP = cfg.dcReplPercentile ?? 98;
  const bulkP = cfg.dcBulkPercentile ?? 90;
  const cover = cfg.dcCoverDays ?? 2;
  const share = cfg.bulkDcServedShare ?? 1.0;

  const skus = [...new Set([...Object.keys(toDrain), ...Object.keys(bulkDaily)])].sort();
  const dcPlan = {}, detail = {};
  for (const sku of skus) {
    const drainSums = rollingSums(toDrain[sku], windowDates, L).sort((a, b) => a - b);
    const repl = Math.ceil(percentile(drainSums, replP) || 0);

    const scaled = {};
    for (const [d, q] of Object.entries(bulkDaily[sku] || {})) scaled[d] = q * share;
    const bulkSums = rollingSums(scaled, windowDates, L).sort((a, b) => a - b);
    const bulk = Math.ceil(percentile(bulkSums, bulkP) || 0);

    const totalDrain = windowDates.reduce((a, d) => a + (toDrain[sku]?.[d] || 0), 0);
    const meanDrain = windowDates.length ? totalDrain / windowDates.length : 0;
    const cycle = Math.ceil(meanDrain * cover);

    const min = repl + bulk;
    dcPlan[sku] = { min, max: min + cycle };
    detail[sku] = { repl, bulk, cycle };
  }
  return { dcPlan, detail };
}

// Capacity trim (spec §6): (1) drop cycle stock, (2) lower bulk percentile 90→85→80.
// Returns trimmed copies + report. Never touches the repl component.
export function trimDCToCapacity(dcPlan, detail, toDrain, bulkDaily, windowDates, cfg, dcCapacity, tclassOf) {
  if (!dcCapacity) return { dcPlan, detail, trimReport: null };
  const over = (p) => {
    const sums = { thick: 0, thin: 0 };
    for (const [sku, v] of Object.entries(p)) sums[tclassOf(sku)] += v.max;
    return {
      thick: sums.thick - (dcCapacity.thick ?? Infinity),
      thin: sums.thin - (dcCapacity.thin ?? Infinity),
      sums,
    };
  };
  let cur = { dcPlan, detail };
  let o = over(cur.dcPlan);
  const steps = [];
  if (o.thick <= 0 && o.thin <= 0) return { ...cur, trimReport: { steps, final: o.sums, stillOver: false } };

  // Step 1: drop cycle stock
  cur = sizeDC(toDrain, bulkDaily, windowDates, { ...cfg, dcCoverDays: 0 });
  steps.push('cycle stock removed');
  o = over(cur.dcPlan);
  // Step 2: lower bulk percentile
  for (const p of [85, 80]) {
    if (o.thick <= 0 && o.thin <= 0) break;
    cur = sizeDC(toDrain, bulkDaily, windowDates, { ...cfg, dcCoverDays: 0, dcBulkPercentile: p });
    steps.push(`bulk percentile → ${p}`);
    o = over(cur.dcPlan);
  }
  return { ...cur, trimReport: { steps, final: o.sums, stillOver: o.thick > 0 || o.thin > 0 } };
}
