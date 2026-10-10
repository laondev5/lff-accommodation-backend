import { Resend } from "resend";
import { env, primaryClientUrl } from "../config/env";
import { fmtDate, money } from "../utils/helpers";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

// Resend cannot send from free mailbox providers; the sender must be on a domain verified in Resend.
if (resend && /@(gmail|yahoo|outlook|hotmail|icloud)./i.test(env.EMAIL_FROM)) {
  console.warn("[email] EMAIL_FROM uses a free mailbox domain. Resend will reject it: verify your own domain at resend.com/domains and use an address on it (or onboarding@resend.dev for testing).");
}

/** Never throws: email problems must not break the business flow. */
export async function sendEmail(to: string | string[], subject: string, html: string) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to];
  if (!recipients.length) return;
  if (!resend) {
    console.log(`[email:dry-run] to=${recipients.join(",")} subject="${subject}"`);
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to: recipients, subject, html });
    if (error) console.error("[email] resend error", error);
  } catch (e) {
    console.error("[email] send failed", e);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, body: string, cta?: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:100%;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0f6b36;border-bottom:4px solid #f7941d;color:#fff;padding:20px 28px;font-size:18px;font-weight:bold">${esc(title)}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">${body}
${cta ? `<p style="margin:28px 0 0"><a href="${cta.url}" style="background:#0f6b36;border-bottom:4px solid #f7941d;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">${esc(cta.label)}</a></p>` : ""}
</td></tr></table></td></tr></table></body></html>`;
}

interface BookingLike {
  code: string;
  visitor: { name: string };
  startDate: Date;
  endDate: Date;
  totalAmount?: number;
  profileToken: string;
  profileExpiresAt: Date;
}
export const profileUrl = (token: string) => `${primaryClientUrl}/booking/${token}`;

export function bookingConfirmedEmail(b: BookingLike, accommodationName: string) {
  return layout(
    "Your accommodation is confirmed",
    `<p>Hello ${esc(b.visitor.name)},</p>
<p>Your payment was received and <b>${esc(accommodationName)}</b> is reserved for you.</p>
<table cellpadding="6" style="background:#f4f4f5;border-radius:8px;width:100%">
<tr><td>Accommodation ID</td><td><b style="font-size:17px">${b.code}</b></td></tr>
<tr><td>Check-in</td><td>${fmtDate(b.startDate)}</td></tr>
<tr><td>Check-out</td><td>${fmtDate(b.endDate)}</td></tr>
${b.totalAmount != null ? `<tr><td>Total paid</td><td>${money(b.totalAmount)}</td></tr>` : ""}
</table>
<p>Use your personal link below to view your stay, extend it, and get reminders. The link expires ${fmtDate(b.profileExpiresAt)}.</p>`,
    { label: "Open my booking", url: profileUrl(b.profileToken) },
  );
}

export function reminderEmail(b: BookingLike, accommodationName: string) {
  return layout(
    "Your stay is ending soon",
    `<p>Hello ${esc(b.visitor.name)},</p>
<p>Your stay in <b>${esc(accommodationName)}</b> (ID <b>${b.code}</b>) ends on <b>${fmtDate(b.endDate)}</b>.</p>
<p>Need more time? You can extend your stay from your booking page before it expires.</p>`,
    { label: "Extend my stay", url: profileUrl(b.profileToken) },
  );
}

export function endedEmail(b: BookingLike, accommodationName: string) {
  return layout(
    "Your stay has ended",
    `<p>Hello ${esc(b.visitor.name)},</p>
<p>Your stay in <b>${esc(accommodationName)}</b> (ID <b>${b.code}</b>) has ended. Please check out and return any keys to the accommodation desk.</p>
<p>Thank you for staying with us.</p>`,
  );
}

export function paymentReceivedEmail(name: string, code: string, extra: string) {
  return layout("We received your payment details", `<p>Hello ${esc(name)},</p><p>${extra}</p><p>Booking ID: <b>${code}</b></p>`);
}

export function adminAlertEmail(title: string, message: string) {
  return layout(title, `<p>${esc(message)}</p>`, { label: "Open dashboard", url: `${primaryClientUrl}/admin` });
}
