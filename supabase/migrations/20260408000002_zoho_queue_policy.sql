-- Fix: allow service role to read zoho_sync_queue (needed by batch-stock function)
-- The original policy only allowed writes, not reads for service_role
drop policy if exists "Service write zoho_sync_queue" on zoho_sync_queue;
create policy "Service all zoho_sync_queue" on zoho_sync_queue for all to service_role using (true) with check (true);
create policy "Public read zoho_sync_queue" on zoho_sync_queue for select to anon using (true);
