-- Hourly stock sync via Zoho Books API
-- Fires at :35 UTC every hour = :05 IST every hour (IST = UTC+5:30)
-- e.g. 12:05 PM IST, 1:05 PM IST, 2:05 PM IST, ...

-- Remove any prior version of this job
select cron.unschedule('stock-sync-hourly') where exists (
  select 1 from cron.job where jobname = 'stock-sync-hourly'
);

select cron.schedule(
  'stock-sync-hourly',
  '35 * * * *',
  $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
