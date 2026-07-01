import { supabase } from '../supabase';
import type { BusinessCapability, RiskLevel, CapabilityStatus } from '../lib/useCapabilities';
import { writeAuditLog } from './auditLogService';

// ── DB type (snake_case) ─────────────────────────────────────

export interface DBCapability {
  id: string;
  tenant_id: string;
  slug: string | null;
  name: string;
  description: string;
  workspace: string;
  icon: string;
  status: CapabilityStatus;
  risk_level: RiskLevel;
  approval_required: boolean;
  inputs: string[];
  outputs: string[];
  required_connectors: string[];
  required_knowledge: string[];
  assigned_des: string[];
  run_count: number;
  avg_confidence: number | null;
  last_run_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── Mapper DB → UI ───────────────────────────────────────────

export function dbToCapability(db: DBCapability): BusinessCapability {
  return {
    id:                 db.id,
    name:               db.name,
    description:        db.description,
    workspace:          db.workspace,
    icon:               db.icon,
    status:             db.status,
    assignedDEs:        db.assigned_des,
    requiredConnectors: db.required_connectors,
    requiredKnowledge:  db.required_knowledge,
    approvalRequired:   db.approval_required,
    riskLevel:          db.risk_level,
    inputs:             db.inputs,
    outputs:            db.outputs,
    runCount:           db.run_count,
    lastRun:            db.last_run_at ? new Date(db.last_run_at).toLocaleString() : undefined,
    avgConfidence:      db.avg_confidence ?? undefined,
    avgHandleTime:      undefined,
  };
}

// ── CRUD ─────────────────────────────────────────────────────

export const fetchCapabilities = async (tenantId: string): Promise<BusinessCapability[]> => {
  const { data, error } = await supabase
    .from('capabilities')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('workspace', { ascending: true })
    .order('name',      { ascending: true });
  if (error) { console.error('fetchCapabilities:', error.message); return []; }
  return (data as DBCapability[]).map(dbToCapability);
};

export const updateCapabilityStatus = async (
  id: string,
  tenantId: string,
  status: CapabilityStatus,
  actorId?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('capabilities')
    .update({ status })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('updateCapabilityStatus:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'update', entity_type: 'capability', entity_id: id,
    after_data: { status },
  });
  return true;
};

export const updateCapabilityApproval = async (
  id: string,
  tenantId: string,
  approvalRequired: boolean,
  actorId?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('capabilities')
    .update({ approval_required: approvalRequired })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('updateCapabilityApproval:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'update', entity_type: 'capability', entity_id: id,
    after_data: { approval_required: approvalRequired },
  });
  return true;
};

export const updateCapabilityRisk = async (
  id: string,
  tenantId: string,
  riskLevel: RiskLevel,
  actorId?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('capabilities')
    .update({ risk_level: riskLevel })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('updateCapabilityRisk:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'update', entity_type: 'capability', entity_id: id,
    after_data: { risk_level: riskLevel },
  });
  return true;
};

export const assignDEsToCapability = async (
  id: string,
  tenantId: string,
  deIds: string[],
  actorId?: string
): Promise<boolean> => {
  const { error } = await supabase
    .from('capabilities')
    .update({ assigned_des: deIds })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) { console.error('assignDEsToCapability:', error.message); return false; }
  writeAuditLog({
    tenant_id: tenantId, actor_user_id: actorId,
    action: 'update', entity_type: 'capability', entity_id: id,
    after_data: { assigned_des: deIds },
  });
  return true;
};
