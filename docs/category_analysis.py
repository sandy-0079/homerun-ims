#!/usr/bin/env python3
"""Category-level inventory strategy analysis for HomeRun IMS."""

import pandas as pd
import numpy as np
from collections import defaultdict
import re
import os

# ── Load and filter ──────────────────────────────────────────────────────────
CSV_PATH = "/Users/sandy/Downloads/Invoices - Jan 1 - Mar 30.csv"
OUTPUT_PATH = "/Users/sandy/Documents/GitHub/homerun-ims/docs/category-analysis.md"

df = pd.read_csv(CSV_PATH)
df = df[df["Invoice Status"].isin(["Closed", "Overdue"])].copy()
df["Invoice Date"] = pd.to_datetime(df["Invoice Date"])
df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0).astype(int)

# Extract DS ID from location name
df["DS"] = df["Line Item Location Name"].str.extract(r"^(DS\d+)", expand=False)
df = df.dropna(subset=["DS", "SKU", "Category Name"])

# ── Global date info ─────────────────────────────────────────────────────────
all_dates = sorted(df["Invoice Date"].unique())
total_unique_dates = len(all_dates)
# Use last 90 unique sale dates (or all if fewer)
dates_90 = all_dates[-90:] if total_unique_dates >= 90 else all_dates
num_days = len(dates_90)
date_set_90 = set(dates_90)
df_90 = df[df["Invoice Date"].isin(date_set_90)]

print(f"Date range: {pd.Timestamp(dates_90[0]).date()} to {pd.Timestamp(dates_90[-1]).date()}")
print(f"Unique sale dates used: {num_days}")
print(f"Total rows after filter: {len(df_90)}")
print()

# ── Build per SKU×DS daily qty maps ──────────────────────────────────────────
# group by SKU, DS, date
daily = df_90.groupby(["SKU", "DS", "Invoice Date"]).agg(
    qty=("Quantity", "sum"),
    order_lines=("Invoice Number", "count")
).reset_index()

# also need category per SKU
sku_cat = df_90.groupby("SKU")["Category Name"].first().to_dict()

# ── Movement tag function ────────────────────────────────────────────────────
def movement_tag(non_zero_days, num_days):
    if non_zero_days == 0:
        return "Super Slow"
    avg_interval = num_days / non_zero_days
    if avg_interval <= 2:
        return "Super Fast"
    elif avg_interval <= 4:
        return "Fast"
    elif avg_interval <= 7:
        return "Moderate"
    elif avg_interval <= 10:
        return "Slow"
    else:
        return "Super Slow"

# ── Compute per SKU×DS stats ─────────────────────────────────────────────────
records = []
for (sku, ds), grp in daily.groupby(["SKU", "DS"]):
    cat = sku_cat.get(sku, "Unknown")
    nzd = len(grp[grp["qty"] > 0])
    total_qty = grp["qty"].sum()
    total_lines = grp["order_lines"].sum()
    mt = movement_tag(nzd, num_days)

    # Order qty volatility: CV of per-order-line qtys
    # We use per-day qty as proxy (each row is a day aggregation)
    day_qtys = grp[grp["qty"] > 0]["qty"].values
    n_orders = len(day_qtys)
    if n_orders >= 3:
        cv_qty = np.std(day_qtys, ddof=1) / np.mean(day_qtys) if np.mean(day_qtys) > 0 else 0
    else:
        cv_qty = np.nan

    # Timing volatility: CV of gaps between consecutive order dates
    order_dates = sorted(grp[grp["qty"] > 0]["Invoice Date"].values)
    if len(order_dates) >= 3:
        gaps = np.diff(order_dates).astype("timedelta64[D]").astype(float)
        cv_timing = np.std(gaps, ddof=1) / np.mean(gaps) if np.mean(gaps) > 0 else 0
    else:
        cv_timing = np.nan

    records.append({
        "SKU": sku,
        "DS": ds,
        "Category": cat,
        "NZD": nzd,
        "TotalQty": total_qty,
        "OrderLines": total_lines,
        "MovementTag": mt,
        "CV_Qty": cv_qty,
        "CV_Timing": cv_timing,
        "NumOrders": n_orders,
    })

stats = pd.DataFrame(records)

# ── Classify CV ──────────────────────────────────────────────────────────────
def classify_cv_qty(cv):
    if pd.isna(cv): return "Too Few Orders"
    if cv < 0.3: return "Predictable"
    if cv <= 0.7: return "Moderate"
    return "Volatile"

def classify_cv_timing(cv):
    if pd.isna(cv): return "Too Few Orders"
    if cv < 0.5: return "Regular"
    if cv <= 1.0: return "Somewhat Erratic"
    return "Very Erratic"

stats["QtyVolClass"] = stats["CV_Qty"].apply(classify_cv_qty)
stats["TimingVolClass"] = stats["CV_Timing"].apply(classify_cv_timing)

# ── Categories ───────────────────────────────────────────────────────────────
categories = sorted(stats["Category"].unique())

# ── Build markdown output ────────────────────────────────────────────────────
lines = []
L = lines.append

L("# Category-Level Inventory Strategy Analysis")
L("")
L(f"**Data range:** {pd.Timestamp(dates_90[0]).date()} to {pd.Timestamp(dates_90[-1]).date()}")
L(f"**Unique sale dates:** {num_days}")
L(f"**Total filtered rows:** {len(df_90)}")
L(f"**Total SKU x DS combos:** {len(stats)}")
L(f"**Categories:** {len(categories)}")
L("")

# ══════════════════════════════════════════════════════════════════════════════
# EXECUTIVE SUMMARY TABLE
# ══════════════════════════════════════════════════════════════════════════════
L("---")
L("")
L("## Executive Summary")
L("")

summary_rows = []
for cat in categories:
    c = stats[stats["Category"] == cat]
    n_skus = c["SKU"].nunique()
    n_combos = len(c)
    total_qty = c["TotalQty"].sum()
    total_lines = c["OrderLines"].sum()

    # Movement distribution
    mv_counts = c["MovementTag"].value_counts()
    fast_pct = ((mv_counts.get("Super Fast", 0) + mv_counts.get("Fast", 0)) / n_combos * 100) if n_combos else 0
    slow_pct = ((mv_counts.get("Slow", 0) + mv_counts.get("Super Slow", 0)) / n_combos * 100) if n_combos else 0

    # Qty volatility (only where enough data)
    c_enough = c[c["QtyVolClass"] != "Too Few Orders"]
    volatile_pct = (len(c_enough[c_enough["QtyVolClass"] == "Volatile"]) / len(c_enough) * 100) if len(c_enough) else 0

    # Timing volatility
    t_enough = c[c["TimingVolClass"] != "Too Few Orders"]
    erratic_pct = (len(t_enough[t_enough["TimingVolClass"].isin(["Somewhat Erratic", "Very Erratic"])]) / len(t_enough) * 100) if len(t_enough) else 0

    # Pain segment: Slow/Super Slow (no price data, just count)
    pain_count = len(c[c["MovementTag"].isin(["Slow", "Super Slow"])])

    summary_rows.append({
        "Category": cat,
        "SKUs": n_skus,
        "Combos": n_combos,
        "Qty": total_qty,
        "Lines": total_lines,
        "Fast%": fast_pct,
        "Slow%": slow_pct,
        "Volatile%": volatile_pct,
        "Erratic%": erratic_pct,
        "PainSeg": pain_count,
    })

summary_df = pd.DataFrame(summary_rows)

L("| Category | SKUs | SKUxDS | Qty | Lines | Fast+SF% | Slow+SS% | Volatile% | Erratic% | Pain Seg |")
L("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
for _, r in summary_df.sort_values("Qty", ascending=False).iterrows():
    L(f"| {r['Category']} | {r['SKUs']} | {r['Combos']} | {r['Qty']:,} | {r['Lines']:,} | {r['Fast%']:.0f}% | {r['Slow%']:.0f}% | {r['Volatile%']:.0f}% | {r['Erratic%']:.0f}% | {r['PainSeg']} |")

L("")
L("**Column guide:**")
L("- **Fast+SF%**: % of SKUxDS combos tagged Super Fast or Fast")
L("- **Slow+SS%**: % tagged Slow or Super Slow")
L("- **Volatile%**: % of combos (with 3+ orders) where order qty CV > 0.7")
L("- **Erratic%**: % of combos (with 3+ orders) where timing CV > 0.5")
L("- **Pain Seg**: Count of Slow/Super Slow SKUxDS combos (the operationally painful segment)")
L("")

# ══════════════════════════════════════════════════════════════════════════════
# STRATEGY RECOMMENDATIONS
# ══════════════════════════════════════════════════════════════════════════════
L("---")
L("")
L("## Strategy Recommendations")
L("")

for _, r in summary_df.sort_values("Qty", ascending=False).iterrows():
    cat = r["Category"]
    c = stats[stats["Category"] == cat]
    n_combos = len(c)

    # Determine recommendation
    reasons = []
    strategy = "standard"

    if r["Fast%"] >= 60 and r["Volatile%"] < 30:
        strategy = "standard"
        reasons.append(f"Majority fast-moving ({r['Fast%']:.0f}%) with low qty volatility")
    elif r["Volatile%"] >= 50:
        strategy = "percentile_cover"
        reasons.append(f"High order qty volatility ({r['Volatile%']:.0f}% volatile)")
    elif r["Erratic%"] >= 60 and r["Volatile%"] < 40:
        strategy = "fixed_unit_floor"
        reasons.append(f"Erratic timing ({r['Erratic%']:.0f}%) but moderate/low qty volatility ({r['Volatile%']:.0f}%)")
    elif r["Slow%"] >= 50:
        strategy = "percentile_cover"
        reasons.append(f"Dominated by slow movers ({r['Slow%']:.0f}%) — averages are misleading")
    elif r["Volatile%"] >= 30:
        strategy = "percentile_cover"
        reasons.append(f"Significant qty volatility ({r['Volatile%']:.0f}%)")
    else:
        strategy = "standard"
        reasons.append("Balanced movement and volatility profile")

    # Check if mixed
    mixed = False
    if r["Fast%"] >= 20 and r["Slow%"] >= 20:
        mixed = True
        reasons.append(f"MIXED: {r['Fast%']:.0f}% fast + {r['Slow%']:.0f}% slow — consider splitting strategy by movement tier")

    strategy_label = {
        "standard": "Standard (current blend model)",
        "percentile_cover": "Percentile Cover (90th pctl of daily demand)",
        "fixed_unit_floor": "Fixed Unit Floor (ABQ-based min)",
    }

    L(f"### {cat}")
    L(f"**Recommended strategy: {strategy_label[strategy]}**")
    L("")
    for reason in reasons:
        L(f"- {reason}")
    if r["PainSeg"] > 0:
        L(f"- Pain segment: {r['PainSeg']} slow-moving SKUxDS combos need special attention")
    L("")

# ══════════════════════════════════════════════════════════════════════════════
# PER-CATEGORY DETAILED BREAKDOWNS
# ══════════════════════════════════════════════════════════════════════════════
L("---")
L("")
L("## Detailed Category Breakdowns")
L("")

MOVEMENT_ORDER = ["Super Fast", "Fast", "Moderate", "Slow", "Super Slow"]
QTY_VOL_ORDER = ["Predictable", "Moderate", "Volatile", "Too Few Orders"]
TIMING_VOL_ORDER = ["Regular", "Somewhat Erratic", "Very Erratic", "Too Few Orders"]

for cat in sorted(categories, key=lambda c: -summary_df[summary_df["Category"]==c]["Qty"].values[0]):
    c = stats[stats["Category"] == cat]
    n_skus = c["SKU"].nunique()
    n_combos = len(c)
    total_qty = c["TotalQty"].sum()
    total_lines = c["OrderLines"].sum()

    L(f"### {cat}")
    L("")
    L(f"- **SKUs:** {n_skus}")
    L(f"- **SKU x DS combos:** {n_combos}")
    L(f"- **Total qty sold:** {total_qty:,}")
    L(f"- **Total order lines:** {total_lines:,}")
    L("")

    # Movement distribution
    L("**Movement Tag Distribution:**")
    L("")
    L("| Movement | Count | % |")
    L("|---|---:|---:|")
    mv = c["MovementTag"].value_counts()
    for tag in MOVEMENT_ORDER:
        cnt = mv.get(tag, 0)
        pct = cnt / n_combos * 100 if n_combos else 0
        if cnt > 0:
            L(f"| {tag} | {cnt} | {pct:.1f}% |")
    L("")

    # Order Qty Volatility
    L("**Order Qty Volatility (CV):**")
    L("")
    L("| Classification | Count | % |")
    L("|---|---:|---:|")
    qv = c["QtyVolClass"].value_counts()
    for tag in QTY_VOL_ORDER:
        cnt = qv.get(tag, 0)
        pct = cnt / n_combos * 100 if n_combos else 0
        if cnt > 0:
            L(f"| {tag} | {cnt} | {pct:.1f}% |")
    L("")

    # Timing Volatility
    L("**Timing Volatility:**")
    L("")
    L("| Classification | Count | % |")
    L("|---|---:|---:|")
    tv = c["TimingVolClass"].value_counts()
    for tag in TIMING_VOL_ORDER:
        cnt = tv.get(tag, 0)
        pct = cnt / n_combos * 100 if n_combos else 0
        if cnt > 0:
            L(f"| {tag} | {cnt} | {pct:.1f}% |")
    L("")

    # Pain segment detail
    pain = c[c["MovementTag"].isin(["Slow", "Super Slow"])]
    if len(pain) > 0:
        L(f"**Pain Segment (Slow/Super Slow):** {len(pain)} SKUxDS combos ({len(pain)/n_combos*100:.0f}% of category)")
        # Show top pain SKUs by qty
        pain_skus = pain.groupby("SKU").agg(
            TotalQty=("TotalQty", "sum"),
            Stores=("DS", "count"),
            AvgNZD=("NZD", "mean"),
        ).sort_values("TotalQty", ascending=False).head(5)
        if len(pain_skus) > 0:
            L("")
            L("Top slow-moving SKUs by qty:")
            L("")
            L("| SKU | Qty | Stores | Avg NZD |")
            L("|---|---:|---:|---:|")
            for sku, row in pain_skus.iterrows():
                L(f"| {sku} | {row['TotalQty']:,} | {row['Stores']} | {row['AvgNZD']:.1f} |")
        L("")
    L("")

# ══════════════════════════════════════════════════════════════════════════════
# OVERALL PAIN SEGMENT SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
L("---")
L("")
L("## The Pain Segment: Slow/Super Slow Movers Across All Categories")
L("")

pain_all = stats[stats["MovementTag"].isin(["Slow", "Super Slow"])]
L(f"**Total Slow/Super Slow SKUxDS combos:** {len(pain_all)} out of {len(stats)} ({len(pain_all)/len(stats)*100:.1f}%)")
L(f"**Unique SKUs in pain segment:** {pain_all['SKU'].nunique()}")
L(f"**Total qty from pain segment:** {pain_all['TotalQty'].sum():,}")
L("")

L("| Category | Pain Combos | % of Category | Qty from Pain |")
L("|---|---:|---:|---:|")
for cat in sorted(categories, key=lambda c: -len(pain_all[pain_all["Category"]==c])):
    c_total = len(stats[stats["Category"] == cat])
    p = pain_all[pain_all["Category"] == cat]
    if len(p) > 0:
        L(f"| {cat} | {len(p)} | {len(p)/c_total*100:.0f}% | {p['TotalQty'].sum():,} |")

L("")
L("These are the SKUs where the current average-based model systematically underestimates required stock.")
L("For these, a percentile-based or fixed-floor strategy would provide better coverage.")
L("")

# ── Overall movement distribution ────────────────────────────────────────────
L("---")
L("")
L("## Overall Movement Distribution (All Categories)")
L("")
L("| Movement | Count | % |")
L("|---|---:|---:|")
mv_all = stats["MovementTag"].value_counts()
for tag in MOVEMENT_ORDER:
    cnt = mv_all.get(tag, 0)
    pct = cnt / len(stats) * 100
    L(f"| {tag} | {cnt} | {pct:.1f}% |")
L("")

# ── Write output ─────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
with open(OUTPUT_PATH, "w") as f:
    f.write("\n".join(lines))

print(f"Analysis written to {OUTPUT_PATH}")
print()

# ── Print summary to stdout ──────────────────────────────────────────────────
print("=" * 80)
print("EXECUTIVE SUMMARY")
print("=" * 80)
print()
print(summary_df.sort_values("Qty", ascending=False).to_string(index=False))
print()
print("=" * 80)
print("STRATEGY RECOMMENDATIONS")
print("=" * 80)
for _, r in summary_df.sort_values("Qty", ascending=False).iterrows():
    cat = r["Category"]
    if r["Fast%"] >= 60 and r["Volatile%"] < 30:
        strat = "STANDARD"
    elif r["Volatile%"] >= 50:
        strat = "PERCENTILE COVER"
    elif r["Erratic%"] >= 60 and r["Volatile%"] < 40:
        strat = "FIXED UNIT FLOOR"
    elif r["Slow%"] >= 50:
        strat = "PERCENTILE COVER"
    elif r["Volatile%"] >= 30:
        strat = "PERCENTILE COVER"
    else:
        strat = "STANDARD"
    mixed = " [MIXED]" if r["Fast%"] >= 20 and r["Slow%"] >= 20 else ""
    print(f"  {cat:30s} → {strat}{mixed}")
print()
print(f"Pain segment: {len(pain_all)} SKUxDS combos across {pain_all['SKU'].nunique()} SKUs")
