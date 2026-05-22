-- Replace single stock sync cron with 3 staggered jobs, one per branch pair.
-- Each job makes 4 concurrent Zoho inventorysummary calls — under the ~8/min rate limit.
-- Staggered 1 minute apart so calls never overlap between jobs.
--
-- IST times (UTC+5:30):
--   stock-sync-1: :35 UTC = :05 IST  — DC + DS01
--   stock-sync-2: :36 UTC = :06 IST  — DS02 + DS03
--   stock-sync-3: :37 UTC = :07 IST  — DS04 + DS05

select cron.unschedule('stock-sync-hourly') where exists (
  select 1 from cron.job where jobname = 'stock-sync-hourly'
);
select cron.unschedule('stock-sync-1') where exists (
  select 1 from cron.job where jobname = 'stock-sync-1'
);
select cron.unschedule('stock-sync-2') where exists (
  select 1 from cron.job where jobname = 'stock-sync-2'
);
select cron.unschedule('stock-sync-3') where exists (
  select 1 from cron.job where jobname = 'stock-sync-3'
);

select cron.schedule(
  'stock-sync-1',
  '35 * * * *',
  $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DC","DS01"]}'::jsonb
  );
  $$
);

select cron.schedule(
  'stock-sync-2',
  '36 * * * *',
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
  '37 * * * *',
  $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS04","DS05"]}'::jsonb
  );
  $$
);
