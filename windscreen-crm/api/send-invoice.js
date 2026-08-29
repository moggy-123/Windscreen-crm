// Serverless function (runs on Vercel, not in the browser) — this is the "backend piece".
// It builds a real PDF invoice from scratch (not a browser print-to-PDF). Two modes:
//   previewOnly: true  -> builds the PDF and returns it as base64, doesn't send anything
//   previewOnly: false -> builds the PDF and actually emails it via Resend
//
// Needs one thing set up in Vercel before sending will work: an environment variable
// called RESEND_API_KEY (Vercel dashboard -> Project -> Settings -> Environment Variables).
// The RESEND_FROM address below must be on a domain verified in your Resend account.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const RESEND_FROM = "Windscreen Repairs Bristol <invoices@windscreenrepairsbristol.co.uk>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, customerName, lineItems, details, labour, parts, vat, total, sageInvoiceNo, custType, paid, paidDate, previewOnly } = req.body || {};
    if (!total) return res.status(400).json({ error: "No invoice total was provided." });
    if (!previewOnly && !to) return res.status(400).json({ error: "No recipient email address was provided." });
    // Every invoice needs its Sage reference recorded before it goes out — keeps the
    // app and Sage in sync, and avoids sending something with no way to reconcile it later.
    if (!sageInvoiceNo) return res.status(400).json({ error: "Add the Sage Invoice Number before sending this invoice." });

    // ── Build the PDF ──────────────────────────────────────────────────────
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 in points
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const navy = rgb(0.118, 0.227, 0.373);
    const grey = rgb(0.42, 0.45, 0.5);
    const green = rgb(0.02, 0.6, 0.4);
    const amber = rgb(0.85, 0.55, 0.02);
    const black = rgb(0.07, 0.09, 0.11);

    let y = 800;
    const left = 50, right = 545;

    page.drawText("Windscreen Repairs (Bristol)", { x: left, y, size: 18, font: bold, color: navy });
    y -= 18;
    page.drawText("3 Goosander Grove, Cheddar, BS27 3FY  |  07946 222246", { x: left, y, size: 10, font, color: grey });
    y -= 14;
    page.drawText("info@windscreenrepairsbristol.co.uk", { x: left, y, size: 10, font, color: grey });
    y -= 6;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 2, color: rgb(0.96, 0.62, 0.04) });
    y -= 26;

    page.drawText("Invoice", { x: left, y, size: 15, font: bold, color: navy });
    y -= 18;
    if (customerName) { page.drawText(customerName, { x: left, y, size: 11, font, color: black }); y -= 14; }
    const dateStr = new Date().toLocaleDateString("en-GB");
    page.drawText(`Invoice date: ${dateStr}`, { x: left, y, size: 9, font, color: grey });
    y -= 12;
    page.drawText(`Reference: ${sageInvoiceNo}`, { x: left, y, size: 9, font, color: grey });
    y -= 12;
    y -= 14;

    // Table header
    page.drawText("Description", { x: left, y, size: 9, font: bold, color: grey });
    page.drawText("Amount", { x: right - 60, y, size: 9, font: bold, color: grey });
    y -= 6;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    y -= 16;

    const wrapText = (text, maxChars) => {
      const words = String(text || "").split(" ");
      const lines = [];
      let cur = "";
      for (const w of words) {
        if ((cur + " " + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
        else cur = (cur + " " + w).trim();
      }
      if (cur) lines.push(cur);
      return lines.length ? lines : [""];
    };

    const items = (Array.isArray(lineItems) && lineItems.length)
      ? lineItems.map(li => ({ description: li.description, price: li.price }))
      : [{ description: details || "Windscreen Repair", price: labour || total }];

    for (const item of items) {
      const lines = wrapText(item.description, 78);
      lines.forEach((line, i) => {
        page.drawText(line, { x: left, y, size: 10, font, color: black });
        if (i === 0) page.drawText(`£${(parseFloat(item.price) || 0).toFixed(2)}`, { x: right - 60, y, size: 10, font, color: black });
        y -= 14;
      });
      y -= 4;
    }
    if (parseFloat(parts) > 0) {
      page.drawText("Parts", { x: left, y, size: 10, font, color: black });
      page.drawText(`£${parseFloat(parts).toFixed(2)}`, { x: right - 60, y, size: 10, font, color: black });
      y -= 18;
    }

    y -= 8;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    y -= 24;
    page.drawText(`Total${vat ? " (inc. VAT)" : ""}`, { x: right - 180, y, size: 13, font: bold, color: navy });
    page.drawText(`£${parseFloat(total).toFixed(2)}`, { x: right - 60, y, size: 13, font: bold, color: navy });

    // ── Footer — payment terms and payment details, fixed near the bottom of the
    // page regardless of how long the itemised section above happens to be ──────
    const footerTop = 150;
    page.drawLine({ start: { x: left, y: footerTop }, end: { x: right, y: footerTop }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    let fy = footerTop - 20;

    const termsLine = paid
      ? `Paid${paidDate ? " " + paidDate : ""}`
      : (custType === "Trade" ? "Payment due within 30 days" : "Payment due by return — please pay promptly using the details below");
    page.drawText(termsLine, { x: left, y: fy, size: 10, font: bold, color: paid ? green : amber });
    fy -= 22;

    page.drawText("PAYMENT DETAILS", { x: left, y: fy, size: 9, font: bold, color: grey });
    fy -= 15;
    page.drawText("David Morgan trading as Windscreen Repairs (Bristol)", { x: left, y: fy, size: 10, font, color: black });
    fy -= 14;
    page.drawText("Account number: 02340725", { x: left, y: fy, size: 10, font, color: black });
    fy -= 14;
    page.drawText("Sort code: 04-00-06", { x: left, y: fy, size: 10, font, color: black });

    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");

    // ── Preview mode: return the PDF, don't send anything ──────────────────
    if (previewOnly) {
      return res.status(200).json({ preview: true, pdfBase64 });
    }

    // ── Send via Resend ────────────────────────────────────────────────────
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: "Email sending isn't set up yet — RESEND_API_KEY is missing from Vercel's environment variables." });
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject: `Invoice — ${customerName || "Windscreen Repairs Bristol"}`,
        text: `Please find your invoice attached, totalling £${parseFloat(total).toFixed(2)}.\n\nWindscreen Repairs (Bristol)\n07946 222246`,
        attachments: [{ filename: "invoice.pdf", content: pdfBase64 }],
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return res.status(502).json({ error: `Resend rejected the email: ${errText}` });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error building or sending the invoice." });
  }
}
