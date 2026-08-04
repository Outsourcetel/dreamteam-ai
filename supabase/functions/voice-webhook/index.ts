/**
 * voice-webhook — where a phone call touches the platform (docs/42 P0 spike).
 *
 * The voice platform (Vapi first) POSTs server messages here:
 *
 *   tool-calls          → the caller asked for something.
 *     take_message      — internal note-taking, like a chat answer: writes
 *                         voice_messages directly, no gate (nothing external
 *                         happens; a human reads it later).
 *     book_appointment  — a STATE CHANGE: routed through connector-hub
 *                         execute_action → decide_action_execution. It is
 *                         destructive-flagged, so it is ALWAYS human-gated —
 *                         the tool result tells the agent to say a colleague
 *                         will confirm. Approval later executes the registered
 *                         executor and produces a receipt. The gate is the
 *                         product; this webhook never bypasses it.
 *
 *   end-of-call-report  → the call becomes a unit of work: an evidence_runs
 *                         row (kind='call') feeding the same performance/
 *                         trust organs as chat, plus an audit-chain entry
 *                         with transcript and recording pointers.
 *
 * Auth: x-voice-secret (same low-privilege secret as voice-turn). Tenant/DE
 * arrive as query params configured per assistant; a suspended workspace
 * records nothing and acts on nothing.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secureEqual } from '../_shared/secureCompare.ts';
import { loadTenantGate } from '../_shared/tenantStatus.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-voice-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

type ToolCall = { id?: string; function?: { name?: string; arguments?: unknown } };

const str = (v: unknown, max = 300) => String(v ?? '').slice(0, max).trim();

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'post_only' }, 405);

  const secret = Deno.env.get('VOICE_GATEWAY_SECRET') ?? '';
  const given = req.headers.get('x-voice-secret') ?? '';
  if (!secret || !(await secureEqual(secret, given))) return json({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenant') ?? '';
  const deId = url.searchParams.get('de') ?? '';
  const connectorId = url.searchParams.get('connector') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(deId)) {
    return json({ error: 'tenant_and_de_required' }, 400);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const message = (body?.message ?? {}) as Record<string, unknown>;
  const msgType = String(message?.type ?? '');
  const call = (message?.call ?? {}) as Record<string, unknown>;
  const callId = str(call?.id ?? '', 80);

  const gate = await loadTenantGate(admin, tenantId);

  // ── tool-calls: the caller asked for something ────────────────────────────
  if (msgType === 'tool-calls') {
    const calls = (message?.toolCallList ?? message?.toolCalls ?? []) as ToolCall[];
    const results: Array<{ toolCallId: string; result: string }> = [];

    for (const tc of calls) {
      const tcId = str(tc?.id ?? '', 80) || 'tool-call';
      const name = str(tc?.function?.name ?? '', 60);
      let args: Record<string, unknown> = {};
      const raw = tc?.function?.arguments;
      if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { args = {}; } }
      else if (raw && typeof raw === 'object') args = raw as Record<string, unknown>;

      if (gate.suspended) {
        results.push({ toolCallId: tcId, result: 'This workspace is not taking requests right now. Ask the caller to try again later.' });
        continue;
      }

      if (name === 'take_message') {
        const text = str(args.message, 1000);
        if (!text) { results.push({ toolCallId: tcId, result: 'No message text was captured — ask the caller to repeat it.' }); continue; }
        const { error } = await admin.from('voice_messages').insert({
          tenant_id: tenantId, de_id: deId, call_id: callId,
          caller_name: str(args.caller_name) || null,
          caller_phone: str(args.caller_phone, 40) || null,
          message: text,
        });
        results.push({
          toolCallId: tcId,
          result: error ? 'The message could not be saved — apologize and offer the direct line.'
                        : 'Message recorded for the team. Tell the caller it has been passed on.',
        });
        continue;
      }

      if (name === 'book_appointment') {
        // Through the gate, exactly like every other external action. The
        // service-role bearer is this project's own key — connector-hub
        // treats it as a service call and requires tenant_id in the body.
        const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'execute_action', tenant_id: tenantId, connector_id: connectorId,
            action_key: 'book_appointment',
            params: {
              caller_name: str(args.caller_name), caller_phone: str(args.caller_phone, 40),
              service: str(args.service), preferred_time: str(args.preferred_time),
            },
            // origin_id is a uuid column; a platform call id only qualifies
            // when it actually is one. The call id always survives in the
            // end-of-call evidence row regardless.
            origin_kind: 'voice_call',
            origin_id: /^[0-9a-f-]{36}$/i.test(callId) ? callId : null,
          }),
        });
        const out = await res.json().catch(() => ({} as Record<string, unknown>));
        const decision = String(out?.decision ?? out?.status ?? '');
        // TRUST THE LEDGER, NOT THE PROSE: a gated reply without an
        // execution_id means the write silently failed (found live 2026-08-04
        // — record_action_execution's error is discarded upstream). Never
        // tell a caller their request is logged when no row exists.
        const persisted = typeof out?.execution_id === 'string' && out.execution_id.length > 0;
        results.push({
          toolCallId: tcId,
          result: decision.startsWith('human_gated') && persisted
            ? 'The appointment request is logged and awaiting confirmation. Tell the caller a colleague will confirm shortly by text or call.'
            : out?.ok === false || !persisted
              ? `The request could not be logged${out?.error ? ` (${str(out?.error, 60)})` : ''} — apologize and take a message instead.`
              : 'The appointment request was recorded. Tell the caller it is being confirmed.',
        });
        continue;
      }

      results.push({ toolCallId: tcId, result: `Unknown tool "${name}" — take a message instead.` });
    }
    return json({ results });
  }

  // ── end-of-call-report: the call becomes a unit of work ───────────────────
  if (msgType === 'end-of-call-report') {
    if (gate.suspended) return json({ ok: true, ignored: 'tenant_suspended' });

    const summary = str(message?.summary, 800) || 'Phone call (no summary provided).';
    const transcript = str(message?.transcript, 8000);
    const recordingUrl = str((message?.recordingUrl ?? (message?.artifact as Record<string, unknown> | undefined)?.recordingUrl), 500);
    const durationSec = Number(message?.durationSeconds ?? 0) || null;
    const customerNumber = str((call?.customer as Record<string, unknown> | undefined)?.number ?? '', 40);

    const { data: run, error } = await admin.from('evidence_runs').insert({
      tenant_id: tenantId, de_id: deId, kind: 'call', work_category: 'support',
      status: 'complete', answer_status: 'answered',
      inquiry: `Phone call${customerNumber ? ` from ${customerNumber}` : ''}`,
      answer: summary,
      steps: [{ step: 'call', call_id: callId, duration_seconds: durationSec, recording_url: recordingUrl || null, transcript_chars: transcript.length }],
      completed_at: new Date().toISOString(),
    }).select('id').single();

    await admin.rpc('append_audit_event', {
      p_tenant_id: tenantId, p_actor: 'Voice channel', p_actor_type: 'de',
      p_action: `Handled a phone call${durationSec ? ` (${Math.round(durationSec)}s)` : ''} — ${summary.slice(0, 140)}`,
      p_category: 'resolved',
      p_detail: {
        kind: 'voice_call_completed', de_id: deId, call_id: callId,
        evidence_run_id: run?.id ?? null, duration_seconds: durationSec,
        recording_url: recordingUrl || null,
        transcript_preview: transcript.slice(0, 1500),
      },
    });
    return json({ ok: !error, evidence_run_id: run?.id ?? null });
  }

  // Anything else (status-update, hang, transfer notifications) is
  // acknowledged and ignored — by design, not by accident.
  return json({ ok: true, ignored: msgType || 'unknown' });
});
