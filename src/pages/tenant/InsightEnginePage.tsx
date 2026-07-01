import React, { useState } from 'react';
import type { AuthUser, Tenant, Page } from '../../types';
import { Badge, StatCard, Spinner } from '../../components';

const InsightEnginePage = ({
  user,
  tenant,
}: {
  user?: AuthUser;
  tenant?: Tenant;
}) => {
  const accentColor = tenant?.primaryColor || '#6366f1';
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  const [activeTab, setActiveTab] = useState<'query' | 'history' | 'usage'>('query');

  const models = [
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', tokens: '128k', best: 'Reasoning and analysis' },
    { id: 'claude-3-5', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', tokens: '200k', best: 'Long documents' },
    { id: 'gemini-1.5', name: 'Gemini 1.5 Pro', provider: 'Google', tokens: '1M', best: 'Multimodal tasks' },
    { id: 'llama-3', name: 'Llama 3 70B', provider: 'Self-hosted', tokens: '8k', best: 'Privacy-sensitive data' },
  ];

  const history = [
    { q: 'What were the top 5 customer complaints last quarter?', model: 'GPT-4o', tokens: 1842, time: '10 min ago' },
    { q: 'Summarise all HR policy changes in 2024', model: 'Claude 3.5 Sonnet', tokens: 5201, time: '2 hr ago' },
    { q: 'How does our refund rate compare to industry benchmarks?', model: 'GPT-4o', tokens: 2108, time: '1 day ago' },
    { q: 'Generate a weekly performance summary for the support team', model: 'GPT-4o', tokens: 3450, time: '2 days ago' },
    { q: 'What product features are customers asking for most?', model: 'Gemini 1.5 Pro', tokens: 1920, time: '3 days ago' },
  ];

  const runQuery = () => {
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    setTimeout(() => {
      setLoading(false);
      setResult(
        'Based on your knowledge base and connected data sources, here is a summary of findings. Your query has been analysed across 2,847 KB articles, 8,421 resolved tickets, and 4 connected data sources. Key finding: 67% of queries match existing KB articles with high confidence. Top content gaps identified: CSV export documentation, SSO setup guides. Customer satisfaction correlates strongly with first-response time. Recommendation: Adding 3 new articles in the identified gap areas could reduce escalation rate by an estimated 8 to 12%.'
      );
    }, 2000);
  };

  const usageData = [1200000, 1800000, 1400000, 2100000, 1950000, 2400000, 2200000];
  const usageLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Insight Engine</h1>
          <p className="text-slate-400 text-sm mt-1">
            Query your knowledge base, connected data, and AI models in natural language
          </p>
        </div>
      </div>

      <div className="flex gap-1 bg-slate-800 rounded-xl p-1 mb-6 w-fit">
        {(['query', 'history', 'usage'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize ${
              activeTab === t ? 'text-white' : 'text-slate-400 hover:text-white'
            }`}
            style={activeTab === t ? { backgroundColor: accentColor } : {}}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === 'query' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {models.map((m) => (
              <div
                key={m.id}
                onClick={() => setSelectedModel(m.id)}
                className={`p-3 rounded-xl border cursor-pointer transition-all bg-slate-900 ${
                  selectedModel === m.id
                    ? 'border-indigo-500'
                    : 'border-slate-800 hover:border-slate-700'
                }`}
                style={selectedModel === m.id ? { borderColor: accentColor } : {}}
              >
                <div className="text-sm font-medium text-white">{m.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{m.provider}</div>
                <div className="text-xs text-slate-600 mt-1">
                  {m.tokens} · {m.best}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <label className="text-xs font-medium text-slate-400 block mb-2">
              Ask a question about your data, customers, or knowledge base
            </label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. What were the most common customer complaints last month? or Which KB articles need updating?"
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-slate-500">
                Searches: KB Articles, Tickets, Conversations, Connected data sources
              </span>
              <button
                onClick={runQuery}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-60 transition-all"
                style={{ backgroundColor: accentColor }}
              >
                {loading ? (
                  <>
                    <Spinner /> Thinking...
                  </>
                ) : (
                  '> Run Query'
                )}
              </button>
            </div>
          </div>

          {result && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-emerald-400 text-sm">*</span>
                <span className="text-sm font-medium text-white">Insight Result</span>
                <Badge label={selectedModel} color="indigo" />
                <Badge label="987 tokens used" color="blue" />
              </div>
              <div className="text-sm text-slate-300 leading-relaxed">{result}</div>
              <div className="flex gap-3 mt-4">
                <button className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-800 rounded-lg">
                  Export as PDF
                </button>
                <button className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-800 rounded-lg">
                  Save to KB
                </button>
                <button className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-800 rounded-lg">
                  Share
                </button>
              </div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Suggested Queries</h2>
            <div className="flex flex-wrap gap-2">
              {[
                'What are the top 5 customer complaints this month?',
                'Summarise HR policy changes in 2024',
                'Which KB articles have the lowest helpfulness rating?',
                'What product features are customers requesting most?',
                'Identify content gaps in the knowledge base',
                'How is agent performance trending this week?',
              ].map((sq, i) => (
                <button
                  key={i}
                  onClick={() => setQuery(sq)}
                  className="text-xs px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl border border-slate-700 hover:border-slate-600 transition-all"
                >
                  {sq}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          {history.map((h, i) => (
            <div
              key={i}
              className={`flex items-start gap-4 px-5 py-4 hover:bg-slate-800/40 cursor-pointer transition-all ${
                i < history.length - 1 ? 'border-b border-slate-800' : ''
              }`}
              onClick={() => {
                setQuery(h.q);
                setActiveTab('query');
              }}
            >
              <span className="text-slate-500 mt-0.5 text-sm">*</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white mb-1 truncate">{h.q}</div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <Badge label={h.model} color="indigo" />
                  <span>{h.tokens.toLocaleString()} tokens</span>
                  <span>{h.time}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'usage' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Tokens This Month" value="2.4M" icon="🔥" color="blue" trend="48% of limit" />
            <StatCard label="Queries Run" value="847" icon="🔍" color="indigo" trend="+12% this week" />
            <StatCard label="Avg Tokens Per Query" value="2,840" icon="⚡" color="emerald" trend="" />
            <StatCard label="Cost Est MTD" value="$24.80" icon="💰" color="amber" trend="On track" />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Daily Token Usage Last 7 Days</h2>
            <div className="flex items-end gap-2 h-32">
              {usageData.map((v, i) => {
                const maxV = Math.max(...usageData);
                const pct = (v / maxV) * 100;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-xs text-slate-500">{(v / 1000000).toFixed(1)}M</span>
                    <div
                      className="w-full rounded-t"
                      style={{ height: pct + '%', backgroundColor: accentColor, opacity: 0.7 }}
                    />
                    <span className="text-xs text-slate-600">{usageLabels[i]}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Usage by Model</h2>
            <div className="space-y-3">
              {[
                { name: 'GPT-4o', pct: 58, tokens: '1.39M' },
                { name: 'Claude 3.5 Sonnet', pct: 27, tokens: '648K' },
                { name: 'Gemini 1.5 Pro', pct: 11, tokens: '264K' },
                { name: 'Llama 3 70B', pct: 4, tokens: '96K' },
              ].map((m, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{m.name}</span>
                    <span className="text-white">
                      {m.tokens} ({m.pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{ width: m.pct + '%', backgroundColor: accentColor }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InsightEnginePage;
