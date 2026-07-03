import { supabase } from '../supabase';

export interface AuditLogEntry {
  tenant_id?: string | null;
  actor_user_id?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  entity_name?: string | null;
  before_data?: Record<string, unknown> | null;
  after_data?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export const writeAuditLog = async (entry: AuditLogEntry): Promise<void> => {
  const { error } = await supabase.from('audit_logs').insert({
    tenant_id:     entry.tenant_id ?? null,
    actor_user_id: entry.actor_user_id ?? null,
    action:        entry.action,
    entity_type:   entry.entity_type,
    entity_id:     entry.entity_id ?? null,
    entity_name:   entry.entity_name ?? null,
    before_data:   entry.before_data ?? null,
    after_data:    entry.after_data ?? null,
    metadata:      entry.metadata ?? {},
  });
  if (error) {
    // Audit log failures are non-fatal — log but never block the user action.
    console.warn('[audit]', error.message);
  }
};
