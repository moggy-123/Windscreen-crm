// Brings Sage up to date with ONE app invoice, automatically, after it's saved in the app.
// Called via /api/sage?action=sync-invoice   Body: { invoiceId, update, confirmCustomer, confirmInvoice }
//
// In order:
//   1. Not in Sage yet → adds the customer to Sage if they aren't there (same duplicate
//      check as the "Push to Sage" button), then creates the invoice in Sage.
//   2. Already in Sage and `update` is set (the invoice was edited in the app) → rewrites
//      the Sage invoice's lines to match the app. Refused if Sage already has any payment
//      against it. If several app invoices share one Sage invoice, all of them are used.
//   3. Marked Paid in the app and no payment in Sage yet → records the payment in Sage.
//
// If something needs a yes/no first (possible duplicate customer or invoice) it stops and
// returns { needs: "customer" | "invoice", message } — the app asks, then calls again with
// confirmCustomer / confirmInvoice set.

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";
import pushCustomer from "./_push-customer.js";
import pushInvoice, { findSalesLedgerId, buildLines } from "./_push-invoice.js";
import pushPayment from "./_push-payment.js";

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const q = encodeURIComponent;

// Runs one of the existing Sage handlers and captures its reply
async function run(handler, req, body) {
  let status = 200, json = null;
  const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
  await handler({ ...req, method: "POST", body }, res);
  return { status, json: json || {} };
}

async function updateSageInvoice(inv) {
  const sid = inv.sage_invoice_id;
  const sageInv = await sageFetch(`/sales_invoices/${q(sid)}`);
  const no = sageInv?.invoice_number || inv.sage_invoice_no || "the Sage invoice";
  const status = String(sageInv?.status?.id || sageInv?.status?.displayed_as || "").toUpperCase();
  if (status.includes("VOID")) return { warning: `${no} is void in Sage, so it wasn't changed.` };
  const paidSoFar = money(money(sageInv?.total_amount) - money(sageInv?.outstanding_amount));
  if (paidSoFar > 0.01) return { warning: `${no} already has £${paidSoFar.toFixed(2)} paid against it in Sage, so it can't be changed from the app — change it in Sage instead.` };

  // Every app invoice linked to this Sage invoice (usually just this one)
  const group = (await supabaseRest(`invoices?sage_invoice_id=eq.${q(sid)}&select=*`)) || [inv];
  if (group.some(g => g.vat)) return { warning: "VAT is ticked on this invoice, but you're not VAT registered — untick it, save, and it will update Sage." };
  const ledgerId = await findSalesLedgerId();
  const newLines = group.flatMap(g => buildLines(g, ledgerId));
  if (!newLines.length) return { warning: `The invoice now comes to £0 — ${no} wasn't changed. Void it in Sage if it's no longer needed.` };
  const target = money(newLines.reduce((t, l) => t + l.unit_price, 0));

  // Reuse the existing Sage lines (in order), remove any left over, add any extra
  const oldLines = Array.isArray(sageInv?.invoice_lines) ? sageInv.invoice_lines : [];
  const lines = newLines.map((l, i) => (oldLines[i]?.id ? { id: oldLines[i].id, ...l } : l));
  oldLines.slice(newLines.length).forEach(l => l?.id && lines.push({ id: l.id, _destroy: true }));

  const put = (withTax) => sageFetch(`/sales_invoices/${q(sid)}`, {
    method: "PUT",
    body: JSON.stringify({ sales_invoice: { invoice_lines: withTax ? lines.map(l => (l._destroy ? l : { ...l, tax_rate_id: "GB_NO_TAX" })) : lines } }),
  });
  let updated;
  try { updated = await put(false); }
  catch (e) { if (/tax/i.test(e?.message || "")) updated = await put(true); else throw e; }

  const sageTotal = money(updated?.total_amount);
  const warning = updated?.total_amount != null && Math.abs(sageTotal - target) > 0.01
    ? `Sage now shows £${sageTotal.toFixed(2)} for ${no} but the app says £${target.toFixed(2)} — please check it in Sage.` : "";
  return { updated: true, sageInvoiceNo: no, total: target, warning };
}

export default async function syncInvoice(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const { invoiceId, update, confirmCustomer, confirmInvoice } = req.body || {};
    if (!invoiceId) return res.status(400).json({ error: "No invoice given." });
    const load = async () => (await supabaseRest(`invoices?id=eq.${q(invoiceId)}&select=*`))?.[0];

    let inv = await load();
    if (!inv) return res.status(404).json({ error: "This invoice hasn't reached the cloud yet — check you're online, then tap Retry." });

    const out = { steps: [], warnings: [] };

    // 1. Create in Sage (customer first if needed)
    if (!inv.sage_invoice_id) {
      const job = (await supabaseRest(`jobs?id=eq.${q(inv.job_id)}&select=customer_id`))?.[0];
      const cust = job && (await supabaseRest(`customers?id=eq.${q(job.customer_id)}&select=id,company,company_contact,sage_id`))?.[0];
      if (!cust) return res.status(404).json({ error: "Couldn't find the customer for this invoice." });
      const custName = cust.company || cust.company_contact || "this customer";

      if (!cust.sage_id) {
        const r = await run(pushCustomer, req, { customerId: cust.id, force: !!confirmCustomer });
        if (r.status === 409 && r.json.possibleDuplicates) {
          return res.status(200).json({ ...out, needs: "customer",
            message: `Sage already has a customer that looks like ${custName}: ${r.json.possibleDuplicates.join(", ")}.\n\nIf it's the same customer, choose "Not now" and link them in Settings → Link Customers to Sage. Otherwise choose "Create new" to add ${custName} to Sage as a new customer.` });
        }
        if (r.status >= 400) return res.status(200).json({ ...out, error: `Couldn't add ${custName} to Sage: ${r.json.error || r.status}` });
        out.sageCustomerId = r.json.sageId;
        out.customerId = cust.id;
        out.steps.push(`Added ${custName} to Sage as a customer`);
      }

      const r = await run(pushInvoice, req, { invoiceId, force: !!confirmInvoice });
      if (r.status === 409 && r.json.needsConfirm) return res.status(200).json({ ...out, needs: "invoice", message: r.json.error });
      if (r.status >= 400) return res.status(200).json({ ...out, error: `Couldn't create the invoice in Sage: ${r.json.error || r.status}` });
      out.sageInvoiceId = r.json.sageInvoiceId;
      out.sageInvoiceNo = r.json.sageInvoiceNo;
      out.steps.push(`Created invoice ${r.json.sageInvoiceNo} in Sage`);
      if (r.json.warning) out.warnings.push(r.json.warning);
    } else if (update) {
      // 2. Edited in the app → update the Sage invoice
      const u = await updateSageInvoice(inv);
      if (u.updated) out.steps.push(`Updated ${u.sageInvoiceNo} in Sage (now £${u.total.toFixed(2)})`);
      if (u.warning) out.warnings.push(u.warning);
    }

    // 3. Paid in the app → record the payment in Sage
    inv = await load();
    if (inv?.paid && inv.sage_invoice_id && !inv.sage_payment_id) {
      const r = await run(pushPayment, req, { invoiceId });
      if (r.status >= 400) {
        out.warnings.push(`Payment not recorded in Sage: ${r.json.error || r.status}`);
      } else {
        out.sagePaymentId = r.json.alreadyPaid ? "PAID_IN_SAGE" : r.json.sagePaymentId;
        out.steps.push(r.json.alreadyPaid ? `${r.json.sageInvoiceNo} was already paid in Sage` : `Recorded £${money(r.json.amount).toFixed(2)} payment in Sage against ${r.json.sageInvoiceNo}`);
      }
    }

    out.ok = true;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ error: e?.message || "Unknown error" });
  }
}
