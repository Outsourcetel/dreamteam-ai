/**
 * DomainClaimPanel — prove your company owns a domain, then use it for SSO.
 *
 * WHY THIS SCREEN IS SHAPED LIKE THIS
 * Domain claim is a TENANT-TAKEOVER PRIMITIVE if it is built casually. If this
 * workspace could claim "acme.com" without proving control of it, every future
 * acme.com signup would silently land in this workspace and this workspace
 * would read their data. So the product rule, stated in the copy and enforced
 * by the server, is:
 *
 *     A CLAIM GRANTS NOTHING. Only VERIFIED grants anything.
 *
 * That is not a UI convention. supabase/migrations/373_tenant_domains.sql puts
 * it in the schema: `CREATE UNIQUE INDEX tenant_domains_verified_uq ON
 * tenant_domains (domain) WHERE status = 'verified'` — pending rows are
 * deliberately not covered, so any number of workspaces may CLAIM a domain and
 * at most one can ever hold it. This screen's job is to never contradict that.
 *
 * So this UI never renders a pending domain as if it were doing something.
 * There is no "1 domain connected" count that quietly includes pending rows —
 * the badge counts verified only — and the pending chip says "grants no access
 * yet" in words, not colour.
 *
 * WHERE REAL USERS GET STUCK — and what this screen does about it
 * DNS is unfamiliar to most people who will land here, propagation is slow and
 * invisible, and "verification failed" with no reason is the single most
 * useless string in the whole flow. So: the exact record is shown as three
 * separately-copyable fields (registrars ask for host and value in different
 * boxes), the host is shown both fully-qualified AND as the bare label most
 * registrars actually want, propagation is stated up front as minutes-to-hours
 * rather than discovered by failure, and the server's own failure sentence is
 * printed verbatim instead of being flattened into "failed".
 *
 * Not mounted anywhere yet — routing is the orchestrator's call after review.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, Chip, EmptyState, PanelCard } from '../../design/primitives';
import {
  claimTenantDomain, describeSsoError, dnsRecordFor, explainDomainReason, formatWhen,
  listTenantDomains, normaliseDomain, removeTenantDomain, verifyTenantDomain,
  SSO_KIND_GUIDANCE, type DnsRecord, type TenantDomain,
} from '../../lib/ssoApi';

/* ── Copy control ──────────────────────────────────────────────────────────
   Lives here because DomainClaimPanel is the first surface that needs it, and
   ScimTokensPanel imports it rather than growing a second copy — a screen
   inventing its own version of a shared control is a design-drift bug per
   docs/design-system.md. It belongs in src/design/primitives.tsx eventually;
   that file is outside this change's blast radius, so it is exported from here
   for now and flagged for the orchestrator. ───────────────────────────────── */
export function CopyButton({ value, label, size = 'sm' }:
  { value: string; label: string; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true); setFailed(false);
    } catch {
      // navigator.clipboard is undefined outside a secure context and can be
      // blocked by permissions policy. Say so — a button that silently does
      // nothing makes the user think they copied it.
      setFailed(true); setCopied(false);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setCopied(false); setFailed(false); }, 2500);
  };

  return (
    <>
      <Button kind="secondary" size={size} onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? 'Copied' : failed ? 'Copy failed' : 'Copy'}
      </Button>
      {/* Announced to screen readers; the visual label change above is not. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied to the clipboard` : failed ? `Could not copy ${label}. Select the text and copy it manually.` : ''}
      </span>
    </>
  );
}

/* ── Status vocabulary ─────────────────────────────────────────────────────
   'pending' is deliberately WARN, not INFO. Info-blue reads as "fine, nothing
   to do here", and the one thing a pending domain needs is for someone to go
   do something. ──────────────────────────────────────────────────────────── */
const STATUS: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string; meaning: string }> = {
  verified: { tone: 'ok', label: 'Verified', meaning: 'You proved you control this domain. It can now be used for single sign-on.' },
  pending: { tone: 'warn', label: 'Awaiting DNS', meaning: 'Not verified. This domain grants no access to anyone and does nothing until the record below is found.' },
  // 373 flips a claim to 'failed' after 10 failed checks and says explicitly
  // that this is "a UI signal … NOT a lock" — the next successful check clears
  // it and further attempts are still accepted. Saying "keeps failing" rather
  // than "blocked" is the difference between a nag and a support ticket.
  failed: { tone: 'danger', label: 'Keeps failing', meaning: 'Checks have been failing for a while, so this needs a look. Nothing is blocked — fix the record and check again. This domain grants no access in the meantime.' },
};
const statusOf = (d: TenantDomain) => STATUS[d.status] ?? { tone: 'neutral' as const, label: d.status || 'Unknown', meaning: 'This screen does not recognise that status, so it is shown exactly as the server reported it.' };

/* ── One copyable DNS field ───────────────────────────────────────────────── */
function RecordField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 rounded-lg bg-dt-page border border-dt-border px-2.5 py-1.5 text-xs text-dt-body font-mono overflow-x-auto whitespace-nowrap">
          {value}
        </code>
        <CopyButton value={value} label={label} />
      </div>
      {hint && <p className="text-[11px] text-dt-muted mt-1">{hint}</p>}
    </div>
  );
}

/** Most registrars want the label WITHOUT the domain suffix ("_x" not
 *  "_x.acme.com") and silently create "_x.acme.com.acme.com" if given the
 *  full name. Showing both, labelled, is what stops that support ticket. */
function bareHost(record: DnsRecord, domain: string): string | null {
  const suffix = `.${domain}`;
  return record.host.endsWith(suffix) ? record.host.slice(0, -suffix.length) : null;
}

function DnsInstructions({ domain, record }: { domain: TenantDomain; record: DnsRecord }) {
  const bare = bareHost(record, domain.domain);
  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset px-4 py-3.5 space-y-3">
      <div>
        <h4 className="text-sm font-medium text-dt-body">Create this DNS record to prove you own {domain.domain}</h4>
        <p className="text-xs text-dt-support mt-1">
          Do this where your domain is managed — the registrar or DNS provider your IT team uses (Cloudflare,
          GoDaddy, Route 53, and so on). Adding a TXT record does not affect your email or your website.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <RecordField label="Type" value={record.type} />
        <RecordField
          label="Host / Name"
          value={bare ?? record.host}
          hint={bare
            ? `Most providers add “.${domain.domain}” for you. If yours asks for the full name, use ${record.host}.`
            : 'Enter this exactly as shown.'}
        />
        <div className="sm:col-span-2">
          <RecordField label="Value" value={record.value} hint="Copy this exactly. A trailing space or a missing character will fail the check." />
        </div>
      </div>

      <p className="text-xs text-dt-support">
        DNS changes take <strong className="text-dt-body">a few minutes to a few hours</strong> to become visible
        worldwide — occasionally up to 24 hours. If the check does not find the record straight away, that is
        normal. Leave the record in place and try again later; removing it after verification will eventually
        un-verify the domain.
      </p>
    </div>
  );
}

export default function DomainClaimPanel() {
  const [domains, setDomains] = useState<TenantDomain[] | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; kind: string; detail: string } | null>(null);

  const [input, setInput] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<{ message: string; kind: string; detail: string } | null>(null);

  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    try {
      setDomains(await listTenantDomains());
      setLoadError(null);
    } catch (err) {
      console.error('DomainClaimPanel.listTenantDomains:', err);
      setLoadError(describeSsoError(err));
      setDomains([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live preview of what will actually be claimed. People paste
  // "https://acme.com/careers" and full email addresses; showing the resolved
  // domain before they press the button prevents a claim on the wrong thing.
  const preview = input.trim() ? normaliseDomain(input) : null;

  const submitClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setClaimError(null);
    if (!preview?.ok) { setClaimError({ message: preview?.error ?? 'Enter a domain.', kind: 'rejected', detail: '' }); return; }
    setClaiming(true);
    try {
      const created = await claimTenantDomain(preview.value);
      setInput('');
      // claim_tenant_domain is idempotent and returns the SAME token on a
      // re-claim (373:380-383), so a second attempt is not a new claim and must
      // not be announced as one — the admin may already have published that
      // record and be waiting on propagation.
      setAnnounce(created.already_claimed
        ? `${created.domain.domain} was already claimed. The record to publish is unchanged.`
        : `${created.domain.domain} claimed. It is not verified yet — publish the DNS record shown to finish.`);
      await load();
    } catch (err) {
      console.error('DomainClaimPanel.claimTenantDomain:', err);
      setClaimError(describeSsoError(err));
    } finally {
      setClaiming(false);
      inputRef.current?.focus();
    }
  };

  const check = async (d: TenantDomain) => {
    setCheckingId(d.id);
    setCheckResult(prev => ({ ...prev, [d.id]: { ok: false, text: '' } }));
    try {
      // verifyTenantDomain has already turned the server's machine code
      // ('no_txt_record', 'token_mismatch', …) into a sentence — see
      // explainDomainReason. Nothing here re-summarises it.
      const res = await verifyTenantDomain(d.domain);
      setCheckResult(prev => ({ ...prev, [d.id]: { ok: res.ok, text: res.detail } }));
      setAnnounce(`${d.domain}: ${res.detail}`);
      await load();
    } catch (err) {
      console.error('DomainClaimPanel.verifyTenantDomain:', err);
      const f = describeSsoError(err);
      const text = `${f.message} ${SSO_KIND_GUIDANCE[f.kind as keyof typeof SSO_KIND_GUIDANCE] ?? ''}`.trim();
      setCheckResult(prev => ({ ...prev, [d.id]: { ok: false, text } }));
      setAnnounce(`${d.domain}: ${f.message}`);
    } finally {
      setCheckingId(null);
    }
  };

  const remove = async (d: TenantDomain) => {
    setRemovingId(d.id);
    try {
      await removeTenantDomain(d.id);
      setConfirmRemoveId(null);
      setAnnounce(`${d.domain} removed.`);
      await load();
    } catch (err) {
      console.error('DomainClaimPanel.removeTenantDomain:', err);
      setLoadError(describeSsoError(err));
    } finally {
      setRemovingId(null);
    }
  };

  const verifiedCount = (domains ?? []).filter(d => d.status === 'verified').length;

  return (
    <PanelCard
      title="Company domains"
      badge={domains && domains.length > 0
        ? <Chip tone={verifiedCount > 0 ? 'ok' : 'warn'} dot>{verifiedCount} verified</Chip>
        : undefined}
    >
      <div className="space-y-5">

        <p className="text-sm text-dt-support">
          Verifying a domain proves your company controls it. Once verified, you can require single sign-on for
          everyone whose work email ends in that domain, and let them be created automatically on first sign-in.
        </p>

        {/* The takeover rule, said to the customer rather than hidden in a
            migration. It is also the answer to "why all this DNS faff?". */}
        <Banner tone="info">
          <p className="font-medium">Why we make you prove it</p>
          <p className="mt-1 text-dt-body">
            A verified domain decides which workspace new people from that domain join. If anyone could claim a
            domain they do not own, they could collect other companies&rsquo; staff into their own workspace. So a
            domain grants nothing until DNS proves you control it, and no two workspaces can ever hold the same
            verified domain.
          </p>
        </Banner>

        {loadError && (
          <Banner tone="danger">
            <p className="font-medium">Could not read your domains.</p>
            <p className="mt-1 text-dt-body">{loadError.message}</p>
            <p className="mt-1 text-dt-support">{SSO_KIND_GUIDANCE[loadError.kind as keyof typeof SSO_KIND_GUIDANCE]}</p>
            {loadError.detail && loadError.detail !== loadError.message && (
              <p className="mt-2 text-xs text-dt-muted break-words"><span className="uppercase tracking-wide">Server detail:</span> {loadError.detail}</p>
            )}
          </Banner>
        )}

        {/* ── Claim form ───────────────────────────────────────────────── */}
        <form onSubmit={submitClaim} className="space-y-2">
          <label htmlFor="dt-sso-domain" className="block text-sm font-medium text-dt-body">
            Add a domain
          </label>
          <p id="dt-sso-domain-hint" className="text-xs text-dt-muted">
            The part after the @ in your work email — for example acme.com. Public providers such as gmail.com
            cannot be claimed by anyone.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="dt-sso-domain"
              ref={inputRef}
              type="text"
              inputMode="url"
              value={input}
              onChange={e => setInput(e.target.value)}
              disabled={claiming}
              placeholder="acme.com"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby="dt-sso-domain-hint"
              aria-invalid={!!preview && !preview.ok}
              className="flex-1 rounded-lg bg-dt-inset border border-dt-border-strong px-3 py-2 text-sm text-dt-body font-mono placeholder:text-dt-faint focus:outline-none focus:ring-2 focus:ring-dt-accent focus:border-transparent"
            />
            <Button type="submit" kind="primary" disabled={claiming || !preview?.ok}>
              {claiming ? 'Adding…' : 'Add domain'}
            </Button>
          </div>
          {preview && !preview.ok && <p className="text-xs text-dt-danger">{preview.error}</p>}
          {preview?.ok && preview.value !== input.trim().toLowerCase() && (
            <p className="text-xs text-dt-support">
              This will claim <span className="font-mono text-dt-body">{preview.value}</span>.
            </p>
          )}
          {claimError && (
            <Banner tone={claimError.kind === 'conflict' ? 'warn' : 'danger'}>
              <p className="font-medium">Domain not added.</p>
              <p className="mt-1 text-dt-body">{claimError.message}</p>
              <p className="mt-1 text-dt-support">{SSO_KIND_GUIDANCE[claimError.kind as keyof typeof SSO_KIND_GUIDANCE]}</p>
              {claimError.detail && claimError.detail !== claimError.message && (
                <p className="mt-2 text-xs text-dt-muted break-words"><span className="uppercase tracking-wide">Server detail:</span> {claimError.detail}</p>
              )}
            </Banner>
          )}
        </form>

        {/* ── The list ─────────────────────────────────────────────────── */}
        {domains === null ? (
          <p className="text-sm text-dt-muted py-2">Loading domains…</p>
        ) : domains.length === 0 ? (
          <EmptyState headline="No domains claimed yet">
            Until a domain is verified here, single sign-on has nothing to match people against and everyone signs
            in with a password.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {domains.map(d => {
              const s = statusOf(d);
              const record = dnsRecordFor(d);
              const result = checkResult[d.id];
              const isChecking = checkingId === d.id;
              return (
                <li key={d.id} className="rounded-xl border border-dt-border bg-dt-card">
                  <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-dt-title font-mono break-all">{d.domain}</span>
                        <Chip tone={s.tone} dot>{s.label}</Chip>
                      </div>
                      <p className="text-xs text-dt-support mt-1 max-w-xl">{s.meaning}</p>
                      <p className="text-[11px] text-dt-muted mt-1">
                        {d.status === 'verified'
                          ? `Verified ${formatWhen(d.verified_at)}`
                          : `Added ${formatWhen(d.created_at)} · last checked ${formatWhen(d.last_checked_at)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {d.status !== 'verified' && (
                        <Button kind="secondary" size="sm" onClick={() => void check(d)} disabled={isChecking}>
                          {isChecking ? 'Checking…' : 'Check now'}
                        </Button>
                      )}
                      {confirmRemoveId === d.id ? (
                        <>
                          <Button kind="ghost" size="sm" onClick={() => setConfirmRemoveId(null)} disabled={removingId === d.id}>
                            Keep it
                          </Button>
                          <Button kind="danger" size="sm" onClick={() => void remove(d)} disabled={removingId === d.id}>
                            {removingId === d.id ? 'Removing…' : 'Yes, remove'}
                          </Button>
                        </>
                      ) : (
                        <Button kind="ghost" size="sm" onClick={() => setConfirmRemoveId(d.id)}
                          aria-label={`Remove ${d.domain}`}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>

                  {confirmRemoveId === d.id && (
                    <div className="px-4 pb-3">
                      <Banner tone="warn">
                        Removing <span className="font-mono">{d.domain}</span>
                        {d.status === 'verified'
                          ? ' releases the claim. Anyone signing in through SSO with this domain will stop being matched to this workspace, and another workspace becomes free to claim it.'
                          : ' discards the claim and its verification record. You can add it again later, but you will get a new record to publish.'}
                      </Banner>
                    </div>
                  )}

                  {/* tenant_domains.last_error is a MACHINE CODE, not prose —
                      373 says so at the column. Rendering it raw would put
                      "no_txt_record" in front of a non-technical admin, so it
                      goes through explainDomainReason, which never returns
                      empty and never hides a code it does not recognise. */}
                  {d.status !== 'verified' && d.last_error && (
                    <div className="px-4 pb-3">
                      <Banner tone="danger">
                        <p className="font-medium">Last check could not verify this domain</p>
                        <p className="mt-1 text-dt-body">{explainDomainReason(d.last_error)}</p>
                        {d.failure_count > 0 && (
                          <p className="mt-1 text-xs text-dt-muted">
                            Failed {d.failure_count} {d.failure_count === 1 ? 'time' : 'times'} so far. This does not
                            lock anything — the next successful check clears it.
                          </p>
                        )}
                      </Banner>
                    </div>
                  )}

                  {result?.text && (
                    <div className="px-4 pb-3">
                      <Banner tone={result.ok ? 'info' : 'warn'}>
                        <p className="text-dt-body break-words">{result.text}</p>
                      </Banner>
                    </div>
                  )}

                  {d.status !== 'verified' && (
                    <div className="px-4 pb-4">
                      {record ? (
                        <DnsInstructions domain={d} record={record} />
                      ) : (
                        <Banner tone="danger">
                          <p className="font-medium">No verification record was issued for this domain.</p>
                          <p className="mt-1 text-dt-body">
                            There is nothing to publish yet, so this domain cannot be verified. Remove it and add it
                            again; if that does not produce a record, contact us — this is our problem, not yours.
                          </p>
                        </Banner>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p aria-live="polite" className="sr-only">{announce}</p>
      </div>
    </PanelCard>
  );
}
