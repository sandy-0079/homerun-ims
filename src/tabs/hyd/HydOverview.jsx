// Hyderabad Overview: KPI cards for HYDS01 Pati, then the four report lists.
import React, { useMemo } from "react";
import { hydOverviewKpis, uniqueOverrideSkus } from "../../hyd/hydStats.js";
import { card, h2, note, fmtInr, fmtNum } from "./hydStyles.js";
import { Kpi, Collapsible, SkuList } from "./HydUi.jsx";

export default function HydOverview({ invoiceData, skuMaster, priceData, hydState, hydRun }) {
  const k = useMemo(
    () => hydState && hydOverviewKpis({ results: hydRun?.results, floors: hydState.floors, priceData, invoiceData, hydParams: hydState.hydParams }),
    [hydState, hydRun, priceData, invoiceData],
  );
  if (!hydState) return <div style={card}><span style={note}>Loading Hyderabad…</span></div>;
  const report = hydRun?.report;
  const overrides = uniqueOverrideSkus(report?.overrides);
  const sub = k.latestDate ? `to ${k.latestDate}` : "no valid invoice date";

  return (
    <div>
      <div style={h2}>HYDERABAD — HYDS01 Pati</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Kpi label="Mode" value={k.mode} />
        <Kpi label="SKUs in range" value={fmtNum(k.inRange)} sub="Max > 0 at HYDS01" />
        <Kpi label="Floor rows" value={fmtNum(k.floorRows)} sub={`${fmtNum(k.floorRowsInRange)} with Min/Max > 0`} />
        <Kpi label="Inv Value Min" value={fmtInr(k.invMin)} />
        <Kpi label="Inv Value Max" value={fmtInr(k.invMax)} />
        <Kpi label="Pati units · 7 days" value={fmtNum(k.sold7)} sub={sub} />
        <Kpi label="Pati units · 30 days" value={fmtNum(k.sold30)} sub={sub} />
      </div>
      {!report && <div style={card}><span style={note}>No engine report (see the error above).</span></div>}
      {report && (
        <>
          <Collapsible title="Floor SKUs inactive in Zoho (stay 0/0)" count={report.inactiveFloored.length}>
            <SkuList items={report.inactiveFloored} skuMaster={skuMaster} />
          </Collapsible>
          <Collapsible title="Floor rows overriding Purchase=OFF / Supplier / Dead Stock" count={overrides.length}>
            <SkuList items={overrides} skuMaster={skuMaster} render={o => o.reasons.join(", ")} />
          </Collapsible>
          <Collapsible title="Pati sales outside the range" count={report.outOfRangeSales.length}>
            <SkuList items={report.outOfRangeSales} skuMaster={skuMaster} />
          </Collapsible>
          <Collapsible title="Floor SKUs not in the SKU master" count={report.unknownFloorSkus.length}>
            <SkuList items={report.unknownFloorSkus} />
          </Collapsible>
        </>
      )}
    </div>
  );
}
