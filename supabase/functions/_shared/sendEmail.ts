/**
 * sendEmail — one place both send-outbound and send-email-reply deliver mail.
 *
 * Provider is chosen by what's configured, checked in order:
 *   1. Gmail SMTP  — GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD present.
 *      Free, sends AS the authenticated Google Workspace mailbox (e.g.
 *      bkhan@outsourcetel.com). The `from` address MUST be that mailbox or a
 *      Gmail "Send mail as" alias, or Google rejects it. Best for a single
 *      org's own outbound (the pilot); NOT a multi-tenant answer — a customer
 *      tenant can't send as someone else's Google mailbox.
 *   2. Resend  — RESEND_API_KEY present. Per-tenant domain verification; the
 *      general multi-tenant path.
 *   3. Neither → { ok:false, reason:'no_provider' } so callers can stay
 *      dormant-honest.
 *
 * SMTP egress from Supabase edge to smtp.gmail.com:465/587 was probed live
 * and works (220 greeting), so this path is real, not aspirational.
 */
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { getAIKey } from './aiKeys.ts';
// deno-lint-ignore no-explicit-any
type Admin = any;

export interface SendEmailInput {
  from: string;       // "Name <addr>" or "addr" — the From header
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}
export interface SendEmailResult {
  ok: boolean;
  provider?: 'gmail_smtp' | 'resend';
  messageId?: string | null;
  error?: string;
  reason?: 'no_provider';
}

export async function sendEmail(admin: Admin, input: SendEmailInput): Promise<SendEmailResult> {
  // ── 1. Gmail SMTP (free, sends as the org mailbox) ──
  const gmailUser = await getAIKey(admin, 'GMAIL_SMTP_USER');
  const gmailPass = await getAIKey(admin, 'GMAIL_SMTP_APP_PASSWORD');
  if (gmailUser && gmailPass) {
    let client: SMTPClient | null = null;
    try {
      client = new SMTPClient({
        connection: {
          hostname: 'smtp.gmail.com',
          port: 465,
          tls: true,
          auth: { username: gmailUser, password: gmailPass.replace(/\s+/g, '') }, // app passwords are shown with spaces
        },
      });
      await client.send({
        from: input.from,
        to: input.to,
        subject: input.subject,
        content: input.text,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      await client.close();
      return { ok: true, provider: 'gmail_smtp', messageId: null };
    } catch (e) {
      try { await client?.close(); } catch { /* ignore */ }
      return { ok: false, provider: 'gmail_smtp', error: String(e).slice(0, 300) };
    }
  }

  // ── 2. Resend (per-tenant domain, multi-tenant path) ──
  const resendKey = await getAIKey(admin, 'RESEND_API_KEY');
  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      return { ok: false, provider: 'resend', error: String((body as { message?: string })?.message ?? `resend_http_${res.status}`).slice(0, 300) };
    }
    return { ok: true, provider: 'resend', messageId: (body as { id?: string })?.id ?? null };
  }

  // ── 3. Nothing configured ──
  return { ok: false, reason: 'no_provider' };
}
