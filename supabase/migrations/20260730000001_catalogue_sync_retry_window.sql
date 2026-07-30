-- catalogue-sync-nightly: one nightly fire -> six, so a transient Zoho outage
-- can no longer cost a whole night's catalogue refresh.
--
-- WHY: on 2026-07-29, the FIRST real run of this cron died on an org-wide Zoho 429
-- penalty window. It was not alone — every Zoho consumer failed in the same window
-- and all recovered at 18:35 UTC:
--
--     17:35 17:38 17:41 17:44  sync-stock      500
--     17:50                    sync-orders     500
--     18:25                    sync-catalogue  500   <-- the catalogue's only shot
--     18:35 onward             everything      200
--
-- Ruled out as causes: our own call volume (the day was clean; the last burst was
-- create-to x20 at 15:45 UTC, ~1h50m earlier), a recurring nightly Zoho window
-- (the same window on 07-26/27/28 had 0 non-200 of 15/18/33 invocations), and the
-- token cache (`zoho token: cache hit` throughout). The trigger was external.
--
-- ⚠ SPLITTING THE WORK WOULD NOT HAVE HELPED, and that distinction matters.
-- sync-invoices was CAUSING its own 429s — 8 concurrent workers over ~500 calls,
-- with the per-call backoff sleeping ~960 worker-seconds and blowing the 150s wall
-- clock. Chunking cut instantaneous pressure, which was the disease there.
-- sync-catalogue is ~30 calls, SEQUENTIAL (concurrency 1), ~16s, and it died on
-- page 1 having consumed nothing. It was a victim, not a cause. Same symptom,
-- opposite cause: the cure is retrying LATER IN TIME, not smaller chunks.
--
-- SCHEDULE — FIVE attempts, 21:55 to 23:55 IST, first success wins:
--
--     16:25Z = 21:55 IST      17:55Z = 23:25 IST
--     16:55Z = 22:25 IST      18:25Z = 23:55 IST   <- existing job, UNCHANGED
--     17:25Z = 22:55 IST
--
--   Spans 2h — deliberately WIDER than the ~55min outage above, which would have
--   killed both a 23:55 and a 23:25 slot. Relocating one slot buys nothing; only
--   attempts spanning more than the outage do.
--
--   ⚠ Retries had to go EARLIER, not later. The last slot is bounded by
--   `invoices-sync-window` starting 19:05 UTC (00:35 IST): the invoice coverage
--   guard must see a fresh master, or a SKU newly created in Zoho has its invoice
--   rows counted as unknown, and above 1% that guard refuses to write at all.
--   23:55 IST leaves a 40-MINUTE BUFFER. A 00:25 IST slot was considered and
--   dropped (Sandy, 2026-07-30): only 10 minutes of margin, and a run that hits
--   429 backoff (10s + 20s per call) could stretch into the invoice window.
--
--   ⚠ Five slots are NOT expressible as one cron string, so this adds a SECOND
--   job for the four earlier attempts and leaves `catalogue-sync-nightly` exactly
--   as it is. That is deliberate: the currently-working schedule is never touched,
--   the addition is independently unschedulable for rollback, and there is no
--   window in which a botched reschedule leaves the catalogue with no cron at all.
--
--   ⚠ Minutes :25 and :55 are both free. Occupied every hour: :35 :38 :41 :44
--   (stock-sync-1..4) and :50 (orders-sync). Free: :00-:34 and :51-:59. Every slot
--   clears the 3-min stagger discipline this repo settled on (20260708000001).
--
--   ⚠ NO SLOT CROSSES MIDNIGHT IST, which is what keeps the night key simple.
--   If you ever add a slot at or past 00:00 IST, re-read syncNightKey first: a
--   post-midnight slot keyed on the plain IST date would start a "new night",
--   re-pull, and then poison the FOLLOWING night's gate into skipping entirely
--   while reporting ok. The offset shift exists to survive exactly that edit.
--
-- ⚠ FIVE SLOTS DO NOT MEAN FIVE PULLS. sync-catalogue now gates on `lastOkNight` in
-- params/catalogueSyncStatus (see _shared/syncCooldown.ts `alreadyRanTonight`).
-- The first SUCCESS closes the night; later slots return `already_ran_tonight`
-- after a single Supabase read and zero Zoho calls — the same shape as
-- sync-invoices' `already_published`. A FAILED run does not close the gate, which
-- is the entire point. COOLDOWN_MS (15 min) remains as a separate anti-hammering
-- guard and does not block the 30-min slot spacing.
--
-- `catalogue-sync-nightly` ('25 18 * * *' = 23:55 IST) is intentionally NOT touched
-- by this migration. Only the four earlier attempts are added.

select cron.schedule('catalogue-sync-earlier', '25,55 16,17 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-catalogue',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- ROLLBACK — reverts to exactly the pre-2026-07-30 behaviour (one fire at 23:55
-- IST), because `catalogue-sync-nightly` was never modified:
--   select cron.unschedule('catalogue-sync-earlier');
--
-- Verify both jobs, and that no two share a minute with the hourly syncs:
--   select jobname, schedule from cron.job order by jobname;
