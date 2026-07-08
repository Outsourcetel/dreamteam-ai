import React, { useState } from 'react';
import { Spinner } from '../components';

// ─────────────────────────────────────────────────────────────────
// Shown instead of the normal app whenever Supabase's client detects a
// password-recovery link (self-requested via LoginPage's "Forgot
// password?" or an admin-triggered reset from a team roster) — see
// AuthContext's passwordRecoveryActive. Sets the new password directly
// on the recovery session; no old password needed, matching every
// standard "reset via emailed link" flow.
// ─────────────────────────────────────────────────────────────────
const ResetPasswordScreen = ({ onComplete }: {
  onComplete: (newPassword: string) => Promise<{ ok: boolean; error?: string }>;
}) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    const res = await onComplete(password);
    setLoading(false);
    if (!res.ok) { setError(res.error || 'Could not set the new password. The link may have expired — request a new one.'); return; }
    setDone(true);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8">
      <div className="max-w-sm w-full">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">DT</div>
          <span className="text-white font-bold">DreamTeam AI</span>
        </div>

        {done ? (
          <div className="text-center py-4">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
            <h2 className="text-xl font-bold text-white mb-2">Password updated</h2>
            <p className="text-slate-400 text-sm leading-relaxed">You're signed in with your new password.</p>
          </div>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-white mb-1">Set a new password</h2>
            <p className="text-slate-400 text-sm mb-6">Choose a new password for your account.</p>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">New password</label>
                <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="8+ characters" autoFocus
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Confirm password</label>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" placeholder="Retype the password"
                  className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-4 py-3 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button type="submit" disabled={loading}
                className="w-full py-3 text-white text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-all flex items-center justify-center gap-2">
                {loading ? <><Spinner /> Saving...</> : 'Set new password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default ResetPasswordScreen;
