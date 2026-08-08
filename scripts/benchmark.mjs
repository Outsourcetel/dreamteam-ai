#!/usr/bin/env node
// ============================================================
// benchmark.mjs — the approve-clean rate, and an honest account of why it is
// not yet readable.
//
// THE NUMBER: of the drafts an employee produces, what fraction does a human
// approve UNTOUCHED? High, and you have an employee. Low, and you have an
// expensive text box with a compliance story. Nothing else about this system —
// not the code quality, not the schema, not the governance — changes that
// answer.
//
//   node scripts/benchmark.mjs            # measure, record a sample
//   node scripts/benchmark.mjs --dry-run  # measure, record nothing
//   node scripts/benchmark.mjs --history  # the accumulated curve
//
// It is READ-ONLY against production except for one INSERT into
// benchmark_samples, which is the ledger the curve lives in.
//
// TWO RULES IT WILL NOT BREAK
//   · It measures the WORK, never an exam. A metric that scores the test
//     instead of the job always closes its own loop and always looks good.
//   · It REFUSES to publish a rate below MIN_N. Three samples is not 67%, it is
//     noise wearing a percentage sign — and a number in a slide deck outlives
//     every caveat attached to it.
// ============================================================
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const HISTORY = process.argv.includes('--history');
const REF = 'rfsvmhcqeiyrxivbmpel';
const WINDOW_DAYS = 90;

// Below this, a percentage is theatre. Set where a single decision cannot swing
// the headline by more than a few points.
const MIN_N = 20;

// Work whose output is TEXT A HUMAN COULD EDIT. An action_approval is a yes/no
// gate on an action — there is nothing to edit, so counting it as "approved
// clean" would inflate the rate with decisions that had no draft in them. That
// inflation is the easiest way to make this number lie.
const DRAFT_SHAPED = ['inquiry_review', 'knowledge_revision', 'improvement_review', 'draft_review'];

function token() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const raw = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const TOKEN = token();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function q(sql, attempt = 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
      await sleep(1500 * (attempt + 1)); return q(sql, attempt + 1);
    }
    throw new Error(`API ${res.status}: ${text.slice(0, 250)}`);
  }
  return JSON.parse(text);
}
const list = (arr) => arr.map((s) => `'${s}'`).join(',');

if (HISTORY) {
  const rows = await q(`select captured_at::date as day, metric, scope, n, numerator, rate
      from benchmark_samples order by captured_at desc limit 40`);
  if (!rows.length) console.log('no samples yet — run the benchmark first');
  else {
    console.log('day         metric                scope   n     clean  rate');
    for (const r of rows) {
      console.log(`${r.day}  ${String(r.metric).padEnd(20)} ${String(r.scope).slice(0, 6).padEnd(7)} `
        + `${String(r.n).padEnd(5)} ${String(r.numerator).padEnd(6)} ${r.rate === null ? '(n too small)' : r.rate + '%'}`);
    }
  }
  process.exit(0);
}

console.log(`approve-clean benchmark — ${WINDOW_DAYS}d window — ${new Date().toISOString()}`);

// ── The measurable path: human_tasks ───────────────────────────────────────
// decide_human_task records decision_edit when the approver actually changed
// the text. An approval with no edit IS a clean approval.
const [overall] = await q(`
  select count(*)::int as n,
         count(*) filter (where status = 'approved' and decision_edit is null)::int as clean,
         count(*) filter (where status = 'approved' and decision_edit is not null)::int as edited,
         count(*) filter (where status = 'rejected')::int as rejected
    from human_tasks
   where decided_at > now() - interval '${WINDOW_DAYS} days'
     and type in (${list(DRAFT_SHAPED)})`);

const rate = overall.n >= MIN_N ? Math.round((overall.clean / overall.n) * 1000) / 10 : null;

console.log(`\n  DRAFT-SHAPED DECISIONS (${DRAFT_SHAPED.join(', ')})`);
console.log(`    decided: ${overall.n}   approved clean: ${overall.clean}   approved w/ edits: ${overall.edited}   rejected: ${overall.rejected}`);
console.log(`    approve-clean rate: ${rate === null
  ? `UNMEASURABLE — only ${overall.n} decision(s), need ${MIN_N}. A rate here would be noise.`
  : `${rate}%`}`);

// ── Why the sample is empty: the queue ─────────────────────────────────────
const queue = await q(`
  select type, count(*)::int as pending
    from human_tasks where status = 'pending'
   group by 1 order by 2 desc`);
const draftPending = queue.filter((r) => DRAFT_SHAPED.includes(r.type)).reduce((a, r) => a + r.pending, 0);
const allPending = queue.reduce((a, r) => a + r.pending, 0);
console.log(`\n  WHY: ${draftPending} draft-shaped task(s) are PENDING, undecided (of ${allPending} total).`);
console.log(`    The rate is not broken — it is UNSAMPLED. Decide some drafts and it appears.`);
for (const r of queue.slice(0, 6)) {
  console.log(`      ${String(r.pending).padStart(4)}  ${r.type}${DRAFT_SHAPED.includes(r.type) ? '   <- draft-shaped' : ''}`);
}

// ── The unmeasurable path, named rather than skipped ───────────────────────
const [support] = await q(`
  select (select count(*)::int from de_messages where delivery = 'draft_pending') as still_draft,
         (select count(*)::int from de_messages where delivery = 'sent')          as sent,
         (select count(*)::int from de_learning_edits)                           as edits`);
console.log(`\n  SUPPORT DRAFT PATH — DENOMINATOR DESTROYED, not merely empty.`);
console.log(`    approve_draft_reply overwrites de_messages.delivery 'draft_pending' -> 'sent',`);
console.log(`    so a message that WAS a draft is indistinguishable from one that never was.`);
console.log(`    sent: ${support.sent}   still pending: ${support.still_draft}   edits recorded: ${support.edits}`);
console.log(`    => edits are countable, clean approvals are NOT. This path cannot report a rate`);
console.log(`       until approval stops erasing the fact that a draft existed.`);

// ── Per-employee, for when there is enough to split ────────────────────────
const perDe = await q(`
  select coalesce(de.name, '(unattributed)') as employee, h.de_id::text as de_id,
         count(*)::int as n,
         count(*) filter (where h.status = 'approved' and h.decision_edit is null)::int as clean
    from human_tasks h left join digital_employees de on de.id = h.de_id
   where h.decided_at > now() - interval '${WINDOW_DAYS} days'
     and h.type in (${list(DRAFT_SHAPED)})
   group by 1, 2 order by 3 desc limit 10`);
if (perDe.length) {
  console.log('\n  PER EMPLOYEE');
  for (const r of perDe) {
    const pct = r.n >= MIN_N ? `${Math.round((r.clean / r.n) * 1000) / 10}%` : `n=${r.n}, too few`;
    console.log(`    ${r.employee.padEnd(28)} ${pct}`);
  }
}

// ── Record the sample ──────────────────────────────────────────────────────
if (!DRY) {
  const detail = JSON.stringify({
    edited: overall.edited, rejected: overall.rejected,
    draft_pending: draftPending, all_pending: allPending,
    support_path: support, min_n: MIN_N, types: DRAFT_SHAPED,
  }).replace(/'/g, "''");
  await q(`insert into benchmark_samples (metric, scope, window_days, n, numerator, rate, detail)
           values ('approve_clean', 'all', ${WINDOW_DAYS}, ${overall.n}, ${overall.clean},
                   ${rate === null ? 'null' : rate}, '${detail}'::jsonb)`);
  const [{ c }] = await q(`select count(*)::int as c from benchmark_samples where metric='approve_clean'`);
  console.log(`\n  sample recorded — ${c} point(s) in the curve. Run with --history to see it.`);
} else {
  console.log('\n  (dry run — no sample recorded)');
}

console.log(rate === null
  ? `\nVERDICT: THE SPINE NUMBER IS STILL UNKNOWN. ${draftPending} drafts are waiting on a human.`
  : `\nVERDICT: approve-clean = ${rate}% over ${overall.n} decisions.`);
