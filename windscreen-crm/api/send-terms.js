// Serverless function — builds the Terms & Conditions as a real, multi-page PDF and
// either returns it for preview or emails it via Resend. The actual terms text is sent
// by the app itself (not duplicated here) so there's only ever one copy to keep in sync.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { drawHeader, wrapText, makeFlow, NAVY, GREY, BLACK, LEFT, RIGHT, PAGE_W, PAGE_H } from "./_pdf-shared.js";

const RESEND_FROM = "Windscreen Repairs Bristol <info@windscreenrepairsbristol.co.uk>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, customerName, sections, intro, previewOnly } = req.body || {};
    if (!Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: "No terms content was provided." });
    }
    if (!previewOnly && !to) return res.status(400).json({ error: "No recipient email address was provided." });

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = await drawHeader(pdfDoc, page, font, bold);
    const flow = makeFlow(pdfDoc, page, y);

    flow.ensureSpace(40);
    flow.page.drawText("Terms and Conditions for Windscreen Repair Services", { x: LEFT, y: flow.y, size: 15, font: bold, color: NAVY });
    flow.setY(flow.y - 22);

    if (intro) {
      const introLines = wrapText(intro, 100);
      for (const line of introLines) {
        flow.ensureSpace(13);
        flow.page.drawText(line, { x: LEFT, y: flow.y, size: 9, font, color: GREY });
        flow.setY(flow.y - 13);
      }
      flow.setY(flow.y - 12);
    }

    for (const section of sections) {
      flow.ensureSpace(30);
      flow.page.drawText(section.title, { x: LEFT, y: flow.y, size: 12, font: bold, color: NAVY });
      flow.setY(flow.y - 18);

      for (const item of section.items || []) {
        const prefix = item.h ? `${item.h}: ` : "";
        const combined = prefix + (item.t || "");
        const lines = wrapText(combined, 96);
        // Bold the heading prefix on the first line only, matching the app's own display
        lines.forEach((line, i) => {
          flow.ensureSpace(14);
          if (i === 0 && item.h) {
            flow.page.drawText(`${item.h}: `, { x: LEFT, y: flow.y, size: 10, font: bold, color: BLACK });
            const prefixWidth = bold.widthOfTextAtSize(`${item.h}: `, 10);
            const rest = line.slice(prefix.length);
            flow.page.drawText(rest, { x: LEFT + prefixWidth + 2, y: flow.y, size: 10, font, color: BLACK });
          } else {
            flow.page.drawText(line, { x: LEFT, y: flow.y, size: 10, font, color: BLACK });
          }
          flow.setY(flow.y - 14);
        });
        flow.setY(flow.y - 6);
      }
      flow.setY(flow.y - 8);
    }

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
        subject: "Terms and Conditions — Windscreen Repairs Bristol",
        text: `Please find our current Terms and Conditions attached.\n\nWindscreen Repairs (Bristol)\n07946 222246`,
        attachments: [{ filename: "terms-and-conditions.pdf", content: pdfBase64 }],
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return res.status(502).json({ error: `Resend rejected the email: ${errText}` });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error building or sending the terms document." });
  }
}
