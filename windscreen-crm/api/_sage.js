// ONE web address for every Sage feature: /api/sage?action=...
// Keeping them together means Sage only counts as one serverless function on Vercel
// (the free plan allows 12 in total). The real work lives in the _underscore files,
// which Vercel treats as shared code rather than separate functions.
//
// Each file is only loaded when its action is used, so if one file is missing or broken
// it only stops THAT feature — every other Sage feature keeps working.

const ACTIONS = {
  "push-customer":  () => import("./_push-customer.js"),
  "contacts":       () => import("./_contacts.js"),
  "link-customer":  () => import("./_link-customer.js"),
  "push-invoice":   () => import("./_push-invoice.js"),
  "match-invoices": () => import("./_match-invoices.js"),
  "link-invoice":   () => import("./_link-invoice.js"),
  "push-payment":   () => import("./_push-payment.js"),
  "check-dates":    () => import("./_check-dates.js"),
};

// Allow longer than the default time limit where the Vercel plan permits it
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const action = req.query?.action || "";
  const load = ACTIONS[action];
  if (!load) return res.status(404).json({ error: `Unknown Sage action "${action}".`, ok: true });
  let mod;
  try {
    mod = await load();
  } catch (e) {
    return res.status(500).json({ error: `The server file for "${action}" is missing or broken — check the api folder (the name must start with an underscore). Details: ${e?.message || e}` });
  }
  return mod.default(req, res);
}
