-- Move invoiceData from team_data/global to team_data/invoice_data.
-- Sync functions (sync-stock, sync-orders) only read/write team_data/global.
-- With invoiceData removed, the global payload drops from ~7MB to ~2MB,
-- cutting Supabase Disk IO per sync by ~70% and preventing burst budget exhaustion.

DO $$
BEGIN
  -- Create invoice_data row with just invoiceData extracted from global
  INSERT INTO team_data (id, payload, updated_at)
  SELECT
    'invoice_data',
    jsonb_build_object('invoiceData', COALESCE(payload->'invoiceData', '[]'::jsonb)),
    now()
  FROM team_data
  WHERE id = 'global'
  ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload, updated_at = now();

  -- Remove invoiceData from global payload
  UPDATE team_data
  SET payload    = payload - 'invoiceData',
      updated_at = now()
  WHERE id = 'global';
END $$;
