-- Re-enable cron jobs after manual pause during invoiceData migration.
-- Schedule: stock-sync-1 :35, stock-sync-2 :38, stock-sync-3 :41 UTC (3-min stagger)
--           orders-sync-hourly :35 UTC alongside stock-sync-1

select cron.unschedule('stock-sync-1') where exists (select 1 from cron.job where jobname = 'stock-sync-1');
select cron.unschedule('stock-sync-2') where exists (select 1 from cron.job where jobname = 'stock-sync-2');
select cron.unschedule('stock-sync-3') where exists (select 1 from cron.job where jobname = 'stock-sync-3');
select cron.unschedule('orders-sync-hourly') where exists (select 1 from cron.job where jobname = 'orders-sync-hourly');

select cron.schedule('stock-sync-1', '35 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DC","DS01"]}'::jsonb
  );
$$);

select cron.schedule('stock-sync-2', '38 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS02","DS03"]}'::jsonb
  );
$$);

select cron.schedule('stock-sync-3', '41 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS04","DS05"]}'::jsonb
  );
$$);

select cron.schedule('orders-sync-hourly', '35 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-orders',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);
