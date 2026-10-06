// Creates one CRM customer as a Customer contact in Sage, then saves the Sage contact ID
// back onto the customer (customers.sage_id). Called by the "Push to Sage" button.
//
// Safety checks, in order:
//   1. Caller must be logged into the CRM.
//   2. Customer must already be saved to the cloud (the server reads it from the database).
//   3. Customer must not already have a sage_id (stops double-pushing).
//   4. Sage is searched for a contact with the same name first. If one exists, nothing is
//      created and the app asks you to confirm — so a customer already in Sage doesn't get
//      duplicated. (Properly linking existing customers is a later stage.)

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const { customerId, force } = req.body || {};
    if (!customerId) return res.status(400).json({ error: "No customer given." });

    const rows = await supabaseRest(`customers?id=eq.${encodeURIComponent(customerId)}&select=*`);
    const c = rows?.[0];
    if (!c) return res.status(404).json({ error: "This customer hasn't synced to the cloud yet — check you're online, wait a moment and try again." });
    if (c.sage_id) return res.status(409).json({ error: "This customer is already linked to Sage." });

    const name = (c.company || c.company_contact || "").trim();
    if (!name) return res.status(400).json({ error: "Customer has no name." });

    // Duplicate check — look for an existing Sage customer with the same name
    if (!force) {
      const found = await sageFetch(`/contacts?contact_type_id=CUSTOMER&search=${encodeURIComponent(name)}&attributes=name,reference&items_per_page=20`);
      const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const matches = (found?.$items || []).filter(x => {
        const n = norm(x.name || x.displayed_as);
        return n && (n === norm(name) || n.includes(norm(name)) || norm(name).includes(n));
      });
      if (matches.length > 0) {
        return res.status(409).json({
          error: "Possible duplicate in Sage",
          possibleDuplicates: matches.map(m => m.displayed_as || m.name),
        });
      }
    }

    // Main contact person — the one marked ★ Main, else the customer's own phone/email
    const contacts = Array.isArray(c.contacts) ? c.contacts : [];
    const main = contacts.find(x => x.main) || contacts[0] || {};
    const person = {
      name: main.name || c.company_contact || name,
      telephone: main.phone || c.phone || undefined,
      email: main.email || c.email || undefined,
    };

    const hasAddress = c.address1 || c.address2 || c.town || c.county || c.postcode;
    const contact = {
      name,
      contact_type_ids: ["CUSTOMER"],
      notes: c.cust_type === "Private" ? "Private customer — added from CRM" : "Added from CRM",
      main_contact_person: person,
      ...(hasAddress ? {
        main_address: {
          address_line_1: c.address1 || "",
          address_line_2: c.address2 || "",
          city: c.town || "",
          region: c.county || "",
          postal_code: c.postcode || "",
          country_id: "GB",
        },
      } : {}),
    };

    const created = await sageFetch("/contacts", { method: "POST", body: JSON.stringify({ contact }) });
    if (!created?.id) throw new Error("Sage didn't return a contact ID.");

    // Save the link straight away on the server, so it's never lost even if the phone drops signal
    await supabaseRest(`customers?id=eq.${encodeURIComponent(customerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ sage_id: created.id, updated_at: Date.now() }),
    });

    return res.status(200).json({ sageId: created.id, sageName: created.displayed_as || created.name || name });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
