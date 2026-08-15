// SKU x DS Ceiling — an absolute cap on what may be stocked at a store, whatever
// the strategy computed. The ops escape hatch for outliers no guardrail catches.
//
// WHY, with the case that prompted it (measured 2026-08-15): G9NYZ, a Rs6,269
// Finolex 300m coil, came out 19/29 at DS05 from two order-days — 20 units on
// 07-09, 1 on 07-29. Fixed Unit Floor's P90 of [20,1] is 18.1; its order-days gate
// needs NZD >= 2 and NZD was exactly 2; its spike cap needs >= 3 orders and there
// were 2. Both guardrails correctly declined to fire, and the result was Rs1.82L
// of wire at one dark store. CLAUDE.md logged this exact shape as a consciously
// accepted gap in July. The answer chosen was a blunt manual cap rather than a
// fourth guardrail for the fifth outlier to slip past.
//
// ⚠ A CEILING ONLY EVER REDUCES. It is not a target: a cell at 0/0 with a cap of 5
// stays 0/0. That is what makes deploying with an empty ceiling map provably a
// no-op, which is how this ships safely.
//
// ⚠ 0 IS A REAL CAP, meaning "stock nothing at this DS". Distinct from an absent
// entry, which means no cap at all. Dead Stock cannot express a cap of 0 at three
// stores while leaving three alone — it zeroes every location including the DC.
// See `src/skuCeilingCsv.js` for why blank and 0 must never be folded together.

/**
 * The cap for one SKU at one DS, or null when uncapped.
 *
 * ⚠ Returns `null` rather than `undefined` for "no cap" so a caller can never
 * confuse it with a legitimate cap of 0 through a falsy test. Callers should use
 * `cap !== null`, never `if (cap)`.
 *
 * SKU lookup is case-insensitive, mirroring runEngine's `nsq` lookup — SKU Master
 * and a hand-edited CSV disagree on casing more often than you would think.
 */
export function capFor(ceilings, skuId, dsId) {
  if (!ceilings) return null;
  let entry = ceilings[skuId];
  if (!entry) {
    const key = Object.keys(ceilings).find((k) => k.toLowerCase() === String(skuId).toLowerCase());
    if (!key) return null;
    entry = ceilings[key];
  }
  const cap = entry?.[dsId];
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : null;
}

/**
 * Clamp a computed Min/Max to a ceiling.
 *
 * ⚠ BOTH fields clamp. Capping Max alone would leave Min > Max, which no consumer
 * expects — Stock Health's tag order, the TO tool's replenish-to-Max arithmetic and
 * the Overrides delta all assume Min <= Max.
 */
export function clampToCeiling(min, max, cap) {
  if (cap === null || cap === undefined) return { min, max, applied: false };
  if (min <= cap && max <= cap) return { min, max, applied: false };
  return { min: Math.min(min, cap), max: Math.min(max, cap), applied: true };
}

/**
 * Clamp every store in a `stores` map to its ceiling, in place. Returns how many
 * cells moved.
 *
 * ⚠⚠ THIS EXISTS BECAUSE `runEngine` WRITES `stores[dsId]` FROM FOUR PLACES, and
 * the first implementation of the ceiling only touched one of them. The per-DS loop
 * has a NO-DATA path that `return`s early with three sub-branches (new-DS floor,
 * manual floor, nothing), and the Network Design bypass builds its own `_stores`
 * entirely separately. Capping inside the HAS-DATA branch therefore did nothing at
 * any store where the SKU had no sales in the window — which is precisely where a
 * manual floor is usually the thing setting the number.
 *
 * Found in production 2026-08-15: G9NYZ capped at 0 for DS01 still read Min=Max=1,
 * because DS01 had zero demand and a 1/1 floor. The tell was `postBlendSteps:
 * undefined` on that store while every working store had `[]`.
 *
 * So: ONE implementation, applied to the finished map. Call it immediately before
 * the DC is derived — the DC's floored branch is `round(sumMin x 0.2)` over these
 * same stores, so clamping first is what lets a DS cap reach the DC.
 */
export function applyCeilingToStores(stores, ceilings, skuId, dsList) {
  if (!ceilings || !stores) return 0;
  let applied = 0;
  for (const dsId of dsList) {
    const st = stores[dsId];
    if (!st) continue;
    const cap = capFor(ceilings, skuId, dsId);
    if (cap === null) continue;
    const c = clampToCeiling(st.min, st.max, cap);
    if (!c.applied) continue;
    // The no-data branches never create this array, hence the ??=.
    (st.postBlendSteps ??= []).push({ rule: "SKU Ceiling", cap, beforeMin: st.min, beforeMax: st.max });
    st.min = c.min;
    st.max = c.max;
    // ⚠ Dead Stock must keep its tag: it already forced 0/0 and a cap cannot lower
    // that further, so `applied` is false there and we never reach this line.
    st.logicTag = "SKU Ceiling";
    applied++;
  }
  return applied;
}
