/**
 * ScimTokensPanel — bearer tokens that let an identity provider create, update
 * and deactivate people in this workspace automatically (SCIM).
 *
 * WHAT A TOKEN HERE ACTUALLY IS: a credential that can add and remove people
 * from this workspace without a human in the loop. It is the most powerful
 * thing on the enterprise-identity screen, so this panel is built around three
 * rules, in order of importance:
 *
 *  1. THE SECRET IS SHOWN EXACTLY ONCE, AND THE USER IS TOLD SO BEFORE THEY
 *     CREATE IT — not after, when the warning is useless. The list below never
 *     renders a token value under any circumstance; ssoApi.ts's ScimToken type
 *     has no field that could hold one. The "we cannot show it again" claim is
 *     literally true rather than a policy we intend to keep:
 *     supabase/migrations/375_scim_tokens.sql stores only the SHA-256 hash and
 *     enforces that with a CHECK, and scim_tokens_list projects token_hash out
 *     entirely. Nothing in the system can produce the plaintext a second time.
 *  2. THE REVEAL IS NOT INSIDE A DIALOG. A stray Escape or a mis-aimed click on
 *     a modal backdrop would destroy a credential that cannot be recovered, and
 *     the fix for that — a dialog you cannot escape from — is an accessibility
 *     defect. So the naming step is a dialog and the reveal is a region in the
 *     panel that only an explicit "I have saved it" dismisses.
 *  3. NOTHING PERSISTS THE SECRET. It is held in component state and dropped on
 *     dismiss: no localStorage, no URL (a query string reaches browser history,
 *     proxy logs and Referer headers), no console.log. The catch blocks in this
 *     file log the ERROR, never the payload.
 *
 * HONESTY: SCIM provisioning runs against the same identity stack as SSO, and
 * SSO is not switched on for this platform yet (config/auth reports
 * saml_enabled = false — the org is on the FREE Supabase plan). A token created
 * today is real and revocable, but nothing will be calling it until that lands.
 * The panel says so rather than letting an admin wire up Okta and wonder why
 * nothing syncs.
 *
 * Not mounted anywhere yet — routing is the orchestrator's call after review.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, Chip, EmptyState, Modal, PanelCard, TableScroll, TD, TH } from '../../design/primitives';
import { CopyButton } from './DomainClaimPanel';
import {
  createScimToken, describeSsoError, formatWhen, listScimTokens, revokeScimToken,
  SSO_KIND_GUIDANCE, SSO_LOGIN_LIVE, type CreatedScimToken, type ScimToken,
} from '../../lib/ssoApi';

export default function ScimTokensPanel() {
  const [tokens, setTokens] = useState<ScimToken[] | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; kind: string; detail: string } | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  // Default OFF, matching the column default. 375 calls it "the ONLY switch in
  // this schema", so it gets an explicit opt-in rather than being decided here.
  const [allowAdoption, setAllowAdoption] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; kind: string; detail: string } | null>(null);

  /** The one-time secret. Cleared by dismissSecret() and by nothing else. */
  const [revealed, setRevealed] = useState<CreatedScimToken | null>(null);
  const [savedAcknowledged, setSavedAcknowledged] = useState(false);

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const nameRef = useRef<HTMLInputElement | null>(null);
  const revealRef = useRef<HTMLDivElement | null>(null);
  // primitives.Button is not a forwardRef component, so the trigger cannot be
  // captured by ref. Recording what had focus when the dialog opened restores
  // focus correctly on close whatever opened it.
  const lastFocused = useRef<HTMLElement | null>(null);

  const load = React.useCallback(async () => {
    try {
      setTokens(await listScimTokens());
      setLoadError(null);
    } catch (err) {
      console.error('ScimTokensPanel.listScimTokens:', err);
      setLoadError(describeSsoError(err));
      setTokens([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Escape closes the naming dialog. primitives.Modal handles the backdrop and
  // the × button but binds no key handler, and a dialog a keyboard user cannot
  // leave is exactly the a11y debt this codebase already has too much of.
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !creating) closeDialog(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // closeDialog only touches setState and a ref, so it is stable in effect;
    // re-binding on `creating` is what makes Escape inert mid-request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, creating]);

  const openDialog = () => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    setName('');
    setAllowAdoption(false);
    setCreateError(null);
    setDialogOpen(true);
    window.setTimeout(() => nameRef.current?.focus(), 0);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    lastFocused.current?.focus?.();
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createScimToken(name, allowAdoption);
      setRevealed(created);
      setSavedAcknowledged(false);
      setDialogOpen(false);
      setAnnounce('Token created. The token value is shown once — copy it now.');
      // Focus the reveal, not the trigger: it is both where the user must act
      // and what a screen-reader user needs read next.
      window.setTimeout(() => revealRef.current?.focus(), 0);
      await load();
    } catch (err) {
      // The error, never the payload — a token value must not reach a log.
      console.error('ScimTokensPanel.createScimToken:', describeSsoError(err).message);
      setCreateError(describeSsoError(err));
      // The list is reloaded even on failure: createScimToken() deliberately
      // throws 'malformed' when the server created a row but returned no value,
      // and the user needs to see that row so they can revoke it.
      await load();
    } finally {
      setCreating(false);
    }
  };

  const dismissSecret = () => {
    setRevealed(null);
    setSavedAcknowledged(false);
    setAnnounce('Token value hidden. It cannot be shown again.');
  };

  const revoke = async (t: ScimToken) => {
    setRevokingId(t.id);
    try {
      await revokeScimToken(t.id);
      setConfirmRevokeId(null);
      setAnnounce(`${t.name} revoked.`);
      await load();
    } catch (err) {
      console.error('ScimTokensPanel.revokeScimToken:', err);
      setLoadError(describeSsoError(err));
    } finally {
      setRevokingId(null);
    }
  };

  const active = (tokens ?? []).filter(t => !t.revoked_at);

  return (
    <PanelCard
      title="Automatic user provisioning (SCIM)"
      badge={tokens ? <Chip tone={active.length > 0 ? 'ok' : 'neutral'} dot>{active.length} active</Chip> : undefined}
      actions={<Button kind="primary" size="sm" onClick={openDialog}>Create token</Button>}
    >
      <div className="space-y-5">

        <p className="text-sm text-dt-support">
          A SCIM token lets your identity provider — Okta, Entra ID, JumpCloud and the like — create, update and
          deactivate people in this workspace automatically, so leavers lose access without anyone remembering to
          remove them here.
        </p>

        <Banner tone="warn">
          <p className="font-medium">A token here can add and remove people from this workspace</p>
          <p className="mt-1 text-dt-body">
            Treat it like a password with admin rights. Paste it straight into your identity provider, do not email
            it, and revoke it the moment you no longer need it. Revoking takes effect immediately and cannot be
            undone — create a new token instead.
          </p>
          {/* Keyed off the same constant every other SSO sentence in the app
              uses, so "is this live?" is answered in one place and can never
              drift between panels. */}
          {!SSO_LOGIN_LIVE && (
            <p className="mt-1.5 text-dt-support">
              Single sign-on is not switched on for this platform yet, so nothing is calling these tokens today. You
              can create one in advance; it will start working the day SSO does.
            </p>
          )}
        </Banner>

        {/* ── One-time reveal. Not in a dialog, on purpose — see the header. ── */}
        {revealed && (
          <div
            ref={revealRef}
            tabIndex={-1}
            aria-label="New SCIM token — shown once"
            className="focus:outline-none focus-visible:ring-2 focus-visible:ring-dt-accent rounded-xl"
          >
            <div className="rounded-xl border border-dt-warn-border bg-dt-warn-soft px-4 py-4 space-y-3">
              <div>
                <p className="text-sm font-semibold text-dt-warn">
                  Copy this now — you will not be able to see it again
                </p>
                <p className="text-xs text-dt-body mt-1">
                  We store only a one-way hash of this token, so we cannot show it to you a second time and cannot
                  recover it for you. If you lose it, revoke this token and create another.
                </p>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-1">
                  Token for “{revealed.token.name}”
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 rounded-lg bg-dt-page border border-dt-border px-2.5 py-2 text-xs text-dt-body font-mono overflow-x-auto whitespace-nowrap">
                    {revealed.secret}
                  </code>
                  <CopyButton value={revealed.secret} label="SCIM token" size="md" />
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-1">SCIM base URL</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 rounded-lg bg-dt-page border border-dt-border px-2.5 py-1.5 text-xs text-dt-body font-mono overflow-x-auto whitespace-nowrap">
                    {revealed.scim_base_url}
                  </code>
                  <CopyButton value={revealed.scim_base_url} label="SCIM base URL" />
                </div>
                <p className="text-[11px] text-dt-muted mt-1">
                  Your identity provider asks for this alongside the token. This one is not secret — the token is.
                </p>
              </div>

              <label htmlFor="dt-scim-saved" className="flex gap-2.5 text-sm text-dt-body cursor-pointer">
                <input
                  id="dt-scim-saved"
                  type="checkbox"
                  checked={savedAcknowledged}
                  onChange={e => setSavedAcknowledged(e.target.checked)}
                  className="mt-0.5 accent-[var(--dt-accent)]"
                />
                <span>I have saved this token somewhere safe.</span>
              </label>

              <Button kind="secondary" size="sm" onClick={dismissSecret} disabled={!savedAcknowledged}>
                Hide the token
              </Button>
            </div>
          </div>
        )}

        {loadError && (
          <Banner tone="danger">
            <p className="font-medium">Could not read your tokens.</p>
            <p className="mt-1 text-dt-body">{loadError.message}</p>
            <p className="mt-1 text-dt-support">{SSO_KIND_GUIDANCE[loadError.kind as keyof typeof SSO_KIND_GUIDANCE]}</p>
            {loadError.detail && loadError.detail !== loadError.message && (
              <p className="mt-2 text-xs text-dt-muted break-words"><span className="uppercase tracking-wide">Server detail:</span> {loadError.detail}</p>
            )}
          </Banner>
        )}

        {/* ── The list. Name, when it was made, when it was last used. Never
            the value — there is no field on ScimToken that could hold one. ── */}
        {tokens === null ? (
          <p className="text-sm text-dt-muted py-2">Loading tokens…</p>
        ) : tokens.length === 0 ? (
          <EmptyState headline="No SCIM tokens">
            Without a token, people are added and removed here by hand. That is fine for a small team and a
            liability for a large one.
          </EmptyState>
        ) : (
          <TableScroll>
            <table className="w-full min-w-[40rem]">
              <caption className="sr-only">SCIM tokens for this workspace. Token values are never shown after creation.</caption>
              <thead>
                <tr className="border-b border-dt-border">
                  <th scope="col" className={TH}>Name</th>
                  <th scope="col" className={TH}>Created</th>
                  <th scope="col" className={TH}>Last used</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map(t => (
                  <tr key={t.id} className="border-b border-dt-border last:border-0">
                    <td className={TD}>
                      <span className="font-medium text-dt-title">{t.name}</span>
                      {/* Safe to show: the prefix is derived from the token's
                          SHA-256 hash, not from the token (375:250). */}
                      {t.prefix && <div className="text-[11px] text-dt-muted font-mono">{t.prefix}…</div>}
                      {t.allow_account_adoption && (
                        <div className="mt-1"><Chip tone="warn">Can adopt existing sign-ins</Chip></div>
                      )}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>{formatWhen(t.created_at)}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {t.last_used_at
                        ? formatWhen(t.last_used_at)
                        // "Never used" is the signal that an integration was set
                        // up wrong, or that this token is dead weight worth
                        // revoking. Worth a word, not a blank cell.
                        : <span className="text-dt-muted">Never used</span>}
                    </td>
                    <td className={TD}>
                      {t.revoked_at
                        ? <Chip tone="neutral">Revoked {formatWhen(t.revoked_at)}</Chip>
                        : <Chip tone="ok" dot>Active</Chip>}
                    </td>
                    <td className={`${TD} text-right whitespace-nowrap`}>
                      {t.revoked_at ? (
                        <span className="text-xs text-dt-muted">—</span>
                      ) : confirmRevokeId === t.id ? (
                        <span className="inline-flex items-center gap-2">
                          <Button kind="ghost" size="sm" onClick={() => setConfirmRevokeId(null)} disabled={revokingId === t.id}>
                            Cancel
                          </Button>
                          <Button kind="danger" size="sm" onClick={() => void revoke(t)} disabled={revokingId === t.id}>
                            {revokingId === t.id ? 'Revoking…' : 'Revoke now'}
                          </Button>
                        </span>
                      ) : (
                        <Button kind="ghost" size="sm" onClick={() => setConfirmRevokeId(t.id)} aria-label={`Revoke the token named ${t.name}`}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {confirmRevokeId && (
          <Banner tone="warn">
            Revoking stops your identity provider from syncing people immediately. Anyone it would have removed will
            keep their access here until someone removes them by hand.
          </Banner>
        )}

        <p aria-live="polite" className="sr-only">{announce}</p>
      </div>

      {dialogOpen && (
        <Modal title="Create a SCIM token" onClose={() => { if (!creating) closeDialog(); }}>
          <form
            onSubmit={e => { e.preventDefault(); void create(); }}
            className="space-y-4"
          >
            {/* Said BEFORE creation. A "you won't see this again" warning that
                only appears next to the secret arrives too late to be advice. */}
            <Banner tone="warn">
              The token appears once, on the next screen. We keep only a one-way hash of it, so we cannot show it
              again or recover it. Have somewhere to paste it ready.
            </Banner>

            <div>
              <label htmlFor="dt-scim-name" className="block text-sm font-medium text-dt-body mb-1">
                Name this token
              </label>
              <p id="dt-scim-name-hint" className="text-xs text-dt-muted mb-1.5">
                Name it after where it will live, so you know what you are revoking later — “Okta production”,
                “Entra ID test”.
              </p>
              <input
                id="dt-scim-name"
                ref={nameRef}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={creating}
                maxLength={80}
                autoComplete="off"
                placeholder="Okta production"
                aria-describedby="dt-scim-name-hint"
                className="w-full rounded-lg bg-dt-inset border border-dt-border-strong px-3 py-2 text-sm text-dt-body placeholder:text-dt-faint focus:outline-none focus:ring-2 focus:ring-dt-accent focus:border-transparent"
              />
            </div>

            {/* The one permission this token can carry beyond "create new
                people". Described as what it actually permits, including the
                limit — 375 refuses to claim an account belonging to another
                tenant with no flag at all, and saying so is what stops an admin
                imagining this is more dangerous, or less, than it is. */}
            <div className="rounded-xl border border-dt-border bg-dt-inset px-3.5 py-3">
              <label htmlFor="dt-scim-adoption" className="flex gap-2.5 cursor-pointer">
                <input
                  id="dt-scim-adoption"
                  type="checkbox"
                  checked={allowAdoption}
                  disabled={creating}
                  onChange={e => setAllowAdoption(e.target.checked)}
                  aria-describedby="dt-scim-adoption-desc"
                  className="mt-0.5 accent-[var(--dt-accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-dt-body">
                    Let this token claim existing sign-ins that belong to no workspace
                  </span>
                  <span id="dt-scim-adoption-desc" className="block text-xs text-dt-support mt-0.5">
                    Off by default. Turn it on only if people already signed up here before your workspace existed
                    and you want provisioning to adopt those accounts instead of failing. It can never take an
                    account that belongs to another workspace — that is refused outright, with or without this.
                  </span>
                </span>
              </label>
            </div>

            {createError && (
              <Banner tone="danger">
                <p className="font-medium">Token not created.</p>
                <p className="mt-1 text-dt-body">{createError.message}</p>
                <p className="mt-1 text-dt-support">{SSO_KIND_GUIDANCE[createError.kind as keyof typeof SSO_KIND_GUIDANCE]}</p>
                {createError.detail && createError.detail !== createError.message && (
                  <p className="mt-2 text-xs text-dt-muted break-words"><span className="uppercase tracking-wide">Server detail:</span> {createError.detail}</p>
                )}
              </Banner>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" kind="secondary" size="sm" onClick={closeDialog} disabled={creating}>Cancel</Button>
              <Button type="submit" kind="primary" size="sm" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create token'}
              </Button>
            </div>
            <p aria-live="polite" className="sr-only">{creating ? 'Creating token' : ''}</p>
          </form>
        </Modal>
      )}
    </PanelCard>
  );
}
