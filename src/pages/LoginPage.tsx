import React, { useState } from 'react';
import { supabase } from '../supabase';
import type { AuthUser } from '../types';
import { Spinner } from '../components';
import { mockUsers } from '../lib/mockData';

const LoginPage = ({ onLogin }: { onLogin: (u: AuthUser) => void }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const demoAccounts = [
    {
      group: 'DreamTeam Platform',
      users: [mockUsers[0], mockUsers[1], mockUsers[2], mockUsers[3]],
    },
    {
      group: 'Tenant: Acme Corp',
      users: [mockUsers[4], mockUsers[5], mockUsers[6], mockUsers[7]],
    },
    { group: 'Other Tenants', users: [mockUsers[8], mockUsers[9]] },
  ];

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        setError(authError.message);
      } else if (authData.user) {
        onLogin({
          id: authData.user.id,
          name: authData.user.user_metadata?.full_name || authData.user.email || 'User',
          email: authData.user.email || '',
          role: (authData.user.user_metadata?.role || 'tenant_admin') as any,
          tenantId: authData.user.user_metadata?.tenant_id || null,
          avatar: authData.user.user_metadata?.avatar || '',
          layer: (authData.user.user_metadata?.layer || 'tenant') as any,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex">
      <div
        className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)',
        }}
      >
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-20 w-64 h-64 rounded-full bg-indigo-500 blur-3xl" />
          <div className="absolute bottom-20 right-20 w-48 h-48 rounded-full bg-purple-500 blur-3xl" />
        </div>
        <div className="relative">
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-white font-bold">
              DT
            </div>
            <div>
              <div className="text-white font-bold text-lg">DreamTeam AI</div>
              <div className="text-indigo-300 text-xs">
                Agentic Intelligence Platform
              </div>
            </div>
          </div>
          <h1 className="text-4xl font-bold text-white mb-4 leading-tight">
            AI agents that work
            <br />
            for you 24/7
          </h1>
          <p className="text-indigo-200 text-sm leading-relaxed mb-8">
            Knowledge base and configurable AI agents that serve your customers
            and internal staff equally — with full audit trails and
            human-in-the-loop controls.
          </p>
          <div className="space-y-4">
            {[
              {
                label: 'Unified Knowledge Base',
                desc: 'One source of truth for customers and staff',
              },
              {
                label: 'Configurable AI Agents',
                desc: 'Agents that act on behalf of your customers',
              },
              {
                label: 'Human-in-the-Loop',
                desc: 'Approval flows and confidence gates built in',
              },
            ].map((f, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-indigo-300 flex-shrink-0 font-bold">
                  {String(i + 1)}
                </div>
                <div>
                  <div className="text-white text-sm font-medium">
                    {f.label}
                  </div>
                  <div className="text-indigo-300 text-xs">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-xs text-indigo-400">
          © 2026 DreamTeam AI · Built for enterprise-grade security · Demo environment
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center p-8 lg:p-16">
        <div className="max-w-sm mx-auto w-full">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">
              DT
            </div>
            <span className="text-white font-bold">DreamTeam AI</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">Welcome back</h2>
          <p className="text-slate-400 text-sm mb-8">
            Sign in to your workspace
          </p>
          <div className="space-y-4 mb-6">
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">
                Email
              </label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                type="email"
                placeholder="you@company.com"
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">
                Password
              </label>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                type="password"
                placeholder="..."
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={() => handleLogin()}
              disabled={loading}
              className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Spinner /> Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </div>
          <div className="border-t border-slate-800 pt-5">
            <p className="text-xs text-slate-500 mb-3">
              Demo accounts — click to log in instantly:
            </p>
            <div className="space-y-4">
              {demoAccounts.map((group, gi) => (
                <div key={gi}>
                  <p className="text-xs text-slate-600 uppercase tracking-wider mb-2">
                    {group.group}
                  </p>
                  <div className="space-y-1">
                    {group.users.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => onLogin(u)}
                        className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-800 transition-all text-left"
                      >
                        <div className="w-7 h-7 rounded-full bg-indigo-600/50 flex items-center justify-center text-xs font-bold text-indigo-300 flex-shrink-0">
                          {u.avatar}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-white truncate">
                            {u.name}
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            {u.role.replace(/_/g, ' ')}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
