// Hyderabad tab bodies. Rendered by App.jsx in place of the Bangalore tab bodies
// when city === "hyd"; receives everything it needs as props and never touches a
// Bangalore row. Prop interface:
//   { tab, isAdmin, invoiceData, skuMaster, priceData, deadStock /*Set*/,
//     stockData, stockDataAccounting, uploadedAtPerDS,
//     hydState, setHydState, hydRun /* {results, report} | null */,
//     blrParams /* Bangalore's applied params, for "Reset to Bangalore" */,
//     setTab /* switch the Hyderabad tab — Overview's SKU row opens SKU Detail */,
//     OverviewTabComponent, SKUDetailTabComponent /* Bangalore's own screens, passed in
//       by App.jsx: importing them from App here would be a circular import */,
//     outputDemandThrough, outputFreshness, provRaw, fmtStamp /* App's Tool Output gate +
//       footnotes: both cities compute from the same invoice row, so one gate serves both */ }
import React, { useMemo, useState } from "react";
import { card, note, banner } from "./hydStyles.js";
import ToolOutputTab from "../ToolOutputTab.jsx";
import HydUploadPanel from "./HydUploadPanel.jsx";
import HydLogicTweaker from "./HydLogicTweaker.jsx";
import HydPlywoodPanel from "./HydPlywoodPanel.jsx";
import StockHealthTab from "../StockHealthTab.jsx";
import HydStockNotice from "./HydStockNotice.jsx";
import { HYD_DS_LIST, hydRowsOnly } from "../../city.js";
import { hydReadFailed } from "../../hyd/hydStore.js";
import { buildHydPoCsv, hydPoCsvFilename, HYD_PO_CSV_HEADERS } from "../../hyd/hydPoCsv.js";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { todayLocalIso } from "./hydStyles.js";

// Sync Now for Pati: its own group, never a branch added to a Bangalore group.
const HYD_SYNC_GROUPS = [["HYDS01"]];
// SKU Detail's "not trading yet" gate: Bangalore's openingDSList names Bangalore
// stores, so Hyderabad passes its own (empty) list. A constant keeps the memo stable.
const HYD_OPENING = [];
// Tool Output: Pati has no Bangalore manual overrides, and no Inner Case Pack card (no DC).
const NO_OVERRIDES = {};
const NOOP = () => {};
const UNKNOWN_FRESHNESS = { state: "unknown", blocked: false, pageThrough: null, liveThrough: null };

function Errors({ hydState, hydRun }) {
  const errors = [...(hydState?.loadErrors || []), ...(hydRun?.error ? [`engine: ${hydRun.error}`] : [])];
  if (!errors.length) return null;
  return <div style={banner("error")}>{errors.map(e => <div key={e}>{e}</div>)}</div>;
}

export default function HydShell(props) {
  const { tab, hydState, hydRun, invoiceData, OverviewTabComponent: OverviewTab, SKUDetailTabComponent: SKUDetailTab } = props;
  // Stock Health notice dismissal: this page session only (survives tab switches,
  // not a reload). Before the early return — hooks must run on every render.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  // Overview / SKU Detail UI state — Hyderabad's own, so switching city never carries
  // Bangalore's store or drill (e.g. "DS03") into a one-store list. Same initial
  // values as Bangalore's in App.jsx.
  const [ovPeriod, setOvPeriod] = useState("L90D");
  const [ovDateFrom, setOvDateFrom] = useState("");
  const [ovDateTo, setOvDateTo] = useState("");
  const [ovStore, setOvStore] = useState("All");
  const [ovDrill, setOvDrill] = useState(null);
  const [sdSku, setSdSku] = useState("");
  const [sdSearch, setSdSearch] = useState("");
  const [sdPeriod, setSdPeriod] = useState("L90D");
  const [sdDateFrom, setSdDateFrom] = useState("");
  const [sdDateTo, setSdDateTo] = useState("");
  const [sdDsView, setSdDsView] = useState("All");
  const patiRows = useMemo(() => hydRowsOnly(invoiceData || []), [invoiceData]);
  // NETWORK dates (both cities), not Pati's own: the Hyderabad engine windows on the
  // network's last N dates (hydEngine.networkWindowDates), so "L45D" here is the same
  // 45 days the targets were computed on, and a day Pati sold nothing still counts as
  // a day (Rate of Sale divides by it). Same formula as App.jsx's invoiceDateRange.
  const invoiceDateRange = useMemo(() => {
    if (!invoiceData || !invoiceData.length) return { min: "", max: "", dates: [] };
    const dates = [...new Set(invoiceData.map(r => r.date))].sort();
    return { min: dates[0], max: dates[dates.length - 1], dates };
  }, [invoiceData]);
  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;
  const storeProps = { dsList: HYD_DS_LIST, includeDC: false };
  return (
    <div>
      {hydReadFailed(hydState) && (
        <div style={banner("error")}><b>Hyderabad data could not be read — downloads and saves are disabled until reload.</b></div>
      )}
      <Errors hydState={hydState} hydRun={hydRun} />
      {tab === "overview" && OverviewTab && (
        <OverviewTab {...storeProps}
          invoiceData={patiRows} results={hydRun?.results ?? null} priceData={props.priceData || {}}
          params={hydState.hydParams} invoiceDateRange={invoiceDateRange}
          period={ovPeriod} setPeriod={setOvPeriod}
          dateFrom={ovDateFrom} setDateFrom={setOvDateFrom}
          dateTo={ovDateTo} setDateTo={setOvDateTo}
          store={ovStore} setStore={setOvStore}
          drill={ovDrill} setDrill={setOvDrill}
          onNavigateToSKU={(skuId) => { setSdSku(skuId); setSdSearch(skuId); props.setTab?.("skuDetail"); }} />
      )}
      {tab === "skuDetail" && SKUDetailTab && (
        <SKUDetailTab {...storeProps} openingList={HYD_OPENING}
          invoiceData={patiRows} skuMaster={props.skuMaster} results={hydRun?.results ?? null}
          params={hydState.hydParams} invoiceDateRange={invoiceDateRange} priceData={props.priceData || {}}
          skuId={sdSku} setSkuId={setSdSku}
          searchVal={sdSearch} setSearchVal={setSdSearch}
          period={sdPeriod} setPeriod={setSdPeriod}
          dateFrom={sdDateFrom} setDateFrom={setSdDateFrom}
          dateTo={sdDateTo} setDateTo={setSdDateTo}
          dsView={sdDsView} setDsView={setSdDsView} />
      )}
      {tab === "output" && (
        // Bangalore's Tool Output tab: Hyderabad PO (its own frozen 9-column file), DS Level
        // for HYDS01, SKU Master, Purchase Prices. DC + Inner Case Pack hidden (no DC).
        // Zero Sale is hidden (zeroSaleLists={null}): it is a delisting shortlist for the
        // shared catalogue, so a Pati-only "sold nothing" list would put SKUs that sell in
        // Bangalore on it, and its windows count the dates PRESENT in the rows, which for
        // Pati rows are Pati's sale days, not calendar days.
        <ToolOutputTab {...storeProps}
          results={hydRun?.results ?? null} skuMaster={props.skuMaster || {}} params={hydState.hydParams}
          priceData={props.priceData || {}} coreOverrides={NO_OVERRIDES}
          provRaw={props.provRaw || {}} fmtStamp={props.fmtStamp || NOOP}
          outputDemandThrough={props.outputDemandThrough ?? null}
          outputFreshness={props.outputFreshness || UNKNOWN_FRESHNESS}
          zeroSaleLists={null} packsAt={null} setPacksAt={NOOP}
          downloadsDisabled={hydReadFailed(hydState)}
          poCard={{
            title: "PO — Hyderabad (HYDS01 Pati)",
            note: <>Every master SKU with <b>Pati&apos;s Min/Max</b> and Hyderabad&apos;s effective Purchase decision. Targets only — no stock. Mode: <b>{isFloorsOnly(hydState.hydParams, "HYDS01") ? "Floors only" : "Engine"}</b>.</>,
            columns: HYD_PO_CSV_HEADERS.length,
            build: () => buildHydPoCsv({ skuMaster: props.skuMaster, hydResults: hydRun?.results, floors: hydState.floors, hydParams: hydState.hydParams }),
            filename: () => hydPoCsvFilename(todayLocalIso()),
          }} />
      )}
      {tab === "upload" && <HydUploadPanel {...props} />}
      {tab === "logic" && <HydLogicTweaker {...props} />}
      {tab === "plywood" && <HydPlywoodPanel {...props} />}
      {tab === "stockHealth" && !noticeDismissed && (
        <HydStockNotice report={hydRun?.report} skuMaster={props.skuMaster} onDismiss={() => setNoticeDismissed(true)} />
      )}
      {tab === "stockHealth" && (
        // One store, no DC. No poData/toData: Pati has no TOs, and its POs reach
        // Stock Health only once sync-orders covers HYDS01, so the PO columns read "—".
        <StockHealthTab results={hydRun?.results ?? null} skuMaster={props.skuMaster}
          stockData={props.stockData || {}} stockDataAccounting={props.stockDataAccounting || {}}
          uploadedAtPerDS={props.uploadedAtPerDS}
          dsList={HYD_DS_LIST} includeDC={false} syncGroups={HYD_SYNC_GROUPS} syncOrders={false}
          defaultDS="HYDS01" filePrefix="Hyderabad_" />
      )}
    </div>
  );
}
