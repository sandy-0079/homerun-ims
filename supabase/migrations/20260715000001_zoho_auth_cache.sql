-- Zoho OAuth access-token cache (service-role only).
--
-- Why: every edge-function invocation (sync-stock ×4/hr, sync-orders, create-to
-- from the TO tool) was minting a fresh Zoho access token via refresh_token
-- grant. Bursts against accounts.zoho.in/oauth/v2/token tripped Zoho's throttle
-- ("too many requests continuously"), failing whichever crons hit it first
-- (2026-07-14: DC/DS01/DS02/DS03 missed a cycle). Caching the token (valid ~1h)
-- and reusing it drops token-endpoint calls from ~5-10/hr to ~1/hr.
--
-- Security: RLS is ON with NO policies, so anon + authenticated get nothing —
-- the access token is NOT exposed via the anon key (unlike params, which the
-- frontend can read). The edge functions use the service-role key, which
-- bypasses RLS. Grants are revoked from anon/authenticated as belt-and-braces.

create table if not exists public.zoho_auth_cache (
  id         text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.zoho_auth_cache enable row level security;
-- Intentionally no RLS policies: only service_role (bypassrls) may read/write.
revoke all on public.zoho_auth_cache from anon, authenticated;
