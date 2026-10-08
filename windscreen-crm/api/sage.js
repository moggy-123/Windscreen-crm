// ONE web address for every Sage feature: /api/sage?action=...
// Keeping them together means Sage only counts as one serverless function on Vercel
// (the free plan allows 12 in total). The real work lives in the _underscore files,
// which Vercel treats as shared code rather than separate functions.

import pushCustomer from "./_push-customer.js";
import contacts from "./_contacts.js";
import linkCustomer from "./_link-customer.js";
import pushInvoice from "./_push-invoice.js";
import matchInvoices from "./_match-invoices.js";
import linkInvoice from "./_link-invoice.js";
import pushPayment from "./_push-payment.js";

const ACTIONS = {
  "push-customer": pushCustomer,
  "contacts": contacts,
  "link-customer": linkCustomer,
  "push-invoice": pushInvoice,
  "match-invoices": matchInvoices,
  "link-invoice": linkInvoice,
  "push-payment": pushPayment,
};

export default async function handler(req, res) {
  const run = ACTIONS[req.query?.action];
  if (!run) return res.status(404).json({ error: `Unknown Sage action "${req.query?.action || ""}".` });
  return run(req, res);
}

