-- sync-catalogue nightly cron — SKU Master + Purchase Prices from Zoho (Stage 7).
--
-- Writes team_data/global (read-merge-write, fresh read immediately before writing).
-- ~30 Zoho calls, ~16s. Held back until 2026-07-29 pending two fixes, both now done
-- and dry-run verified — see commit b14b391 and catalogueMap.ts STATUS OWNERSHIP.
--
-- SCHEDULE 18:25 UTC = 23:55 IST.
--
--   ⚠ NOT 18:50, which was the earlier suggestion in this repo: `orders-sync-hourly`
--   runs at :50 of EVERY hour, so 18:50 would collide with it on the same
--   team_data/global row. Concurrent writers on that row are exactly what caused the
--   statement-timeout incident that left DC+DS01 74m stale (migration 20260708000001).
--   Occupied minutes each hour: :35 :38 :41 :44 (stock-sync-1..4) and :50
--   (orders-sync). Free: :00-:34 and :51-:59.
--
--   Deliberately BEFORE the invoice window (`invoices-sync-window`, 19:05-22:20 UTC)
--   so the invoice coverage guard checks a FRESH master. A SKU newly created in Zoho
--   would otherwise have its invoice rows counted as unknown, and at >1% that guard
--   refuses to write invoice data at all.
--
-- BACKUP TAKEN FIRST: team_data/catalogue_backup_20260729, verified byte-identical
-- (skuMaster 2,092 · priceData 1,822). This matters more than for invoices —
-- `inventorisedAt` is hand-maintained and does NOT exist in Zoho, so a bad master
-- write cannot be repaired from the API.
--
-- EXPECTED FIRST-RUN EFFECT (measured by dry run, 2026-07-29): 5 SKUs gain Min/Max
-- because Zoho marks them active and the CSV master was stale — TENX4, E3MPF, WUTDS,
-- XP5EV (confirmation_pending -> active) and P292Y (inactive -> active). 29ZVW stays
-- excluded. New SKU HQ2B4 arrives confirmation_pending, so excluded, inventorisedAt
-- defaulted to DC. Prices 1,822 -> 1,834 with 350 retained by the merge.
--
-- Guards, all fail closed: assessMasterChange refuses an empty pull, a sharp shrink,
-- an inventorisedAt shift, or an active-share shift beyond the threshold.

select cron.schedule('catalogue-sync-nightly', '25 18 * * *', $$
  select net.http_post(
    url := 'https://rgyupnrogkbugsadwlye.supabase.co/functions/v1/sync-catalogue',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- To remove:
--   select cron.unschedule('catalogue-sync-nightly');
