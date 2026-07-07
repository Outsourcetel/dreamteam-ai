import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { redeemPlatformInvite } from '../lib/api';
import { Spinner } from '../components';

/**
 * Entry point for a platform-invite link (/platform/redeem?code=...).
 * Simple by design: if the person isn't logged in yet, they're told to
 * sign in (or create an account first, via the ordinary tenant signup
 * flow — there is no separate signup path for platform invites, by
 * design, so email confirmation is never bypassed) and come back to this
 * same link afterward. Once logged in, a single confirmation screen
 * calls redeem_platform_invite.
 */
export default function PlatformInviteRedeemPage({ code }: { code: string }) {
  const { authedUser, handleLogout } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ role: string } | null>(null);

  const handleAccept = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await redeemPlatformInvite(code);
      if (!res.ok) {
        setError(res.error || 'Could not accept this invitation.');
        return;
      }
      setDone({ role: res.role || 'platform team member' });
      // Force a full reload so AuthContext re-reads the now-promoted
      // profile (layer=platform) from scratch and routes into Platform
      // Console, rather than trying to patch every derived bit of state
      // by hand from here.
      setTimeout(() => { window.location.href = '/platform'; }, 1800);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8">
      <div className="max-w-sm w-full">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold">DT</div>
          <div>
            <div className="text-white font-bold text-lg">DreamTeam AI</div>
            <div className="text-indigo-300 text-xs">Digital Workforce Platform</div>
          </div>
        </div>

        {!authedUser ? (
          <>
            <h2 className="text-2xl font-bold text-white mb-1 text-center">Platform invitation</h2>
            <p className="text-slate-400 text-sm mb-6 text-center leading-relaxed">
              Sign in (or create an account) first, then come back to this same link to accept your
              invitation.
            </p>
            <a
              href={'/'}
              className="block w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 transition-all text-center"
            >
              Go to sign in
            </a>
          </>
        ) : done ? (
          <div className="text-center py-4">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
            <h2 className="text-xl font-bold text-white mb-2">You're in</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Taking you to the Platform Console…
            </p>
          </div>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-white mb-1 text-center">Accept platform invitation</h2>
            <p className="text-slate-400 text-sm mb-6 text-center leading-relaxed">
              You're signed in as {authedUser.email}. Accepting this invitation will give this account
              platform-level access — above any single tenant.
            </p>
            {error && <p className="text-xs text-red-400 mb-4 text-center">{error}</p>}
            <button
              onClick={handleAccept}
              disabled={loading}
              className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
            >
              {loading ? <><Spinner /> Accepting...</> : 'Accept platform invitation'}
            </button>
            <div className="border-t border-slate-800 mt-6 pt-5 text-center">
              <p className="text-xs text-slate-600">
                Wrong account?{' '}
                <button
                  onClick={() => { void (async () => { await handleLogout(); })(); }}
                  className="text-indigo-400 hover:text-indigo-300 underline"
                >
                  Sign out
                </button>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
