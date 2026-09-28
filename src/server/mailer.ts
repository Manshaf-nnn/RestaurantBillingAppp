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
  const port = Number(process.env.SMTP_PORT ?? 587)
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    // A relay without credentials (a local Mailpit, an IP-allowlisted host)
    // is configured by leaving both blank.
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
      : {}),
    /*
     * Bounded. nodemailer's defaults wait minutes for a silent server, and a
     * password-reset request that waits minutes is one that tells an observer
     * something about the address it was for. Fail in seconds and say so.
     */
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  })
  return transporter
}

export interface MailInput {
  to: string
  subject: string
  html: string
  text?: string
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>
  /**
   * The body carries a secret — a one-time code. When SMTP is not configured
   * the message is normally written to the server log so a developer can
   * follow the link; a code must never be, so only the envelope is logged.
   */
  sensitive?: boolean
}

export interface MailResult {
  sent: boolean
  /** False when no SMTP host is set at all, as opposed to a delivery that failed. */
  configured: boolean
}

/** The address messages come from. `EMAIL_FROM` is accepted as a synonym. */
function fromAddress(): string {
  return process.env.SMTP_FROM || process.env.EMAIL_FROM || 'TableFlow <no-reply@tableflow.app>'
}

type MailTransportForTests = (input: MailInput & { from: string }) => Promise<void>
let testTransport: MailTransportForTests | null = null

/**
 * Swap the real transport for a function, so a test can read what would have
 * been sent — or throw, to stand in for a provider that is down. Passing
 * `null` restores SMTP. Ignored in production.
 */
export function setMailTransportForTests(transport: MailTransportForTests | null): void {
  if (process.env.NODE_ENV === 'production') return
  testTransport = transport
}

export async function sendMail(input: MailInput): Promise<MailResult> {
  const { sensitive: _sensitive, ...message } = input
  void _sensitive
  const envelope = { from: fromAddress(), ...message }

  if (testTransport) {
    try {
      await testTransport({ ...input, from: envelope.from })
      return { sent: true, configured: true }
    } catch (error) {
      console.error('[mail] delivery failed', error instanceof Error ? error.message : error)
      return { sent: false, configured: true }
    }
  }

  const transport = getTransport()
  if (!transport) {
    const body = input.sensitive
      ? '(not logged — the message carries a one-time code)'
      : (input.text ?? input.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500))
    console.info(
      `\n[mail] SMTP not configured — message not sent.\n  To:      ${input.to}\n  Subject: ${input.subject}\n  Text:    ${body}\n`,
    )
    return { sent: false, configured: false }
  }

  try {
    await transport.sendMail(envelope)
    return { sent: true, configured: true }
  } catch (error) {
    // The provider's words, never the message: a failed reset email must not
    // put its code into the log by way of the error.
    console.error('[mail] delivery failed', error instanceof Error ? error.message : String(error))
    return { sent: false, configured: true }
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

/**
 * The forgot-password code (prisma/email.md §5).
 *
 * No name, no link, no origin: the code is typed into the screen that asked
 * for it, so the message does not need to know where that screen lives, and
 * a body with nothing interpolated but six digits has nothing to escape.
 */
export function passwordResetCodeEmail(code: string): Pick<MailInput, 'subject' | 'html' | 'text' | 'sensitive'> {
  return {
    subject: 'Your TableFlow password reset code',
    html: layout(
      'Reset your password',
      `<p>Use this code to reset your TableFlow password:</p>` +
        `<p style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:0.3em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>` +
        `<p>This code expires in 10 minutes.</p>` +
        `<p>If you did not request a password reset, you can ignore this email.</p>`,
    ),
    text: `Use this code to reset your TableFlow password:\n\n${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request a password reset, you can ignore this email.`,
    sensitive: true,
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
