// Links app invoice(s) to an invoice that ALREADY exists in Sage (made by hand), or unlinks one.
// Nothing is ever created or changed in Sage — this only saves the link in the app.
//
// Body: { invoiceIds: [..], sageInvoiceId }  → link one or more app invoices to one Sage invoice
//       { invoiceId, sageInvoiceId }         → same, single invoice (older form)
//       { invoiceId, unlink: true }          → remove the link (keeps the typed Sage number)
//
// Several app invoices may share ONE Sage invoice (e.g. one invoice per job in the app, but
// one combined invoice in Sage). That's only allowed while their amounts together don't go
// over the Sage invoice's total, so a Sage invoice can't be over-claimed.

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const inList = ids => `(${ids.map(id => `"${String(id).replace(/"/g, "")}"`).join(",")})`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const body = req.body || {};

    // ── Unlink ──
    if (body.unlink) {
      if (!body.invoiceId) return res.status(400).json({ error: "No invoice given." });
      await supabaseRest(`invoices?id=eq.${encodeURIComponent(body.invoiceId)}`, {
        method: "PATCH",
        body: JSON.stringify({ sage_invoice_id: null, updated_at: Date.now() }),
      });
      return res.status(200).json({ sageInvoiceId: null });
    }

    // ── Link ──
    const ids = Array.isArray(body.invoiceIds) ? body.invoiceIds : (body.invoiceId ? [body.invoiceId] : []);
    const { sageInvoiceId } = body;
    if (!ids.length || !sageInvoiceId) return res.status(400).json({ error: "Missing invoice details." });

    const rows = await supabaseRest(`invoices?id=in.${encodeURIComponent(inList(ids))}&select=id,total,sage_invoice_id`);
    if ((rows || []).length !== ids.length) return res.status(404).json({ error: "One or more of these invoices hasn't synced to the cloud yet." });
    const already = rows.filter(r => r.sage_invoice_id);
    if (already.length) return res.status(409).json({ error: "One or more of these invoices is already linked to Sage." });

    // Confirms the Sage invoice exists (throws a readable error if not)
    const s = await sageFetch(`/sales_invoices/${encodeURIComponent(sageInvoiceId)}`);
    const sageTotal = money(s?.total_amount);

    // Don't let app invoices claim more than the Sage invoice is worth
    const existing = await supabaseRest(`invoices?sage_invoice_id=eq.${encodeURIComponent(sageInvoiceId)}&select=total`);
    const existingSum = money((existing || []).reduce((t, r) => t + money(r.total), 0));
    const newSum = money(rows.reduce((t, r) => t + money(r.total), 0));
    if (s?.total_amount != null && existingSum + newSum > sageTotal + 0.01) {
      return res.status(409).json({
        error: `These come to £${(existingSum + newSum).toFixed(2)}${existingSum ? ` (including £${existingSum.toFixed(2)} already linked)` : ""}, but the Sage invoice is only £${sageTotal.toFixed(2)}. Check the amounts before linking.`,
      });
    }

    const sageNo = s?.invoice_number || s?.displayed_as || "";
    await supabaseRest(`invoices?id=in.${encodeURIComponent(inList(ids))}`, {
      method: "PATCH",
      body: JSON.stringify({ sage_invoice_id: sageInvoiceId, sage_invoice_no: sageNo, updated_at: Date.now() }),
    });
    return res.status(200).json({ sageInvoiceId, sageInvoiceNo: sageNo, linkedTotal: money(existingSum + newSum), sageTotal });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
