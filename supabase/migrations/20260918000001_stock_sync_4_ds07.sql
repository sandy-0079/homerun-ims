-- DS07 HAL joins the stock-sync-4 slot (was DS06 alone).
--
-- WHY THIS SLOT RATHER THAN A FIFTH CRON: stock-sync-4 has been the only
-- SINGLE-branch group since DS06 went live — 2 fetch chains where :35, :38 and :41
-- each run 4. Adding DS07 restores it to the shape the stagger was designed around
-- rather than adding load. A 2-branch group is ~50-56 real Zoho requests in ~32s
-- (~100-105 req/min, i.e. already at Zoho's documented 100 req/min/org ceiling), so
-- this group now costs exactly what the other three have always cost.
--
-- A fifth cron at :47 would instead have added ~50 requests/cycle — ~1,200/day,
-- every day, for a store holding no stock.
--
-- ⚠⚠ DS08 MUST NOT BE ADDED HERE. Three branches in one invocation is measured
-- unsafe: 6 concurrent chains 429s after a single group (2026-07-06, re-confirmed
-- on the Inventory API). DS08 needs a fifth slot or the untested `per_page` work —
-- see Open Work. It is in sync-stock's BRANCHES map so it can be pulled by hand
-- (`{"branches":["DS08"]}`) to verify its branch id before go-live, but nothing
-- calls it on a schedule.
--
-- ⚠ Do NOT compress the 3-minute stagger to make room. It is not padding: it holds
-- the duty cycle near 35%, and overlapping two groups is ~200 req/min — the shape of
-- the 2026-07-09 429 storm.
--
-- Unschedule + reschedule is the only way to change a cron's body; the job name and
-- the :44 slot are unchanged, so the hourly cycle keeps its existing shape.

select cron.unschedule('stock-sync-4') where exists (select 1 from cron.job where jobname = 'stock-sync-4');

select cron.schedule('stock-sync-4', '44 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS06","DS07"]}'::jsonb
  );
$$);
