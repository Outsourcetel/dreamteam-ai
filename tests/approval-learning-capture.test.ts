// ============================================================
// Behavioral proof for the approve-WITH-EDITS learning loop
// (docs/34, migrations 455-456): a real signed-in tenant user
// decides a real human_task through decide_human_task and the
// (before, after) pair actually lands in decision_edit — plus
// the two contracts the client depends on: NULL on an already-
// decided task (the double-charge guard) and reason-required on
// rejection. Runs against the dev schema-clone via .env.test,
// exactly like tenant-isolation.test.ts — no service role, no
// forged auth.
// ============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, TestTenant } from './helpers/testTenant';

describe('approval learning capture (decide_human_task)', () => {
  let t: TestTenant;

  const mkTask = async (title: string): Promise<{ id: string }> => {
    const { data, error } = await t.client
      .from('human_tasks')
      .insert({ tenant_id: t.tenantId, type: 'approval_gate', title, detail: 'capture test', source: 'system', status: 'pending' })
      .select('id')
      .single();
    if (error) throw new Error(`task insert failed: ${error.message}`);
    return data;
  };

  beforeAll(async () => {
    t = await createTestTenant('Approval Capture');
  }, 30000);

  afterAll(async () => {
    await t.client.from('human_tasks').delete().eq('tenant_id', t.tenantId);
  });

  it('approve-with-edits lands the (before, after) pair in decision_edit', async () => {
    const task = await mkTask('Edit capture');
    const edit = {
      before: 'Dear customer, your ticket has been closed.',
      after: 'Hi Sam — the API auth failure is fixed, so I’m closing your ticket. Reply here if it recurs.',
    };
    const { data, error } = await t.client.rpc('decide_human_task', {
      p_task_id: task.id,
      p_decision: 'approved',
      p_reason_code: 'wrong_tone',
      p_note: 'Use the customer’s name and say what was actually fixed.',
      p_edit: edit,
    });
    expect(error).toBeNull();
    const row = data as { status: string; decision_edit: unknown; decision_reason_code: string | null };
    expect(row.status).toBe('approved');
    expect(row.decision_edit).toEqual(edit);
    expect(row.decision_reason_code).toBe('wrong_tone');

    // The pair must survive a read-back through RLS as the tenant's own user
    // — returning it from the RPC and then losing it on the row would still
    // satisfy the assertion above.
    const { data: read, error: readErr } = await t.client
      .from('human_tasks')
      .select('status, decision_edit, decision_reason_code, decision_note')
      .eq('id', task.id)
      .single();
    expect(readErr).toBeNull();
    expect(read?.decision_edit).toEqual(edit);
    expect(read?.decision_reason_code).toBe('wrong_tone');
  });

  it('a clean approval needs no reason and stores no edit', async () => {
    const task = await mkTask('Clean approval');
    const { data, error } = await t.client.rpc('decide_human_task', {
      p_task_id: task.id, p_decision: 'approved',
    });
    expect(error).toBeNull();
    const row = data as { status: string; decision_edit: unknown; decision_reason_code: string | null };
    expect(row.status).toBe('approved');
    expect(row.decision_edit).toBeNull();
    expect(row.decision_reason_code).toBeNull();
  });

  it('returns NULL on an already-decided task — the guard the side-effect hooks rely on', async () => {
    const task = await mkTask('Idempotency');
    const first = await t.client.rpc('decide_human_task', { p_task_id: task.id, p_decision: 'approved' });
    expect(first.error).toBeNull();
    expect((first.data as { id: string | null }).id).toBe(task.id);
    // ⚠ Measured here first: PostgREST serializes the RPC's NULL composite as
    // a row of ALL-NULL columns, NOT JSON null — `if (!data)` never fires.
    // The client therefore guards on `data.id == null` before running any
    // side-effect hook (invoice send, gated-action execute, email delivery);
    // this asserts the exact signal that guard depends on.
    const second = await t.client.rpc('decide_human_task', { p_task_id: task.id, p_decision: 'approved' });
    expect(second.error).toBeNull();
    expect((second.data as { id: string | null } | null)?.id ?? null).toBeNull();
  });

  it('refuses a rejection without a reason code', async () => {
    const task = await mkTask('Reason required');
    const { error } = await t.client.rpc('decide_human_task', { p_task_id: task.id, p_decision: 'rejected' });
    expect(error?.message ?? '').toContain('reason_required');
  });

  it('refuses an edit carrying only half of the pair (shape check)', async () => {
    const task = await mkTask('Shape check');
    const { error } = await t.client.rpc('decide_human_task', {
      p_task_id: task.id, p_decision: 'approved', p_edit: { after: 'only the correction' },
    });
    expect(error).not.toBeNull();
  });
});
