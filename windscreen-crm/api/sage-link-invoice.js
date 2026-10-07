// Links an app invoice to an invoice that ALREADY exists in Sage (made by hand).
// Saves Sage's invoice ID, and replaces the typed-in number with Sage's exact number.
// Nothing is created or changed in Sage.
//
// Body: { invoiceId, sageInvoiceId }

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const { invoiceId, sageInvoiceId } = req.body || {};
    if (!invoiceId || !sageInvoiceId) return res.status(400).json({ error: "Missing invoice details." });
    const iid = encodeURIComponent(invoiceId);

    const inv = (await supabaseRest(`invoices?id=eq.${iid}&select=id,sage_invoice_id`))?.[0];
    if (!inv) return res.status(404).json({ error: "This invoice hasn't synced to the cloud yet." });
    if (inv.sage_invoice_id) return res.status(409).json({ error: "This invoice is already linked to Sage." });

    // Confirms the Sage invoice exists (throws a readable error if not)
    const s = await sageFetch(`/sales_invoices/${encodeURIComponent(sageInvoiceId)}`);

    const others = await supabaseRest(`invoices?sage_invoice_id=eq.${encodeURIComponent(sageInvoiceId)}&select=id`);
    if (others?.length) return res.status(409).json({ error: "That Sage invoice is already linked to another invoice in the app." });

    const sageNo = s?.invoice_number || s?.displayed_as || "";
    await supabaseRest(`invoices?id=eq.${iid}`, {
      method: "PATCH",
      body: JSON.stringify({ sage_invoice_id: sageInvoiceId, sage_invoice_no: sageNo, updated_at: Date.now() }),
    });
    return res.status(200).json({ sageInvoiceId, sageInvoiceNo: sageNo });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
