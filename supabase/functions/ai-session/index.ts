/**
 * ai-session — the conversational working session (Wave 1).
 *
 * Every AI surface in the product was one-shot: "Draft with AI" produced a
 * result and forgot it. This is the durable, multi-turn loop behind
 * "Edit with AI" on a playbook, a DE, or the workspace dock — the user
 * describes what's wrong in plain language and iterates.
 *
 * THE SECURITY MODEL (read before changing anything here):
 *   The model may only NAME a change kind. The database owns the
 *   allow-list (migration 201, ai_change_is_auto_appliable) and rejects
 *   anything else — so no amount of injected text can talk this function
 *   into touching guardrails, trust levels, credentials, publishing, or
 *   anything customer-facing. Those still go through the human-reviewed
 *   amendment path (entity-amend / playbook-amend).
 *
 *   Changes are applied through a USER-SCOPED client, never the service
 *   role, so ai_apply_change() sees the real auth.uid()/auth_tenant_id()
 *   and RLS applies exactly as it would if the human clicked the button.
 *
 * GLOBAL (every tenant), budget-gated + metered, dormant-honest.
 * POST { session_id?, subject_kind, subject_id?, message }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MODEL = 'claude-sonnet-5';
const MAX_TURNS = 4;          // tool round-trips before we stop and answer
const HISTORY_LIMIT = 24;     // messages of context carried forward
const MAX_MESSAGE_CHARS = 4000;

// Mirrors ai_change_is_auto_appliable() in migration 201. Defence in depth:
// the DB is authoritative and will reject anything not on its list, but
// failing here first gives the user a clean message instead of a SQL error.
const AUTO_APPLIABLE = new Set([
  'knowledge.create',
  'knowledge.edit',
  'playbook.draft_steps',
  'de.describe',
]);

const TOOLS = [
  {
    name: 'apply_change',
    description:
      'Apply a low-risk change immediately. The user can undo it for 120 hours. ' +
      'Only these kinds are permitted: knowledge.create (add a knowledge document), ' +
      'knowledge.edit (change a document title/content), playbook.draft_steps (save DRAFT ' +
      'playbook steps — never publishes), de.describe (change a digital employee\'s name, ' +
      'persona_name, description or purpose_statement). Anything else — guardrails, trust ' +
      'levels, credentials, publishing, going live — is NOT available to you; use ' +
      'propose_change for those and explain that a human must approve.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...AUTO_APPLIABLE] },
        target_id: { type: 'string', description: 'UUID of the row to change. Omit for knowledge.create.' },
        patch: { type: 'object', description: 'Only the fields that change.' },
        summary: { type: 'string', description: 'One plain-language sentence for the undo list, e.g. "Added a refund policy document".' },
      },
      required: ['kind', 'patch', 'summary'],
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search this workspace\'s knowledge library so you can ground what you write in what already exists. Use before creating a document, to avoid duplicating one.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'propose_change',
    description:
      'Record a change that you are NOT allowed to apply yourself, so the user can see exactly ' +
      'what you would do and route it for human approval. Use this for anything touching ' +
      'guardrails, trust, credentials, publishing, lifecycle, or customer-facing behaviour.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'The change, in plain language.' },
        why: { type: 'string' },
      },
      required: ['what', 'why'],
    },
  },
];

interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }

async function callModel(
  apiKey: string,
  system: string,
  messages: Array<{ role: string; content: unknown }>,
): Promise<{ blocks: ContentBlock[]; stop: string; inTok: number; outTok: number } | { error: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools: TOOLS, messages }),
  });
  if (!res.ok) return { error: `llm_http_${res.status}` };
  const d = await res.json();
  return {
    blocks: (d.content ?? []) as ContentBlock[],
    stop: String(d.stop_reason ?? ''),
    inTok: Number(d.usage?.input_tokens ?? 0),
    outTok: Number(d.usage?.output_tokens ?? 0),
  };
}

const textOf = (blocks: ContentBlock[]) =>
  blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();

/** Subject context — what the assistant is allowed to see about the thing being edited. */
async function loadSubject(
  admin: SupabaseClient, tenantId: string, kind: string, id: string | null,
): Promise<{ label: string; context: string } | { error: string }> {
  if (kind === 'workspace') {
    const [{ data: des }, { data: pbs }] = await Promise.all([
      admin.from('digital_employees').select('id, name, description, lifecycle_status').eq('tenant_id', tenantId).limit(40),
      admin.from('playbook_definitions').select('id, name, status').eq('tenant_id', tenantId).limit(40),
    ]);
    return {
      label: 'this workspace',
      context:
        `DIGITAL EMPLOYEES:\n${(des ?? []).map((d) => `- ${d.name} (id ${d.id}, ${d.lifecycle_status}) — ${d.description ?? 'no description'}`).join('\n') || '- none yet'}\n\n` +
        `PLAYBOOKS:\n${(pbs ?? []).map((p) => `- ${p.name} (id ${p.id}, ${p.status})`).join('\n') || '- none yet'}`,
    };
  }
  if (kind === 'de') {
    const { data: de } = await admin.from('digital_employees')
      .select('id, name, persona_name, description, purpose_statement, lifecycle_status, external_reply_mode')
      .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!de) return { error: 'de_not_found' };
    return {
      label: `the digital employee "${de.name}"`,
      context:
        `DIGITAL EMPLOYEE (id ${de.id})\n` +
        `name: ${de.name}\npersona_name: ${de.persona_name ?? '—'}\n` +
        `description: ${de.description ?? '—'}\npurpose_statement: ${de.purpose_statement ?? '—'}\n` +
        `lifecycle_status: ${de.lifecycle_status} (you cannot change this)\n` +
        `external_reply_mode: ${de.external_reply_mode} (you cannot change this)`,
    };
  }
  if (kind === 'playbook') {
    const { data: pb } = await admin.from('playbook_definitions')
      .select('id, name, description, status, steps').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
    if (!pb) return { error: 'playbook_not_found' };
    return {
      label: `the playbook "${pb.name}"`,
      context:
        `PLAYBOOK (id ${pb.id})\nname: ${pb.name}\ndescription: ${pb.description ?? '—'}\n` +
        `status: ${pb.status}${pb.status === 'published' ? ' — PUBLISHED, so you may NOT edit its steps; a human must review changes to a live playbook.' : ''}\n` +
        `steps:\n${JSON.stringify(pb.steps ?? [], null, 1).slice(0, 6000)}`,
    };
  }
  return { error: 'bad_subject_kind' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(SUPA_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));

    // ── Auth. User JWT only: this surface WRITES on the user's behalf, so
    // there is deliberately no service-role or dispatch bypass. ──
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'unauthorized' }, 401);
    const userId = u.user.id;

    const { data: prof } = await admin.from('profiles')
      .select('tenant_id, layer').eq('user_id', userId).maybeSingle();
    const tenantId = await resolveTenantWithRemoteAccess(admin, userId, prof?.tenant_id, prof?.layer, body?.tenant_id);
    if (!tenantId) return json({ error: 'no_tenant' }, 403);

    // Remote access (a platform admin operating inside someone else's
    // workspace) resolves a tenant that auth_tenant_id() will NOT agree
    // with, so ai_apply_change would write to the wrong workspace. Rather
    // than widen that RPC's trust boundary, this session degrades to
    // advice-only and says so.
    const canAutoApply = prof?.tenant_id === tenantId;

    const subjectKind = String(body.subject_kind ?? 'workspace');
    if (!['de', 'playbook', 'workspace'].includes(subjectKind)) return json({ error: 'bad_subject_kind' }, 400);
    const subjectId = typeof body.subject_id === 'string' ? body.subject_id : null;
    if (subjectKind !== 'workspace' && !subjectId) return json({ error: 'subject_id required' }, 400);

    const userMessage = String(body.message ?? '').slice(0, MAX_MESSAGE_CHARS).trim();
    if (!userMessage) return json({ error: 'message required' }, 400);

    const apiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'llm_not_configured' }, 503);
    const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budget && budget.allowed === false) return json({ error: 'ai_budget_exceeded' }, 429);

    const subject = await loadSubject(admin, tenantId, subjectKind, subjectId);
    if ('error' in subject) return json({ error: subject.error }, 404);

    // ── Session: reuse or open ──
    let sessionId = typeof body.session_id === 'string' ? body.session_id : null;
    if (sessionId) {
      const { data: s } = await admin.from('ai_sessions')
        .select('id').eq('id', sessionId).eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
      if (!s) return json({ error: 'session_not_found' }, 404);
    } else {
      const { data: s, error } = await admin.from('ai_sessions').insert({
        tenant_id: tenantId, user_id: userId,
        subject_kind: subjectKind, subject_id: subjectId,
        title: userMessage.slice(0, 60),
      }).select('id').single();
      if (error) return json({ error: `session_create: ${error.message}` }, 500);
      sessionId = s.id;
    }

    // ── History ──
    const { data: hist } = await admin.from('ai_session_messages')
      .select('role, content').eq('session_id', sessionId)
      .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
    const history = (hist ?? []).reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: String(m.content) }));

    await admin.from('ai_session_messages').insert({
      session_id: sessionId, tenant_id: tenantId, role: 'user', content: userMessage,
    });

    // ── The loop ──
    const system =
      `You are the Workspace Assistant inside DreamTeam AI, helping a NON-TECHNICAL business user ` +
      `change ${subject.label}. Speak plainly — no jargon, no code, no field names unless the user used them first.\n\n` +
      `You can make low-risk changes yourself with apply_change, and the user can undo any of them for 120 hours. ` +
      `Make the change rather than describing how the user could do it themselves — that is the point of you.\n\n` +
      `You CANNOT change guardrails, trust levels, connector credentials, publishing/going live, lifecycle status, ` +
      `or anything a customer would see. If asked for one of those, use propose_change and explain plainly that ` +
      `a person has to approve it — do not apologise at length, just say who needs to do what.\n` +
      (canAutoApply
        ? ''
        : `\nIMPORTANT: this is a remote-access support session, so you may NOT apply anything. Use propose_change ` +
          `for every change and tell the user it must be applied from their own login.\n`) +
      `\nWhen you change something, say what you changed in one short sentence. Do not restate the whole document back.\n\n` +
      `CURRENT STATE:\n${wrapUntrusted(subject.context, 'workspace-state')}` +
      FIREWALL_RULES;

    const messages: Array<{ role: string; content: unknown }> = [
      ...history,
      { role: 'user', content: userMessage },
    ];

    const applied: Array<Record<string, unknown>> = [];
    const proposed: Array<Record<string, unknown>> = [];
    let inTok = 0, outTok = 0, reply = '';

    // User-scoped client: ai_apply_change() must see the real auth.uid().
    const asUser = createClient(SUPA_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await callModel(apiKey, system, messages);
      if ('error' in r) return json({ error: r.error, session_id: sessionId }, 502);
      inTok += r.inTok; outTok += r.outTok;
      reply = textOf(r.blocks) || reply;

      const toolUses = r.blocks.filter((b) => b.type === 'tool_use');
      if (r.stop !== 'tool_use' || toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: r.blocks });
      const results: Array<Record<string, unknown>> = [];

      for (const t of toolUses) {
        const input = (t.input ?? {}) as Record<string, unknown>;
        let out: Record<string, unknown>;

        if (t.name === 'search_knowledge') {
          const { data: docs } = await admin.from('knowledge_docs')
            .select('id, title')
            .eq('tenant_id', tenantId).eq('is_current', true)
            .textSearch('search_tsv', String(input.query ?? ''), { type: 'websearch' })
            .limit(8);
          out = { results: (docs ?? []).map((d) => ({ id: d.id, title: d.title })) };

        } else if (t.name === 'propose_change') {
          proposed.push({ what: String(input.what ?? ''), why: String(input.why ?? '') });
          out = { recorded: true, note: 'Shown to the user for human approval.' };

        } else if (t.name === 'apply_change') {
          const kind = String(input.kind ?? '');
          if (!canAutoApply) {
            out = { ok: false, error: 'remote_access_session_cannot_apply' };
          } else if (!AUTO_APPLIABLE.has(kind)) {
            // The DB would reject this too; failing here keeps the message clean.
            out = { ok: false, error: 'change_kind_requires_human_review', kind };
          } else {
            const { data: res, error } = await asUser.rpc('ai_apply_change', {
              p_session_id: sessionId,
              p_kind: kind,
              p_target_id: typeof input.target_id === 'string' ? input.target_id : null,
              p_patch: input.patch ?? {},
              p_summary: String(input.summary ?? kind).slice(0, 300),
            });
            if (error) {
              out = { ok: false, error: error.message };
            } else {
              out = res as Record<string, unknown>;
              applied.push({
                change_id: (res as Record<string, unknown>)?.change_id,
                kind,
                summary: String(input.summary ?? kind).slice(0, 300),
                undoable_until: (res as Record<string, unknown>)?.undoable_until,
              });
            }
          }
        } else {
          out = { error: 'unknown_tool' };
        }

        results.push({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!reply) reply = applied.length ? 'Done.' : 'I could not work out a change to make from that — could you say a bit more about what is wrong?';

    await admin.from('ai_session_messages').insert({
      session_id: sessionId, tenant_id: tenantId, role: 'assistant', content: reply,
      meta: { applied, proposed, model: MODEL },
    });
    await admin.from('ai_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);

    // ── Metering ──
    const total = inTok + outTok;
    if (subjectKind === 'de' && subjectId) {
      await admin.rpc('record_de_token_usage', {
        p_tenant_id: tenantId, p_de_id: subjectId, p_model_id: MODEL,
        p_input_tokens: inTok, p_output_tokens: outTok,
      });
    } else {
      await admin.rpc('increment_tenant_token_usage', {
        p_tenant_id: tenantId,
        p_year_month: new Date().toISOString().slice(0, 7),
        p_tokens: total,
      });
    }

    if (applied.length) {
      await admin.rpc('append_audit_event', {
        p_tenant_id: tenantId, p_actor: 'Workspace Assistant', p_actor_type: 'de',
        p_action: `Assistant applied ${applied.length} change${applied.length === 1 ? '' : 's'} in a working session`,
        p_category: 'config_change',
        p_detail: { session_id: sessionId, subject_kind: subjectKind, subject_id: subjectId, applied },
      });
    }

    return json({
      session_id: sessionId,
      reply,
      applied,
      proposed,
      can_auto_apply: canAutoApply,
      tokens: { input: inTok, output: outTok },
    });
  } catch (err) {
    console.error('ai-session error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
