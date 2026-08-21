/**
 * SetPasswordScreen — the step an invited person never got.
 *
 * THE BUG THIS FIXES
 * invite-team-member calls inviteUserByEmail(), which creates the auth user
 * with NO PASSWORD and emails a one-time link. The link signed the person in
 * and dropped them straight into the app — and nothing ever asked them to
 * choose a password. So the moment that link was spent they could not get back
 * in, and there was no password for them to have written down.
 *
 * To be clear about what was NOT wrong: there was never a default password.
 * Nothing was set, so nothing was guessable and no account was exposed. The
 * defect was the missing step, not a weak secret.
 *
 * HOW AN INVITE IS DETECTED
 * Supabase returns from the invite link with `type=invite` (or `type=recovery`
 * for a reset) in the URL fragment, alongside the tokens it uses to establish
 * the session. That fragment is the only reliable signal that this session came
 * from a link rather than from someone typing a password they already know.
 *
 * ⚠ THE FRAGMENT IS READ ONCE, ON LOAD, BEFORE ANYTHING CLEARS IT.
 * Supabase's client strips the hash after it consumes the tokens, and React
 * Router rewrites the URL. Reading it late reads nothing. So it is captured at
 * module load — the earliest moment available — and held in a module constant.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not claim to know whether an ARBITRARY account has a password.
 * Supabase does not expose that, and inventing a heuristic ("no last sign-in",
 * "created recently") would eventually trap a real user in a password screen
 * they cannot dismiss. This fires only on the one signal that actually means
 * "you arrived by link": if somebody reloads past it, they still have the
 * working escape hatch below.
 */
import React, { useState } from 'react';
import { supabase } from '../supabase';

/**
 * Captured at module load, before Supabase consumes the hash or the router
 * rewrites it. See the note above — reading this lazily reads an empty string.
 */
let ARRIVED_BY_LINK = (() => {
  try {
    const h = window.location.hash ?? '';
    return /type=(invite|recovery|signup)/.test(h);
  } catch {
    return false;
  }
})();

export const arrivedByInviteLink = () => ARRIVED_BY_LINK;

/**
 * Cleared once a password is saved. A module flag rather than React state on
 * purpose: the check sits AFTER early returns in App, and a hook there would
 * break the rules-of-hooks ordering. The flag is per page-load, which matches
 * the signal it represents — you arrived by link on THIS load.
 */
export const markPasswordSet = () => { ARRIVED_BY_LINK = false; };

export default function SetPasswordScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deliberately mild: Supabase enforces its own minimum server-side, and a
  // long list of rules on the screen a new colleague meets first is a bad
  // welcome. The server's own complaint is shown verbatim if it objects.
  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSubmit = pw.length >= 8 && pw === confirm && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (err) { setError(err.message); return; }
    markPasswordSet();
    onDone();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dt-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-dt-title">Choose a password</h1>
          <p className="text-sm text-dt-support mt-2">
            You signed in through an invite link. That link only works once, so pick a password now —
            it is how you will get back in.
          </p>
        </div>

        <form onSubmit={submit} className="bg-dt-card border border-dt-border rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-xs text-dt-support mb-1">New password</label>
            <input
              type="password" value={pw} onChange={e => setPw(e.target.value)}
              autoFocus autoComplete="new-password"
              className="w-full bg-dt-inset border border-dt-border rounded-lg px-3 py-2 text-sm text-dt-body"
            />
            {tooShort && <p className="text-xs text-amber-300 mt-1">At least 8 characters.</p>}
          </div>

          <div>
            <label className="block text-xs text-dt-support mb-1">Confirm password</label>
            <input
              type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-dt-inset border border-dt-border rounded-lg px-3 py-2 text-sm text-dt-body"
            />
            {mismatch && <p className="text-xs text-amber-300 mt-1">These do not match.</p>}
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit" disabled={!canSubmit}
            className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium"
          >
            {busy ? 'Saving…' : 'Save password and continue'}
          </button>
        </form>

        {/* The escape hatch, stated rather than hidden. Somebody who reloads past
            this screen, or closes it, is not locked out — "Forgot password" on
            the sign-in page sends a fresh link. Saying so here means a confused
            person has an answer instead of a support ticket. */}
        <p className="text-xs text-dt-muted mt-4 text-center">
          If you skip this, use <span className="text-dt-support">Forgot password</span> on the sign-in
          page to set one later.
        </p>
      </div>
    </div>
  );
}
