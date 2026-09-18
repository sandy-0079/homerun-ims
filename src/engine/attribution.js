// Demand attribution — which DS gets credited for a sale.
//
// Two modes:
//   "location"     — credit the DS that physically fulfilled the invoice
//                    (row.ds, from "Line Item Location Name"). Historical default.
//   "shippingCode" — credit the DS whose catchment the customer's pincode belongs
//                    to (row.pin -> map). When a DS is out of stock the order is
//                    invoiced from a different store, which inflates that store's
//                    demand and hides the real need at the customer's own DS.

// How much of the loaded invoice data the mapping can actually attribute.
// `coveragePct` is null — not 0 — when no row carries a pincode, because a
// percentage of nothing is not a measurement, and rendering it as 0% reads as
// "the mapping is broken" when the real answer is "there is nothing to map yet".
export function summariseCoverage(inv, map) {
  const m = map || {};
  let withPin = 0, covered = 0;
  const missing = new Map();
  for (const r of inv) {
    if (!r.pin) continue;
    withPin++;
    if (m[r.pin]) covered++;
    else missing.set(r.pin, (missing.get(r.pin) || 0) + 1);
  }
  return {
    withPin,
    pinPct: inv.length ? Math.round((withPin / inv.length) * 100) : 0,
    coveragePct: withPin ? (covered / withPin) * 100 : null,
    unmapped: [...missing.entries()].sort((a, b) => b[1] - a[1]),
  };
}

const PIN = /^\d{6}$/;
const DS_LABEL = /^(DS\d{2})\b/i;

// Accepts either shape ops actually produce:
//   a) a plain two-column sheet: Pincode,DS
//   b) the working sheet, where each DS owns a block of delivery-time columns
//      (60/90/120 mins) under a "DS0n <name>" header
// Returns { map, conflicts } — conflicts are surfaced rather than resolved, since
// a pincode claimed by two DSes is an ops data error we must not paper over.
export function parsePincodeMapCsv(text) {
  const rows = text.trim().split("\n").map((line) => {
    const vals = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { vals.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    vals.push(cur.trim());
    return vals;
  });

  const claims = new Map(); // pin -> Set<ds>
  const claim = (pin, ds) => {
    if (!claims.has(pin)) claims.set(pin, new Set());
    claims.get(pin).add(ds);
  };

  const header = (rows[0] || []).map((h) => h.toLowerCase());
  const pinCol = header.findIndex((h) => h === "pincode" || h === "pin code" || h === "shipping code");
  const dsCol = header.findIndex((h) => h === "ds" || h === "dark store");

  if (pinCol >= 0 && dsCol >= 0) {
    for (const r of rows.slice(1)) {
      const pin = (r[pinCol] || "").trim();
      const ds = (r[dsCol] || "").trim().toUpperCase();
      if (PIN.test(pin) && ds) claim(pin, ds);
    }
  } else {
    // Wide layout: find the row naming the DSes, then forward-fill that label
    // across its block so every column knows which DS it belongs to. Deriving
    // ownership this way avoids hard-coding a column stride.
    let best = -1, bestCount = 0;
    rows.forEach((r, i) => {
      const n = r.filter((c) => DS_LABEL.test(c)).length;
      if (n > bestCount) { bestCount = n; best = i; }
    });
    if (best < 0) return { map: {}, conflicts: [] };

    const dsByCol = [];
    let cur = null;
    rows[best].forEach((cell, c) => {
      const m = cell.match(DS_LABEL);
      if (m) cur = m[1].toUpperCase();
      dsByCol[c] = cur;
    });

    for (const r of rows.slice(best + 1)) {
      r.forEach((cell, c) => {
        const v = cell.trim();
        // The "#" index column holds 1,2,3… — never 6 digits, so PIN excludes it.
        if (PIN.test(v) && dsByCol[c]) claim(v, dsByCol[c]);
      });
    }
  }

  const map = {}, conflicts = [];
  for (const [pin, set] of claims) {
    const dses = [...set];
    map[pin] = dses[0];
    if (dses.length > 1) conflicts.push({ pin, dses });
  }
  return { map, conflicts };
}

// What an upload is about to change, BEFORE it is applied.
//
// ⚠⚠ WHY THIS EXISTS: `params/pincodeMap` is REPLACE-ENTIRELY, exactly like the
// invoice CSV. A short or partial sheet raises no error — the pincodes it omits
// simply stop being mapped, their demand falls back to the fulfilling store, and
// every donor silently re-inflates. Nothing in the app could show that, and the
// upload happens on the one morning a new store depends on it.
//
// Reported, never enforced: REMOVING pincodes is legitimate (a store closes, a
// catchment is re-cut) and a modal that cries wolf on a go-live morning is a modal
// people learn to click through. The number to look at is `removed` — a remap should
// MOVE pincodes, so a non-zero `removed` with no explanation means rows went missing
// rather than changing hands.
export function diffPincodeMap(before, after) {
  const A = before || {}, B = after || {};
  const moved = [], added = [], removed = [];
  for (const [pin, ds] of Object.entries(B)) {
    if (!(pin in A)) added.push({ pin, to: ds });
    else if (A[pin] !== ds) moved.push({ pin, from: A[pin], to: ds });
  }
  for (const pin of Object.keys(A)) if (!(pin in B)) removed.push({ pin, from: A[pin] });

  // Per-DS net, which is the line that actually reads as right or wrong: a store
  // gaining 34 while its neighbours give up 34 is a remap; a store gaining 34 while
  // nobody loses anything means the file grew rather than being re-cut.
  const net = {};
  const bump = (ds, k) => { (net[ds] ??= { gained: 0, lost: 0 })[k]++; };
  for (const m of moved) { bump(m.to, "gained"); bump(m.from, "lost"); }
  for (const a of added) bump(a.to, "gained");
  for (const r of removed) bump(r.from, "lost");

  return { beforeCount: Object.keys(A).length, afterCount: Object.keys(B).length, moved, added, removed, net };
}

/** One-line human summary of a diff — the string the upload alert shows. */
export function describePincodeDiff(d) {
  const per = Object.entries(d.net).sort()
    .map(([ds, n]) => `${ds} ${n.gained - n.lost >= 0 ? "+" : ""}${n.gained - n.lost}`).join(" · ");
  return [
    `${d.beforeCount} → ${d.afterCount} pincodes`,
    `${d.moved.length} moved · ${d.added.length} added · ${d.removed.length} removed`,
    per || "no change",
  ].join("\n");
}

export function applyAttribution(inv, cfg) {
  if (!cfg || cfg.mode !== "shippingCode") return inv;
  const map = cfg.map || {};
  return inv.map((r) => {
    const mapped = map[r.pin];
    return mapped && mapped !== r.ds ? { ...r, ds: mapped } : r;
  });
}
