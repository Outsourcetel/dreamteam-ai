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

/** ── 778: a headline from the employee's own account of why it stopped ────
 *
 *  ⚠ THE AUTHORITY FOR THIS RULE IS SQL, NOT THIS FILE.
 *  `public.de_escalation_headline(text, integer)` (migration 778) is what runs
 *  on the fallback path and what rebuilt the 42 rows already in the queue.
 *  This is the client-side twin so that de-work's `escalate_to_human` never
 *  passes a null title in the first place. The two are pinned to the SAME
 *  seven fixtures — the SQL ones live in migration 778's PROBE 1, the TS ones
 *  in tests/escalation-headline.test.ts — so a divergence turns one of them
 *  red rather than quietly producing two different titles for one input.
 *
 *  Two branches, both of which cut only where a WORD ends:
 *   (a) the first COMPLETE sentence, if one ends inside the budget. A
 *       terminator counts only when >= 3 alphanumerics run up to it (through
 *       one optional closing bracket or quote) AND whitespace or end-of-text
 *       follows. Three alphanumerics rejects "vs.", "e.g." and "No."; the
 *       whitespace requirement rejects every decimal point, because "439.3k"
 *       has no space after its dot.
 *   (b) otherwise truncate on a SPACE, never on punctuation. Splitting on '.'
 *       is what produced "Ledger does not balance (debits PKR 322k vs" and
 *       "...both exceed the $10,000" — headlines cut mid-figure.
 *
 *  Returns null when there is nothing to derive from, so the caller (and, on
 *  the SQL side, the ladder) decides what to do with an employee that said
 *  nothing — which is a different question from how to shorten a sentence.
 */
export function escalationHeadline(text: string | null | undefined, limit = 120): string | null {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const lim = Math.max(24, Math.min(limit, 300));

  const sentence = s.match(/^(.{20,}?[\p{L}\p{N}]{3}[)\]"']?)[.!?](\s|$)/u);
  if (sentence && sentence[1].length <= lim) return sentence[1];

  if (s.length <= lim) return s;
  let cut = s.slice(0, lim).replace(/\s+\S*$/, '');
  if (!cut.trim()) cut = s.slice(0, lim);          // one word longer than lim
  cut = cut.replace(/\s*\((\d{1,2}|[a-z])\)$/, ''); // no dangling "(2)"
  cut = cut.replace(/[\s,;:./&(…–—-]+$/, '');       // no dangling joiner
  if (!cut.trim()) return null;
  return cut + '…';
}

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
  // The frustration dial. It was loaded here from day one and never tested
  // against anything, because nothing on the answer path computed a sentiment
  // value — a control visible in the UI that governed nothing. The answer
  // paths now supply `sentiment` from the employee's own read of the thread
  // (see _shared/conversation.ts), so the dial finally means what it says.
  // Absent sentiment (action path, or a model that omitted it) => inert.
  const thr = ruleset.frustration_threshold;
  if (thr != null && ctx.sentiment != null && Number.isFinite(num(ctx.sentiment)) && num(ctx.sentiment) >= num(thr)) {
    return {
      escalate: true,
      rule: `frustration threshold (${thr})`,
      reason: `the person reads as needing a human (${num(ctx.sentiment)} vs threshold ${thr})`,
    };
  }
  // Composable rules — the DE's own first, then tenant defaults.
  const rules = [...(ruleset.de_rules ?? []), ...(ruleset.tenant_rules ?? [])].filter((r) => r && r.enabled !== false);
  for (const r of rules) {
    if (evalRule(r, ctx)) return { escalate: true, rule: describeRule(r), reason: `matched rule "${describeRule(r)}"` };
  }
  return { escalate: false };
}
