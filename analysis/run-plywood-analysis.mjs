// Quick analysis script — fetches invoice data from Supabase and runs Plywood network analysis
const SUPABASE_URL = "https://rgyupnrogkbugsadwlye.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";

async function main() {
  console.log("Fetching team_data from Supabase...");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/team_data?id=eq.global&select=payload`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await res.json();
  if (!rows.length) { console.error("No data found"); return; }

  const { invoiceData, skuMaster } = rows[0].payload;
  console.log(`Loaded ${invoiceData.length} invoice rows, ${Object.keys(skuMaster).length} SKUs\n`);

  // Helpers
  const percentile = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const i = (p / 100) * (s.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const median = arr => percentile(arr, 50);
  const inferMM = name => { const m = name.match(/(\d+(?:\.\d+)?)\s*mm/i); return m ? parseFloat(m[1]) : null; };

  // Filter dates — L45D
  const allDates = [...new Set(invoiceData.map(r => r.date))].sort();
  const l45Dates = new Set(allDates.slice(-45));
  const l45Data = invoiceData.filter(r => l45Dates.has(r.date));

  // Plywood/MDF filter
  const plyCats = new Set();
  Object.values(skuMaster).forEach(s => {
    const c = (s.category || "").toLowerCase();
    if (c.includes("plywood") || c.includes("mdf") || c.includes("hdhmr")) plyCats.add(s.category);
  });
  console.log("Plywood categories found:", [...plyCats].join(", "));

  const isPly = sku => {
    const cat = (skuMaster[sku]?.category || "").toLowerCase();
    return cat.includes("plywood") || cat.includes("mdf") || cat.includes("hdhmr");
  };

  for (const ds of ["DS01", "DS02"]) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`  ${ds} — PLYWOOD NETWORK ANALYSIS (L45D)`);
    console.log(`${"=".repeat(70)}\n`);

    const dsRows = l45Data.filter(r => r.ds === ds);
    const plyRows = dsRows.filter(r => isPly(r.sku));

    // === BASKET ANALYSIS ===
    const orderMap = {};
    dsRows.forEach(r => {
      const order = r.shopifyOrder || r.invoiceNumber || "";
      if (!order) return;
      if (!orderMap[order]) orderMap[order] = [];
      orderMap[order].push(r);
    });

    let totalOrders = Object.keys(orderMap).length;
    let plyOrders = 0, plyOnly = 0, plyFevicol = 0, plyOther = 0;
    Object.values(orderMap).forEach(lines => {
      const hasPly = lines.some(l => isPly(l.sku));
      if (!hasPly) return;
      plyOrders++;
      const otherCats = new Set(lines.filter(l => !isPly(l.sku)).map(l => skuMaster[l.sku]?.category || "").filter(Boolean));
      if (otherCats.size === 0) plyOnly++;
      else {
        const hasFev = [...otherCats].some(c => c.toLowerCase().includes("fevicol") || c.toLowerCase().includes("adhesive"));
        const nonFev = [...otherCats].filter(c => !c.toLowerCase().includes("fevicol") && !c.toLowerCase().includes("adhesive"));
        if (hasFev && nonFev.length === 0) plyFevicol++;
        else plyOther++;
      }
    });

    console.log("── BASKET COMPOSITION ──");
    console.log(`Total orders: ${totalOrders}`);
    console.log(`Plywood orders: ${plyOrders} (${(plyOrders/totalOrders*100).toFixed(1)}%)`);
    console.log(`  Primary only: ${plyOnly} (${(plyOnly/plyOrders*100).toFixed(1)}%)`);
    console.log(`  + Fevicol:    ${plyFevicol} (${(plyFevicol/plyOrders*100).toFixed(1)}%)`);
    console.log(`  + Others:     ${plyOther} (${(plyOther/plyOrders*100).toFixed(1)}%)`);

    // === SKU PROFILING ===
    const skuMap = {};
    plyRows.forEach(r => {
      if (!skuMap[r.sku]) skuMap[r.sku] = { sku: r.sku, dates: new Set(), qtys: [], orders: new Set() };
      skuMap[r.sku].dates.add(r.date);
      skuMap[r.sku].qtys.push(r.qty);
      const order = r.shopifyOrder || r.invoiceNumber || "";
      if (order) skuMap[r.sku].orders.add(order);
    });

    const skuList = Object.values(skuMap).map(s => {
      const name = skuMaster[s.sku]?.name || s.sku;
      const mm = inferMM(name);
      const abq = +(s.qtys.reduce((a,b)=>a+b,0) / s.qtys.length).toFixed(1);
      const cat = mm === null ? "Unknown" : mm <= 1 ? "Laminate" : mm <= 6 ? "Thin" : "Thick";
      return {
        sku: s.sku, name, mm, cat,
        nzd: s.dates.size,
        orders: s.orders.size,
        abq,
        medianQty: Math.ceil(median(s.qtys)),
        p75: Math.ceil(percentile(s.qtys, 75)),
        p90: Math.ceil(percentile(s.qtys, 90)),
        maxQty: Math.max(...s.qtys),
      };
    }).sort((a, b) => b.nzd - a.nzd);

    console.log(`\n── SKU PROFILE (${skuList.length} SKUs) ──`);
    console.log(`${"SKU".padEnd(30)} ${"Name".padEnd(35)} ${"mm".padStart(5)} ${"Cat".padEnd(8)} ${"NZD".padStart(4)} ${"Ord".padStart(4)} ${"ABQ".padStart(5)} ${"Med".padStart(4)} ${"P75".padStart(4)} ${"P90".padStart(4)} ${"Max".padStart(4)}`);
    console.log("-".repeat(140));
    skuList.forEach(s => {
      console.log(`${s.sku.padEnd(30)} ${s.name.slice(0,34).padEnd(35)} ${(s.mm !== null ? s.mm+"mm" : "?").padStart(5)} ${s.cat.padEnd(8)} ${String(s.nzd).padStart(4)} ${String(s.orders).padStart(4)} ${String(s.abq).padStart(5)} ${String(s.medianQty).padStart(4)} ${String(s.p75).padStart(4)} ${String(s.p90).padStart(4)} ${String(s.maxQty).padStart(4)}`);
    });

    // === PROPOSE THRESHOLDS ===
    // Find natural breaks in NZD distribution
    const nzdValues = skuList.map(s => s.nzd).sort((a,b) => b-a);
    const nzdP75 = Math.ceil(percentile(nzdValues, 75));
    const nzdP50 = Math.ceil(percentile(nzdValues, 50));
    const nzdP25 = Math.ceil(percentile(nzdValues, 25));

    // NZD distribution
    console.log("\n── NZD DISTRIBUTION ──");
    const nzdBuckets = {};
    skuList.forEach(s => {
      const bucket = s.nzd >= 10 ? "10+" : s.nzd >= 6 ? "6-9" : s.nzd >= 3 ? "3-5" : s.nzd >= 1 ? "1-2" : "0";
      nzdBuckets[bucket] = (nzdBuckets[bucket] || 0) + 1;
    });
    ["10+", "6-9", "3-5", "1-2"].forEach(b => {
      console.log(`  NZD ${b.padEnd(4)}: ${(nzdBuckets[b]||0)} SKUs`);
    });

    // Tier 1 analysis with different thresholds
    console.log("\n── TIER THRESHOLD ANALYSIS ──");
    for (const t1 of [3, 4, 5, 6, 8, 10]) {
      const t1skus = skuList.filter(s => s.nzd >= t1 && s.cat !== "Laminate");
      const thin = t1skus.filter(s => s.cat === "Thin");
      const thick = t1skus.filter(s => s.cat === "Thick");
      const thinStock3 = thin.reduce((s,x) => s + Math.ceil(x.abq * 3 * 1.2), 0);
      const thickStock3 = thick.reduce((s,x) => s + Math.ceil(x.abq * 3 * 1.2), 0);
      const fits = thinStock3 <= 60 && thickStock3 <= 150;
      console.log(`  NZD ≥ ${String(t1).padEnd(2)}: ${t1skus.length} SKUs (${thin.length} thin/${thick.length} thick) | Thin: ${thinStock3}/60 | Thick: ${thickStock3}/150 | ${fits ? "✅ FITS" : "❌ OVER"}`);
    }

    // === PROPOSED MIN/MAX ===
    // Use best-fit threshold
    let bestThreshold = 3;
    for (const t1 of [3, 4, 5, 6, 8, 10]) {
      const t1skus = skuList.filter(s => s.nzd >= t1 && s.cat !== "Laminate");
      const thin = t1skus.filter(s => s.cat === "Thin");
      const thick = t1skus.filter(s => s.cat === "Thick");
      const thinStock = thin.reduce((s,x) => s + Math.ceil(x.abq * 3 * 1.2), 0);
      const thickStock = thick.reduce((s,x) => s + Math.ceil(x.abq * 3 * 1.2), 0);
      if (thinStock <= 60 && thickStock <= 150) { bestThreshold = t1; break; }
    }

    const tier1 = skuList.filter(s => s.nzd >= bestThreshold && s.cat !== "Laminate");
    console.log(`\n── PROPOSED STOCKING: Tier 1 NZD ≥ ${bestThreshold}, Cover 3D + 20% buffer ──`);
    console.log(`${"SKU".padEnd(30)} ${"Name".padEnd(30)} ${"Cat".padEnd(8)} ${"NZD".padStart(4)} ${"ABQ".padStart(5)} ${"Min".padStart(5)} ${"Max".padStart(5)} ${"Threshold".padStart(10)}`);
    console.log("-".repeat(110));

    tier1.forEach(s => {
      const stockQty = Math.ceil(s.abq * 3 * 1.2); // 3 days + 20% buffer
      const minQty = Math.ceil(s.abq * 1.5); // 1.5 days = reorder trigger
      const maxQty = stockQty; // Max = full stock target
      const threshold = s.p75; // Orders above P75 → fallback
      console.log(`${s.sku.padEnd(30)} ${s.name.slice(0,29).padEnd(30)} ${s.cat.padEnd(8)} ${String(s.nzd).padStart(4)} ${String(s.abq).padStart(5)} ${String(minQty).padStart(5)} ${String(maxQty).padStart(5)} ${(">"+threshold).padStart(10)}`);
    });

    const tier1Thin = tier1.filter(s => s.cat === "Thin");
    const tier1Thick = tier1.filter(s => s.cat === "Thick");
    console.log(`\n  Thin:  ${tier1Thin.reduce((s,x)=>s+Math.ceil(x.abq*3*1.2),0)} / 60 capacity`);
    console.log(`  Thick: ${tier1Thick.reduce((s,x)=>s+Math.ceil(x.abq*3*1.2),0)} / 150 capacity`);
  }

  // === DS01 vs DS02 COMPARISON ===
  console.log(`\n${"=".repeat(70)}`);
  console.log("  DS01 vs DS02 — SHOULD THEY STOCK THE SAME SKUS?");
  console.log(`${"=".repeat(70)}\n`);

  const ds01Skus = new Set();
  const ds02Skus = new Set();
  const skuNZD = { DS01: {}, DS02: {} };

  l45Data.forEach(r => {
    if (!isPly(r.sku)) return;
    if (r.ds === "DS01") {
      ds01Skus.add(r.sku);
      if (!skuNZD.DS01[r.sku]) skuNZD.DS01[r.sku] = new Set();
      skuNZD.DS01[r.sku].add(r.date);
    }
    if (r.ds === "DS02") {
      ds02Skus.add(r.sku);
      if (!skuNZD.DS02[r.sku]) skuNZD.DS02[r.sku] = new Set();
      skuNZD.DS02[r.sku].add(r.date);
    }
  });

  const both = [...ds01Skus].filter(s => ds02Skus.has(s));
  const ds01Only = [...ds01Skus].filter(s => !ds02Skus.has(s));
  const ds02Only = [...ds02Skus].filter(s => !ds01Skus.has(s));

  console.log(`DS01 Plywood SKUs: ${ds01Skus.size}`);
  console.log(`DS02 Plywood SKUs: ${ds02Skus.size}`);
  console.log(`Sold at both:      ${both.length}`);
  console.log(`DS01 only:         ${ds01Only.length}`);
  console.log(`DS02 only:         ${ds02Only.length}`);

  // Compare NZD for shared SKUs
  console.log(`\n── Top shared SKUs — NZD comparison ──`);
  console.log(`${"SKU".padEnd(30)} ${"Name".padEnd(30)} ${"DS01 NZD".padStart(9)} ${"DS02 NZD".padStart(9)} ${"Diff".padStart(6)}`);
  console.log("-".repeat(90));
  both
    .map(sku => ({
      sku, name: (skuMaster[sku]?.name || sku).slice(0, 29),
      nzd1: skuNZD.DS01[sku]?.size || 0,
      nzd2: skuNZD.DS02[sku]?.size || 0,
    }))
    .sort((a, b) => (b.nzd1 + b.nzd2) - (a.nzd1 + a.nzd2))
    .slice(0, 20)
    .forEach(s => {
      console.log(`${s.sku.padEnd(30)} ${s.name.padEnd(30)} ${String(s.nzd1).padStart(9)} ${String(s.nzd2).padStart(9)} ${String(Math.abs(s.nzd1-s.nzd2)).padStart(6)}`);
    });
}

main().catch(console.error);
