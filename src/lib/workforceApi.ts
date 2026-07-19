import { supabase } from '../supabase';

export interface WorkforceConversation {
  conversation_id: string;
  tenant_id: string;
  user_id: string;
  de_id: string;
  topic: 'hire' | 'improve' | 'monitor' | 'retire' | 'train';
  status: 'active' | 'decision_pending' | 'completed' | 'archived';
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  context?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkforceAction {
  action_id: string;
  tenant_id: string;
  action_type: 'de_hire' | 'de_amend' | 'de_retire' | 'de_train';
  entity_id: string;
  conversation_id?: string;
  proposal: Record<string, unknown>;
  proposal_rationale?: string;
  approved_by?: string;
  approved_at?: string;
  applied_at?: string;
  result?: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface DEPerformanceSummary {
  de_id: string;
  de_name: string;
  de_status: string;
  current_stage: string;
  time_window_days: number;
  cost_this_month: number;
  responses_this_month: number;
  avg_csat: number;
  escalation_rate: number;
  resolution_rate: number;
  amendments_applied: number;
  training_sessions: number;
  fte_equivalent_cost: number;
  roi_hours_saved: number;
  timestamp: string;
}

export interface AmendmentSuggestion {
  de_id: string;
  de_name: string;
  suggestion: string;
  metric_type: string;
  current_csat: number;
  current_escalation_rate: number;
  confidence_score: number;
  replay_tests_count: number;
  recommendation: 'HIGH' | 'MEDIUM' | 'LOW';
  generated_at: string;
}

/**
 * Send a message to the Workforce Assistant
 */
export async function sendWorkforceMessage(
  tenantId: string,
  message: string,
  conversationId?: string
): Promise<{ conversation_id: string; message: string; topic: string }> {
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workforce-chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: (await supabase.auth.getUser()).data.user?.id,
        conversation_id: conversationId,
        message,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to send message: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Load a conversation's history
 */
export async function loadConversation(conversationId: string): Promise<WorkforceConversation | null> {
  const { data, error } = await supabase
    .from('workforce_conversations')
    .select('*')
    .eq('conversation_id', conversationId)
    .single();

  if (error) {
    console.error('Failed to load conversation:', error);
    return null;
  }

  return data;
}

/**
 * Get all conversations for current user
 */
export async function listUserConversations(
  tenantId: string,
  topic?: string
): Promise<WorkforceConversation[]> {
  let query = supabase
    .from('workforce_conversations')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (topic) {
    query = query.eq('topic', topic);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to list conversations:', error);
    return [];
  }

  return data || [];
}

/**
 * Get DE performance summary
 */
export async function getPerformanceSummary(
  deId: string,
  timeWindowDays: number = 30
): Promise<DEPerformanceSummary | null> {
  const response = await supabase.rpc('get_de_performance_summary', {
    p_de_id: deId,
    p_time_window_days: timeWindowDays,
  });

  if (response.error) {
    console.error('Failed to get performance summary:', response.error);
    return null;
  }

  return response.data;
}

/**
 * Get amendment suggestions for a DE
 */
export async function getAmendmentSuggestions(
  deId: string,
  metricType: 'csat' | 'escalation' | 'cost' | 'performance' = 'csat'
): Promise<AmendmentSuggestion | null> {
  const response = await supabase.rpc('suggest_de_amendments', {
    p_de_id: deId,
    p_metric_type: metricType,
  });

  if (response.error) {
    console.error('Failed to get amendment suggestions:', response.error);
    return null;
  }

  return response.data;
}

/**
 * Approve a pending workforce action (hire, amend, train, retire)
 */
export async function approveWorkforceAction(
  actionId: string,
  rationale?: string
): Promise<{ success: boolean; error?: string }> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) {
    return { success: false, error: 'User not authenticated' };
  }

  const { error } = await supabase
    .from('workforce_actions')
    .update({
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('action_id', actionId);

  if (error) {
    console.error('Failed to approve action:', error);
    return { success: false, error: error.message };
  }

  return { success: true };
}

/**
 * Record training feedback for a DE
 */
export async function recordTrainingFeedback(
  deId: string,
  humanDecision: string,
  feedbackType: 'approval' | 'correction' | 'suggestion',
  correctionDetail?: { from: string; to: string; reasoning?: string },
  replayTest?: boolean
): Promise<{ feedback_id: string; applied_to_charter: boolean; should_promote_stage: boolean }> {
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/de-training-capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
      },
      body: JSON.stringify({
        de_id: deId,
        human_decision: humanDecision,
        feedback_type: feedbackType,
        correction_detail: correctionDetail,
        replay_test: replayTest,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to record training feedback: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Get current deployment stage for a DE
 */
export async function getDeploymentStage(deId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('de_deployment_stages')
    .select('stage')
    .eq('de_id', deId)
    .single();

  if (error) {
    console.error('Failed to get deployment stage:', error);
    return null;
  }

  return data?.stage || null;
}

/**
 * Promote DE to next stage (shadow → co-pilot → live → retired)
 */
export async function promoteDeploymentStage(
  deId: string,
  reason?: string
): Promise<{ success: boolean; new_stage?: string; error?: string }> {
  // Get current stage
  const currentStage = await getDeploymentStage(deId);
  if (!currentStage) {
    return { success: false, error: 'Current stage not found' };
  }

  const stageProgression: Record<string, string> = {
    shadow: 'co-pilot',
    'co-pilot': 'live',
    live: 'retired',
  };

  const newStage = stageProgression[currentStage];
  if (!newStage) {
    return { success: false, error: 'Cannot promote from this stage' };
  }

  const { error } = await supabase
    .from('de_deployment_stages')
    .update({
      stage: newStage,
      stage_promoted_at: new Date().toISOString(),
      promotion_reason: reason,
    })
    .eq('de_id', deId);

  if (error) {
    console.error('Failed to promote stage:', error);
    return { success: false, error: error.message };
  }

  return { success: true, new_stage: newStage };
}

/**
 * Get pending workforce actions for approval
 */
export async function getPendingActions(tenantId: string): Promise<WorkforceAction[]> {
  const { data, error } = await supabase
    .from('workforce_actions')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('approved_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to get pending actions:', error);
    return [];
  }

  return data || [];
}

/**
 * Get all product knowledge (for Workforce Assistant context)
 */
export async function getProductKnowledge(
  topic?: string
): Promise<
  Array<{ topic: string; subtopic: string; title: string; content: string }>
> {
  let query = supabase.from('de_product_knowledge').select('topic, subtopic, title, content');

  if (topic) {
    query = query.eq('topic', topic);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to get product knowledge:', error);
    return [];
  }

  return data || [];
}
