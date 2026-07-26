// ============================================================
// OpsAlertsBanner — make operational alerts reach a human.
//
// WHY THIS EXISTS
// ops_alerts had NO reader anywhere in src/ or supabase/functions/. Things wrote
// to it; nothing ever displayed it. An audit found this sitting unresolved in
// production for four days:
//
//   "Outsourcetel has EXHAUSTED its monthly AI budget (566850 of 400000 tokens).
//    Its digital employees have stopped answering."     — 2026-07-22
//
// The real workspace's digital employees stopped working, the system correctly
// noticed and wrote it down, and no human ever saw it. The budget was eventually
// raised by hand — fixing the symptom without ever seeing the alert built to
// report it.
//
// Migration 366 then added an hourly dispatch-failure check that writes to the
// SAME unread table. Building a better smoke detector and not connecting it to
// anything that makes noise is not monitoring. This is the wire.
//
// Renders NOTHING when there are no unresolved alerts. A banner that is always
// present is furniture, and furniture gets ignored — which is how the original
// alert went unread.
// ============================================================
import React, { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { Button } from '../design/primitives';

interface OpsAlert {
  id: string;
  kind: string;
  message: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

// Alert kinds that mean "the product has stopped working for a customer",
// as opposed to "something needs attention eventually".
const CRITICAL_KINDS = new Set([
  'ai_budget_exhausted',
  'dispatch_failure',
  'edge_function_error',
]);

const age = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

export default function OpsAlertsBanner() {
  const [alerts, setAlerts] = useState<OpsAlert[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    // list_ops_alerts is platform-admin only and raises for everyone else.
    // A tenant user seeing nothing here is correct, not an error to surface.
    const { data, error } = await supabase.rpc('list_ops_alerts', {
      p_hours: 720,
      p_include_resolved: false,
    });
    if (error) { setAlerts([]); return; }
    setAlerts((data ?? []) as OpsAlert[]);
  }

  useEffect(() => {
    load();
    // Poll rather than subscribe: this is a low-frequency operational signal and
    // a realtime channel for it would be more moving parts than it is worth.
    const t = setInterval(load, 300_000);
    return () => clearInterval(t);
  }, []);

  async function resolve(id: string) {
    setBusy(id);
    try {
      await supabase.rpc('resolve_ops_alert', { p_id: id });
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } finally {
      setBusy(null);
    }
  }

  if (alerts.length === 0) return null;

  const critical = alerts.filter((a) => CRITICAL_KINDS.has(a.kind));
  const tone = critical.length > 0;

  return (
    <div
      role="region"
      aria-label="Operational alerts"
      className={`mb-4 rounded-xl border ${
        tone
          ? 'border-dt-danger/40 bg-dt-danger/10'
          : 'border-dt-warn/40 bg-dt-warn/10'
      }`}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-dt-border/40">
        <span className="text-sm font-semibold text-dt-body">
          {alerts.length} unresolved {alerts.length === 1 ? 'alert' : 'alerts'}
          {critical.length > 0 && (
            <span className="ml-2 text-dt-danger">
              · {critical.length} affecting service
            </span>
          )}
        </span>
      </div>

      <ul className="divide-y divide-dt-border/30">
        {alerts.slice(0, 6).map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-4 py-3">
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                CRITICAL_KINDS.has(a.kind) ? 'bg-dt-danger' : 'bg-dt-warn'
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-dt-body break-words">{a.message}</p>
              <p className="mt-0.5 text-xs text-dt-faint">
                {a.kind} · {age(a.created_at)}
              </p>
            </div>
            <Button
              kind="secondary"
              size="sm"
              onClick={() => resolve(a.id)}
              disabled={busy === a.id}
            >
              {busy === a.id ? '…' : 'Resolve'}
            </Button>
          </li>
        ))}
      </ul>

      {alerts.length > 6 && (
        <p className="px-4 py-2 text-xs text-dt-faint">
          and {alerts.length - 6} more
        </p>
      )}
    </div>
  );
}
