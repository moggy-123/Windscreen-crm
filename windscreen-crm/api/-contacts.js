// Returns every Customer contact in Sage (id, name, reference) so the app can match
// them up with CRM customers. Read-only — never changes anything in Sage.

import { verifyAppUser, sageFetch } from "./_sage.js";

export default async function handler(req, res) {
  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const contacts = [];
    for (let page = 1; page <= 50; page++) {
      const r = await sageFetch(`/contacts?contact_type_id=CUSTOMER&items_per_page=200&page=${page}&attributes=name,reference`);
      const items = r?.$items || [];
      items.forEach(x => contacts.push({
        id: x.id,
        name: x.name || x.displayed_as || "",
        reference: x.reference || "",
      }));
      if (!r?.$next || items.length === 0) break;
    }

    return res.status(200).json({ contacts });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
