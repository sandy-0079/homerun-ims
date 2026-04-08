// Shared Zoho API utilities for all Edge Functions

const ZOHO_TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token";
const ZOHO_BASE_URL = "https://www.zohoapis.in/inventory/v1";
export const ORG_ID = Deno.env.get("ZOHO_ORG_ID") ?? "";

// Location name → tool DS mapping
export const LOCATION_MAP: Record<string, string> = {
  "DS01 Sarjapur": "DS01",
  "DS02 Bileshivale": "DS02",
  "DS03 Kengeri": "DS03",
  "DS04 Chikkabanavara": "DS04",
  "DS05 Basavanapura": "DS05",
  "DC01 Rampura": "DC",
};

// Invoice statuses for engine (Min/Max computation)
export const ENGINE_STATUSES = ["paid", "overdue"];

// Invoice statuses for Mode 2 simulation (actual stock)
export const SIM_STATUSES = ["paid", "overdue", "sent"];

let _cachedToken: string | null = null;
let _tokenExpiry = 0;

/** Get a valid Zoho access token, refreshing if needed */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry - 60_000) return _cachedToken;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: Deno.env.get("ZOHO_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("ZOHO_CLIENT_SECRET") ?? "",
    refresh_token: Deno.env.get("ZOHO_REFRESH_TOKEN") ?? "",
  });

  const res = await fetch(ZOHO_TOKEN_URL, { method: "POST", body });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  _cachedToken = data.access_token;
  _tokenExpiry = now + (data.expires_in ?? 3600) * 1000;
  return _cachedToken!;
}

/** Make an authenticated GET request to Zoho Inventory API */
export async function zohoGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await getAccessToken();
  const url = new URL(`${ZOHO_BASE_URL}/${path}`);
  url.searchParams.set("organization_id", ORG_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  if (!res.ok) throw new Error(`Zoho API error ${res.status} on ${path}`);
  return res.json();
}

/** Standard CORS + JSON response helper */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}
