// Deterministic day-by-day replay (spec §7). One engine, two consumers:
// DC sizing (drain series, infiniteDC) and the Simulation panel (service levels).
//
// Timing model (documented simplification): arrivals (TO at DS, PO at DC) are applied
// at the START of day; the day's orders then draw stock; replenishment triggers are
// evaluated on CLOSING stock. TO raised on day D arrives start of D+1. PO raised on
// day D arrives start of D+leadDays. Initial stock = Max everywhere.

// deterministic 0..1 hash of an order id — stable bulk routing across runs
function orderHash01(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

export function replay(plan, dcPlan, demand, cfg) {
  const { orders, windowDates } = demand;
  const leadDays = cfg.leadDays ?? 3;
  const infiniteDC = !!cfg.infiniteDC;
  // α: share of bulk orders routed to DC; the rest go supplier-direct (assumed served)
  const dcShare = cfg.bulkDcServedShare ?? 1.0;

  const skus = Object.keys(plan);
  const dsStock = {};            // sku → ds → qty
  const dcStock = {};            // sku → qty
  const dcOnOrder = {};          // sku → qty already on PO
  for (const sku of skus) {
    dsStock[sku] = {};
    for (const ds of Object.keys(plan[sku])) dsStock[sku][ds] = plan[sku][ds].max;
    dcStock[sku] = infiniteDC ? Infinity : (dcPlan?.[sku]?.max ?? 0);
    dcOnOrder[sku] = 0;
  }

  const ordersByDate = {};
  for (const o of orders) {
    if (!ordersByDate[o.date]) ordersByDate[o.date] = [];
    ordersByDate[o.date].push(o);
  }

  // TO fulfilment: the DC's replenishment promise — every TO line shipped in full?
  const toFill = { lines: 0, fullLines: 0, qtyRequested: 0, qtyShipped: 0 };

  const pendingTO = {};          // arriveDate → [{sku, ds, qty}]
  const pendingPO = {};          // arriveDate → [{sku, qty}]
  const toDrain = {};            // sku → date → requested qty (DC-side demand view)
  const oosEvents = [];
  const counts = { regular: { total: 0, oos: 0, perDS: {} }, bulk: { total: 0, oos: 0, supplierRouted: 0 } };
  const dcStockByDate = {};      // sku → date → closing qty (tests/UI)
  const opsLoad = { toLines: 0, poLines: 0 };

  windowDates.forEach((date, i) => {
    // 1) Arrivals
    for (const t of pendingTO[date] || []) {
      const ship = infiniteDC ? t.qty : Math.min(t.qty, dcStock[t.sku]);
      if (!infiniteDC) dcStock[t.sku] -= ship;
      dsStock[t.sku][t.ds] += ship;
      if (!toDrain[t.sku]) toDrain[t.sku] = {};
      toDrain[t.sku][date] = (toDrain[t.sku][date] || 0) + t.qty;
      toFill.lines += 1;
      if (ship >= t.qty) toFill.fullLines += 1;
      toFill.qtyRequested += t.qty;
      toFill.qtyShipped += ship;
    }
    for (const p of pendingPO[date] || []) {
      dcStock[p.sku] += p.qty;
      dcOnOrder[p.sku] -= p.qty;
    }

    // 2) Demand
    for (const o of ordersByDate[date] || []) {
      // α-routing: (1−α) of bulk orders go supplier-direct — never touch DC stock
      if (o.isBulk && dcShare < 1 && orderHash01(o.id) >= dcShare) {
        counts.bulk.supplierRouted += 1;
        continue;
      }
      let short = false;
      for (const { sku, qty } of o.lines) {
        if (!plan[sku]) continue; // not in plan
        if (o.isBulk) {
          const avail = dcStock[sku];
          if (avail < qty) {
            short = true;
            oosEvents.push({ type: 'bulk', orderId: o.id, date, ds: o.ds, sku, short: qty - Math.max(0, avail) });
          }
          if (!infiniteDC) dcStock[sku] = Math.max(0, avail - qty);
        } else {
          const avail = dsStock[sku][o.ds] ?? 0;
          if (avail < qty) {
            short = true;
            oosEvents.push({ type: 'regular', orderId: o.id, date, ds: o.ds, sku, short: qty - avail });
          }
          dsStock[sku][o.ds] = Math.max(0, avail - qty);
        }
      }
      if (o.isBulk) {
        counts.bulk.total += 1;
        if (short) counts.bulk.oos += 1;
      } else {
        counts.regular.total += 1;
        if (!counts.regular.perDS[o.ds]) counts.regular.perDS[o.ds] = { total: 0, oos: 0 };
        counts.regular.perDS[o.ds].total += 1;
        if (short) { counts.regular.oos += 1; counts.regular.perDS[o.ds].oos += 1; }
      }
    }

    // 3) Closing: DS → TO, DC → PO
    const nd = windowDates[i + 1];
    for (const sku of skus) {
      for (const [ds, p] of Object.entries(plan[sku])) {
        const s = dsStock[sku][ds];
        if (s <= p.min && p.max > s && nd) {
          if (!pendingTO[nd]) pendingTO[nd] = [];
          pendingTO[nd].push({ sku, ds, qty: p.max - s });
          opsLoad.toLines += 1;
        }
      }
      if (!infiniteDC && dcPlan?.[sku]) {
        const { min, max } = dcPlan[sku];
        const position = dcStock[sku] + dcOnOrder[sku];
        if (position <= min && max > position) {
          const qty = max - position;
          const arrive = windowDates[i + leadDays];
          if (arrive) {
            if (!pendingPO[arrive]) pendingPO[arrive] = [];
            pendingPO[arrive].push({ sku, qty });
            dcOnOrder[sku] += qty;
            opsLoad.poLines += 1;
          }
        }
      }
      if (!dcStockByDate[sku]) dcStockByDate[sku] = {};
      dcStockByDate[sku][date] = infiniteDC ? Infinity : dcStock[sku];
    }
  });

  const serviceLevels = {
    regular: {
      overall: counts.regular.total ? 1 - counts.regular.oos / counts.regular.total : 1,
      perDS: Object.fromEntries(Object.entries(counts.regular.perDS).map(([ds, c]) =>
        [ds, { total: c.total, oos: c.oos, service: c.total ? 1 - c.oos / c.total : 1 }])),
      total: counts.regular.total, oos: counts.regular.oos,
    },
    bulk: {
      overall: counts.bulk.total ? 1 - counts.bulk.oos / counts.bulk.total : 1,
      total: counts.bulk.total, oos: counts.bulk.oos,
      supplierRouted: counts.bulk.supplierRouted,
    },
    toFill: {
      lineRate: toFill.lines ? toFill.fullLines / toFill.lines : 1,
      qtyRate: toFill.qtyRequested ? toFill.qtyShipped / toFill.qtyRequested : 1,
      lines: toFill.lines, fullLines: toFill.fullLines,
      qtyShort: toFill.qtyRequested - toFill.qtyShipped,
    },
  };
  return { toDrain, oosEvents, serviceLevels, opsLoad, dcStockByDate };
}
