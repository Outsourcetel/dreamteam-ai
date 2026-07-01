import React, { useState } from 'react';
import { useControlFabric, ActionPermission } from '../../lib/useControlFabric';

type Tab = 'connections' | 'knowledge' | 'actions';

const RISK_STYLE: Record<string, string> = {
  low: 'text-emerald-400 bg-emerald-400/10',
  medium: 'text-amber-400 bg-amber-400/10',
  high: 'text-red-400 bg-red-400/10',
};

const PERM_STYLE: Record<ActionPermission, { label: string; classes: string }> = {
  allow: { label: 'Allow', classes: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' },
  approval_required: { label: 'Approval Required', classes: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
  block: { label: 'Block', classes: 'bg-red-500/20 text-red-300 border border-red-500/30' },
};

const CAT_ICON: Record<string, string> = {
  CRM: '◉', Support: '◎', Finance: '$', Knowledge: '◈',
  Communication: '✉', Storage: '⊞', HR: '◉', Developer: '</>',
};

const SCOPE_STYLE: Record<string, { label: string; dot: string; badge: string }> = {
  trusted: { label: 'Trusted', dot: 'bg-emerald-500', badge: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/20' },
  restricted: { label: 'Restricted', dot: 'bg-amber-500', badge: 'text-amber-400 bg-amber-400/10 border-amber-500/20' },
  none: { label: 'No Access', dot: 'bg-slate-600', badge: 'text-slate-500 bg-slate-800 border-slate-700' },
};

export default function ControlFabricPage() {
  const {
    bindings, knowledgeScopes, actionRules,
    connectors, digitalEmployees, kbCategories,
    toggleDEConnector, setConnectorPermission, setKnowledgeScope, setActionRule,
  } = useControlFabric();

  const [tab, setTab] = useState<Tab>('connections');
  const [selectedDE, setSelectedDE] = useState(knowledgeScopes[0]?.deId ?? '');
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState<Record<string, string>>({});

  const activeDE = knowledgeScopes.find(s => s.deId === selectedDE);

  const totalBindings = bindings.reduce((n, b) => n + b.deIds.length, 0);
  const blockedCount = actionRules.filter(r => r.permission === 'block').length;
  const approvalCount = actionRules.filter(r => r.permission === 'approval_required').length;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-950">
      {/* Header */}
      <div className="px-8 pt-8 pb-0 flex-shrink-0">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-slate-500 uppercase tracking-widest">Platform</span>
              <span className="text-slate-700">/</span>
              <span className="text-xs text-indigo-400 uppercase tracking-widest">Control Fabric</span>
            </div>
            <h1 className="text-2xl font-bold text-white">Control Fabric</h1>
            <p className="text-slate-400 text-sm mt-1">
              Define exactly what data, knowledge, and actions each Digital Employee can access. This is your trust boundary.
            </p>
          </div>
          <div className="flex gap-3">
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-center">
              <div className="text-lg font-bold text-white">{totalBindings}</div>
              <div className="text-xs text-slate-500">DE–Connector Links</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-center">
              <div className="text-lg font-bold text-amber-400">{approvalCount}</div>
              <div className="text-xs text-slate-500">Approval-Gated</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-center">
              <div className="text-lg font-bold text-red-400">{blockedCount}</div>
              <div className="text-xs text-slate-500">Blocked Actions</div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-800">
          {([
            { id: 'connections', label: 'Data Connections', icon: '⇄' },
            { id: 'knowledge', label: 'Knowledge Scope', icon: '◈' },
            { id: 'actions', label: 'Action Rules', icon: '⚡' },
          ] as { id: Tab; label: string; icon: string }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-8 py-6">

        {/* ── DATA CONNECTIONS ── */}
        {tab === 'connections' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500 mb-4">
              For each connected data source, choose which Digital Employees may access it and at what permission level. Changes take effect on the next DE invocation.
            </p>
            {bindings.map(binding => {
              const connector = connectors.find(c => c.id === binding.connectorId);
              return (
                <div key={binding.connectorId} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-slate-800 rounded-lg flex items-center justify-center text-base">
                        {CAT_ICON[connector?.category ?? ''] ?? '⊞'}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">{binding.connectorName}</div>
                        <div className="text-xs text-slate-500">{connector?.category}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 mr-1">Permission:</span>
                      {(['read', 'read-write'] as const).map(p => (
                        <button
                          key={p}
                          onClick={() => setConnectorPermission(binding.connectorId, p)}
                          className={`px-3 py-1 rounded-lg text-xs font-medium border transition-all ${
                            binding.permission === p
                              ? p === 'read-write'
                                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                              : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500'
                          }`}
                        >
                          {p === 'read' ? 'Read Only' : 'Read + Write'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2">
                    {digitalEmployees.map(de => {
                      const linked = binding.deIds.includes(de.id);
                      return (
                        <button
                          key={de.id}
                          onClick={() => toggleDEConnector(binding.connectorId, de.id)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                            linked
                              ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40'
                              : 'bg-slate-800/50 text-slate-500 border-slate-700 hover:border-slate-500 hover:text-slate-300'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${linked ? 'bg-indigo-400' : 'bg-slate-600'}`} />
                          <span className="truncate">{de.name}</span>
                        </button>
                      );
                    })}
                  </div>

                  {binding.deIds.length === 0 && (
                    <p className="text-xs text-slate-600 mt-3 italic">No Digital Employees connected to this data source.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── KNOWLEDGE SCOPE ── */}
        {tab === 'knowledge' && (
          <div className="flex gap-6 h-full">
            {/* DE selector */}
            <div className="w-56 flex-shrink-0 space-y-1">
              <p className="text-xs text-slate-500 uppercase tracking-widest px-1 mb-3">Digital Employees</p>
              {knowledgeScopes.map(s => (
                <button
                  key={s.deId}
                  onClick={() => setSelectedDE(s.deId)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-left transition-all ${
                    selectedDE === s.deId
                      ? 'bg-indigo-500/15 text-white border border-indigo-500/30'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <span className="w-7 h-7 bg-slate-800 rounded-lg flex items-center justify-center text-xs flex-shrink-0">
                    {s.deName[0]}
                  </span>
                  <span className="truncate text-xs font-medium">{s.deName}</span>
                </button>
              ))}
            </div>

            {/* Scope table */}
            {activeDE && (
              <div className="flex-1">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base font-semibold text-white">{activeDE.deName}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Set which knowledge categories this DE may draw upon when answering queries.
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    {(['trusted', 'restricted', 'none'] as const).map(level => (
                      <span key={level} className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${SCOPE_STYLE[level].dot}`} />
                        {SCOPE_STYLE[level].label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="text-left px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Category</th>
                        <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider text-center">Trusted</th>
                        <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider text-center">Restricted</th>
                        <th className="px-5 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider text-center">No Access</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {kbCategories.map(cat => {
                        const current = activeDE.categories[cat] ?? 'none';
                        return (
                          <tr key={cat} className="hover:bg-slate-800/30 transition-colors">
                            <td className="px-5 py-3 text-sm text-white font-medium">{cat}</td>
                            {(['trusted', 'restricted', 'none'] as const).map(level => (
                              <td key={level} className="px-5 py-3 text-center">
                                <button
                                  onClick={() => setKnowledgeScope(activeDE.deId, cat, level)}
                                  className={`w-5 h-5 rounded-full border-2 mx-auto flex items-center justify-center transition-all ${
                                    current === level
                                      ? level === 'trusted'
                                        ? 'border-emerald-500 bg-emerald-500'
                                        : level === 'restricted'
                                        ? 'border-amber-500 bg-amber-500'
                                        : 'border-slate-500 bg-slate-500'
                                      : 'border-slate-700 hover:border-slate-500'
                                  }`}
                                >
                                  {current === level && <span className="text-white text-xs">✓</span>}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-600 mt-3">
                  <strong className="text-slate-500">Trusted</strong> — DE may cite and quote directly. &nbsp;
                  <strong className="text-slate-500">Restricted</strong> — DE may use for reasoning but not cite to users. &nbsp;
                  <strong className="text-slate-500">No Access</strong> — completely excluded from this DE's context.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── ACTION RULES ── */}
        {tab === 'actions' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 mb-4">
              For each action type a Digital Employee may attempt, set whether it runs automatically, requires a human approval, or is completely blocked. These rules override capability settings.
            </p>
            {actionRules.map(rule => {
              const perm = PERM_STYLE[rule.permission];
              const isEditing = editingRule === rule.id;
              return (
                <div key={rule.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
                  <div className="flex items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-white">{rule.actionType}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_STYLE[rule.riskLevel]}`}>
                          {rule.riskLevel} risk
                        </span>
                        <span className="text-xs text-slate-600 bg-slate-800 px-2 py-0.5 rounded">{rule.workspace}</span>
                      </div>
                      <p className="text-xs text-slate-400">{rule.description}</p>
                      {rule.permission === 'approval_required' && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-xs text-slate-500">Value limit:</span>
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-slate-400">$</span>
                              <input
                                type="number"
                                value={limitDraft[rule.id] ?? (rule.valueLimit ?? '')}
                                onChange={e => setLimitDraft(p => ({ ...p, [rule.id]: e.target.value }))}
                                className="w-20 bg-slate-800 border border-indigo-500 rounded px-2 py-1 text-xs text-white outline-none"
                                placeholder="no limit"
                              />
                              <button
                                onClick={() => {
                                  const v = parseFloat(limitDraft[rule.id]);
                                  setActionRule(rule.id, rule.permission, isNaN(v) ? undefined : v);
                                  setEditingRule(null);
                                }}
                                className="text-xs text-emerald-400 hover:text-emerald-300 px-1"
                              >save</button>
                              <button onClick={() => setEditingRule(null)} className="text-xs text-slate-500 hover:text-slate-300 px-1">cancel</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditingRule(rule.id); setLimitDraft(p => ({ ...p, [rule.id]: String(rule.valueLimit ?? '') })); }}
                              className="text-xs text-amber-400 hover:text-amber-300 underline"
                            >
                              {rule.valueLimit != null ? `$${rule.valueLimit}` : 'no limit'} (edit)
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {(['allow', 'approval_required', 'block'] as ActionPermission[]).map(p => {
                        const s = PERM_STYLE[p];
                        return (
                          <button
                            key={p}
                            onClick={() => setActionRule(rule.id, p)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                              rule.permission === p ? s.classes : 'bg-slate-800 text-slate-500 border-slate-700 hover:border-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="mt-4 bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-4">
              <p className="text-xs text-indigo-300">
                <strong>Rule precedence:</strong> Block &gt; Approval Required &gt; Allow. If a DE's capability config says "allow" but an Action Rule says "block", the block wins. Audit entries are created for every action attempt regardless of outcome.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
