// nightly-digest — the one email that says whether last night's chain worked.
//
// Open Work item 17. `invoiceSyncStatus`, `catalogueSyncStatus`, `skuFloorSyncStatus`
// and `engineRunStatus` are written every night and, until this, nobody read them.
// The chain was automatic but not self-reporting.
//
// Design record: docs/superpowers/specs/2026-08-04-nightly-digest-design.md
//
// ⚠ HEARTBEAT, NOT ALERT-ONLY. It sends every morning, green or red. Alert-only shares
// a failure mode with the thing it watches: if the alerter dies, silence reads as
// success. With a fixed-time daily send, "no email by 06:40 IST" is itself the signal.
//
// ⚠ `send` DEFAULTS TO TRUE, deliberately inverting sync-sku-floors (`dryRun` true) and
// run-engine (`mode` "dry"). For those, a silent no-op is safe. For a watchdog it is
// fatal — a digest that never sends is precisely the failure this exists to catch.
// Dry runs pass {"send": false}.
//
// SAFETY — what this must never do:
//   * zero Zoho calls, so it cannot contribute to an org-wide 429 window
//   * reads only small `params` rows: never team_data/invoice_data (~7MB) or
//     team_data/global. Row counts come from stamps that already exist.
//   * writes exactly ONE row, `params/digestHistory`, which nothing else touches
//   * no frontend involvement
//
// ⚠ DELIVERABILITY, measured 2026-08-04. Brevo sends on behalf of @home-run.co
// without SPF/DKIM alignment, which is the same signature as domain spoofing — and
// the From and To are the same address, which Gmail treats with extra suspicion.
// It will NOT bounce: the domain publishes `v=DMARC1; p=none` and its SPF ends in
// `~all` (softfail), so there is no policy action. The realistic failure is the spam
// folder. The fix costs nothing and needs no DNS: a Gmail filter on the sender ->
// "Never send it to Spam". Check the spam folder after the first send.
//
// Body: { send?: boolean, now?: string }   Env: BREVO_API_KEY, DIGEST_RECIPIENTS,
// DIGEST_FROM_EMAIL, DIGEST_FROM_NAME (optional), SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assessNight, renderDigest, appendHistory, istDateOf } from "../_shared/nightlyDigest.ts";

const HISTORY_ROW = "digestHistory";
const STATUS_ROW = "digestStatus";
const KEEP_DAYS = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const readRow = async (id: string) => {
    const { data } = await supabase.from("params").select("payload").eq("id", id).maybeSingle();
    return data?.payload ?? null;
  };

  let status: Record<string, unknown> = { ok: false, reason: "exception" };

  try {
    const body = await req.json().catch(() => ({}));
    // Explicit opt-OUT, never opt-in. See the header note.
    const send = body.send !== false;
    const now = body.now ? Date.parse(body.now) : Date.now();
    if (!Number.isFinite(now)) return json({ ok: false, error: "unparseable `now`" }, 400);

    const [invoices, catalogue, floors, engine, targets, historyRow] = await Promise.all([
      readRow("invoiceSyncStatus"),
      readRow("catalogueSyncStatus"),
      readRow("skuFloorSyncStatus"),
      readRow("engineRunStatus"),
      readRow("toTargets"),
      readRow(HISTORY_ROW),
    ]);

    const history = Array.isArray(historyRow?.days) ? historyRow.days : [];
    const verdict = assessNight({ now, invoices, catalogue, floors, engine, targets, history });
    const { subject, text } = renderDigest(verdict);

    // ── Record today's inventory value, for tomorrow's delta ──────────────────
    // ⚠ Written AFTER the verdict is computed, so today's own entry can never become
    // the baseline it is compared against. Idempotent by date, so a hand re-run on the
    // same day replaces rather than duplicates.
    let recorded = false;
    if (verdict.facts.invValue) {
      const days = appendHistory(history, {
        date: verdict.today,
        min: verdict.facts.invValue.min,
        max: verdict.facts.invValue.max,
      }, KEEP_DAYS);
      const { error } = await supabase.from("params").upsert({ id: HISTORY_ROW, payload: { days } });
      if (error) console.error("digestHistory write failed (non-fatal):", error.message);
      else recorded = true;
    }

    // ── Send ──────────────────────────────────────────────────────────────────
    // Brevo, not Resend: Resend requires a verified DOMAIN (DNS records), Brevo
    // verifies a single sender address by email + mobile. An HTTPS API rather than
    // SMTP is not a preference — Supabase's own guide only ever demonstrates `fetch`,
    // and raw outbound TCP is unconfirmed on this runtime. Swapping providers is this
    // block and nothing else.
    const to = (Deno.env.get("DIGEST_RECIPIENTS") || "").split(",").map((s) => s.trim()).filter(Boolean);
    let sent: unknown = null;
    if (send) {
      // Fail loudly rather than report a successful run that mailed nobody.
      if (!to.length) throw new Error("DIGEST_RECIPIENTS is empty — refusing to claim a send that cannot happen");
      const key = Deno.env.get("BREVO_API_KEY");
      if (!key) throw new Error("BREVO_API_KEY is not set");
      const fromEmail = Deno.env.get("DIGEST_FROM_EMAIL");
      if (!fromEmail) throw new Error("DIGEST_FROM_EMAIL is not set — it must be a sender verified in Brevo");
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: Deno.env.get("DIGEST_FROM_NAME") || "HomeRun IMS", email: fromEmail },
          to: to.map((email) => ({ email })),
          subject,
          textContent: text,
        }),
      });
      // Brevo answers 201 Created on success, so test `r.ok`, never `status === 200`.
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Brevo ${r.status}: ${JSON.stringify(payload)}`);
      sent = payload?.messageId ?? true;
    }

    status = {
      ok: true, at: new Date().toISOString(), night: istDateOf(now),
      level: verdict.level, sent, send, recipients: to.length, recorded,
      checks: verdict.checks.map((c) => ({ key: c.key, level: c.level, lag: c.lag, mode: c.mode })),
      flags: verdict.flags.map((f) => f.key),
      subject,
    };
    // Every exit path records itself — a total failure that writes nothing is
    // indistinguishable from a cron that never fired (sync-catalogue, 2026-07-29).
    await supabase.from("params").upsert({ id: STATUS_ROW, payload: status });
    return json({ ...status, text });
  } catch (e) {
    status = { ok: false, at: new Date().toISOString(), reason: "exception", error: String(e) };
    await supabase.from("params").upsert({ id: STATUS_ROW, payload: status }).then(() => {}, () => {});
    console.error("nightly-digest:", e);
    return json(status, 500);
  }
});
