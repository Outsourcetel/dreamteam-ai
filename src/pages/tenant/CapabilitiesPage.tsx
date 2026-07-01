import React, { useState, useMemo } from 'react';
import { useCapabilities, BusinessCapability, RiskLevel } from '../../lib/useCapabilities';

const WORKSPACES = ['All', 'Support', 'Revenue', 'Finance', 'HR', 'Compliance'];

const RISK_STYLE: Record<RiskLevel, string> = {
  low: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-500/20',
  high: 'text-red-400 bg-red-400/10 border-red-500/20',
};

const WS_COLOR: Record<string, string> = {
  Support: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  Revenue: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  Finance: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
  HR: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  Compliance: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
};

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  disabled: 'bg-slate-600',
  draft: 'bg-amber-500',
};

export default function CapabilitiesPage() {
  const { capabilities, toggleCapability, setApprovalRequired, setRiskLevel } = useCapabilities();
  const [wsFilter, setWsFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled' | 'draft'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => capabilities.filter(c => {
    if (wsFilter !== 'All' && c.workspace !== wsFilter) return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [capabilities, wsFilter, statusFilter, search]);

  const activeCount = capabilities.filter(c => c.status === 'active').length;
  const totalRuns = capabilities.reduce((n, c) => n + c.runCount, 0);
  const approvalGated = capabilities.filter(c => c.approvalRequired).length;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-950">
      {/* Header */}
      <div className="px-8 pt-8 pb-0 flex-shrink-0">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-slate-500 uppercase tracking-widest">Platform</span>
              <span className="text-slate-700">/</span>
              <span className="text-xs text-indigo-400 uppercase tracking-widest">Business Capabilities</span>
            </div>
            <h1 className="text-2xl font-bold text-white">Business Capabilities</h1>
            <p className="text-slate-400 text-sm mt-1">
              Named business outcomes your Digital Employees can execute. Enable, configure approval rules, and monitor performance per capability.
            </p>
          </div>
          <div className="flex gap-3">
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-center">
              <div className="text-lg font-bold text-emerald-400">{activeCount}</div>
              <div className="text-xs text-slate-500">Active</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-center">
              <div className="text-lg font-bold text-white">{totalRuns.toLocaleString()}</div>
              <div className="text-xs text-slate-500">Total Runs</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-center">
              <div className="text-lg font-bold text-amber-400">{approvalGated}</div>
              <div className="text-xs text-slate-500">Approval-Gated</div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 pb-4">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search capabilities..."
            className="flex-1 max-w-xs bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500"
          />
          <div className="flex gap-1">
            {WORKSPACES.map(ws => (
              <button
                key={ws}
                onClick={() => setWsFilter(ws)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  wsFilter === ws ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' : 'bg-slate-800 text-slate-400 hover:text-white border border-transparent'
                }`}
              >
                {ws}
              </button>
            ))}
          </div>
          <div className="flex gap-1 ml-2">
            {(['all', 'active', 'disabled', 'draft'] as const).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                  statusFilter === s ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Capability List */}
      <div className="flex-1 overflow-y-auto px-8 pb-8">
        <div className="space-y-3">
          {filtered.map(cap => {
            const expanded = expandedId === cap.id;
            return (
              <div
                key={cap.id}
                className={`bg-slate-900 border rounded-xl transition-colors ${
                  expanded ? 'border-indigo-500/40' : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                {/* Row */}
                <div
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer"
                  onClick={() => setExpandedId(expanded ? null : cap.id)}
                >
                  {/* Status toggle */}
                  <button
                    onClick={e => { e.stopPropagation(); toggleCapability(cap.id); }}
                    className={`w-10 h-5 rounded-full relative flex-shrink-0 transition-all ${
                      cap.status === 'active' ? 'bg-indigo-600' : 'bg-slate-700'
                    }`}
                    title={cap.status === 'active' ? 'Click to disable' : 'Click to enable'}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${cap.status === 'active' ? 'left-5' : 'left-0.5'}`} />
                  </button>

                  <div className="w-9 h-9 bg-slate-800 rounded-lg flex items-center justify-center text-base flex-shrink-0">
                    {cap.icon}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-white">{cap.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded border ${WS_COLOR[cap.workspace] ?? 'text-slate-400 border-slate-700'}`}>
                        {cap.workspace}
                      </span>
                      {cap.approvalRequired && (
                        <span className="text-xs px-2 py-0.5 rounded border text-amber-400 bg-amber-400/10 border-amber-500/20">
                          Approval Required
                        </span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded border ${RISK_STYLE[cap.riskLevel]}`}>
                        {cap.riskLevel} risk
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 truncate">{cap.description}</p>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-6 flex-shrink-0">
                    <div className="text-right">
                      <div className="text-sm font-semibold text-white">{cap.runCount.toLocaleString()}</div>
                      <div className="text-xs text-slate-500">Runs</div>
                    </div>
                    {cap.avgConfidence && (
                      <div className="text-right">
                        <div className="text-sm font-semibold text-white">{Math.round(cap.avgConfidence * 100)}%</div>
                        <div className="text-xs text-slate-500">Confidence</div>
                      </div>
                    )}
                    <div className="text-right">
                      <div className="text-sm font-semibold text-white">{cap.avgHandleTime ?? '—'}</div>
                      <div className="text-xs text-slate-500">Avg Time</div>
                    </div>
                    {cap.lastRun && (
                      <div className="text-right">
                        <div className="text-xs text-slate-400">{cap.lastRun}</div>
                        <div className="text-xs text-slate-600">Last run</div>
                      </div>
                    )}
                    <span className={`text-slate-400 text-sm transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
                  </div>
                </div>

                {/* Expanded detail */}
                {expanded && (
                  <div className="border-t border-slate-800 px-5 py-4 grid grid-cols-3 gap-6">
                    {/* Config */}
                    <div className="col-span-2 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Assigned Digital Employees</p>
                          <div className="flex flex-wrap gap-1.5">
                            {cap.assignedDEs.map(de => (
                              <span key={de} className="text-xs px-2 py-1 bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 rounded-lg">
                                {de.replace('de_', '').replace(/_/g, ' ')}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Required Connectors</p>
                          <div className="flex flex-wrap gap-1.5">
                            {cap.requiredConnectors.length > 0 ? cap.requiredConnectors.map(c => (
                              <span key={c} className="text-xs px-2 py-1 bg-slate-800 text-slate-300 rounded-lg">{c}</span>
                            )) : <span className="text-xs text-slate-600">None</span>}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Required Knowledge</p>
                          <div className="flex flex-wrap gap-1.5">
                            {cap.requiredKnowledge.length > 0 ? cap.requiredKnowledge.map(k => (
                              <span key={k} className="text-xs px-2 py-1 bg-slate-800 text-slate-300 rounded-lg">{k}</span>
                            )) : <span className="text-xs text-slate-600">None</span>}
                          </div>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Inputs → Outputs</p>
                          <div className="text-xs text-slate-400">
                            <span className="text-slate-300">{cap.inputs.join(', ')}</span>
                            <span className="text-slate-600 mx-2">→</span>
                            <span className="text-slate-300">{cap.outputs.join(', ')}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Approval Rule</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setApprovalRequired(cap.id, false)}
                            className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${!cap.approvalRequired ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500'}`}
                          >
                            Auto-approve
                          </button>
                          <button
                            onClick={() => setApprovalRequired(cap.id, true)}
                            className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${cap.approvalRequired ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500'}`}
                          >
                            Require Approval
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Risk Level</p>
                        <div className="flex gap-1.5">
                          {(['low', 'medium', 'high'] as RiskLevel[]).map(r => (
                            <button
                              key={r}
                              onClick={() => setRiskLevel(cap.id, r)}
                              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all capitalize ${
                                cap.riskLevel === r ? RISK_STYLE[r] : 'bg-slate-800 text-slate-500 border-slate-700 hover:border-slate-500'
                              }`}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Status</p>
                        <button
                          onClick={() => toggleCapability(cap.id)}
                          className={`w-full py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            cap.status === 'active'
                              ? 'bg-red-500/10 text-red-300 border-red-500/30 hover:bg-red-500/20'
                              : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20'
                          }`}
                        >
                          {cap.status === 'active' ? 'Disable Capability' : 'Enable Capability'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="text-center py-16 text-slate-500">
              <div className="text-3xl mb-3">⚡</div>
              <p className="text-sm">No capabilities match your filters.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
