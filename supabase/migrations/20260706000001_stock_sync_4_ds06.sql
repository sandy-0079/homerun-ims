-- Add stock-sync-4 cron for DS06 Kogilu (new DS, Zoho Inventory org 60075214606).
-- Continues the 3-min stagger: :35 DC+DS01, :38 DS02+DS03, :41 DS04+DS05, :44 DS06.
-- Single branch = 2 Zoho calls (physical + accounting) — well under the ~8/min rate limit.

select cron.unschedule('stock-sync-4') where exists (select 1 from cron.job where jobname = 'stock-sync-4');

select cron.schedule('stock-sync-4', '44 * * * *', $$
  select net.http_post(
    url     := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-stock',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body    := '{"branches":["DS06"]}'::jsonb
  );
$$);
