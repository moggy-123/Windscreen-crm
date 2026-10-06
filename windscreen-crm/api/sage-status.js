// Test page for the Sage connection. Open https://<your-app>/api/sage-status in a browser.
// It refreshes the Sage login if needed and makes one harmless read-only call to Sage.
// Shows only "working / not working" — no business details or tokens are displayed.

import { getValidAccessToken, sageFetch } from "./_sage.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  try {
    const auth = await getValidAccessToken();
    await sageFetch("/contacts?items_per_page=1"); // proves the token actually works
    const mins = Math.max(0, Math.round((auth.expiresAt - Date.now()) / 60000));
    return res.status(200).send(page(true,
      `${auth.refreshed ? "The token had expired and was <b>refreshed successfully</b>." : "The existing token was still valid."} Sage answered a test request. Token good for about ${mins} more minute(s).`));
  } catch (e) {
    return res.status(500).send(page(false, e?.message || "Unknown error"));
  }
}

function page(ok, detail) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:Arial,sans-serif;background:#F8FAFC;margin:0;padding:40px 20px;text-align:center;}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
h1{font-size:18px;color:${ok ? "#059669" : "#DC2626"};margin:0 0 10px;}p{font-size:14px;color:#6B7280;line-height:1.5;}</style>
</head><body><div class="card"><h1>${ok ? "✅ Sage connection working" : "⚠️ Sage connection problem"}</h1><p>${detail}</p></div></body></html>`;
}
