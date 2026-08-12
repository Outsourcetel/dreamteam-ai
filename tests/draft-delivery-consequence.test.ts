// ============================================================
// Behavioral proof for F-6 (docs/50 row 95, docs/53 B-1, migration 721):
// a screen said "Approved and sent." and sent nothing.
//
// THE DEFECT, in production rows, before the fix:
//   human_tasks      b6cd7764…  approved 2026-08-11 20:45
//   de_conversations e3c1dfc6…  still needs_human
//   de_messages      27f98c5a…  still draft_pending
//
// `approve_draft_reply` — the only code in the product that flips a gated
// reply to `sent` — was reachable from ONE screen (the Support inbox). Neither
// decide path called it, so approving from the desktop queue or the phone
// shell recorded the decision, wrote the audit event, closed the task, and
// left the customer's answer undelivered.
//
// ⚠ WHY THIS TEST EXISTS AND NOT JUST THE MIGRATION'S ASSERTS. The migration
// can prove the trigger is ATTACHED. Only a decision driven end to end proves
// the consequence LANDS — and F-6 is exactly the shape where a present
// mechanism and an absent one look identical from the client, because
// PostgREST returns success either way. So every assertion below re-reads the
// row; none of them trusts "the call did not throw".
//
// Runs as a REAL signed-in tenant user against the dev schema-clone, through
// the same `decide_human_task` RPC both surfaces call. No service role, no
// forged auth, no second decision path.
// ============================================================
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, TestTenant } from './helpers/testTenant';

// ⚠ THE FIXTURE IS SEEDED PRIVILEGED, AND THAT IS THE POINT. `authenticated`
// holds no INSERT on de_conversations — measured, not assumed: the first
// version of this test tried and got `permission denied for table
// de_conversations`. That grant is correctly absent. Conversations are created
// by the RUNTIME (widget-ask, email-inbound) under the service role; a human
// only ever DECIDES one. Granting the test user an insert it does not have in
// production would have made the test pass against a perimeter that does not
// exist. So the seed goes through the Management API exactly as the runtime
// would, and the DECISION — the thing under test — is driven by the real
// signed-in user through the RPC both surfaces call.
const DEV_REF = 'nmuntxrcdksyhsdywpan';
function mgmtToken(): string {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in .env.local');
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
async function devSql(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${DEV_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgmtToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`dev sql failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

describe('a decided reply is actually delivered (mig 721)', () => {
  let t: TestTenant;

  /** One gated reply waiting on one conversation, plus the escalation task
   *  the runtime raises beside it — the exact shape widget-ask creates. */
  const seed = async (channel: string, body: string | null) => {
    const rows = await devSql(`
      with c as (
        insert into de_conversations (tenant_id, channel, status)
        values ('${t.tenantId}', '${channel}', 'needs_human') returning id
      ), m as (
        insert into de_messages (tenant_id, conversation_id, role, content, delivery, escalated)
        select '${t.tenantId}', c.id, 'assistant', ${body === null ? 'null' : `'${body.replace(/'/g, "''")}'`}, 'draft_pending', true
          from c where ${body === null ? 'false' : 'true'} returning id
      ), h as (
        insert into human_tasks (tenant_id, type, source, title, detail, related_table, related_id, status)
        select '${t.tenantId}', 'escalation', 'de', 'Reply to approve — ${channel}', 'draft delivery test',
               'de_conversations', c.id, 'pending' from c returning id
      )
      select (select id from c) as conv_id, (select id from m) as msg_id, (select id from h) as task_id`);
    const r = rows[0] as { conv_id: string; msg_id: string | null; task_id: string };
    return { convId: r.conv_id, msgId: r.msg_id, taskId: r.task_id };
  };

  /** ⚠ THE ROW IS THE TRUTH. Never the RPC's return, never the absence of an
   *  error — both were present and cheerful throughout the entire life of the
   *  defect this file exists for. */
  const readBack = async (msgId: string, convId: string) => {
    const { data: m } = await t.client.from('de_messages')
      .select('delivery, content').eq('id', msgId).single();
    const { data: c } = await t.client.from('de_conversations')
      .select('status').eq('id', convId).single();
    return { delivery: m?.delivery as string, content: m?.content as string, convStatus: c?.status as string };
  };

  beforeAll(async () => {
    t = await createTestTenant('Draft Delivery');
  }, 30000);

  afterAll(async () => {
    // Torn down the same way it was seeded. `set_config` because
    // guard_human_task_decision refuses to delete an UNDECIDED task, and the
    // last test's task is deliberately left in whatever state it reached.
    await devSql(`
      select set_config('app.allow_task_decision', 'on', true);
      delete from human_tasks where tenant_id = '${t.tenantId}';
      delete from de_messages where tenant_id = '${t.tenantId}';
      delete from de_conversations where tenant_id = '${t.tenantId}';`).catch(() => { /* dev fixtures */ });
  });

  it('approving a gated reply SENDS it and takes the thread', async () => {
    const { convId, msgId, taskId } = await seed('widget', 'Invoices are issued monthly on the 1st.');

    const before = await readBack(msgId, convId);
    expect(before.delivery).toBe('draft_pending');
    expect(before.convStatus).toBe('needs_human');

    const { error } = await t.client.rpc('decide_human_task', {
      p_task_id: taskId, p_decision: 'approved',
      p_reason_code: null, p_note: null, p_edit: null,
    });
    expect(error).toBeNull();

    const after = await readBack(msgId, convId);
    expect(after.delivery).toBe('sent');
    expect(after.convStatus).toBe('human_owned');
  });

  it('DECLINING the identical shape sends nothing', async () => {
    // The inversion. Without this, the test above passes just as happily
    // against a trigger that fires on every decision — which would be a worse
    // defect than the one it replaced: the person said no and the customer
    // got the answer anyway.
    const { convId, msgId, taskId } = await seed('widget', 'This answer is wrong and must not go out.');

    const { error } = await t.client.rpc('decide_human_task', {
      p_task_id: taskId, p_decision: 'rejected',
      p_reason_code: 'wrong_facts', p_note: null, p_edit: null,
    });
    expect(error).toBeNull();

    const after = await readBack(msgId, convId);
    expect(after.delivery).toBe('draft_pending');
    expect(after.convStatus).toBe('needs_human');
  });

  it('an EMAIL conversation is left to the outbound path, never marked sent', async () => {
    // On email the customer is reached by a carrier, not by this row.
    // Flipping the bubble here would move F-6 one layer down instead of
    // fixing it — the thread would read "sent" with nothing carrying it.
    const { convId, msgId, taskId } = await seed('email', 'Thanks for your email — here is the answer.');

    const { error } = await t.client.rpc('decide_human_task', {
      p_task_id: taskId, p_decision: 'approved',
      p_reason_code: null, p_note: null, p_edit: null,
    });
    expect(error).toBeNull();

    const after = await readBack(msgId, convId);
    expect(after.delivery).toBe('draft_pending');
  });

  it('the approver’s CORRECTION is what gets sent, not the original', async () => {
    const { convId, msgId, taskId } = await seed('hosted', 'Refunds take 30 days.');

    const { error } = await t.client.rpc('decide_human_task', {
      p_task_id: taskId, p_decision: 'approved',
      p_reason_code: 'wrong_facts', p_note: null,
      p_edit: { before: 'Refunds take 30 days.', after: 'Refunds are processed within 5 working days.' },
    });
    expect(error).toBeNull();

    const after = await readBack(msgId, convId);
    expect(after.delivery).toBe('sent');
    expect(after.content).toBe('Refunds are processed within 5 working days.');
  });

  it('a conversation with NO drafted reply is left completely alone', async () => {
    // A guardrail block, or an escalation the employee never answered. There
    // is nothing owed to the customer, so approving must not invent a send
    // and must not quietly claim the thread.
    const { convId, msgId, taskId } = await seed('widget', null);
    expect(msgId).toBeNull();

    const { error } = await t.client.rpc('decide_human_task', {
      p_task_id: taskId, p_decision: 'approved',
      p_reason_code: null, p_note: null, p_edit: null,
    });
    expect(error).toBeNull();

    const { data: after } = await t.client.from('de_conversations')
      .select('status').eq('id', convId).single();
    expect(after?.status).toBe('needs_human');
  });
});
