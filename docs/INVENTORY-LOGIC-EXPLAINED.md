# How HomeRun IMS decides Min and Max

*A guide for the Inventory Manager. Written 2026-08-04 from the live configuration and the
production code — every number below is what the system was actually running that day, not a
default. Parameters are editable in **Logic Tweaker**, so treat this as a snapshot.*

---

## 1. What the tool does, in one paragraph

For every **SKU at every location** (6 dark stores + the Rampura DC) the engine computes a **Min**
and a **Max**. Min is the reorder trigger: when closing stock falls to or below Min, the SKU is
restocked up to Max overnight. Nothing else in the tool matters as much as these two numbers — the
DC team's transfer orders and the purchase team's POs both come from them.

The engine does **not** use one formula. It picks a **strategy per category**, because a bag of
cement and a premium tap fail in completely different ways.

---

## 2. The demand it works from

| | |
|---|---|
| **Window** | The last **45 days** of invoice data (`overallPeriod = 45`) |
| **Source** | Zoho invoices, pulled automatically every night |
| **Which store gets credited** | The **customer's pincode**, not the store that happened to fulfil it |

That last point matters. If DS02 is out of stock and the order ships from DS04, the demand is
credited to **the store whose catchment the customer lives in**. Otherwise the busy store looks
busier and the store that actually needs stock stays under-stocked. Roughly **11% of demand lines**
are affected in steady state.

---

## 3. Every SKU gets two tags first

These two tags drive almost every decision downstream.

### Price tag — from purchase price

| Tag | Purchase price |
|---|---|
| Premium | ≥ ₹3,000 |
| High | ₹1,500 – ₹2,999 |
| Medium | ₹400 – ₹1,499 |
| Low | ₹100 – ₹399 |
| Super Low | ₹1 – ₹99 |
| No Price | no price on record |

**Cheap items are stocked aggressively, expensive items lean.** A stockout on a ₹50 item costs ops
a scramble; ₹3,000 of dead stock on a slow premium item costs real money.

⚠ **"No Price" is treated as the *cheapest* tier**, so a SKU missing a price is stocked
aggressively. Keeping purchase prices current is an inventory decision, not an admin chore.

### Movement tag — from how often it sells

Take the **average gap in days between days it sold** at that location:

| Tag | Average gap between selling days |
|---|---|
| Super Fast | ≤ 2 days |
| Fast | ≤ 4 days |
| Moderate | ≤ 7 days |
| Slow | ≤ 10 days |
| Super Slow | > 10 days, or never sold |

**78.7% of SKU×location combinations are Slow or Super Slow.** That single fact is why the
strategies below exist — a plain average produces a Min of nearly zero for something that sells once
a fortnight.

**NZD = Non-Zero Days** — the count of days a SKU actually sold at a location in the window. It
appears in almost every guardrail below.

---

## 4. Which strategy each category uses

**Live as of 2026-08-04, with active SKU counts:**

| Category | SKUs | Strategy |
|---|---:|---|
| Wires, MCB & Distribution Boards | 612 | **Fixed Unit Floor** |
| Furniture & Architectural Hardware | 339 | **Percentile Cover** |
| Plywood, MDF & HDHMR | 169 | **Network Design** |
| CPVC Pipes & Fittings | 163 | **Percentile Cover** |
| Painting | 110 | Standard *(by default — see below)* |
| Tiling | 99 | **Percentile Cover** |
| Lighting | 95 | **Percentile Cover** |
| General Hardware | 90 | Standard *(by default)* |
| Switches & Sockets | 84 | **Percentile Cover** |
| Sanitary & Bath Fittings | 77 | **Percentile Cover** |
| Home Appliances | 57 | Standard *(by default)* |
| Conduits & GI Boxes | 57 | **Percentile Cover** |
| Fevicol | 46 | Standard *(by default)* |
| Kitchen Sinks & Faucets | 35 | **Percentile Cover** |
| Glass Hardware | 34 | Standard *(by default)* |
| Water Proofing | 19 | Standard *(by default)* |
| Cement | 18 | Standard *(by default)* |
| Overhead Tanks | 3 | **Fixed Unit Floor** |
| Service | 2 | Standard *(by default)* |

| Strategy | Active SKUs |
|---|---:|
| Percentile Cover | 949 |
| Fixed Unit Floor | 615 |
| Standard | 376 |
| Network Design | 169 |

> ### ⚠ The most important thing on this page
>
> **Only 11 categories are explicitly assigned a strategy. Every other category silently falls
> through to Standard — and there is no warning anywhere in the tool.**
>
> As of 2026-08-04, **zero categories are deliberately mapped to Standard.** All 376 SKUs on it are
> there because nobody assigned them, not because anyone decided Standard suits them.
>
> Some of those are probably fine (Cement, Painting, Fevicol — steady, fast-moving). Others deserve
> a look: **Home Appliances (57)**, **Glass Hardware (34)** and **Kitchen Sinks & Faucets** are
> premium slow-movers, which is exactly the profile Percentile Cover was built for. Glass Hardware
> currently shows **34 active SKUs and zero sales in 90 days.**
>
> **When Zoho gains a new category, it lands on Standard by default.** That is a decision to make,
> not a default to accept.

---

## 5. Standard — steady, predictable movers

Splits the 45-day window into **the recent 15 days** and **the earlier 30 days**, computes each
separately, then blends with heavy weight on the recent half.

**For each half:**

```
base        = base-min-days for that movement tag
              Super Fast 6 · Fast 5 · Moderate 3 · Slow 3 · Super Slow 3

baseMinQty  = daily average × base
buffer      = daily average × 2

Min = ceil( baseMinQty )                       ...normally
Max = ceil( baseMinQty + buffer )
```

**Spike handling.** A "spike day" is a day selling more than **5×** the daily average. If spikes are
frequent (or the item is cheap), the calculation uses the *median spike* instead when it is larger:

```
Min = ceil( max( baseMinQty, median spike ) )
Max = ceil( max( baseMinQty, median spike ) + buffer )
```

**Bulk-buy override.** For **Slow / Super Slow** items priced **Medium or below**, if the average
order size (ABQ) is bigger than the computed Min, the Min becomes one whole typical order:

```
Min = ceil( ABQ )
Max = ceil( Min × 1.5 )
```

**The blend:**

```
weight w = 5 for Super Fast/Fast, 4 for everything else

Final Min = ceil( (Min_30day + Min_15day × w) / (1 + w) )
Final Max = ceil( (Max_30day + Max_15day × w) / (1 + w) )
```

⚠ With w = 4 or 5, **the recent 15 days carry 80–83% of the weight.** Standard reacts fast to a
change in demand — which is right for steady movers and wrong for erratic ones. That is why the
erratic categories are on other strategies.

---

## 6. Percentile Cover (PCT) — the workhorse, 949 SKUs

**Built for:** items that sell in bursts with long gaps. Averaging them gives a Min near zero.

Instead of averaging, PCT asks: *"On a day this SKU actually sells, how much goes out?"* — and
stocks for that.

```
Take only the days it SOLD (ignore all the zero days).
Take the Xth percentile of those daily quantities.

Min = ceil( Pxx of selling-day quantities × cover days )
Max = ceil( Min + daily average × 2 )
```

**X depends on price** — cheap stocks aggressively:

| Price tag | Percentile |
|---|---|
| Premium | 75th |
| High | 80th |
| Medium | 85th |
| Low / Super Low / No Price | 95th |

**Cover days depend on movement:** Super Fast and Fast = **2 days**; everything else = **1 day**.

### Guardrails

| Guard | Rule | Why |
|---|---|---|
| **Minimum observations** | **Premium and High** need **NZD ≥ 2**, else the SKU falls back to **Standard** | One sale is not a distribution. Without this, a single order of 10 units of a ₹5,000 item sets Min = 10 forever. |
| **Days-of-cover cap** | Premium/High capped at **30 days** of cover; everything else at **60 days** | Stops a rare large order translating into months of stock sitting on a premium SKU. |

---

## 7. Fixed Unit Floor — 615 SKUs (Wires/MCB, Overhead Tanks)

**Built for:** items where *when* someone buys is unpredictable, but *how much* they buy is very
predictable. Nobody buys 3 metres of wire — they buy a full coil.

This strategy ignores daily rates entirely and looks at **individual order sizes**.

```
Take every individual order line for this SKU at this store in the window.

Min = ceil( P90 of those order quantities )
Max = ceil( max( Min + 1, Min × 1.5 ) )
```

So Min is roughly "one typical order, sized generously" — enough to serve the next customer who
walks in, whenever they do.

### Guardrails

| Guard | Rule | Why |
|---|---|---|
| **Spike cap (winsorising)** | With **3+ orders**, any single order larger than **median × 5** is clipped down to that cap before the P90 | One contractor bulk-buy of 200 units shouldn't set the floor for a store that normally sells 4 at a time. |
| **Minimum order-days** | **Premium and High** need **NZD ≥ 2**, else fall back to **Standard** | Same reasoning as PCT — one order shouldn't dictate stocking of an expensive item. |
| **No orders at all** | Falls back to **Standard** | Nothing to take a percentile of. |

⚠ **Known and accepted gap:** a two-order pattern like `[1, 20]` slips through both guards — too many
orders for the NZD gate, and the median is too high for the spike cap to bite. Raising the gate would
over-suppress genuine repeat demand, so this was consciously left alone.

---

## 8. Network Design — Plywood only, 169 SKUs

Plywood is different: it is bulky, shelf space is the binding constraint, and it is bought by brand.
So it gets a capacity-aware strategy of its own, configured per brand in the **Plywood** tab.

All four brands (**Action Tesa, CenturyPly, ArchidPly, GreenPly**) are currently stocked at **all six
stores**, each store covering only its own demand. *Merino is excluded and uses PCT.*

Each SKU at each store lands in one of three zones by **NZD**:

| Zone | Condition | Min | Max |
|---|---|---|---|
| **Rare** | NZD < 2 | **0** | **0** — not stocked |
| **Sparse** | 2 ≤ NZD < 5 | ceil(average order qty) | largest winsorised day, at least Min + 1 |
| **Frequent** | NZD ≥ 5 | 95th percentile of winsorised daily demand | largest winsorised day, at least Min + 1 |

Both Sparse and Frequent Max values are **capped at 20 units**. Daily demand is winsorised at
**median × 4** before the percentile, so one outlier day cannot inflate the shelf.

*A separate technical document covers the plywood engine in depth; this section is the summary.*

---

## 9. The DC (Rampura)

The DC is not calculated by the strategies above. It buffers the stores.

**Normal SKUs:**

```
lead time = 3 days (Asian Paints: 4)

DC Min = ceil( sum of all stores' daily averages × (lead time + 1) )
DC Max = DC Min + ceil( sum of all stores' daily averages × 2 )
```

**SKUs with a manual floor set by ops:**

```
DC Min = round( sum of store Mins × 0.2 )
DC Max = round( sum of store Maxes × 0.3 )
```

⚠ **Known open issue:** the rate-based formula understocks the DC for erratic demand — precisely the
Fixed Unit Floor categories. About **639 SKUs** are affected. It is a logged item, not yet changed.

---

## 10. What overrides the strategies

After a strategy produces Min/Max, these are applied **in this exact order**. Later steps beat
earlier ones.

| # | Step | Effect |
|---|---|---|
| 1 | **New DS Floor** | The top **250** SKUs get a baseline presence at DS03, DS04, DS05, DS06 so a newer store carries breadth. Per-field maximum — it can raise Min without destroying a demand-informed Max. |
| 2 | **SKU Floor Override** | Ops sets explicit Min/Max per store in a Google Sheet, synced nightly. Beats the strategy. |
| 3 | **Dead Stock** | Min = Max = **0 everywhere**. Beats every floor above. |
| 4 | **Rounding** | Whole units. |
| 5 | **Active-only** | A SKU not `Active` in Zoho gets **0/0 everywhere**, whatever the floors said. |
| 6 | **Inventorised At** | `Supplier` → 0/0 everywhere (never stocked by us). `DS` → DC set to 0 (goes direct to store). `DC` → untouched. |

⚠ **A floor cannot resurrect an inactive SKU.** Steps 5 and 6 run last and win. If ops sets a floor
and the SKU still shows 0/0, check its **Status** and **Inventorised At** in Zoho first — that
accounts for most "the floor isn't working" reports. The nightly sync reports these as *ineffective
floors* (5 of them on 2026-08-04).

---

## 11. All guardrails on one page

| Guard | Applies to | Rule |
|---|---|---|
| Minimum observations | PCT, Fixed Unit Floor | Premium/High need NZD ≥ 2, else fall back to Standard |
| Days-of-cover cap | PCT | 30 days Premium/High · 60 days everything else |
| Spike cap | Fixed Unit Floor | 3+ orders: clip anything above median × 5 |
| Spike median | Standard | Spike day = more than 5× the daily average |
| Bulk-buy override | Standard | Slow + cheap: Min becomes one average order, Max = ×1.5 |
| Zone gate | Network Design | NZD < 2 → not stocked |
| Winsorising | Network Design | Daily demand clipped at median × 4 |
| Absolute cap | Network Design | Max never exceeds 20 units |
| Dead stock | All | 0/0 everywhere, beats all floors |
| Active-only | All | Non-active in Zoho → 0/0 everywhere |
| Supplier / DS | All | Supplier → 0/0. DS-inventorised → DC 0 |

---

## 12. The five questions worth asking about any number

1. **What strategy is this SKU on?** — driven by its category (section 4). Check it isn't an
   unmapped fallthrough to Standard.
2. **What are its price and movement tags?** — those select the percentile, the cover days and the
   base days.
3. **How many days did it actually sell (NZD)?** — below 2, most strategies deliberately refuse to
   act on the data.
4. **Is a floor, dead-stock flag or Zoho status overriding it?** — section 10, and remember steps 5
   and 6 win.
5. **Is the price on record?** — missing price = stocked as if it were the cheapest tier.

Everything above is visible per SKU in the **SKU Detail** tab, including which strategy ran and which
guardrail fired.

---

## Appendix — live parameter values, 2026-08-04

| Parameter | Value |
|---|---|
| Demand window | 45 days · recent sub-window 15 days |
| Movement thresholds | 2 / 4 / 7 / 10 days average gap |
| Price tiers | ₹3,000 / ₹1,500 / ₹400 / ₹100 |
| Base min days | SF 6 · F 5 · M 3 · S 3 · SS 3 |
| Max buffer | 2 days |
| Recency weight | 5 (Super Fast, Fast) · 4 (others) |
| Spike definition | 5× the daily average |
| PCT percentiles | Premium 75 · High 80 · Medium 85 · rest 95 |
| PCT cover days | 2 (Super Fast, Fast) · 1 (others) |
| PCT NZD gate | 2, for Premium/High |
| PCT DOC caps | 30 days Premium/High · 60 days others |
| Fixed Unit Floor | P90 · Max = max(Min+1, Min×1.5) · NZD gate 2 · spike cap ×5 |
| Network Design | NZD zones 2 / 5 · P95 · cap 20 · winsor ×4 |
| DC lead time | 3 days (Asian Paints 4) |
| DC floored-SKU multipliers | 0.2 Min · 0.3 Max |
| New DS Floor | top 250 SKUs at DS03–DS06 |
| DS Seed | **off** (retired 2026-07-31 once DS06 had its own demand history) |
