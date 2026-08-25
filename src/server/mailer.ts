import 'server-only'
import nodemailer from 'nodemailer'

import { appUrl, isSmtpConfigured } from '@/lib/env'

/**
 * Transactional email.
 *
 * When SMTP is not configured (local development) messages are printed to the
 * server log with their action links intact, so flows like email verification
 * and password reset remain fully testable without a mail provider.
 */
let transporter: nodemailer.Transporter | null = null

function getTransport(): nodemailer.Transporter | null {
  if (!isSmtpConfigured()) return null
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  })
  return transporter
}

export interface MailInput {
  to: string
  subject: string
  html: string
  text?: string
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>
}

export async function sendMail(input: MailInput): Promise<{ sent: boolean }> {
  const transport = getTransport()
  if (!transport) {
    console.info(
      `\n[mail] SMTP not configured — message not sent.\n  To:      ${input.to}\n  Subject: ${input.subject}\n  Text:    ${
        input.text ?? input.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500)
      }\n`,
    )
    return { sent: false }
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? 'TableFlow <no-reply@tableflow.app>',
      ...input,
    })
    return { sent: true }
  } catch (error) {
    console.error('[mail] delivery failed', error)
    return { sent: false }
  }
}

// ── templates ────────────────────────────────────────────────────────────────

function layout(title: string, body: string, cta?: { label: string; href: string }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <tr><td style="padding:28px 32px 8px">
      <div style="font-size:15px;font-weight:700;letter-spacing:-.01em;color:#ea580c">TableFlow</div>
    </td></tr>
    <tr><td style="padding:8px 32px 4px">
      <h1 style="margin:0;font-size:22px;line-height:1.3;letter-spacing:-.02em">${title}</h1>
    </td></tr>
    <tr><td style="padding:12px 32px 4px;font-size:15px;line-height:1.6;color:#3f3f46">${body}</td></tr>
    ${
      cta
        ? `<tr><td style="padding:20px 32px 8px">
             <a href="${cta.href}" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px">${cta.label}</a>
           </td></tr>
           <tr><td style="padding:4px 32px 8px;font-size:12px;color:#71717a;word-break:break-all">Or paste this link into your browser:<br>${cta.href}</td></tr>`
        : ''
    }
    <tr><td style="padding:20px 32px 28px;font-size:12px;color:#a1a1aa;border-top:1px solid #f4f4f5">
      Sent by TableFlow. If you did not expect this email you can safely ignore it.
    </td></tr>
  </table>
</body></html>`
}

/*
 * Every template takes the origin rather than reaching for `appUrl()`.
 *
 * An email is composed where there is no request to read and opened days
 * later, so it has to name the restaurant's own home. Cookies here are
 * host-only: a reset link pointing at the platform address drops somebody on a
 * hostname where their session does not exist, and they cannot tell why.
 *
 * It defaults to `appUrl()`, which is right for anything with no restaurant
 * behind it and keeps every existing caller correct.
 */
export function verificationEmail(name: string, token: string, origin = appUrl()) {
  const href = `${origin}/verify-email?token=${token}`
  return {
    subject: 'Confirm your TableFlow email',
    html: layout(
      'Confirm your email',
      `<p>Hi ${name}, welcome to TableFlow. Confirm your email address to activate your account.</p><p>This link expires in 24 hours.</p>`,
      { label: 'Confirm email', href },
    ),
    text: `Confirm your email: ${href}`,
  }
}

export function passwordResetEmail(name: string, token: string, origin = appUrl()) {
  const href = `${origin}/reset-password?token=${token}`
  return {
    subject: 'Reset your TableFlow password',
    html: layout(
      'Reset your password',
      `<p>Hi ${name}, we received a request to reset your password. This link expires in 1 hour and can be used once.</p><p>If you did not request this, no action is needed.</p>`,
      { label: 'Reset password', href },
    ),
    text: `Reset your password: ${href}`,
  }
}

export function staffInviteEmail(params: {
  name: string
  restaurantName: string
  email: string
  temporaryPassword: string
  role: string
  /** The restaurant's own home, when they have one. */
  origin?: string
}) {
  const href = `${params.origin ?? appUrl()}/login`
  return {
    subject: `You have been added to ${params.restaurantName} on TableFlow`,
    html: layout(
      `Welcome to ${params.restaurantName}`,
      `<p>Hi ${params.name}, an account was created for you as <strong>${params.role}</strong>.</p>
       <p style="background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;padding:14px;font-size:14px">
         <strong>Email:</strong> ${params.email}<br>
         <strong>Temporary password:</strong> <code>${params.temporaryPassword}</code>
       </p>
       <p>Please sign in and change your password right away.</p>`,
      { label: 'Sign in', href },
    ),
    text: `Sign in at ${href} with ${params.email} / ${params.temporaryPassword}`,
  }
}

export function receiptEmail(params: {
  customerName: string
  restaurantName: string
  orderNumber: string
  total: string
  invoiceUrl: string
  rows: Array<{ name: string; qty: number; amount: string }>
}) {
  const rows = params.rows
    .map(
      (row) =>
        `<tr><td style="padding:6px 0">${row.qty} × ${row.name}</td><td style="padding:6px 0;text-align:right">${row.amount}</td></tr>`,
    )
    .join('')

  return {
    subject: `Your receipt from ${params.restaurantName} — ${params.orderNumber}`,
    html: layout(
      'Thanks for dining with us',
      `<p>Hi ${params.customerName}, here is your receipt for order <strong>${params.orderNumber}</strong>.</p>
       <table width="100%" style="font-size:14px;border-collapse:collapse;margin:12px 0">
         ${rows}
         <tr><td style="padding:10px 0 0;border-top:1px solid #e4e4e7;font-weight:700">Total</td>
             <td style="padding:10px 0 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:700">${params.total}</td></tr>
       </table>`,
      { label: 'View invoice', href: params.invoiceUrl },
    ),
    text: `Receipt for ${params.orderNumber}: ${params.total} — ${params.invoiceUrl}`,
  }
}

export function lowStockEmail(params: {
  restaurantName: string
  items: Array<{ name: string; quantity: number; unit: string; reorderLevel: number }>
  origin?: string
}) {
  const rows = params.items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0">${item.name}</td><td style="padding:6px 0;text-align:right;color:#dc2626">${item.quantity} ${item.unit} <span style="color:#a1a1aa">(min ${item.reorderLevel})</span></td></tr>`,
    )
    .join('')

  return {
    subject: `Low stock alert — ${params.items.length} item(s)`,
    html: layout(
      'Low stock alert',
      `<p>The following items at ${params.restaurantName} are at or below their reorder level.</p>
       <table width="100%" style="font-size:14px;border-collapse:collapse;margin:12px 0">${rows}</table>`,
      { label: 'Open inventory', href: `${params.origin ?? appUrl()}/dashboard/inventory` },
    ),
  }
}
