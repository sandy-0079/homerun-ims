#!/usr/bin/env node
/**
 * check-claude-md.mjs — proves the CLAUDE.md split lost nothing.
 *
 * WHY THIS EXISTS. CLAUDE.md was 232,380 chars and was split across several
 * files so that most of it loads on demand (a subdirectory CLAUDE.md is
 * included only when Claude reads files in that subtree) instead of at every
 * session start. A split is only safe if you can PROVE no line went missing,
 * so this counts rather than trusts: every warning line and every heading in
 * the frozen baseline must appear in EXACTLY ONE destination file.
 *
 *   0 occurrences = lost.  2+ = duplicated, which is how the changelog drifted
 *   from the body sections in the first place.
 *
 * It also refuses `@`-imports. Those resolve EAGERLY at session launch, so an
 * `@docs/foo.md` written in prose would silently re-inline everything we just
 * moved out while the file still looked small on disk. Paths must be written
 * inside backticks — the import parser skips code spans.
 *
 * Read-only. Touches nothing. Run: node scripts/check-claude-md.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const BASELINE_SHA = "cdc457c26787cc3dc90116ed37dee384af50d9e8";
const BASELINE_PATH = "CLAUDE.md";

// Destination set + the char budget each file is held to. Budgets are the
// regrowth rule: exceed one and this check goes amber, which is the prompt to
// promote the lesson and archive the incident rather than append again.
const DESTINATIONS = [
  { path: "CLAUDE.md",                     budget:  40_000 },
  { path: "src/engine/CLAUDE.md",          budget:  55_000 },
  { path: "supabase/functions/CLAUDE.md",  budget:  55_000 },
  { path: "src/tabs/CLAUDE.md",            budget:  30_000 },
  { path: "docs/CHANGELOG-ARCHIVE.md",     budget:  60_000 },
];

// Deliberate rewrites. Step 6 condenses some post-mortems into rules, so a
// baseline line can legitimately stop existing verbatim — but only if it is
// recorded here with what replaced it. An empty ledger means every line still
// exists word for word.
const LEDGER_PATH = "docs/claude-md-split-ledger.json";

const baseline = execFileSync("git", ["show", `${BASELINE_SHA}:${BASELINE_PATH}`], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});

const isHeading = (l) => /^#{1,6}\s+\S/.test(l);
const isWarning = (l) => l.includes("⚠");
const norm = (l) => l.trim().replace(/\s+/g, " ");

// Baseline lines we must account for, de-duplicated (a line repeated in the
// baseline only has to survive once).
const tracked = new Map(); // normalised -> {kind, raw}
for (const raw of baseline.split("\n")) {
  const line = norm(raw);
  if (!line) continue;
  if (!isWarning(raw) && !isHeading(raw)) continue;
  if (!tracked.has(line)) tracked.set(line, { kind: isWarning(raw) ? "warning" : "heading", raw });
}

const present = DESTINATIONS.filter((d) => existsSync(d.path));
const corpora = present.map((d) => ({
  ...d,
  text: readFileSync(d.path, "utf8"),
  lines: new Set(readFileSync(d.path, "utf8").split("\n").map(norm).filter(Boolean)),
}));

const lost = [];
const duplicated = [];
for (const [line, meta] of tracked) {
  const hits = corpora.filter((c) => c.lines.has(line));
  if (hits.length === 0) lost.push({ line, ...meta });
  else if (hits.length > 1) duplicated.push({ line, ...meta, where: hits.map((h) => h.path) });
}

// Allow only what the ledger explicitly records as condensed.
let ledger = {};
if (existsSync(LEDGER_PATH)) ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
const condensed = new Set(Object.keys(ledger.condensed ?? {}));
const unexplainedLost = lost.filter((l) => !condensed.has(l.line));
const explainedLost = lost.filter((l) => condensed.has(l.line));

// `@import` scan — outside code spans and fenced blocks, matching how the
// import parser itself reads the file.
const imports = [];
for (const c of corpora) {
  let fenced = false;
  c.text.split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const stripped = raw.replace(/`[^`]*`/g, "");
    const m = stripped.match(/(^|\s)@[.\w/~-]+\.\w+/);
    if (m) imports.push({ path: c.path, line: i + 1, text: raw.trim().slice(0, 90) });
  });
}

const totals = { warnings: 0, headings: 0 };
for (const m of tracked.values()) totals[m.kind === "warning" ? "warnings" : "headings"]++;
const accounted = tracked.size - lost.length;

console.log("CLAUDE.md split check — baseline " + BASELINE_SHA.slice(0, 7) + "\n");
console.log(`  tracked lines      ${tracked.size}  (${totals.warnings} warnings, ${totals.headings} headings)`);
console.log(`  accounted for      ${accounted}/${tracked.size}`);
console.log(`  lost               ${unexplainedLost.length}` + (explainedLost.length ? `  (+${explainedLost.length} condensed per ledger)` : ""));
console.log(`  duplicated         ${duplicated.length}`);
console.log(`  eager @imports     ${imports.length}\n`);

console.log("  file                                    chars    budget   status");
let overBudget = 0;
for (const d of DESTINATIONS) {
  if (!existsSync(d.path)) { console.log(`  ${d.path.padEnd(38)}      —              not yet created`); continue; }
  const chars = readFileSync(d.path, "utf8").length;
  const over = chars > d.budget;
  if (over) overBudget++;
  console.log(`  ${d.path.padEnd(38)} ${String(chars).padStart(7)}  ${String(d.budget).padStart(7)}   ${over ? "OVER BUDGET" : "ok"}`);
}

const show = (label, rows, fmt) => {
  if (!rows.length) return;
  console.log(`\n  ${label}`);
  for (const r of rows.slice(0, 20)) console.log("    " + fmt(r));
  if (rows.length > 20) console.log(`    …and ${rows.length - 20} more`);
};
show("LOST — in baseline, in no destination:", unexplainedLost, (r) => `[${r.kind}] ${r.line.slice(0, 110)}`);
show("DUPLICATED — in more than one destination:", duplicated, (r) => `${r.where.join(" + ")} :: ${r.line.slice(0, 80)}`);
show("EAGER @IMPORT — would re-inline at launch:", imports, (r) => `${r.path}:${r.line}  ${r.text}`);

const failed = unexplainedLost.length || duplicated.length || imports.length;
console.log("\n" + (failed ? "FAIL" : overBudget ? "PASS (over budget — see above)" : "PASS") + "\n");
process.exit(failed ? 1 : 0);
