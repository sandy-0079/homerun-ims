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
//       footnotes: both cities compute from the same invoice row, so one gate serves both */,
//     hydDraft, setHydDraft /* the unsaved Logic Tweaker draft {base, value} — held by App so
//       the city toggle and the Hyderabad tab bar can guard it (src/hyd/hydDraft.js) */,
//     inputSummaries, inputProvenance /* App's Upload Data counts + provenance pills, shown on
//       the shared (read-only) cards of Hyderabad's Upload Data */,
//     hydPlywoodDraft, setHydPlywoodDraft /* the unsaved Plywood draft {base, value} — held by
//       App for the same guard; passed through to HydPlywoodPanel */ }
import React, { useMemo, useState } from "react";
import { card, note, banner, SETTINGS_UNREADABLE } from "./hydStyles.js";
import ToolOutputTab from "../ToolOutputTab.jsx";
import UploadDataTab from "../UploadDataTab.jsx";
import HydFloorsCard from "./HydFloorsCard.jsx";
import LogicTweakerTab from "../LogicTweakerTab.jsx";
import HydLogicTop from "./HydLogicTop.jsx";
import HydPlywoodPanel from "./HydPlywoodPanel.jsx";
import StockHealthTab from "../StockHealthTab.jsx";
import { HYD_DS_LIST, hydRowsOnly } from "../../city.js";
import { hydReadFailed } from "../../hyd/hydStore.js";
import { buildHydPoCsv, hydPoCsvFilename, HYD_PO_CSV_HEADERS } from "../../hyd/hydPoCsv.js";
import { isFloorsOnly } from "../../hyd/hydParams.js";
import { todayLocalIso } from "./hydStyles.js";
import { hydDraftValue, isHydDraftDirty, hydOnlyChangelog } from "../../hyd/hydDraft.js";
import { runHydApply } from "../../hyd/hydApply.js";
import { summariseInputs } from "../../inputSummary.js";

// Sync Now for Pati: its own group, never a branch added to a Bangalore group.
const HYD_SYNC_GROUPS = [["HYDS01"]];
// SKU Detail's "not trading yet" gate: Bangalore's openingDSList names Bangalore
// stores, so Hyderabad passes its own (empty) list. A constant keeps the memo stable.
const HYD_OPENING = [];
// Tool Output: Pati has no Bangalore manual overrides, and no Inner Case Pack card (no DC).
const NO_OVERRIDES = {};
const NOOP = () => {};
const UNKNOWN_FRESHNESS = { state: "unknown", blocked: false, pageThrough: null, liveThrough: null };
// Logic Tweaker: the Bangalore-network sections are hidden, so their inputs are inert.
const NO_ROWS = [];
// Spec §3.3: the copy must be freezable on creation, so a never-stored params/hydGlobal
// enables Apply with no edits, and the changelog says what that Apply does.
export const FIRST_SAVE_LINE = "First save — creates Hyderabad's own copy (params/hydGlobal)";
// Upload Data: shared cards' provenance pill when App passes none.
const NO_PROVENANCE = { source: "none", level: "unknown", note: "Provenance is shown in Bangalore", at: null };

function Errors({ hydState, hydRun }) {
  const errors = [...(hydState?.loadErrors || []), ...(hydRun?.error ? [`engine: ${hydRun.error}`] : [])];
  if (!errors.length) return null;
  return <div style={banner("error")}>{errors.map(e => <div key={e}>{e}</div>)}</div>;
}

export default function HydShell(props) {
  const { tab, hydState, hydRun, invoiceData, OverviewTabComponent: OverviewTab, SKUDetailTabComponent: SKUDetailTab } = props;
  // Upload Data's ⓘ hover (UI only). Before the early return — hooks run on every render.
  const [infoCard, setInfoCard] = useState(null);
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
  // Logic Tweaker UI state (the draft itself is App's: props.hydDraft).
  const [logicAdvanced, setLogicAdvanced] = useState(false);
  const [logicConfirm, setLogicConfirm] = useState(false);
  const [logicStatus, setLogicStatus] = useState(null);
  const [applying, setApplying] = useState(false);
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

  // Bangalore's Logic Tweaker over the Hyderabad draft. Apply writes only params/hydGlobal.
  function renderLogic() {
    if (!props.isAdmin) return <div style={card}><span style={note}>Logic Tweaker is admin-only.</span></div>;
    const saved = hydState.hydParams;
    if (!saved) return <div style={card}><span style={note}>{SETTINGS_UNREADABLE}</span></div>;
    const draft = hydDraftValue(props.hydDraft, saved);
    const dirty = isHydDraftDirty(props.hydDraft, saved);
    const setDraft = (value) => props.setHydDraft?.({ base: saved, value });
    // try/finally inside runHydApply: a thrown save can't leave Apply stuck disabled.
    const onApply = (value) => runHydApply({ draft: value, hydState, setHydState: props.setHydState,
      confirm: (m) => window.confirm(m), setApplying, setStatus: setLogicStatus });
    const firstSave = hydState.stored?.params === false;
    return (
      <LogicTweakerTab showNetworkSections={false} leadTimeLabel="Brand Lead Time (vendor → Pati)"
        params={draft} savedParams={saved} saveParams={setDraft} setParams={setDraft}
        onApply={onApply} hasChanges={dirty || firstSave} applyDisabled={hydReadFailed(hydState) || applying}
        extraChangelog={[...hydOnlyChangelog(saved, draft), ...(firstSave ? [FIRST_SAVE_LINE] : [])]}
        skuMaster={props.skuMaster || {}} isAdmin blrInvoice={NO_ROWS} missing={NO_ROWS} uploading={null} handlePincodeMap={NOOP}
        advancedOpen={logicAdvanced} setAdvancedOpen={setLogicAdvanced}
        showLogicConfirm={logicConfirm} setShowLogicConfirm={setLogicConfirm}
        topSlot={<HydLogicTop draft={draft} setDraft={setDraft} dirty={dirty} status={logicStatus}
          hydState={hydState} hydRun={hydRun} blrParams={props.blrParams}
          invoiceData={invoiceData} skuMaster={props.skuMaster} priceData={props.priceData} deadStock={props.deadStock} />} />
    );
  }
  // Bangalore's Upload Data in "hyd" mode: the Hyderabad floors card first (the only
  // active card), every other card shared and inert. NO Bangalore handler is passed —
  // each one writes a Bangalore row via saveTeamData / applyAndRun.
  function renderUpload() {
    if (!props.isAdmin) return <div style={card}><span style={note}>Upload Data is admin-only.</span></div>;
    const inputSummaries = props.inputSummaries || summariseInputs({ invoiceData: invoiceData || [], skuMaster: props.skuMaster || {},
      priceData: props.priceData || {}, minReqQty: {}, newSKUQty: {}, deadStock: props.deadStock || new Set(), skuCeiling: {} });
    const inputProvenance = props.inputProvenance || Object.fromEntries(Object.keys(inputSummaries).map(k => [k, NO_PROVENANCE]));
    return (
      <UploadDataTab mode="hyd" inputSummaries={inputSummaries} inputProvenance={inputProvenance}
        infoCard={infoCard} setInfoCard={setInfoCard} uploadedFiles={NO_OVERRIDES} uploading={null}
        extraCards={<HydFloorsCard invoiceData={invoiceData} skuMaster={props.skuMaster} priceData={props.priceData}
          deadStock={props.deadStock} hydState={hydState} setHydState={props.setHydState} hydRun={hydRun} />} />
    );
  }
  return (
    <div>
      {hydReadFailed(hydState) && (
        <div style={banner("error")}><b>Hyderabad data could not be read — downloads and saves are disabled until reload.</b></div>
      )}
      <Errors hydState={hydState} hydRun={hydRun} />
      {tab === "overview" && OverviewTab && (
        <OverviewTab {...storeProps}
          invoiceData={patiRows} results={hydRun?.results ?? null} priceData={props.priceData || {}}
          params={hydState.hydParams} invoiceDateRange={invoiceDateRange} periodDates={invoiceDateRange.dates}
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
          downloadsDisabled={hydReadFailed(hydState)} filePrefix="Hyderabad_"
          poCard={{
            title: "PO — Hyderabad (HYDS01 Pati)",
            note: <>Every master SKU with <b>Pati&apos;s Min/Max</b> and Hyderabad&apos;s effective Purchase decision. Targets only — no stock. Mode: <b>{isFloorsOnly(hydState.hydParams, "HYDS01") ? "Floors only" : "Engine"}</b>.</>,
            columns: HYD_PO_CSV_HEADERS.length,
            build: () => buildHydPoCsv({ skuMaster: props.skuMaster, hydResults: hydRun?.results, floors: hydState.floors, hydParams: hydState.hydParams }),
            filename: () => hydPoCsvFilename(todayLocalIso()),
          }} />
      )}
      {tab === "upload" && renderUpload()}
      {tab === "logic" && renderLogic()}
      {tab === "plywood" && <HydPlywoodPanel {...props} />}
      {tab === "stockHealth" && (
        // One store, no DC. No poData/toData: Pati has no TOs, and its POs reach
        // Stock Health only once sync-orders covers HYDS01, so the PO columns read "—".
        <StockHealthTab results={hydRun?.results ?? null} skuMaster={props.skuMaster}
          stockData={props.stockData || {}} stockDataAccounting={props.stockDataAccounting || {}}
          uploadedAtPerDS={props.uploadedAtPerDS} floors={hydState?.floors}
          dsList={HYD_DS_LIST} includeDC={false} syncGroups={HYD_SYNC_GROUPS} syncOrders={false}
          defaultDS="HYDS01" filePrefix="Hyderabad_" downloadsDisabled={hydReadFailed(hydState)} />
      )}
    </div>
  );
}
