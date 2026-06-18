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
  const captureLines = !!cfg.captureLines;   // record every line's outcome (served + short) — for the OOS sim table
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
  const lineEvents = [];         // (captureLines) every order line: served + short, with on-hand
  const counts = { regular: { total: 0, oos: 0, perDS: {} }, bulk: { total: 0, oos: 0, supplierRouted: 0 } };
  const dcStockByDate = {};      // sku → date → closing qty (tests/UI)
  const opsLoad = { toLines: 0, poLines: 0 };

  windowDates.forEach((date, i) => {
    // 1) Arrivals — TOs raised yesterday land today. When the DC is short, ship
    //    PROPORTIONALLY across the competing DS requests for that SKU (largest-remainder
    //    rounding, bigger requester gets the leftover sheet) — matches ops, and removes the
    //    first-come bias. Total shipped = min(stock, Σrequests) regardless, so qty-fill is unchanged.
    const toBySku = {};
    for (const t of pendingTO[date] || []) (toBySku[t.sku] ??= []).push(t);
    for (const [sku, group] of Object.entries(toBySku)) {
      const reqTotal = group.reduce((a, t) => a + t.qty, 0);
      const avail = infiniteDC ? reqTotal : dcStock[sku];
      let shipped;
      if (avail >= reqTotal) {
        shipped = group.map(t => t.qty);
      } else {
        const raw = group.map(t => (avail * t.qty) / reqTotal);
        shipped = raw.map(Math.floor);
        let rem = avail - shipped.reduce((a, b) => a + b, 0);
        // hand out the remainder by largest fractional part, ties to the larger request
        const order = group.map((_, idx) => idx).sort((x, y) =>
          (raw[y] - shipped[y]) - (raw[x] - shipped[x]) || group[y].qty - group[x].qty);
        for (let k = 0; k < rem; k++) shipped[order[k]] += 1;
      }
      let shippedTotal = 0;
      group.forEach((t, idx) => {
        const ship = shipped[idx];
        dsStock[t.sku][t.ds] += ship;
        if (!toDrain[t.sku]) toDrain[t.sku] = {};
        toDrain[t.sku][date] = (toDrain[t.sku][date] || 0) + t.qty;
        toFill.lines += 1;
        if (ship >= t.qty) toFill.fullLines += 1;
        toFill.qtyRequested += t.qty;
        toFill.qtyShipped += ship;
        shippedTotal += ship;
      });
      if (!infiniteDC) dcStock[sku] -= shippedTotal;
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
            oosEvents.push({ type: 'bulk', orderId: o.id, date, ds: o.ds, sku, short: qty - Math.max(0, avail), qty, onHand: Math.max(0, avail) });
          }
          if (captureLines) lineEvents.push({ type: 'bulk', orderId: o.id, date, ds: o.ds, sku, qty, onHand: Math.max(0, avail), short: Math.max(0, qty - avail), served: avail >= qty });
          if (!infiniteDC) dcStock[sku] = Math.max(0, avail - qty);
        } else {
          const avail = dsStock[sku][o.ds] ?? 0;
          if (avail < qty) {
            short = true;
            oosEvents.push({ type: 'regular', orderId: o.id, date, ds: o.ds, sku, short: qty - avail, qty, onHand: avail });
          }
          if (captureLines) lineEvents.push({ type: 'regular', orderId: o.id, date, ds: o.ds, sku, qty, onHand: avail, short: Math.max(0, qty - avail), served: avail >= qty });
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
  return { toDrain, oosEvents, lineEvents, serviceLevels, opsLoad, dcStockByDate };
}
