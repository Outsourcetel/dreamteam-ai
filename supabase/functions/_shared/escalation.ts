/**
 * Generic escalation conditions engine (mig 262) — shared evaluator.
 *
 * Replaces the support-shaped `frustration + keyword` model with composable
 * conditions over an extensible signal catalog. A rule is a set of
 * { signal, op, value } conditions (ANDed or ORed); any rule that matches the
 * context escalates. The SAME engine runs in every context — a support DE
 * composes text/confidence/sentiment conditions on the answer path; a finance
 * DE composes amount/destructive conditions on the action path — because each
 * caller passes whatever signals it has and the evaluator only tests the ones
 * present. Legacy keyword topics + `{ when }` rows still evaluate.
 */

export type EscOp =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq'          // numbers (eq also text)
  | 'contains' | 'not_contains' | 'contains_any' // text
  | 'is_true' | 'is_false';                      // booleans

export interface EscCondition { signal: string; op: EscOp; value: unknown }
export interface EscRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  match?: 'all' | 'any';        // AND (default) / OR across conditions
  conditions?: EscCondition[];
  when?: string;                // legacy: keyword-contains on the message
}
export interface EscRuleset {
  frustration_threshold?: number | null;
  always_escalate_topics?: string[];
  de_rules?: EscRule[];
  tenant_rules?: EscRule[];
}
/** Signals a caller can provide. Absent signals never match — so an
 *  action-only condition is inert on the answer path and vice-versa. */
export type EscContext = Record<string, string | number | boolean | null | undefined>;

export interface EscResult { escalate: boolean; rule?: string; reason?: string }

function num(v: unknown): number { return typeof v === 'number' ? v : Number(v); }
function txt(v: unknown): string { return String(v ?? '').toLowerCase(); }

function evalCondition(c: EscCondition, ctx: EscContext): boolean {
  const actual = ctx[c.signal];
  if (actual === null || actual === undefined) return false; // signal not present here
  switch (c.op) {
    case 'gt':  return num(actual) >  num(c.value);
    case 'gte': return num(actual) >= num(c.value);
    case 'lt':  return num(actual) <  num(c.value);
    case 'lte': return num(actual) <= num(c.value);
    case 'eq':  return txt(actual) === txt(c.value);
    case 'contains':     return txt(actual).includes(txt(c.value));
    case 'not_contains': return !txt(actual).includes(txt(c.value));
    case 'contains_any': return Array.isArray(c.value) && c.value.some((v) => txt(actual).includes(txt(v)));
    case 'is_true':  return actual === true || actual === 'true';
    case 'is_false': return actual === false || actual === 'false';
    default: return false;
  }
}

function evalRule(r: EscRule, ctx: EscContext): boolean {
  // Legacy keyword row: treat `when` as message_text contains.
  const conds: EscCondition[] = (r.conditions && r.conditions.length)
    ? r.conditions
    : (r.when ? [{ signal: 'message_text', op: 'contains', value: r.when }] : []);
  if (!conds.length) return false;
  const results = conds.map((c) => evalCondition(c, ctx));
  return r.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function describeRule(r: EscRule): string {
  if (r.name) return r.name;
  const conds = r.conditions ?? (r.when ? [{ signal: 'message_text', op: 'contains' as EscOp, value: r.when }] : []);
  return conds.map((c) => `${c.signal} ${c.op} ${JSON.stringify(c.value)}`).join(r.match === 'any' ? ' or ' : ' and ');
}

/** Load a DE's full escalation ruleset (legacy frustration/topics + generic
 *  per-DE and tenant-default condition rules). Shared by every enforcement
 *  path so they all read the same rules. `admin` is a service-role client. */
// deno-lint-ignore no-explicit-any
export async function loadEscalationRuleset(admin: any, tenantId: string, deId: string): Promise<EscRuleset> {
  const [escRes, rowsRes] = await Promise.all([
    admin.rpc('resolve_de_escalation', { p_tenant_id: tenantId, p_de_id: deId }),
    admin.from('de_escalation_rules').select('custom_rules, de_id').eq('tenant_id', tenantId),
  ]);
  const esc = Array.isArray(escRes.data) ? escRes.data[0] : escRes.data;
  const rows = (rowsRes.data ?? []) as Array<{ custom_rules?: unknown; de_id: string | null }>;
  const pick = (deScoped: boolean) => rows
    .filter((r) => deScoped ? r.de_id === deId : r.de_id === null)
    .flatMap((r) => Array.isArray(r.custom_rules) ? (r.custom_rules as EscRule[]) : []);
  return {
    frustration_threshold: esc?.frustration_threshold ?? null,
    always_escalate_topics: (esc?.always_escalate_topics ?? []) as string[],
    de_rules: pick(true),
    tenant_rules: pick(false),
  };
}

/** Evaluate a DE's ruleset against the signals available in this context. */
export function evaluateEscalation(ruleset: EscRuleset, ctx: EscContext): EscResult {
  // Legacy always-escalate topics (keyword-contains on the message).
  const topics = ruleset.always_escalate_topics ?? [];
  const msg = ctx.message_text;
  if (msg != null && topics.length) {
    const hit = topics.find((t) => txt(msg).includes(txt(t)));
    if (hit) return { escalate: true, rule: `always-escalate topic "${hit}"`, reason: `the message mentions "${hit}"` };
  }
  // Composable rules — the DE's own first, then tenant defaults.
  const rules = [...(ruleset.de_rules ?? []), ...(ruleset.tenant_rules ?? [])].filter((r) => r && r.enabled !== false);
  for (const r of rules) {
    if (evalRule(r, ctx)) return { escalate: true, rule: describeRule(r), reason: `matched rule "${describeRule(r)}"` };
  }
  return { escalate: false };
}
