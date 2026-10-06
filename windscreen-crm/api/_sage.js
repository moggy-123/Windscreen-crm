
// Shared Sage helper — used by every Sage serverless function.
// The underscore at the start of the filename tells Vercel this is NOT a web address
// of its own; it's just shared code that the other /api files import.
//
// What it does:
//   • getValidAccessToken() — returns a working Sage access token, refreshing it first
//     if it has expired (Sage tokens only last ~5 minutes). Sage hands back a NEW refresh
//     token every time, so that is saved straight back into the sage_connection table.
//   • sageFetch() — makes a Sage API call with the token + business attached, and if Sage
//     says the token is bad, refreshes once and tries again.
//   • verifyAppUser() — checks the request came from someone logged into the CRM, so
//     nobody else can call these functions.

const SUPABASE_URL = "https://ubnwpghiozmydkczklek.supabase.co";
const TOKEN_URL = "https://oauth.accounting.sage.com/token";
export const SAGE_API = "https://api.accounting.sage.com/v3.1";

function serviceKey() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing from Vercel's environment variables.");
  return k;
}

// Talk to Supabase's database directly with the service key (server-side only).
export async function supabaseRest(path, options = {}) {
  const key = serviceKey();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Database error: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Confirms the request carries a valid CRM login. Returns the user, or null.
export async function verifyAppUser(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function loadConnection() {
  const rows = await supabaseRest("sage_connection?id=eq.default&select=*");
  const conn = rows?.[0];
  if (!conn || !conn.refresh_token) {
    throw new Error("Not connected to Sage yet — go to Settings → Connect to Sage.");
  }
  return conn;
}

async function refreshToken(conn) {
  const CLIENT_ID = process.env.SAGE_CLIENT_ID;
  const CLIENT_SECRET = process.env.SAGE_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("SAGE_CLIENT_ID or SAGE_CLIENT_SECRET is missing from Vercel's environment variables.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Refresh tokens expire after about a month without use, or if Sage access is revoked.
    throw new Error("The Sage connection has expired — go to Settings → Connect to Sage and log in again. (" + (data.error_description || data.error || res.status) + ")");
  }

  const updated = {
    access_token: data.access_token,
    // Sage gives a new refresh token each time and the old one stops working — must save it.
    refresh_token: data.refresh_token || conn.refresh_token,
    expires_at: Date.now() + (data.expires_in || 300) * 1000,
    updated_at: Date.now(),
  };
  await supabaseRest("sage_connection?id=eq.default", { method: "PATCH", body: JSON.stringify(updated) });
  return { ...conn, ...updated };
}

// Returns { token, businessId, businessName, refreshed } — always a token that works right now.
export async function getValidAccessToken({ force = false } = {}) {
  let conn = await loadConnection();
  let refreshed = false;
  // Refresh if it expires in less than a minute (or already has)
  if (force || !conn.access_token || Number(conn.expires_at || 0) - Date.now() < 60000) {
    conn = await refreshToken(conn);
    refreshed = true;
  }
  return { token: conn.access_token, businessId: conn.business_id, businessName: conn.business_name, expiresAt: Number(conn.expires_at), refreshed };
}

// Turns Sage's error format into a readable sentence.
function sageErrorMessage(body, status) {
  if (Array.isArray(body)) return body.map(e => e.$message || e.message).filter(Boolean).join("; ") || `Sage error ${status}`;
  return body?.$message || body?.error_description || body?.error || `Sage error ${status}`;
}

// Makes a Sage API call. path like "/contacts". Throws a readable error if Sage refuses.
export async function sageFetch(path, options = {}) {
  const call = async (auth) => fetch(`${SAGE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(auth.businessId ? { "X-Business": auth.businessId } : {}),
      ...(options.headers || {}),
    },
  });

  let auth = await getValidAccessToken();
  let res = await call(auth);
  if (res.status === 401) {
    auth = await getValidAccessToken({ force: true });
    res = await call(auth);
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(sageErrorMessage(body, res.status));
  return body;
}
