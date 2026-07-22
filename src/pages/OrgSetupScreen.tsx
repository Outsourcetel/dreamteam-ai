import React, { useEffect, useState } from 'react';
import { completeSignup } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabase';
import { Spinner } from '../components';

import { INDUSTRY_NAMES as INDUSTRIES } from '../lib/industries';

/**
 * Shown when AuthContext detects a genuinely authenticated, confirmed user
 * whose profile has no tenant_id yet — i.e. the signup flow created their
 * login but never finished provisioning their organization. This is the
 * ONLY correct place that gap gets closed: it calls the complete_signup
 * RPC (migration 049), which creates the tenant server-side and links it to
 * the caller's own profile.
 *
 * This must never be confused with CompanySetupPage (the "tell us about
 * your company" wizard shown to already-tenanted users on their very first
 * login) — this screen runs strictly before that, for accounts that have
 * no organization at all yet.
 */
export default function OrgSetupScreen() {
  const { authedUser, completeOrgSetup, handleLogout } = useAuth();

  const [orgName, setOrgName] = useState('');
  const [industry, setIndustry] = useState(INDUSTRIES[0]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Pre-fill from whatever the signup form's user was typed in
  // (stashed as pending_org_name / pending_industry on auth user_metadata
  // at signUp() time) — a nice-to-have, never required.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (!active) return;
      const meta = data.user?.user_metadata || {};
      if (meta.pending_org_name) setOrgName(meta.pending_org_name);
      if (meta.pending_industry && INDUSTRIES.includes(meta.pending_industry)) {
        setIndustry(meta.pending_industry);
      }
    })();
    return () => { active = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!orgName.trim()) {
      setError('Please enter your organization name.');
      return;
    }
    setLoading(true);
    try {
      const res = await completeSignup(orgName.trim(), industry);
      if (!res.ok || !res.tenant_id) {
        setError(res.detail || res.error || 'Could not set up your organization. Please try again.');
        return;
      }
      await completeOrgSetup(res.tenant_id);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dt-page flex items-center justify-center p-8">
      <div className="max-w-sm w-full">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold">DT</div>
          <div>
            <div className="text-white font-bold text-lg">DreamTeam AI</div>
            <div className="text-indigo-300 text-xs">Digital Workforce Platform</div>
          </div>
        </div>

        <h2 className="text-2xl font-bold text-white mb-1 text-center">One last step</h2>
        <p className="text-dt-support text-sm mb-6 text-center leading-relaxed">
          Your email is confirmed. Let's set up your organization so you can start using your workspace.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-dt-support block mb-1.5">Organization Name</label>
            <input
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              type="text"
              placeholder="Acme Corp"
              autoFocus
              className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-dt-support block mb-1.5">Industry</label>
            <select
              value={industry}
              onChange={e => setIndustry(e.target.value)}
              className="w-full bg-dt-panel border border-dt-border-strong text-white text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500"
            >
              {INDUSTRIES.map(i => <option key={i}>{i}</option>)}
            </select>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
          >
            {loading ? <><Spinner /> Setting up your workspace...</> : 'Create My Workspace'}
          </button>
        </form>

        <div className="border-t border-dt-border mt-6 pt-5 text-center">
          <p className="text-xs text-dt-faint">
            Signed in as {authedUser?.email}.{' '}
            <button
              onClick={() => { void (async () => { await handleLogout(); })(); }}
              className="text-indigo-400 hover:text-indigo-300 underline"
            >
              Sign out
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
