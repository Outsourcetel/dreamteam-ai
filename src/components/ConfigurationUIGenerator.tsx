import React, { useState, useEffect } from "react"
import type { ConfigFieldSchema, DEConfigSchema } from "../lib/configurationFramework"
import { getConfig, setConfig, validateConfigData } from "../lib/configurationFramework"

interface ConfigurationUIGeneratorProps {
  tenant_id: string
  entity_kind: "de" | "playbook" | "specialist"
  entity_id: string
  entity_name: string
  schema: DEConfigSchema
  onSaved?: () => void
}

export function ConfigurationUIGenerator({
  tenant_id,
  entity_kind,
  entity_id,
  entity_name,
  schema,
  onSaved,
}: ConfigurationUIGeneratorProps) {
  const [data, setData] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [editingField, setEditingField] = useState<string | null>(null)

  useEffect(() => {
    loadConfig()
  }, [entity_id])

  const loadConfig = async () => {
    setLoading(true)
    try {
      const config = await getConfig(tenant_id, entity_kind, entity_id)
      if (config) {
        setData(config.data)
      }
    } catch (e) {
      console.error("Failed to load config:", e)
    } finally {
      setLoading(false)
    }
  }

  const handleFieldChange = (fieldKey: string, value: unknown) => {
    setData(prev => ({ ...prev, [fieldKey]: value }))
    setErrors(prev => ({ ...prev, [fieldKey]: "" }))
    setSaved(false)
  }

  const handleSave = async () => {
    const validation = validateConfigData(data, schema)
    if (!validation.valid) {
      const newErrors: Record<string, string> = {}
      validation.errors.forEach(err => {
        newErrors[err.field] = err.message
      })
      setErrors(newErrors)
      return
    }

    setSaving(true)
    try {
      await setConfig(tenant_id, entity_kind, entity_id, data)
      setSaved(true)
      onSaved?.()
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error("Failed to save config:", e)
      setErrors({ _form: e instanceof Error ? e.message : "Failed to save configuration" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-xs text-dt-muted py-4">Loading configuration...</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white mb-1">{schema.name}</h4>
        <p className="text-xs text-dt-support">Configure {entity_name} behavior</p>
      </div>

      {/* Form Fields */}
      <div className="space-y-3 bg-dt-card border border-dt-border rounded-lg p-4">
        {schema.fields.map(field => (
          <ConfigField
            key={field.key}
            field={field}
            value={data[field.key]}
            error={errors[field.key]}
            onChangeValue={val => handleFieldChange(field.key, val)}
            isEditing={editingField === field.key}
            onEdit={() => setEditingField(field.key)}
            onEditClose={() => setEditingField(null)}
          />
        ))}
      </div>

      {/* Form Error */}
      {errors._form && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-3">
          <p className="text-xs text-red-300">{errors._form}</p>
        </div>
      )}

      {/* Save Button */}
      <div className="flex items-center gap-2 pt-2 border-t border-dt-border">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-xs font-medium text-white transition-colors">
          {saving ? "Saving..." : "Save Configuration"}
        </button>
        {saved && <span className="text-xs text-emerald-400">✓ Saved</span>}
      </div>
    </div>
  )
}

interface ConfigFieldProps {
  field: ConfigFieldSchema
  value: unknown
  error?: string
  onChangeValue: (value: unknown) => void
  isEditing: boolean
  onEdit: () => void
  onEditClose: () => void
}

function ConfigField({
  field,
  value,
  error,
  onChangeValue,
  isEditing,
  onEdit,
  onEditClose,
}: ConfigFieldProps) {
  const component = field.ui?.component || (
    field.type === "string" ? "text" :
    field.type === "number" ? "number" :
    field.type === "boolean" ? "toggle" :
    field.type === "array" ? "modal-editor" :
    "text"
  )

  return (
    <div className="space-y-1.5 py-2.5 border-b border-dt-border last:border-0">
      <label className="text-xs font-medium text-dt-support">
        {field.name}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </label>

      {field.description && (
        <p className="text-xs text-dt-muted">{field.description}</p>
      )}

      {component === "text" && (
        <input
          type="text"
          value={(value as string) || ""}
          onChange={e => onChangeValue(e.target.value)}
          placeholder={field.ui?.placeholder}
          className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500"
        />
      )}

      {component === "textarea" && (
        <textarea
          value={(value as string) || ""}
          onChange={e => onChangeValue(e.target.value)}
          placeholder={field.ui?.placeholder}
          rows={3}
          className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500 resize-none"
        />
      )}

      {component === "number" && (
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={e => onChangeValue(e.target.value ? Number(e.target.value) : null)}
          placeholder={field.ui?.placeholder}
          className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500"
        />
      )}

      {component === "toggle" && (
        <button
          onClick={() => onChangeValue(!value)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            value
              ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-400"
              : "bg-dt-panel border border-dt-border-strong text-dt-support"
          }`}>
          {value ? "Enabled" : "Disabled"}
        </button>
      )}

      {component === "select" && (
        <select
          value={String(value || "")}
          onChange={e => {
            const opt = field.ui?.options?.find(o => String(o.value) === e.target.value)
            onChangeValue(opt?.value)
          }}
          className="w-full bg-dt-page border border-dt-border-strong rounded-lg px-2 py-1.5 text-sm text-dt-body focus:outline-none focus:border-indigo-500">
          <option value="">Select an option...</option>
          {field.ui?.options?.map(opt => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {component === "modal-editor" && (
        <button
          onClick={onEdit}
          className="px-3 py-1.5 text-xs bg-dt-panel hover:bg-dt-panel rounded-lg transition-colors">
          {isEditing ? "Editing..." : "Edit Rules"}
        </button>
      )}

      {field.ui?.help && <p className="text-xs text-dt-muted italic">{field.ui.help}</p>}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
