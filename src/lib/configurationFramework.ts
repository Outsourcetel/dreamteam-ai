/**
 * Extensible Configuration Framework
 *
 * Each customer tenant defines:
 * - Configuration schema: what fields their DEs have (JSON schema)
 * - Validation rules: type, required, constraints
 * - UI generation: forms generated from schema, not hardcoded
 *
 * Examples:
 * - Support DE: refund_limit, escalation_rules, preapproval_rules
 * - HR DE: approval_hierarchy, budget_limit, leave_policies
 * - Billing DE: discount_authority, dispute_procedures, payment_terms
 * - Operations DE: resource_allocation, cost_tracking, budget_enforcement
 */

import { supabase } from '../supabase'

export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object'

export interface ConfigFieldSchema {
  key: string
  name: string
  type: ConfigFieldType
  description?: string
  required?: boolean
  defaultValue?: unknown
  validation?: {
    minValue?: number
    maxValue?: number
    pattern?: string
    minLength?: number
    maxLength?: number
  }
  ui?: {
    component?: 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'modal-editor'
    placeholder?: string
    help?: string
    options?: Array<{ value: unknown; label: string }>
  }
}

export interface DEConfigSchema {
  schema_id: string
  tenant_id: string
  entity_kind: 'de' | 'playbook' | 'specialist'
  entity_id?: string // if specific to one entity, else applies to all of type
  name: string // e.g., "Support DE Config", "HR DE Config"
  fields: ConfigFieldSchema[]
  tags?: string[] // ["support", "configuration"]
  created_at: string
  updated_at: string
}

export interface DEConfigInstance {
  config_id: string
  tenant_id: string
  entity_kind: 'de' | 'playbook' | 'specialist'
  entity_id: string
  schema_id: string
  data: Record<string, unknown> // actual config values
  created_at: string
  updated_at: string
  updated_by: string
}

// ── Get Configuration Schema ───────────────────────────────────────

export async function getConfigSchema(
  tenant_id: string,
  entity_kind: 'de' | 'playbook' | 'specialist',
  entity_id?: string
): Promise<DEConfigSchema | null> {
  try {
    const query = supabase
      .from('de_config_schemas')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('entity_kind', entity_kind)

    if (entity_id) {
      query.or(`entity_id.eq.${entity_id},entity_id.is.null`)
    } else {
      query.is('entity_id', null)
    }

    const { data, error } = await query.single()
    if (error && error.code !== 'PGRST116') throw error // PGRST116 = no rows
    return data as DEConfigSchema || null
  } catch (e) {
    console.error('Failed to fetch config schema:', e)
    return null
  }
}

// ── Get Configuration Instance ─────────────────────────────────────

export async function getConfig(
  tenant_id: string,
  entity_kind: 'de' | 'playbook' | 'specialist',
  entity_id: string
): Promise<DEConfigInstance | null> {
  try {
    const { data, error } = await supabase.rpc('get_de_config', {
      p_tenant_id: tenant_id,
      p_entity_kind: entity_kind,
      p_entity_id: entity_id,
    })

    if (error) throw error
    return data as DEConfigInstance
  } catch (e) {
    console.error('Failed to fetch config:', e)
    return null
  }
}

// ── Set Configuration Instance ─────────────────────────────────────

export async function setConfig(
  tenant_id: string,
  entity_kind: 'de' | 'playbook' | 'specialist',
  entity_id: string,
  config_data: Record<string, unknown>
): Promise<DEConfigInstance | null> {
  try {
    const { data, error } = await supabase.rpc('set_de_config', {
      p_tenant_id: tenant_id,
      p_entity_kind: entity_kind,
      p_entity_id: entity_id,
      p_config: config_data,
    })

    if (error) throw error
    return data as DEConfigInstance
  } catch (e) {
    console.error('Failed to set config:', e)
    return null
  }
}

// ── Create Configuration Schema ────────────────────────────────────

export async function createConfigSchema(
  tenant_id: string,
  schema: Omit<DEConfigSchema, 'schema_id' | 'tenant_id' | 'created_at' | 'updated_at'>
): Promise<DEConfigSchema | null> {
  try {
    const { data, error } = await supabase.rpc('create_config_schema', {
      p_tenant_id: tenant_id,
      p_entity_kind: schema.entity_kind,
      p_entity_id: schema.entity_id || null,
      p_name: schema.name,
      p_fields: schema.fields,
      p_tags: schema.tags || null,
    })

    if (error) throw error
    return data as DEConfigSchema
  } catch (e) {
    console.error('Failed to create config schema:', e)
    return null
  }
}

// ── Validate Configuration Data ────────────────────────────────────

export function validateConfigData(
  data: Record<string, unknown>,
  schema: DEConfigSchema
): { valid: boolean; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = []

  for (const field of schema.fields) {
    const value = data[field.key]

    // Check required
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push({ field: field.key, message: `${field.name} is required` })
      continue
    }

    if (value === undefined || value === null) continue

    // Check type
    const valueType = Array.isArray(value) ? 'array' : typeof value
    if (valueType !== field.type) {
      errors.push({ field: field.key, message: `${field.name} must be ${field.type}` })
      continue
    }

    // Check validation rules
    if (field.type === 'number' && typeof value === 'number') {
      if (field.validation?.minValue !== undefined && value < field.validation.minValue) {
        errors.push({ field: field.key, message: `${field.name} must be >= ${field.validation.minValue}` })
      }
      if (field.validation?.maxValue !== undefined && value > field.validation.maxValue) {
        errors.push({ field: field.key, message: `${field.name} must be <= ${field.validation.maxValue}` })
      }
    }

    if (field.type === 'string' && typeof value === 'string') {
      if (field.validation?.minLength !== undefined && value.length < field.validation.minLength) {
        errors.push({ field: field.key, message: `${field.name} must be >= ${field.validation.minLength} chars` })
      }
      if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) {
        errors.push({ field: field.key, message: `${field.name} must be <= ${field.validation.maxLength} chars` })
      }
      if (field.validation?.pattern) {
        const regex = new RegExp(field.validation.pattern)
        if (!regex.test(value)) {
          errors.push({ field: field.key, message: `${field.name} format is invalid` })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ── Built-in Configuration Templates ───────────────────────────────

export const CONFIG_TEMPLATES = {
  support: {
    entity_kind: 'de' as const,
    name: 'Support DE Configuration',
    fields: [
      {
        key: 'refund_limit',
        name: 'Refund Limit',
        type: 'number' as ConfigFieldType,
        description: 'Maximum refund amount without manager approval',
        required: false,
        ui: {
          component: 'number',
          placeholder: '1000',
          help: 'Refunds above this amount require escalation',
        },
        validation: {
          minValue: 0,
          maxValue: 1000000,
        },
      },
      {
        key: 'escalation_rules',
        name: 'Escalation Rules',
        type: 'array' as ConfigFieldType,
        description: 'Multi-rule escalation routing engine',
        required: false,
        ui: {
          component: 'modal-editor',
          help: '5 rule types: topic, confidence, sentiment, custom. 9 escalation targets.',
        },
      },
      {
        key: 'knowledge_sources',
        name: 'Knowledge Sources',
        type: 'array' as ConfigFieldType,
        description: 'Which systems this DE consults for knowledge',
        required: false,
        ui: {
          component: 'modal-editor',
          help: 'Salesforce, SharePoint, Google Drive, Notion, Confluence, etc.',
        },
      },
      {
        key: 'preapproval_strategy',
        name: 'Response Approval Strategy',
        type: 'string' as ConfigFieldType,
        description: 'When should responses require human review before sending',
        required: false,
        ui: {
          component: 'select',
          options: [
            { value: 'all', label: 'Review all responses (safest)' },
            { value: 'rule_based', label: 'Rule-based review' },
            { value: 'never', label: 'Never review (fastest)' },
          ],
        },
      },
    ],
    tags: ['support', 'configuration'],
  },
  hr: {
    entity_kind: 'de' as const,
    name: 'HR DE Configuration',
    fields: [
      {
        key: 'approval_hierarchy',
        name: 'Approval Hierarchy',
        type: 'array' as ConfigFieldType,
        description: 'Who approves which types of requests',
        required: false,
        ui: {
          component: 'modal-editor',
        },
      },
      {
        key: 'budget_limit_per_request',
        name: 'Budget Limit per Request',
        type: 'number' as ConfigFieldType,
        description: 'Maximum cost per HR request (training, tools, etc)',
        required: false,
        validation: { minValue: 0 },
      },
      {
        key: 'escalation_for_policies',
        name: 'Escalate for Policy Questions',
        type: 'boolean' as ConfigFieldType,
        description: 'Always escalate policy interpretation to HR lead',
        required: false,
      },
    ],
    tags: ['hr', 'configuration'],
  },
  billing: {
    entity_kind: 'de' as const,
    name: 'Billing DE Configuration',
    fields: [
      {
        key: 'discount_authority',
        name: 'Discount Authority',
        type: 'number' as ConfigFieldType,
        description: 'Maximum discount percentage DE can approve',
        required: false,
        validation: { minValue: 0, maxValue: 100 },
      },
      {
        key: 'payment_methods',
        name: 'Accepted Payment Methods',
        type: 'array' as ConfigFieldType,
        description: 'Which payment methods this DE can process',
        required: false,
      },
    ],
    tags: ['billing', 'configuration'],
  },
}
