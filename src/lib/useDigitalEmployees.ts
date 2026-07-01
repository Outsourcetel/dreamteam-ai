import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase';
import { writeAuditLog } from '../services/auditLogService';

export interface StoredDE {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'Customer' | 'Internal';
  department: string;
  workspace: string;
  status: 'active' | 'idle' | 'disabled';
  lifecycle_status: string;
  trust_level: 'supervised' | 'established' | 'trusted' | 'autonomous';
  capabilities: string[];
  responsibilities: string[];
  channels: string[];
  knowledgeSources: string[];
  tags: string[];
  confidenceThreshold: number;
  requiredApproval: boolean;
  createdAt: string;
  tasksThisMonth: number;
  successRate: number;
  catalog_id?: string;
  model_provider: string;
  model_id: string;
}

function dbToStored(row: Record<string, unknown>): StoredDE {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    icon: (row.icon as string) ?? 'D',
    category: row.category as 'Customer' | 'Internal',
    department: (row.department as string) ?? '',
    workspace: (row.workspace as string) ?? '',
    status: row.status as 'active' | 'idle' | 'disabled',
    lifecycle_status: (row.lifecycle_status as string) ?? 'designed',
    trust_level: (row.trust_level as StoredDE['trust_level']) ?? 'supervised',
    capabilities: (row.capabilities as string[]) ?? [],
    responsibilities: (row.responsibilities as string[]) ?? [],
    channels: (row.channels as string[]) ?? [],
    knowledgeSources: (row.knowledge_sources as string[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    confidenceThreshold: (row.confidence_threshold as number) ?? 75,
    requiredApproval: (row.required_approval as boolean) ?? false,
    createdAt: row.created_at as string,
    tasksThisMonth: (row.tasks_this_month as number) ?? 0,
    successRate: Number(row.success_rate ?? 100),
    catalog_id: row.catalog_id as string | undefined,
    model_provider: (row.model_provider as string) ?? 'anthropic',
    model_id: (row.model_id as string) ?? 'claude-haiku-4-5-20251001',
  };
}

export function useDigitalEmployees(
  tenantId: string | undefined,
  defaults: StoredDE[],
  actorId?: string
) {
  const [employees, setEmployees] = useState<StoredDE[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) {
      setEmployees(defaults);
      setLoading(false);
      return;
    }
    supabase
      .from('digital_employees')
      .select('*')
      .eq('tenant_id', tenantId)
      .neq('lifecycle_status', 'retired')
      .neq('lifecycle_status', 'archived')
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error('useDigitalEmployees fetch:', error.message);
          setEmployees(defaults);
        } else {
          setEmployees(
            data && data.length > 0
              ? data.map(row => dbToStored(row as Record<string, unknown>))
              : defaults
          );
        }
        setLoading(false);
      });
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const hire = useCallback(
    async (
      de: Omit<StoredDE, 'id' | 'createdAt' | 'tasksThisMonth' | 'successRate'>
    ): Promise<StoredDE | null> => {
      if (!tenantId) {
        const newDE: StoredDE = {
          ...de,
          id: 'de_' + Date.now(),
          createdAt: new Date().toISOString(),
          tasksThisMonth: 0,
          successRate: 100,
        };
        setEmployees(prev => [...prev, newDE]);
        return newDE;
      }

      const { data, error } = await supabase
        .from('digital_employees')
        .insert({
          tenant_id: tenantId,
          catalog_id: de.catalog_id ?? null,
          name: de.name,
          description: de.description,
          icon: de.icon,
          category: de.category,
          department: de.department,
          workspace: de.workspace ?? '',
          status: de.status,
          lifecycle_status: de.lifecycle_status ?? 'designed',
          trust_level: de.trust_level ?? 'supervised',
          capabilities: de.capabilities,
          responsibilities: de.responsibilities ?? [],
          channels: de.channels,
          knowledge_sources: de.knowledgeSources,
          tags: de.tags ?? [],
          confidence_threshold: de.confidenceThreshold,
          required_approval: de.requiredApproval,
        })
        .select()
        .single();

      if (error) {
        console.error('hire DE:', error.message);
        return null;
      }

      const newDE = dbToStored(data as Record<string, unknown>);
      setEmployees(prev => [...prev, newDE]);
      writeAuditLog({
        tenant_id: tenantId, actor_user_id: actorId,
        action: 'hire', entity_type: 'digital_employee',
        entity_id: newDE.id, entity_name: newDE.name,
        after_data: { catalog_id: de.catalog_id, status: de.status },
      });
      return newDE;
    },
    [tenantId, actorId]
  );

  const update = useCallback(
    async (id: string, changes: Partial<StoredDE>) => {
      const dbChanges: Record<string, unknown> = {};
      if (changes.name !== undefined) dbChanges.name = changes.name;
      if (changes.description !== undefined) dbChanges.description = changes.description;
      if (changes.icon !== undefined) dbChanges.icon = changes.icon;
      if (changes.status !== undefined) dbChanges.status = changes.status;
      if (changes.lifecycle_status !== undefined) dbChanges.lifecycle_status = changes.lifecycle_status;
      if (changes.trust_level !== undefined) dbChanges.trust_level = changes.trust_level;
      if (changes.capabilities !== undefined) dbChanges.capabilities = changes.capabilities;
      if (changes.responsibilities !== undefined) dbChanges.responsibilities = changes.responsibilities;
      if (changes.channels !== undefined) dbChanges.channels = changes.channels;
      if (changes.knowledgeSources !== undefined) dbChanges.knowledge_sources = changes.knowledgeSources;
      if (changes.confidenceThreshold !== undefined) dbChanges.confidence_threshold = changes.confidenceThreshold;
      if (changes.requiredApproval !== undefined) dbChanges.required_approval = changes.requiredApproval;
      if (changes.tasksThisMonth !== undefined) dbChanges.tasks_this_month = changes.tasksThisMonth;
      if (changes.successRate !== undefined) dbChanges.success_rate = changes.successRate;
      if (changes.tags !== undefined) dbChanges.tags = changes.tags;
      if (changes.workspace !== undefined) dbChanges.workspace = changes.workspace;
      if (changes.model_provider !== undefined) dbChanges.model_provider = changes.model_provider;
      if (changes.model_id !== undefined) dbChanges.model_id = changes.model_id;

      if (tenantId && Object.keys(dbChanges).length > 0) {
        const { error } = await supabase
          .from('digital_employees')
          .update(dbChanges)
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) console.error('update DE:', error.message);
      }

      setEmployees(prev => prev.map(d => (d.id === id ? { ...d, ...changes } : d)));
    },
    [tenantId]
  );

  const dismiss = useCallback(
    async (id: string) => {
      if (tenantId) {
        const { error } = await supabase
          .from('digital_employees')
          .update({ lifecycle_status: 'retired', status: 'disabled' })
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) {
          console.error('dismiss DE:', error.message);
        } else {
          writeAuditLog({
            tenant_id: tenantId, actor_user_id: actorId,
            action: 'dismiss', entity_type: 'digital_employee', entity_id: id,
          });
        }
      }
      setEmployees(prev => prev.filter(d => d.id !== id));
    },
    [tenantId, actorId]
  );

  const toggleStatus = useCallback(
    async (id: string) => {
      setEmployees(prev => {
        const de = prev.find(e => e.id === id);
        if (!de) return prev;
        const newStatus = de.status === 'active' ? 'idle' : 'active';
        if (tenantId) {
          supabase
            .from('digital_employees')
            .update({ status: newStatus })
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .then(({ error }) => {
              if (error) console.error('toggleStatus DE:', error.message);
            });
        }
        return prev.map(d => (d.id === id ? { ...d, status: newStatus } : d));
      });
    },
    [tenantId]
  );

  return { employees, loading, hire, update, dismiss, toggleStatus };
}
