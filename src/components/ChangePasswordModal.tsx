import React, { useState } from 'react';
import { supabase } from '../supabase';
import { Spinner } from './index';

// ─────────────────────────────────────────────────────────────────
// Self-service "change my password" for an already-logged-in user —
// no email round-trip needed, unlike the forgot-password flow (which
// exists for when you're locked out entirely). Reusable from any
// account menu (platform MyAccountBadge, tenant Settings).
// ─────────────────────────────────────────────────────────────────
const ChangePasswordModal = ({ onClose }: { onClose: () => void }) => {
  const [current, setCurrent] = useState('');
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
    if (password === current) { setError('The new password must be different from the current one.'); return; }
    setLoading(true);
    // Re-verify the CURRENT password before allowing a change —
    // updateUser alone would let anyone at an unlocked screen take
    // over the account.
    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email;
    if (!email) { setLoading(false); setError('No live session — please sign in again first.'); return; }
    const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: current });
    if (reauthError) { setLoading(false); setError('Current password is incorrect.'); return; }
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) { setError(updateError.message); return; }
    // Best-effort audit — never blocks the change; skips cleanly for
    // accounts without a tenant (platform admins).
    try {
      const { appendAuditEvent } = await import('../lib/guardrailApi');
      await appendAuditEvent({
        actor: 'You', actor_type: 'human', category: 'access_control',
        action: 'Account password changed (self-serve, current password re-verified)',
        detail: { kind: 'password_change' },
      });
    } catch { /* noop */ }
    setDone(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-white font-semibold">Change password</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
        </div>
        {done ? (
          <div className="text-center py-2">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center text-2xl mx-auto mb-3">✓</div>
            <p className="text-sm text-white mb-4">Password updated.</p>
            <button onClick={onClose} className="w-full py-2.5 text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">Current password</label>
              <input value={current} onChange={(e) => setCurrent(e.target.value)} type="password" placeholder="Your current password" autoComplete="current-password" autoFocus
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">New password</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="8+ characters" autoComplete="new-password"
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1.5">Confirm password</label>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" placeholder="Retype the password"
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-xl px-3 py-2.5 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
            </div>
            {error && <p className="text-xs text-rose-400">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-60 transition-all flex items-center justify-center gap-2">
              {loading ? <><Spinner /> Saving...</> : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ChangePasswordModal;
