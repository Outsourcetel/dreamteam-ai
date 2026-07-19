// Stream 2: Amendment Metrics API
import { supabase } from '../supabase';

export interface AmendmentMetrics {
  metric_id: string;
  amendment_id: string;
  entity_kind: 'de' | 'playbook' | 'specialist';
  entity_id: string;
  before_metrics: Record<string, any>;
  after_metrics?: Record<string, any>;
  replay_score_before?: number;
  replay_score_after?: number;
  confidence_delta?: number;
  escalation_rate_delta?: number;
  adopted_at?: string;
  created_at: string;
}

export interface AmendmentEffectiveness {
  entity_kind: string;
  entity_id: string;
  total_amendments: number;
  adopted_count: number;
  adoption_rate_pct: number;
  avg_confidence_delta: number;
  avg_escalation_rate_delta: number;
  avg_replay_score_gain: number;
}

export interface AmendmentImpactItem {
  metric_id: string;
  amendment_id: string;
  confidence_delta?: number;
  escalation_rate_delta?: number;
  replay_score_delta: number;
  adopted_at?: string;
  status: 'adopted' | 'pending';
}

export async function recordAmendmentBeforeMetrics(
  amendmentId: string,
  entityKind: 'de' | 'playbook' | 'specialist',
  entityId: string,
  beforeMetrics: Record<string, any>
): Promise<{ ok: boolean; metric_id: string } | null> {
  const { data, error } = await supabase.rpc(
    'record_amendment_before_metrics',
    {
      p_amendment_id: amendmentId,
      p_entity_kind: entityKind,
      p_entity_id: entityId,
      p_before_metrics: beforeMetrics,
    }
  );

  if (error) {
    console.error('Failed to record before metrics:', error);
    return null;
  }

  return data;
}

export async function recordAmendmentAfterMetrics(
  amendmentId: string,
  afterMetrics: Record<string, any>,
  options?: {
    replay_score_before?: number;
    replay_score_after?: number;
    confidence_delta?: number;
    escalation_rate_delta?: number;
  }
): Promise<{ ok: boolean; adopted_at: string } | null> {
  const { data, error } = await supabase.rpc(
    'record_amendment_after_metrics',
    {
      p_amendment_id: amendmentId,
      p_after_metrics: afterMetrics,
      p_replay_score_before: options?.replay_score_before,
      p_replay_score_after: options?.replay_score_after,
      p_confidence_delta: options?.confidence_delta,
      p_escalation_rate_delta: options?.escalation_rate_delta,
    }
  );

  if (error) {
    console.error('Failed to record after metrics:', error);
    return null;
  }

  return data;
}

export async function getAmendmentEffectiveness(
  entityKind: 'de' | 'playbook' | 'specialist',
  entityId: string
): Promise<AmendmentEffectiveness | null> {
  const { data, error } = await supabase.rpc(
    'get_amendment_effectiveness',
    {
      p_entity_kind: entityKind,
      p_entity_id: entityId,
    }
  );

  if (error) {
    console.error('Failed to get amendment effectiveness:', error);
    return null;
  }

  return data;
}

export async function getAmendmentImpactHistory(
  entityKind: 'de' | 'playbook' | 'specialist',
  entityId: string,
  limit: number = 10
): Promise<AmendmentImpactItem[] | null> {
  const { data, error } = await supabase.rpc(
    'get_amendment_impact_history',
    {
      p_entity_kind: entityKind,
      p_entity_id: entityId,
      p_limit: limit,
    }
  );

  if (error) {
    console.error('Failed to get amendment impact history:', error);
    return null;
  }

  return data || [];
}
