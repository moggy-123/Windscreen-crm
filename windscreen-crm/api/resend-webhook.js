// Serverless function — receives delivery events from Resend (bounced, complained,
// delayed) and records them so the app can show "this email didn't actually arrive"
// rather than Dave just hoping it did. Verifies the request genuinely came from Resend
// before trusting anything in it (Svix-style HMAC signature, same scheme GitHub/Stripe
// use) — this is a publicly reachable URL, so anyone could otherwise post fake events.

import crypto from "crypto";

const SUPABASE_URL = "https://ubnwpghiozmydkczklek.supabase.co";

// Only these event types get recorded — the ones that mean "something went wrong",
// not routine sent/delivered/opened/clicked noise.
const TRACKED_EVENTS = new Set(["email.bounced", "email.complained", "email.delivery_delayed"]);

function verifySvixSignature(secret, msgId, timestamp, rawBody, signatureHeader) {
  if (!secret || !msgId || !timestamp || !signatureHeader) return false;
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const secretBytes = Buffer.from(secret.split("_")[1], "base64");
  const expectedSignature = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  const signatures = signatureHeader.split(" ").map(s => s.split(",")[1]).filter(Boolean);
  return signatures.some(sig => {
    if (sig.length !== expectedSignature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature));
  });
}

// Resend's send API takes tags as [{name, value}]; the webhook may echo them back either
// the same way or as a flat object — handle both rather than assume.
function readTag(tags, name) {
  if (!tags) return "";
  if (Array.isArray(tags)) {
    const found = tags.find(t => t.name === name);
    return found ? found.value : "";
  }
  return tags[name] || "";
}

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const svixId = req.headers["svix-id"];
  const svixTimestamp = req.headers["svix-timestamp"];
  const svixSignature = req.headers["svix-signature"];

  if (!secret) {
    // Fail loudly in logs, but still return 200 so Resend doesn't retry forever —
    // there's nothing a retry would fix here, the env var just needs setting.
    console.error("RESEND_WEBHOOK_SECRET is not set — cannot verify webhook, ignoring.");
    return res.status(200).json({ skipped: true });
  }

  if (!verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (!TRACKED_EVENTS.has(event.type)) {
    return res.status(200).json({ ignored: event.type });
  }

  const data = event.data || {};
  const customerId = readTag(data.tags, "customer_id");
  const docType = readTag(data.tags, "doc_type");

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is not set — cannot record email event.");
    return res.status(200).json({ skipped: true });
  }

  // Upsert (not plain insert) so a Resend retry of the same delivery doesn't fail on
  // a duplicate id — it just harmlessly overwrites the same row with the same data.
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/email_events?on_conflict=id`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      id: `${data.email_id || "unknown"}-${event.type}`,
      resend_email_id: data.email_id || "",
      event_type: event.type,
      recipient: Array.isArray(data.to) ? data.to[0] : (data.to || ""),
      doc_type: docType,
      customer_id: customerId,
      subject: data.subject || "",
      bounce_message: data.bounce?.message || data.delay?.message || "",
      created_at: new Date().toISOString(),
    }),
  });

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    console.error("Failed to record email event:", errText);
    // Still return 200 — Resend will retry on non-2xx, and a DB hiccup on our side
    // isn't something a retry of the SAME webhook delivery would necessarily fix.
  }

  return res.status(200).json({ recorded: true });
}

