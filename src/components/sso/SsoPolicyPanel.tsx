/**
 * SsoPolicyPanel — the single-sign-on policy for this workspace.
 *
 * THE HONESTY PROBLEM THIS SCREEN LIVES INSIDE
 * GET /v1/projects/rfsvmhcqeiyrxivbmpel/config/auth returns saml_enabled = false,
 * because SAML is a Supabase Pro+ feature and the org is on the FREE plan. So
 * at the moment you are reading this, NOBODY CAN SIGN IN WITH SSO.
 *
 * An enterprise buyer who flips a toggle labelled "Require SSO", watches it
 * save, and later finds it never did anything has learned something far worse
 * about us than "they don't support SSO yet". So this screen refuses to speak
 * in one voice about two different states, and instead says, per control, what
 * IS in force today and what is stored and waiting.
 *
 * AND — the part that took reading the migration to get right — "waiting" is
 * NOT the same as "inert". supabase/migrations/374_sso_policy_jit.sql
 * deliberately gave both switches teeth that work with saml_enabled still
 * false:
 *   · jit_enabled is checked by jit_decide_internal before any account is
 *     created (374:409-411), so turning it OFF blocks automatic provisioning
 *     TODAY.
 *   · sso_required makes jit_decide_internal refuse to provision anyone who did
 *     not arrive via SSO (374:416-419) — real, enforced, right now.
 *   · what sso_required does NOT do today is stop an EXISTING user signing in
 *     with a password. 374's own column comment says so: GoTrue owns password
 *     login, not this database. The database exposes sso_login_compliance() so
 *     the app can eject such a session, and `grep -rn sso_login_compliance src/`
 *     returns nothing — the app does not call it yet. That gap is stated on
 *     screen rather than left for a buyer to discover.
 *
 * THE LOCKOUT GUARD, SIZED TO THE REAL RISK
 * An earlier draft of this panel hard-blocked "Require SSO" until SSO was live.
 * Reading 374 showed that to be wrong: configuring in advance is exactly what
 * the backend was built to support, and blocking it would make the panel lie in
 * the other direction. So the guard is now:
 *   · Require SSO is savable, behind an explicit acknowledgement, with the
 *     current effect and the future effect both spelled out.
 *   · Automatic creation IS blocked with zero verified domains, because that
 *     combination is structurally inert — jit_decide_internal returns
 *     'no_verified_domain' (374:382) — and a switch that cannot do anything is
 *     worse than a switch that is honestly unavailable.
 *
 * THE ROLE STORY — TWO ROLES, BOTH ENFORCED
 * jit_default_role is CHECK-constrained to ('tenant_user','tenant_admin')
 * (374:170-171), so owner and platform roles are structurally unreachable by
 * automatic provisioning. 'tenant_user' is a real least-privilege level, not a
 * label: 374 measured 232 of 332 RLS policies gating on membership alone and 34
 * additionally requiring owner/admin. This matters because the readiness audit
 * flagged "UI advertises 7 roles, database enforces 3" as a defect — this panel
 * offers two, and both are enforced.
 *
 * Not mounted anywhere yet — routing is the orchestrator's call after review.
 */
import React, { useEffect, useState } from 'react';
import { Banner, Button, Chip, PanelCard } from '../../design/primitives';
import {
  ADMIN_LEVEL_ROLES, describeSsoError, formatWhen, getSsoPolicy, JIT_ROLE_DETAIL,
  JIT_ROLE_LABELS, JIT_ROLES, setSsoPolicy, SSO_KIND_GUIDANCE, type SsoPolicy,
} from '../../lib/ssoApi';

/* ── Switch — a real checkbox, styled. Custom div-with-onClick switches are
   invisible to keyboards and screen readers, and app-wide a11y here is near
   zero, so this sets the example rather than adding to the debt. ─────────── */
function Switch({ id, checked, onChange, disabled, label, description }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
  label: string; description: React.ReactNode;
}) {
  return (
    <div className={`flex items-start gap-3 ${disabled ? 'opacity-60' : ''}`}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-desc`}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded accent-[var(--dt-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dt-accent"
      />
      <div className="min-w-0">
        <label htmlFor={id} className={`block text-sm font-medium text-dt-body ${disabled ? '' : 'cursor-pointer'}`}>
          {label}
        </label>
        <div id={`${id}-desc`} className="text-xs text-dt-support mt-0.5 space-y-1">{description}</div>
      </div>
    </div>
  );
}

/** One line of the readiness strip: a fact, and what it means here. */
function ReadinessRow({ tone, label, value, detail }: {
  tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string; value: string; detail: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 border-b border-dt-border last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-dt-muted w-36 shrink-0">{label}</span>
      <Chip tone={tone} dot>{value}</Chip>
      <span className="text-xs text-dt-support flex-1 min-w-[14rem]">{detail}</span>
    </div>
  );
}

type Draft = { sso_required: boolean; jit_enabled: boolean; jit_default_role: string };

export default function SsoPolicyPanel() {
  const [saved, setSaved] = useState<SsoPolicy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; kind: string; detail: string } | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; kind: string; detail: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [acceptRequire, setAcceptRequire] = useState(false);
  const [announce, setAnnounce] = useState('');

  const adopt = (p: SsoPolicy) => {
    setSaved(p);
    setDraft({ sso_required: p.sso_required, jit_enabled: p.jit_enabled, jit_default_role: p.jit_default_role });
  };

  useEffect(() => {
    let alive = true;
    getSsoPolicy()
      .then(p => { if (alive) adopt(p); })
      .catch(err => {
        console.error('SsoPolicyPanel.getSsoPolicy:', err);
        if (alive) setLoadError(describeSsoError(err));
      });
    return () => { alive = false; };
  }, []);

  const ssoLive = saved?.sso_login_live === true;
  const verified = saved?.verified_domains.length ?? 0;

  // Blocked because it is structurally inert, not because we disapprove:
  // jit_decide_internal refuses with 'no_verified_domain' when nothing is
  // verified (374:382), so the switch could not do anything if it were on.
  const canEnableJit = verified > 0;
  const turningOnRequire = !!draft?.sso_required && !saved?.sso_required;

  const dirty = !!saved && !!draft && (
    draft.sso_required !== saved.sso_required ||
    draft.jit_enabled !== saved.jit_enabled ||
    draft.jit_default_role !== saved.jit_default_role
  );
  const canSave = dirty && !saving && (!turningOnRequire || acceptRequire);

  const save = async () => {
    if (!draft || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await setSsoPolicy(draft);
      adopt(next);
      setAcceptRequire(false);
      setAnnounce(ssoLive
        ? 'Single sign-on policy saved and in force.'
        : 'Single sign-on policy saved. Automatic account creation follows it immediately; the sign-in requirement takes full effect when SSO sign-in is switched on.');
    } catch (err) {
      console.error('SsoPolicyPanel.setSsoPolicy:', err);
      setSaveError(describeSsoError(err));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (saved) adopt(saved);
    setAcceptRequire(false);
    setSaveError(null);
  };

  return (
    <PanelCard
      title="Single sign-on"
      badge={saved ? <Chip tone={ssoLive ? 'ok' : 'warn'} dot>{ssoLive ? 'SSO sign-in live' : 'SSO sign-in not live yet'}</Chip> : undefined}
    >
      <div className="space-y-5">

        {/* ── The honesty banner. First thing on the page, deliberately. ── */}
        {saved && !ssoLive && (
          <Banner tone="warn">
            <p className="font-medium">SSO sign-in is not switched on for this platform yet</p>
            <p className="mt-1 text-dt-body">
              Nobody can sign in through an identity provider right now. Everyone continues signing in the way they
              do today. We are telling you this on the screen that sells you the feature, because finding out later
              would be worse.
            </p>
            <p className="mt-1.5 text-dt-support">
              What you set here is still worth setting. The rules below about <strong className="text-dt-body">who
              gets an account created automatically</strong> are enforced today. The rule about{' '}
              <strong className="text-dt-body">how people sign in</strong> is stored and waits.
            </p>
          </Banner>
        )}

        {loadError && (
          <Banner tone="danger">
            <p className="font-medium">Could not read your single sign-on settings.</p>
            <p className="mt-1 text-dt-body">{loadError.message}</p>
            <p className="mt-1 text-dt-support">{SSO_KIND_GUIDANCE[loadError.kind as keyof typeof SSO_KIND_GUIDANCE]}</p>
            {loadError.detail && loadError.detail !== loadError.message && (
              <p className="mt-2 text-xs text-dt-muted break-words"><span className="uppercase tracking-wide">Server detail:</span> {loadError.detail}</p>
            )}
          </Banner>
        )}

        {/* ── Readiness: the facts that decide what is possible ─────────── */}
        {saved && (
          <div className="rounded-xl border border-dt-border bg-dt-inset px-4 py-1.5">
            <ReadinessRow
              tone={ssoLive ? 'ok' : 'warn'}
              label="SSO sign-in"
              value={ssoLive ? 'Live' : 'Not enabled'}
              detail={ssoLive
                ? 'People can sign in through your identity provider.'
                : 'Being enabled on our side. Everything on this page can be set up in advance.'}
            />
            <ReadinessRow
              tone={verified > 0 ? 'ok' : 'warn'}
              label="Verified domains"
              value={verified > 0 ? `${verified} verified` : 'None'}
              detail={verified > 0
                ? `People with an email at ${saved.verified_domains.slice(0, 3).join(', ')}${verified > 3 ? ` and ${verified - 3} more` : ''} can be matched to this workspace.`
                : 'Verify a company domain first — without one there is nobody for these rules to apply to.'}
            />
            <ReadinessRow
              tone={saved.configured ? 'neutral' : 'warn'}
              label="This policy"
              value={saved.configured ? 'Configured' : 'Not configured'}
              detail={saved.configured
                ? `Last changed ${formatWhen(saved.updated_at)}.`
                : 'Nothing saved yet, which means automatic account creation is off. Nobody is created here without an invite.'}
            />
          </div>
        )}

        {/* ── Controls ─────────────────────────────────────────────────── */}
        {draft && saved && (
          <div className="space-y-6">

            {/* ── Automatic creation (JIT) ─────────────────────────────── */}
            <div className="space-y-3">
              <Switch
                id="dt-sso-jit"
                checked={draft.jit_enabled}
                disabled={saving || !canEnableJit}
                onChange={v => setDraft({ ...draft, jit_enabled: v })}
                label="Create people automatically on first sign-in"
                description={
                  <>
                    <p>
                      Anyone who signs in successfully through your identity provider with an email at one of your
                      verified domains gets an account here, without an invite.
                    </p>
                    <p className="text-dt-muted">
                      This rule is enforced now, not later — with it off, nobody is created automatically whatever
                      happens at sign-in.
                    </p>
                  </>
                }
              />

              {!canEnableJit && (
                <Banner tone="neutral" className="ml-7">
                  <p className="font-medium text-dt-body">Not available until a domain is verified</p>
                  <p className="mt-1 text-dt-support">
                    Automatic creation matches people by the domain in their email address. With none verified there
                    is nothing to match, so this switch would have no effect — we would rather show you that than let
                    you save a setting that does nothing.
                  </p>
                </Banner>
              )}

              {draft.jit_enabled && (
                <div className="ml-7 space-y-2">
                  <label htmlFor="dt-sso-default-role" className="block text-sm font-medium text-dt-body">
                    Role for automatically-created people
                  </label>
                  <p id="dt-sso-default-role-hint" className="text-xs text-dt-muted">
                    Your identity provider decides who reaches this point. This decides what they can do when they
                    arrive. Owner cannot be granted automatically — becoming an owner is always a deliberate human act.
                  </p>
                  <select
                    id="dt-sso-default-role"
                    value={draft.jit_default_role}
                    disabled={saving}
                    aria-describedby="dt-sso-default-role-hint"
                    onChange={e => setDraft({ ...draft, jit_default_role: e.target.value })}
                    className="w-full sm:max-w-lg rounded-lg bg-dt-inset border border-dt-border-strong px-3 py-2 text-sm text-dt-body focus:outline-none focus:ring-2 focus:ring-dt-accent focus:border-transparent"
                  >
                    {JIT_ROLES.map(r => <option key={r} value={r}>{JIT_ROLE_LABELS[r]}</option>)}
                  </select>
                  <p className="text-xs text-dt-support max-w-xl">{JIT_ROLE_DETAIL[draft.jit_default_role]}</p>

                  {ADMIN_LEVEL_ROLES.has(draft.jit_default_role) && (
                    <Banner tone="danger">
                      <p className="font-medium">Everyone matched will be able to administer this workspace</p>
                      <p className="mt-1 text-dt-body">
                        Combined with automatic creation, this hands full control of the workspace — settings, people,
                        data — to anyone who holds an email address at a verified domain and can sign in through your
                        identity provider. That is a lot of trust to place in one DNS record.
                      </p>
                      <p className="mt-1 text-dt-support">
                        Choose Member instead and promote individuals deliberately, unless you specifically intend this.
                      </p>
                    </Banner>
                  )}
                </div>
              )}
            </div>

            {/* ── Require SSO ──────────────────────────────────────────── */}
            <div className="space-y-3 pt-5 border-t border-dt-border">
              <Switch
                id="dt-sso-required"
                checked={draft.sso_required}
                disabled={saving}
                onChange={v => { setDraft({ ...draft, sso_required: v }); if (!v) setAcceptRequire(false); }}
                label="Require single sign-on for this workspace"
                description={
                  <>
                    <p>Everyone here signs in through your identity provider rather than with a password.</p>
                    <p className="text-dt-muted">
                      Turning this on also stops anyone being created automatically unless they arrived through your
                      identity provider.
                    </p>
                  </>
                }
              />

              {/* The exact, unflattering truth about what this does today.
                  Shown whenever the switch is on OR being turned on — not only
                  at the moment of change — because someone auditing the screen
                  later needs the same sentence. */}
              {(draft.sso_required || saved.sso_required) && !ssoLive && (
                <Banner tone="warn" className="ml-7">
                  <p className="font-medium">What this does today, precisely</p>
                  <ul className="mt-1.5 space-y-1 text-dt-body list-disc pl-5">
                    <li><strong>In force now:</strong> nobody is created automatically in this workspace unless they arrived through single sign-on.</li>
                    <li><strong>Not in force yet:</strong> people who already have an account can still sign in with a password. Password sign-in is handled by our authentication provider, not by this setting, and stopping it needs SSO to be switched on first.</li>
                  </ul>
                  <p className="mt-1.5 text-dt-support">
                    So this is a real restriction on who gets in, and not yet a restriction on how existing people get
                    in. Both become true together when SSO sign-in goes live.
                  </p>
                </Banner>
              )}

              {turningOnRequire && (
                <div className="ml-7 rounded-xl border border-dt-warn-border bg-dt-warn-soft px-4 py-3">
                  <p className="text-sm font-medium text-dt-warn">
                    {ssoLive ? 'This changes how your whole team signs in' : 'This will change how your whole team signs in, later'}
                  </p>
                  <p className="text-xs text-dt-body mt-1">
                    {ssoLive
                      ? 'From the moment this saves, anyone who cannot complete a sign-in through your identity provider cannot get in — including you. Test one sign-in first, and keep the session you are in right now open until you have.'
                      : 'Nothing about today’s sign-ins changes. But on the day SSO sign-in is switched on, password sign-in stops for this workspace — including for you. Make sure your identity provider is ready before that day, or turn this back off.'}
                  </p>
                  <label htmlFor="dt-sso-require-ack" className="flex gap-2.5 text-sm text-dt-body mt-2.5 cursor-pointer">
                    <input
                      id="dt-sso-require-ack"
                      type="checkbox"
                      checked={acceptRequire}
                      onChange={e => setAcceptRequire(e.target.checked)}
                      className="mt-0.5 accent-[var(--dt-accent)]"
                    />
                    <span>
                      I understand that password sign-in stops for this workspace
                      {ssoLive ? ' as soon as this is saved' : ' once single sign-on is switched on'}.
                    </span>
                  </label>
                </div>
              )}
            </div>

            {saveError && (
              <Banner tone="danger">
                <p className="font-medium">Nothing was saved.</p>
                <p className="mt-1 text-dt-body">{saveError.message}</p>
                <p className="mt-1 text-dt-support">{SSO_KIND_GUIDANCE[saveError.kind as keyof typeof SSO_KIND_GUIDANCE]}</p>
                {saveError.detail && saveError.detail !== saveError.message && (
                  <p className="mt-2 text-xs text-dt-muted break-words"><span className="uppercase tracking-wide">Server detail:</span> {saveError.detail}</p>
                )}
              </Banner>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-dt-border">
              <Button kind="primary" onClick={() => void save()} disabled={!canSave}>
                {saving ? 'Saving…' : 'Save policy'}
              </Button>
              {dirty && <Button kind="ghost" onClick={reset} disabled={saving}>Discard changes</Button>}
              {turningOnRequire && !acceptRequire && (
                <span className="text-xs text-dt-warn">Confirm the checkbox above before saving.</span>
              )}
            </div>
          </div>
        )}

        {!draft && !loadError && <p className="text-sm text-dt-muted py-2">Loading single sign-on settings…</p>}

        <p aria-live="polite" className="sr-only">{announce}</p>
      </div>
    </PanelCard>
  );
}
