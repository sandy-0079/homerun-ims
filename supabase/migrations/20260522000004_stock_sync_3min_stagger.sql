-- Increase stagger from 2 min to 3 min between stock sync jobs.
-- 2-min stagger caused collisions when Zoho was slow (~100s/function):
-- stock-sync-3 initial read overlapped with stock-sync-2 write → Postgres timeout.
-- 3-min stagger gives 30s clear gap even at the 150s wall clock worst case.
--
-- IST times (UTC+5:30):
--   stock-sync-1: :35 UTC = :05 IST  — DC + DS01   (unchanged)
--   stock-sync-2: :38 UTC = :08 IST  — DS02 + DS03 (was :37)
--   stock-sync-3: :41 UTC = :11 IST  — DS04 + DS05 (was :39)

select cron.unschedule('stock-sync-2') where exists (
  select 1 from cron.job where jobname = 'stock-sync-2'
);
select cron.unschedule('stock-sync-3') where exists (
  select 1 from cron.job where jobname = 'stock-sync-3'
);

select cron.schedule(
  'stock-sync-2',
  '38 * * * *',
  $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS02","DS03"]}'::jsonb
  );
  $$
);

select cron.schedule(
  'stock-sync-3',
  '41 * * * *',
  $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS04","DS05"]}'::jsonb
  );
  $$
);
