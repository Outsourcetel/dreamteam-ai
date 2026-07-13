// ============================================================
// Tenant status gate — the real teeth behind trial expiry / suspension.
//
// expire_trials() (migration 086) flips status 'trial' → 'suspended' when
// trial_ends_at passes, and a platform admin can suspend a tenant manually.
// Until now nothing HONORED that flag: a suspended tenant's DEs kept
// answering and spending paid tokens. Every paid-work entry point resolves
// the tenant, then calls loadTenantGate() and refuses when suspended —
// BEFORE any LLM spend or conversation write.
//
// Deliberately gates only status='suspended'. 'trial' and 'active' both
// pass (a trial is a paying-in-waiting customer, not a blocked one). Demo
// tenants are 'active' and unaffected.
// ============================================================

export interface TenantGate {
  name: string;
  status: string;
  suspended: boolean;
}

// deno-lint-ignore no-explicit-any
export async function loadTenantGate(admin: any, tenantId: string): Promise<TenantGate> {
  const { data } = await admin.from('tenants').select('name, status').eq('id', tenantId).single();
  const status = data?.status ?? 'active';
  return {
    name: data?.name ?? 'your company',
    status,
    suspended: status === 'suspended',
  };
}

// Honest, owner-actionable message. HTTP 402 (Payment Required) is the
// correct status for an expired trial / paused billing.
export const TENANT_SUSPENDED_BODY = {
  error: 'tenant_suspended',
  detail: 'This workspace is suspended — its trial has ended or billing is paused. An owner can reactivate it from Settings, or contact support@outsourcetel.com.',
};
