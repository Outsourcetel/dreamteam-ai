/**
 * DeleteWorkspacePanel — "delete my data", stated the way it actually works.
 *
 * WHY: an independent readiness audit scored ENTERPRISE READINESS 27/100, and
 * one of the named holes was that a customer cannot get their data deleted and
 * we could not prove it if asked. This is the surface that lets them ask.
 *
 * WHAT THIS SCREEN IS CAREFUL NOT TO IMPLY: that a customer can delete their
 * own workspace. Read from production today, delete_tenant(p_tenant_id uuid,
 * p_confirm_slug text) refuses unless ALL of these hold, and a customer inside
 * their own workspace can satisfy none of the first two:
 *   · resolve_platform_capability(auth.uid(), 'tenants.manage')
 *       -> "only a platform team member with tenant-management access may delete a tenant"
 *   · tenants.status = 'suspended'
 *       -> "suspend the tenant before deleting it — deletion is permanent and irreversible"
 *   · p_confirm_slug = tenants.slug
 *   · zero rows in tenants where parent_tenant_id = p_tenant_id
 *   · it explicitly refuses the caller's OWN tenant: "you cannot delete the
 *     tenant you belong to", and refuses the demo tenant outright.
 * So the honest product is a REQUEST that a human on our side actions, and the
 * copy below says exactly that. Every one of those rules is mirrored in the UI
 * (the retyped slug especially) so nothing about the request is a surprise.
 *
 * WHAT IT DOES NOT CLAIM: it makes no completeness guarantee about the
 * deletion itself. That guarantee belongs to the server, so if the request RPC
 * reports anything retained, it is rendered verbatim rather than summarised.
 *
 * Not mounted anywhere yet — routing is the orchestrator's call after review.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Banner, Button, Chip, Modal, PanelCard } from '../design/primitives';
import { EXPORT_PANEL_ANCHOR_ID } from './DataExportPanel';
import {
  describeDataRightsError, getWorkspaceIdentity, requestWorkspaceDeletion,
  type DeletionRequestResult, type WorkspaceIdentity,
} from '../lib/dataRightsApi';

/** Plain language, no table names — this is read by the person signing off on
 *  losing it, not by an engineer. Kept short enough to actually be read. */
const DESTROYED = [
  'Every digital employee you configured, and the work they have done',
  'All knowledge you uploaded — documents, articles, and everything derived from them',
  'Your customers, invoices, payments and any financial records held here',
  'Conversations, tickets, escalations and their history',
  'Playbooks, guardrails, connectors and stored credentials',
  'Audit trails and governance records for this workspace',
  'Every user account that exists only inside this workspace',
];

const KIND_GUIDANCE: Record<string, string> = {
  not_deployed: 'This is a platform-side gap. Nothing was submitted and nothing was changed. Email us and we will take the request manually.',
  denied: 'Only a workspace owner can request deletion. Ask an owner to submit it.',
  rejected: 'Nothing was submitted. Correct the problem above and try again.',
  unavailable: 'The request did not reach our servers, so nothing was submitted. It is safe to try again.',
  malformed: 'We could not confirm the request was recorded. Do not assume it was — contact us.',
  server: 'The request was not recorded. Please try again, or contact us.',
};

export default function DeleteWorkspacePanel({ onExportFirst }: { onExportFirst?: () => void } = {}) {
  const [workspace, setWorkspace] = useState<WorkspaceIdentity | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [acknowledgedExport, setAcknowledgedExport] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; kind: string; detail: string } | null>(null);
  const [submitted, setSubmitted] = useState<DeletionRequestResult | null>(null);

  const slugInputRef = useRef<HTMLInputElement | null>(null);
  const receiptRef = useRef<HTMLDivElement | null>(null);
  // primitives.Button is not a forwardRef component, so the trigger cannot be
  // captured by ref. Recording the element that had focus when the dialog
  // opened restores focus correctly on close regardless of what opened it.
  const lastFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    getWorkspaceIdentity()
      .then(w => { if (alive) setWorkspace(w); })
      .catch(err => {
        console.error('DeleteWorkspacePanel.getWorkspaceIdentity:', err);
        if (alive) setLoadError(describeDataRightsError(err).message);
      });
    return () => { alive = false; };
  }, []);

  // Escape closes the dialog. primitives.Modal handles the backdrop click and
  // the × button but binds no key handler, and a modal that traps a keyboard
  // user is exactly the kind of a11y debt this codebase already has too much of.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) closeDialog(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // closeDialog only touches setState and a ref, so it is stable in effect;
    // re-binding on `submitting` is what makes Escape inert mid-submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, submitting]);

  const openDialog = () => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    setTyped('');
    setReason('');
    setAcknowledgedExport(false);
    setFailure(null);
    setOpen(true);
    // Focus the confirmation field, so the keyboard path starts where the
    // deliberate action starts rather than at the close button.
    window.setTimeout(() => slugInputRef.current?.focus(), 0);
  };

  const closeDialog = () => {
    setOpen(false);
    lastFocused.current?.focus?.();
  };

  const goExport = () => {
    if (onExportFirst) { onExportFirst(); return; }
    // Default path: the export panel is on the same screen in the intended
    // layout, so put it in front of the user without needing a route.
    const el = document.getElementById(EXPORT_PANEL_ANCHOR_ID);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      (el as HTMLElement).focus?.();
    }
  };

  const slugMatches = !!workspace && typed === workspace.slug;
  const canSubmit = slugMatches && acknowledgedExport && !submitting;

  const submit = async () => {
    if (!workspace || !canSubmit) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const res = await requestWorkspaceDeletion({
        tenantId: workspace.id,
        confirmSlug: typed,
        reason,
      });
      setSubmitted(res);
      setOpen(false);
      // The trigger button is replaced by the receipt, so restoring focus to
      // it would drop focus onto a detached node. Send focus to the receipt —
      // it is also what a screen-reader user needs read next.
      window.setTimeout(() => receiptRef.current?.focus(), 0);
    } catch (err) {
      console.error('DeleteWorkspacePanel.submit:', err);
      setFailure(describeDataRightsError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PanelCard
      title="Delete this workspace"
      badge={<Chip tone="danger">Irreversible</Chip>}
    >
      <div className="space-y-5">

        {loadError && (
          <Banner tone="danger">
            <p className="font-medium">Could not read your workspace details.</p>
            <p className="mt-1 text-dt-body">{loadError}</p>
            <p className="mt-1 text-dt-support">Deletion cannot be requested from this screen until that is fixed.</p>
          </Banner>
        )}

        {/* ── Export first. Placed above the danger copy on purpose: it is the
            only step that is still reversible. ─────────────────────────── */}
        <Banner tone="info">
          <p className="font-medium">Export your data first</p>
          <p className="mt-1 text-dt-body">
            Once this workspace is deleted we cannot reproduce anything in it — not from a backup, not on request.
            Take your export while you still can.
          </p>
          <div className="mt-2.5">
            <Button kind="secondary" size="sm" onClick={goExport}>Go to export</Button>
          </div>
        </Banner>

        {/* ── What actually happens ────────────────────────────────────── */}
        <div>
          {/* Framed as what the customer is ASKING for, not as a guarantee the
              mechanism already makes. Measured today, delete_tenant relies on
              FK cascade and 19 tenant-scoped tables — customers, invoices,
              payments, bank_transactions, bills, vendors among them — carry no
              foreign key to tenants at all, so a blanket "all of this is
              destroyed" would be a claim this screen cannot back. The written
              confirmation below is where completeness gets asserted, by the
              party that can actually verify it. */}
          <h3 className="text-sm font-medium text-dt-body mb-2">What you are asking us to destroy</h3>
          <ul className="space-y-1 text-sm text-dt-support list-disc pl-5">
            {DESTROYED.map(d => <li key={d}>{d}</li>)}
          </ul>
          <p className="text-sm text-dt-body mt-3">
            This cannot be undone, and it cannot be partially undone. There is no recycle bin and no grace-period
            restore. We will confirm in writing exactly what was destroyed — and if anything in your workspace
            cannot be destroyed, that confirmation will name it.
          </p>
        </div>

        {/* ── The real rules, not an idealised flow ────────────────────── */}
        <div className="rounded-xl border border-dt-border bg-dt-inset px-4 py-3">
          <h3 className="text-sm font-medium text-dt-body">How deletion actually happens</h3>
          <p className="text-sm text-dt-support mt-1">
            You are submitting a <strong className="text-dt-body">request</strong>. Deletion itself is performed by
            our platform team — this workspace cannot delete itself, by design. When you submit:
          </p>
          <ol className="mt-2 space-y-1 text-sm text-dt-support list-decimal pl-5">
            <li>We confirm the request with a workspace owner.</li>
            <li>The workspace is <strong className="text-dt-body">suspended</strong> first — sign-in stops, and nothing is destroyed yet. Suspension is required before deletion can run at all.</li>
            <li>A platform administrator performs the deletion, retyping this workspace’s identifier to confirm.</li>
            <li>You get written confirmation of what was destroyed, and of anything we are required to keep.</li>
          </ol>
          <p className="text-xs text-dt-muted mt-2">
            Workspaces that have sub-workspaces underneath them cannot be deleted until those are moved or deleted first.
          </p>
        </div>

        {/* ── Identity + status, so nothing about the target is ambiguous ── */}
        {workspace && (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-dt-muted">Workspace</dt>
              <dd className="text-dt-title font-medium">{workspace.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-dt-muted">Identifier to confirm</dt>
              <dd className="text-dt-title font-mono">{workspace.slug}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-dt-muted">Current status</dt>
              <dd>
                <Chip tone={workspace.status === 'suspended' ? 'warn' : 'ok'} dot>
                  {workspace.status}
                </Chip>
              </dd>
            </div>
          </dl>
        )}

        {submitted ? (
          <div ref={receiptRef} tabIndex={-1} aria-label="Deletion request receipt" className="focus:outline-none">
          <Banner tone="warn">
            <p className="font-medium">Deletion request submitted</p>
            <p className="mt-1 text-dt-body">
              {submitted.message ?? 'We have recorded your request. Nothing has been deleted yet — an owner will be contacted to confirm before anything is destroyed.'}
            </p>
            <ul className="mt-2 text-xs text-dt-support space-y-0.5">
              {submitted.requestId && <li>Reference: <span className="font-mono text-dt-body">{submitted.requestId}</span></li>}
              {submitted.status && <li>Status: <span className="text-dt-body">{submitted.status}</span></li>}
            </ul>
            {submitted.retained.length > 0 && (
              <>
                <p className="mt-2.5 font-medium">Records that will be kept, not destroyed</p>
                <ul className="mt-1 text-xs text-dt-body list-disc pl-5 space-y-0.5">
                  {submitted.retained.map(r => <li key={r} className="font-mono break-all">{r}</li>)}
                </ul>
              </>
            )}
            <p className="mt-2 text-xs text-dt-muted">
              To cancel this request, contact us before you receive the suspension notice.
            </p>
          </Banner>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap pt-1 border-t border-dt-border mt-1">
            <div className="pt-4">
              <Button kind="danger" onClick={openDialog} disabled={!workspace}>
                Request workspace deletion
              </Button>
            </div>
            {!workspace && !loadError && <span className="text-xs text-dt-muted pt-4">Loading workspace details…</span>}
          </div>
        )}
      </div>

      {open && workspace && (
        <Modal title={`Request deletion of ${workspace.name}`} onClose={() => { if (!submitting) closeDialog(); }}>
          <div className="space-y-4">
            <Banner tone="danger">
              This destroys everything in <strong>{workspace.name}</strong> permanently. It cannot be undone.
            </Banner>

            <div>
              <label htmlFor="dt-delete-ack" className="flex gap-2.5 text-sm text-dt-body cursor-pointer">
                <input
                  id="dt-delete-ack"
                  type="checkbox"
                  checked={acknowledgedExport}
                  onChange={e => setAcknowledgedExport(e.target.checked)}
                  className="mt-0.5 accent-[var(--dt-accent)]"
                />
                <span>
                  I have exported everything I need, or I accept losing it.
                </span>
              </label>
            </div>

            <div>
              <label htmlFor="dt-delete-slug" className="block text-sm font-medium text-dt-body mb-1">
                Type <span className="font-mono text-dt-title">{workspace.slug}</span> to confirm
              </label>
              <p id="dt-delete-slug-hint" className="text-xs text-dt-muted mb-1.5">
                This is the same confirmation our platform administrator has to retype before the deletion will run.
              </p>
              <input
                id="dt-delete-slug"
                ref={slugInputRef}
                type="text"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                disabled={submitting}
                aria-label={`Type the workspace identifier ${workspace.slug} to confirm deletion`}
                aria-describedby="dt-delete-slug-hint"
                aria-invalid={typed.length > 0 && !slugMatches}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full rounded-lg bg-dt-inset border border-dt-border-strong px-3 py-2 text-sm text-dt-body font-mono placeholder:text-dt-faint focus:outline-none focus:ring-2 focus:ring-dt-accent focus:border-transparent"
              />
              {typed.length > 0 && !slugMatches && (
                <p className="text-xs text-dt-danger mt-1">That does not match {workspace.slug}.</p>
              )}
            </div>

            <div>
              <label htmlFor="dt-delete-reason" className="block text-sm font-medium text-dt-body mb-1">
                Reason <span className="text-dt-muted font-normal">(optional)</span>
              </label>
              <textarea
                id="dt-delete-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                disabled={submitting}
                rows={3}
                aria-label="Reason for deletion, optional"
                className="w-full rounded-lg bg-dt-inset border border-dt-border-strong px-3 py-2 text-sm text-dt-body placeholder:text-dt-faint focus:outline-none focus:ring-2 focus:ring-dt-accent focus:border-transparent"
                placeholder="Helps us confirm we are deleting the right thing."
              />
            </div>

            {failure && (
              <Banner tone="danger">
                <p className="font-medium">Request not submitted.</p>
                <p className="mt-1 text-dt-body">{failure.message}</p>
                {KIND_GUIDANCE[failure.kind] && <p className="mt-1 text-dt-support">{KIND_GUIDANCE[failure.kind]}</p>}
                {failure.detail && failure.detail !== failure.message && (
                  <p className="mt-2 text-xs text-dt-muted break-words">
                    <span className="uppercase tracking-wide">Server detail:</span> {failure.detail}
                  </p>
                )}
              </Banner>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button kind="secondary" size="sm" onClick={closeDialog} disabled={submitting}>Cancel</Button>
              <Button kind="danger" size="sm" onClick={submit} disabled={!canSubmit}>
                {submitting ? 'Submitting…' : 'Submit deletion request'}
              </Button>
            </div>
            <p aria-live="polite" className="sr-only">{submitting ? 'Submitting deletion request' : ''}</p>
          </div>
        </Modal>
      )}
    </PanelCard>
  );
}
