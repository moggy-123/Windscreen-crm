// Read-only scan: compares every app invoice that isn't linked to Sage yet against the
// invoices that already exist in Sage, and suggests matches. Changes nothing anywhere.
//
// Several app invoices can belong to ONE Sage invoice (e.g. one invoice per job in the
// app, one combined invoice in Sage, all with the same Sage number typed in). Those are
// grouped together and checked against what's still unclaimed on the Sage invoice.
//
// Each result row has `members` (the app invoices in it) and a status:
//   matched          — Sage number found, and the amount(s) add up to the Sage invoice
//   group            — as matched, but several app invoices together make up the Sage invoice
//   check            — number found, but the amount or customer differs (needs a look)
//   full             — number found, but that Sage invoice is already fully linked
//   numberNotFound   — a Sage number is typed in the app, but Sage has no such invoice
//   suggested        — no number in the app; Sage has one for the same customer + amount
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

    // How much of each Sage invoice is already claimed by linked app invoices
    const linkedSum = new Map();
    (invoices || []).filter(i => i.sage_invoice_id).forEach(i => {
      linkedSum.set(i.sage_invoice_id, money((linkedSum.get(i.sage_invoice_id) || 0) + money(i.total)));
    });

    // Every (non-void) sales invoice in Sage
    const sage = [];
    for (let page = 1; page <= 50; page++) {
      const r = await sageFetch(`/sales_invoices?items_per_page=200&page=${page}&attributes=invoice_number,date,total_amount,contact,status`);
      const items = r?.$items || [];
      items.forEach(x => {
        const status = String(x.status?.id || x.status?.displayed_as || "").toUpperCase();
        if (status.includes("VOID")) return;
        const total = money(x.total_amount);
        const already = linkedSum.get(x.id) || 0;
        sage.push({
          id: x.id,
          number: x.invoice_number || x.displayed_as || "",
          date: String(x.date || "").slice(0, 10),
          total,
          alreadyLinked: already,
          remaining: money(total - already),
          contactId: x.contact?.id || "",
          contactName: x.contact?.displayed_as || "",
        });
      });
      if (!r?.$next || items.length === 0) break;
    }
    const byNumber = new Map(sage.map(s => [normNo(s.number), s]));
    const findByNumber = no => {
      let s = byNumber.get(normNo(no));
      if (!s) {
        // Allow "123" typed in the app to match "SI-123" in Sage — only if unambiguous
        const d = digits(no);
        const cands = d ? sage.filter(x => digits(x.number) === d) : [];
        if (cands.length === 1) s = cands[0];
      }
      return s || null;
    };

    // One "member" per unlinked app invoice
    const members = (invoices || []).filter(i => !i.sage_invoice_id).map(inv => {
      const job = jobById.get(inv.job_id);
      const cust = job ? custById.get(job.customer_id) : null;
      return {
        invoiceId: inv.id,
        jobId: inv.job_id,
        customerName: cust ? (cust.company || cust.company_contact || "Unnamed") : "Unknown",
        custSageId: cust?.sage_id || "",
        appNo: inv.sage_invoice_no || "",
        appTotal: money(inv.total),
        date: String(job?.date || inv.created_at || "").slice(0, 10),
      };
    });

    const results = [];
    const claimed = new Set();
    const strip = m => { const { custSageId, ...rest } = m; return rest; };
    const row = (status, list, extra = {}) => ({
      status,
      members: list.map(strip),
      customerName: list[0].customerName,
      date: list.map(m => m.date).sort().reverse()[0] || "",
      appTotal: money(list.reduce((t, m) => t + m.appTotal, 0)),
      ...extra,
    });

    // 1) Invoices with a Sage number typed in — grouped by the Sage invoice they point to
    const groups = new Map();
    for (const m of members.filter(m => m.appNo)) {
      const s = findByNumber(m.appNo);
      if (!s) { results.push(row("numberNotFound", [m])); continue; }
      if (!groups.has(s.id)) groups.set(s.id, { s, list: [] });
      groups.get(s.id).list.push(m);
    }
    for (const { s, list } of groups.values()) {
      claimed.add(s.id);
      const sum = money(list.reduce((t, m) => t + m.appTotal, 0));
      const custIds = [...new Set(list.map(m => m.custSageId).filter(Boolean))];
      const sameCustomer = custIds.length === 0 ? null : (custIds.length === 1 && custIds[0] === s.contactId);
      const sameTotal = Math.abs(sum - s.remaining) <= 0.01;
      let status;
      if (s.remaining <= 0.01) status = "full";
      else if (sameTotal && sameCustomer !== false) status = list.length > 1 ? "group" : "matched";
      else status = "check";
      results.push(row(status, list, { sage: s, sameTotal, sameCustomer }));
    }

    // 2) Invoices with no number — suggest a Sage invoice for the same customer + amount
    for (const m of members.filter(m => !m.appNo)) {
      if (!m.custSageId) { results.push(row("customerNotLinked", [m])); continue; }
      const cands = sage
        .filter(s => !claimed.has(s.id) && s.alreadyLinked === 0 && s.contactId === m.custSageId && Math.abs(s.total - m.appTotal) <= 0.01)
        .sort((a, b) => daysApart(a.date, m.date) - daysApart(b.date, m.date));
      if (cands.length) {
        claimed.add(cands[0].id);
        results.push(row("suggested", [m], { sage: cands[0], otherCandidates: cands.length - 1 }));
      } else {
        results.push(row("notInSage", [m]));
      }
    }

    results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return res.status(200).json({ results, sageCount: sage.length });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
