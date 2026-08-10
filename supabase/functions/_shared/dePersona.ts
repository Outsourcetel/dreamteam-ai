/**
 * dePersona — resolves the real, configured identity of the Digital
 * Employee answering a question, for use in an LLM system prompt and
 * in every activity/audit record that names the answering employee.
 *
 * Found during Wave 1.3 ("make the role real"): de-answer and
 * widget-ask both correctly resolve a subjectDeId for KNOWLEDGE
 * SCOPING (migration 030) — but then completely ignore it for the
 * actual persona. Every system prompt hardcoded "You are Alex, a
 * Customer Support Digital Employee", and every activity_events /
 * human_tasks / audit record hardcoded actor 'Alex' — regardless of
 * which DE was actually resolved, what its name/persona_name is, what
 * department it belongs to, or what its founder-authored description
 * says. A tenant whose real answering DE is "Jordan, the Billing
 * Specialist" was still being told they were talking to "Alex".
 *
 * This is intentionally NOT a config-vs-code toggle or a new table —
 * it reads columns that already exist on digital_employees (name,
 * persona_name, description, department, responsibilities), the same
 * discipline as the rest of this codebase: real data already captured
 * at DE-creation time, simply never wired into the one place that
 * actually talks to the customer.
 */
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadTenantBrand, brandVoiceDirective } from './brandIdentity.ts';

export interface DePersona {
  /** Display name to use as the answering actor everywhere (audit,
   *  activity_events, human_tasks, escalation text). Never fabricated —
   *  falls back to an honest generic label when no DE is resolved. */
  name: string;
  /** A short first-person framing line for the system prompt, e.g.
   *  "You are Jordan, the Billing Specialist Digital Employee for
   *  Acme Telecom, responsible for invoicing and payment disputes." */
  preamble: string;
  /** How many prior turns of the thread this employee should see
   *  (digital_employees.context_turns, default 8; 0 = single-turn). */
  contextTurns: number;
}

const FALLBACK_NAME = 'your Digital Employee';

/**
 * HOUSE VOICE — the manner every Digital Employee inherits unless a human
 * writes it one (digital_employees.voice).
 *
 * Founder, after using the live chat: pleasantries "are handled poorly with no
 * sensible conversation". Two of the three causes were structural (no thread
 * history; a sentiment dial wired to nothing). The third is this: the persona
 * told the model WHO it was and never WHO IT SOUNDS LIKE, so it defaulted to
 * support-macro register — restate the question, apologise, offer further
 * assistance, repeat.
 *
 * Written as behaviour to imitate rather than adjectives to satisfy ("be warm
 * and friendly" produces stock warmth). Every clause here governs MANNER only;
 * the grounding rules follow it in the prompt and are unconditional.
 */
export const HOUSE_VOICE = [
  'Write like a capable colleague, not a support macro.',
  'Match the person: brief when they are brief, thorough when they are working something out.',
  'Read what is underneath the words — confusion, frustration, relief, a joke — and let it change how you reply,',
  'in the reply itself. Never announce that you detected a feeling, never narrate their emotional state back to them,',
  'and never open with a stock apology.',
  'Skip the padding: no "Great question!", no restating what they just asked, no "I understand that you...",',
  'no closing offer of further assistance unless it is genuinely the next step.',
  'Vary how you open; do not start consecutive replies the same way.',
  'If they are joking, you are allowed to be light. If they are angry, get shorter and more concrete and drop the pleasantries.',
  'If they thank you, take it gracefully in a few words and stop — do not re-explain what you already said.',
  'You are in a conversation, not a queue of unrelated tickets: refer back to what was already said instead of restarting.',
  'None of this loosens the facts. Manner is yours; every factual claim still comes only from the knowledge documents.',
].join(' ');

/** Mirrors digital_employees.context_turns DEFAULT (mig 325). Used only when
 *  no DE row is resolved — a resolved row always carries its own value. */
const DEFAULT_CONTEXT_TURNS = 8;

/** Wave 5 — the tenant's configured reply language/tone (stored on
 *  tenants.vocabulary as ai_language / ai_tone; both optional). English
 *  and no tone directive when unset — exactly today's behavior. */
async function styleDirective(admin: SupabaseClient, tenantId: string): Promise<string> {
  try {
    // Vocabulary and brand identity are independent reads — parallel, same
    // reason the persona row is (dead air on a phone call is audible).
    const [{ data }, brand] = await Promise.all([
      admin.from('tenants').select('vocabulary').eq('id', tenantId).maybeSingle(),
      loadTenantBrand(admin, tenantId),
    ]);
    const v = (data?.vocabulary ?? {}) as { ai_language?: string; ai_tone?: string };
    const parts: string[] = [];
    if (typeof v.ai_language === 'string' && v.ai_language.trim()) {
      parts.push(` Always reply in ${v.ai_language.trim()}.`);
    }
    if (typeof v.ai_tone === 'string' && v.ai_tone.trim()) {
      parts.push(` Tone of voice: ${v.ai_tone.trim()}.`);
    }
    // Brand identity (mig 666): the company's own voice, sanitized in the
    // helper. Complements HOUSE_VOICE — manner only, grounding untouched.
    const bv = brandVoiceDirective(brand);
    if (bv) parts.push(bv);
    return parts.join('');
  } catch {
    return '';
  }
}

// GI-6b: a candidate persona for DRY-RUN measurement only. These are exactly the
// intersection of resolveDePersona-visible fields ∩ 'de'-amendment-editable
// fields (apply_entity_amendment, mig 211) — so a proposed-persona replay
// measures only what the apply path could actually change. display_title /
// department / responsibilities are NOT amendment-editable, so they are never
// overridden (overriding them would measure a phantom delta).
export interface DePersonaOverrides {
  persona_name?: string | null;
  description?: string | null;
  purpose_statement?: string | null;
}

export async function resolveDePersona(
  admin: SupabaseClient, tenantId: string, deId: string | null, tenantName: string,
  overrides?: DePersonaOverrides | null,
): Promise<DePersona> {
  if (!deId) {
    const style = await styleDirective(admin, tenantId);
    return {
      name: FALLBACK_NAME,
      preamble: `You are a Digital Employee for ${tenantName}. ${HOUSE_VOICE}${style}`,
      contextTurns: DEFAULT_CONTEXT_TURNS,
    };
  }
  // The tenant's style directive and the employee's own row are independent
  // reads. Doing them one after the other cost a whole extra round trip on
  // every answer this platform gives — invisible in chat, audible on a phone
  // call, where it is dead air before the employee speaks.
  const [style, { data: de }] = await Promise.all([
    styleDirective(admin, tenantId),
    admin
      .from('digital_employees')
      .select('name, persona_name, description, department, responsibilities, display_title, purpose_statement, voice, context_turns')
      .eq('id', deId).eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (!de) {
    return {
      name: FALLBACK_NAME,
      preamble: `You are a Digital Employee for ${tenantName}. ${HOUSE_VOICE}${style}`,
      contextTurns: DEFAULT_CONTEXT_TURNS,
    };
  }
  // GI-6b: candidate overrides win when present (dry-run measurement); otherwise
  // the live row is used verbatim — a normal call (overrides undefined) is byte-identical.
  const oPersonaName = overrides?.persona_name ?? de.persona_name;
  const oDescription = overrides?.description ?? de.description;
  const oPurpose = overrides?.purpose_statement ?? de.purpose_statement;
  const name = oPersonaName || de.name || FALLBACK_NAME;
  // Structured identity (DE-C4, migration 130): the founder-authored
  // display_title/purpose_statement lead when present; department is
  // the fallback role line.
  const roleLine = de.display_title
    ? `${de.display_title} — a Digital Employee for ${tenantName}`
    : de.department
      ? `the ${de.department} Digital Employee for ${tenantName}`
      : `a Digital Employee for ${tenantName}`;
  const purpose = oPurpose ? ` ${oPurpose}` : '';
  const responsibilities = Array.isArray(de.responsibilities) && de.responsibilities.length > 0
    ? ` You are responsible for: ${de.responsibilities.slice(0, 8).join('; ')}.`
    : '';
  const description = oDescription ? ` ${oDescription}` : '';
  // Voice: the employee's own if a human wrote one, otherwise the house voice.
  // Placed after identity and before the tenant's language/tone directive, so
  // an explicit ai_tone still has the last word on register.
  const voice = typeof de.voice === 'string' && de.voice.trim() ? de.voice.trim() : HOUSE_VOICE;
  const ct = Number(de.context_turns);
  return {
    name,
    preamble: `You are ${name}, ${roleLine}.${purpose}${responsibilities}${description} ${voice}${style}`,
    contextTurns: Number.isFinite(ct) && ct >= 0 ? Math.min(30, Math.floor(ct)) : DEFAULT_CONTEXT_TURNS,
  };
}
