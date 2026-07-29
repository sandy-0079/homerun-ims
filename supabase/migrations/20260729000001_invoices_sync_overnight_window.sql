-- sync-invoices — move the nightly pull from 21:30 IST to the idle overnight window.
--
-- STILL SHADOW-ONLY. sync-invoices writes team_data/invoice_data_shadow, which
-- nothing reads. This migration changes only WHEN it runs.
--
-- WHY THE OLD 21:30 IST SLOT WAS WRONG. It was picked because "invoices are complete
-- by ~20:30". They are RAISED by then but not SETTLED, and the pull filtered on
-- payment status. Measured 2026-07-29 at ~12:00 IST over 224 in-flight invoices:
--
--     paid 112 (50%)     partially_paid 86 (38%)     sent 26 (12%)
--
-- The 2026-07-28 run therefore lost 312 rows / 2,081 units — 27.7% of the day's
-- quantity — and still reported ok:true. (The status filter is fixed separately in
-- _shared/invoiceMap.ts; this migration removes the reason to pull mid-settlement.)
--
-- WHY IT ALSO FIXES THE RATE LIMIT. Squeezing a whole day into one 150s invocation
-- forced CONCURRENCY 8, which drew 429s continuously: on 2026-07-28, 44 calls got
-- 429 on the first attempt, 26 on the second, 15 exhausted all three and were
-- dropped. The 10s/20s backoff sleeps added ~960 worker-seconds, pushing the run to
-- 172s where the gateway killed it with a 504 (the isolate kept going and still
-- wrote, which is why the failure was invisible).
--
-- Trading ends 20:00 IST and ops POs start ~06:00 IST, so the night is idle. Eight
-- slots an hour apart remove the deadline entirely: a few hundred invoices per
-- invocation at CONCURRENCY 4, with Zoho's per-minute budget fully reset between
-- chunks. 429s stop being generated rather than being retried.
--
-- SLOT CHOICE — :05 and :20 only.
--   Hourly crons occupy :35 stock-sync-1, :38 -2, :41 -3, :44 -4, :50 orders-sync.
--   :05/:20 leave 15+ minutes of clear air before :35. Verified against cron.job
--   2026-07-29: those five plus the three invoice jobs this migration replaces.
--
-- 19:00-22:59 UTC = 00:30-04:29 IST the NEXT IST day, so the function pulls
-- "yesterday IST" (see istDateRange's endOffsetDays) — the last complete day. All
-- eight slots resolve to the same date, which is what lets chunking span them.
--
-- NOT SCHEDULED HERE: sync-catalogue. It is deployed but still has two open defects
-- (it would rewrite the 5 'Confirmation Pending' SKUs to active, and drop the ~9
-- SKUs present in the CSV master but absent from Zoho /items). Schedule it at
-- 18:50 UTC / 00:20 IST — before this window, so the invoice coverage guard checks a
-- fresh master — only once those are fixed.

do $$
declare r record;
begin
  for r in select jobname from cron.job where jobname like 'invoices-sync-%' loop
    perform cron.unschedule(r.jobname);
  end loop;
end $$;

select cron.schedule('invoices-sync-window', '5,20 19-22 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-invoices',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- Slots after a successful publish cost one Supabase read and zero Zoho calls: the
-- function returns early on `already_published` (same plan, published < 12h ago).
--
-- To roll back to the previous schedule:
--   select cron.unschedule('invoices-sync-window');
--   then re-apply 20260728000001_invoices_sync_cron.sql
