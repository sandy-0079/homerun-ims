import React, { useState, useMemo, useCallback, useEffect } from "react";
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

export default function BasketAnalysisTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin }) {
  const [period, setPeriod] = useState("L45D");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dsFilter, setDsFilter] = useState("All");
  const [primaryCats, setPrimaryCats] = useState(new Set());
  const [secondaryCats, setSecondaryCats] = useState(new Set());
  const [results, setResults] = useState(null);
  const [cachedResults, setCachedResults] = useState(null); // keyed by period then DS: {L45D: {All, DS01,...}, ...}

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

  // Run button shows "Re-run" if we have cached results (category/custom change forces re-run)
  const needsRerun = !cachedResults && primaryCats.size > 0;

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
            disabled={!canRun}
            style={{padding:"5px 18px",borderRadius:6,border:"none",background:canRun?HR.yellow:"#E5E5E5",color:canRun?HR.black:"#999",fontWeight:800,fontSize:12,cursor:canRun?"pointer":"not-allowed"}}
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

      {!results && (
        <div style={{padding:40,textAlign:"center",color:HR.muted,fontSize:13}}>
          {primaryCats.size === 0 ? "Select at least one Primary category to begin." : "Click Run Basket Analysis."}
        </div>
      )}

      {results && (
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
  );
}
