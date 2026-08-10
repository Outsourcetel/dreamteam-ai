// ============================================================
// Behavioral proof for the review-minutes editor (migs 691 + 698):
// a real tenant owner — created through the exact public signup
// flow — can override a standard minute, sees the override through
// RLS, and can reset it back to the platform default. The gate and
// validation refusals arrive in the PAYLOAD (the card's contract),
// and this test pins that contract.
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestTenant, TestTenant } from './helpers/testTenant';

describe('review minutes editor (G-D)', () => {
  let owner: TestTenant;

  beforeAll(async () => {
    owner = await createTestTenant('Review Minutes Test');
  }, 30000);

  it('ships the platform defaults, readable through RLS', async () => {
    const { data, error } = await owner.client
      .from('review_time_standards')
      .select('tenant_id, task_type, minutes')
      .is('tenant_id', null);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(11);
  });

  it('lets the owner override a minute and returns the server truth', async () => {
    const { data, error } = await owner.client.rpc('set_review_minutes', {
      p_task_type: 'action_approval', p_minutes: 7,
    });
    expect(error).toBeNull();
    const r = data as { ok: boolean; effective_minutes: number; overridden: boolean };
    expect(r.ok).toBe(true);
    expect(Number(r.effective_minutes)).toBe(7);
    expect(r.overridden).toBe(true);

    // The override row is visible to its own tenant through RLS.
    const { data: mine } = await owner.client
      .from('review_time_standards')
      .select('task_type, minutes, source')
      .eq('tenant_id', owner.tenantId).eq('task_type', 'action_approval');
    expect(mine?.length).toBe(1);
    expect(Number(mine![0].minutes)).toBe(7);
    expect(mine![0].source).toBe('founder');
  });

  it('refuses garbage in the payload, never silently', async () => {
    const { data: badType } = await owner.client.rpc('set_review_minutes', {
      p_task_type: 'not_a_real_type', p_minutes: 5,
    });
    expect((badType as { ok: boolean; error: string }).ok).toBe(false);
    expect((badType as { error: string }).error).toBe('unknown_task_type');

    const { data: badMinutes } = await owner.client.rpc('set_review_minutes', {
      p_task_type: 'escalation', p_minutes: 500,
    });
    expect((badMinutes as { ok: boolean; error: string }).ok).toBe(false);
    expect((badMinutes as { error: string }).error).toBe('minutes_out_of_range');
  });

  it('resets to the platform default and says whether an override existed', async () => {
    const { data } = await owner.client.rpc('clear_review_minutes', {
      p_task_type: 'action_approval',
    });
    const r = data as { ok: boolean; effective_minutes: number; was_overridden: boolean };
    expect(r.ok).toBe(true);
    expect(r.was_overridden).toBe(true);
    expect(Number(r.effective_minutes)).toBe(2);   // the seeded platform default

    const { data: mine } = await owner.client
      .from('review_time_standards')
      .select('task_type')
      .eq('tenant_id', owner.tenantId).eq('task_type', 'action_approval');
    expect(mine ?? []).toEqual([]);
  });
});
