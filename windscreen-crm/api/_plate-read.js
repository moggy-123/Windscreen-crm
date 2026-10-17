// Reads a vehicle photo: number plate, make, model and colour. Read-only — nothing is
// saved here; the app fills in the form and you check it before saving.
// Called via /api/sage?action=plate-read   Body: { image: <base64 JPEG>, mediaType }
// (lives in the Sage router only so it doesn't count as another Vercel function)
//
// Needs in Vercel → Settings → Environment Variables:
//   ANTHROPIC_API_KEY  — from console.anthropic.com
//   ANTHROPIC_MODEL    — optional, defaults to claude-sonnet-5-5 (better at telling
//                        similar-looking models apart; set claude-haiku-4-5-20251001 for cheapest)
// If the DVSA MOT keys are also set, the make/model are double-checked against the reg.

import { verifyAppUser } from "./_sage.js";
import { motConfigured, lookupReg } from "./_vehicle-lookup.js";

const PROMPT = `This is a photo of a vehicle taken by a windscreen repair technician in the UK.
Read the UK number plate and identify the vehicle. Reply with ONLY a JSON object, no other text:
{"reg": "AB12CDE", "make": "Ford", "model": "Transit Custom", "colour": "White", "plateClear": true}
Rules:
- "reg": the plate exactly as shown, capitals, no spaces. If no plate is readable use "".
- "plateClear": false if any character of the plate is uncertain.
- "make" / "model": your best identification from the vehicle's appearance, or "" if unsure.
  Use the name the vehicle is sold under in the UK (e.g. "BYD Atto 3", never the Chinese-market
  name "Yuan Plus"). Look closely at badges, model lettering on the tailgate, light shapes and
  grille before deciding — many models from the same maker look alike (e.g. BYD Dolphin vs Atto 3,
  Ford Transit vs Transit Custom). If you can't tell between two, give the make only.
- "colour": the main body colour in one or two plain words.`;

export default async function plateRead(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(400).json({ error: "Photo reading isn't set up yet — add ANTHROPIC_API_KEY in Vercel, then redeploy." });

    const { image, mediaType } = req.body || {};
    if (!image || image.length < 1000) return res.status(400).json({ error: "No photo received — please try again." });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 300,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
          { type: "text", text: PROMPT },
        ] }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `Photo reader error (${r.status}): ${j?.error?.message || "try again"}` });

    const text = (j.content || []).map(c => c.text || "").join("");
    let v;
    try { v = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || ""); }
    catch { return res.status(502).json({ error: "Couldn't make sense of the photo — try again with the plate clearer in the picture." }); }

    const reg = String(v.reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const out = { reg, make: String(v.make || ""), model: String(v.model || ""), colour: String(v.colour || ""), plateClear: v.plateClear !== false && !!reg, source: "photo" };

    // Double-check against the official record when DVSA keys are set up
    if (reg && motConfigured()) {
      try {
        const d = await lookupReg(reg);
        if (d) Object.assign(out, { make: d.make || out.make, model: d.model || out.model, colour: d.colour || out.colour, year: d.year, fuel: d.fuel, source: "dvsa" });
        else out.dvsaNotFound = true;
      } catch { /* keep the photo's answer */ }
    }

    if (!reg && !out.make) return res.status(422).json({ error: "Couldn't see a number plate or vehicle in that photo — try again closer to the plate." });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
