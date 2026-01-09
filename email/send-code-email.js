// send-code-email.js - Email endpoint for sending crypto transfer codes
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

const router = express.Router();

// Initialize Resend
if (!process.env.RESEND_API_KEY) {
  console.warn("WARNING: RESEND_API_KEY not set. Email sending will fail.");
}

const resend = new Resend(process.env.RESEND_API_KEY);

// Simple in-memory rate limiter (use Redis in production)
const ipCounts = new Map();
const RATE_LIMIT_MAX = 12; // max 12 emails per IP per day
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function checkRateLimit(ipAddress) {
  const entry = ipCounts.get(ipAddress) || { count: 0, ts: Date.now() };
  const now = Date.now();

  // Reset counter if window expired (24 hours)
  if (now - entry.ts > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.ts = now;
  }

  entry.count++;
  ipCounts.set(ipAddress, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

// POST /send-email - Send security alert email
router.post("/send-email", async (req, res) => {
  try {
    const { to, subject, from, html, senderName } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    // Validate required fields
    if (!to) {
      return res.status(400).json({
        error: "Missing required field: 'to'"
      });
    }

    // Basic email validation
    if (typeof to !== "string" || !to.includes("@")) {
      return res.status(400).json({
        error: "Invalid email address"
      });
    }

    // Check rate limit (12 emails per IP per day)
    if (!checkRateLimit(ip)) {
      return res.status(429).json({
        error: "Daily limit reached. You can only send 12 codes per day."
      });
    }

    // Construct email HTML (use provided HTML or default template)
    const messageHtml = html || `
<!DOCTYPE html>
<html>

<body style="font-family: Arial, sans-serif; background:#f5f5f5; padding:20px;">
    <table width="100%" max-width="600" align="center" style="background:#ffffff; padding:20px;">
        <tr>
            <td>
                <h3>New sign-in blocked — action may be required</h3>

                <p>Hi Michael,</p>

                <p>
                    We blocked a recent sign-in attempt to your account from a new device.
                </p>

                <p>
                    <strong>Location:</strong> Lagos, NG<br />
                    <strong>Device:</strong> Android<br />
                    <strong>Time:</strong> Today, 14:21
                </p>

                <p>
                    If you don’t recognize this activity, we recommend securing your account.
                </p>

                <a href="#" style="color:#0066cc;">
                    Review activity
                </a>

                <p style="margin-top:30px;">
                    Thanks,<br />
                    Account Security Team
                </p>
            </td>
        </tr>
    </table>
</body>

</html>
    `;



    // Send email via Resend
    const sendResult = await resend.emails.send({
      from: from || process.env.DEFAULT_FROM || "noreply@column.app",
      to,
      subject: subject || "New sign-in blocked",
      html: messageHtml,

    });

    // Debug: Log full Resend response
    console.log('[Resend Response]', JSON.stringify(sendResult, null, 2));

    // Check if there's an error in the response
    if (sendResult.error) {
      throw new Error(sendResult.error.message || 'Resend API error');
    }

    // Log success (optional: store in database for audit)
    console.log(`[Email Sent] Security alert sent to ${to}, ID: ${sendResult.data?.id}`);

    res.json({
      success: true,
      id: sendResult.data?.id || null,
      message: "Email sent successfully"
    });

  } catch (err) {
    console.error("Error sending email:", err);
    res.status(500).json({
      error: "Failed to send email",
      details: process.env.NODE_ENV === 'development' ? err?.message : undefined
    });
  }
});

export default router;
