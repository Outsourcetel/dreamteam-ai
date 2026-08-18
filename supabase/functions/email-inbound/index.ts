/**
 * email-inbound — the inbound EMAIL channel (docs/19 G1).
 *
 * Until now the workforce could only be reached by widget, in-app chat, and
 * internal missions; email — the default mid-market support channel — had no
 * way in (send-outbound only). This closes the loop:
 *
 *   Resend `email.received` webhook  →  verify svix signature
 *   →  fetch the full message from Resend (webhook carries metadata only)
 *   →  resolve tenant from the recipient address
 *   →  find-or-create a de_conversations thread (channel 'email')
 *   →  de-answer (the SAME governed brain as widget/chat: guardrails,
 *      trust-dial floor, escalation rules, budget, metering)
 *   →  confident answer  →  create_outbound_draft (mig 179): approval task,
 *      and on human approve decideHumanTask → send-outbound delivers the
 *      reply via Resend. NOTHING sends without approval — email v1 is
 *      draft-for-approval regardless of a DE's widget reply mode (founder
 *      decision, Human-as-DE program).
 *   →  low confidence / rule / guardrail → de-answer has already escalated
 *      to a human task; no draft is created.
 *
 * Tenant routing (global by design — Always-Live rule): the recipient's
 * local part is matched against tenants.slug (support inbox pattern
 * `<tenant-slug>@<receiving-domain>`), with an optional platform_config
 * INBOUND_EMAIL_MAP JSON `{ "full@address": "tenant-uuid" }` override for
 * pretty addresses.
 *
 * DORMANT-HONEST: no RESEND_INBOUND_SECRET → 503 (webhook can't be
 * trusted); no RESEND_API_KEY → 503 (content can't be fetched). Unroutable
 * or auto-generated mail → 200 ignored (never a retry storm), with the
 * reason logged.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { loadTenantGate } from '../_shared/tenantStatus.ts';
import { classifyAndRoute, chooseAnswerer, triageColumns, NEVER_FRONTS_CUSTOMER_CHAT } from '../_shared/topicRouting.ts';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// ── Svix signature verification (Resend signs webhooks via svix). ──
// signedContent = `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the
// base64 secret (after the whsec_ prefix), compared against any v1 entry.
async function verifySvix(secret: string, id: string, ts: string, sigHeader: string, rawBody: string): Promise<boolean> {
  if (!id || !ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false; // 5-min tolerance
  const secretB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sigHeader.split(' ').some((part) => {
    const [ver, sig] = part.split(',');
    return ver === 'v1' && sig === expected;
  });
}

function parseAddress(raw: unknown): { email: string; name: string | null } {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(.*?)<([^<>@\s]+@[^<>\s]+)>$/);
  if (m) return { email: m[2].toLowerCase(), name: m[1].replace(/["']/g, '').trim() || null };
  const bare = s.match(/[^<>@\s]+@[^<>\s]+/);
  return { email: (bare?.[0] ?? '').toLowerCase(), name: null };
}

// Strip quoted reply chains + signatures so the DE answers the NEW text,
// not the whole thread it already has as conversation history.
function cleanBody(text: string): string {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .{5,80} wrote:\s*$/.test(line)) break;
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim().slice(0, 4000);
}

async function resolveTenant(admin: SupabaseClient, recipients: string[]): Promise<{ tenantId: string | null; via: string }> {
  // 1) Explicit platform override map (pretty addresses → tenant).
  try {
    const mapRaw = await getAIKey(admin, 'INBOUND_EMAIL_MAP');
    if (mapRaw) {
      const map = JSON.parse(mapRaw) as Record<string, string>;
      for (const r of recipients) {
        const hit = map[r] ?? map[r.toLowerCase()];
        if (hit) return { tenantId: hit, via: `map:${r}` };
      }
    }
  } catch { /* malformed map → fall through to slug routing */ }
  // 2) Global convention: local part = tenant slug.
  for (const r of recipients) {
    const local = r.split('@')[0]?.toLowerCase();
    if (!local) continue;
    const { data: t } = await admin.from('tenants').select('id').eq('slug', local).maybeSingle();
    if (t?.id) return { tenantId: t.id, via: `slug:${local}` };
  }
  return { tenantId: null, via: 'none' };
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const rawBody = await req.text();

    // ── Gate 1: the webhook must prove it is Resend. ──
    const inboundSecret = await getAIKey(admin, 'RESEND_INBOUND_SECRET');
    if (!inboundSecret) return json({ error: 'inbound_not_configured', detail: 'RESEND_INBOUND_SECRET is not set — inbound email is dormant.' }, 503);
    const ok = await verifySvix(
      inboundSecret,
      req.headers.get('svix-id') ?? '',
      req.headers.get('svix-timestamp') ?? '',
      req.headers.get('svix-signature') ?? '',
      rawBody,
    );
    if (!ok) return json({ error: 'bad_signature' }, 401);

    const event = JSON.parse(rawBody) as { type?: string; data?: { email_id?: string } };
    if (event?.type !== 'email.received') return json({ ok: true, ignored: event?.type ?? 'unknown_event' });
    const emailId = String(event.data?.email_id ?? '');
    if (!emailId) return json({ ok: true, ignored: 'no_email_id' });

    // ── Fetch the full message (webhook payloads carry metadata only). ──
    const apiKey = await getAIKey(admin, 'RESEND_API_KEY');
    if (!apiKey) return json({ error: 'no_resend_key', detail: 'RESEND_API_KEY is not set — cannot fetch inbound content.' }, 503);
    const emRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!emRes.ok) return json({ error: 'fetch_failed', status: emRes.status }, 502);
    const em = await emRes.json() as {
      from?: string; to?: string[] | string; cc?: string[] | string;
      subject?: string; text?: string; html?: string; message_id?: string;
    };

    const from = parseAddress(em.from);
    const subject = String(em.subject ?? '').slice(0, 200);
    const toList = ([] as string[]).concat(em.to ?? [], em.cc ?? []).map((a) => parseAddress(a).email).filter(Boolean);
    if (!from.email) return json({ ok: true, ignored: 'no_sender' });

    // ── Auto-mail / loop guard: never converse with robots or ourselves. ──
    if (/^(no-?reply|mailer-daemon|postmaster|bounce)[@+.-]/i.test(from.email) || /@.*\.(bounces?|amazonses)\./i.test(from.email)) {
      return json({ ok: true, ignored: 'auto_generated_sender' });
    }

    const { tenantId, via } = await resolveTenant(admin, toList);
    if (!tenantId) {
      console.log(`[email-inbound] unroutable: to=${toList.join(',')} from=${from.email}`);
      return json({ ok: true, ignored: 'no_tenant_for_recipient' });
    }
    // A suspended workspace does no work on inbound mail — no conversation,
    // no answer, no outbound draft, no approval task. Deliberately 200 with a
    // reason (the file's idiom for "not ours") rather than 402: this is a mail
    // provider's webhook, and a non-2xx would just make it retry the same
    // message. The email is not lost — it stays in the customer's own inbox.
    const gate = await loadTenantGate(admin, tenantId);
    if (gate.suspended) return json({ ok: true, ignored: 'tenant_suspended' });

    const { data: comms } = await admin.from('tenant_comms_settings').select('from_email').eq('tenant_id', tenantId).maybeSingle();
    if (comms?.from_email && from.email === String(comms.from_email).toLowerCase()) {
      return json({ ok: true, ignored: 'own_from_address' });
    }

    // ── Idempotency: Resend retries webhooks; one email = one turn. ──
    const { data: seen } = await admin.from('activity_events')
      .select('id').eq('tenant_id', tenantId).eq('event_type', 'email_received')
      .like('text', `%${emailId}%`).limit(1);
    if (seen && seen.length > 0) return json({ ok: true, ignored: 'duplicate_delivery' });

    // ── Front DE for email: same resolution as the public widget. ──
    const { data: frontDes } = await admin.from('digital_employees')
      .select('id, external_reply_mode, created_at').eq('tenant_id', tenantId)
      .not('lifecycle_status', 'in', '(paused,retired,archived,designed)')
      .order('created_at', { ascending: true }).limit(20);
    // ⚠ mig 760: THE MESSAGE IS COMPOSED BEFORE THE CONVERSATION IS CREATED,
    // and that hoist is the whole change on this path. It used to be built two
    // statements AFTER the insert, which made routing on it impossible — you
    // cannot classify a question you have not read yet, and de_id is chosen at
    // INSERT and never moved (moving it would retroactively re-attribute the
    // whole thread; see the migration header). cleanBody is pure, so this is a
    // move and nothing else.
    const bodyText = cleanBody(em.text ?? '') || cleanBody(String(em.html ?? '').replace(/<[^>]+>/g, ' '));
    const question = [subject ? `Subject: ${subject}` : null, bodyText || '(empty message body)'].filter(Boolean).join('\n\n');

    // ── Thread: reuse this sender's open email conversation (14d), else new. ──
    // ⚠⚠⚠ A REUSED THREAD IS NOT RE-ROUTED AND NOT RE-LABELLED — AND THIS
    // LOOKUP HAS MOVED SO THAT SENTENCE IS TRUE. It used to sit BELOW the
    // classification and below `deId`, so the comment describing it was the
    // opposite of what the code did: every inbound mail on an open thread was
    // re-classified, and `deId` — the freshly-routed owner, not the thread's —
    // was what got passed to de-answer AND to create_outbound_draft. Reply two
    // in a fourteen-day thread could therefore be written, charged and drafted
    // by a different employee while de_conversations.de_id still named the
    // first. Topic routing is a decision made once, when the conversation
    // starts; the row is where that decision lives.
    const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
    const { data: openConv } = await admin.from('de_conversations')
      .select('id, de_id').eq('tenant_id', tenantId).eq('channel', 'email').eq('end_user_ref', from.email)
      .not('status', 'in', '(closed,resolved)').gte('last_message_at', cutoff)
      .order('last_message_at', { ascending: false }).limit(1).maybeSingle();

    // ⚠ For email the subject line IS part of what the customer wrote, so it
    // stays in the classified text — unlike the widget's `[channel · display
    // name · account]` tag, which is OURS and is what made "Fireside Media"
    // classify as a safety emergency. `question` is exactly the string
    // de-answer will store as the user message, so the label the customer sees
    // and the text that produced it are the same thing.
    //
    // ⚠ AND IT ONLY RUNS FOR A THREAD THAT DOES NOT EXIST YET. Not "runs and is
    // then ignored" — a reused thread is not classified at all, because the
    // answer is already on the row and the trigger already refuses to overwrite
    // a category.
    const routed = openConv
      ? { triage: null, owner: null }
      : await classifyAndRoute(admin, tenantId, question, 'email');

    // The employee this thread already belongs to, held to the same bar the
    // front desk holds everyone to. A thread whose owner has since been paused,
    // retired, archived or un-published still has to be answered — by today's
    // fallback, never by a classification.
    let threadOwner: { id: string; external_reply_mode: string | null } | null = null;
    if (openConv?.de_id) {
      const { data: recorded } = await admin.from('digital_employees')
        .select('id, external_reply_mode, lifecycle_status')
        .eq('id', openConv.de_id).eq('tenant_id', tenantId).maybeSingle();
      if (recorded && !NEVER_FRONTS_CUSTOMER_CHAT.includes(String(recorded.lifecycle_status))) {
        threadOwner = { id: String(recorded.id), external_reply_mode: recorded.external_reply_mode ?? null };
      }
    }

    const firstDe = chooseAnswerer({
      named: null,           // inbound mail names nobody; the address named the workspace
      thread: threadOwner,
      topic: routed.owner,
      // Unchanged, and it is the branch that actually runs: external_reply_mode
      // is 'draft' on all 109 employees across all 18 tenants, so the `auto`
      // find has never selected anything and `?? frontDes[0]` resolves every
      // time. "No match behaves as today" has to mean this branch.
      fallback: ((f) => (f ? { id: String(f.id), external_reply_mode: f.external_reply_mode ?? null } : null))(
        (frontDes ?? []).find((d) => d.external_reply_mode === 'auto') ?? (frontDes ?? [])[0] ?? null,
      ),
    }).who;
    // ⚠ THE SAME `deId` FLOWS TO BOTH SIDES OF THE HANDOFF — de-answer at the
    // fetch below, and create_outbound_draft's p_de_id further down. On a
    // reused thread it is now the thread's own employee, so the draft a human
    // approves is attributed to whoever the conversation belongs to.
    const deId: string | null = firstDe?.id ?? null;
    if (!deId) return json({ ok: true, ignored: 'no_eligible_de' });

    let convId = openConv?.id ?? null;
    if (!convId) {
      const { data: conv, error: convErr } = await admin.from('de_conversations').insert({
        tenant_id: tenantId, channel: 'email', de_id: deId, subject: subject || '(no subject)',
        end_user_ref: from.email, end_user_name: from.name, last_message_at: new Date().toISOString(),
        // ALL FOUR, together or not at all — see topicRouting.ts's header.
        ...triageColumns(routed.triage),
      }).select('id').single();
      if (convErr || !conv) return json({ error: 'conversation_create_failed', detail: convErr?.message }, 500);
      convId = conv.id;
    }

    // ── The governed brain — identical to widget/chat: guardrails, floors,
    // escalation rules, budget, metering all enforced inside de-answer. ──
    const answerRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/de-answer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenant_id: tenantId, de_id: deId, conversation_id: convId, question }),
    });
    const ans = await answerRes.json().catch(() => ({})) as {
      answer?: string; confidence?: number; needs_escalation?: boolean; blocked?: boolean; error?: string; de_name?: string;
    };

    // ── Disposition. Escalated/blocked → de-answer already raised the human
    // task; the thread sits in the inbox as needs_human. Confident → draft
    // the reply for approval (mig 179 gate → send-outbound on approve). ──
    let disposition = 'escalated_to_human';
    let draftId: string | null = null;
    if (ans.error) {
      disposition = `answer_error:${ans.error}`;
    } else if (!ans.blocked && !ans.needs_escalation && ans.answer) {
      const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject || 'your email'}`;
      const { data: dId, error: draftErr } = await admin.rpc('create_outbound_draft', {
        p_tenant_id: tenantId, p_de_id: deId, p_recipient: from.email,
        p_channel: 'email', p_subject: replySubject.slice(0, 200), p_body: ans.answer,
        p_reason: `Reply to inbound email from ${from.email} (confidence ${ans.confidence ?? '—'}%). Approving sends it via email.`,
        p_source_kind: 'conversation', p_source_ref: convId,
      });
      if (draftErr) disposition = `draft_failed:${draftErr.message}`;
      else {
        disposition = 'reply_drafted_for_approval'; draftId = dId as string | null;
        // The thread must not claim delivery that hasn't happened: de-answer
        // recorded the answer as a normal message, but for email nothing
        // reaches the customer until the draft is approved — flip the bubble
        // to draft_pending so the inbox shows it as awaiting approval.
        const { data: lastMsg } = await admin.from('de_messages')
          .select('id').eq('tenant_id', tenantId).eq('conversation_id', convId).eq('role', 'assistant')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (lastMsg?.id) await admin.from('de_messages').update({ delivery: 'draft_pending' }).eq('id', lastMsg.id);
      }
    }

    await admin.from('activity_events').insert({
      tenant_id: tenantId, actor: ans.de_name ?? 'DE', actor_type: 'de', event_type: 'email_received',
      text: `Inbound email from ${from.email} ("${subject || 'no subject'}") → ${disposition} [resend:${emailId}] routed via ${via}`,
      confidence: ans.confidence ?? null,
    });

    return json({ ok: true, conversation_id: convId, disposition, draft_id: draftId });
  } catch (err) {
    console.error('email-inbound error:', String(err));
    await reportEdgeError('email-inbound', err, {});
    return json({ error: String(err) }, 500);
  }
});
