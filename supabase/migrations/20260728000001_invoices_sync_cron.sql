-- sync-invoices nightly cron — Stage 4 (SHADOW).
--
-- NOT YET APPLIED. Writes only team_data/invoice_data_shadow, which nothing reads.
--
-- SCHEDULE 16:00 UTC = 21:30 IST, with resume passes at :06 and :12.
--
--   Trading closes 20:00 IST; invoices are complete by ~20:30.
--   The team raises TOs at 14:30 and 20:30 IST — 21:30 IST clears both.
--   The hourly stock/orders crons occupy :35-:50 UTC, so :00-:34 is free and
--   all three passes finish with ~20 minutes to spare.
--
-- WHY THREE PASSES: sync-invoices completes exactly one date per invocation.
-- A day can be ~1,000 invoices and Zoho's speed varies ~3.5x (measured
-- 289ms/call quiet, ~1s/call under load), so a two-day window in a single pass
-- can exceed the 150s wall clock. Pass 1 takes the first date and leaves the
-- rest in params/invoiceSyncCursor; passes 2 and 3 drain it. When there is
-- nothing pending they return immediately on the cooldown, costing one
-- Supabase read and zero Zoho calls.
--
-- The function's 15-minute cooldown deliberately does NOT block cursor drains,
-- so :06 and :12 still run. See supabase/functions/_shared/syncCooldown.ts.

do $$
declare r record;
begin
  for r in select jobname from cron.job where jobname like 'invoices-sync-%' loop
    perform cron.unschedule(r.jobname);
  end loop;
end $$;

select cron.schedule('invoices-sync-main', '0 16 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-invoices',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

select cron.schedule('invoices-sync-resume-1', '6 16 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-invoices',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

select cron.schedule('invoices-sync-resume-2', '12 16 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-invoices',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- To remove:
--   select cron.unschedule('invoices-sync-main');
--   select cron.unschedule('invoices-sync-resume-1');
--   select cron.unschedule('invoices-sync-resume-2');
