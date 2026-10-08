// Links (or unlinks) a CRM customer to a customer that ALREADY exists in Sage.
// Nothing is created or changed in Sage — it only saves the Sage contact ID onto the
// CRM customer (customers.sage_id).
//
// Body: { customerId, sageId }   → link
//       { customerId, sageId: null } → unlink

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const { customerId, sageId } = req.body || {};
    if (!customerId) return res.status(400).json({ error: "No customer given." });
    const cid = encodeURIComponent(customerId);

    const rows = await supabaseRest(`customers?id=eq.${cid}&select=id`);
    if (!rows?.[0]) return res.status(404).json({ error: "This customer hasn't synced to the cloud yet — check you're online, wait a moment and try again." });

    // Unlink
    if (!sageId) {
      await supabaseRest(`customers?id=eq.${cid}`, { method: "PATCH", body: JSON.stringify({ sage_id: null, updated_at: Date.now() }) });
      return res.status(200).json({ sageId: null });
    }

    // Make sure the Sage contact really exists (throws a readable error if not)
    const contact = await sageFetch(`/contacts/${encodeURIComponent(sageId)}`);

    // Make sure no other CRM customer is already linked to it
    const sid = encodeURIComponent(sageId);
    const others = await supabaseRest(`customers?sage_id=eq.${sid}&id=neq.${cid}&select=company,company_contact`);
    if (others?.length) {
      return res.status(409).json({ error: `That Sage customer is already linked to "${others[0].company || others[0].company_contact}" in the app.` });
    }

    await supabaseRest(`customers?id=eq.${cid}`, { method: "PATCH", body: JSON.stringify({ sage_id: sageId, updated_at: Date.now() }) });
    return res.status(200).json({ sageId, sageName: contact?.displayed_as || contact?.name || "" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
