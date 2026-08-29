// Nightly digest — turns the four status rows into one verdict and one email.
//
// PURE. No I/O, no clock: `now` is injected so the whole thing is testable and so a
// dry run and the deployed function cannot disagree about what "today" is.
//
// ⚠ KEYED ON DATES CARRIED IN THE DATA, NEVER ON `ok:true`. The 2026-07-28 invoice
// run reported ok:true over a day missing 27.7% of its quantity. A status flag records
// what a function believed about itself; a date records what actually landed.
//
// ⚠ UNKNOWN RESOLVES TO RED HERE — the opposite of `assessOutputFreshness`, and the
// difference is the action. There, uncertainty must not block a download, because a
// download blocked at 06:00 stops purchasing for the day. Here the action is sending an
// email: a spurious red costs thirty seconds of reading, and silence costs a night.
//
// Design record: docs/superpowers/specs/2026-08-04-nightly-digest-design.md

export type Level = "green" | "amber" | "red";
export type Mode = "ok" | "refused" | "silent" | "unreadable";

export type Check = {
  key: string;
  label: string;
  level: Level;
  mode: Mode;
  lag: number | null;
  missed: number | null;
  detail: string;
  remedy: string;
};

const DAY = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** How many duplicated SKU codes the email names before saying "+N more". */
const DUP_NAMES_SHOWN = 12;

/** How many skipped TO SKUs the email names. Same cap, same reason: 60 codes joined
 *  into one line is an unreadable wall in Gmail, and every test still passes. */
const SKIP_NAMES_SHOWN = 12;

/**
 * TO lines dropped in the last 24h because Zoho has the item inactive.
 *
 * ⚠ WHY THIS IS IN THE EMAIL AT ALL: the ground team sees only a COUNT on the TO
 * tool ("90 of 94 items"), deliberately — an inactive SKU is a Zoho catalogue
 * problem they cannot act on. The names belong to whoever can fix them, and the
 * digest already goes to exactly that person. No new UI, no new admin gate.
 *
 * ⚠ Deduped by SKU across TOs: one deactivated SKU appearing in six DS transfers
 * is ONE thing to fix, not six. `tos` still counts the transfers it touched, so
 * the blast radius stays visible.
 *
 * ⚠ Reads `params/toAudit`, which create-to owns and this function only borrows.
 * Every access is defensive: a malformed or absent row must degrade to "no line",
 * never throw — this is a reporting nicety riding in a watchdog.
 */
export function summariseToSkips(toAudit: any, now: number, windowMs = DAY): {
  skus: string[]; names: string[]; tos: string[]; total: number;
} | null {
  const entries = Array.isArray(toAudit?.entries) ? toAudit.entries : [];
  const seen = new Map<string, string>();
  const tos = new Set<string>();
  for (const e of entries) {
    const at = Date.parse(String(e?.at ?? ""));
    if (!Number.isFinite(at) || now - at > windowMs || at > now) continue;
    const skipped = Array.isArray(e?.skipped) ? e.skipped : [];
    for (const sk of skipped) {
      const sku = typeof sk?.sku === "string" ? sk.sku : null;
      if (!sku) continue;
      if (!seen.has(sku)) seen.set(sku, typeof sk?.name === "string" && sk.name ? sk.name : sku);
      if (e?.transfer_order_number) tos.add(String(e.transfer_order_number));
    }
  }
  if (seen.size === 0) return null;
  return {
    skus: [...seen.keys()],
    names: [...seen.entries()].map(([sku, name]) => `${name} (${sku})`),
    tos: [...tos],
    total: seen.size,
  };
}

/** Calendar date in Asia/Kolkata. The chain straddles midnight IST, so a UTC read is wrong. */
export function istDateOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * ISO date -> ms, or null. Strict on purpose: `03/08/2026` is exactly the value that
 * took prod down on 2026-07-29, and a digest that crashes on it reports nothing at all.
 */
function parseIsoDate(s: unknown): number | null {
  if (typeof s !== "string" || !ISO.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return null;
  // Date.parse normalises 2026-02-31 into March; round-tripping rejects that.
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmt = (v: number | null): string => (v === null ? "—" : v.toLocaleString("en-US"));

const CRORE = 1e7;
const LAKH = 1e5;
/** ₹7.93Cr — the unit the Overview card uses, so the email and the app read alike. */
const money = (n: number): string => `₹${(n / CRORE).toFixed(2)}Cr`;
/** A move: lakhs below a crore, because a typical night moves ₹10L and "₹0.10Cr" hides it. */
const move = (n: number): string => {
  const a = Math.abs(n);
  return `${n < 0 ? "-" : "+"}${a >= CRORE ? `₹${(a / CRORE).toFixed(2)}Cr` : `₹${(a / LAKH).toFixed(1)}L`}`;
};

export type ValuePoint = { date: string; min: number; max: number };

const validPoint = (e: any): e is ValuePoint =>
  !!e && typeof e === "object" && parseIsoDate(e.date) !== null &&
  num(e.min) !== null && num(e.max) !== null;

const byDate = (a: ValuePoint, b: ValuePoint) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/**
 * Append today's inventory value to the digest's own history row.
 *
 * ⚠ IDEMPOTENT BY DATE, and that is load-bearing. The digest can be invoked by hand
 * on the same day; a duplicate entry would become "yesterday" for tomorrow's delta
 * and silently report zero movement.
 *
 * ⚠ This history lives with the DIGEST, not with the engine run, because
 * `engine-run-nightly` fires TWICE (05:45 and 06:15 IST). An engine-side append would
 * record the same day twice every night and break every delta.
 */
export function appendHistory(history: unknown, entry: ValuePoint, keepDays = 60): ValuePoint[] {
  const kept = (Array.isArray(history) ? history : [])
    .filter(validPoint)
    .filter((e) => e.date !== entry.date)
    .map((e) => ({ date: e.date, min: e.min, max: e.max }));
  kept.push({ date: entry.date, min: entry.min, max: entry.max });
  kept.sort(byDate);
  return kept.slice(-keepDays);
}

/**
 * Per-input thresholds.
 *
 * ⚠ `healthyLag` DIFFERS PER INPUT AND IS NOT AN OFF-BY-ONE. Catalogue runs 21:55–23:55
 * IST — before midnight — so on the morning of D+1 its lastOkNight is correctly D.
 * Floors run 04:35 IST, after midnight, so its lastOkNight is correctly D+1. Deriving
 * one baseline for all four would report a healthy catalogue as a day late, every day.
 *
 * `amberAt: null` means no amber tier — floors go straight to red. That is earned by a
 * near-zero benign failure rate: one HTTP GET to a Google Sheet, no Zoho, so it cannot
 * be caught in a 429 window or starved. Invoices have twelve slots precisely because
 * Zoho is flaky, so one miss there is unremarkable.
 */
const SPEC = {
  invoices:  { label: "Invoice demand", healthyLag: 1, amberAt: 1,    redAt: 2 },
  catalogue: { label: "Catalogue",      healthyLag: 1, amberAt: 1,    redAt: 2 },
  floors:    { label: "SKU floors",     healthyLag: 0, amberAt: null, redAt: 1 },
  engine:    { label: "Engine run",     healthyLag: 0, amberAt: 1,    redAt: 2 },
} as const;

const WORST: Record<Level, number> = { green: 0, amber: 1, red: 2 };
const worse = (a: Level, b: Level): Level => (WORST[a] >= WORST[b] ? a : b);

function levelFor(missed: number, spec: { amberAt: number | null; redAt: number }): Level {
  if (missed >= spec.redAt) return "red";
  if (spec.amberAt !== null && missed >= spec.amberAt) return "amber";
  return "green";
}

/** Timestamp in IST, labelled. The chain is scheduled in IST; UTC in the email invites misreading. */
function istStampOf(at: unknown): string | null {
  const t = Date.parse(String(at ?? ""));
  if (!Number.isFinite(t)) return null;
  return `${new Date(t + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ")} IST`;
}

/**
 * "A guard refused" vs "it never ran" — two reds with opposite remedies.
 *
 * ⚠ Judged on `ok`, NOT on how recent the row is. A cron that never fired leaves the
 * PREVIOUS successful row in place, which is both recent AND ok:true — a recency test
 * reads that as a refusal and prints the last success's reason ("refused: ok"), sending
 * the reader to inspect a sheet that is fine. `ok === false` is the only honest signal:
 * every sync stamps the row on failure too, so a refusal is always recorded as one.
 */
function modeFor(row: any): Mode {
  return row?.ok === false ? "refused" : "silent";
}

/**
 * Why a status row refused. Two places carry it and BOTH must be read.
 *
 * ⚠ `change.reason` FIRST because it is the more specific of the two: sync-catalogue
 * stamps a generic top-level `change_guard_failed` and puts the real verdict
 * (`active_share_shift`, `row_collapse`) in `change`. Preferring the top level loses it.
 *
 * ⚠ But the top level MUST be the fallback. Only a change-guard rejection has a
 * `change` object at all — a parse failure, a fetch failure or an exception has none,
 * and reading `change.reason` alone printed "refused: reason not stated" on the nights
 * of 2026-08-14 and 08-15 while `reason: "duplicate_sku"` sat in the row, naming the
 * ops sheet exactly. Two mornings lost to a field the email declined to read.
 *
 * Generalisable, and the same shape as `autoAtFor`: when a value has two homes, a
 * reader that knows only one of them fails silently on precisely the case that matters.
 */
function reasonOf(row: any): string | null {
  const specific = row?.change?.reason;
  if (typeof specific === "string" && specific) return specific;
  const general = row?.reason;
  return typeof general === "string" && general ? general : null;
}

type Input = {
  now: number;
  invoices: any;
  catalogue: any;
  floors: any;
  engine: any;
  targets: any;
  /** params/digestHistory — the digest's own record. Absent on the first ever run. */
  history?: unknown;
  /** params/toAudit — written by create-to. Read ONLY for the skipped-line summary. */
  toAudit?: any;
};

export function assessNight(input: Input) {
  const { now } = input;
  const today = istDateOf(now);
  const todayMs = parseIsoDate(today)!;

  // ── the date each stage is judged on ───────────────────────────────────────
  // ⚠ `publishedPlan`, not `dates` or `plan`. It is set only by the atomic publish
  // that actually replaced the row, so it cannot claim a night that refused to write
  // — same reasoning as App.jsx preferring `publishedAt` over `at`.
  const publishedThrough = (() => {
    const p = input.invoices?.publishedPlan;
    if (!Array.isArray(p)) return null;
    const ok = p.map(parseIsoDate).filter((t): t is number => t !== null);
    return ok.length ? istDateOf(Math.max(...ok) - IST_OFFSET_MS) : null;
  })();

  const demandThrough = typeof input.targets?.inputs?.invoiceDataThrough === "string"
    ? input.targets.inputs.invoiceDataThrough : null;

  const engineRanOn = (() => {
    const t = Date.parse(String(input.targets?.refreshedAt ?? ""));
    return Number.isFinite(t) ? istDateOf(t) : null;
  })();

  const build = (
    key: keyof typeof SPEC,
    successDate: string | null,
    row: any,
    reason: string | null,
    text: (missed: number, mode: Mode) => { detail: string; remedy: string },
    greenDetail: string,
  ): Check => {
    const spec = SPEC[key];
    const ms = successDate === null ? null : parseIsoDate(successDate);
    if (ms === null) {
      return {
        key, label: spec.label, level: "red", mode: "unreadable", lag: null, missed: null,
        detail: `could not read a usable date from params — got ${JSON.stringify(successDate)}`,
        remedy: `Read the status row by hand; a missing or malformed row is itself a fault.`,
      };
    }
    const lag = Math.round((todayMs - ms) / DAY);
    const missed = Math.max(0, lag - spec.healthyLag);
    const level = levelFor(missed, spec);
    if (level === "green") {
      return { key, label: spec.label, level, mode: "ok", lag, missed, detail: greenDetail, remedy: "" };
    }
    const mode = modeFor(row);
    const t = text(missed, mode);
    const stamp = istStampOf(row?.at);
    return {
      key, label: spec.label, level, mode, lag, missed,
      detail: mode === "refused"
        ? `${t.detail} — the run recorded ${stamp ?? "at an unknown time"} refused: ${reason ?? "reason not stated"}`
        : t.detail,
      remedy: t.remedy,
    };
  };

  const nights = (n: number) => `${n} night${n === 1 ? "" : "s"} missed`;

  const checks: Check[] = [
    build("invoices", publishedThrough, input.invoices, input.invoices?.reason ?? null,
      (missed, mode) => ({
        // A date gets exactly two chances: the night after it, and the D-4 recheck three
        // nights later. planNightDates has no memory of misses, so past lag 5 the first
        // missed date has silently used both.
        detail: missed >= 4
          ? `${nights(missed)} — the D-4 recheck window has passed, so the earliest missing date is now unrecoverable from Zoho and needs a manual backfill`
          : `${nights(missed)} — self-heals via the D-4 recheck if the sync resumes within the next ${Math.max(0, 4 - missed)} night(s)`,
        remedy: mode === "refused"
          ? `A guard blocked the write and the previous complete pull is intact. Read params/invoiceSyncStatus before anything else.`
          : `Check cron.job_run_details for invoices-sync-window, then params/invoiceSyncStatus.reason.`,
      }),
      `published through ${publishedThrough}`),

    build("catalogue", typeof input.catalogue?.lastOkNight === "string" ? input.catalogue.lastOkNight : null,
      input.catalogue, reasonOf(input.catalogue),
      (missed, mode) => ({
        detail: `${nights(missed)} — new SKUs are invisible to the engine, and any floor added for one of them cannot take effect`,
        remedy: mode === "refused"
          ? `A guard blocked the write; the stored catalogue is intact. Read params/catalogueSyncStatus.change.`
          : `Five slots run 21:55–23:55 IST — if all five missed, suspect an org-wide Zoho window.`,
      }),
      `last synced ${input.catalogue?.lastOkNight}`),

    build("floors", typeof input.floors?.lastOkNight === "string" ? input.floors.lastOkNight : null,
      input.floors, reasonOf(input.floors),
      (missed, mode) => ({
        detail: `${nights(missed)} — any floor added to the ops sheet since then is NOT live, and nothing will backfill it`,
        remedy: mode === "refused"
          ? `A guard blocked the write, which means the sheet changed shape. Inspect the ops sheet first; stored floors are intact.`
          : `Check the sku-floors-sync cron, then invoke sync-sku-floors with {"dryRun": false}.`,
      }),
      `last synced ${input.floors?.lastOkNight}`),

    build("engine", engineRanOn, input.engine, input.engine?.reason ?? null,
      (missed, mode) => ({
        detail: `${nights(missed)} — params/toTargets is stale, so the TO tool is transferring on old numbers (IMS recomputes client-side and is unaffected)`,
        remedy: mode === "refused"
          ? `assessTargetsChange blocked the write. Read params/engineRunStatus.change before forcing anything.`
          : `Check engine-run-nightly, or click Apply & Re-run Model in IMS to rebuild toTargets in seconds.`,
      }),
      // ⚠ Plain language, not the row name. "toTargets refreshed" reads as a typo to
      // anyone who is not looking at the Supabase schema, and this email is for humans.
      // The remedy strings keep `params/toTargets` because acting on them needs it.
      `TO tool targets refreshed ${engineRanOn}`),
  ];

  // ── composition flags: what the guards structurally let through ────────────
  const flags: { key: string; level: Level; detail: string }[] = [];

  // ⚠ The highest-consequence field in the catalogue. Supplier ⇒ Min=Max=0 at every
  // location. assessMasterChange only trips above a 5% mix shift, so ~20 SKUs flipped
  // in Zoho passes every guard and silently stops them being stocked anywhere.
  const toSupplier = input.catalogue?.invAtChanged?.toSupplier;
  if (Array.isArray(toSupplier) && toSupplier.length) {
    flags.push({
      key: "toSupplier",
      level: "amber",
      detail: `${toSupplier.length} SKU(s) became Supplier overnight — Min=Max=0 everywhere: ${toSupplier.join(", ")}`,
    });
  }

  // Leading indicator for a SKU re-code. The write guard refuses above 1%, so anything
  // that published is below it — the value is watching it climb toward the line.
  const unknownPct = num(input.invoices?.coverage?.unknownPct);
  if (unknownPct !== null && unknownPct > 0.5) {
    flags.push({
      key: "unknownSku",
      level: "amber",
      detail: `unknown-SKU rate ${unknownPct}% is over half the 1% refusal threshold — check for a Zoho re-code`,
    });
  }

  // ⚠ GREEN, and that is the whole design of it. Since 2026-08-15 duplicate rows are
  // resolved by the ops append rule (last row wins) and so cannot change what the
  // engine receives — they are housekeeping, not a fault. But they GROW (1 duplicated
  // SKU on 08-14, 95 by 08-15), a human reading the sheet cannot tell which of two
  // conflicting rows is live, and this sync has NO write access to the sheet by
  // deliberate choice. So this email is the only mechanism that will ever get them
  // cleaned up, which is why it names the SKUs rather than just counting them.
  //
  // ⚠ It must not raise amber. Nobody has measured how often ops legitimately
  // appends, so any threshold would be guessed — the Sunday-row-count mistake, and a
  // note that goes amber every morning until someone tidies a spreadsheet would
  // discredit the reds sharing the email. Informational, exactly like invValue.
  const dupSkus: string[] = Array.isArray(input.floors?.duplicates?.skus) ? input.floors.duplicates.skus : [];
  const dupRows = num(input.floors?.duplicates?.rows);
  if (dupRows !== null && dupRows > 0) {
    // ⚠ NAMES ARE TRUNCATED HARD, and rendering the real thing is what showed why:
    // the live sheet has 95 duplicated SKUs, and joining even the status row's 60
    // produced a single unbroken wall of codes in Gmail that nobody would read. A
    // list you scroll past is worth less than a count plus a handful of examples —
    // the full set is in params/skuFloorSyncStatus and in the dry-run script.
    // `skuTotal` is the untruncated count; fall back to the list length for a row
    // written before that field existed.
    const total = num(input.floors?.duplicates?.skuTotal) ?? dupSkus.length;
    const shown = dupSkus.slice(0, DUP_NAMES_SHOWN);
    const names = shown.length
      ? `${shown.join(", ")}${total > shown.length ? ` … (+${total - shown.length} more)` : ""}`
      : "(names unavailable)";
    flags.push({
      key: "sheetDuplicates",
      level: "green",
      detail: `${dupRows} duplicate row(s) across ${total} SKU(s) in the ops floor sheet — the LAST row of each won, per the append rule, so floors are correct. Worth deleting the older rows: ${names}`,
    });
  }

  // The engine ran, but on older demand than what is published.
  if (demandThrough && publishedThrough && demandThrough < publishedThrough) {
    flags.push({
      key: "targetsBehind",
      level: "amber",
      detail: `targets were computed from demand through ${demandThrough} while ${publishedThrough} is published`,
    });
  }

  // ── inventory value: the directional line ──────────────────────────────────
  // ⚠ STAMPED BY THE ENGINE RUN, not derived here. params/toTargets carries DS
  // columns only and DC-inventorised Active SKUs only, so a value computed from it
  // came out ₹5.29Cr against the card's ₹7.93Cr — 33.3% short (measured 2026-08-04).
  // Printing that beside a card reading 7.93 would be worse than printing nothing.
  //
  // ⚠ INFORMATIONAL ONLY. It never moves the alert level: Min/Max legitimately
  // shifts every night as the 45-day window slides, and nobody has yet measured the
  // normal variance. Raising amber on a guessed threshold is the Sunday-row-count
  // mistake — a guard that cries wolf on schedule gets ignored, and this one would
  // discredit the reds sharing the email.
  const iv = input.targets?.invValue;
  const invValue = num(iv?.min) !== null && num(iv?.max) !== null ? { min: iv.min, max: iv.max } : null;

  const hist = (Array.isArray(input.history) ? input.history : []).filter(validPoint).sort(byDate);
  // Strictly EARLIER than today — a same-day entry (a hand re-run) would compare
  // today against itself and report a flat zero.
  const prev = hist.filter((e) => e.date < today).at(-1) ?? null;
  const invValueDelta = invValue && prev
    ? {
        prevDate: prev.date,
        prevMin: prev.min,
        prevMax: prev.max,
        absMax: invValue.max - prev.max,
        pctMax: prev.max ? ((invValue.max - prev.max) / prev.max) * 100 : 0,
      }
    : null;

  const level = [...checks.map((c) => c.level), ...flags.map((f) => f.level)]
    .reduce<Level>((a, b) => worse(a, b), "green");

  return {
    level,
    today,
    checks,
    flags,
    facts: {
      invValue,
      invValueDelta,
      demandThrough,
      publishedThrough,
      invoiceRows: num(input.targets?.inputs?.invoiceRows) ?? num(input.invoices?.merge?.rowsAfter),
      invoiceDates: num(input.invoices?.merge?.datesAfter),
      unknownPct,
      // ⚠⚠ `after` IS THE PULL, NOT THE CATALOGUE. On a night the guard REFUSES, the
      // pull is discarded and the stored master is unchanged — so reporting `after`
      // states a rejected write as fact. Measured 2026-08-29: the email read
      // "master 2,473 (1,971 active)" while the live master was 2,463 / 2,306. Read
      // literally it said 334 SKUs had been deactivated. They had not.
      // So: `after` when the run wrote, `before` when it refused.
      // Same class as the `refused: ok` bug — a convenient field standing in for the
      // true one, diverging on exactly the night the report exists for.
      master: num(input.catalogue?.ok === false
        ? input.catalogue?.change?.before
        : input.catalogue?.change?.after) ?? num(input.targets?.inputs?.skuMaster),
      active: num(input.catalogue?.ok === false
        ? input.catalogue?.statusMix?.before?.active
        : input.catalogue?.statusMix?.after?.active),
      // Reported, never alerting — see the render below.
      deactivated: Array.isArray(input.catalogue?.statusChanged?.toInactive)
        ? input.catalogue.statusChanged.toInactive.length
        : null,
      // ⚠ TO lines Zoho refused because the item is inactive. create-to now DROPS
      // these so the rest of the transfer can be created — before 2026-08-29 one
      // such line failed the WHOLE order and the DC team was hard-blocked. The
      // ground team deliberately sees only a count on screen; the SKU names come
      // here, to the one recipient who can fix them in Zoho.
      toSkipped: summariseToSkips(input.toAudit, now),
      prices: num(input.catalogue?.prices?.merged?.total),
      pricesRetained: num(input.catalogue?.prices?.merged?.retained),
      floors: num(input.floors?.skuCount) ?? num(input.targets?.inputs?.newSKUQty),
      floorsIneffective: num(input.floors?.ineffective?.total),
      // ⚠ ROWS, not SKUs — the two differ and ops needs the row count (how much to
      // delete) alongside the names (what to search for). 96 rows / 95 SKUs on
      // 2026-08-15. Reported only; see the flag below for why it never alerts.
      floorDuplicateRows: num(input.floors?.duplicates?.rows),
      floorDuplicateSkus: Array.isArray(input.floors?.duplicates?.skus) ? input.floors.duplicates.skus : [],
      targets: num(input.engine?.targets),
      // Free, already computed by assessTargetsChange. Arguably the sharpest change
      // signal available: a SKU entering or leaving the stocked set matters more than
      // a few percent of value drift, and it needs no history to detect.
      targetsAdded: num(input.engine?.change?.counts?.added),
      targetsRemoved: num(input.engine?.change?.counts?.removed),
    },
  };
}

export type Verdict = ReturnType<typeof assessNight>;

const ICON: Record<Level, string> = { green: "✅", amber: "🟡", red: "🔴" };

/** Subject-line wording for a flag, for the case where no stage failed. */
const FLAG_LABEL: Record<string, string> = {
  toSupplier: "SKUs moved to Supplier",
  unknownSku: "unknown-SKU rate rising",
  targetsBehind: "targets behind published demand",
};

export function renderDigest(v: Verdict): { subject: string; text: string } {
  const bad = v.checks.filter((c) => c.level !== "green");

  // ⚠ BRACKETED PREFIX FIRST, emoji second. The prefix is a stable token that one
  // Gmail filter can match in every state (green, amber, red, first-reading); leading
  // with the emoji would make the rule depend on which emoji happened to be chosen.
  const subject = v.level === "green"
    ? `[IMS] ✅ nightly — demand through ${v.facts.demandThrough ?? "—"}`
    // ⚠ A flag-only amber must NOT say "check inputs" or name a stage — every stage ran.
    // Sending the reader hunting for a broken stage that does not exist is how a signal
    // loses credibility.
    // ⚠ Only NON-GREEN flags may name the subject. A green flag (the floor-sheet
    // duplicate note) can never raise the level, so if it appeared here it would ride
    // into an amber subject caused by something else entirely and read as a second
    // fault. Reaching this branch at all guarantees `bad` or a non-green flag exists,
    // so the join is never empty.
    : `[IMS] ${ICON[v.level]} nightly — ${
      bad.length
        ? bad.map((c) => c.label).join(", ")
        : v.flags.filter((fl) => fl.level !== "green").map((fl) => FLAG_LABEL[fl.key] ?? fl.key).join(", ")
    }`;

  const f = v.facts;
  const lines: string[] = [];

  lines.push(
    v.level === "green"
      ? `${ICON.green} All four nightly stages ran and landed on time.`
      : bad.length
        ? `${ICON[v.level]} ${bad.length} ${bad.length === 1 ? "stage needs" : "stages need"} attention.`
        : `${ICON[v.level]} All four nightly stages ran, but ${v.flags.length === 1 ? "one thing is" : `${v.flags.length} things are`} worth a look.`,
  );
  lines.push("");

  // ⚠ Composition, not volume. Volume is what the guards already refuse on; these are
  // the numbers that move without tripping anything.
  lines.push(`demand through ${f.demandThrough ?? "—"}  ·  ${fmt(f.invoiceRows)} rows  ·  ${f.unknownPct ?? "—"}% unknown SKU`);
  // ⚠ Appended only when non-zero, and it NEVER changes the alert level. Zoho's
  // `status` is an ops lever here — 334 SKUs were flipped and reverted inside a day
  // on 2026-08-28 — and nobody has measured what a normal night looks like, so any
  // amber threshold would be a guess. A line that goes amber on routine ops activity
  // discredits the reds beside it. Same rule as floor-sheet duplicates, and the same
  // reason the inventory value never sets a level. Revisit once digestHistory has data.
  const deact = f.deactivated && f.deactivated > 0
    ? ` · ${fmt(f.deactivated)} deactivated in Zoho`
    : "";
  lines.push(`master ${fmt(f.master)}  (${fmt(f.active)} active${deact} · → Supplier: ${
    v.flags.find((x) => x.key === "toSupplier") ? "SEE BELOW" : "none"
  })  ·  prices ${fmt(f.prices)} (${fmt(f.pricesRetained)} retained)`);
  // Appended, never a placeholder: on a clean sheet the phrase is absent entirely
  // rather than reading "0 duplicate rows", which invites the reader to wonder what
  // it means. Same rule as the inventory-value line being omitted when unstamped.
  const dupes = f.floorDuplicateRows && f.floorDuplicateRows > 0
    ? ` · ${fmt(f.floorDuplicateRows)} duplicate row${f.floorDuplicateRows === 1 ? "" : "s"} superseded`
    : "";
  lines.push(`floors ${fmt(f.floors)}  (${fmt(f.floorsIneffective)} ineffective${dupes})  ·  targets ${fmt(f.targets)}${
    f.targetsAdded === null || f.targetsRemoved === null ? "" : ` (${f.targetsAdded} added, ${f.targetsRemoved} removed)`
  }`);

  // Omitted entirely rather than shown as "—" when the engine run has not stamped
  // it: a placeholder invites the reader to wonder what broke.
  if (f.invValue) {
    const d = f.invValueDelta;
    const trend = d
      ? `${d.absMax > 0 ? "▲" : d.absMax < 0 ? "▼" : "="} ${move(d.absMax)} (${d.pctMax >= 0 ? "+" : ""}${d.pctMax.toFixed(1)}%) vs ${d.prevDate}`
      : "— first reading, no prior day to compare";
    lines.push(`Inv Value (Max) ${money(f.invValue.max)}   ${trend}    (Min ${money(f.invValue.min)})`);
  }
  // ── TO lines dropped because Zoho has the item inactive ────────────────────
  // ⚠ ADMIN-ONLY BY CONSTRUCTION, not by a permission check: this email has one
  // recipient, and that is the entire access-control story. The ground team sees a
  // COUNT on the TO tool and nothing more — an inactive SKU is a Zoho catalogue
  // problem they cannot act on, and putting a SKU list in front of them would only
  // invite chasing stock that was never sent.
  //
  // ⚠ GREEN. It never moves the alert level, for the same reason as the deactivation
  // count and the floor duplicates: a dropped line means the TO SUCCEEDED where it
  // used to fail outright, so it is good news with a chore attached. An amber here
  // would fire on every mass-deactivation afternoon and train the reader to skim.
  if (f.toSkipped) {
    lines.push("");
    const t = f.toSkipped;
    lines.push(`TO lines skipped (inactive in Zoho): ${t.total}`);
    for (const n of t.names.slice(0, SKIP_NAMES_SHOWN)) lines.push(`    ${n}`);
    if (t.names.length > SKIP_NAMES_SHOWN) lines.push(`    +${t.names.length - SKIP_NAMES_SHOWN} more`);
    if (t.tos.length) lines.push(`  on ${t.tos.join(", ")}`);
    lines.push("  Reactivate in Zoho, or leave them out of the plan.");
  }
  lines.push("");

  lines.push("STAGES");
  // ⚠ A COLON, NOT PADDING. An earlier version aligned these with padEnd(15); Gmail
  // renders text/plain in a proportional font and collapses runs of spaces, so the
  // columns dissolved and "Engine run toTargets refreshed 2026-08-04" read as a
  // run-on sentence. Verified against a real delivered email, 2026-08-04 — monospace
  // layout in a plain-text email is not a thing you can rely on.
  for (const c of v.checks) lines.push(`  ${ICON[c.level]} ${c.label}: ${c.detail}`);

  if (v.flags.length) {
    lines.push("");
    lines.push("WORTH A LOOK");
    for (const fl of v.flags) lines.push(`  ${ICON[fl.level]} ${fl.detail}`);
  }

  // Only when something actually has a remedy — an empty heading reads as a bug.
  if (bad.length) {
    lines.push("");
    lines.push("WHAT TO DO");
    for (const c of bad) lines.push(`  • ${c.label}: ${c.remedy}`);
  }

  lines.push("");
  lines.push(`— IMS nightly digest, ${v.today}. Silence from this email is itself a signal: if it does not arrive, the watchdog is down.`);

  return { subject, text: lines.join("\n") };
}
