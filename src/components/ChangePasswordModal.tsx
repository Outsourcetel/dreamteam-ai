import React, { useState } from 'react';
import { supabase } from '../supabase';
import { Spinner } from './index';
import { Modal } from '../design/primitives';

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
    <Modal title="Change password" onClose={onClose} size="sm">
      <>
        {done ? (
          <div className="text-center py-2">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center text-2xl mx-auto mb-3">✓</div>
            <p className="text-sm text-dt-title mb-4">Password updated.</p>
            <button onClick={onClose} className="w-full py-2.5 text-sm font-medium rounded-xl bg-dt-accent-strong hover:bg-dt-accent-hover text-white transition-all">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-dt-support block mb-1.5">Current password</label>
              <input value={current} onChange={(e) => setCurrent(e.target.value)} type="password" placeholder="Your current password" autoComplete="current-password" autoFocus
                className="w-full bg-dt-panel border border-dt-border-strong text-dt-body text-sm rounded-xl px-3 py-2.5 placeholder-slate-500 focus:outline-none focus:border-dt-accent" />
            </div>
            <div>
              <label className="text-xs font-medium text-dt-support block mb-1.5">New password</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="8+ characters" autoComplete="new-password"
                className="w-full bg-dt-panel border border-dt-border-strong text-dt-body text-sm rounded-xl px-3 py-2.5 placeholder-slate-500 focus:outline-none focus:border-dt-accent" />
            </div>
            <div>
              <label className="text-xs font-medium text-dt-support block mb-1.5">Confirm password</label>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" placeholder="Retype the password"
                className="w-full bg-dt-panel border border-dt-border-strong text-dt-body text-sm rounded-xl px-3 py-2.5 placeholder-slate-500 focus:outline-none focus:border-dt-accent" />
            </div>
            {error && <p className="text-xs text-rose-400">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full py-2.5 text-sm font-medium rounded-xl bg-dt-accent-strong hover:bg-dt-accent-hover text-white disabled:opacity-60 transition-all flex items-center justify-center gap-2">
              {loading ? <><Spinner /> Saving...</> : 'Save new password'}
            </button>
          </form>
        )}
      </>
    </Modal>
  );
};

export default ChangePasswordModal;
