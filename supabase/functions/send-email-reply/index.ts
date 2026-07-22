/**
 * send-email-reply — a HUMAN's free-form reply on an email conversation,
 * actually delivered (docs/19 G3).
 *
 * The inbox's send_human_reply RPC writes a thread row — which IS delivery
 * for widget/dock (the customer polls the thread), but for channel 'email'
 * the customer would never see it. This sends the reply via Resend first,
 * and only then records it on the thread, so the transcript never claims a
 * delivery that didn't happen. The human is the author AND the approver —
 * no draft gate applies to their own words (same trust model as
 * send_human_reply on chat).
 *
 * DE-drafted email replies do NOT come through here — they stay behind the
 * mig-179 approval gate (approve → send-outbound), whether approved from
 * the Approvals desk or the inbox.
 *
 * Auth: caller JWT → tenant member; conversation must belong to the tenant.
 * POST { conversation_id, content }
 * Dormant-honest: no RESEND_API_KEY or no verified from-address → 409 with
 * a plain explanation, nothing written to the thread.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';
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
    const conversationId = String(body?.conversation_id ?? '');
    const content = String(body?.content ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return json({ error: 'conversation_id_required' }, 400);
    if (!content) return json({ error: 'content_required' }, 400);

    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'unauthorized' }, 401);
    const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
    const tenantId = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, body?.tenant_id);
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    const { data: conv } = await admin.from('de_conversations')
      .select('id, channel, subject, end_user_ref, status')
      .eq('id', conversationId).eq('tenant_id', tenantId).maybeSingle();
    if (!conv) return json({ error: 'conversation_not_found' }, 404);
    if (conv.channel !== 'email') return json({ error: 'not_an_email_conversation', detail: 'Use the regular reply for chat channels — this endpoint only delivers email.' }, 400);
    const recipient = String(conv.end_user_ref ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) return json({ error: 'bad_recipient', detail: 'This conversation has no valid customer email address.' }, 400);

    const apiKey = await getAIKey(admin, 'RESEND_API_KEY');
    const { data: comms } = await admin.from('tenant_comms_settings').select('from_email, from_name').eq('tenant_id', tenantId).maybeSingle();
    if (!apiKey || !comms?.from_email) {
      return json({
        error: 'delivery_not_configured', blocked: true,
        detail: !apiKey
          ? 'Email sending is not connected — add a RESEND_API_KEY in Settings. Your reply was NOT sent.'
          : 'No verified from-address is set for this workspace — set one in Settings → Communications. Your reply was NOT sent.',
      }, 409);
    }

    // ── Deliver FIRST; the thread only records what really happened. ──
    const subject = conv.subject && /^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject || 'your email'}`;
    const from = comms.from_name ? `${comms.from_name} <${comms.from_email}>` : comms.from_email;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [recipient], subject: subject.slice(0, 200), text: content }),
    });
    const rBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json({ error: 'send_failed', detail: (rBody as { message?: string })?.message ?? `resend_http_${res.status}` }, 502);
    }

    const { data: msg } = await admin.from('de_messages').insert({
      tenant_id: tenantId, conversation_id: conversationId, role: 'assistant',
      content, confidence: 100, escalated: false, delivery: 'sent',
    }).select('id').single();
    await admin.from('de_conversations').update({
      owner_user_id: u.user.id, status: 'human_owned', last_message_at: new Date().toISOString(),
    }).eq('id', conversationId).eq('tenant_id', tenantId);
    await admin.from('activity_events').insert({
      tenant_id: tenantId, actor: 'You', actor_type: 'human', event_type: 'email_sent',
      text: `Replied by email to ${recipient} ("${subject.slice(0, 80)}")`,
    });

    return json({ ok: true, sent: true, message_id: msg?.id ?? null, provider_message_id: (rBody as { id?: string })?.id ?? null });
  } catch (err) {
    console.error('send-email-reply error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
