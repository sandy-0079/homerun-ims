-- Phase 1: Zoho Integration Tables

-- Live stock: latest stock per SKU × location, updated hourly
create table if not exists stock_live (
  sku text not null,
  location text not null,  -- DS01, DS02, DS03, DS04, DS05, DC
  stock_on_hand numeric not null default 0,
  quantity_in_transit numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (sku, location)
);

-- Daily 8 AM snapshots: opening stock for Mode 2 simulation
create table if not exists stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  sku text not null,
  location text not null,
  stock_on_hand numeric not null default 0,
  quantity_in_transit numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (snapshot_date, sku, location)
);

-- Sync queue: batches of item_ids to process during full snapshot
create table if not exists zoho_sync_queue (
  id uuid primary key default gen_random_uuid(),
  batch_number int not null,
  item_ids jsonb not null,  -- array of {item_id, sku} objects
  status text not null default 'pending',  -- pending | processing | done | error
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

-- Enable RLS (public read, service-role write for edge functions)
alter table stock_live enable row level security;
alter table stock_snapshots enable row level security;
alter table zoho_sync_queue enable row level security;

-- Public can read stock (needed by frontend)
create policy "Public read stock_live" on stock_live for select using (true);
create policy "Public read stock_snapshots" on stock_snapshots for select using (true);

-- Service role (edge functions) can write everything
create policy "Service write stock_live" on stock_live for all using (auth.role() = 'service_role');
create policy "Service write stock_snapshots" on stock_snapshots for all using (auth.role() = 'service_role');
create policy "Service write zoho_sync_queue" on zoho_sync_queue for all using (auth.role() = 'service_role');

-- Indexes for common queries
create index if not exists idx_stock_live_sku on stock_live (sku);
create index if not exists idx_stock_snapshots_date on stock_snapshots (snapshot_date);
create index if not exists idx_sync_queue_status on zoho_sync_queue (status);

-- Allow public to read queue (for status checking)
create policy "Public read zoho_sync_queue" on zoho_sync_queue for select using (true);
