import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { DS_LIST } from "../engine/index.js";
import { supabase } from "../supabase.js";

const SYNC_COOLDOWN_MINS = 15;

// ─── Design tokens ────────────────────────────────────────────────────────────
const HR = {
  yellow: "#F5C400", black: "#1A1A1A", white: "#FFFFFF",
  bg: "#F5F5F0", surface: "#FFFFFF", surfaceLight: "#F0F0E8",
  border: "#E0E0D0", muted: "#888870", text: "#1A1A1A", textSoft: "#444438",
};
const DS_COLORS = [
  { header: "#B8860B" }, { header: "#1D6B30" }, { header: "#C05A00" },
  { header: "#7A3DBF" }, { header: "#B5006A" }, { header: "#0F766E" },
];
const DC_COLOR = { header: "#0077A8" };
const DS_AND_DC = [...DS_LIST, "DC"];

// Zoho Inventory deep-link base (org migrated from Books → Inventory 2026-07-06).
const ZOHO_INV_URL = "https://inventory.zoho.in/app/60075214606#";

const TC = {
  ec:          { label: "Critical",     short: "Critical",     cardBg: "#FEE2E2", cardText: "#B91C1C", cardBorder: "#FECACA", rowBg: "rgba(254,226,226,0.45)", ecsBg: "#FECACA", borderColor: "#EF4444", textColor: "#B91C1C" },
  critical:    { label: "Low Stock",    short: "Low Stock",    cardBg: "#FEF3C7", cardText: "#92400E", cardBorder: "#FDE68A", rowBg: "rgba(254,243,199,0.45)", ecsBg: "#FDE68A", borderColor: "#F59E0B", textColor: "#92400E" },
  dsReqCovered: { label: "DS Req Covered", short: "Covered", cardBg: "#EDE9FE", cardText: "#5B21B6", cardBorder: "#DDD6FE", rowBg: "rgba(237,233,254,0.45)", ecsBg: "#DDD6FE", borderColor: "#7C3AED", textColor: "#5B21B6" },
  okay:        { label: "Okay",         short: "Okay",         cardBg: "#D1FAE5", cardText: "#065F46", cardBorder: "#A7F3D0", rowBg: "rgba(209,250,229,0.35)", ecsBg: "#A7F3D0", borderColor: "#10B981", textColor: "#065F46" },
  excess:      { label: "Excess",       short: "Excess",       cardBg: "#DBEAFE", cardText: "#1E40AF", cardBorder: "#BFDBFE", rowBg: "rgba(219,234,254,0.35)", ecsBg: "#BFDBFE", borderColor: "#3B82F6", textColor: "#1E40AF" },
};
const TAG_ORDER = ["ec", "critical", "dsReqCovered", "okay", "excess"];

const N = { padding: "6px 10px", textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", borderTop: `1px solid ${HR.border}` };
const SEL = { border: `1px solid ${HR.border}`, borderRadius: 6, padding: "6px 8px", fontSize: 11, background: HR.white, color: HR.text, outline: "none", cursor: "pointer", fontFamily: "inherit" };

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function Tooltip({ text, children }) {
  const [show, setShow] = React.useState(false);
  return (
    <span style={{ position: "relative" }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: 0,
          background: "#1A1A1A", color: "#fff", borderRadius: 6, padding: "8px 12px",
          fontSize: 11, lineHeight: 1.7, whiteSpace: "nowrap", zIndex: 100,
          pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        }}>{text}</div>
      )}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


function getHealthTag(ecs, min, max, ros) {
  if (ecs > max) return "excess";
  if (ecs === min && min === max) return "okay";  // fully stocked dead-stock SKU
  if (ecs <= min) return (ros - ecs >= 1) ? "ec" : "critical";
  return "okay";
}

// DC-only reclassification: a Critical/Low-Stock DC SKU needs no supplier PO when any of:
//   A) no DS is short, B) DC stock covers all short-DS reorder needs, or
//   C) network DS excess + DC stock covers DC's own Min floor.
// SHARED by dsSummary (tab-bar badges) and allSkuRows (KPI cards + table) so the two
// never diverge — the override must live in exactly one place.
function applyDCReqCovered(tag, { sku, ecs, min, res, activeStockData }) {
  if (tag !== "ec" && tag !== "critical") return tag;
  let dsExcessSum = 0, dsReorderSum = 0, hasShortDS = false;
  for (const ds of DS_LIST) {
    const dsLive = activeStockData[sku]?.[ds];
    if (!dsLive) continue;
    const dsMax = res.stores?.[ds]?.max || 0;
    const dsMin = res.stores?.[ds]?.min || 0;
    const dsEcs = Math.max(0, dsLive.stock_on_hand ?? 0);  // SoH basis — matches ECS (see getLive)
    if (dsEcs > dsMax) dsExcessSum += dsEcs - dsMax;
    if (dsEcs <= dsMin) { hasShortDS = true; dsReorderSum += Math.max(0, dsMax - dsEcs); }
  }
  const condA = !hasShortDS;
  const condB = hasShortDS && ecs >= dsReorderSum;
  const condC = dsExcessSum + ecs >= min;
  return (condA || condB || condC) ? "dsReqCovered" : tag;
}

function getLive(live) {
  const stockOnHand = live.stock_on_hand ?? 0;
  const afs         = live.available_for_sale ?? 0;
  // ECS (effective current stock) tags on Stock-on-Hand, not AFS: stale historical
  // Sales Orders depress AFS even when the stock is physically present at the location.
  return { stockOnHand, afs, ecs: Math.max(0, stockOnHand) };
}

function pct(n, total) { return total > 0 ? Math.round((n / total) * 100) : 0; }

function dsAccent(ds) {
  const i = DS_LIST.indexOf(ds);
  return i >= 0 ? DS_COLORS[i].header : DC_COLOR.header;
}

// ─── Main Component ───────────────────────────────────────────────────────────
const TO_STATUS_BADGE = {
  draft:       'Picking',
  in_transit:  'In Transit',
  transferred: 'Transferred',
}
const TO_STATUS_STYLE = {
  draft:       { bg: '#FEF3C7', color: '#92400E' },
  in_transit:  { bg: '#DBEAFE', color: '#1E40AF' },
  transferred: { bg: '#D1FAE5', color: '#065F46' },
}

// Zoho Inventory PO status vocabulary (migrated from Books 2026-07-06). Books
// keys (open/partially_billed) kept for any stale cached POs during transition.
const PO_STATUS_LABEL = {
  issued:             'Issued',
  partially_received: 'Partially Received',
  received:           'Received',
  pending_approval:   'Pending Approval',
  delayed:            'Delayed',
  open:               'Issued',
  partially_billed:   'Issued',
};
const PO_STATUS_BADGE = {
  issued:             'Issued',
  partially_received: 'Partial',
  received:           'Received',
  pending_approval:   'Pend. Appr.',
  delayed:            'Delayed',
  open:               'Issued',
  partially_billed:   'Issued',
};
const PO_STATUS_STYLE = {
  issued:             { bg: '#D1FAE5', color: '#065F46' },
  partially_received: { bg: '#DBEAFE', color: '#1E40AF' },
  received:           { bg: '#E5E7EB', color: '#374151' },
  pending_approval:   { bg: '#FEF3C7', color: '#92400E' },
  delayed:            { bg: '#FEE2E2', color: '#B91C1C' },
  open:               { bg: '#D1FAE5', color: '#065F46' },
  partially_billed:   { bg: '#D1FAE5', color: '#065F46' },
};

// Derives display status — adds Delayed for overdue issued POs with no receipt.
function getPoDisplayStatus(po) {
  if (!po) return null;
  if ((po.status === 'issued' || po.status === 'partially_received' ||
       po.status === 'open'   || po.status === 'partially_billed') && po.delivery) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due   = new Date(po.delivery); due.setHours(0, 0, 0, 0);
    if (today > due && (po.received ?? 0) === 0) return 'delayed';
  }
  return po.status;
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  } catch { return d; }
}

export default function StockHealthTab({
  results, skuMaster, stockData, stockDataAccounting, uploadedAtPerDS, onSyncComplete, poData, toData,
}) {
  const [selectedDS,  setSelectedDS]  = useState("DS01");
  const [selectedCat, setSelectedCat] = useState(null);
  const [filterTag,   setFilterTag]   = useState(null);
  const [filterBrand,    setFilterBrand]    = useState("All");
  const [filterPoStatus, setFilterPoStatus] = useState("All");
  const [filterToStatus, setFilterToStatus] = useState("All");
  const [sortCol,        setSortCol]        = useState(null);
  const [sortDir,        setSortDir]        = useState("asc");
  const [search,         setSearch]         = useState("");
  const [copiedSku,   setCopiedSku]   = useState(null);
  const [syncing,     setSyncing]     = useState(false);
  const [stockMode,   setStockMode]   = useState("accounting"); // "physical" | "accounting"

  const allSkuRowsRef = useRef([]);

  // Active stock dataset — switches based on selected mode
  const activeStockData = (stockMode === "accounting" && Object.keys(stockDataAccounting || {}).length > 0)
    ? stockDataAccounting
    : stockData;

  const copySku = useCallback((sku, e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sku).catch(() => {});
    setCopiedSku(sku);
    setTimeout(() => setCopiedSku(s => s === sku ? null : s), 1500);
  }, []);

  // ── CSV Upload ──────────────────────────────────────────────────────────────
  const handleSyncNow = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // Stock: sequential branch pairs to stay under Zoho's inventorysummary rate limit.
      // Orders runs in parallel with the first batch (different endpoints, no conflict).
      await Promise.all([
        supabase.functions.invoke('sync-stock', { body: { branches: ['DC', 'DS01'] } }),
        supabase.functions.invoke('sync-orders'),
      ]);
      await supabase.functions.invoke('sync-stock', { body: { branches: ['DS02', 'DS03'] } });
      await supabase.functions.invoke('sync-stock', { body: { branches: ['DS04', 'DS05'] } });
      await supabase.functions.invoke('sync-stock', { body: { branches: ['DS06'] } });
      // Reload fresh data directly — don't rely on Realtime being configured
      await onSyncComplete?.();
    } catch (err) {
      console.error('Sync Now failed:', err);
    } finally {
      setSyncing(false);
    }
  }, [syncing, onSyncComplete]);

  // ── DS-level summary (tab EC badges) ───────────────────────────────────────
  const dsSummary = useMemo(() => {
    const s = {};
    for (const ds of DS_AND_DC) s[ds] = { ec: 0, critical: 0, dsReqCovered: 0, okay: 0, excess: 0 };
    if (!results) return s;
    for (const [sku, res] of Object.entries(results)) {
      const meta = res.meta || {};
      const invAt = (meta.inventorisedAt || "DS").toLowerCase();
      if (invAt === "supplier") continue;
      if ((meta.status || "Active").toLowerCase() !== "active") continue;
      // DS tabs: both "ds" and "dc" inventorised SKUs are relevant
      for (const ds of DS_LIST) {
        const sr = res.stores?.[ds];
        if (!sr || (!sr.min && !sr.max)) continue;
        const live = activeStockData[sku]?.[ds];
        if (!live) continue;
        const { ecs } = getLive(live);
        s[ds][getHealthTag(ecs, sr.min || 0, sr.max || 0, sr.dailyAvg || 0)]++;
      }
      // DC tab: only "dc" inventorised SKUs — "ds" SKUs bypass the DC entirely
      if (invAt === "dc") {
        const dc = res.dc;
        if (dc?.min || dc?.max) {
          const live = activeStockData[sku]?.["DC"];
          if (!live) continue;
          const { ecs } = getLive(live);
          const dcRos = DS_LIST.reduce((sum, ds) => sum + (res.stores?.[ds]?.dailyAvg || 0), 0);
          let dcTag = getHealthTag(ecs, dc.min || 0, dc.max || 0, dcRos);
          dcTag = applyDCReqCovered(dcTag, { sku, ecs, min: dc.min || 0, res, activeStockData });
          s["DC"][dcTag]++;
        }
      }
    }
    return s;
  }, [results, activeStockData]);

  // ── All SKU rows for selected DS ───────────────────────────────────────────
  // Supplier-inventorised and inactive SKUs are excluded here using res.meta,
  // which is populated from the already-uploaded SKU Master CSV.
  const allSkuRows = useMemo(() => {
    if (!results) return [];
    const isDC = selectedDS === "DC";
    return Object.entries(results).flatMap(([sku, res]) => {
      const meta = res.meta || {};
      const invAt = (meta.inventorisedAt || "DS").toLowerCase();
      if (invAt === "supplier") return [];
      if ((meta.status || "Active").toLowerCase() !== "active") return [];
      // DC tab only shows SKUs that flow through DC; DS tabs show both ds+dc inventorised
      if (isDC && invAt !== "dc") return [];

      const minMax = isDC ? res.dc : res.stores?.[selectedDS];
      if (!minMax || (!minMax.min && !minMax.max)) return [];
      const live = activeStockData[sku]?.[selectedDS];
      if (!live) return [];
      const { stockOnHand, afs, ecs } = getLive(live);
      const min = minMax.min || 0;
      const max = minMax.max || 0;
      const ros = isDC
        ? DS_LIST.reduce((sum, ds) => sum + (res.stores?.[ds]?.dailyAvg || 0), 0)
        : (res.stores?.[selectedDS]?.dailyAvg || 0);
      let tag = getHealthTag(ecs, min, max, ros);
      // DC tab only: reclassify Critical/Low-Stock to "DS Req Covered" when no supplier PO is needed.
      if (isDC) tag = applyDCReqCovered(tag, { sku, ecs, min, res, activeStockData });
      const reorderQty = (tag === "ec" || tag === "critical") ? Math.max(0, max - ecs) : 0;
      return [{
        sku,
        name:     meta.name     || sku,
        category: meta.category || "Uncategorized",
        brand:    meta.brand    || "—",
        invAt,
        stockOnHand, afs, ecs, min, max, ros, tag, reorderQty,
      }];
    });
  }, [results, selectedDS, activeStockData]);

  allSkuRowsRef.current = allSkuRows;

  // ── Per-category totals (for nav badges + KPI cards) ──────────────────────
  const catTotals = useMemo(() => {
    const map = {};
    for (const row of allSkuRows) {
      if (!map[row.category]) map[row.category] = { total: 0, stocked: 0, ec: 0, critical: 0, dsReqCovered: 0, okay: 0, excess: 0 };
      map[row.category].total++;
      if (row.ecs > 0) map[row.category].stocked++;
      map[row.category][row.tag]++;
    }
    return map;
  }, [allSkuRows]);

  // Master SKU counts per category — denominator for coverage metric.
  // DC tab: only DC-inventorised SKUs. DS tabs: all active non-supplier (ds + dc).
  const masterCatTotals = useMemo(() => {
    const isDC = selectedDS === "DC";
    const map = {};
    for (const entry of Object.values(skuMaster || {})) {
      if ((entry.status || "Active").toLowerCase() !== "active") continue;
      const invAt = (entry.inventorisedAt || "DS").toLowerCase();
      if (invAt === "supplier") continue;
      if (isDC && invAt !== "dc") continue;
      const cat = entry.category || "Uncategorized";
      map[cat] = (map[cat] || 0) + 1;
    }
    return map;
  }, [skuMaster, selectedDS]);

  const masterTotal = useMemo(() =>
    Object.values(masterCatTotals).reduce((s, n) => s + n, 0),
    [masterCatTotals]
  );

  // Nav list: sorted by EC desc then Critical desc
  const navCategories = useMemo(() =>
    Object.entries(catTotals)
      .map(([cat, t]) => ({ cat, ...t }))
      .sort((a, b) => b.ec - a.ec || b.critical - a.critical),
    [catTotals]
  );

  // ── DS-level totals ────────────────────────────────────────────────────────
  const dsTotals = useMemo(() => {
    const counts = { ec: 0, critical: 0, dsReqCovered: 0, okay: 0, excess: 0, total: 0 };
    for (const row of allSkuRows) {
      counts[row.tag] = (counts[row.tag] || 0) + 1;
      counts.total++;
    }
    return counts;
  }, [allSkuRows]);

  // KPI cards show category totals when a category is selected
  const kpiTotals = useMemo(() => {
    if (selectedCat) {
      const t = catTotals[selectedCat] || { ec: 0, critical: 0, dsReqCovered: 0, okay: 0, excess: 0 };
      const total = t.ec + t.critical + (t.dsReqCovered || 0) + t.okay + t.excess;
      return { ...t, total };
    }
    return dsTotals;
  }, [selectedCat, catTotals, dsTotals]);

  // ── Available brands (for dropdown) ───────────────────────────────────────
  const brands = useMemo(() => {
    const set = new Set();
    for (const row of allSkuRows) {
      if (row.brand && row.brand !== "—") set.add(row.brand);
    }
    return [...set].sort();
  }, [allSkuRows]);

  // ── PO data for selected DS ────────────────────────────────────────────────
  const dsPoData = useMemo(() => {
    const raw = selectedDS === "DC" ? (poData?.DC || {}) : (poData?.[selectedDS] || {});
    // Hide POs where any qty was received — stock already arrived, latest PO wins
    // so if the most recent PO has received > 0, that's the end of the story
    const out = {};
    for (const [sku, po] of Object.entries(raw)) {
      if (po && po.received > 0) continue;
      out[sku] = po;
    }
    return out;
  }, [poData, selectedDS]);

  // ── TO data for selected DS (DC-originated TOs destined for this DS) ───────
  const dsToData = useMemo(() => {
    if (selectedDS === "DC") return {};
    return toData?.[selectedDS] || {};
  }, [toData, selectedDS]);

  // PO status breakdown per stock health tag — must be after dsPoData
  const poCountsByTag = useMemo(() => {
    const counts = {};
    for (const tag of TAG_ORDER) counts[tag] = { noPO: 0, delayed: 0, issued: 0, pending: 0 };
    const rows = selectedCat ? allSkuRows.filter(r => r.category === selectedCat) : allSkuRows;
    const isDC = selectedDS === "DC";
    for (const row of rows) {
      // On DS tabs, DC-inv SKUs use TOs — skip from PO pill counts
      if (!isDC && row.invAt === "dc") continue;
      const po = dsPoData[row.sku];
      const bucket = counts[row.tag];
      if (!bucket) continue;
      if (!po) { bucket.noPO++; continue; }
      const ds = getPoDisplayStatus(po);
      if (ds === 'delayed') bucket.delayed++;
      else if (ds === 'pending_approval') bucket.pending++;
      else bucket.issued++;
    }
    return counts;
  }, [allSkuRows, selectedCat, dsPoData]);

  // ── TO pill counts per health tag (DC-inv SKUs on DS tabs only) ───────────
  const toCountsByTag = useMemo(() => {
    const counts = {};
    for (const tag of TAG_ORDER) counts[tag] = { noTO: 0, draft: 0, inTransit: 0 };
    if (selectedDS === "DC") return counts;
    const rows = selectedCat ? allSkuRows.filter(r => r.category === selectedCat) : allSkuRows;
    for (const row of rows) {
      if (row.invAt !== "dc") continue;
      const to = dsToData[row.sku];
      const bucket = counts[row.tag];
      if (!bucket) continue;
      if (!to) { bucket.noTO++; continue; }
      if (to.status === "in_transit") bucket.inTransit++;
      else bucket.draft++;
    }
    return counts;
  }, [allSkuRows, selectedCat, dsToData, selectedDS]);


  // Reset sort and filters when switching DS tabs — filters are location-specific
  useEffect(() => {
    setSortCol(null); setSortDir("asc");
    setFilterTag(null); setFilterBrand("All"); setSelectedCat(null);
    setFilterPoStatus("All"); setFilterToStatus("All");
  }, [selectedDS]);

  const handleSort = useCallback((key) => {
    if (sortCol === key) {
      if (sortDir === "asc") { setSortDir("desc"); }
      else { setSortCol(null); setSortDir("asc"); }
    } else {
      setSortCol(key);
      setSortDir("asc");
    }
  }, [sortCol, sortDir]);

  // ── Filtered flat rows ─────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    const q = search.toLowerCase();
    const TAG_RANK = { ec: 0, critical: 1, dsReqCovered: 2, okay: 3, excess: 4 };
    return allSkuRows
      .filter(r => {
        if (selectedCat && r.category !== selectedCat) return false;
        if (filterTag && r.tag !== filterTag) return false;
        if (filterBrand !== "All" && r.brand !== filterBrand) return false;
        if (q && !r.sku.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q) && !r.brand.toLowerCase().includes(q)) return false;
        const isDC = selectedDS === "DC";
        const isDCInv = !isDC && r.invAt === "dc";

        // PO filter — DC tab always, DS-inv SKUs on DS tabs only; exclude DC-inv SKUs on DS tabs when active
        if (filterPoStatus !== "All") {
          if (!isDC && isDCInv) return false;
          const po = dsPoData[r.sku];
          if (filterPoStatus === "No PO") { if (po) return false; }
          else {
            const displayStatus = getPoDisplayStatus(po);
            if (filterPoStatus === "Issued" && displayStatus !== "issued" && displayStatus !== "partially_received" && displayStatus !== "open" && displayStatus !== "partially_billed") return false;
            if (filterPoStatus === "Pending Approval" && displayStatus !== "pending_approval") return false;
            if (filterPoStatus === "Delayed" && displayStatus !== "delayed") return false;
          }
        }

        // TO filter — DC-inv SKUs on DS tabs only; exclude DS-inv SKUs entirely when active
        if (filterToStatus !== "All") {
          if (!isDCInv) return false;
          const to = dsToData[r.sku];
          if (filterToStatus === "No TO"      && to) return false;
          if (filterToStatus === "Draft"      && (!to || to.status !== "draft"))       return false;
          if (filterToStatus === "In Transit" && (!to || to.status !== "in_transit"))  return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (!sortCol) {
          const tagDiff = TAG_RANK[a.tag] - TAG_RANK[b.tag];
          if (tagDiff !== 0) return tagDiff;
          if (a.tag === "ec" || a.tag === "critical") return b.reorderQty - a.reorderQty;
          return a.ecs - b.ecs;
        }
        const isDC = selectedDS === "DC";
        const isDCInvA = !isDC && a.invAt === "dc";
        const isDCInvB = !isDC && b.invAt === "dc";
        let aVal, bVal;
        switch (sortCol) {
          case "name":       aVal = a.name.toLowerCase();  bVal = b.name.toLowerCase();  break;
          case "brand":      aVal = a.brand === "—" ? "" : a.brand.toLowerCase();
                             bVal = b.brand === "—" ? "" : b.brand.toLowerCase();        break;
          case "ecs":        aVal = a.ecs;                 bVal = b.ecs;                 break;
          case "reorderQty": aVal = a.reorderQty;          bVal = b.reorderQty;          break;
          case "date": {
            const aOrd = isDCInvA ? dsToData[a.sku] : dsPoData[a.sku];
            const bOrd = isDCInvB ? dsToData[b.sku] : dsPoData[b.sku];
            aVal = (isDCInvA ? aOrd?.to_date   : aOrd?.po_date)  ?? "";
            bVal = (isDCInvB ? bOrd?.to_date   : bOrd?.po_date)  ?? "";
            break;
          }
          case "delivery": {
            const aOrd = isDCInvA ? dsToData[a.sku] : dsPoData[a.sku];
            const bOrd = isDCInvB ? dsToData[b.sku] : dsPoData[b.sku];
            aVal = (isDCInvA ? aOrd?.to_date   : aOrd?.delivery) ?? "";
            bVal = (isDCInvB ? bOrd?.to_date   : bOrd?.delivery) ?? "";
            break;
          }
          case "status": {
            const PO_RANK = { delayed: 0, issued: 1, partially_received: 2, pending_approval: 3, open: 1, partially_billed: 2 };
            const TO_RANK = { transferred: 0, in_transit: 1, draft: 2 };
            const aOrd = isDCInvA ? dsToData[a.sku] : dsPoData[a.sku];
            const bOrd = isDCInvB ? dsToData[b.sku] : dsPoData[b.sku];
            const aSt  = isDCInvA ? aOrd?.status : (aOrd ? getPoDisplayStatus(aOrd) : null);
            const bSt  = isDCInvB ? bOrd?.status : (bOrd ? getPoDisplayStatus(bOrd) : null);
            aVal = aSt != null ? ((isDCInvA ? TO_RANK : PO_RANK)[aSt] ?? 9) : 10;
            bVal = bSt != null ? ((isDCInvB ? TO_RANK : PO_RANK)[bSt] ?? 9) : 10;
            break;
          }
          default: return 0;
        }
        // Nulls / empty strings always sort last regardless of direction
        if (typeof aVal === "string" && typeof bVal === "string") {
          if (!aVal && bVal)  return 1;
          if (aVal  && !bVal) return -1;
          const cmp = aVal.localeCompare(bVal);
          return sortDir === "asc" ? cmp : -cmp;
        }
        const cmp = (aVal ?? Infinity) - (bVal ?? Infinity);
        return sortDir === "asc" ? cmp : -cmp;
      });
  }, [allSkuRows, selectedCat, filterTag, filterBrand, filterPoStatus, filterToStatus, search, dsPoData, dsToData, selectedDS, sortCol, sortDir]);

  // ── Reset filters on DS switch ─────────────────────────────────────────────
  const hasStock = Object.keys(activeStockData).length > 0;

  // Last synced timestamp for the current DS
  const lastSyncedLabel = (() => {
    const raw = uploadedAtPerDS?.[selectedDS];
    if (!raw) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  })();

  // Cooldown — disabled if any DS was synced within SYNC_COOLDOWN_MINS
  const { inCooldown, minsAgo } = useMemo(() => {
    const timestamps = Object.values(uploadedAtPerDS || {}).map(t => new Date(t).getTime()).filter(Boolean);
    if (!timestamps.length) return { inCooldown: false, minsAgo: null };
    const mins = (Date.now() - Math.max(...timestamps)) / 60_000;
    return { inCooldown: mins < SYNC_COOLDOWN_MINS, minsAgo: Math.floor(mins) };
  }, [uploadedAtPerDS]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", height: "100%", minWidth: 0 }}>

      {/* ── Left: Category Nav — full height ────────────────────────────── */}
      <div style={{
        width: 192, flexShrink: 0, overflowY: "auto",
        borderRight: `1px solid ${HR.border}`, background: HR.surface,
        display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{ padding: "10px 12px", borderBottom: `2px solid ${HR.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: HR.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Categories</div>
        </div>

        {/* All */}
        <NavItem
          label="All Categories"
          subLabel={masterTotal > 0 ? `${dsTotals.total}/${masterTotal} · ${pct(dsTotals.total, masterTotal)}%` : `${dsTotals.total} SKUs`}
          ecCount={dsTotals.ec}
          critCount={dsTotals.critical}
          isSelected={selectedCat === null}
          onClick={() => setSelectedCat(null)}
        />

        {/* Per-category */}
        {navCategories.map(({ cat, ec, critical, total }) => {
          const masterN = masterCatTotals[cat] || 0;
          const subLabel = masterN > 0
            ? `${total}/${masterN} · ${pct(total, masterN)}%`
            : `${total} SKUs`;
          return (
            <NavItem
              key={cat}
              label={cat}
              subLabel={subLabel}
              ecCount={ec}
              critCount={critical}
              isSelected={selectedCat === cat}
              onClick={() => setSelectedCat(cat === selectedCat ? null : cat)}
            />
          );
        })}
      </div>

      {/* ── Right: DS tabs + KPI + filters + table ──────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>

        {/* ── DS Tab Bar ──────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "stretch", background: HR.surface, borderBottom: `2px solid ${HR.border}`, flexShrink: 0 }}>
          {DS_AND_DC.map(ds => {
            const isSelected = selectedDS === ds;
            const accent = dsAccent(ds);
            const ecCount = dsSummary[ds]?.ec || 0;
            return (
              <button key={ds}
                onClick={() => setSelectedDS(ds)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "10px 15px", border: "none",
                  borderBottom: `2px solid ${isSelected ? accent : "transparent"}`,
                  marginBottom: -2, cursor: "pointer", transition: "all 0.15s",
                  background: isSelected ? `${accent}12` : "transparent",
                  fontWeight: isSelected ? 700 : 500, fontSize: 12,
                  color: isSelected ? accent : HR.muted, whiteSpace: "nowrap", fontFamily: "inherit",
                }}>
                {ds}
                {ecCount > 0 && (
                  <span style={{ background: TC.ec.cardBg, color: TC.ec.cardText, borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 700, lineHeight: "15px" }}>
                    {ecCount}
                  </span>
                )}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />

          {/* Stock mode toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 12px", borderLeft: `1px solid ${HR.border}` }}>
            {[["accounting", "Accounting"], ["physical", "Physical"]].map(([mode, label]) => (
              <button key={mode} onClick={() => setStockMode(mode)}
                style={{
                  border: `1px solid ${stockMode === mode ? "#B8860B" : HR.border}`,
                  borderRadius: 4, padding: "3px 8px", fontSize: 10,
                  fontWeight: stockMode === mode ? 700 : 500,
                  background: stockMode === mode ? "#FFFBEA" : HR.surface,
                  color: stockMode === mode ? "#7A5800" : HR.muted,
                  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
                }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderLeft: `1px solid ${HR.border}` }}>
            <span style={{ fontSize: 10, color: HR.muted, whiteSpace: "nowrap" }}>
              ↻ Syncs hourly
              {lastSyncedLabel && (
                <> · Last synced: <span style={{ fontWeight: 600, color: HR.textSoft }}>{lastSyncedLabel}</span></>
              )}
            </span>
            <button
              onClick={handleSyncNow}
              disabled={syncing || inCooldown}
              title={inCooldown ? `Synced ${minsAgo}m ago — available again in ${SYNC_COOLDOWN_MINS - minsAgo}m` : "Sync all locations from Zoho now"}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                border: `1px solid #E8D48A`, borderRadius: 5, padding: "3px 9px",
                background: (syncing || inCooldown) ? HR.surfaceLight : "#FFFBEA",
                color: (syncing || inCooldown) ? HR.muted : "#92740A",
                fontSize: 10, fontWeight: 600, cursor: (syncing || inCooldown) ? "not-allowed" : "pointer",
                whiteSpace: "nowrap", fontFamily: "inherit", flexShrink: 0,
                opacity: (syncing || inCooldown) ? 0.65 : 1,
              }}
            >
              {syncing ? "Syncing…" : inCooldown ? `Synced ${minsAgo}m ago` : "↻ Sync Now"}
            </button>
          </div>
        </div>

        {/* ── KPI Cards ───────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${selectedDS === "DC" ? 5 : 4},1fr)`, gap: 10, padding: "12px 14px 10px", flexShrink: 0 }}>
          {TAG_ORDER.map(tag => {
            if (tag === "dsReqCovered" && selectedDS !== "DC") return null;
            const cfg   = TC[tag];
            const count = kpiTotals[tag] || 0;
            const p     = pct(count, kpiTotals.total || 0);
            const isActive = filterTag === tag;
            return (
              <div key={tag} onClick={() => setFilterTag(isActive ? null : tag)}
                style={{
                  background: isActive ? cfg.cardBg : `${cfg.cardBg}88`,
                  border: `2px solid ${isActive ? cfg.borderColor : cfg.cardBorder}`,
                  borderRadius: 10, padding: "12px 14px", cursor: "pointer",
                  transition: "border-color 0.15s, background 0.15s",
                  boxShadow: isActive ? `0 2px 10px ${cfg.borderColor}28` : "0 1px 3px rgba(0,0,0,0.04)",
                }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: cfg.cardText, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                  {cfg.label}
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: cfg.cardText, lineHeight: 1, marginBottom: 3 }}>
                  {count}
                </div>
                <div style={{ fontSize: 10, color: cfg.cardText, opacity: 0.65 }}>
                  {selectedCat ? `${p}% of ${selectedCat}` : `${p}% of ${selectedDS}`}
                </div>

                {/* TO pills (DS tabs only) */}
                {selectedDS !== "DC" && (
                  <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${cfg.cardBorder}`, display: "flex", gap: 3 }}>
                    {[
                      { k: "noTO",      label: "No TO",      tf: "No TO",      bg: "#F3F4F6", color: "#6B7280", border: "#D1D5DB" },
                      { k: "draft",     label: "Picking",    tf: "Draft",      bg: "#FEF3C7", color: "#92400E", border: "#FDE68A" },
                      { k: "inTransit", label: "In Transit", tf: "In Transit", bg: "#DBEAFE", color: "#1E40AF", border: "#BFDBFE" },
                    ].map(({ k, label, tf, bg, color, border }) => (
                      <span key={k}
                        onClick={e => { e.stopPropagation(); setFilterTag(tag); setFilterToStatus(tf); }}
                        title={`${cfg.label} · TO: ${label}`}
                        style={{
                          flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600,
                          padding: "2px 2px", borderRadius: 5, cursor: "pointer",
                          border: `1px solid ${border}`, background: bg, color,
                          whiteSpace: "nowrap", userSelect: "none", lineHeight: 1.4,
                        }}
                        onMouseEnter={e => e.currentTarget.style.filter = "brightness(0.93)"}
                        onMouseLeave={e => e.currentTarget.style.filter = ""}
                      >
                        {label} {toCountsByTag[tag]?.[k] ?? 0}
                      </span>
                    ))}
                  </div>
                )}

                {/* PO pills */}
                <div style={{ marginTop: selectedDS !== "DC" ? 4 : 8, paddingTop: 6, borderTop: `1px solid ${cfg.cardBorder}`, display: "flex", gap: 3 }}>
                  {[
                    { k: "noPO",    label: "No PO",   pf: "No PO",            bg: "#F3F4F6", color: "#6B7280", border: "#D1D5DB" },
                    { k: "delayed", label: "Delayed",  pf: "Delayed",          bg: "#FEE2E2", color: "#B91C1C", border: "#FECACA" },
                    { k: "issued",  label: "Issued",   pf: "Issued",           bg: "#D1FAE5", color: "#065F46", border: "#A7F3D0" },
                    { k: "pending", label: "Pend.",    pf: "Pending Approval", bg: "#FEF3C7", color: "#92400E", border: "#FDE68A" },
                  ].map(({ k, label, pf, bg, color, border }) => (
                    <span key={k}
                      onClick={e => { e.stopPropagation(); setFilterTag(tag); setFilterPoStatus(pf); }}
                      title={`${cfg.label} · PO: ${label === "Pend." ? "Pending Approval" : label}`}
                      style={{
                        flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600,
                        padding: "2px 2px", borderRadius: 5, cursor: "pointer",
                        border: `1px solid ${border}`, background: bg, color,
                        whiteSpace: "nowrap", userSelect: "none", lineHeight: 1.4,
                      }}
                      onMouseEnter={e => e.currentTarget.style.filter = "brightness(0.93)"}
                      onMouseLeave={e => e.currentTarget.style.filter = ""}
                    >
                      {label} {poCountsByTag[tag]?.[k] ?? 0}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Filters ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px 10px", flexShrink: 0, flexWrap: "wrap" }}>
          <input
            value={search} onChange={e => {
              const val = e.target.value;
              setSearch(val);
              if (val) { setFilterTag(null); setFilterBrand("All"); setSelectedCat(null); setFilterPoStatus("All"); setFilterToStatus("All"); }
            }}
            placeholder="Search name, SKU or brand…"
            style={{ ...SEL, flex: 1, minWidth: 180, maxWidth: 260, padding: "6px 10px", fontSize: 12 }}
          />
          <select value={filterTag || "all"} onChange={e => setFilterTag(e.target.value === "all" ? null : e.target.value)} style={SEL}>
            <option value="all">All Tags</option>
            <option value="ec">Critical</option>
            <option value="critical">Low Stock</option>
            {selectedDS === "DC" && <option value="dsReqCovered">DS Req Covered</option>}
            <option value="okay">Okay</option>
            <option value="excess">Excess</option>
          </select>
          <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} style={SEL}>
            <option value="All">All Brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={filterPoStatus} onChange={e => setFilterPoStatus(e.target.value)} style={SEL}>
            <option value="All">All PO Status</option>
            <option value="Issued">Issued</option>
            <option value="Pending Approval">Pending Approval</option>
            <option value="Delayed">Delayed</option>
            <option value="No PO">No PO</option>
          </select>
          {selectedDS !== "DC" && (
            <select value={filterToStatus} onChange={e => setFilterToStatus(e.target.value)} style={SEL}>
              <option value="All">All TO Status</option>
              <option value="Draft">Picking</option>
              <option value="In Transit">In Transit</option>
              <option value="No TO">No TO</option>
            </select>
          )}
          <Tooltip text={
            <><div style={{ fontWeight: 700, marginBottom: 4 }}>ECS (Effective Current Stock) = SoH</div>
            <div>Critical — ECS ≤ Min and daily sales ≥ 1 unit</div>
            <div>Low Stock — ECS ≤ Min (slow mover, not urgent)</div>
            {selectedDS === "DC" && <div>DS Req Covered — DC below Min but DS excess covers network gap or DC stock covers all short DS needs (no PO needed)</div>}
            <div>Okay — Min &lt; ECS ≤ Max</div>
            <div>Excess — ECS &gt; Max</div></>
          }>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 18, height: 18, borderRadius: "50%",
              background: "#D1D5DB", flexShrink: 0,
              fontFamily: "Georgia, serif", fontSize: 13, fontWeight: 400,
              color: "#111827", lineHeight: 1, userSelect: "none",
            }}>i</span>
          </Tooltip>
          {(search || filterTag || filterBrand !== "All" || selectedCat || filterPoStatus !== "All" || filterToStatus !== "All") && (
            <button
              onClick={() => { setSearch(""); setFilterTag(null); setFilterBrand("All"); setSelectedCat(null); setFilterPoStatus("All"); setFilterToStatus("All"); }}
              style={{
                border: "none", borderRadius: 6, padding: "5px 12px",
                fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: HR.yellow, color: HR.black,
                whiteSpace: "nowrap", flexShrink: 0,
                display: "flex", alignItems: "center", gap: 5, fontFamily: "inherit",
              }}
            >
              ✕ Clear filters
            </button>
          )}
          <span style={{ fontSize: 11, color: HR.muted, marginLeft: "auto", whiteSpace: "nowrap" }}>
            {filteredRows.length} SKU{filteredRows.length !== 1 ? "s" : ""}
          </span>
          {filteredRows.length > 0 && (
            <button
              onClick={() => {
                const isDCTab = selectedDS === "DC";
                const headers = ["SKU", "Item Name", "Brand", "Stock Health", "SoH", "AFS", "Min", "Max", "ROS", "Req Qty",
                  ...(!isDCTab ? ["DC Stock"] : []),
                  "Rep. Qty", "Rec Qty", "Date", "Est. Delivery", "Ref #", "Status"];
                const rows = filteredRows.map(r => {
                  const isDCInv = !isDCTab && r.invAt === "dc";
                  const po = isDCInv ? null : dsPoData[r.sku];
                  const to = isDCInv ? dsToData[r.sku] : null;
                  const repQty    = isDCInv ? (to?.qty ?? "")                    : (po?.qty ?? "");
                  const recQty    = isDCInv ? (to?.rec_qty != null ? to.rec_qty : "") : (po?.received ?? "");
                  const date      = isDCInv ? (to?.to_date ?? "") : (po?.po_date ?? "");
                  const delivery  = isDCInv ? (to?.to_date ?? "") : (po?.delivery ?? "");
                  const refNum    = isDCInv ? (to?.to_number ?? "") : (po?.po_number ?? "");
                  const status    = isDCInv
                    ? (to ? (TO_STATUS_BADGE[to.status] ?? to.status) : "")
                    : (po ? (PO_STATUS_LABEL[getPoDisplayStatus(po)] ?? po.status) : "");
                  const dcStockVal = !isDCTab && isDCInv
                    ? (() => { const dcLive = activeStockData[r.sku]?.["DC"]; return dcLive != null ? Math.max(0, getLive(dcLive).stockOnHand) : ""; })()
                    : "";
                  return [
                    r.sku,
                    `"${r.name.replace(/"/g, '""')}"`,
                    r.brand !== "—" ? `"${r.brand.replace(/"/g, '""')}"` : "",
                    TC[r.tag].label,
                    Math.max(0, r.stockOnHand), Math.max(0, r.afs),
                    r.min, r.max,
                    r.ros > 0 ? Math.round(r.ros) : 0,
                    r.reorderQty > 0 ? r.reorderQty : "",
                    ...(!isDCTab ? [dcStockVal] : []),
                    repQty, recQty, date, delivery, refNum, status,
                  ];
                });
                const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `stock-health-${selectedDS}${selectedCat ? `-${selectedCat}` : ""}${filterTag ? `-${TC[filterTag].label}` : ""}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              style={{
                display: "flex", alignItems: "center", gap: 4, cursor: "pointer",
                border: `1px solid ${HR.border}`, borderRadius: 5, padding: "3px 8px",
                background: HR.surface, color: HR.textSoft, fontSize: 10,
                fontWeight: 600, whiteSpace: "nowrap", fontFamily: "inherit",
              }}
            >
              ⬇ Download
            </button>
          )}
        </div>

        {/* ── Empty states ────────────────────────────────────────────────── */}
        {!results && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: HR.muted, fontSize: 13 }}>
            Run the model first to see stock health.
          </div>
        )}
        {results && !hasStock && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: HR.muted, fontSize: 13 }}>
            Waiting for first sync — runs automatically every hour at :05 IST.
          </div>
        )}

        {/* ── SKU Table ───────────────────────────────────────────────────── */}
        {results && hasStock && (
          <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", borderTop: `1px solid ${HR.border}` }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: 248 }} />  {/* SKU */}
                <col />                          {/* Item Name — flex */}
                <col style={{ width: 58 }} />   {/* Brand */}
                <col style={{ width: 64 }} />   {/* Stock Health */}
                <col style={{ width: 54 }} />   {/* Stock on Hand */}
                <col style={{ width: 54 }} />   {/* Avail. for Sale */}
                <col style={{ width: 32 }} />   {/* Min */}
                <col style={{ width: 32 }} />   {/* Max */}
                <col style={{ width: 34 }} />   {/* ROS */}
                <col style={{ width: 52 }} />   {/* Req Qty */}
                {selectedDS !== "DC" && <col style={{ width: 44 }} />}  {/* DC Stock */}
                <col style={{ width: 54 }} />   {/* Ordered Qty */}
                <col style={{ width: 58 }} />   {/* Received Qty */}
                <col style={{ width: 60 }} />   {/* PO Date */}
                <col style={{ width: 64 }} />   {/* Est. Delivery */}
                <col style={{ width: 86 }} />   {/* PO Number */}
                <col style={{ width: 78 }} />   {/* PO Status */}
              </colgroup>
              <thead>
                <tr>
                  {[
                    ["SKU",            "left",   "4px 6px", true,  null        ],
                    ["Item Name",      "left",   "4px 6px", false, "name"      ],
                    ["Brand",          "left",   "4px 6px", false, "brand"     ],
                    ["Stock Health",   "center", "4px 4px", false, null        ],
                    ["SoH",            "center", "4px 4px", false, "ecs"       ],
                    ["AFS",            "center", "4px 4px", false, null        ],
                    ["Min",            "center", "4px 4px", false, null        ],
                    ["Max",            "center", "4px 4px", false, null        ],
                    ["ROS",            "center", "4px 4px", false, null        ],
                    ["Req Qty",        "center", "4px 4px", false, "reorderQty"],
                    ...(selectedDS !== "DC" ? [["DC Stock", "center", "4px 4px", false, null]] : []),
                    ["Rep. Qty",       "center", "4px 4px", false, null        ],
                    ["Rec Qty",        "center", "4px 4px", false, null        ],
                    ["Date",           "center", "4px 4px", false, "date"      ],
                    ["Est. Delivery",  "center", "4px 4px", false, "delivery"  ],
                    ["Ref #",          "left",   "4px 6px", false, null        ],
                    ["Status",         "center", "4px 4px", false, "status"    ],
                  ].map(([label, align, pad, isSkuCol, sortKey], i) => {
                    const isSortable   = !!sortKey;
                    const isActiveSort = sortCol === sortKey;
                    return (
                      <th key={i}
                        onClick={isSortable ? () => handleSort(sortKey) : undefined}
                        style={{
                          padding: pad, textAlign: align, fontSize: 9, fontWeight: 700,
                          color: isActiveSort ? HR.text : HR.textSoft,
                          background: HR.surfaceLight,
                          borderBottom: `3px solid ${HR.yellow}`,
                          ...(isSkuCol ? { borderLeft: "3px solid transparent" } : {}),
                          position: "sticky", top: 0, zIndex: 2,
                          whiteSpace: "nowrap", overflow: "hidden",
                          cursor: isSortable ? "pointer" : "default",
                          userSelect: "none",
                        }}>
                        {isSortable ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                            {label}
                            <span style={{ fontSize: 8, color: isActiveSort ? HR.text : HR.border, lineHeight: 1 }}>
                              {isActiveSort ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                            </span>
                          </span>
                        ) : label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={selectedDS !== "DC" ? 17 : 16} style={{ padding: 36, textAlign: "center", color: HR.muted, fontSize: 11 }}>
                      No SKUs match the current filter.
                    </td>
                  </tr>
                )}
                {filteredRows.map((row, idx) => {
                  const cfg        = TC[row.tag];
                  const isNewGroup = row.tag !== (idx > 0 ? filteredRows[idx - 1].tag : null);
                  const topBorder  = isNewGroup ? `2px solid ${cfg.borderColor}55` : `1px solid ${HR.border}`;
                  const TP = "2px 6px";
                  const NP = "2px 4px";
                  const FS = 10;
                  return (
                    <tr key={row.sku}
                      style={{ background: cfg.rowBg }}
                      onMouseEnter={e => e.currentTarget.style.filter = "brightness(0.94)"}
                      onMouseLeave={e => e.currentTarget.style.filter = ""}>

                      {/* SKU — sized for 40-char max; copy icon */}
                      <td style={{ padding: TP, borderTop: topBorder, borderLeft: `3px solid ${cfg.borderColor}`, overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <span style={{ fontFamily: "monospace", fontSize: 9.5, color: HR.muted }}>{row.sku}</span>
                          <span
                            onClick={e => copySku(row.sku, e)}
                            title="Copy SKU"
                            style={{ cursor: "pointer", flexShrink: 0, color: copiedSku === row.sku ? "#059669" : "#BBAC97", lineHeight: 1, display: "flex", alignItems: "center" }}
                          >
                            {copiedSku === row.sku
                              ? <span style={{ fontSize: 9, fontWeight: 700, color: "#059669" }}>✓</span>
                              : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                </svg>
                            }
                          </span>
                        </div>
                      </td>

                      {/* Item Name — truncates when very long */}
                      <td title={row.name} style={{ padding: TP, borderTop: topBorder, fontSize: FS, fontWeight: 400, color: HR.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.name}
                      </td>

                      {/* Brand */}
                      <td style={{ padding: TP, borderTop: topBorder, fontSize: 9.5, color: HR.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.brand !== "—" ? row.brand : ""}
                      </td>

                      {/* Stock Health badge */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center" }}>
                        <span style={{ display: "inline-block", padding: "1px 5px", borderRadius: 7, fontSize: 8.5, fontWeight: 700, whiteSpace: "nowrap", background: cfg.cardBg, color: cfg.textColor }}>
                          {cfg.short}
                        </span>
                      </td>

                      {/* Stock on Hand — health tag highlight (ECS basis) */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontWeight: 600, color: cfg.textColor, background: cfg.ecsBg, fontVariantNumeric: "tabular-nums" }}>
                        {Math.max(0, row.stockOnHand)}
                      </td>

                      {/* Available for Sale — reference only */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: HR.textSoft, fontVariantNumeric: "tabular-nums" }}>
                        {Math.max(0, row.afs)}
                      </td>

                      {/* Min */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: HR.muted, fontVariantNumeric: "tabular-nums" }}>{row.min}</td>

                      {/* Max */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: HR.muted, fontVariantNumeric: "tabular-nums" }}>{row.max}</td>

                      {/* ROS — rounded */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: HR.muted, fontVariantNumeric: "tabular-nums" }}>
                        {row.ros > 0 ? Math.round(row.ros) : "—"}
                      </td>

                      {/* Req Qty */}
                      <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontWeight: row.reorderQty > 0 ? 600 : 400, color: row.reorderQty > 0 ? cfg.textColor : HR.muted, fontVariantNumeric: "tabular-nums" }}>
                        {row.reorderQty > 0 ? row.reorderQty : "—"}
                      </td>

                      {/* DC Stock — DS tabs only, meaningful for DC-inv SKUs. SoH basis (matches ECS). */}
                      {selectedDS !== "DC" && (() => {
                        const dcLive = activeStockData[row.sku]?.["DC"];
                        const dcSoh  = dcLive != null ? Math.max(0, getLive(dcLive).stockOnHand) : null;
                        const show   = row.invAt === "dc";
                        return (
                          <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontVariantNumeric: "tabular-nums",
                            fontWeight: show && dcSoh > 0 ? 600 : 400,
                            color: !show ? HR.muted : dcSoh == null ? HR.muted : dcSoh > 0 ? "#16A34A" : "#DC2626",
                          }}>
                            {show ? (dcSoh != null ? dcSoh : "—") : "—"}
                          </td>
                        );
                      })()}

                      {/* ── Order columns (PO for DS-inv, TO for DC-inv on DS tabs) ── */}
                      {(() => {
                        const isDC    = selectedDS === "DC";
                        const isDCInv = !isDC && row.invAt === "dc";
                        if (isDCInv) {
                          // Transfer Order columns
                          const to = dsToData[row.sku];
                          const toSt = to ? TO_STATUS_STYLE[to.status] : null;
                          return (
                            <>
                              {/* Rep. Qty — green when > 0 */}
                              <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontVariantNumeric: "tabular-nums", fontWeight: to?.qty > 0 ? 600 : 400, color: to?.qty > 0 ? "#16A34A" : HR.muted }}>
                                {to ? to.qty : "—"}
                              </td>
                              {/* Rec Qty — populated for transferred TOs */}
                              <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontVariantNumeric: "tabular-nums", color: to?.rec_qty > 0 ? "#065F46" : HR.muted }}>
                                {to?.rec_qty != null ? to.rec_qty : "—"}
                              </td>
                              {/* Date */}
                              <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: HR.muted }}>
                                {to ? fmtDate(to.to_date) : "—"}
                              </td>
                              {/* Est. Delivery = same as TO Date */}
                              <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: to ? HR.textSoft : HR.muted }}>
                                {to ? fmtDate(to.to_date) : "—"}
                              </td>
                              {/* Ref # — TO number, links to Zoho Books */}
                              <td style={{ padding: "2px 6px", borderTop: topBorder, fontSize: FS, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {to?.to_number ? (
                                  <a href={`${ZOHO_INV_URL}/transferorders/${to.to_id}`}
                                     target="_blank" rel="noopener noreferrer"
                                     style={{ color: "#1D4ED8", textDecoration: "underline", fontWeight: 500 }}>
                                    {to.to_number}
                                  </a>
                                ) : "—"}
                              </td>
                              {/* Status badge */}
                              <td style={{ padding: NP, borderTop: topBorder, textAlign: "center" }}>
                                {to && toSt ? (
                                  <span style={{ display: "inline-block", padding: "1px 5px", borderRadius: 7, fontSize: 8.5, fontWeight: 700, whiteSpace: "nowrap", background: toSt.bg, color: toSt.color }}>
                                    {TO_STATUS_BADGE[to.status] ?? to.status}
                                  </span>
                                ) : <span style={{ color: HR.muted, fontSize: FS }}>—</span>}
                              </td>
                            </>
                          );
                        }

                        // Purchase Order columns
                        const po = dsPoData[row.sku];
                        return (
                          <>
                            {/* Rep. Qty — green when > 0 */}
                            <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontVariantNumeric: "tabular-nums", fontWeight: po?.qty > 0 ? 600 : 400, color: po?.qty > 0 ? "#16A34A" : HR.muted }}>
                              {po ? po.qty : "—"}
                            </td>
                            {/* Rec Qty */}
                            <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, fontVariantNumeric: "tabular-nums", color: po ? (po.received > 0 ? "#065F46" : HR.muted) : HR.muted }}>
                              {po ? (po.received ?? 0) : "—"}
                            </td>
                            {/* Date */}
                            <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: HR.muted }}>
                              {po ? fmtDate(po.po_date) : "—"}
                            </td>
                            {/* Est. Delivery */}
                            <td style={{ padding: NP, borderTop: topBorder, textAlign: "center", fontSize: FS, color: po?.delivery ? HR.textSoft : HR.muted }}>
                              {po?.delivery ? fmtDate(po.delivery) : "—"}
                            </td>
                            {/* Ref # — PO number, links to Zoho Inventory */}
                            <td style={{ padding: "2px 6px", borderTop: topBorder, fontSize: FS, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {po?.po_number ? (
                                po.po_id ? (
                                  <a href={`${ZOHO_INV_URL}/purchaseorders/${po.po_id}`}
                                     target="_blank" rel="noopener noreferrer"
                                     style={{ color: "#1D4ED8", textDecoration: "underline", fontWeight: 500 }}>
                                    {po.po_number}
                                  </a>
                                ) : <span style={{ color: HR.textSoft }}>{po.po_number}</span>
                              ) : "—"}
                            </td>
                            {/* Status badge */}
                            <td style={{ padding: NP, borderTop: topBorder, textAlign: "center" }}>
                              {po ? (() => {
                                const ds = getPoDisplayStatus(po);
                                const st = PO_STATUS_STYLE[ds] ?? PO_STATUS_STYLE[po.status];
                                return st ? (
                                  <span style={{ display: "inline-block", padding: "1px 5px", borderRadius: 7, fontSize: 8.5, fontWeight: 700, whiteSpace: "nowrap", background: st.bg, color: st.color }}>
                                    {PO_STATUS_BADGE[ds] ?? ds}
                                  </span>
                                ) : <span style={{ color: HR.muted, fontSize: FS }}>—</span>;
                              })() : <span style={{ color: HR.muted, fontSize: FS }}>—</span>}
                            </td>
                          </>
                        );
                      })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Nav Item sub-component ───────────────────────────────────────────────────
function NavItem({ label, subLabel, ecCount, critCount, isSelected, onClick }) {
  const [hovered, setHovered] = useState(false);
  const hasBadge   = ecCount > 0 || critCount > 0;
  const badgeCfg   = ecCount > 0 ? TC.ec : TC.critical;
  const badgeCount = ecCount > 0 ? ecCount : critCount;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "9px 12px",
        cursor: "pointer",
        borderBottom: `1px solid ${HR.border}`,
        borderLeft: `3px solid ${isSelected ? HR.yellow : "transparent"}`,
        background: isSelected ? "#FFFBEA" : hovered ? HR.surfaceLight : HR.surface,
        transition: "background 0.1s",
        flexShrink: 0,
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: isSelected ? 700 : 500,
          color: isSelected ? HR.black : HR.textSoft,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
        }}>
          {label}
        </span>
        {hasBadge && (
          <span style={{ background: badgeCfg.cardBg, color: badgeCfg.textColor, borderRadius: 9, padding: "1px 6px", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
            {badgeCount}
          </span>
        )}
      </div>
      <div style={{ fontSize: 9, color: HR.muted, marginTop: 2 }}>{subLabel}</div>
    </div>
  );
}
