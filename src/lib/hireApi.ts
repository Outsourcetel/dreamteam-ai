// ── The conversational "Hire a Digital Employee" journey ──────────
// One front door that orchestrates engines that already exist:
//   entity-draft   → plain-language brief becomes a configured DE + Deep Study
//   knowledge docs → interview answers become real, embedded grounding
//   playbook-draft → interview answers become a draft procedure
//   de-simulate    → a live, judged rehearsal before anyone trusts it
//   advance_de_lifecycle → promotion as far as the REAL gates allow
// Nothing here bypasses governance — the wizard walks the same gates an
// expert would, and translates whatever still blocks into plain language.
import { supabase } from '../supabase';
import { getSessionTenantId } from './customerApi';
import { createKnowledgeDoc, ingestDocChunks } from './knowledgeApi';
import { draftPlaybookFromSop } from './playbookBuilderApi';

export interface HireStudy {
  coverage: string;
  contradictions: Array<{ role_expects: string; kb_says: string; source_title: string }>;
  questions: string[];
  exam: Array<{ question: string; expected_fragments: string[]; category: string }>;
  bindings: Array<{ title: string }>;
}

export interface HireDraft {
  entity_id: string;
  config: {
    name?: string;
    persona_name?: string;
    description?: string;
    purpose_statement?: string;
    department?: string;
  };
  study: HireStudy;
}

const invokeError = async (fnName: string, error: unknown, data: unknown): Promise<never> => {
  const dataErr = (data as { error?: string } | null)?.error;
  if (dataErr) throw new Error(dataErr);
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const j = (await ctx.json()) as { error?: string };
      if (j?.error) throw new Error(j.error);
    } catch (e) {
      if (e instanceof Error && e.message && !e.message.startsWith('Unexpected')) throw e;
    }
  }
  throw new Error((error as Error | null)?.message || `${fnName} failed`);
};

/** Step 1 — describe the role in plain words, get back a drafted employee
 *  plus its Deep Study of the tenant's real knowledge. */
export async function draftNewHire(brief: string): Promise<HireDraft> {
  const tid = await getSessionTenantId();
  const { data, error } = await supabase.functions.invoke('entity-draft', {
    body: { entity_kind: 'de', brief, ...(tid ? { tenant_id: tid } : {}) },
  });
  if (error || (data as { error?: string })?.error) await invokeError('draftNewHire', error, data);
  const d = data as { entity_id: string; config: HireDraft['config']; study: Partial<HireStudy> };
  return {
    entity_id: d.entity_id,
    config: d.config ?? {},
    study: {
      coverage: String(d.study?.coverage ?? ''),
      contradictions: Array.isArray(d.study?.contradictions) ? d.study.contradictions : [],
      questions: Array.isArray(d.study?.questions) ? d.study.questions.map(String) : [],
      exam: Array.isArray(d.study?.exam) ? d.study.exam : [],
      bindings: Array.isArray(d.study?.bindings) ? d.study.bindings : [],
    },
  };
}

// ── Archetype hire — the SAME DE hire path, from a role template ──────
// Some roles (Renewals, Billing, SDR, CS…) already ship as ROLE ARCHETYPES:
// a proven persona + Book-of-Work watchers + SOP + guardrails + system
// bindings. Hiring one is the ordinary DE hire (instantiate_role_archetype),
// then stamping its kit (install_role_kit) and systems (install_role_systems).
// This is NOT a new entity type — it produces a standard digital_employees
// row that walks the same lifecycle gates as any other hire. The AI-led
// tailoring (P1.2/P1.3) layers on top of this scaffold; nothing replaces it.

export interface RoleArchetype {
  key: string;
  name: string;
  domain: string;
  description: string;
}

/** The catalog of hireable role templates (global; readable by any member). */
export async function listRoleArchetypes(): Promise<RoleArchetype[]> {
  const { data, error } = await supabase
    .from('role_archetypes')
    .select('key, name, domain, description')
    .eq('status', 'active')
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as RoleArchetype[];
}

export interface ArchetypeHireResult {
  deId: string;
  watchersCreated: number;
  guardrailsCreated: number;
  sopPlaybookId: string | null;
  systemsInstalled: number;
}

/** Hire a DE from a role archetype: create it, then stamp its Book of Work,
 *  SOP, guardrails, and system bindings. Reuses three existing RPCs — no new
 *  hire engine. The DE lands at designed/supervised, exactly like any hire. */
export async function hireFromArchetype(
  archetypeKey: string,
  deName: string,
  personaName?: string
): Promise<ArchetypeHireResult> {
  const tid = await getSessionTenantId();
  if (!tid) throw new Error('No tenant found for the current session.');

  // 1. Hire the employee from the archetype (creates the DE).
  const { data: deId, error: e1 } = await supabase.rpc('instantiate_role_archetype', {
    p_tenant_id: tid,
    p_archetype_key: archetypeKey,
    p_de_name: deName,
    p_persona_name: personaName ?? null,
  });
  if (e1 || !deId) throw new Error(e1?.message || 'Could not hire from this archetype.');
  const newDeId = deId as string;

  // 2. Stamp its role kit — Book of Work watchers + published SOP + guardrails.
  const { data: kit, error: e2 } = await supabase.rpc('install_role_kit', {
    p_de_id: newDeId,
    p_archetype_key: archetypeKey,
  });
  if (e2) throw new Error(e2.message);
  const k = (kit ?? {}) as { watchers_created?: number; guardrails_created?: number; sop_playbook_id?: string | null };

  // 3. Register its connected systems (additive — a failure never blocks the hire).
  let systemsInstalled = 0;
  try {
    const { data: sys } = await supabase.rpc('install_role_systems', {
      p_de_id: newDeId,
      p_archetype_key: archetypeKey,
    });
    systemsInstalled = Number(sys) || 0;
  } catch {
    /* systems bindings are additive; the DE exists and is configurable regardless */
  }

  return {
    deId: newDeId,
    watchersCreated: Number(k.watchers_created) || 0,
    guardrailsCreated: Number(k.guardrails_created) || 0,
    sopPlaybookId: k.sop_playbook_id ?? null,
    systemsInstalled,
  };
}

/** The Deep Study's exam becomes the tenant's golden exam for this role, so
 *  the Proving Ground and the certification gate test the RIGHT things.
 *  Best-effort: a failed insert never blocks the hire. */
export async function saveExamAsGolden(exam: HireStudy['exam']): Promise<number> {
  const tid = await getSessionTenantId();
  if (!tid || exam.length === 0) return 0;
  const allowed = new Set(['knowledge', 'procedure', 'guardrail', 'escalation', 'calibration']);
  const rows = exam
    .filter((q) => q.question && Array.isArray(q.expected_fragments) && q.expected_fragments.length > 0)
    .map((q) => ({
      tenant_id: tid,
      question: q.question.slice(0, 1000),
      expected_fragments: q.expected_fragments.map(String).slice(0, 6),
      category: allowed.has(q.category) ? q.category : 'knowledge',
    }));
  if (rows.length === 0) return 0;
  const { error } = await supabase.from('golden_qa').insert(rows);
  return error ? 0 : rows.length;
}

export interface TeachResult {
  knowledgeDocId: string | null;
  embeddedChunks: number;
  playbookName: string | null;
  playbookError: string | null;
}

/** Step 2 — the founder's interview answers become the employee's actual
 *  working material: an embedded knowledge doc (grounds every future answer)
 *  and, when the answers describe how work should be done, a draft playbook. */
export async function teachNewHire(
  deId: string,
  roleName: string,
  brief: string,
  qa: Array<{ question: string; answer: string }>
): Promise<TeachResult> {
  const answered = qa.filter((x) => x.answer.trim().length > 0);
  const out: TeachResult = { knowledgeDocId: null, embeddedChunks: 0, playbookName: null, playbookError: null };
  if (answered.length === 0) return out;

  const body = answered.map((x) => `## ${x.question}\n${x.answer.trim()}`).join('\n\n');
  const doc = await createKnowledgeDoc({
    title: `Hiring interview — ${roleName}`,
    content: `Answers given by the hiring manager while onboarding the "${roleName}" digital employee.\n\n${body}`,
    source: 'paste',
    tags: ['hiring-interview'],
  });
  out.knowledgeDocId = doc.id;
  try {
    const st = await ingestDocChunks(doc.id);
    out.embeddedChunks = st.embedded;
  } catch {
    // The doc exists and is retrievable lexically; embedding backfill
    // (embed-backfill cron) will finish the job — not a hire-blocker.
  }

  // Enough procedural substance → draft a playbook from the same answers.
  const totalChars = answered.reduce((s, x) => s + x.answer.trim().length, 0);
  if (totalChars >= 120) {
    try {
      const sop = `Standard operating procedure for the "${roleName}" role.\n\nRole description: ${brief}\n\nHow the hiring manager wants situations handled:\n${body}`;
      const pb = await draftPlaybookFromSop({ sopText: sop, deId });
      out.playbookName = pb.name;
    } catch (e) {
      out.playbookError = e instanceof Error ? e.message : 'playbook draft failed';
    }
  }
  return out;
}

export interface RehearsalScenario {
  question: string;
  answer: string;
  verdict: string;
  score: number;
  rationale: string;
}
export interface RehearsalResult {
  simRunId: string;
  status: string;
  passed: number;
  total: number;
  avgScore: number;
  scenarios: RehearsalScenario[];
}

/** Step 3 — the live rehearsal: realistic customer questions for this role,
 *  answered by the DE's REAL governed brain, each scored by the judge. */
export async function runRehearsal(deId: string): Promise<RehearsalResult> {
  const tid = await getSessionTenantId();
  const { data, error } = await supabase.functions.invoke('de-simulate', {
    body: { de_id: deId, mode: 'synthetic', count: 4, ...(tid ? { tenant_id: tid } : {}) },
  });
  if (error || (data as { error?: string })?.error) await invokeError('runRehearsal', error, data);
  const d = data as { sim_run_id: string; status: string; passed: number; total: number; avg_score: number };

  let scenarios: RehearsalScenario[] = [];
  const { data: run } = await supabase
    .from('sim_runs')
    .select('results')
    .eq('id', d.sim_run_id)
    .maybeSingle();
  const raw = (run?.results ?? []) as Array<Record<string, unknown>>;
  scenarios = raw.map((r) => ({
    question: String(r.question ?? ''),
    answer: String(r.answer ?? ''),
    verdict: String(r.verdict ?? ''),
    score: Number(r.score) || 0,
    rationale: String(r.rationale ?? ''),
  }));
  return {
    simRunId: d.sim_run_id,
    status: d.status,
    passed: Number(d.passed) || 0,
    total: Number(d.total) || 0,
    avgScore: Number(d.avg_score) || 0,
    scenarios,
  };
}

// Plain-language names for the real lifecycle gate criteria, so a blocked
// promotion reads as a to-do list instead of a JSON blob.
const CRITERIA_LABELS: Record<string, string> = {
  identity_complete: 'Finish its identity (name, description, purpose)',
  control_fabric_grant: 'Give it at least one data-access grant',
  knowledge_in_scope: 'Put at least one knowledge document in its scope',
  active_guardrails: 'Have at least one active guardrail protecting it',
  knowledge_embedded: 'Let its knowledge finish indexing (usually automatic within minutes)',
  golden_qa_passed: 'Pass its golden exam in the Proving Ground',
  certified_by_human: 'A human certifies it after reviewing its test results',
  has_work_channel: 'Connect it to a work channel (chat widget, email, or queue)',
  first_live_execution: 'Complete its first real task under supervision',
};

export interface PromotionOutcome {
  reachedStage: string;
  blockedAt: string | null;
  todo: string[]; // plain-language remaining items for the next stage
  message: string | null;
}

const STAGE_ORDER = ['configured', 'trained', 'tested', 'certified', 'published', 'assigned', 'active'];

/** Step 4 — walk the employee through the REAL lifecycle gates, one stage at
 *  a time, stopping honestly at the first gate that isn't satisfied. */
export async function promoteAsFarAsGatesAllow(deId: string, startStage: string): Promise<PromotionOutcome> {
  let current = startStage;
  // 'designed' is not in STAGE_ORDER (indexOf -1), so -1 + 1 = 0 starts the
  // walk at 'configured' — exactly where a freshly drafted employee begins.
  const startIdx = STAGE_ORDER.indexOf(current) + 1;
  for (let i = Math.max(0, startIdx); i < STAGE_ORDER.length; i++) {
    const target = STAGE_ORDER[i];
    const note = target === 'certified'
      ? 'Certified through the AI hiring flow — live rehearsal answers reviewed by the hiring manager.'
      : null;
    const { data, error } = await supabase.rpc('advance_de_lifecycle', {
      p_de_id: deId, p_to_stage: target, p_note: note,
    });
    if (error) {
      return { reachedStage: current, blockedAt: target, todo: [], message: error.message };
    }
    const res = data as { ok?: boolean; blocked?: boolean; reason?: string; readiness?: { criteria?: Record<string, Record<string, boolean>> } };
    if (res?.blocked) {
      const failing = res.readiness?.criteria?.[target] ?? {};
      const todo = Object.entries(failing)
        .filter(([, ok]) => !ok)
        .map(([key]) => CRITERIA_LABELS[key] ?? key.replace(/_/g, ' '));
      return { reachedStage: current, blockedAt: target, todo, message: null };
    }
    current = target;
  }
  return { reachedStage: current, blockedAt: null, todo: [], message: null };
}

/** Friendly one-liner for where the employee landed. */
export function describeStage(stage: string): string {
  switch (stage) {
    case 'designed': return 'drafted — identity created, not yet configured';
    case 'configured': return 'configured — identity complete';
    case 'trained': return 'trained — has knowledge, access, and guardrails';
    case 'tested': return 'tested — knowledge indexed and exercised';
    case 'certified': return 'certified — passed its exams';
    case 'published': return 'published — approved for assignment';
    case 'assigned': return 'assigned — connected to a work channel';
    case 'active': return 'active — working live';
    default: return stage;
  }
}
