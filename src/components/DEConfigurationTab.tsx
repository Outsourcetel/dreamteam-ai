import React, { useState, useEffect } from 'react'
import type { DigitalEmployee } from '../lib/digitalEmployeesApi'
import { ConfigurationUIGenerator } from './ConfigurationUIGenerator'
import { getConfigSchema, type DEConfigSchema } from '../lib/configurationFramework'

interface DEConfigurationTabProps {
  de: DigitalEmployee
  tenant_id: string
}

/**
 * Configuration Tab for DE Profile
 *
 * Shows and edits DE configuration (refund limits, escalation rules, etc.)
 * Combines summary view + editable configuration UI
 */
export function DEConfigurationTab({ de, tenant_id }: DEConfigurationTabProps) {
  const [schema, setSchema] = useState<DEConfigSchema | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadSchema = async () => {
      try {
        const loaded = await getConfigSchema(tenant_id, 'de', de.id)
        if (loaded) {
          setSchema(loaded)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load configuration schema')
      } finally {
        setLoading(false)
      }
    }

    loadSchema()
  }, [tenant_id, de.id])

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse h-48 bg-dt-card rounded-lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-4">
          <p className="text-sm text-red-300">⚠ {error}</p>
        </div>
      </div>
    )
  }

  if (!schema) {
    return (
      <div className="p-6">
        <div className="bg-amber-900/20 border border-amber-700/50 rounded-lg p-4">
          <p className="text-sm text-amber-300">
            📋 No configuration schema found for {de.name}. Set up a configuration template first.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-2">{de.name} Configuration</h2>
        <p className="text-sm text-dt-support">
          Customize how {de.name} operates: limits, rules, approval gates, knowledge sources, and escalation routing.
        </p>
      </div>

      {/* Configuration Form */}
      <div className="bg-dt-card border border-dt-border rounded-xl p-6">
        <ConfigurationUIGenerator
          tenant_id={tenant_id}
          entity_kind="de"
          entity_id={de.id}
          entity_name={de.name}
          schema={schema}
          onSaved={() => {
            // Reload schema to reflect updates
            location.reload()
          }}
        />
      </div>

      {/* Help Section */}
      <div className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-dt-support">ℹ️ Configuration Guide</h3>
        <div className="text-xs text-dt-support space-y-2">
          <p>
            <strong>Authority:</strong> Set decision limits (refund authority, commitment thresholds). Requests above these limits escalate to a human.
          </p>
          <p>
            <strong>Escalation Rules:</strong> Define when and how requests get escalated. Examples: high confidence threshold, specific customer tiers, sentiment detection.
          </p>
          <p>
            <strong>Pre-Approval Strategy:</strong> Choose whether responses need human review before sending. Options: review all, rule-based (e.g., low confidence), never.
          </p>
          <p>
            <strong>Knowledge Sources:</strong> Select which systems {de.name} can consult. Examples: Salesforce, SharePoint, Google Drive, Zendesk.
          </p>
        </div>
      </div>
    </div>
  )
}
