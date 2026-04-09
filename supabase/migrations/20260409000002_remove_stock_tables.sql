-- Remove stock sync infrastructure (replaced by CSV upload workflow)

-- Drop cron jobs
do $$
declare r record;
begin
  for r in select jobname from cron.job where jobname like 'zoho-%' loop
    perform cron.unschedule(r.jobname);
  end loop;
end $$;

-- Drop tables
drop table if exists stock_live cascade;
drop table if exists stock_snapshots cascade;
drop table if exists zoho_sync_queue cascade;
