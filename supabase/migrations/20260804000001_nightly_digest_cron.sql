-- nightly-digest: one email every morning saying whether last night's chain worked.
--
-- Open Work item 17. invoiceSyncStatus, catalogueSyncStatus, skuFloorSyncStatus and
-- engineRunStatus have been written every night since Stage 5 and, until this job,
-- nobody read them. The chain was automatic but not self-reporting — the gap between
-- "it runs every night" and "you will know if it didn't".
--
-- ⚠⚠ DO NOT APPLY THIS UNTIL THE FUNCTION HAS BEEN DEPLOYED AND EXERCISED BY HAND
-- with {"send": false} and then {"send": true}. Scheduling an undeployed function
-- produces a nightly 404 that nothing reports — the silent-failure shape this whole
-- job exists to remove.
--
-- SCHEDULE — 01:00 UTC = 06:30 IST, once daily.
--
--   ⚠ WHY 06:30 IST. It cannot be earlier and be accurate: engine-run-nightly's
--   second slot fires at 06:15 IST and rewrites params/toTargets, so a digest before
--   that would report a chain that had not finished. Ops POs start ~07:30 IST, which
--   leaves a full hour to act on a red.
--
--   ⚠ MINUTES. Occupied every hour: :35 :38 :41 :44 (stock-sync-1..4) and :50
--   (orders-sync). Free: :00-:34 and :51-:59. This job uses :00, and hour 01 UTC
--   carries no other nightly job.
--
--   ⚠ SLOTS AFTER MIDNIGHT IST. 01:00 UTC = 06:30 IST, well past the 3-hour offset
--   used by syncNightKey — but this function does not use syncNightKey at all. It
--   works in plain IST calendar dates (istDateOf), because it reports on "last
--   night" from the morning after, not on "which night am I part of".
--
-- ⚠ `send` DEFAULTS TO **TRUE**, deliberately inverting sku-floors-sync (`dryRun`
-- defaults true) and run-engine (`mode` defaults "dry"). For a writer, a silent
-- no-op is the safe default. For a watchdog it is fatal: a digest that quietly never
-- sends is exactly the failure being fixed, and it would report ok:true while doing
-- it. So an empty body sends. A dry run must ask, with {"send": false}.
--
-- WHAT IT TOUCHES
--   reads   params/{invoiceSyncStatus,catalogueSyncStatus,skuFloorSyncStatus,
--                   engineRunStatus,toTargets,digestHistory}
--   writes  params/digestHistory  (its own row, no other writer)
--           params/digestStatus   (its own row, written on EVERY exit path including
--                                  the catch — a total failure that records nothing is
--                                  indistinguishable from a cron that never fired,
--                                  which is what happened to sync-catalogue 2026-07-29)
--   zero Zoho calls, so it cannot contribute to an org-wide 429 window.
--   never team_data — not the ~7MB invoice row, not global.
--
-- THRESHOLDS (docs/superpowers/specs/2026-08-04-nightly-digest-design.md)
--   invoice demand  green lag 1 · amber 1 night missed · red 2   -- self-heals via the
--                   D-4 recheck; data becomes unrecoverable at lag 5, so red at lag 3
--                   leaves two nights of margin
--   catalogue       green lag 1 (it runs BEFORE midnight IST) · amber 1 · red 2
--   SKU floors      green lag 0 (it runs AFTER midnight IST) · red on the FIRST miss --
--                   no self-heal, near-zero benign failure rate, trivial remedy
--   engine run      green lag 0 · amber 1 · red 2
--
-- ROLLBACK — instant and complete; nothing depends on this job:
--   select cron.unschedule('nightly-digest');
--
-- Verify the job, and that no two jobs share a minute within an hour:
--   select jobname, schedule from cron.job order by jobname;

select cron.schedule('nightly-digest', '0 1 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/nightly-digest',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{"send": true}'::jsonb
  );
$$);
