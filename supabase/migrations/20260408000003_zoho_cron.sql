-- B9: pg_cron scheduled jobs for Zoho stock sync
-- All times in UTC (IST = UTC + 5:30, so 7:45 AM IST = 2:15 AM UTC)

-- Enable pg_cron extension if not already enabled
create extension if not exists pg_cron;

-- Helper function to call an Edge Function via HTTP
create or replace function call_edge_function(function_name text)
returns void
language plpgsql
security definer
as $$
declare
  function_url text;
  anon_key text;
begin
  function_url := current_setting('app.supabase_url') || '/functions/v1/' || function_name;
  anon_key := current_setting('app.anon_key');

  perform net.http_post(
    url := function_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || anon_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

-- 7:45 AM IST (2:15 AM UTC): Trigger items-list to queue all batches
select cron.schedule(
  'zoho-full-snapshot-queue',
  '15 2 * * *',  -- 2:15 AM UTC = 7:45 AM IST
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-items-list',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )$$
);

-- Every 30 seconds from 2:15 AM to 2:30 AM UTC: process batches
-- pg_cron minimum is 1 minute, so run every minute for 15 min window
select cron.schedule(
  'zoho-batch-stock-1',  '16 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-2',  '17 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-3',  '18 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-4',  '19 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-5',  '20 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-6',  '21 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-7',  '22 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-8',  '23 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-9',  '24 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);
select cron.schedule(
  'zoho-batch-stock-10', '25 2 * * *', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-batch-stock', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);

-- 7:55 AM IST (2:25 AM UTC): Save snapshot
select cron.schedule(
  'zoho-snapshot',
  '25 2 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/zoho-snapshot', headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'), body:='{}'::jsonb)$$
);

-- Hourly 9 AM – 8 PM IST (3:30 AM – 2:30 PM UTC): incremental sync
select cron.schedule('zoho-incremental-0330', '30 3 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-0430', '30 4 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-0530', '30 5 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-0630', '30 6 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-0730', '30 7 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-0830', '30 8 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-0930', '30 9 * * *',  $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-1030', '30 10 * * *', $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-1130', '30 11 * * *', $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-1230', '30 12 * * *', $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-1330', '30 13 * * *', $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
select cron.schedule('zoho-incremental-1430', '30 14 * * *', $$select net.http_post(url:=(select decrypted_secret from vault.decrypted_secrets where name='supabase_url')||'/functions/v1/zoho-incremental',headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='anon_key'),'Content-Type','application/json'),body:='{}'::jsonb)$$);
