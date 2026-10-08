// Creates one CRM invoice in Sage as a sales invoice, then saves Sage's invoice ID and
// invoice number back onto the CRM invoice. Called by the "Push Invoice to Sage" button.
//
// Rules:
//   • The customer must already be linked to Sage (customers.sage_id).
//   • Every line goes to sales account 4000, with no VAT (not VAT registered).
//   • An invoice already pushed (sage_invoice_id set) is refused — no double invoices.
//   • An invoice that already has a Sage number typed in by hand asks for confirmation
//     first, because it was probably already created in Sage manually.
//   • Only ever CREATES invoices — never reads, edits or touches invoices made in Sage.

import { verifyAppUser, supabaseRest, sageFetch } from "./_sage.js";

const SALES_NOMINAL_CODE = "4000";

async function findSalesLedgerId() {
  for (let page = 1; page <= 10; page++) {
    const r = await sageFetch(`/ledger_accounts?items_per_page=200&page=${page}&attributes=nominal_code,name`);
    const items = r?.$items || [];
    const hit = items.find(a => String(a.nominal_code) === SALES_NOMINAL_CODE);
    if (hit) return hit.id;
    if (!r?.$next || items.length === 0) break;
  }
  throw new Error(`Couldn't find sales account ${SALES_NOMINAL_CODE} in Sage.`);
}

const money = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const dateOnly = v => (v ? String(v).slice(0, 10) : new Date().toISOString().slice(0, 10));
function addDays(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const user = await verifyAppUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in — please sign in to the app again." });

    const { invoiceId, force } = req.body || {};
    if (!invoiceId) return res.status(400).json({ error: "No invoice given." });

    const inv = (await supabaseRest(`invoices?id=eq.${encodeURIComponent(invoiceId)}&select=*`))?.[0];
    if (!inv) return res.status(404).json({ error: "This invoice hasn't synced to the cloud yet — check you're online, wait a moment and try again." });
    if (inv.sage_invoice_id) return res.status(409).json({ error: `Already in Sage as invoice ${inv.sage_invoice_no || ""}.` });
    if (inv.sage_invoice_no && !force) {
      return res.status(409).json({ needsConfirm: true, error: `This invoice already has a Sage number typed in (${inv.sage_invoice_no}), so it may already have been created in Sage by hand.` });
    }
    if (inv.vat) return res.status(400).json({ error: "This invoice has VAT ticked, but you're not VAT registered. Edit the invoice, untick VAT, save, then push again." });

    const job = (await supabaseRest(`jobs?id=eq.${encodeURIComponent(inv.job_id)}&select=customer_id,date`))?.[0];
    if (!job) return res.status(404).json({ error: "Couldn't find the job this invoice belongs to." });
    const cust = (await supabaseRest(`customers?id=eq.${encodeURIComponent(job.customer_id)}&select=company,company_contact,cust_type,sage_id`))?.[0];
    if (!cust?.sage_id) return res.status(400).json({ error: "This customer isn't linked to Sage yet — link them first (Settings → Link Customers to Sage)." });

    // Duplicate guard: does Sage already have an invoice for this customer for the same
    // amount that isn't linked to anything in the app? (e.g. made by hand, number never typed in)
    if (!force) {
      const linkedRows = await supabaseRest("invoices?sage_invoice_id=not.is.null&select=sage_invoice_id");
      const linked = new Set((linkedRows || []).map(r => r.sage_invoice_id));
      const existing = await sageFetch(`/sales_invoices?contact_id=${encodeURIComponent(cust.sage_id)}&items_per_page=200&attributes=invoice_number,date,total_amount,status`);
      const same = (existing?.$items || []).filter(x =>
        !linked.has(x.id) &&
        !String(x.status?.id || "").toUpperCase().includes("VOID") &&
        Math.abs(money(x.total_amount) - money(inv.total)) <= 0.01);
      if (same.length) {
        return res.status(409).json({
          needsConfirm: true,
          error: `Sage already has ${same.length === 1 ? "an invoice" : "invoices"} for this customer for £${money(inv.total).toFixed(2)}: ${same.map(x => `${x.invoice_number || x.displayed_as} (${String(x.date || "").slice(0, 10)})`).join(", ")}. It may already be in Sage — if so, use Settings → Match Invoices to Sage instead.`,
        });
      }
    }

    // Build the invoice lines from the app's invoice
    const ledgerId = await findSalesLedgerId();
    const lines = [];
    const addLine = (description, amount) => {
      const a = money(amount);
      if (a > 0) lines.push({ description: String(description || "Windscreen repair").slice(0, 250), quantity: 1, unit_price: a, ledger_account_id: ledgerId });
    };
    const items = Array.isArray(inv.line_items) ? inv.line_items : [];
    if (items.length > 0) {
      items.forEach(li => addLine(li.description, li.price));
    } else {
      addLine(inv.details || "Windscreen repair", inv.labour);
    }
    addLine("Parts", inv.parts);

    if (lines.length === 0) return res.status(400).json({ error: "This invoice comes to £0 — nothing to send to Sage." });
    const linesTotal = money(lines.reduce((s, l) => s + l.unit_price, 0));
    if (Math.abs(linesTotal - money(inv.total)) > 0.01) {
      return res.status(400).json({ error: `The invoice lines add up to £${linesTotal.toFixed(2)} but the invoice total is £${money(inv.total).toFixed(2)}. Open the invoice, check it and save it again, then push.` });
    }

    const date = dateOnly(inv.created_at || job.date);
    const due = cust.cust_type === "Private" ? date : addDays(date, 30);

    const create = (withTax) => sageFetch("/sales_invoices", {
      method: "POST",
      body: JSON.stringify({
        sales_invoice: {
          contact_id: cust.sage_id,
          date,
          due_date: due,
          invoice_lines: withTax ? lines.map(l => ({ ...l, tax_rate_id: "GB_NO_TAX" })) : lines,
        },
      }),
    });

    let created;
    try {
      created = await create(false);
    } catch (e) {
      // Some Sage setups insist on a tax rate on every line — "No Tax" is right when not VAT registered
      if (/tax/i.test(e?.message || "")) created = await create(true);
      else throw e;
    }
    if (!created?.id) throw new Error("Sage didn't return an invoice ID.");

    const sageNo = created.invoice_number || created.displayed_as || "";
    await supabaseRest(`invoices?id=eq.${encodeURIComponent(invoiceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ sage_invoice_id: created.id, sage_invoice_no: sageNo, updated_at: Date.now() }),
    });

    const sageTotal = money(created.total_amount);
    const warning = created.total_amount != null && Math.abs(sageTotal - linesTotal) > 0.01
      ? `Sage's total (£${sageTotal.toFixed(2)}) doesn't match the app (£${linesTotal.toFixed(2)}) — please check it in Sage.`
      : "";

    return res.status(200).json({ sageInvoiceId: created.id, sageInvoiceNo: sageNo, warning });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
