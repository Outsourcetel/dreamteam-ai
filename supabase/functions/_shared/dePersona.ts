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

export interface DePersona {
  /** Display name to use as the answering actor everywhere (audit,
   *  activity_events, human_tasks, escalation text). Never fabricated —
   *  falls back to an honest generic label when no DE is resolved. */
  name: string;
  /** A short first-person framing line for the system prompt, e.g.
   *  "You are Jordan, the Billing Specialist Digital Employee for
   *  Acme Telecom, responsible for invoicing and payment disputes." */
  preamble: string;
}

const FALLBACK_NAME = 'your Digital Employee';

export async function resolveDePersona(
  admin: SupabaseClient, tenantId: string, deId: string | null, tenantName: string,
): Promise<DePersona> {
  if (!deId) {
    return {
      name: FALLBACK_NAME,
      preamble: `You are a Digital Employee for ${tenantName}.`,
    };
  }
  const { data: de } = await admin
    .from('digital_employees')
    .select('name, persona_name, description, department, responsibilities')
    .eq('id', deId).eq('tenant_id', tenantId).maybeSingle();
  if (!de) {
    return {
      name: FALLBACK_NAME,
      preamble: `You are a Digital Employee for ${tenantName}.`,
    };
  }
  const name = de.persona_name || de.name || FALLBACK_NAME;
  const roleLine = de.department
    ? `the ${de.department} Digital Employee for ${tenantName}`
    : `a Digital Employee for ${tenantName}`;
  const responsibilities = Array.isArray(de.responsibilities) && de.responsibilities.length > 0
    ? ` You are responsible for: ${de.responsibilities.slice(0, 8).join('; ')}.`
    : '';
  const description = de.description ? ` ${de.description}` : '';
  return {
    name,
    preamble: `You are ${name}, ${roleLine}.${responsibilities}${description}`,
  };
}
