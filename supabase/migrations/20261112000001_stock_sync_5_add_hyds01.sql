-- Applied 2026-11-12 after sync-stock v42 deploy + a verified manual HYDS01 pull (spec §6.3).
--
-- stock-sync-5 (:47 UTC) gains HYDS01 Pati alongside DS08: two branches = one normal group, the
-- same shape as stock-sync-1..4. Command text is copied from 20260925000001_stock_sync_5_ds08.sql
-- with ONLY the branches array changed.

select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'stock-sync-5'),
  command := $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS08","HYDS01"]}'::jsonb
  );
$$);
