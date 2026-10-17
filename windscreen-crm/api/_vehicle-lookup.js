// Looks up a vehicle's make, model and colour from its registration, using the free
// DVSA MOT History API. Read-only. Called via /api/sage?action=vehicle-lookup&reg=AB12CDE
// (it lives in the Sage router only so it doesn't count as another Vercel function).
//
// Needs these in Vercel → Settings → Environment Variables (from the DVSA sign-up email):
//   MOT_CLIENT_ID, MOT_CLIENT_SECRET, MOT_API_KEY, MOT_TOKEN_URL
//   MOT_SCOPE (optional — defaults to https://tapi.dvsa.gov.uk/.default)

import { verifyAppUser } from "./_sage.js";

const API = "https://history.mot.api.gov.uk/v1/trade/vehicles/registration/";
let cached = { token: "", expires: 0 };   // reused while the server stays warm

async function getToken() {
  if (cached.token && cached.expires - Date.now() > 60000) return cached.token;
  const { MOT_CLIENT_ID, MOT_CLIENT_SECRET, MOT_TOKEN_URL, MOT_SCOPE } = process.env;
  const res = await fetch(MOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: MOT_CLIENT_ID,
      client_secret: MOT_CLIENT_SECRET,
      scope: MOT_SCOPE || "https://tapi.dvsa.gov.uk/.default",
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("DVSA login failed — check MOT_CLIENT_ID, MOT_CLIENT_SECRET and MOT_TOKEN_URL in Vercel. (" + (j.error_description || j.error || res.status) + ")");
  cached = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

// "LAND ROVER" → "Land Rover", but keep short codes like "BMW", "VW", "X5" as they are
const tidy = s => String(s || "").trim().split(/\s+/).map(w => (w.length <= 3 || /\d/.test(w)) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");

export const motConfigured = () => ["MOT_CLIENT_ID", "MOT_CLIENT_SECRET", "MOT_API_KEY", "MOT_TOKEN_URL"].every(k => process.env[k]);

// Returns { reg, make, model, colour, fuel, year } or null if DVSA has no record
export async function lookupReg(rawReg) {
  const reg = String(rawReg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const call = async () => fetch(API + encodeURIComponent(reg), {
    headers: { Authorization: `Bearer ${await getToken()}`, "X-API-Key": process.env.MOT_API_KEY, Accept: "application/json" },
  });
  let r = await call();
  if (r.status === 401) { cached = { token: "", expires: 0 }; r = await call(); }
  if (r.status === 404) return null;
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`DVSA lookup failed (${r.status}): ${v.errorMessage || v.message || "try again later"}`);
  return {
    reg: v.registration || reg,
    make: tidy(v.make), model: tidy(v.model), colour: tidy(v.primaryColour), fuel: tidy(v.fuelType),
    year: String(v.manufactureDate || v.registrationDate || v.firstUsedDate || "").slice(0, 4),
  };
}

export default async function vehicleLookup(req, res) {
  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const missing = ["MOT_CLIENT_ID", "MOT_CLIENT_SECRET", "MOT_API_KEY", "MOT_TOKEN_URL"].filter(k => !process.env[k]);
    if (missing.length) return res.status(400).json({ error: `Reg lookup isn't set up yet — add ${missing.join(", ")} in Vercel (from your DVSA email), then redeploy.` });

    const reg = String(req.query?.reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (reg.length < 2 || reg.length > 8) return res.status(400).json({ error: "That doesn't look like a UK registration." });

    const v = await lookupReg(reg);
    if (!v) return res.status(404).json({ error: `No vehicle found for ${reg} — check the reg, or type the details in.` });
    return res.status(200).json(v);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
