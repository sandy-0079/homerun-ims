-- Move orders-sync-hourly :35 → :50 UTC.
-- At :35 it fired alongside stock-sync-1 (DC+DS01); both write team_data/global and
-- the concurrent big upserts caused statement-timeout cancellations (observed
-- 2026-07-08: DC+DS01 stock 74m stale). :50 is clear of all stock syncs (:35/:38/:41/:44).

select cron.unschedule('orders-sync-hourly') where exists (
  select 1 from cron.job where jobname = 'orders-sync-hourly'
);

select cron.schedule('orders-sync-hourly', '50 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-orders',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);
