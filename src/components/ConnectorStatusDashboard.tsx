import React, { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import { fmtSince } from '../lib/connectorApi';

interface ConnectorStatus {
  connector_id: string;
  category: string;
  provider: string;
  connector_name: string;
  last_ok_at: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  status: 'connected' | 'degraded' | 'down' | 'never_connected';
  item_count: number;
  error_message?: string;
}

function statusColor(status: ConnectorStatus['status']): string {
  const colors = {
    connected: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    degraded: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    down: 'bg-red-500/15 text-red-300 border-red-500/30',
    never_connected: 'bg-slate-600/40 text-dt-support border-dt-border-strong',
  };
  return colors[status];
}

function statusDot(status: ConnectorStatus['status']): string {
  const dots = {
    connected: 'bg-emerald-500',
    degraded: 'bg-amber-500',
    down: 'bg-red-500',
    never_connected: 'bg-slate-600',
  };
  return dots[status];
}

export function ConnectorStatusDashboard() {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

  useEffect(() => {
    loadConnectorStatus();
    const interval = setInterval(loadConnectorStatus, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  const loadConnectorStatus = async () => {
    try {
      const { data } = await supabase.rpc('list_connector_health');
      if (data) {
        setConnectors(data as ConnectorStatus[]);
      }
    } catch (e) {
      console.error('Failed to load connector status:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (connectorId: string) => {
    setSyncing(connectorId);
    try {
      // Trigger sync based on connector type
      const connector = connectors.find(c => c.connector_id === connectorId);
      if (connector?.category === 'helpdesk') {
        await supabase.rpc('poll_support_inbox');
      }
      // Refresh status
      await loadConnectorStatus();
    } catch (e) {
      console.error('Sync failed:', e);
    } finally {
      setSyncing(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="bg-dt-card border border-dt-border rounded-lg p-4 animate-pulse h-20" />
        ))}
      </div>
    );
  }

  const grouped = new Map<string, ConnectorStatus[]>();
  for (const c of connectors) {
    const key = c.category;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-dt-support mb-4">
        Data integration status — shows when connectors last synced successfully and any active errors.
      </div>

      {connectors.length === 0 ? (
        <div className="bg-dt-card border border-dt-border rounded-lg p-8 text-center">
          <p className="text-sm text-dt-support">No connectors configured yet.</p>
          <p className="text-xs text-dt-muted mt-2">Connect your systems under Connectors to start syncing data.</p>
        </div>
      ) : (
        Array.from(grouped.entries()).map(([category, cats]) => (
          <div key={category}>
            <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2 ml-1">{category}</p>
            <div className="space-y-2">
              {cats.map(c => (
                <div key={c.connector_id} className={`border rounded-lg p-4 transition-colors ${statusColor(c.status)}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-block w-2 h-2 rounded-full ${statusDot(c.status)}`} />
                        <p className="text-sm font-medium">{c.connector_name || c.provider}</p>
                        <span className="text-xs opacity-70">({c.provider})</span>
                      </div>
                      <div className="text-xs space-y-1 mt-2">
                        {c.last_ok_at ? (
                          <p>
                            ✓ Last synced <span className="font-mono">{fmtSince(c.last_ok_at)}</span>
                            {c.item_count > 0 && ` · ${c.item_count} items`}
                          </p>
                        ) : (
                          <p>No successful sync yet</p>
                        )}
                        {c.last_error_at && (
                          <p className="opacity-80">
                            ✗ Last error <span className="font-mono">{fmtSince(c.last_error_at)}</span>
                            {c.error_message && ` · ${c.error_message}`}
                          </p>
                        )}
                        {c.consecutive_failures > 0 && (
                          <p className="opacity-80">{c.consecutive_failures} consecutive failures</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleSync(c.connector_id)}
                      disabled={syncing === c.connector_id}
                      className="px-3 py-1 text-xs bg-dt-panel hover:bg-dt-panel/60 rounded border border-dt-border-strong transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {syncing === c.connector_id ? 'Syncing...' : 'Sync now'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="text-[11px] text-dt-muted border-t border-dt-border pt-3 mt-4">
        <p>🔄 Syncs run automatically every 5 minutes. Use "Sync now" to force an immediate sync.</p>
      </div>
    </div>
  );
}
