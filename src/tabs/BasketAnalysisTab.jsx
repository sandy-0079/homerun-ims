import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from "recharts";

const HR = {
  yellow:"#F5C400",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",
};
const S = {
  card:{background:HR.surface,borderRadius:8,padding:12,border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  btn:(on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,transition:"all 0.15s",whiteSpace:"nowrap",outline:"none"}),
  input:{background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"5px 10px",color:HR.text,fontSize:12},
};

const BA_PERIODS = [
  { key:"L45D",label:"L45D",days:45 },
  { key:"L30D",label:"L30D",days:30 },
  { key:"L15D",label:"L15D",days:15 },
  { key:"L7D", label:"L7D", days:7  },
  { key:"L3D", label:"L3D", days:3  },
  { key:"CUSTOM",label:"Custom" },
];

const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];
const DONUT_COLORS = ["#16a34a","#F5C400","#C05A00"];

function filterByPeriod(invoiceData, periodKey, dateFrom, dateTo, invoiceDateRange) {
  if (!invoiceData?.length) return [];
  const allDates = invoiceDateRange.dates;
  if (periodKey === "CUSTOM" && dateFrom && dateTo)
    return invoiceData.filter(r => r.date >= dateFrom && r.date <= dateTo);
  const preset = BA_PERIODS.find(p => p.key === periodKey);
  if (preset?.days) {
    const last = allDates.slice(-preset.days);
    return invoiceData.filter(r => last.includes(r.date));
  }
  return [];
}

function computeBaskets(rows, skuMaster, primaryCats, secondaryCats) {
  const isPrimary = cat => primaryCats.has(cat);
  const isSecondary = cat => secondaryCats.has(cat);

  const orderMap = {};
  rows.forEach(r => {
    const orderId = r.shopifyOrder || `${r.sku}__${r.date}`;
    if (!orderMap[orderId]) orderMap[orderId] = new Set();
    const cat = skuMaster[r.sku]?.category || "";
    if (cat) orderMap[orderId].add(cat);
  });

  let totalOrders = 0, primaryOrders = 0, primaryOnlyOrders = 0;
  let primarySecondaryOrders = 0, primaryOtherOrders = 0;
  const coCatCounts = {};

  Object.values(orderMap).forEach(cats => {
    totalOrders++;
    const allCats = [...cats];
    if (!allCats.some(isPrimary)) return;
    primaryOrders++;
    const nonPrimary = allCats.filter(c => !isPrimary(c));
    if (nonPrimary.length === 0) { primaryOnlyOrders++; return; }
    if (nonPrimary.every(isSecondary)) { primarySecondaryOrders++; }
    else { primaryOtherOrders++; }
    nonPrimary.forEach(c => { coCatCounts[c] = (coCatCounts[c] || 0) + 1; });
  });

  return { totalOrders, primaryOrders, primaryOnlyOrders, primarySecondaryOrders, primaryOtherOrders, coCatCounts };
}

function computeBrandDSDistribution(rows, skuMaster, selectedCategory) {
  // For each brand in the category: count unique orders per DS
  const brandDS = {}; // brand → ds → Set(orderId)
  rows.forEach(r => {
    if (skuMaster[r.sku]?.category !== selectedCategory) return;
    const brand = skuMaster[r.sku]?.brand;
    if (!brand) return;
    const orderId = r.shopifyOrder || `${r.sku}__${r.date}`;
    if (!brandDS[brand]) brandDS[brand] = {};
    if (!brandDS[brand][r.ds]) brandDS[brand][r.ds] = new Set();
    brandDS[brand][r.ds].add(orderId);
  });
  return Object.entries(brandDS).map(([brand, dsCounts]) => {
    const counts = {};
    let total = 0;
    DS_LIST.forEach(ds => { counts[ds] = dsCounts[ds]?.size || 0; total += counts[ds]; });
    const pcts = {};
    DS_LIST.forEach(ds => { pcts[ds] = total > 0 ? Math.round((counts[ds] / total) * 100) : 0; });
    return { brand, total, counts, pcts };
  }).sort((a, b) => b.total - a.total);
}

function computeBrandBaskets(rows, skuMaster, selectedCategory, primaryBrands, secondaryBrands, excludedBrands = new Set()) {
  const isPrimary = b => primaryBrands.has(b);
  const isSecondary = b => secondaryBrands.has(b);

  // Filter to selected category only; skip excluded brands entirely
  const orderMap = {};
  rows.forEach(r => {
    if (skuMaster[r.sku]?.category !== selectedCategory) return;
    const brand = skuMaster[r.sku]?.brand || "";
    if (!brand || excludedBrands.has(brand)) return;
    const orderId = r.shopifyOrder || `${r.sku}__${r.date}`;
    if (!orderMap[orderId]) orderMap[orderId] = new Set();
    orderMap[orderId].add(brand);
  });

  let totalOrders = 0, primaryOrders = 0, primaryOnlyOrders = 0;
  let primarySecondaryOrders = 0, primaryOtherOrders = 0;
  const coBrandCounts = {};

  Object.values(orderMap).forEach(brands => {
    totalOrders++;
    const allBrands = [...brands];
    if (!allBrands.some(isPrimary)) return;
    primaryOrders++;
    const nonPrimary = allBrands.filter(b => !isPrimary(b));
    if (nonPrimary.length === 0) { primaryOnlyOrders++; return; }
    if (nonPrimary.every(isSecondary)) { primarySecondaryOrders++; }
    else { primaryOtherOrders++; }
    nonPrimary.forEach(b => { coBrandCounts[b] = (coBrandCounts[b] || 0) + 1; });
  });

  return { totalOrders, primaryOrders, primaryOnlyOrders, primarySecondaryOrders, primaryOtherOrders, coBrandCounts };
}

export default function BasketAnalysisTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin }) {
  const [period, setPeriod] = useState(() => localStorage.getItem("hrBasketPeriod") || "L45D");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dsFilter, setDsFilter] = useState(() => localStorage.getItem("hrBasketDS") || "All");
  const [primaryCats, setPrimaryCats] = useState(() => {
    try { const s = localStorage.getItem("hrBasketPrimary"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [secondaryCats, setSecondaryCats] = useState(() => {
    try { const s = localStorage.getItem("hrBasketSecondary"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [results, setResults] = useState(null);
  const [cachedResults, setCachedResults] = useState(null);
  const autoRanRef = useRef(false);

  // ── Brand Basket state ────────────────────────────────────────────────────
  const [brandCategory, setBrandCategory] = useState(() => localStorage.getItem("hrBrandCat") || "");
  const [brandPrimary, setBrandPrimary] = useState(() => {
    try { const s = localStorage.getItem("hrBrandPrimary"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [brandSecondary, setBrandSecondary] = useState(() => {
    try { const s = localStorage.getItem("hrBrandSecondary"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [brandPeriod, setBrandPeriod] = useState(() => localStorage.getItem("hrBrandPeriod") || "L45D");
  const [brandDateFrom, setBrandDateFrom] = useState("");
  const [brandDateTo, setBrandDateTo] = useState("");
  const [brandDsFilter, setBrandDsFilter] = useState(() => localStorage.getItem("hrBrandDS") || "All");
  const [brandResults, setBrandResults] = useState(null);
  const [brandCachedResults, setBrandCachedResults] = useState(null);
  const [brandExcluded, setBrandExcluded] = useState(new Set()); // excluded brands per category
  const brandAutoRanRef = useRef(false);

  const hasShopifyOrder = useMemo(() => invoiceData.some(r => r.shopifyOrder), [invoiceData]);
  const allCategories = useMemo(() =>
    [...new Set(Object.values(skuMaster).map(s => s.category).filter(Boolean))].sort(),
    [skuMaster]);

  const primaryLabel = primaryCats.size > 0 ? [...primaryCats].join(" + ") : "Primary";
  const secondaryLabel = secondaryCats.size > 0 ? [...secondaryCats].join(" + ") : "Secondary";

  const canRun = primaryCats.size > 0
    && invoiceData.length > 0
    && hasShopifyOrder
    && (period !== "CUSTOM" || (dateFrom && dateTo));

  // Button active only when results don't yet exist for the current period+DS combination
  const resultsUpToDate = !!(cachedResults?.[period]?.[dsFilter]);
  const runActive = canRun && !resultsUpToDate;

  const handleRun = useCallback(() => {
    const cache = {};
    // Pre-compute all preset periods × all DSes so period switching is instant
    BA_PERIODS.filter(p => p.days).forEach(preset => {
      const periodRows = filterByPeriod(invoiceData, preset.key, "", "", invoiceDateRange);
      cache[preset.key] = {};
      ["All", ...DS_LIST].forEach(ds => {
        const dsRows = ds === "All"
          ? periodRows.filter(r => DS_LIST.includes(r.ds))
          : periodRows.filter(r => r.ds === ds);
        cache[preset.key][ds] = computeBaskets(dsRows, skuMaster, primaryCats, secondaryCats);
      });
    });
    // Also compute custom period if active
    if (period === "CUSTOM" && dateFrom && dateTo) {
      const periodRows = filterByPeriod(invoiceData, "CUSTOM", dateFrom, dateTo, invoiceDateRange);
      cache["CUSTOM"] = {};
      ["All", ...DS_LIST].forEach(ds => {
        const dsRows = ds === "All"
          ? periodRows.filter(r => DS_LIST.includes(r.ds))
          : periodRows.filter(r => r.ds === ds);
        cache["CUSTOM"][ds] = computeBaskets(dsRows, skuMaster, primaryCats, secondaryCats);
      });
    }
    setCachedResults(cache);
    setResults(cache[period]?.[dsFilter] || null);
  }, [invoiceData, skuMaster, period, dateFrom, dateTo, dsFilter, primaryCats, secondaryCats, invoiceDateRange]);

  const toggleCat = (cat) => {
    const isPrimary = primaryCats.has(cat);
    const isSecondary = secondaryCats.has(cat);
    if (!isPrimary && !isSecondary) {
      // none → Primary
      setPrimaryCats(prev => { const n = new Set(prev); n.add(cat); return n; });
    } else if (isPrimary) {
      // Primary → Secondary
      setPrimaryCats(prev => { const n = new Set(prev); n.delete(cat); return n; });
      setSecondaryCats(prev => { const n = new Set(prev); n.add(cat); return n; });
    } else {
      // Secondary → none
      setSecondaryCats(prev => { const n = new Set(prev); n.delete(cat); return n; });
    }
    setResults(null);
    setCachedResults(null);
  };

  useEffect(() => {
    if (cachedResults) {
      setResults(cachedResults[period]?.[dsFilter] || null);
    }
  }, [dsFilter, period, cachedResults]);

  // ── Brand Basket derived values ───────────────────────────────────────────
  // Load exclusions from localStorage when category changes
  useEffect(() => {
    if (!brandCategory) { setBrandExcluded(new Set()); return; }
    try {
      const s = localStorage.getItem(`hrBrandExclude_${brandCategory}`);
      setBrandExcluded(s ? new Set(JSON.parse(s)) : new Set());
    } catch { setBrandExcluded(new Set()); }
  }, [brandCategory]);

  // Persist exclusions per category
  useEffect(() => {
    if (!brandCategory) return;
    localStorage.setItem(`hrBrandExclude_${brandCategory}`, JSON.stringify([...brandExcluded]));
  }, [brandExcluded, brandCategory]);

  const brandsInCategory = useMemo(() => {
    if (!brandCategory) return [];
    return [...new Set(Object.values(skuMaster)
      .filter(s => s.category === brandCategory && s.brand && !brandExcluded.has(s.brand))
      .map(s => s.brand))].sort();
  }, [skuMaster, brandCategory, brandExcluded]);

  const excludedBrandsList = useMemo(() => {
    if (!brandCategory) return [];
    return [...new Set(Object.values(skuMaster)
      .filter(s => s.category === brandCategory && s.brand && brandExcluded.has(s.brand))
      .map(s => s.brand))].sort();
  }, [skuMaster, brandCategory, brandExcluded]);

  const excludeBrand = (brand) => {
    setBrandPrimary(prev => { const n = new Set(prev); n.delete(brand); return n; });
    setBrandSecondary(prev => { const n = new Set(prev); n.delete(brand); return n; });
    setBrandExcluded(prev => { const n = new Set(prev); n.add(brand); return n; });
    setBrandResults(null); setBrandCachedResults(null);
    brandAutoRanRef.current = false; // allow auto-run to re-fire with updated exclusions
  };

  const restoreBrand = (brand) => {
    setBrandExcluded(prev => { const n = new Set(prev); n.delete(brand); return n; });
    setBrandResults(null); setBrandCachedResults(null);
    brandAutoRanRef.current = false;
  };

  const brandDSDistribution = useMemo(() => {
    if (!brandCategory || !invoiceData.length) return [];
    const periodRows = filterByPeriod(invoiceData, brandPeriod, brandDateFrom, brandDateTo, invoiceDateRange);
    const allDSRows = periodRows.filter(r => DS_LIST.includes(r.ds));
    return computeBrandDSDistribution(allDSRows, skuMaster, brandCategory).filter(r => !brandExcluded.has(r.brand));
  }, [invoiceData, skuMaster, brandCategory, brandPeriod, brandDateFrom, brandDateTo, invoiceDateRange, brandExcluded]);

  const brandPrimaryLabel = brandPrimary.size > 0 ? [...brandPrimary].join(" + ") : "Primary Brand";
  const brandSecondaryLabel = brandSecondary.size > 0 ? [...brandSecondary].join(" + ") : "Secondary Brand";

  const canBrandRun = brandCategory && brandPrimary.size > 0 && invoiceData.length > 0 && hasShopifyOrder
    && (brandPeriod !== "CUSTOM" || (brandDateFrom && brandDateTo));
  const brandResultsUpToDate = !!(brandCachedResults?.[brandPeriod]?.[brandDsFilter]);
  const brandRunActive = canBrandRun && !brandResultsUpToDate;

  const handleBrandRun = useCallback(() => {
    const cache = {};
    BA_PERIODS.filter(p => p.days).forEach(preset => {
      const periodRows = filterByPeriod(invoiceData, preset.key, "", "", invoiceDateRange);
      cache[preset.key] = {};
      ["All", ...DS_LIST].forEach(ds => {
        const dsRows = ds === "All" ? periodRows.filter(r => DS_LIST.includes(r.ds)) : periodRows.filter(r => r.ds === ds);
        cache[preset.key][ds] = computeBrandBaskets(dsRows, skuMaster, brandCategory, brandPrimary, brandSecondary, brandExcluded);
      });
    });
    if (brandPeriod === "CUSTOM" && brandDateFrom && brandDateTo) {
      const periodRows = filterByPeriod(invoiceData, "CUSTOM", brandDateFrom, brandDateTo, invoiceDateRange);
      cache["CUSTOM"] = {};
      ["All", ...DS_LIST].forEach(ds => {
        const dsRows = ds === "All" ? periodRows.filter(r => DS_LIST.includes(r.ds)) : periodRows.filter(r => r.ds === ds);
        cache["CUSTOM"][ds] = computeBrandBaskets(dsRows, skuMaster, brandCategory, brandPrimary, brandSecondary, brandExcluded);
      });
    }
    setBrandCachedResults(cache);
    setBrandResults(cache[brandPeriod]?.[brandDsFilter] || null);
  }, [invoiceData, skuMaster, brandCategory, brandPrimary, brandSecondary, brandExcluded, brandPeriod, brandDateFrom, brandDateTo, brandDsFilter, invoiceDateRange]);

  const toggleBrand = (brand) => {
    const isPrim = brandPrimary.has(brand);
    const isSec = brandSecondary.has(brand);
    if (!isPrim && !isSec) {
      setBrandPrimary(prev => { const n = new Set(prev); n.add(brand); return n; });
    } else if (isPrim) {
      setBrandPrimary(prev => { const n = new Set(prev); n.delete(brand); return n; });
      setBrandSecondary(prev => { const n = new Set(prev); n.add(brand); return n; });
    } else {
      setBrandSecondary(prev => { const n = new Set(prev); n.delete(brand); return n; });
    }
    setBrandResults(null); setBrandCachedResults(null);
  };

  useEffect(() => {
    if (brandCachedResults) setBrandResults(brandCachedResults[brandPeriod]?.[brandDsFilter] || null);
  }, [brandDsFilter, brandPeriod, brandCachedResults]);

  // Persist selections to localStorage
  useEffect(() => { localStorage.setItem("hrBasketPrimary",   JSON.stringify([...primaryCats]));   }, [primaryCats]);
  useEffect(() => { localStorage.setItem("hrBasketSecondary", JSON.stringify([...secondaryCats])); }, [secondaryCats]);
  useEffect(() => { localStorage.setItem("hrBasketPeriod", period);   }, [period]);
  useEffect(() => { localStorage.setItem("hrBasketDS",     dsFilter); }, [dsFilter]);

  // Auto-run on load if categories were restored from localStorage
  useEffect(() => {
    if (autoRanRef.current) return;
    if (!invoiceData.length || !hasShopifyOrder || primaryCats.size === 0) return;
    autoRanRef.current = true;
    handleRun();
  }); // no dep array — runs every render until autoRanRef is set

  // Brand Basket — localStorage persistence
  useEffect(() => { localStorage.setItem("hrBrandCat",       brandCategory); }, [brandCategory]);
  useEffect(() => { localStorage.setItem("hrBrandPrimary",   JSON.stringify([...brandPrimary])); }, [brandPrimary]);
  useEffect(() => { localStorage.setItem("hrBrandSecondary", JSON.stringify([...brandSecondary])); }, [brandSecondary]);
  useEffect(() => { localStorage.setItem("hrBrandPeriod",    brandPeriod); }, [brandPeriod]);
  useEffect(() => { localStorage.setItem("hrBrandDS",        brandDsFilter); }, [brandDsFilter]);

  // Brand Basket — auto-run on load if state restored from localStorage
  useEffect(() => {
    if (brandAutoRanRef.current) return;
    if (!invoiceData.length || !hasShopifyOrder || !brandCategory || brandPrimary.size === 0) return;
    brandAutoRanRef.current = true;
    handleBrandRun();
  }); // no dep array — runs every render until brandAutoRanRef is set

  if (!invoiceData.length) return (
    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
      No invoice data loaded. Upload invoice CSV in the Upload Data tab.
    </div>
  );

  return (
    <div style={{fontFamily:"Inter,sans-serif",color:HR.text}}>
      {!hasShopifyOrder && (
        <div style={{background:"#FEF3C7",border:"1px solid #FDE68A",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#92400E"}}>
          ⚠ Loaded invoice data was uploaded before Shopify Order tracking was added. Please re-upload the invoice CSV to enable basket grouping.
        </div>
      )}

      {/* Category selector */}
      <div style={{...S.card,marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Categories</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {allCategories.map(cat => {
            const isPrimary = primaryCats.has(cat);
            const isSecondary = secondaryCats.has(cat);
            const bg = isPrimary ? "#D1FAE5" : isSecondary ? "#FEF3C7" : HR.white;
            const color = isPrimary ? "#065F46" : isSecondary ? "#92400E" : HR.muted;
            const borderColor = isPrimary ? "#6EE7B7" : isSecondary ? "#FDE68A" : HR.border;
            return (
              <button
                key={cat}
                onClick={() => toggleCat(cat)}
                style={{...S.btn(isPrimary||isSecondary), background:bg, color, borderColor}}
              >
                {cat}
              </button>
            );
          })}
        </div>
        <div style={{fontSize:10,color:HR.muted,marginTop:8}}>
          Click once → <span style={{background:"#D1FAE5",color:"#065F46",padding:"1px 4px",borderRadius:3}}>Primary</span> &nbsp;
          Click again → <span style={{background:"#FEF3C7",color:"#92400E",padding:"1px 4px",borderRadius:3}}>Secondary</span> &nbsp;
          Click again → Unselect
        </div>
        <div style={{marginTop:10,display:"flex",justifyContent:"flex-end"}}>
          <button
            onClick={handleRun}
            disabled={!runActive}
            style={{padding:"5px 18px",borderRadius:6,border:"none",background:runActive?HR.yellow:"#E5E5E5",color:runActive?HR.black:"#999",fontWeight:800,fontSize:12,cursor:runActive?"pointer":"not-allowed"}}
          >
            ▶ Run Basket Analysis
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <div style={{display:"flex",gap:4}}>
          {BA_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={S.btn(period === p.key)}>{p.label}</button>
          ))}
          <button onClick={() => { setPeriod("CUSTOM"); setCachedResults(null); setResults(null); }} style={S.btn(period === "CUSTOM")}>Custom</button>
        </div>
        {period === "CUSTOM" && (
          <>
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setResults(null); setCachedResults(null); }} style={S.input}/>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setResults(null); setCachedResults(null); }} style={S.input}/>
          </>
        )}
        <div style={{display:"flex",gap:4,marginLeft:8}}>
          {["All",...DS_LIST].map(ds => (
            <button key={ds} onClick={() => setDsFilter(ds)} style={S.btn(dsFilter === ds)}>{ds}</button>
          ))}
        </div>
      </div>

      <div style={{minHeight:440}}>
      {!results ? (
        <div style={{height:440,display:"flex",alignItems:"center",justifyContent:"center",color:HR.muted,fontSize:13}}>
          {primaryCats.size === 0 ? "Select at least one Primary category to begin." : "Click Run Basket Analysis."}
        </div>
      ) : (
        <>
          {/* 5 Summary Cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
            {[
              {num:results.totalOrders,pct:null,lbl:"Total Orders",sub:`${dsFilter} · ${period}`,color:"#0077A8"},
              {num:results.primaryOrders,pct:results.totalOrders?`${((results.primaryOrders/results.totalOrders)*100).toFixed(1)}%`:null,lbl:`Orders with ${primaryLabel}`,sub:"of total orders",color:"#92400E"},
              {num:results.primaryOnlyOrders,pct:results.primaryOrders?`${((results.primaryOnlyOrders/results.primaryOrders)*100).toFixed(1)}%`:null,lbl:`${primaryLabel} Only`,sub:`of ${primaryLabel} orders`,color:"#16a34a"},
              {num:results.primarySecondaryOrders,pct:results.primaryOrders?`${((results.primarySecondaryOrders/results.primaryOrders)*100).toFixed(1)}%`:null,lbl:`${primaryLabel} + ${secondaryLabel} Only`,sub:`of ${primaryLabel} orders`,color:"#B8860B"},
              {num:results.primaryOtherOrders,pct:results.primaryOrders?`${((results.primaryOtherOrders/results.primaryOrders)*100).toFixed(1)}%`:null,lbl:"+ Others",sub:`of ${primaryLabel} orders`,color:"#C05A00"},
            ].map((c,i) => (
              <div key={i} style={S.card}>
                <div style={{fontSize:24,fontWeight:800,color:c.color}}>{c.num.toLocaleString()}</div>
                {c.pct && <div style={{fontSize:16,fontWeight:800,color:c.color,margin:"-2px 0 2px"}}>{c.pct}</div>}
                <div style={{fontSize:11,fontWeight:600,color:"#555"}}>{c.lbl}</div>
                <div style={{fontSize:10,color:HR.muted,marginTop:2}}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* Charts */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1.5fr",gap:12,marginBottom:16}}>
            {/* Donut */}
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Basket Composition</div>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={[
                      {name:`${primaryLabel} Only`,value:results.primaryOnlyOrders},
                      {name:`+ ${secondaryLabel} Only`,value:results.primarySecondaryOrders},
                      {name:"+ Others",value:results.primaryOtherOrders},
                    ]}
                    cx="50%" cy="50%" innerRadius={75} outerRadius={115}
                    dataKey="value"
                  >
                    {DONUT_COLORS.map((c,i) => <Cell key={i} fill={c}/>)}
                  </Pie>
                  <RTooltip/>
                  <Legend iconSize={10} wrapperStyle={{fontSize:10}}/>
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Co-category bar */}
            <div style={S.card}>
              <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Co-Category Frequency (top 10)</div>
              {(() => {
                const sortedCoCats = Object.entries(results.coCatCounts)
                  .sort((a,b) => b[1]-a[1]).slice(0,10);
                return (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                      layout="vertical"
                      data={sortedCoCats.map(([cat,count]) => ({cat:cat.length>28?cat.slice(0,26)+"…":cat,count}))}
                      margin={{left:8,right:16,top:0,bottom:0}}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false}/>
                      <XAxis type="number" tick={{fontSize:10}}/>
                      <YAxis type="category" dataKey="cat" width={140} tick={{fontSize:10}}/>
                      <RTooltip formatter={(v) => [v, `${primaryLabel} orders also containing this`]}/>
                      <Bar dataKey="count">
                        {sortedCoCats.map(([cat],i) => <Cell key={i} fill={secondaryCats.has(cat)?"#F5C400":"#0077A8"}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </div>
          </div>

          {/* Insight */}
          {(() => {
            const mixedPct = results.primaryOrders > 0
              ? Math.round(((results.primarySecondaryOrders + results.primaryOtherOrders) / results.primaryOrders) * 100)
              : 0;
            const onlyPct = results.primaryOrders > 0
              ? Math.round((results.primaryOnlyOrders / results.primaryOrders) * 100)
              : 0;
            const insight = mixedPct > 60
              ? `High mix rate — routing all ${primaryLabel} to fallback would split most orders. Keeping top ${primaryLabel} SKUs at DS makes sense.`
              : onlyPct > 60
              ? `Most ${primaryLabel} orders are standalone — routing to fallback is operationally clean.`
              : `Mixed/standalone split is roughly even — stock top movers at DS, route bulk to fallback.`;
            const secNote = secondaryCats.size > 0
              ? ` ${secondaryLabel} appears in ${results.primarySecondaryOrders} orders with ${primaryLabel} (${results.primaryOrders > 0 ? Math.round((results.primarySecondaryOrders/results.primaryOrders)*100) : 0}%).`
              : "";
            return (
              <div style={{background:"#FFF9E6",border:"1px solid #FDE68A",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#92400E",lineHeight:1.6}}>
                <strong>Key Insight:</strong> {mixedPct}% of {primaryLabel} orders are mixed (contain other categories). {insight}{secNote}
              </div>
            );
          })()}
        </>
      )}
      </div>

      {/* ── Brand Basket Analysis ─────────────────────────────────────────── */}
      <div style={{borderTop:`2px solid ${HR.border}`,marginTop:24,paddingTop:20}}>
        <div style={{fontSize:13,fontWeight:700,color:HR.text,marginBottom:12}}>Brand Basket Analysis</div>

        {/* Category dropdown + Brand selector */}
        <div style={{...S.card,marginBottom:12}}>
          <div style={{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"}}>
            <div style={{minWidth:200}}>
              <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Category</div>
              <select
                value={brandCategory}
                onChange={e => { setBrandCategory(e.target.value); setBrandPrimary(new Set()); setBrandSecondary(new Set()); setBrandResults(null); setBrandCachedResults(null); }}
                style={{...S.input,width:"100%"}}
              >
                <option value="">Select a category…</option>
                {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {brandCategory && (
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:700,color:HR.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Brands in {brandCategory}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {brandsInCategory.map(brand => {
                    const isPrim = brandPrimary.has(brand);
                    const isSec = brandSecondary.has(brand);
                    const bg = isPrim ? "#D1FAE5" : isSec ? "#FEF3C7" : HR.white;
                    const color = isPrim ? "#065F46" : isSec ? "#92400E" : HR.muted;
                    const borderColor = isPrim ? "#6EE7B7" : isSec ? "#FDE68A" : HR.border;
                    return (
                      <span key={brand} style={{display:"inline-flex",alignItems:"center",gap:2}}>
                        <button onClick={() => toggleBrand(brand)}
                          style={{...S.btn(isPrim||isSec), background:bg, color, borderColor}}>
                          {brand}
                        </button>
                        <button onClick={() => excludeBrand(brand)}
                          title="Exclude from analysis"
                          style={{padding:"1px 4px",borderRadius:4,border:`1px solid ${HR.border}`,background:HR.white,color:HR.muted,cursor:"pointer",fontSize:9,lineHeight:"14px"}}>
                          ✕
                        </button>
                      </span>
                    );
                  })}
                  {excludedBrandsList.length > 0 && (
                    <div style={{width:"100%",marginTop:6,fontSize:10,color:HR.muted}}>
                      <span style={{fontWeight:600}}>Excluded:</span>{" "}
                      {excludedBrandsList.map(brand => (
                        <span key={brand} style={{marginRight:8}}>
                          {brand}
                          <button onClick={() => restoreBrand(brand)}
                            style={{marginLeft:3,padding:"0 4px",borderRadius:3,border:`1px solid ${HR.border}`,background:HR.white,color:"#0077A8",cursor:"pointer",fontSize:9}}>
                            restore
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{fontSize:10,color:HR.muted,marginTop:8}}>
                  Click once → <span style={{background:"#D1FAE5",color:"#065F46",padding:"1px 4px",borderRadius:3}}>Primary</span> &nbsp;
                  Click again → <span style={{background:"#FEF3C7",color:"#92400E",padding:"1px 4px",borderRadius:3}}>Secondary</span> &nbsp;
                  Click again → Unselect
                </div>
              </div>
            )}
          </div>
          <div style={{marginTop:10,display:"flex",justifyContent:"flex-end"}}>
            <button onClick={handleBrandRun} disabled={!brandRunActive}
              style={{padding:"5px 18px",borderRadius:6,border:"none",background:brandRunActive?HR.yellow:"#E5E5E5",color:brandRunActive?HR.black:"#999",fontWeight:800,fontSize:12,cursor:brandRunActive?"pointer":"not-allowed"}}>
              ▶ Run Brand Analysis
            </button>
          </div>
        </div>

        {/* Filters */}
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
          <div style={{display:"flex",gap:4}}>
            {BA_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
              <button key={p.key} onClick={() => setBrandPeriod(p.key)} style={S.btn(brandPeriod === p.key)}>{p.label}</button>
            ))}
            <button onClick={() => { setBrandPeriod("CUSTOM"); setBrandCachedResults(null); setBrandResults(null); }} style={S.btn(brandPeriod === "CUSTOM")}>Custom</button>
          </div>
          {brandPeriod === "CUSTOM" && (
            <>
              <input type="date" value={brandDateFrom} onChange={e => { setBrandDateFrom(e.target.value); setBrandResults(null); setBrandCachedResults(null); }} style={S.input}/>
              <input type="date" value={brandDateTo} onChange={e => { setBrandDateTo(e.target.value); setBrandResults(null); setBrandCachedResults(null); }} style={S.input}/>
            </>
          )}
          <div style={{display:"flex",gap:4,marginLeft:8}}>
            {["All",...DS_LIST].map(ds => (
              <button key={ds} onClick={() => setBrandDsFilter(ds)} style={S.btn(brandDsFilter === ds)}>{ds}</button>
            ))}
          </div>
        </div>

        <div style={{minHeight:440}}>
        {(!brandCategory || !brandResults) ? (
          <div style={{height:440,display:"flex",alignItems:"center",justifyContent:"center",color:HR.muted,fontSize:13}}>
            {!brandCategory ? "Select a category above to begin brand analysis." : brandPrimary.size === 0 ? "Select at least one Primary brand to begin." : "Click Run Brand Analysis."}
          </div>
        ) : (() => {
          const r = brandResults;
          const sortedCoBrands = Object.entries(r.coBrandCounts).sort((a,b) => b[1]-a[1]).slice(0,10);
          return (
            <>
              {/* 5 Summary Cards */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
                {[
                  {num:r.totalOrders,pct:null,lbl:"Total Orders",sub:`${brandDsFilter} · ${brandPeriod}`,color:"#0077A8"},
                  {num:r.primaryOrders,pct:r.totalOrders?`${((r.primaryOrders/r.totalOrders)*100).toFixed(1)}%`:null,lbl:`Orders with ${brandPrimaryLabel}`,sub:"of total orders",color:"#92400E"},
                  {num:r.primaryOnlyOrders,pct:r.primaryOrders?`${((r.primaryOnlyOrders/r.primaryOrders)*100).toFixed(1)}%`:null,lbl:`${brandPrimaryLabel} Only`,sub:`of ${brandPrimaryLabel} orders`,color:"#16a34a"},
                  {num:r.primarySecondaryOrders,pct:r.primaryOrders?`${((r.primarySecondaryOrders/r.primaryOrders)*100).toFixed(1)}%`:null,lbl:`${brandPrimaryLabel} + ${brandSecondaryLabel} Only`,sub:`of ${brandPrimaryLabel} orders`,color:"#B8860B"},
                  {num:r.primaryOtherOrders,pct:r.primaryOrders?`${((r.primaryOtherOrders/r.primaryOrders)*100).toFixed(1)}%`:null,lbl:"+ Other Brands",sub:`of ${brandPrimaryLabel} orders`,color:"#C05A00"},
                ].map((c,i) => (
                  <div key={i} style={S.card}>
                    <div style={{fontSize:24,fontWeight:800,color:c.color}}>{c.num.toLocaleString()}</div>
                    {c.pct && <div style={{fontSize:16,fontWeight:800,color:c.color,margin:"-2px 0 2px"}}>{c.pct}</div>}
                    <div style={{fontSize:11,fontWeight:600,color:"#555"}}>{c.lbl}</div>
                    <div style={{fontSize:10,color:HR.muted,marginTop:2}}>{c.sub}</div>
                  </div>
                ))}
              </div>

              {/* Charts */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1.5fr",gap:12,marginBottom:16}}>
                <div style={S.card}>
                  <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Basket Composition</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={[
                        {name:`${brandPrimaryLabel} Only`,value:r.primaryOnlyOrders},
                        {name:`+ ${brandSecondaryLabel}`,value:r.primarySecondaryOrders},
                        {name:"+ Other Brands",value:r.primaryOtherOrders},
                      ]} cx="50%" cy="50%" innerRadius={75} outerRadius={115} dataKey="value">
                        {DONUT_COLORS.map((c,i) => <Cell key={i} fill={c}/>)}
                      </Pie>
                      <RTooltip/><Legend iconSize={10} wrapperStyle={{fontSize:10}}/>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={S.card}>
                  <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>Co-Brand Frequency in {brandCategory} (top 10)</div>
                  {sortedCoBrands.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart layout="vertical"
                        data={sortedCoBrands.map(([brand,count]) => ({brand:brand.length>28?brand.slice(0,26)+"…":brand,count}))}
                        margin={{left:8,right:16,top:0,bottom:0}}>
                        <CartesianGrid strokeDasharray="3 3" horizontal={false}/>
                        <XAxis type="number" tick={{fontSize:10}}/>
                        <YAxis type="category" dataKey="brand" width={140} tick={{fontSize:10}}/>
                        <RTooltip formatter={(v) => [v, `${brandCategory} orders also containing this brand`]}/>
                        <Bar dataKey="count">
                          {sortedCoBrands.map(([brand],i) => <Cell key={i} fill={brandSecondary.has(brand)?"#F5C400":"#0077A8"}/>)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:12}}>No other brands found in the same orders.</div>
                  )}
                </div>
              </div>

              {/* Insight */}
              {(() => {
                const mixedPct = r.primaryOrders > 0 ? Math.round(((r.primarySecondaryOrders + r.primaryOtherOrders) / r.primaryOrders) * 100) : 0;
                const onlyPct = r.primaryOrders > 0 ? Math.round((r.primaryOnlyOrders / r.primaryOrders) * 100) : 0;
                const insight = mixedPct > 60
                  ? `High brand mix rate — splitting ${brandPrimaryLabel} and other ${brandCategory} brands across DSes would affect most orders. Consider stocking multiple brands at the same DS.`
                  : onlyPct > 60
                  ? `Most ${brandPrimaryLabel} orders are brand-exclusive — safe to consider stocking ${brandPrimaryLabel} at a dedicated DS without impacting order fulfilment.`
                  : `Mixed and exclusive orders are roughly balanced — analyse per-DS brand volume before deciding on brand-level DS assignment.`;
                const secNote = brandSecondary.size > 0
                  ? ` ${brandSecondaryLabel} appears exclusively alongside ${brandPrimaryLabel} in ${r.primarySecondaryOrders} orders (${r.primaryOrders > 0 ? Math.round((r.primarySecondaryOrders/r.primaryOrders)*100) : 0}%).`
                  : "";
                return (
                  <div style={{background:"#FFF9E6",border:"1px solid #FDE68A",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#92400E",lineHeight:1.6}}>
                    <strong>Stocking Signal:</strong> {mixedPct}% of {brandPrimaryLabel} orders contain other {brandCategory} brands. {insight}{secNote}
                  </div>
                );
              })()}
            </>
          );
        })()}
        </div>
        {/* ── Brand × DS Distribution Table ───────────────────────────────── */}
        {brandCategory && brandDSDistribution.length > 0 && (
          <div style={{marginTop:20}}>
            <div style={{fontSize:12,fontWeight:700,color:"#555",marginBottom:8}}>
              Brand × DS Distribution — {brandCategory}
              <span style={{fontSize:10,color:HR.muted,fontWeight:400,marginLeft:8}}>% of each brand's orders per DS · {brandPeriod}</span>
            </div>
            <div style={S.card}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead>
                  <tr style={{background:HR.surfaceLight}}>
                    <th style={{padding:"6px 10px",textAlign:"left",color:HR.muted,fontWeight:600,fontSize:10,borderBottom:`1px solid ${HR.border}`}}>Brand</th>
                    <th style={{padding:"6px 8px",textAlign:"center",color:HR.muted,fontWeight:600,fontSize:10,borderBottom:`1px solid ${HR.border}`}}>Total Orders</th>
                    {DS_LIST.map(ds => (
                      <th key={ds} style={{padding:"6px 8px",textAlign:"center",color:HR.muted,fontWeight:600,fontSize:10,borderBottom:`1px solid ${HR.border}`}}>{ds}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {brandDSDistribution.map(row => {
                    const maxPct = Math.max(...DS_LIST.map(ds => row.pcts[ds]));
                    return (
                      <tr key={row.brand} style={{borderTop:`1px solid ${HR.border}`}}>
                        <td style={{padding:"5px 10px",fontWeight:600}}>{row.brand}</td>
                        <td style={{padding:"5px 8px",textAlign:"center",color:HR.muted}}>{row.total}</td>
                        {(() => {
                          // Per-row relative heat map: normalize against this brand's own min/max
                          const nonZero = DS_LIST.map(ds => row.pcts[ds]).filter(p => p > 0);
                          const rowMin = nonZero.length ? Math.min(...nonZero) : 0;
                          const rowMax = nonZero.length ? Math.max(...nonZero) : 0;
                          return DS_LIST.map(ds => {
                            const pct = row.pcts[ds];
                            const count = row.counts[ds];
                            // Interpolate hue: 0 (red) → 120 (green) based on position within this brand's range
                            const normalized = rowMax > rowMin ? (pct - rowMin) / (rowMax - rowMin) : pct > 0 ? 1 : 0;
                            const hue = Math.round(normalized * 120);
                            const cellBg = pct > 0 ? `hsl(${hue},60%,90%)` : "";
                            return (
                              <td key={ds} style={{padding:"5px 8px",textAlign:"center",background:cellBg,borderRadius:4}}>
                                {pct > 0 ? (
                                  <>
                                    <span style={{fontWeight: pct === maxPct ? 800 : 500, color:"#374151", fontSize:12}}>{pct}%</span>
                                    <span style={{fontSize:9,color:"#6B7280",marginLeft:3}}>({count})</span>
                                  </>
                                ) : <span style={{color:HR.border}}>—</span>}
                              </td>
                            );
                          });
                        })()}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
