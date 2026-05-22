-- Hourly orders sync (PO + TO) via Zoho Books API
-- Fires at :35 UTC every hour = :05 IST, same as sync-stock.
-- Both run in parallel — they write different payload keys so no conflict.

select cron.unschedule('orders-sync-hourly') where exists (
  select 1 from cron.job where jobname = 'orders-sync-hourly'
);

select cron.schedule(
  'orders-sync-hourly',
  '35 * * * *',
  $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-orders',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
