// Read-only: returns the real invoice date and payment date from Sage for every Sage
// invoice, so the app can compare them with its own dates. Changes nothing anywhere.
// Called via /api/sage?action=check-dates
//
// Response: { invoices: { [sageInvoiceId]: { number, date, total, outstanding, paidDate } } }
//   date      — the invoice date in Sage
//   paidDate  — the date of the latest customer receipt allocated to it (null if none)

import { verifyAppUser, sageFetch } from "./_sage.js";

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;

export default async function checkDates(req, res) {
  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    // 1. Every sales invoice: number, date, total, how much is still owed
    const invoices = {};
    for (let page = 1; page <= 50; page++) {
      const r = await sageFetch(`/sales_invoices?items_per_page=200&page=${page}&attributes=invoice_number,date,total_amount,outstanding_amount,status`);
      const items = r?.$items || [];
      items.forEach(x => {
        invoices[x.id] = {
          number: x.invoice_number || x.displayed_as || "",
          date: String(x.date || "").slice(0, 10),
          total: money(x.total_amount),
          outstanding: money(x.outstanding_amount),
          paidDate: null,
        };
      });
      if (!r?.$next || items.length === 0) break;
    }

    // 2. Every customer receipt, and which invoice(s) it was put against → latest payment date
    const apply = (p) => {
      const d = String(p.date || "").slice(0, 10);
      (p.allocated_artefacts || []).forEach(a => {
        const id = a?.artefact?.id || a?.artefact_id;
        const inv = id && invoices[id];
        if (inv && d && (!inv.paidDate || d > inv.paidDate)) inv.paidDate = d;
      });
    };
    const receipts = [];
    for (let page = 1; page <= 50; page++) {
      const r = await sageFetch(`/contact_payments?transaction_type_id=CUSTOMER_RECEIPT&items_per_page=200&page=${page}&attributes=date,allocated_artefacts`);
      const items = r?.$items || [];
      receipts.push(...items);
      if (!r?.$next || items.length === 0) break;
    }
    if (receipts.some(p => Array.isArray(p.allocated_artefacts))) {
      receipts.forEach(apply);
    } else {
      // Some Sage plans don't include the allocations in the list — look each receipt up,
      // 10 at a time so it stays quick.
      for (let i = 0; i < receipts.length; i += 10) {
        const batch = await Promise.all(receipts.slice(i, i + 10).map(p =>
          sageFetch(`/contact_payments/${encodeURIComponent(p.id)}`).catch(() => null)));
        batch.filter(Boolean).forEach(apply);
      }
    }

    return res.status(200).json({ invoices });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
