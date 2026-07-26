import React, { useCallback, useEffect, useState } from 'react';
import {
  PanelCard, Button, Chip, EntityRow, EmptyState, Banner, Drawer, Field, INPUT_CLS,
  TH, TD, TableScroll, type Tone,
} from '../../../design/primitives';
import {
  listKnowledgeSpacesAdmin, listResourceAccess, previewSpaceAccess, myKnowledgeAdminLevel,
  listWorkspacePeople, grantKnowledgeAccess, revokeKnowledgeAccess, setSpaceRestricted,
  PERMISSION_LEVELS,
  type KnowledgeSpaceAdmin, type ResourceGrant, type EffectiveAccess,
} from '../../../lib/knowledgeApi';

// ============================================================
// Who can see what — knowledge permissions, presets first.
//
// The founder's call (docs/27 §7b) and the reason for it: the schema supports a
// full enterprise ACL matrix — six levels × five principal kinds × three
// resource levels — and there is no evidence any workspace needs that yet.
// Several have one person. Shipping a permission grid to a one-person workspace
// is how good architecture becomes an abandoned screen.
//
// So the primary control is TWO CHOICES per space: open to the workspace, or
// restricted. The full grid is real, complete, and behind "Advanced".
//
// The centrepiece is not the grid — it's "Who can see this", which answers for
// every real person what they can do AND WHY. A checkbox tells you what you
// set; it doesn't tell you that Priya can read the HR space because she's in a
// group somebody added her to in March. That answer is the whole product here.
// ============================================================

const LEVEL_TONE = (n: number): Tone =>
  n >= 5 ? 'accent' : n >= 3 ? 'ok' : n >= 1 ? 'info' : 'neutral';

export default function KnowledgePermissionsPage() {
  const [spaces, setSpaces] = useState<KnowledgeSpaceAdmin[]>([]);
  const [myLevel, setMyLevel] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<KnowledgeSpaceAdmin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, lvl] = await Promise.all([listKnowledgeSpacesAdmin(), myKnowledgeAdminLevel(null)]);
      setSpaces(s); setMyLevel(lvl); setError(null);
    } catch (e) {
      setError((e as Error)?.message || 'Could not load your spaces.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const canManage = myLevel >= 5;

  return (
    <div className="px-6 pb-10 pt-6 space-y-6">
      {notice && <Banner tone="info">{notice}</Banner>}

      {!loading && !canManage && (
        <Banner tone="warn">
          You can see how access is set up here, but changing it needs the
          knowledge&nbsp;manager level. Ask someone with full access to change it, or to give you that level.
        </Banner>
      )}

      <PanelCard
        title="Spaces"
        badge={spaces.some(s => s.is_restricted)
          ? <Chip tone="accent" dot>{spaces.filter(s => s.is_restricted).length} restricted</Chip>
          : <Chip tone="ok" dot>All open to the workspace</Chip>}
      >
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map(i => <div key={i} className="h-14 rounded-xl border border-dt-border bg-dt-panel animate-pulse" />)}
          </div>
        ) : error ? (
          <Banner tone="danger">
            <div className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button size="sm" onClick={() => void load()}>Try again</Button>
            </div>
          </Banner>
        ) : spaces.length === 0 ? (
          <EmptyState icon="⬚" headline="No spaces yet">
            A space is a shelf in your library — and the place you decide who can see what.
            Every workspace starts with one called General; import some documents and it fills up.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {spaces.map(s => (
              <EntityRow
                key={s.id}
                title={s.name}
                chips={
                  s.is_restricted
                    ? <Chip tone="accent" dot>Restricted</Chip>
                    : <Chip tone="ok" dot>Open to workspace</Chip>
                }
                meta={
                  <>
                    {s.doc_count} document{s.doc_count === 1 ? '' : 's'}
                    {s.is_restricted
                      ? ` · ${s.grant_count} person or group can reach it`
                      : ' · everyone in the workspace can reach it'}
                    {s.description ? ` · ${s.description}` : ''}
                  </>
                }
                onOpen={() => setOpen(s)}
              />
            ))}
          </div>
        )}
      </PanelCard>

      {open && (
        <SpaceAccessDrawer
          space={open}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onChanged={async (msg) => { setNotice(msg); await load(); }}
        />
      )}
    </div>
  );
}

/* ── One space: presets, who-can-see-this, and the grid behind Advanced ──── */
function SpaceAccessDrawer({ space, canManage, onClose, onChanged }: {
  space: KnowledgeSpaceAdmin;
  canManage: boolean;
  onClose: () => void;
  onChanged: (msg: string) => Promise<void>;
}) {
  const [restricted, setRestricted] = useState(space.is_restricted);
  const [people, setPeople] = useState<EffectiveAccess[]>([]);
  const [grants, setGrants] = useState<ResourceGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [p, g] = await Promise.all([
        previewSpaceAccess(space.id),
        listResourceAccess('collection', space.id),
      ]);
      setPeople(p); setGrants(g); setErr(null);
    } catch (e) {
      setErr((e as Error)?.message || 'Could not load access for this space.');
    } finally { setLoading(false); }
  }, [space.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const applyPreset = async (next: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await setSpaceRestricted(space.id, next);
      setRestricted(next);
      await refresh();
      await onChanged(
        next
          ? r.explicit_grants === 0
            ? `"${space.name}" is now restricted — and nobody has been given access to it yet. Add at least one person below.`
            : `"${space.name}" is now restricted. Only the ${r.explicit_grants} listed below can reach it.`
          : `"${space.name}" is open to everyone in the workspace again.`,
      );
    } catch (e) {
      setErr((e as Error)?.message || 'Could not change this.');
    } finally { setBusy(false); }
  };

  const withAccess = people.filter(p => p.level > 0);
  const without = people.filter(p => p.level === 0);

  return (
    <Drawer title={space.name} onClose={onClose}>
      <div className="space-y-5">
        {err && <Banner tone="danger">{err}</Banner>}

        {/* ── The two presets. This is the control 99% of workspaces need. ── */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-dt-muted mb-2">Who can reach this space</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <PresetCard
              selected={!restricted}
              disabled={!canManage || busy}
              title="Open to the workspace"
              body="Everyone here can read it, and your digital employees can answer from it."
              onSelect={() => void applyPreset(false)}
            />
            <PresetCard
              selected={restricted}
              disabled={!canManage || busy}
              title="Restricted"
              /* This sentence is a security promise, so it has to be exactly
                 true. Mig 357 is what makes it so: restricted documents are now
                 excluded from retrieval for anyone not named here, INCLUDING
                 the public widget and autonomous work. It says "people" and not
                 "people and groups" because group management is not built yet —
                 the schema supports groups, the screen does not. */
              body="Only the people you name below. Your digital employees won't use it to answer anyone else — including customers on your website."
              onSelect={() => void applyPreset(true)}
            />
          </div>
          {restricted && grants.length === 0 && !loading && (
            <Banner tone="warn" className="mt-2">
              This space is locked and nobody has been given access to it. Its documents
              can't be read by anyone, and your digital employees won't answer from them.
            </Banner>
          )}
        </div>

        {/* ── The actual feature: who can see this, and WHY. ── */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-dt-muted mb-2">
            Who can see this — {withAccess.length} of {people.length} people
          </p>
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1].map(i => <div key={i} className="h-11 rounded-lg border border-dt-border bg-dt-panel animate-pulse" />)}
            </div>
          ) : people.length === 0 ? (
            <EmptyState headline="Nobody to show">
              This workspace has no other people in it yet.
            </EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {[...withAccess, ...without].map(p => (
                <li key={p.user_id} className="flex items-center justify-between gap-3 rounded-lg border border-dt-border bg-dt-panel px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-dt-body truncate">{p.full_name}</p>
                    {/* The WHY. Without it this list is just another grid. */}
                    <p className="text-[11px] text-dt-muted truncate">{p.reason}</p>
                  </div>
                  <Chip tone={LEVEL_TONE(p.level)}>{p.level_name}</Chip>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Advanced: the full grid, real and complete, out of the way. ── */}
        <div className="border-t border-dt-border pt-4">
          <button
            onClick={() => setAdvanced(v => !v)}
            className="text-xs text-dt-support hover:text-dt-body transition-colors"
          >
            {advanced ? '▾' : '▸'} Advanced — grant access to specific people, groups or roles
          </button>

          {advanced && (
            <div className="mt-3 space-y-4">
              <TableScroll>
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>Who</th>
                      <th className={TH}>Can</th>
                      <th className={TH}>Where</th>
                      <th className={TH} />
                    </tr>
                  </thead>
                  <tbody>
                    {grants.length === 0 ? (
                      <tr><td className={TD} colSpan={4}><span className="text-dt-muted">No specific grants — access comes from the workspace-wide setting.</span></td></tr>
                    ) : grants.map(g => (
                      <tr key={g.id} className="border-t border-dt-border">
                        <td className={TD}>{g.principal_label}</td>
                        <td className={TD}>
                          {PERMISSION_LEVELS.find(l => l.value === g.permission)?.label ?? g.permission}
                        </td>
                        <td className={`${TD} text-dt-muted`}>{g.scope}</td>
                        <td className={TD}>
                          {canManage && g.scope !== 'Whole workspace' && (
                            <Button kind="ghost" size="sm" onClick={async () => {
                              setBusy(true);
                              try { await revokeKnowledgeAccess(g.id); await refresh(); await onChanged('Access removed.'); }
                              catch (e) { setErr((e as Error)?.message || 'Could not remove that.'); }
                              finally { setBusy(false); }
                            }}>Remove</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>

              {canManage && (
                <AddGrantForm
                  spaceId={space.id}
                  onAdded={async () => { await refresh(); await onChanged('Access granted.'); }}
                  onError={setErr}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function PresetCard({ selected, disabled, title, body, onSelect }: {
  selected: boolean; disabled?: boolean; title: string; body: string; onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled || selected}
      className={`text-left rounded-xl border px-4 py-3 transition-colors disabled:cursor-default ${
        selected
          ? 'border-dt-accent/40 bg-dt-accent-soft'
          : 'border-dt-border bg-dt-card hover:border-dt-border-strong disabled:opacity-60'}`}
    >
      <div className="flex items-center gap-2">
        <span className={`text-sm font-medium ${selected ? 'text-dt-accent-text' : 'text-dt-title'}`}>{title}</span>
        {selected && <Chip tone="accent">Current</Chip>}
      </div>
      <p className="text-xs text-dt-support mt-1">{body}</p>
    </button>
  );
}

function AddGrantForm({ spaceId, onAdded, onError }: {
  spaceId: string; onAdded: () => Promise<void>; onError: (m: string | null) => void;
}) {
  const [people, setPeople] = useState<Array<{ user_id: string; full_name: string; role: string }>>([]);
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState('viewer');
  const [saving, setSaving] = useState(false);
  // Starts at 0 and FAILS CLOSED. If the level lookup errors, this offers
  // nothing rather than everything — the server would refuse an over-grant
  // anyway, but a form that offers a permission it cannot deliver teaches
  // people the product is unreliable, and the opposite default would hide a
  // real escalation bug behind a server error nobody reads.
  const [myLevel, setMyLevel] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const [p, lvl] = await Promise.all([listWorkspacePeople(), myKnowledgeAdminLevel(spaceId)]);
        setPeople(p); setUserId(p[0]?.user_id ?? ''); setMyLevel(lvl);
      } catch { /* the form simply stays empty */ }
    })();
  }, [spaceId]);

  // You cannot hand out more than you hold — enforced server-side, shown here so
  // the option isn't offered and then refused.
  const offerable = PERMISSION_LEVELS.filter((_, i) => i + 1 <= myLevel);

  const submit = async () => {
    if (!userId) return;
    setSaving(true); onError(null);
    try {
      await grantKnowledgeAccess({
        resourceType: 'collection', resourceId: spaceId,
        principalType: 'user', principalId: userId, permission,
      });
      await onAdded();
    } catch (e) {
      onError((e as Error)?.message || 'Could not grant that.');
    } finally { setSaving(false); }
  };

  if (people.length === 0) {
    return <p className="text-xs text-dt-muted">Nobody else is in this workspace yet.</p>;
  }

  return (
    <div className="rounded-xl border border-dt-border bg-dt-inset px-4 py-3 space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-dt-muted">Give someone access</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Person">
          <select value={userId} onChange={e => setUserId(e.target.value)} className={INPUT_CLS}>
            {people.map(p => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
          </select>
        </Field>
        <Field label="Can" hint={PERMISSION_LEVELS.find(l => l.value === permission)?.blurb}>
          <select value={permission} onChange={e => setPermission(e.target.value)} className={INPUT_CLS}>
            {offerable.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="flex justify-end">
        <Button kind="primary" size="sm" disabled={saving || !userId} onClick={() => void submit()}>
          {saving ? 'Saving…' : 'Give access'}
        </Button>
      </div>
    </div>
  );
}
