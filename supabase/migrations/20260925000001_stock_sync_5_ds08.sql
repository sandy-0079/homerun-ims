-- DS08 Rajajinagar gets its own stock slot: stock-sync-5 at :47 UTC (:17 IST).
--
-- DS08 went live on IMS 2026-09-25 18:32 IST (openingDSList → []), ahead of trading, so the
-- DC can stock it. Until now it had no cron by design (Open Work 39): an unopened store holds
-- no stock, so hourly syncing bought nothing.
--
-- WHY A FIFTH SLOT RATHER THAN A THIRD BRANCH IN stock-sync-4: three branches in one invocation
-- is measured unsafe — 6 concurrent fetch chains 429 after a single group (2026-07-06,
-- re-confirmed on the Inventory API). A single branch is 2 chains ≈ 28 real Zoho requests, half
-- a normal group, so this adds ~670 requests/day to the ~4,400 the other four already cost.
--
-- WHY :47. It is the existing gap between stock-sync-4 (:44) and orders-sync-hourly (:50), so
-- every job keeps a 3-minute stagger. ⚠ Do NOT compress the stagger to make room for anything:
-- it holds the duty cycle near 35%, overlapping two groups is ~200 req/min (the 2026-07-09 429
-- storm), and a 2-minute stagger has already produced Supabase statement timeouts on the shared
-- team_data/global row.
--
-- The higher-leverage fix remains the untested `per_page` > 200 probe, which would shrink every
-- group ~4× and could then justify a tighter cycle. This slot does not block it.
--
-- ⚠ THREE LISTS MIRROR THE CRON GROUPS and must change together: IMS StockHealthTab SYNC_GROUPS,
-- homerun-to src/sync.js PULL_GROUPS, and these crons.

select cron.unschedule('stock-sync-5') where exists (select 1 from cron.job where jobname = 'stock-sync-5');

select cron.schedule('stock-sync-5', '47 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS08"]}'::jsonb
  );
$$);
