-- B9: pg_cron scheduled jobs for Zoho stock sync
-- All times in UTC (IST = UTC + 5:30, so 7:45 AM IST = 2:15 AM UTC)

-- Enable pg_cron and pg_net extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Supabase project constants (anon key is public, safe to store here)
-- URL and anon key for calling Edge Functions
do $$ begin
  perform set_config('app.supabase_url', 'https://rgyupnrogkbugsadwlye.supabase.co', false);
  perform set_config('app.anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc', false);
end $$;

-- Remove any existing schedules to avoid duplicates
select cron.unschedule(jobname) from cron.job where jobname like 'zoho-%' on conflict do nothing;

-- Helper: build the http_post call for an edge function
-- 7:45 AM IST (2:15 AM UTC): Trigger items-list to queue all batches
select cron.schedule(
  'zoho-full-snapshot-queue',
  '15 2 * * *',
  $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-items-list',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- 2:16 AM to 2:25 AM UTC (every minute for 10 min): process batches
-- Each call processes one batch of 100 items
select cron.schedule('zoho-batch-2-16', '16 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-17', '17 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-18', '18 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-19', '19 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-20', '20 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-21', '21 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-22', '22 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-23', '23 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-24', '24 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-batch-2-25', '25 2 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-batch-stock',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);

-- 7:55 AM IST (2:25 AM UTC): Save snapshot
select cron.schedule(
  'zoho-snapshot',
  '25 2 * * *',
  $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-snapshot',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Hourly incremental sync 9 AM – 8 PM IST (3:30 AM – 14:30 PM UTC)
select cron.schedule('zoho-incremental-0330',  '30 3  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-0430',  '30 4  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-0530',  '30 5  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-0630',  '30 6  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-0730',  '30 7  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-0830',  '30 8  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-0930',  '30 9  * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-1030',  '30 10 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-1130',  '30 11 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlje.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-1230',  '30 12 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-1330',  '30 13 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
select cron.schedule('zoho-incremental-1430',  '30 14 * * *', $$select net.http_post(url:='https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/zoho-incremental',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$);
