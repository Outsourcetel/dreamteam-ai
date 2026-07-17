import React, { useState } from 'react';
import { supabase } from '../supabase';
import type { AuthUser } from '../types';
import { Spinner } from '../components';

import { INDUSTRY_NAMES as INDUSTRIES } from '../lib/industries';

const LoginPage = ({
  onLogin,
  deactivatedMessage,
  clearDeactivatedMessage,
}: {
  onLogin: (u: AuthUser) => void | Promise<void>;
  deactivatedMessage?: string | null;
  clearDeactivatedMessage?: () => void;
}) => {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');

  // Sign-in state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Forgot-password state
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotError, setForgotError] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError('');
    if (!forgotEmail.trim()) { setForgotError('Enter your email address.'); return; }
    setForgotLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), {
      redirectTo: window.location.origin,
    });
    setForgotLoading(false);
    // Never reveal whether the email exists — same message either way,
    // so this can't be used to enumerate real accounts.
    if (resetError) { setForgotError(resetError.message); return; }
    setForgotSent(true);
  };

  // Sign-up state
  const [suFullName, setSuFullName] = useState('');
  const [suEmail, setSuEmail] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [suOrgName, setSuOrgName] = useState('');
  const [suIndustry, setSuIndustry] = useState(INDUSTRIES[0]);
  const [suError, setSuError] = useState('');
  const [suLoading, setSuLoading] = useState(false);
  const [suSuccess, setSuSuccess] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError('');
    if (clearDeactivatedMessage) clearDeactivatedMessage();
    setLoading(true);
    try {
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        setError(authError.message);
      } else if (authData.user) {
        // onLogin (AuthContext.handleLogin) checks profiles.is_active
        // before ever setting an authenticated session — if the account
        // is deactivated, it signs out immediately and sets
        // deactivatedMessage, which we render below instead of navigating
        // anywhere.
        await onLogin({
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

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuError('');
    if (!suFullName.trim() || !suEmail.trim() || !suPassword.trim() || !suOrgName.trim()) {
      setSuError('All fields are required.');
      return;
    }
    if (suPassword.length < 8) {
      setSuError('Password must be at least 8 characters.');
      return;
    }
    setSuLoading(true);
    try {
      // Create the auth user only. Organization (tenant) creation happens
      // AFTER the user confirms their email and logs in, via the
      // "Set up your organization" screen calling the complete_signup RPC
      // (see AuthContext's needsOrgSetup / OrgSetupScreen). We used to also
      // attempt a client-side `tenants` insert right here, but the tenants
      // table has never had an INSERT RLS policy (SELECT-only), so that
      // insert always silently failed — and because email confirmation is
      // required on this project, signUp() doesn't even return a usable
      // authenticated session at this point anyway. Attempting tenant
      // creation here was both unauthorized and premature; don't do it.
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: suEmail.trim(),
        password: suPassword,
        options: {
          data: {
            full_name: suFullName.trim(),
            role: 'tenant_owner',
            layer: 'tenant',
            // Carried through so the post-confirmation setup screen can
            // pre-fill the org name/industry the user already typed here,
            // even though it isn't used to create anything at this step.
            pending_org_name: suOrgName.trim(),
            pending_industry: suIndustry,
          },
        },
      });
      if (authError) throw authError;
      if (!authData.user?.id) throw new Error('User creation failed.');

      setSuSuccess(true);
    } catch (err: any) {
      setSuError(err.message || 'Registration failed. Please try again.');
    } finally {
      setSuLoading(false);
    }
  };

  const leftPanel = (
    <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 relative overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)' }}>
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-20 left-20 w-64 h-64 rounded-full bg-indigo-500 blur-3xl" />
        <div className="absolute bottom-20 right-20 w-48 h-48 rounded-full bg-purple-500 blur-3xl" />
      </div>
      <div className="relative">
        <div className="flex items-center gap-3 mb-16">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-white font-bold">DT</div>
          <div>
            <div className="text-white font-bold text-lg">DreamTeam AI</div>
            <div className="text-indigo-300 text-xs">Digital Workforce Platform</div>
          </div>
        </div>
        <h1 className="text-4xl font-bold text-white mb-4 leading-tight">
          Digital Employees that work<br />for you 24/7
        </h1>
        <p className="text-indigo-200 text-sm leading-relaxed mb-8">
          Knowledge base and Digital Employees that serve your customers and internal staff equally — with full audit trails and human-in-the-loop controls.
        </p>
        <div className="space-y-4">
          {[
            { label: 'Unified Knowledge Base', desc: 'One source of truth for customers and staff' },
            { label: 'Digital Employees', desc: 'Digital Employees that act on behalf of your customers' },
            { label: 'Human-in-the-Loop', desc: 'Approval flows and confidence gates built in' },
          ].map((f, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-indigo-300 flex-shrink-0 font-bold">{i + 1}</div>
              <div>
                <div className="text-white text-sm font-medium">{f.label}</div>
                <div className="text-indigo-300 text-xs">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="relative text-xs text-indigo-400">© 2026 DreamTeam AI · Enterprise-grade security</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-900 flex">
      {leftPanel}
      <div className="flex-1 flex flex-col justify-center p-8 lg:p-16">
        <div className="max-w-sm mx-auto w-full">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">DT</div>
            <span className="text-white font-bold">DreamTeam AI</span>
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 bg-slate-700 rounded-xl p-1 mb-6">
            <button onClick={() => setTab('signin')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${tab === 'signin' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              Sign In
            </button>
            <button onClick={() => setTab('signup')}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${tab === 'signup' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              Create Account
            </button>
          </div>

          {/* ── SIGN IN ── */}
          {tab === 'signin' && !showForgot && (
            <>
              <h2 className="text-2xl font-bold text-white mb-1">Welcome back</h2>
              <p className="text-slate-400 text-sm mb-6">Sign in to your workspace</p>
              {deactivatedMessage && (
                <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30">
                  <p className="text-xs text-red-300">{deactivatedMessage}</p>
                </div>
              )}
              <form onSubmit={handleLogin} className="space-y-4 mb-6">
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Email</label>
                  <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@company.com"
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-slate-400">Password</label>
                    <button type="button" onClick={() => { setShowForgot(true); setForgotEmail(email); setForgotSent(false); setForgotError(''); }}
                      className="text-xs text-indigo-400 hover:text-indigo-300 underline">
                      Forgot password?
                    </button>
                  </div>
                  <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="..."
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                </div>
                {error && <p className="text-xs text-red-400">{error}</p>}
                <button type="submit" disabled={loading}
                  className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2">
                  {loading ? <><Spinner /> Signing in...</> : 'Sign In'}
                </button>
              </form>
              <div className="border-t border-slate-700 pt-5 text-center">
                <p className="text-xs text-slate-600">
                  Don't have an account?{' '}
                  <button onClick={() => setTab('signup')} className="text-indigo-400 hover:text-indigo-300 underline">
                    Create your organization
                  </button>
                </p>
                {import.meta.env.DEV && (
                  <button
                    onClick={() => onLogin({ id: 'dev-demo-user', name: 'Demo User', email: 'demo@local.dev', role: 'tenant_admin', tenantId: 'demo-tenant' })}
                    className="mt-3 text-xs text-slate-500 hover:text-slate-300 underline"
                  >
                    Enter demo (local dev only)
                  </button>
                )}
              </div>
            </>
          )}

          {/* ── FORGOT PASSWORD ── */}
          {tab === 'signin' && showForgot && (
            <>
              {forgotSent ? (
                <div className="text-center py-4">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
                  <h2 className="text-xl font-bold text-white mb-2">Check your email</h2>
                  <p className="text-slate-400 text-sm mb-6 leading-relaxed">
                    If an account exists for {forgotEmail}, a password reset link is on its way.
                  </p>
                  <button onClick={() => setShowForgot(false)}
                    className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 transition-all">
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="text-2xl font-bold text-white mb-1">Reset your password</h2>
                  <p className="text-slate-400 text-sm mb-6">We'll email you a link to set a new one.</p>
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <div>
                      <label className="text-xs font-medium text-slate-400 block mb-1.5">Email</label>
                      <input value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} type="email" placeholder="you@company.com" autoFocus
                        className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                    </div>
                    {forgotError && <p className="text-xs text-red-400">{forgotError}</p>}
                    <button type="submit" disabled={forgotLoading}
                      className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2">
                      {forgotLoading ? <><Spinner /> Sending...</> : 'Send reset link'}
                    </button>
                    <button type="button" onClick={() => setShowForgot(false)}
                      className="w-full text-center text-xs text-slate-500 hover:text-slate-300 underline">
                      Back to sign in
                    </button>
                  </form>
                </>
              )}
            </>
          )}

          {/* ── SIGN UP ── */}
          {tab === 'signup' && !suSuccess && (
            <>
              <h2 className="text-2xl font-bold text-white mb-1">Create your organization</h2>
              <p className="text-slate-400 text-sm mb-6">Set up your Digital Workforce in minutes</p>
              <form onSubmit={handleSignUp} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Full Name</label>
                  <input value={suFullName} onChange={e => setSuFullName(e.target.value)} type="text" placeholder="Sarah Mitchell"
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Work Email</label>
                  <input value={suEmail} onChange={e => setSuEmail(e.target.value)} type="email" placeholder="you@company.com"
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Password</label>
                  <input value={suPassword} onChange={e => setSuPassword(e.target.value)} type="password" placeholder="8+ characters"
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div className="border-t border-slate-700 pt-4">
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Organization Name</label>
                  <input value={suOrgName} onChange={e => setSuOrgName(e.target.value)} type="text" placeholder="Acme Corp"
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-400 block mb-1.5">Industry</label>
                  <select value={suIndustry} onChange={e => setSuIndustry(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500">
                    {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
                  </select>
                </div>
                {suError && <p className="text-xs text-red-400">{suError}</p>}
                <button type="submit" disabled={suLoading}
                  className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2">
                  {suLoading ? <><Spinner /> Creating account...</> : 'Create Organization'}
                </button>
                <p className="text-xs text-slate-600 text-center">
                  By signing up you agree to DreamTeam's{' '}
                  <a href="/terms" className="text-indigo-400 hover:underline">terms of service</a>{' '}
                  and{' '}
                  <a href="/privacy" className="text-indigo-400 hover:underline">privacy policy</a>
                </p>
              </form>
            </>
          )}

          {/* ── SIGN UP SUCCESS ── */}
          {tab === 'signup' && suSuccess && (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
              <h2 className="text-xl font-bold text-white mb-2">Organization created</h2>
              <p className="text-slate-400 text-sm mb-6 leading-relaxed">
                Check your email to confirm your account, then sign in to access your workspace.
              </p>
              <button onClick={() => { setTab('signin'); setSuSuccess(false); setEmail(suEmail); }}
                className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 transition-all">
                Go to Sign In
              </button>
              {/* A lost/spam-filtered confirmation email must not strand the
                  signup — resend is the only self-serve recovery. */}
              <button
                onClick={async () => {
                  if (resendState === 'sending') return;
                  setResendState('sending');
                  const { error } = await supabase.auth.resend({ type: 'signup', email: suEmail });
                  setResendState(error ? 'error' : 'sent');
                }}
                className="w-full mt-3 py-2 text-xs text-slate-400 hover:text-white transition-colors">
                {resendState === 'sent' ? 'Confirmation email re-sent ✓'
                  : resendState === 'sending' ? 'Sending…'
                  : resendState === 'error' ? "Couldn't resend — try again in a minute"
                  : "Didn't get the email? Resend confirmation"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
