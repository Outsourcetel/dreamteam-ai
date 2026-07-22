import React, { useState, useEffect } from "react"
import { getTenantMetrics, getMetricsForDE, type MetricQueryResult, type CustomMetric } from "../lib/metricsFramework"

interface MetricsDisplayProps {
  tenant_id: string
  de_id: string
  tags?: string[]
  columns?: number
}

export function MetricsDisplay({ tenant_id, de_id, tags, columns = 2 }: MetricsDisplayProps) {
  const [metrics, setMetrics] = useState<CustomMetric[]>([])
  const [values, setValues] = useState<MetricQueryResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadMetrics()
  }, [tenant_id, de_id, tags])

  const loadMetrics = async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch metric definitions
      const metricsList = await getTenantMetrics(tenant_id, tags)
      setMetrics(metricsList)

      if (metricsList.length === 0) {
        setLoading(false)
        return
      }

      // Fetch metric values for DE
      const metricKeys = metricsList.map(m => m.key)
      const metricsData = await getMetricsForDE(tenant_id, de_id, metricKeys)
      setValues(metricsData)
    } catch (e) {
      console.error("Failed to load metrics:", e)
      setError("Failed to load metrics")
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="text-xs text-dt-muted py-4">Loading metrics...</div>
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-3">
        <p className="text-xs text-red-300">{error}</p>
      </div>
    )
  }

  if (metrics.length === 0) {
    return (
      <div className="bg-dt-card border border-dt-border rounded-lg p-4 text-center">
        <p className="text-xs text-dt-muted">No metrics defined for this domain</p>
      </div>
    )
  }

  const getMetricValue = (key: string): MetricQueryResult | undefined => {
    return values.find(v => v.metric_key === key)
  }

  const getStatusColor = (metric: CustomMetric, value?: number): string => {
    if (!value || !metric.thresholds) return "text-dt-support"
    if (metric.thresholds.critical && value <= metric.thresholds.critical)
      return "text-red-400"
    if (metric.thresholds.warning && value <= metric.thresholds.warning)
      return "text-amber-400"
    return "text-emerald-400"
  }

  const formatValue = (metric: CustomMetric, value?: number): string => {
    if (!value) return "—"
    if (metric.type === "percentage") return `${value.toFixed(1)}%`
    if (metric.type === "duration") return `${value.toFixed(0)} ${metric.unit || "min"}`
    if (metric.type === "score") return `${value.toFixed(1)}/5`
    return `${value.toFixed(0)}`
  }

  return (
    <div className={`grid grid-cols-${columns} gap-4`}>
      {metrics.map(metric => {
        const metricValue = getMetricValue(metric.key)
        const statusColor = getStatusColor(metric, metricValue?.value)

        return (
          <div
            key={metric.metric_id}
            className="bg-dt-card border border-dt-border rounded-lg p-3 space-y-2">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-dt-support">{metric.name}</p>
                <p className="text-xs text-dt-muted mt-0.5">{metric.description}</p>
              </div>
            </div>

            <div className="pt-1 border-t border-dt-border">
              <p className={`text-lg font-semibold ${statusColor}`}>
                {formatValue(metric, metricValue?.value)}
              </p>
              {metricValue?.trend && (
                <p className="text-xs text-dt-muted mt-1">
                  {metricValue.trend === "up" && "📈 Improving"}
                  {metricValue.trend === "down" && "📉 Declining"}
                  {metricValue.trend === "stable" && "→ Stable"}
                </p>
              )}

              {metricValue?.comparison && (
                <p className="text-xs text-dt-muted mt-1">
                  {metricValue.comparison.changePercent > 0 ? "+" : ""}
                  {metricValue.comparison.changePercent.toFixed(1)}% vs last period
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
