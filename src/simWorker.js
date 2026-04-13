function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function runSim(invoiceData, results, overrides, simDates) {
  const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];
  if (!invoiceData.length || !results || !simDates.length) return [];
  const simDateSet = new Set(simDates);
  const simIndex = {};
  invoiceData.forEach(r => {
    if (!simDateSet.has(r.date)) return;
    const k = `${r.sku}||${r.ds}`;
    if (!simIndex[k]) simIndex[k] = [];
    simIndex[k].push(r);
  });
  const out = [];
  Object.entries(results).forEach(([skuId, res]) => {
    DS_LIST.forEach(dsId => {
      const toolMin = res.stores[dsId]?.min || 0;
      const toolMax = res.stores[dsId]?.max || 0;
      if (!toolMax) return;
      const ov = overrides[skuId]?.[dsId];
      const useMin = (ov?.min !== null && ov?.min !== undefined) ? ov.min : toolMin;
      const useMax = (ov?.max !== null && ov?.max !== undefined) ? ov.max : toolMax;
      const isOverridden = ov !== undefined && (ov.min !== null || ov.max !== null);
      const simLines = simIndex[`${skuId}||${dsId}`] || [];
      let stock = useMax, oosInstances = 0;
      const shortQtys = [], orderLog = [];
      simDates.forEach(date => {
        const dayLines = simLines.filter(l => l.date === date);
        dayLines.forEach((line, li) => {
          const stockBefore = stock;
          const fulfilled = Math.min(line.qty, stock);
          const shortQty = line.qty - fulfilled;
          const oos = shortQty > 0;
          if (oos) { oosInstances++; shortQtys.push(shortQty); }
          stock = Math.max(0, stock - line.qty);
          const isLastOfDay = li === dayLines.length - 1;
          const replenished = isLastOfDay && stock <= useMin;
          orderLog.push({ date: line.date, qty: line.qty, stockBefore, fulfilled, shortQty, oos, stockAfter: stock, replenished });
          if (replenished) stock = useMax;
        });
      });
      if (oosInstances > 0 || isOverridden) {
        out.push({
          skuId, dsId,
          name: res.meta.name || skuId,
          category: res.meta.category || "Unknown",
          brand: res.meta.brand || "Unknown",
          priceTag: res.meta.priceTag || "—",
          mvTag: res.stores[dsId]?.mvTag || "—",
          toolMin, toolMax, useMin, useMax, isOverridden,
          oosInstances,
          totalInstances: simLines.length,
          medianShort: Math.ceil(median(shortQtys)),
          maxShort: shortQtys.length ? Math.max(...shortQtys) : 0,
          orderLog,
        });
      }
    });
  });
  out.sort((a, b) => b.oosInstances - a.oosInstances);
  return out;
}

// Root cause priority: Unstocked → Could Have Been Saved → Ops Failure → Tool Failure
function classifyRootCause(openingStock, toolMin, orderQty, physical, inTransit) {
  if (toolMin === 0 && openingStock === 0) return "unstocked";
  if (physical + inTransit >= orderQty) return "could_have_saved";
  if (openingStock <= toolMin) return "ops_failure";
  return "tool_failure";
}

function runActualStockSim(invoiceData, results, openingStock, singleDate) {
  // openingStock: { DS01: { SKU1: { physical, inTransit }, ... }, ... }
  const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];
  if (!invoiceData.length || !results) return [];
  if (!singleDate) return [];
  const dayLines = invoiceData.filter(r => r.date === singleDate);
  const simIndex = {};
  dayLines.forEach(r => {
    const k = `${r.sku}||${r.ds}`;
    if (!simIndex[k]) simIndex[k] = [];
    simIndex[k].push(r);
  });
  const out = [];
  Object.entries(results).forEach(([skuId, res]) => {
    DS_LIST.forEach(dsId => {
      const toolMin = res.stores[dsId]?.min || 0;
      const toolMax = res.stores[dsId]?.max || 0;
      const dsStock = openingStock[dsId] || {};
      const stockEntry = dsStock[skuId] || { physical: 0, inTransit: 0 };
      const { physical, inTransit } = stockEntry;
      let stock = physical;
      const lines = simIndex[`${skuId}||${dsId}`] || [];
      if (!lines.length) return;
      let oosInstances = 0;
      const shortQtys = [], orderLog = [];
      lines.forEach(line => {
        const stockBefore = stock;
        const fulfilled = Math.min(line.qty, stock);
        const shortQty = line.qty - fulfilled;
        const oos = shortQty > 0;
        if (oos) {
          oosInstances++;
          shortQtys.push(shortQty);
        }
        stock = Math.max(0, stock - line.qty);
        const rootCause = oos ? classifyRootCause(physical, toolMin, line.qty, physical, inTransit) : null;
        orderLog.push({ date: line.date, qty: line.qty, stockBefore, fulfilled, shortQty, oos, stockAfter: stock, rootCause });
      });
      if (oosInstances > 0) {
        const firstOosLine = orderLog.find(l => l.oos);
        out.push({
          skuId, dsId,
          name: res.meta.name || skuId,
          category: res.meta.category || "Unknown",
          brand: res.meta.brand || "Unknown",
          priceTag: res.meta.priceTag || "—",
          mvTag: res.stores[dsId]?.mvTag || "—",
          toolMin, toolMax,
          openingStock: physical,
          inTransit,
          oosInstances,
          totalInstances: lines.length,
          medianShort: Math.ceil(median(shortQtys)),
          maxShort: shortQtys.length ? Math.max(...shortQtys) : 0,
          rootCause: firstOosLine?.rootCause || "tool_failure",
          orderLog,
        });
      }
    });
  });
  out.sort((a, b) => b.oosInstances - a.oosInstances);
  return out;
}

self.onmessage = ({ data }) => {
  if (data.type === "actual") {
    const { invoiceData, results, openingStock, singleDate } = data;
    const actual = runActualStockSim(invoiceData, results, openingStock, singleDate);
    self.postMessage({ actual });
    return;
  }
  // Default: ideal restock (loaded data or fresh CSV)
  const { invoiceData, results, overrides, simDates } = data;
  const tool = runSim(invoiceData, results, {}, simDates);
  const ovr  = runSim(invoiceData, results, overrides || {}, simDates);
  self.postMessage({ tool, ovr });
};
