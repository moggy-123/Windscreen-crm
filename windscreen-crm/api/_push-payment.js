// Records a payment in Sage for one app invoice that's marked Paid, and allocates it to
// that invoice's linked Sage invoice. Called via /api/sage?action=push-payment.
//
// Body: { invoiceId }                → push the payment
//       { invoiceId, clear: true }   → forget the Sage payment link (used by "Unmark Paid")
//
// Rules:
//   • The app invoice must be marked Paid and linked to a Sage invoice.
//   • Money always goes into Sage bank account 1200.
//   • Before creating anything, Sage is checked: if the Sage invoice is ALREADY paid there
//     (e.g. you recorded it by hand), nothing is created — the app just notes it as done.
//   • A payment is never pushed twice (sage_payment_id is saved on the app invoice).
//   • The payment is allocated to that specific Sage invoice only — never "on account" —
//     so it can't land on any other invoice (e.g. R&J accounts-work invoices).

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

const BANK_NOMINAL_CODE = "1200";
const ALREADY_PAID = "PAID_IN_SAGE";

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;

// App payment method → Sage payment method id
const METHOD = { "Bank Transfer": "BANK_TRANSFER", "Card": "CREDIT_DEBIT", "Cash": "CASH", "Cheque": "CHEQUE" };

async function findBankAccountId() {
  const r = await sageFetch(`/bank_accounts?items_per_page=200&attributes=nominal_code,ledger_account`);
  const items = r?.$items || [];
  for (const b of items) {
    const code = b.nominal_code || b.ledger_account?.nominal_code;
    if (String(code) === BANK_NOMINAL_CODE) return b.id;
  }
  // Some Sage setups don't return the code on the list — look each one up
  for (const b of items) {
    if (!b.ledger_account?.id) continue;
    const la = await sageFetch(`/ledger_accounts/${encodeURIComponent(b.ledger_account.id)}?attributes=nominal_code`);
    if (String(la?.nominal_code) === BANK_NOMINAL_CODE) return b.id;
  }
  throw new Error(`Couldn't find bank account ${BANK_NOMINAL_CODE} in Sage. Bank accounts found: ${items.map(b => b.displayed_as).join(", ") || "none"}.`);
}

export default async function pushPayment(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const { invoiceId, clear } = req.body || {};
    if (!invoiceId) return res.status(400).json({ error: "No invoice given." });
    const iid = encodeURIComponent(invoiceId);

    if (clear) {
      await supabaseRest(`invoices?id=eq.${iid}`, { method: "PATCH", body: JSON.stringify({ sage_payment_id: null, updated_at: Date.now() }) });
      return res.status(200).json({ cleared: true });
    }

    const inv = (await supabaseRest(`invoices?id=eq.${iid}&select=*`))?.[0];
    if (!inv) return res.status(404).json({ error: "This invoice hasn't synced to the cloud yet — check you're online, wait a moment and try again." });
    if (!inv.paid) return res.status(400).json({ error: "This invoice isn't marked Paid in the app." });
    if (!inv.sage_invoice_id) return res.status(400).json({ error: "This invoice isn't linked to Sage yet." });
    if (inv.sage_payment_id) return res.status(409).json({ error: "This payment is already recorded in Sage." });

    const sageInv = await sageFetch(`/sales_invoices/${encodeURIComponent(inv.sage_invoice_id)}`);
    const outstanding = money(sageInv?.outstanding_amount);
    const amount = money(inv.total);

    // Already paid in Sage → don't create anything, just note it
    if (outstanding <= 0.01) {
      await supabaseRest(`invoices?id=eq.${iid}`, { method: "PATCH", body: JSON.stringify({ sage_payment_id: ALREADY_PAID, updated_at: Date.now() }) });
      return res.status(200).json({ alreadyPaid: true, sageInvoiceNo: sageInv?.invoice_number || inv.sage_invoice_no });
    }
    if (amount > outstanding + 0.01) {
      return res.status(409).json({ error: `The app says £${amount.toFixed(2)} was paid, but Sage only has £${outstanding.toFixed(2)} left to pay on ${sageInv?.invoice_number || "this invoice"} — part of it may already be recorded in Sage. Check it in Sage before going further.` });
    }

    const contactId = sageInv?.contact?.id;
    if (!contactId) throw new Error("Couldn't find the customer on the Sage invoice.");
    const bankAccountId = await findBankAccountId();
    const date = String(inv.paid_date || new Date().toISOString()).slice(0, 10);
    const reference = (inv.payment_ref || `${inv.payment_method || "Payment"} ${sageInv?.invoice_number || ""}`).trim().slice(0, 25);

    const build = (withMethod) => ({
      contact_payment: {
        transaction_type_id: "CUSTOMER_RECEIPT",
        contact_id: contactId,
        bank_account_id: bankAccountId,
        date,
        total_amount: amount,
        reference,
        ...(withMethod && METHOD[inv.payment_method] ? { payment_method_id: METHOD[inv.payment_method] } : {}),
        allocated_artefacts: [{ artefact_id: inv.sage_invoice_id, amount }],
      },
    });

    let payment;
    try {
      payment = await sageFetch("/contact_payments", { method: "POST", body: JSON.stringify(build(true)) });
    } catch (e) {
      // If Sage doesn't like the payment method, record it without one rather than failing
      if (/payment.?method/i.test(e?.message || "")) payment = await sageFetch("/contact_payments", { method: "POST", body: JSON.stringify(build(false)) });
      else throw e;
    }
    if (!payment?.id) throw new Error("Sage didn't return a payment ID.");

    await supabaseRest(`invoices?id=eq.${iid}`, { method: "PATCH", body: JSON.stringify({ sage_payment_id: payment.id, updated_at: Date.now() }) });
    return res.status(200).json({ sagePaymentId: payment.id, amount, sageInvoiceNo: sageInv?.invoice_number || inv.sage_invoice_no });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}

