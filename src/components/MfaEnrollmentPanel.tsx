import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase';

// Real two-factor enrollment, wired to Supabase's own MFA system
// (supabase.auth.mfa.*) -- not the hardcoded demo toggle that used to be
// the only "MFA" anywhere in this app (SecurityAccessPage's HUMAN_USERS
// mock list). Remote Access is gated server-side (migration 061,
// start_platform_remote_access) to require a verified factor the moment
// one exists for the calling account -- this screen is what makes that
// possible to actually turn on.

type Factor = { id: string; friendly_name: string | null; factor_type: string; status: string };

const MfaEnrollmentPanel = () => {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [pendingFactorId, setPendingFactorId] = useState('');
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [removingId, setRemovingId] = useState('');

  const loadFactors = useCallback(async () => {
    setLoading(true);
    const { data, error: listErr } = await supabase.auth.mfa.listFactors();
    if (listErr) {
      setError(listErr.message);
    } else {
      setFactors((data?.totp ?? []) as Factor[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadFactors(); }, [loadFactors]);

  const verifiedFactor = factors.find((f) => f.status === 'verified');

  const startEnroll = async () => {
    setError('');
    setEnrolling(true);
    const { data, error: enrollErr } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    setEnrolling(false);
    if (enrollErr) { setError(enrollErr.message); return; }
    setPendingFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
  };

  const cancelEnroll = async () => {
    if (pendingFactorId) {
      await supabase.auth.mfa.unenroll({ factorId: pendingFactorId });
    }
    setPendingFactorId('');
    setQrCode('');
    setSecret('');
    setCode('');
    setError('');
  };

  const verifyCode = async () => {
    setError('');
    if (code.trim().length !== 6) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setVerifying(true);
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: pendingFactorId });
    if (challengeErr) { setVerifying(false); setError(challengeErr.message); return; }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId: pendingFactorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setVerifying(false);
    if (verifyErr) { setError('That code didn\'t match. Check your authenticator app and try again.'); return; }
    setPendingFactorId('');
    setQrCode('');
    setSecret('');
    setCode('');
    await loadFactors();
  };

  const removeFactor = async (factorId: string) => {
    setError('');
    setRemovingId(factorId);
    const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId });
    setRemovingId('');
    if (unenrollErr) { setError(unenrollErr.message); return; }
    await loadFactors();
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-900 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Two-Factor Authentication</h1>
        <p className="text-slate-400 text-sm mt-1">
          An extra code from your phone, required before you can open Remote Access into any tenant's workspace.
        </p>
      </div>

      {loading ? (
        <div className="text-slate-500 text-sm">Checking your account…</div>
      ) : verifiedFactor ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-lg">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            <span className="text-sm font-medium text-white">Two-factor authentication is on</span>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Remote Access now requires a verified code from your authenticator app before it will let you
            into a tenant's workspace.
          </p>
          <button
            onClick={() => removeFactor(verifiedFactor.id)}
            disabled={removingId === verifiedFactor.id}
            className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-50"
          >
            {removingId === verifiedFactor.id ? 'Removing…' : 'Turn off two-factor authentication'}
          </button>
        </div>
      ) : pendingFactorId ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-lg space-y-4">
          <div>
            <p className="text-sm font-medium text-white mb-2">1. Scan this with your authenticator app</p>
            <p className="text-xs text-slate-500 mb-3">Google Authenticator, Authy, 1Password, or any TOTP app.</p>
            {qrCode && (
              <div
                className="bg-white rounded-lg p-3 inline-block"
                dangerouslySetInnerHTML={{ __html: qrCode }}
              />
            )}
            <p className="text-[11px] text-slate-600 mt-2">
              Can't scan it? Enter this code manually: <span className="font-mono text-slate-400">{secret}</span>
            </p>
          </div>
          <div>
            <p className="text-sm font-medium text-white mb-2">2. Enter the 6-digit code it shows you</p>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono tracking-widest w-32 text-center"
              />
              <button
                onClick={verifyCode}
                disabled={verifying || code.length !== 6}
                className="px-4 py-2 text-sm font-medium rounded-lg text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
              >
                {verifying ? 'Verifying…' : 'Verify and turn on'}
              </button>
              <button
                onClick={cancelEnroll}
                className="px-3 py-2 text-sm text-slate-400 hover:text-slate-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 max-w-lg">
          <p className="text-sm text-white mb-1">Two-factor authentication is off</p>
          <p className="text-xs text-slate-500 mb-4">
            Remote Access works without it today, but adding a second factor closes the one real gap
            left on this account.
          </p>
          <button
            onClick={startEnroll}
            disabled={enrolling}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50"
          >
            {enrolling ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 mt-3 max-w-lg">{error}</p>
      )}
    </div>
  );
};

export default MfaEnrollmentPanel;
