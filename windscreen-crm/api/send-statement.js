// Serverless function — builds a Statement of Account as a real, multi-page-safe PDF
// and either returns it for preview or emails it via Resend. The list of unpaid
// invoices is sent by the app itself (not recomputed here), so there's only ever one
// source of truth for what's actually outstanding.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { drawHeader, makeFlow, NAVY, GREY, BLACK, LEFT, RIGHT, PAGE_W, PAGE_H } from "./_pdf-shared.js";

const RESEND_FROM = "Windscreen Repairs Bristol <info@windscreenrepairsbristol.co.uk>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, customerName, rows, totalOwed, previewOnly } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: "No statement rows were provided." });
    if (!previewOnly && !to) return res.status(400).json({ error: "No recipient email address was provided." });

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const amber = rgb(0.573, 0.251, 0.055);
    const amberBg = rgb(1, 0.984, 0.925);
    const amberBorder = rgb(0.992, 0.906, 0.651);
    const red = rgb(0.86, 0.15, 0.15);
    const lineGrey = rgb(0.9, 0.9, 0.9);
    const headerBg = rgb(0.976, 0.980, 0.984);

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = await drawHeader(pdfDoc, page, font, bold);
    const flow = makeFlow(pdfDoc, page, y);
    const dateStr = new Date().toLocaleDateString("en-GB");

    flow.ensureSpace(50);
    flow.page.drawText("Statement of Account", { x: LEFT, y: flow.y, size: 15, font: bold, color: NAVY });
    flow.setY(flow.y - 18);
    if (customerName) { flow.page.drawText(customerName, { x: LEFT, y: flow.y, size: 11, font, color: BLACK }); flow.setY(flow.y - 14); }
    flow.page.drawText(`Statement date: ${dateStr}`, { x: LEFT, y: flow.y, size: 9, font, color: GREY });
    flow.setY(flow.y - 22);

    // Table header — repeated automatically at the top of any new page via drawTableHeader()
    function drawTableHeader() {
      flow.ensureSpace(24);
      flow.page.drawRectangle({ x: LEFT, y: flow.y - 4, width: RIGHT - LEFT, height: 22, color: headerBg });
      flow.page.drawText("DATE", { x: LEFT + 8, y: flow.y + 4, size: 9, font: bold, color: GREY });
      flow.page.drawText("DESCRIPTION", { x: LEFT + 90, y: flow.y + 4, size: 9, font: bold, color: GREY });
      flow.page.drawText("AMOUNT", { x: RIGHT - 70, y: flow.y + 4, size: 9, font: bold, color: GREY });
      flow.setY(flow.y - 6);
      flow.page.drawLine({ start: { x: LEFT, y: flow.y }, end: { x: RIGHT, y: flow.y }, thickness: 1, color: lineGrey });
      flow.setY(flow.y - 18);
    }
    drawTableHeader();

    if (rows.length === 0) {
      flow.page.drawText("Nothing outstanding", { x: LEFT + 90, y: flow.y, size: 10, font, color: GREY });
      flow.setY(flow.y - 18);
    }

    for (const row of rows) {
      const startedNewPage = flow.ensureSpace(18);
      if (startedNewPage) drawTableHeader();
      flow.page.drawText(row.date || "", { x: LEFT + 8, y: flow.y, size: 10, font, color: GREY });
      flow.page.drawText((row.description || "—").slice(0, 55), { x: LEFT + 90, y: flow.y, size: 10, font, color: BLACK });
      if (row.overdue) {
        const descWidth = font.widthOfTextAtSize((row.description || "—").slice(0, 55), 10);
        flow.page.drawText("(overdue)", { x: LEFT + 90 + descWidth + 6, y: flow.y, size: 9, font: bold, color: red });
      }
      flow.page.drawText(`£${(parseFloat(row.amount) || 0).toFixed(2)}`, { x: RIGHT - 70, y: flow.y, size: 10, font: bold, color: BLACK });
      flow.setY(flow.y - 18);
    }

    flow.setY(flow.y - 6);
    flow.ensureSpace(40);
    flow.page.drawRectangle({ x: LEFT, y: flow.y - 22, width: RIGHT - LEFT, height: 36, color: amberBg, borderColor: amberBorder, borderWidth: 1 });
    flow.page.drawText("Total Outstanding", { x: LEFT + 14, y: flow.y - 8, size: 13, font: bold, color: amber });
    flow.page.drawText(`£${parseFloat(totalOwed || 0).toFixed(2)}`, { x: RIGHT - 90, y: flow.y - 8, size: 15, font: bold, color: amber });
    flow.setY(flow.y - 44);

    flow.ensureSpace(80);
    flow.page.drawRectangle({ x: LEFT, y: flow.y - 62, width: RIGHT - LEFT, height: 78, color: headerBg, borderColor: lineGrey, borderWidth: 1 });
    flow.setY(flow.y - 12);
    flow.page.drawText("PAYMENT DETAILS", { x: LEFT + 14, y: flow.y, size: 9, font: bold, color: GREY });
    flow.setY(flow.y - 18);
    flow.page.drawText("David Morgan trading as Windscreen Repairs (Bristol)", { x: LEFT + 14, y: flow.y, size: 10, font, color: BLACK });
    flow.setY(flow.y - 15);
    flow.page.drawText("Account number: 02340725", { x: LEFT + 14, y: flow.y, size: 10, font, color: BLACK });
    flow.setY(flow.y - 15);
    flow.page.drawText("Sort code: 04-00-06", { x: LEFT + 14, y: flow.y, size: 10, font, color: BLACK });
    flow.setY(flow.y - 30);

    flow.ensureSpace(14);
    flow.page.drawText("Payment is due within 30 days of invoice date. Please get in touch if you have any queries about this statement.", { x: LEFT, y: flow.y, size: 9, font, color: GREY });

    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");

    if (previewOnly) {
      return res.status(200).json({ preview: true, pdfBase64 });
    }

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
        subject: `Statement of Account — ${customerName || "Windscreen Repairs Bristol"}`,
        text: `Please find our statement attached, showing a total outstanding balance of £${parseFloat(totalOwed || 0).toFixed(2)}.\n\nWindscreen Repairs (Bristol)\n07946 222246`,
        attachments: [{ filename: "statement.pdf", content: pdfBase64 }],
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return res.status(502).json({ error: `Resend rejected the email: ${errText}` });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error building or sending the statement." });
  }
}
