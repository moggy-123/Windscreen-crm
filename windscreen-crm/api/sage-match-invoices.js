// Read-only scan: compares every app invoice that isn't linked to Sage yet against the
// invoices that already exist in Sage, and suggests matches. Changes nothing anywhere.
//
// Results per app invoice:
//   matched          — Sage number typed in the app was found in Sage, and the amount agrees
//   check            — number found, but the amount or customer differs (needs a look)
//   numberNotFound   — a Sage number is typed in the app, but Sage has no such invoice
//   suggested        — no number in the app, but Sage has an invoice for the same customer
//                      and the same amount (closest date picked)
//   notInSage        — no number, no likely match → push it from the job page
//   customerNotLinked— no number and the customer isn't linked to Sage yet

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const normNo = s => String(s || "").toUpperCase().replace(/\s+/g, "");
const digits = s => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
const daysApart = (a, b) => (a && b) ? Math.abs((new Date(a) - new Date(b)) / 86400000) : 9999;

export default async function handler(req, res) {
  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const [invoices, jobs, customers] = await Promise.all([
      supabaseRest("invoices?select=id,job_id,total,sage_invoice_no,sage_invoice_id,created_at"),
      supabaseRest("jobs?select=id,customer_id,date"),
      supabaseRest("customers?select=id,company,company_contact,sage_id"),
    ]);
    const jobById = new Map((jobs || []).map(j => [j.id, j]));
    const custById = new Map((customers || []).map(c => [c.id, c]));
    const alreadyLinked = new Set((invoices || []).filter(i => i.sage_invoice_id).map(i => i.sage_invoice_id));

    // Every (non-void) sales invoice in Sage
    const sage = [];
    for (let page = 1; page <= 50; page++) {
      const r = await sageFetch(`/sales_invoices?items_per_page=200&page=${page}&attributes=invoice_number,date,total_amount,contact,status`);
      const items = r?.$items || [];
      items.forEach(x => {
        const status = String(x.status?.id || x.status?.displayed_as || "").toUpperCase();
        if (status.includes("VOID")) return;
        sage.push({
          id: x.id,
          number: x.invoice_number || x.displayed_as || "",
          date: String(x.date || "").slice(0, 10),
          total: money(x.total_amount),
          contactId: x.contact?.id || "",
          contactName: x.contact?.displayed_as || "",
        });
      });
      if (!r?.$next || items.length === 0) break;
    }
    const available = sage.filter(s => !alreadyLinked.has(s.id));
    const byNumber = new Map(available.map(s => [normNo(s.number), s]));
    const claimed = new Set();

    const results = [];
    for (const inv of (invoices || []).filter(i => !i.sage_invoice_id)) {
      const job = jobById.get(inv.job_id);
      const cust = job ? custById.get(job.customer_id) : null;
      const base = {
        invoiceId: inv.id,
        jobId: inv.job_id,
        customerName: cust ? (cust.company || cust.company_contact || "Unnamed") : "Unknown",
        appNo: inv.sage_invoice_no || "",
        appTotal: money(inv.total),
        date: String(job?.date || inv.created_at || "").slice(0, 10),
        _custSageId: cust?.sage_id || "",
      };

      if (inv.sage_invoice_no) {
        let s = byNumber.get(normNo(inv.sage_invoice_no));
        if (!s) {
          // Allow "123" typed in the app to match "SI-123" in Sage — only if it's unambiguous
          const d = digits(inv.sage_invoice_no);
          const cands = d ? available.filter(x => digits(x.number) === d) : [];
          if (cands.length === 1) s = cands[0];
        }
        if (s && !claimed.has(s.id)) {
          claimed.add(s.id);
          const sameTotal = Math.abs(s.total - base.appTotal) <= 0.01;
          const sameCustomer = base._custSageId ? base._custSageId === s.contactId : null;
          results.push({ ...base, status: sameTotal && sameCustomer !== false ? "matched" : "check", sage: s, sameTotal, sameCustomer });
        } else {
          results.push({ ...base, status: "numberNotFound" });
        }
      } else {
        results.push({ ...base, status: "pending" });
      }
    }

    // Invoices with no number: suggest a Sage invoice for the same customer + same amount
    for (const r of results) {
      if (r.status !== "pending") continue;
      if (!r._custSageId) { r.status = "customerNotLinked"; continue; }
      const cands = available
        .filter(s => !claimed.has(s.id) && s.contactId === r._custSageId && Math.abs(s.total - r.appTotal) <= 0.01)
        .sort((a, b) => daysApart(a.date, r.date) - daysApart(b.date, r.date));
      if (cands.length) {
        claimed.add(cands[0].id);
        r.status = "suggested";
        r.sage = cands[0];
        r.otherCandidates = cands.length - 1;
      } else {
        r.status = "notInSage";
      }
    }

    results.forEach(r => { delete r._custSageId; });
    results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return res.status(200).json({ results, sageCount: sage.length });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
