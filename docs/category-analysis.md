# Category-Level Inventory Strategy Analysis

**Data range:** 2026-01-01 to 2026-03-31
**Unique sale dates:** 90
**Total filtered rows:** 36055
**Total SKU x DS combos:** 4158
**Categories:** 15

---

## Executive Summary

| Category | SKUs | SKUxDS | Qty | Lines | Fast+SF% | Slow+SS% | Volatile% | Erratic% | Pain Seg |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cement | 16 | 77 | 84,343 | 7,198 | 65% | 22% | 61% | 77% | 17 |
| Tiling | 83 | 346 | 41,478 | 5,356 | 15% | 76% | 48% | 88% | 262 |
| Furniture & Architectural Hardware | 302 | 937 | 29,052 | 4,364 | 1% | 93% | 44% | 84% | 873 |
| Painting | 130 | 537 | 24,452 | 5,803 | 9% | 80% | 32% | 87% | 430 |
| Conduits & GI Boxes | 57 | 222 | 22,058 | 1,373 | 2% | 91% | 59% | 85% | 202 |
| CPVC Pipes & Fittings | 130 | 366 | 11,689 | 1,625 | 1% | 92% | 67% | 86% | 336 |
| Plywood, MDF & HDHMR | 108 | 383 | 10,895 | 2,242 | 2% | 90% | 61% | 84% | 343 |
| Switches & Sockets | 80 | 222 | 8,176 | 1,028 | 0% | 94% | 71% | 89% | 208 |
| General Hardware | 29 | 135 | 8,117 | 1,988 | 17% | 71% | 44% | 90% | 96 |
| Wires, MCB & Distribution Boards | 196 | 562 | 3,150 | 1,949 | 0% | 99% | 16% | 78% | 556 |
| Fevicol | 29 | 138 | 2,203 | 1,751 | 14% | 66% | 5% | 96% | 91 |
| Lighting | 38 | 113 | 1,965 | 489 | 0% | 96% | 60% | 84% | 109 |
| Water Proofing | 16 | 68 | 1,051 | 592 | 9% | 78% | 21% | 95% | 53 |
| Sanitary & Bath Fittings | 10 | 37 | 406 | 170 | 0% | 95% | 35% | 87% | 35 |
| Overhead Tanks | 3 | 15 | 158 | 127 | 0% | 80% | 7% | 73% | 12 |

**Column guide:**
- **Fast+SF%**: % of SKUxDS combos tagged Super Fast or Fast
- **Slow+SS%**: % tagged Slow or Super Slow
- **Volatile%**: % of combos (with 3+ orders) where order qty CV > 0.7
- **Erratic%**: % of combos (with 3+ orders) where timing CV > 0.5
- **Pain Seg**: Count of Slow/Super Slow SKUxDS combos (the operationally painful segment)

---

## Strategy Recommendations

### Cement
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- High order qty volatility (61% volatile)
- MIXED: 65% fast + 22% slow — consider splitting strategy by movement tier
- Pain segment: 17 slow-moving SKUxDS combos need special attention

### Tiling
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- Dominated by slow movers (76%) — averages are misleading
- Pain segment: 262 slow-moving SKUxDS combos need special attention

### Furniture & Architectural Hardware
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- Dominated by slow movers (93%) — averages are misleading
- Pain segment: 873 slow-moving SKUxDS combos need special attention

### Painting
**Recommended strategy: Fixed Unit Floor (ABQ-based min)**

- Erratic timing (87%) but moderate/low qty volatility (32%)
- Pain segment: 430 slow-moving SKUxDS combos need special attention

### Conduits & GI Boxes
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- High order qty volatility (59% volatile)
- Pain segment: 202 slow-moving SKUxDS combos need special attention

### CPVC Pipes & Fittings
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- High order qty volatility (67% volatile)
- Pain segment: 336 slow-moving SKUxDS combos need special attention

### Plywood, MDF & HDHMR
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- High order qty volatility (61% volatile)
- Pain segment: 343 slow-moving SKUxDS combos need special attention

### Switches & Sockets
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- High order qty volatility (71% volatile)
- Pain segment: 208 slow-moving SKUxDS combos need special attention

### General Hardware
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- Dominated by slow movers (71%) — averages are misleading
- Pain segment: 96 slow-moving SKUxDS combos need special attention

### Wires, MCB & Distribution Boards
**Recommended strategy: Fixed Unit Floor (ABQ-based min)**

- Erratic timing (78%) but moderate/low qty volatility (16%)
- Pain segment: 556 slow-moving SKUxDS combos need special attention

### Fevicol
**Recommended strategy: Fixed Unit Floor (ABQ-based min)**

- Erratic timing (96%) but moderate/low qty volatility (5%)
- Pain segment: 91 slow-moving SKUxDS combos need special attention

### Lighting
**Recommended strategy: Percentile Cover (90th pctl of daily demand)**

- High order qty volatility (60% volatile)
- Pain segment: 109 slow-moving SKUxDS combos need special attention

### Water Proofing
**Recommended strategy: Fixed Unit Floor (ABQ-based min)**

- Erratic timing (95%) but moderate/low qty volatility (21%)
- Pain segment: 53 slow-moving SKUxDS combos need special attention

### Sanitary & Bath Fittings
**Recommended strategy: Fixed Unit Floor (ABQ-based min)**

- Erratic timing (87%) but moderate/low qty volatility (35%)
- Pain segment: 35 slow-moving SKUxDS combos need special attention

### Overhead Tanks
**Recommended strategy: Fixed Unit Floor (ABQ-based min)**

- Erratic timing (73%) but moderate/low qty volatility (7%)
- Pain segment: 12 slow-moving SKUxDS combos need special attention

---

## Detailed Category Breakdowns

### Cement

- **SKUs:** 16
- **SKU x DS combos:** 77
- **Total qty sold:** 84,343
- **Total order lines:** 7,198

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 26 | 33.8% |
| Fast | 24 | 31.2% |
| Moderate | 10 | 13.0% |
| Slow | 5 | 6.5% |
| Super Slow | 12 | 15.6% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Moderate | 29 | 37.7% |
| Volatile | 46 | 59.7% |
| Too Few Orders | 2 | 2.6% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 17 | 22.1% |
| Somewhat Erratic | 51 | 66.2% |
| Very Erratic | 7 | 9.1% |
| Too Few Orders | 2 | 2.6% |

**Pain Segment (Slow/Super Slow):** 17 SKUxDS combos (22% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| GCE-OPC-PRI-50K | 274.0 | 2.0 | 9.5 |
| GCE-OPC-RAM-50K | 166.0 | 2.0 | 6.5 |
| GCE-RMP-JSW-EP-40K | 165.0 | 1.0 | 9.0 |
| GCE-BGA-JSW-EP-40K | 133.0 | 2.0 | 8.0 |
| GCE-OPC-MAH-50K | 131.0 | 1.0 | 8.0 |


### Tiling

- **SKUs:** 83
- **SKU x DS combos:** 346
- **Total qty sold:** 41,478
- **Total order lines:** 5,356

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 21 | 6.1% |
| Fast | 31 | 9.0% |
| Moderate | 32 | 9.2% |
| Slow | 32 | 9.2% |
| Super Slow | 230 | 66.5% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 17 | 4.9% |
| Moderate | 108 | 31.2% |
| Volatile | 117 | 33.8% |
| Too Few Orders | 104 | 30.1% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 30 | 8.7% |
| Somewhat Erratic | 153 | 44.2% |
| Very Erratic | 59 | 17.1% |
| Too Few Orders | 104 | 30.1% |

**Pain Segment (Slow/Super Slow):** 262 SKUxDS combos (76% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| TIL-ADH-MYK-307-GRE-20K | 240.0 | 5.0 | 4.8 |
| TIL-ADH-ROF-T06-20K | 238.0 | 5.0 | 4.2 |
| TIL-ADH-MYK-SUP-335-WHI-20K | 216.0 | 2.0 | 10.0 |
| TIL-ADH-MYK-HIG-325-GRE-20K | 184.0 | 3.0 | 6.3 |
| BIR-WHT-TX1-ADH | 179.0 | 3.0 | 5.0 |


### Furniture & Architectural Hardware

- **SKUs:** 302
- **SKU x DS combos:** 937
- **Total qty sold:** 29,052
- **Total order lines:** 4,364

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 1 | 0.1% |
| Fast | 12 | 1.3% |
| Moderate | 51 | 5.4% |
| Slow | 68 | 7.3% |
| Super Slow | 805 | 85.9% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 67 | 7.2% |
| Moderate | 204 | 21.8% |
| Volatile | 213 | 22.7% |
| Too Few Orders | 453 | 48.3% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 79 | 8.4% |
| Somewhat Erratic | 288 | 30.7% |
| Very Erratic | 117 | 12.5% |
| Too Few Orders | 453 | 48.3% |

**Pain Segment (Slow/Super Slow):** 873 SKUxDS combos (93% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| HAR-HET-HIN-REG-RC-2333-0CR | 1,423.0 | 5.0 | 6.2 |
| EBCO-PSS2 | 622.0 | 4.0 | 4.5 |
| HAR-EBCO-HIN-REG-EHS1-0CR | 572.0 | 4.0 | 6.5 |
| EBCO-PF-Q-100MM | 452.0 | 5.0 | 4.2 |
| HAR-HET-HIN-REG-RC-2333-8CR | 417.0 | 4.0 | 4.8 |


### Painting

- **SKUs:** 130
- **SKU x DS combos:** 537
- **Total qty sold:** 24,452
- **Total order lines:** 5,803

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 11 | 2.0% |
| Fast | 36 | 6.7% |
| Moderate | 60 | 11.2% |
| Slow | 45 | 8.4% |
| Super Slow | 385 | 71.7% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 68 | 12.7% |
| Moderate | 190 | 35.4% |
| Volatile | 119 | 22.2% |
| Too Few Orders | 160 | 29.8% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 49 | 9.1% |
| Somewhat Erratic | 231 | 43.0% |
| Very Erratic | 97 | 18.1% |
| Too Few Orders | 160 | 29.8% |

**Pain Segment (Slow/Super Slow):** 430 SKUxDS combos (80% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| ASA-PAI-SAN-PAP-180 | 306.0 | 5.0 | 7.0 |
| ASA-PAI-SAN-PAP-120 | 295.0 | 2.0 | 10.0 |
| ASA-PAI-SAN-PAP-150 | 268.0 | 2.0 | 5.0 |
| ASA-PAI-SAN-PAP-200 | 219.0 | 3.0 | 6.7 |
| PAI-PUT-ASI-TRU-40K | 206.0 | 2.0 | 9.0 |


### Conduits & GI Boxes

- **SKUs:** 57
- **SKU x DS combos:** 222
- **Total qty sold:** 22,058
- **Total order lines:** 1,373

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Fast | 4 | 1.8% |
| Moderate | 16 | 7.2% |
| Slow | 31 | 14.0% |
| Super Slow | 171 | 77.0% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 6 | 2.7% |
| Moderate | 57 | 25.7% |
| Volatile | 90 | 40.5% |
| Too Few Orders | 69 | 31.1% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 23 | 10.4% |
| Somewhat Erratic | 101 | 45.5% |
| Very Erratic | 29 | 13.1% |
| Too Few Orders | 69 | 31.1% |

**Pain Segment (Slow/Super Slow):** 202 SKUxDS combos (91% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| PIP-VIP-BEND-WHT-25 | 1,602.0 | 5.0 | 6.6 |
| PIP-VIP-250-WHI-COL-1 | 1,205.0 | 4.0 | 7.8 |
| PIP-VIP-BEND-WHT-19 | 1,015.0 | 5.0 | 7.4 |
| PIP-VIP-190-WHI-COL-1 | 932.0 | 5.0 | 6.6 |
| PIP-VIP-250-BLA-COL-1 | 896.0 | 4.0 | 8.0 |


### CPVC Pipes & Fittings

- **SKUs:** 130
- **SKU x DS combos:** 366
- **Total qty sold:** 11,689
- **Total order lines:** 1,625

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Fast | 4 | 1.1% |
| Moderate | 26 | 7.1% |
| Slow | 20 | 5.5% |
| Super Slow | 316 | 86.3% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 6 | 1.6% |
| Moderate | 48 | 13.1% |
| Volatile | 108 | 29.5% |
| Too Few Orders | 204 | 55.7% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 22 | 6.0% |
| Somewhat Erratic | 107 | 29.2% |
| Very Erratic | 33 | 9.0% |
| Too Few Orders | 204 | 55.7% |

**Pain Segment (Slow/Super Slow):** 336 SKUxDS combos (92% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| PIP-CPVC-AVD-FGPS-ELB90-20 | 668.0 | 3.0 | 7.3 |
| PIP-CPVC-AVD-FGP-MET-CLA-25 | 521.0 | 4.0 | 6.0 |
| PIP-CPVC-AVG-FGP-THR-END-PLU-15 | 318.0 | 3.0 | 5.0 |
| PIP-CPVC-AVD-FGD-TEE-20 | 301.0 | 3.0 | 5.0 |
| PIP-CPVC-AVD-FGP-MET-CLA-20 | 265.0 | 4.0 | 3.5 |


### Plywood, MDF & HDHMR

- **SKUs:** 108
- **SKU x DS combos:** 383
- **Total qty sold:** 10,895
- **Total order lines:** 2,242

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Fast | 7 | 1.8% |
| Moderate | 33 | 8.6% |
| Slow | 40 | 10.4% |
| Super Slow | 303 | 79.1% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 7 | 1.8% |
| Moderate | 87 | 22.7% |
| Volatile | 147 | 38.4% |
| Too Few Orders | 142 | 37.1% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 38 | 9.9% |
| Somewhat Erratic | 143 | 37.3% |
| Very Erratic | 60 | 15.7% |
| Too Few Orders | 142 | 37.1% |

**Pain Segment (Slow/Super Slow):** 343 SKUxDS combos (90% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| PLY-CEN-SAI-MR-19M-28 | 266.0 | 5.0 | 7.6 |
| PLY-GRP-ECO-MR-18M-32 | 188.0 | 3.0 | 6.3 |
| PLY-ARC-CLA-MR-18M-28 | 182.0 | 5.0 | 6.2 |
| PLY-CEN-SAI-BWP-710-19M-28 | 169.0 | 5.0 | 6.0 |
| PLY-GRP-ECO-MR-16M-32 | 165.0 | 4.0 | 4.2 |


### Switches & Sockets

- **SKUs:** 80
- **SKU x DS combos:** 222
- **Total qty sold:** 8,176
- **Total order lines:** 1,028

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Fast | 1 | 0.5% |
| Moderate | 13 | 5.9% |
| Slow | 20 | 9.0% |
| Super Slow | 188 | 84.7% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 3 | 1.4% |
| Moderate | 31 | 14.0% |
| Volatile | 83 | 37.4% |
| Too Few Orders | 105 | 47.3% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 13 | 5.9% |
| Somewhat Erratic | 66 | 29.7% |
| Very Erratic | 38 | 17.1% |
| Too Few Orders | 105 | 47.3% |

**Pain Segment (Slow/Super Slow):** 208 SKUxDS combos (94% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| PVC-CHA-WHI | 551.0 | 4.0 | 7.2 |
| SWI-LEG-MYR-6A-1W-BLK | 371.0 | 3.0 | 4.0 |
| SWI-LEG-MYR-BLANK-1M-BLCK | 292.0 | 3.0 | 3.3 |
| SWI-ANC-ROM-20A-WH-1W-PLN | 256.0 | 5.0 | 3.8 |
| SOC-ANR-ROM-6-16A-WHI-2MO | 171.0 | 4.0 | 4.8 |


### General Hardware

- **SKUs:** 29
- **SKU x DS combos:** 135
- **Total qty sold:** 8,117
- **Total order lines:** 1,988

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 9 | 6.7% |
| Fast | 14 | 10.4% |
| Moderate | 16 | 11.9% |
| Slow | 19 | 14.1% |
| Super Slow | 77 | 57.0% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 19 | 14.1% |
| Moderate | 42 | 31.1% |
| Volatile | 47 | 34.8% |
| Too Few Orders | 27 | 20.0% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 11 | 8.1% |
| Somewhat Erratic | 84 | 62.2% |
| Very Erratic | 13 | 9.6% |
| Too Few Orders | 27 | 20.0% |

**Pain Segment (Slow/Super Slow):** 96 SKUxDS combos (71% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| GEN-SIL-789-WHT-300 | 188.0 | 5.0 | 5.8 |
| GEN-HAR-BOPP-3IN | 126.0 | 2.0 | 9.0 |
| GEN-SIL-789-CLR-300 | 108.0 | 4.0 | 5.5 |
| GEN-SIL-789-BLK-300 | 78.0 | 3.0 | 5.0 |
| GEN-HAR-ABRO | 75.0 | 1.0 | 10.0 |


### Wires, MCB & Distribution Boards

- **SKUs:** 196
- **SKU x DS combos:** 562
- **Total qty sold:** 3,150
- **Total order lines:** 1,949

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Moderate | 6 | 1.1% |
| Slow | 35 | 6.2% |
| Super Slow | 521 | 92.7% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 107 | 19.0% |
| Moderate | 115 | 20.5% |
| Volatile | 43 | 7.7% |
| Too Few Orders | 297 | 52.8% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 59 | 10.5% |
| Somewhat Erratic | 140 | 24.9% |
| Very Erratic | 66 | 11.7% |
| Too Few Orders | 297 | 52.8% |

**Pain Segment (Slow/Super Slow):** 556 SKUxDS combos (99% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| SCH-MCB-CC-SP-10A | 282.0 | 4.0 | 6.8 |
| SCH-MCB-CC-SP-20A | 253.0 | 4.0 | 7.2 |
| SCH-MCB-CC-DP-32A | 107.0 | 5.0 | 5.0 |
| SCH-MCB-CC-SP-32A | 62.0 | 4.0 | 3.0 |
| WIR-FR-LSH-FIN-250-BLA-1800-1 | 44.0 | 5.0 | 6.0 |


### Fevicol

- **SKUs:** 29
- **SKU x DS combos:** 138
- **Total qty sold:** 2,203
- **Total order lines:** 1,751

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 1 | 0.7% |
| Fast | 18 | 13.0% |
| Moderate | 28 | 20.3% |
| Slow | 14 | 10.1% |
| Super Slow | 77 | 55.8% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 43 | 31.2% |
| Moderate | 68 | 49.3% |
| Volatile | 6 | 4.3% |
| Too Few Orders | 21 | 15.2% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 5 | 3.6% |
| Somewhat Erratic | 84 | 60.9% |
| Very Erratic | 28 | 20.3% |
| Too Few Orders | 21 | 15.2% |

**Pain Segment (Slow/Super Slow):** 91 SKUxDS combos (66% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| ADH-PID-SYN-MASTERLOK-50K | 55.0 | 4.0 | 5.2 |
| ARAL-STD-180 | 44.0 | 4.0 | 8.2 |
| FEV-PID-HI-PER-ADH-30K | 33.0 | 5.0 | 6.6 |
| ARAL-KLR5-108 | 31.0 | 3.0 | 7.0 |
| ARAL-STD-450 | 26.0 | 3.0 | 7.0 |


### Lighting

- **SKUs:** 38
- **SKU x DS combos:** 113
- **Total qty sold:** 1,965
- **Total order lines:** 489

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Moderate | 4 | 3.5% |
| Slow | 10 | 8.8% |
| Super Slow | 99 | 87.6% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 2 | 1.8% |
| Moderate | 23 | 20.4% |
| Volatile | 38 | 33.6% |
| Too Few Orders | 50 | 44.2% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 10 | 8.8% |
| Somewhat Erratic | 39 | 34.5% |
| Very Erratic | 14 | 12.4% |
| Too Few Orders | 50 | 44.2% |

**Pain Segment (Slow/Super Slow):** 109 SKUxDS combos (96% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| LHT-PHP-DL-UG-10W-ROU-TW-2 | 214.0 | 5.0 | 5.8 |
| LHT-PHP-SF-NRL-12W-TW-3 | 108.0 | 4.0 | 5.2 |
| LHT-PHP-SL-NW-20W-2 | 101.0 | 3.0 | 7.3 |
| LHT-PHP-SL-CW-20W-2 | 78.0 | 4.0 | 6.8 |
| LHT-PHP-SF-FGL-15W-ROU-NW-2 | 74.0 | 3.0 | 3.7 |


### Water Proofing

- **SKUs:** 16
- **SKU x DS combos:** 68
- **Total qty sold:** 1,051
- **Total order lines:** 592

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Fast | 6 | 8.8% |
| Moderate | 9 | 13.2% |
| Slow | 6 | 8.8% |
| Super Slow | 47 | 69.1% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 8 | 11.8% |
| Moderate | 37 | 54.4% |
| Volatile | 12 | 17.6% |
| Too Few Orders | 11 | 16.2% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 3 | 4.4% |
| Somewhat Erratic | 37 | 54.4% |
| Very Erratic | 17 | 25.0% |
| Too Few Orders | 11 | 16.2% |

**Pain Segment (Slow/Super Slow):** 53 SKUxDS combos (78% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| DR-FIX-CRA-201-PES-1kg | 60.0 | 5.0 | 5.8 |
| PAI-ASI-DMS-INT-20L | 45.0 | 3.0 | 7.0 |
| DR-FIX-PID-112-2K-3KG | 37.0 | 4.0 | 6.2 |
| DR-FIX-CRA-PID-101-LW+-5L | 35.0 | 4.0 | 6.2 |
| PAI-ASI- SMA-DAM-ADV-WAT-4L | 32.0 | 4.0 | 5.5 |


### Sanitary & Bath Fittings

- **SKUs:** 10
- **SKU x DS combos:** 37
- **Total qty sold:** 406
- **Total order lines:** 170

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Moderate | 2 | 5.4% |
| Slow | 4 | 10.8% |
| Super Slow | 31 | 83.8% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 3 | 8.1% |
| Moderate | 12 | 32.4% |
| Volatile | 8 | 21.6% |
| Too Few Orders | 14 | 37.8% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 3 | 8.1% |
| Somewhat Erratic | 17 | 45.9% |
| Very Erratic | 3 | 8.1% |
| Too Few Orders | 14 | 37.8% |

**Pain Segment (Slow/Super Slow):** 35 SKUxDS combos (95% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| SBP-CP-JAQ-DIV-HIG-FLW | 110.0 | 4.0 | 5.8 |
| JAQ-ALD-CHR-089 | 47.0 | 4.0 | 2.5 |
| SBP-CP-JAQ-CFT-ST-WH | 39.0 | 3.0 | 6.3 |
| KOH-KWP-32MM | 29.0 | 4.0 | 4.5 |
| SBP-CP-JAQ-ALL-BT | 28.0 | 5.0 | 3.8 |


### Overhead Tanks

- **SKUs:** 3
- **SKU x DS combos:** 15
- **Total qty sold:** 158
- **Total order lines:** 127

**Movement Tag Distribution:**

| Movement | Count | % |
|---|---:|---:|
| Moderate | 3 | 20.0% |
| Slow | 3 | 20.0% |
| Super Slow | 9 | 60.0% |

**Order Qty Volatility (CV):**

| Classification | Count | % |
|---|---:|---:|
| Predictable | 3 | 20.0% |
| Moderate | 11 | 73.3% |
| Volatile | 1 | 6.7% |

**Timing Volatility:**

| Classification | Count | % |
|---|---:|---:|
| Regular | 4 | 26.7% |
| Somewhat Erratic | 10 | 66.7% |
| Very Erratic | 1 | 6.7% |

**Pain Segment (Slow/Super Slow):** 12 SKUxDS combos (80% of category)

Top slow-moving SKUs by qty:

| SKU | Qty | Stores | Avg NZD |
|---|---:|---:|---:|
| OVE-TAN-ASH-WHT-2000 | 38.0 | 5.0 | 6.8 |
| OVE-TAN-ASH-WHT-1500 | 32.0 | 4.0 | 6.2 |
| OVE-TAN-ASH-WHT-1000 | 28.0 | 3.0 | 5.7 |


---

## The Pain Segment: Slow/Super Slow Movers Across All Categories

**Total Slow/Super Slow SKUxDS combos:** 3623 out of 4158 (87.1%)
**Unique SKUs in pain segment:** 1213
**Total qty from pain segment:** 67,693

| Category | Pain Combos | % of Category | Qty from Pain |
|---|---:|---:|---:|
| Furniture & Architectural Hardware | 873 | 93% | 15,593 |
| Wires, MCB & Distribution Boards | 556 | 99% | 3,055 |
| Painting | 430 | 80% | 4,088 |
| Plywood, MDF & HDHMR | 343 | 90% | 6,499 |
| CPVC Pipes & Fittings | 336 | 92% | 7,449 |
| Tiling | 262 | 76% | 3,953 |
| Switches & Sockets | 208 | 94% | 5,028 |
| Conduits & GI Boxes | 202 | 91% | 16,642 |
| Lighting | 109 | 96% | 1,712 |
| General Hardware | 96 | 71% | 1,268 |
| Fevicol | 91 | 66% | 580 |
| Water Proofing | 53 | 78% | 412 |
| Sanitary & Bath Fittings | 35 | 95% | 333 |
| Cement | 17 | 22% | 983 |
| Overhead Tanks | 12 | 80% | 98 |

These are the SKUs where the current average-based model systematically underestimates required stock.
For these, a percentile-based or fixed-floor strategy would provide better coverage.

---

## Overall Movement Distribution (All Categories)

| Movement | Count | % |
|---|---:|---:|
| Super Fast | 69 | 1.7% |
| Fast | 157 | 3.8% |
| Moderate | 309 | 7.4% |
| Slow | 352 | 8.5% |
| Super Slow | 3271 | 78.7% |
