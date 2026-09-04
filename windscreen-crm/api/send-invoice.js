// Serverless function (runs on Vercel, not in the browser) — this is the "backend piece".
// It builds a real PDF invoice from scratch (not a browser print-to-PDF), optionally
// followed by a Job Card (with before/after photos) in the same PDF. Two modes:
//   previewOnly: true  -> builds the PDF and returns it as base64, doesn't send anything
//   previewOnly: false -> builds the PDF and actually emails it via Resend
//
// Needs one thing set up in Vercel before sending will work: an environment variable
// called RESEND_API_KEY (Vercel dashboard -> Project -> Settings -> Environment Variables).
// The RESEND_FROM address below must be on a domain verified in your Resend account.

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

const RESEND_FROM = "Windscreen Repairs Bristol <info@windscreenrepairsbristol.co.uk>";
// Same logo image used throughout the app's own reports — embedded directly (not a
// URL), so nothing in the PDF ever points back at the app's real address.
const LOGO_DATA_URI = "data:image/png;base64,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";

const NAVY = rgb(0.118, 0.227, 0.373);
const GREY = rgb(0.42, 0.45, 0.5);
const BLACK = rgb(0.07, 0.09, 0.11);
const LEFT = 50, RIGHT = 545, PAGE_W = 595.28, PAGE_H = 841.89;

// Draws the shared header (logo + company details), vertically centred against the
// 3-line text block. Returns the y-coordinate just below the divider line.
async function drawHeader(pdfDoc, page, font, bold) {
  const titleY = 800;
  const line2Y = titleY - 18;
  const line3Y = line2Y - 14;
  const titleSize = 18, addrSize = 10;
  const textCenterY = ((titleY + titleSize * 0.72) + (line3Y - addrSize * 0.25)) / 2;

  const logoPng = await pdfDoc.embedPng(LOGO_DATA_URI);
  const logoDims = logoPng.scale(112 / logoPng.width);
  page.drawImage(logoPng, { x: LEFT, y: textCenterY - logoDims.height / 2, width: logoDims.width, height: logoDims.height });

  const textX = LEFT + logoDims.width + 14;
  page.drawText("Windscreen Repairs (Bristol)", { x: textX, y: titleY, size: titleSize, font: bold, color: NAVY });
  page.drawText("3 Goosander Grove, Cheddar, BS27 3FY  |  07946 222246", { x: textX, y: line2Y, size: addrSize, font, color: GREY });
  page.drawText("info@windscreenrepairsbristol.co.uk", { x: textX, y: line3Y, size: addrSize, font, color: GREY });
  const dividerY = Math.min(line3Y - 10, textCenterY - logoDims.height / 2 - 8);
  page.drawLine({ start: { x: LEFT, y: dividerY }, end: { x: RIGHT, y: dividerY }, thickness: 2, color: rgb(0.96, 0.62, 0.04) });
  return dividerY - 26;
}

// Builds the Job Card page(s) — vehicle/driver/damage details, then before/after photo
// grids, spilling onto further pages automatically if there isn't room. Appended to the
// same PDF document as the invoice (as extra pages), not a separate file.
async function addJobCardPages(pdfDoc, font, bold, jobCard) {
  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = await drawHeader(pdfDoc, page, font, bold);

  page.drawText("Job Completion Report", { x: LEFT, y, size: 15, font: bold, color: NAVY });
  y -= 22;

  const rows = [
    ["Vehicle", jobCard.vehicleText],
    ["Driver", jobCard.driverName],
    ["Date", jobCard.date],
    ["Damage", jobCard.damageLines],
    ["Notes", jobCard.notes],
  ].filter(([, v]) => v);
  for (const [label, value] of rows) {
    page.drawText(label, { x: LEFT, y, size: 9, font: bold, color: GREY });
    page.drawText(String(value).slice(0, 90), { x: LEFT + 90, y, size: 10, font, color: BLACK });
    y -= 16;
  }
  y -= 10;

  function newPageIfNeeded(neededHeight) {
    if (y - neededHeight < 60) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = 800;
    }
  }

  async function drawPhotoSection(title, photos) {
    if (!photos || photos.length === 0) return;
    newPageIfNeeded(30);
    page.drawText(title, { x: LEFT, y, size: 12, font: bold, color: NAVY });
    y -= 20;

    const cols = 2, gap = 10;
    const imgW = (RIGHT - LEFT - gap) / cols;
    const imgH = imgW * 0.72;
    let col = 0;

    for (const photo of photos) {
      newPageIfNeeded(imgH + 10);
      const x = LEFT + col * (imgW + gap);
      try {
        const res = await fetch(photo.url);
        if (!res.ok) throw new Error("fetch failed");
        const bytes = new Uint8Array(await res.arrayBuffer());
        let img;
        try { img = await pdfDoc.embedJpg(bytes); } catch { img = await pdfDoc.embedPng(bytes); }
        page.drawImage(img, { x, y: y - imgH, width: imgW, height: imgH });
      } catch (e) {
        page.drawRectangle({ x, y: y - imgH, width: imgW, height: imgH, borderColor: GREY, borderWidth: 1 });
        page.drawText("Photo unavailable", { x: x + 10, y: y - imgH / 2, size: 9, font, color: GREY });
      }
      col++;
      if (col >= cols) { col = 0; y -= imgH + gap; }
    }
    if (col !== 0) y -= imgH + gap;
    y -= 10;
  }

  await drawPhotoSection("Before", jobCard.photosBefore);
  await drawPhotoSection("After", jobCard.photosAfter);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, customerName, lineItems, details, labour, parts, vat, total, sageInvoiceNo, custType, paid, paidDate, previewOnly, includeJobCard, jobCard } = req.body || {};
    if (!total) return res.status(400).json({ error: "No invoice total was provided." });
    if (!previewOnly && !to) return res.status(400).json({ error: "No recipient email address was provided." });
    // Every invoice needs its Sage reference recorded before it goes out — keeps the
    // app and Sage in sync, and avoids sending something with no way to reconcile it later.
    if (!sageInvoiceNo) return res.status(400).json({ error: "Add the Sage Invoice Number before sending this invoice." });

    // ── Build the invoice page ──────────────────────────────────────────────
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const green = rgb(0.02, 0.6, 0.4);
    const amber = rgb(0.85, 0.55, 0.02);

    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = await drawHeader(pdfDoc, page, font, bold);

    page.drawText("Invoice", { x: LEFT, y, size: 15, font: bold, color: NAVY });
    y -= 18;
    if (customerName) { page.drawText(customerName, { x: LEFT, y, size: 11, font, color: BLACK }); y -= 14; }
    const dateStr = new Date().toLocaleDateString("en-GB");
    page.drawText(`Invoice date: ${dateStr}`, { x: LEFT, y, size: 9, font, color: GREY });
    y -= 12;
    page.drawText(`Reference: ${sageInvoiceNo}`, { x: LEFT, y, size: 9, font, color: GREY });
    y -= 12;
    y -= 14;

    page.drawText("Description", { x: LEFT, y, size: 9, font: bold, color: GREY });
    page.drawText("Amount", { x: RIGHT - 60, y, size: 9, font: bold, color: GREY });
    y -= 6;
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    y -= 16;

    const wrapText = (text, maxChars) => {
      const paragraphs = String(text || "").split("\n");
      const lines = [];
      for (const para of paragraphs) {
        const words = para.split(" ");
        let cur = "";
        for (const w of words) {
          if ((cur + " " + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
          else cur = (cur + " " + w).trim();
        }
        lines.push(cur.trim());
      }
      return lines.length ? lines : [""];
    };

    const items = (Array.isArray(lineItems) && lineItems.length)
      ? lineItems.map(li => ({ description: li.description, price: li.price }))
      : [{ description: details || "Windscreen Repair", price: labour || total }];

    for (const item of items) {
      const lines = wrapText(item.description, 78);
      lines.forEach((line, i) => {
        page.drawText(line, { x: LEFT, y, size: 10, font, color: BLACK });
        if (i === 0) page.drawText(`£${(parseFloat(item.price) || 0).toFixed(2)}`, { x: RIGHT - 60, y, size: 10, font, color: BLACK });
        y -= 14;
      });
      y -= 4;
    }
    if (parseFloat(parts) > 0) {
      page.drawText("Parts", { x: LEFT, y, size: 10, font, color: BLACK });
      page.drawText(`£${parseFloat(parts).toFixed(2)}`, { x: RIGHT - 60, y, size: 10, font, color: BLACK });
      y -= 18;
    }

    y -= 8;
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    y -= 24;
    page.drawText(`Total${vat ? " (inc. VAT)" : ""}`, { x: RIGHT - 180, y, size: 13, font: bold, color: NAVY });
    page.drawText(`£${parseFloat(total).toFixed(2)}`, { x: RIGHT - 60, y, size: 13, font: bold, color: NAVY });

    // Footer — payment terms and payment details, fixed near the bottom of the page
    // regardless of how long the itemised section above happens to be
    const footerTop = 150;

    // PAID stamp — sits in whatever whitespace is available between the total and the
    // footer, so it looks right whether the invoice is short or has several line items
    if (paid) {
      const stampCenterY = (y + footerTop) / 2;
      page.drawText("PAID", {
        x: LEFT + 130, y: stampCenterY - 25,
        size: 64,
        font: bold,
        color: rgb(0.75, 0.1, 0.1),
        rotate: degrees(-20),
      });
    }

    page.drawLine({ start: { x: LEFT, y: footerTop }, end: { x: RIGHT, y: footerTop }, thickness: 1, color: rgb(0.9, 0.9, 0.9) });
    let fy = footerTop - 20;

    const termsLine = paid
      ? `Paid${paidDate ? " " + paidDate : ""}`
      : (custType === "Trade" ? "Payment due within 30 days" : "Payment due by return — please pay promptly using the details below");
    page.drawText(termsLine, { x: LEFT, y: fy, size: 10, font: bold, color: paid ? green : amber });
    fy -= 22;

    page.drawText("PAYMENT DETAILS", { x: LEFT, y: fy, size: 9, font: bold, color: GREY });
    fy -= 15;
    page.drawText("David Morgan trading as Windscreen Repairs (Bristol)", { x: LEFT, y: fy, size: 10, font, color: BLACK });
    fy -= 14;
    page.drawText("Account number: 02340725", { x: LEFT, y: fy, size: 10, font, color: BLACK });
    fy -= 14;
    page.drawText("Sort code: 04-00-06", { x: LEFT, y: fy, size: 10, font, color: BLACK });

    // ── Optionally append the Job Card as extra page(s), including photos ─────
    if (includeJobCard && jobCard) {
      await addJobCardPages(pdfDoc, font, bold, jobCard);
    }

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
        bcc: ["info@windscreenrepairsbristol.co.uk"],
        subject: `Invoice — ${customerName || "Windscreen Repairs Bristol"}`,
        text: `Please find your invoice${includeJobCard ? " and job card" : ""} attached, totalling £${parseFloat(total).toFixed(2)}.\n\nWindscreen Repairs (Bristol)\n07946 222246`,
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
