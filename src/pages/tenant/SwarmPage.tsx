import React, { useState, useEffect } from 'react';
import type { Tenant, Page } from '../../types';
import { PageTabs, AGENT_TABS } from '../../components';

const SwarmPage = ({ tenant, page, setPage }: { tenant?: Tenant; page?: Page; setPage?: (p: Page) => void }) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [tick, setTick] = useState(0);
  const [showActivation, setShowActivation] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const nodes = [
    { id: 'hub', x: 240, y: 180, label: 'Knowledge Brain', color: accentColor, size: 28 },
    { id: 'support', x: 100, y: 80, label: 'Support Agent', color: '#3b82f6', size: 20 },
    { id: 'billing', x: 380, y: 80, label: 'Billing Agent', color: '#10b981', size: 20 },
    { id: 'onboard', x: 60, y: 220, label: 'Onboarding Agent', color: '#8b5cf6', size: 20 },
    { id: 'hr', x: 420, y: 220, label: 'HR Agent', color: '#f59e0b', size: 20 },
    { id: 'compliance', x: 120, y: 330, label: 'Compliance Agent', color: '#ef4444', size: 20 },
    { id: 'sales', x: 360, y: 330, label: 'Sales Agent', color: '#06b6d4', size: 20 },
    { id: 'it', x: 240, y: 360, label: 'IT Helpdesk Agent', color: '#84cc16', size: 20 },
  ];

  const edges = [
    ['hub', 'support'],
    ['hub', 'billing'],
    ['hub', 'onboard'],
    ['hub', 'hr'],
    ['hub', 'compliance'],
    ['hub', 'sales'],
    ['hub', 'it'],
    ['support', 'billing'],
  ];

  const getNode = (id: string) => nodes.find((n) => n.id === id)!;

  const liveEvents = [
    'Support Agent resolved ticket T-9921',
    'Billing Agent queued credit approval for $350',
    'HR Agent answered benefits query for 3 staff',
    'Compliance Agent flagged policy change — KB refresh triggered',
    'Onboarding Agent sent Day-1 pack to new hire Sarah M.',
    'Sales Agent qualified lead from web chat and pushed to CRM',
    'IT Helpdesk resolved 4 password reset requests',
    'Knowledge Brain indexed 42 new Zendesk tickets',
  ];

  const [eventIdx, setEventIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setEventIdx((e) => (e + 1) % liveEvents.length),
      3000
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={AGENT_TABS} page={page} setPage={setPage} accentColor={accentColor} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Workforce Engine</h1>
          <p className="text-slate-400 text-sm mt-1">
            Real-time view of all Digital Employees and knowledge flows
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-xs text-emerald-400 font-medium">All agents live</span>
        </div>
      </div>

      {/* LLM Activation Banner */}
      <div className="mb-6 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-amber-400 text-lg">⚡</span>
            <div>
              <div className="text-sm font-semibold text-amber-300">Workforce Engine is running in rule-based mode</div>
              <div className="text-xs text-amber-400/70 mt-0.5">Connect your Anthropic API key to activate full LLM reasoning — the Edge Function code is already written and ready to deploy</div>
            </div>
          </div>
          <button
            onClick={() => setShowActivation(v => !v)}
            className="text-xs text-amber-400 border border-amber-500/40 rounded-lg px-3 py-1.5 hover:bg-amber-500/10 transition-all whitespace-nowrap"
          >
            {showActivation ? 'Hide steps' : 'Activate AI →'}
          </button>
        </div>

        {showActivation && (
          <div className="mt-4 border-t border-amber-500/20 pt-4">
            <p className="text-xs text-amber-300/80 font-medium mb-3">5 steps — no terminal needed, takes about 10 minutes</p>
            <div className="space-y-3">
              {[
                { n: 1, title: 'Get your Anthropic API key', detail: 'Go to console.anthropic.com → API Keys → Create Key. Copy it.' },
                { n: 2, title: 'Open your Supabase project', detail: 'Go to app.supabase.com → open this project → Edge Functions in the left sidebar.' },
                { n: 3, title: 'Add the API key as a secret', detail: 'In Edge Functions → Secrets → Add new secret. Name: ANTHROPIC_API_KEY. Value: paste your key.' },
                { n: 4, title: 'Deploy workforce-chat', detail: 'Click "Deploy a new function" → upload supabase/functions/workforce-chat/index.ts from this codebase.' },
                { n: 5, title: 'Test it', detail: 'Open the Customer Portal and send a message. A confidence score in the response confirms the LLM is live.' },
              ].map(step => (
                <div key={step.n} className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{step.n}</div>
                  <div>
                    <div className="text-xs font-semibold text-white">{step.title}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{step.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 bg-slate-900/60 rounded-lg p-3 text-xs text-slate-400">
              Once deployed, Digital Employees switch from rule-based scoring to real Claude Haiku with KB retrieval. Confidence scoring, approval routing, and conversation memory all activate automatically — no other code changes needed.
            </div>
          </div>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <svg viewBox="0 0 480 420" className="w-full" style={{ maxHeight: '360px' }}>
          {edges.map((e, i) => {
            const from = getNode(e[0]);
            const to = getNode(e[1]);
            const active = (tick + i) % 3 === 0;
            return (
              <line
                key={i}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={active ? accentColor : '#334155'}
                strokeWidth={active ? 2 : 1}
                opacity={active ? 0.8 : 0.3}
                strokeDasharray={active ? '4 2' : 'none'}
              />
            );
          })}
          {nodes.map((node) => (
            <g key={node.id}>
              <circle cx={node.x} cy={node.y} r={node.size} fill={node.color} opacity="0.15" />
              <circle
                cx={node.x}
                cy={node.y}
                r={node.size - 4}
                fill={node.color}
                opacity="0.3"
                stroke={node.color}
                strokeWidth="1.5"
              />
              <text x={node.x} y={node.y + 5} textAnchor="middle" fontSize={node.size === 28 ? '12' : '10'} fill="white">
                AI
              </text>
              <text x={node.x} y={node.y + node.size + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse flex-shrink-0" />
          <span className="text-sm text-slate-300">{liveEvents[eventIdx]}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {nodes
          .filter((n) => n.id !== 'hub')
          .map((node, i) => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
              <div
                className="w-8 h-8 rounded-full mx-auto mb-2"
                style={{
                  backgroundColor: node.color + '30',
                  border: '1px solid ' + node.color + '60',
                }}
              />
              <div className="text-xs font-medium text-white mb-1">
                {node.label.replace(' Agent', '')}
              </div>
              <div className="flex items-center justify-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-emerald-400">Active</span>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
};

export default SwarmPage;
