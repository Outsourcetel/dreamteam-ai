// Stream 1: Sophie Configuration UI API
import { supabase } from '../supabase';

export interface ConfigValue {
  refund_limit?: number;
  escalation_rules?: Array<{ condition: string; action: string }>;
  preapproval_strategy?: 'all' | 'rule_based' | 'never';
  knowledge_sources?: string[];
  escalation_sla_minutes?: number;
  reply_mode_enabled?: boolean;
}

export interface DEConfig {
  instance_id: string;
  de_id: string;
  template_key: string;
  values: ConfigValue;
  updated_at: string;
}

export async function getDEConfig(deId: string): Promise<DEConfig | null> {
  const { data, error } = await supabase.rpc('get_de_config', {
    p_de_id: deId,
  });

  if (error) {
    console.error('Failed to get DE config:', error);
    return null;
  }

  return data;
}

export async function saveDEConfig(
  deId: string,
  templateKey: string,
  values: ConfigValue
): Promise<{ ok: boolean; instance_id: string; updated_at: string } | null> {
  const { data, error } = await supabase.rpc('save_de_config', {
    p_de_id: deId,
    p_template_key: templateKey,
    p_values: values,
  });

  if (error) {
    console.error('Failed to save DE config:', error);
    return null;
  }

  return data;
}

export async function getConfigTemplateWithOverrides(
  deId: string,
  templateKey: string = 'support-de-template'
): Promise<ConfigValue | null> {
  const { data, error } = await supabase.rpc(
    'get_config_template_with_overrides',
    {
      p_de_id: deId,
      p_template_key: templateKey,
    }
  );

  if (error) {
    console.error('Failed to get config template:', error);
    return null;
  }

  return data;
}

export async function resetDEConfigToTemplate(
  deId: string,
  templateKey: string = 'support-de-template'
): Promise<{ ok: boolean } | null> {
  const { data, error } = await supabase.rpc('reset_de_config_to_template', {
    p_de_id: deId,
    p_template_key: templateKey,
  });

  if (error) {
    console.error('Failed to reset DE config:', error);
    return null;
  }

  return data;
}
