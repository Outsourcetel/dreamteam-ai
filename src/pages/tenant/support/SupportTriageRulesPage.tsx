import React, { useState, useEffect, useCallback } from 'react';
import type { Page } from '../../../types';
import { listTriageRules, upsertTriageRule, deleteTriageRule } from '../../../lib/supportInboxApi';
import type { TriageRule } from '../../../lib/supportInboxApi';
import { LiveLoadingSkeleton } from '../../../components/LiveDataStates';

// ============================================================
// Support triage-rules editor — the config surface for mig 233.
// Deterministic classification/priority/severity is applied at intake
// by the DB trigger; this lets an admin edit the rules that drive it.
// Precedence = rule_order (lower wins), so keep safety/security first.
// Writes are RLS-guarded (owner/admin/manager).
// ============================================================

type Draft = Partial<TriageRule> & { name: string; set_category: string };
const BLANK: Draft = { rule_order: 100, name: '', match_pattern: '', set_category: '', set_priority: 'normal', set_severity: 'sev3', active: true };
const PRIORITIES: TriageRule['set_priority'][] = ['low', 'normal', 'high', 'urgent'];
const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'];

const SupportTriageRulesPage = ({ setPage, embedded }: { setPage: (p: Page) => void; embedded?: boolean }) => {
  const [rules, setRules] = useState<TriageRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setRules(await listTriageRules()); }
    catch (err) { setError((err as Error)?.message || 'Failed to load triage rules.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const save = async () => {
    if (!draft || !draft.name.trim() || !draft.set_category.trim()) { setError('Name and category are required.'); return; }
    setSaving(true); setError(null);
    try {
      await upsertTriageRule(draft);
      setDraft(null);
      notify('Rule saved');
      await refresh();
    } catch (err) { setError((err as Error)?.message || 'Could not save the rule.'); }
    finally { setSaving(false); }
  };

  const remove = async (r: TriageRule) => {
    setError(null);
    try { await deleteTriageRule(r.id); notify('Rule deleted'); await refresh(); }
    catch (err) { setError((err as Error)?.message || 'Could not delete the rule.'); }
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...(d ?? BLANK), ...patch }));

  return (
    <div className="p-6">
      <div className={`flex items-start justify-between flex-wrap gap-2 ${embedded ? 'mb-4' : 'mb-6'}`}>
        {!embedded ? <div>
          <h1 className="text-2xl font-bold text-white">Support triage rules</h1>
          <p className="text-dt-support text-sm mt-1">
            Deterministic classification applied at intake. Rules run in order (lower number wins) — keep safety, security and outage rules at the top so they win over emotional phrasing.
          </p>
        </div> : <p className="text-dt-support text-sm mt-1 max-w-2xl">
          Deterministic classification applied at intake. Rules run in order (lower number wins) — keep safety, security and outage rules at the top so they win over emotional phrasing.
        </p>}
        <div className="flex gap-2">
          {!embedded && <button onClick={() => setPage('support_command_center')}
            className="text-xs px-3 py-1.5 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors">← Command Center</button>}
          <button onClick={() => setDraft({ ...BLANK })}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">+ Add rule</button>
        </div>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-800/50 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

      {/* Editor */}
      {draft && (
        <div className="mb-5 rounded-2xl border border-indigo-500/30 bg-indigo-500/10 p-5 space-y-3">
          <p className="text-sm font-semibold text-white">{draft.id ? 'Edit rule' : 'New rule'}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="block">
              <span className="text-[11px] text-dt-support">Order (lower wins)</span>
              <input type="number" value={draft.rule_order ?? 100} onChange={(e) => set({ rule_order: Number(e.target.value) })}
                className="mt-1 w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body" />
            </label>
            <label className="block col-span-1 md:col-span-3">
              <span className="text-[11px] text-dt-support">Name</span>
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Security"
                className="mt-1 w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body" />
            </label>
          </div>
          <label className="block">
            <span className="text-[11px] text-dt-support">Keywords (| separated, matched literally). Leave blank for a catch-all default.</span>
            <input value={draft.match_pattern ?? ''} onChange={(e) => set({ match_pattern: e.target.value })} placeholder="data breach|hacked|unauthorized access"
              className="mt-1 w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body" />
          </label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="block">
              <span className="text-[11px] text-dt-support">Category</span>
              <input value={draft.set_category} onChange={(e) => set({ set_category: e.target.value })} placeholder="security"
                className="mt-1 w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body" />
            </label>
            <label className="block">
              <span className="text-[11px] text-dt-support">Priority</span>
              <select value={draft.set_priority} onChange={(e) => set({ set_priority: e.target.value as TriageRule['set_priority'] })}
                className="mt-1 w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body">
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-dt-support">Severity</span>
              <select value={draft.set_severity} onChange={(e) => set({ set_severity: e.target.value })}
                className="mt-1 w-full bg-dt-page border border-dt-border-strong rounded-lg px-3 py-1.5 text-sm text-dt-body">
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 mt-5">
              <input type="checkbox" checked={draft.active ?? true} onChange={(e) => set({ active: e.target.checked })} />
              <span className="text-xs text-dt-support">Active</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving}
              className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-60 transition-colors">
              {saving ? 'Saving…' : 'Save rule'}
            </button>
            <button onClick={() => setDraft(null)} className="text-sm px-4 py-2 rounded-lg border border-dt-border-strong text-dt-support hover:border-dt-border-strong transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <LiveLoadingSkeleton rows={5} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-dt-border bg-dt-card">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-dt-border text-left">
                {['Order', 'Name', 'Keywords', 'Category', 'Priority', 'Severity', '', ''].map((h, i) => (
                  <th key={i} className="py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr><td colSpan={8} className="py-6 px-4 text-center text-xs text-dt-muted">No triage rules yet — add one, or apply migration 233 to seed the defaults.</td></tr>
              ) : rules.map((r) => (
                <tr key={r.id} className={`border-b border-dt-border hover:bg-dt-panel transition-colors ${!r.active ? 'opacity-50' : ''}`}>
                  <td className="py-3 px-4 text-dt-support">{r.rule_order}</td>
                  <td className="py-3 px-4 font-medium text-white">{r.name}</td>
                  <td className="py-3 px-4 text-dt-support text-xs max-w-xs truncate">{r.match_pattern || <span className="italic">catch-all</span>}</td>
                  <td className="py-3 px-4 text-dt-support">{r.set_category}</td>
                  <td className="py-3 px-4"><span className={`text-xs ${r.set_priority === 'urgent' ? 'text-rose-400' : r.set_priority === 'high' ? 'text-amber-300' : 'text-dt-support'}`}>{r.set_priority}</span></td>
                  <td className="py-3 px-4"><span className={`text-xs ${r.set_severity === 'sev1' ? 'text-rose-400' : r.set_severity === 'sev2' ? 'text-amber-300' : 'text-dt-support'}`}>{r.set_severity}</span></td>
                  <td className="py-3 px-4"><button onClick={() => setDraft({ ...r })} className="text-xs text-indigo-400 hover:text-indigo-300">Edit</button></td>
                  <td className="py-3 px-4"><button onClick={() => void remove(r)} className="text-xs text-rose-400 hover:text-rose-300">Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[100] px-4 py-3 rounded-xl border shadow-xl text-sm font-medium bg-emerald-900/90 border-emerald-700/50 text-emerald-300">{toast}</div>
      )}
    </div>
  );
};

export default SupportTriageRulesPage;
