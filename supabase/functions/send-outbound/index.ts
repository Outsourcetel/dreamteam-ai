/**
 * send-outbound — actually DELIVER an approved outbound email (EXEC 0.4).
 *
 * Until now a DE could draft an outbound message (outbound_drafts, DE-A4) but a
 * human had to copy it and send it by hand. When a human APPROVES an email
 * draft, decideHumanTask calls this to deliver it via Resend, so the employee's
 * voice reaches the customer. Nothing sends without that approval — the draft's
 * human_task must already be 'approved'.
 *
 * DORMANT-HONEST: no RESEND_API_KEY, or no verified from-address for the tenant,
 * → the draft is marked 'blocked_no_provider' and the caller is told plainly.
 * Never a silent failure, never a fabricated send.
 *
 * Auth: caller JWT (the approving user) → tenant; the draft must belong to that
 * tenant and its approval task must be decided 'approved'.
 * POST { draft_id }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/sendEmail.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const draftId = String(body?.draft_id ?? '');
    if (!draftId) return json({ error: 'draft_id_required' }, 400);

    // ── Auth: the approving user. ──
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'unauthorized' }, 401);
    const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
    const tenantId = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, body?.tenant_id);
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // ── Load the draft, scoped to the tenant. ──
    const { data: draft } = await admin.from('outbound_drafts')
      .select('id, tenant_id, de_id, channel, recipient_ref, subject, body, status, delivery_status, human_task_id')
      .eq('id', draftId).eq('tenant_id', tenantId).maybeSingle();
    if (!draft) return json({ error: 'draft_not_found' }, 404);
    if (draft.channel !== 'email') return json({ ok: true, skipped: true, note: `Channel "${draft.channel}" has no automated delivery — deliver it via your own channel.` });
    if (['sent'].includes(draft.delivery_status)) return json({ ok: true, already: 'sent' });

    // ── The approval gate MUST have passed. ──
    if (draft.human_task_id) {
      const { data: task } = await admin.from('human_tasks').select('status').eq('id', draft.human_task_id).maybeSingle();
      if (!task || task.status !== 'approved') return json({ error: 'not_approved', detail: 'This draft has not been approved — it will not be sent.' }, 403);
    }

    // ── From-address. Dormant-honest when it's missing. ──
    const { data: comms } = await admin.from('tenant_comms_settings').select('from_email, from_name').eq('tenant_id', tenantId).maybeSingle();
    if (!comms?.from_email) {
      await admin.rpc('mark_outbound_delivery', { p_draft_id: draftId, p_status: 'blocked_no_provider', p_error: 'no verified from-address' });
      return json({
        ok: false, blocked: true,
        detail: 'Approved, but no from-address is set for this workspace — set one in Settings → Communications. The draft is saved.',
      });
    }
    if (!draft.recipient_ref || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.recipient_ref)) {
      await admin.rpc('mark_outbound_delivery', { p_draft_id: draftId, p_status: 'failed', p_error: 'recipient is not a valid email address' });
      return json({ ok: false, error: 'bad_recipient', detail: 'The draft recipient is not a valid email address.' });
    }

    // ── Send (Gmail SMTP if configured, else Resend). ──
    await admin.rpc('mark_outbound_delivery', { p_draft_id: draftId, p_status: 'sending' });
    const from = comms.from_name ? `${comms.from_name} <${comms.from_email}>` : comms.from_email;
    const sent = await sendEmail(admin, {
      from,
      to: draft.recipient_ref,
      subject: draft.subject || '(no subject)',
      text: draft.body,
    });
    if (sent.reason === 'no_provider') {
      await admin.rpc('mark_outbound_delivery', { p_draft_id: draftId, p_status: 'blocked_no_provider', p_error: 'no email provider configured' });
      return json({
        ok: false, blocked: true,
        detail: 'Approved, but email sending is not connected yet — add Gmail SMTP or a RESEND_API_KEY. The draft is saved.',
      });
    }
    if (!sent.ok) {
      await admin.rpc('mark_outbound_delivery', { p_draft_id: draftId, p_status: 'failed', p_error: String(sent.error ?? 'send_failed').slice(0, 300) });
      return json({ ok: false, error: 'send_failed', detail: sent.error }, 502);
    }
    await admin.rpc('mark_outbound_delivery', { p_draft_id: draftId, p_status: 'sent', p_provider_message_id: sent.messageId ?? null });
    return json({ ok: true, sent: true, provider: sent.provider, provider_message_id: sent.messageId ?? null });
  } catch (err) {
    console.error('send-outbound error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
