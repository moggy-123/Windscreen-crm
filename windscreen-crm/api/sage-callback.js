// Serverless function — the callback URL Sage redirects to after you approve the
// connection. Exchanges the one-time authorization code for an access token and a
// refresh token, then stores them so future requests can use the connection without
// asking you to log into Sage again.
//
// Needs these Vercel environment variables set:
//   SAGE_CLIENT_ID           — from the app you create in the Sage Developer Portal
//   SAGE_CLIENT_SECRET       — from the same place
//   SUPABASE_SERVICE_ROLE_KEY — from Supabase dashboard -> Settings -> API -> service_role key
//                                (NOT the same key the app itself uses — this one bypasses
//                                the login requirement, so it's only ever used here, on the
//                                server, never sent to the browser)

const SUPABASE_URL = "https://ubnwpghiozmydkczklek.supabase.co";
const TOKEN_URL = "https://oauth.accounting.sage.com/token";

export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(sageResultPage(false, error_description || error));
  }
  if (!code) {
    return res.status(400).send(sageResultPage(false, "No authorization code was returned by Sage."));
  }

  const CLIENT_ID = process.env.SAGE_CLIENT_ID;
  const CLIENT_SECRET = process.env.SAGE_CLIENT_SECRET;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const APP_URL = `https://${req.headers.host}`;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).send(sageResultPage(false, "Sage isn't fully configured yet — SAGE_CLIENT_ID or SAGE_CLIENT_SECRET is missing from Vercel's environment variables."));
  }
  if (!SERVICE_KEY) {
    return res.status(500).send(sageResultPage(false, "SUPABASE_SERVICE_ROLE_KEY is missing from Vercel's environment variables — needed to store the Sage connection."));
  }

  try {
    // Exchange the authorization code for tokens
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: `${APP_URL}/api/sage-callback`,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(502).send(sageResultPage(false, `Sage rejected the token exchange: ${tokenData.error_description || tokenData.error || JSON.stringify(tokenData)}`));
    }

    // Find which Sage business to use (the account you authorized may have more than one)
    const bizRes = await fetch("https://api.accounting.sage.com/v3.1/businesses", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const bizData = await bizRes.json();
    const business = bizData?.$items?.[0];

    const expiresAt = Date.now() + (tokenData.expires_in || 300) * 1000;

    // Store the connection in Supabase, using the service role key (this bypasses the
    // login requirement — that's expected and safe, since this only ever runs on the
    // server, never in the browser)
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/sage_connection?on_conflict=id`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        id: "default",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        business_id: business?.id || null,
        business_name: business?.business_name || null,
        updated_at: Date.now(),
      }),
    });
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      return res.status(502).send(sageResultPage(false, `Connected to Sage, but couldn't save the connection: ${errText}`));
    }

    return res.status(200).send(sageResultPage(true, business?.business_name || "your Sage account"));
  } catch (err) {
    return res.status(500).send(sageResultPage(false, err?.message || "Unknown error connecting to Sage."));
  }
}

// A minimal, self-contained result page — this loads in the browser after Sage
// redirects back, so it needs to work standalone without the rest of the app's code.
function sageResultPage(success, detail) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:Arial,sans-serif;background:#F8FAFC;margin:0;padding:40px 20px;text-align:center;}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
h1{font-size:18px;color:${success ? "#059669" : "#DC2626"};margin:0 0 10px;}
p{font-size:14px;color:#6B7280;line-height:1.5;}
a{display:inline-block;margin-top:20px;background:#1E3A5F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;}</style>
</head><body><div class="card">
<h1>${success ? "✅ Connected to Sage" : "⚠️ Couldn't connect"}</h1>
<p>${success ? `Successfully connected to <b>${detail}</b>. You can close this and go back to the app.` : detail}</p>
<a href="/">Back to the app</a>
</div></body></html>`;
}
