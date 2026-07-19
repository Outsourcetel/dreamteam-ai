/**
 * compute — deterministic calculation tool for DEs. NO model in the loop.
 *
 * Finance/billing/medical-billing roles need numbers that are EXACTLY
 * right, with an audit trail — never an LLM approximation. The reasoning
 * layer calls this to compute, gets back a value + a plain-language
 * receipt it can cite, and the guardrail rule 'require_computed_number'
 * (migration 157) can enforce that any stated number carries such a
 * receipt.
 *
 * Fully self-contained: no API key, no DB, no secrets. Pure arithmetic,
 * so it is 100% testable and identical every run.
 *
 * Operations (POST JSON, one of):
 *   { op:'evaluate', expression:'(100-15)*1.08', vars?:{...} } -> value
 *   { op:'aggregate', fn:'sum|avg|min|max|count', values:[...] }
 *   { op:'apply_rate', amount, rate_pct }        -> amount * rate/100
 *   { op:'percent_of', part, whole }             -> part/whole*100
 *   { op:'round_currency', amount, dp? }
 *   { op:'reconcile', expected, actual, tolerance? } -> {difference, matches}
 * Every response: { ok, value, receipt, steps }.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { secureEqual } from '../_shared/secureCompare.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ── Safe arithmetic evaluator: recursive-descent over + - * / ( ) and
// numbers only. NO eval, NO identifiers, NO function calls — after
// variable substitution the string must contain only [0-9 . + - * / ( )
// eE whitespace], or it's rejected. This cannot execute injected code.
function safeEval(expr: string): number {
  let i = 0;
  const s = expr;
  const peek = () => s[i];
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function parseExpr(): number { // + -
    let v = parseTerm();
    for (;;) { skip(); const c = peek();
      if (c === '+') { i++; v += parseTerm(); }
      else if (c === '-') { i++; v -= parseTerm(); }
      else return v;
    }
  }
  function parseTerm(): number { // * /
    let v = parseFactor();
    for (;;) { skip(); const c = peek();
      if (c === '*') { i++; v *= parseFactor(); }
      else if (c === '/') { i++; const d = parseFactor(); if (d === 0) throw new Error('division by zero'); v /= d; }
      else return v;
    }
  }
  function parseFactor(): number { // number | ( ) | unary -
    skip(); const c = peek();
    if (c === '(') { i++; const v = parseExpr(); skip(); if (peek() !== ')') throw new Error('expected )'); i++; return v; }
    if (c === '-') { i++; return -parseFactor(); }
    if (c === '+') { i++; return parseFactor(); }
    const start = i;
    while (i < s.length && /[0-9.eE]/.test(s[i])) i++;
    const num = Number(s.slice(start, i));
    if (!isFinite(num)) throw new Error(`invalid number near "${s.slice(start, start + 8)}"`);
    return num;
  }
  const v = parseExpr(); skip();
  if (i < s.length) throw new Error(`unexpected "${s[i]}"`);
  return v;
}

const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Service/dispatch callers only (de-work is the sole consumer). No data
  // is at risk here, but an open compute endpoint invites abuse traffic.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
  const authed =
    (serviceKey !== '' && (await secureEqual(bearer, serviceKey))) ||
    (dispatchSecret !== '' && (await secureEqual(headerSecret, dispatchSecret)));
  if (!authed) return json({ error: 'unauthorized' }, 401);

  try {
    const b = await req.json().catch(() => ({}));
    const op = b.op;

    if (op === 'evaluate') {
      let expr = String(b.expression ?? '');
      const vars = (b.vars ?? {}) as Record<string, number>;
      // Substitute named vars (word-boundary) with their numeric value.
      for (const [k, val] of Object.entries(vars)) {
        if (!/^[a-zA-Z_]\w*$/.test(k) || typeof val !== 'number' || !isFinite(val)) {
          return json({ ok: false, error: `invalid var ${k}` }, 400);
        }
        expr = expr.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${val})`);
      }
      if (!/^[-0-9.eE+*/()\s]+$/.test(expr)) {
        return json({ ok: false, error: 'expression contains disallowed characters after substitution' }, 400);
      }
      const value = safeEval(expr);
      return json({ ok: true, value, receipt: `Computed ${b.expression} = ${value}`, steps: [{ expression: expr, value }] });
    }

    if (op === 'aggregate') {
      const vals = (Array.isArray(b.values) ? b.values : []).map(Number);
      if (vals.some((v: number) => !isFinite(v))) return json({ ok: false, error: 'non-numeric value' }, 400);
      const fn = String(b.fn);
      let value: number;
      switch (fn) {
        case 'sum': value = vals.reduce((a: number, c: number) => a + c, 0); break;
        case 'avg': value = vals.length ? vals.reduce((a: number, c: number) => a + c, 0) / vals.length : 0; break;
        case 'min': value = Math.min(...vals); break;
        case 'max': value = Math.max(...vals); break;
        case 'count': value = vals.length; break;
        default: return json({ ok: false, error: `unknown fn ${fn}` }, 400);
      }
      return json({ ok: true, value, receipt: `${fn} of ${vals.length} value(s) = ${value}`, steps: [{ fn, n: vals.length, value }] });
    }

    if (op === 'apply_rate') {
      const amount = Number(b.amount), rate = Number(b.rate_pct);
      if (!isFinite(amount) || !isFinite(rate)) return json({ ok: false, error: 'amount and rate_pct required' }, 400);
      const value = round(amount * rate / 100);
      return json({ ok: true, value, receipt: `${rate}% of ${amount} = ${value}`, steps: [{ amount, rate_pct: rate, value }] });
    }

    if (op === 'percent_of') {
      const part = Number(b.part), whole = Number(b.whole);
      if (!isFinite(part) || !isFinite(whole) || whole === 0) return json({ ok: false, error: 'valid part and non-zero whole required' }, 400);
      const value = round(part / whole * 100);
      return json({ ok: true, value, receipt: `${part} is ${value}% of ${whole}`, steps: [{ part, whole, value }] });
    }

    if (op === 'round_currency') {
      const amount = Number(b.amount); const dp = Number.isInteger(b.dp) ? b.dp : 2;
      if (!isFinite(amount)) return json({ ok: false, error: 'amount required' }, 400);
      const value = round(amount, dp);
      return json({ ok: true, value, receipt: `${amount} rounded to ${dp}dp = ${value}`, steps: [{ amount, dp, value }] });
    }

    if (op === 'reconcile') {
      const expected = Number(b.expected), actual = Number(b.actual);
      const tol = isFinite(Number(b.tolerance)) ? Number(b.tolerance) : 0;
      if (!isFinite(expected) || !isFinite(actual)) return json({ ok: false, error: 'expected and actual required' }, 400);
      const difference = round(actual - expected);
      const matches = Math.abs(difference) <= tol;
      return json({ ok: true, value: difference, matches,
        receipt: `expected ${expected}, actual ${actual} -> diff ${difference} (${matches ? 'within' : 'exceeds'} tolerance ${tol})`,
        steps: [{ expected, actual, difference, tolerance: tol, matches }] });
    }

    return json({ ok: false, error: 'unknown_op' }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 400);
  }
});
