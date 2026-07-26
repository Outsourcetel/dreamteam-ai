import React, { useCallback, useEffect, useState } from 'react';
import {
  PanelCard, Button, Chip, EntityRow, EmptyState, Banner, Drawer, Modal, Field, INPUT_CLS,
} from '../design/primitives';
import {
  listPrincipalGroups, listGroupMembers, createPrincipalGroup, deletePrincipalGroup,
  addGroupMember, removeGroupMember, listWorkspacePeople, myKnowledgeAdminLevel,
  type PrincipalGroup, type GroupMember,
} from '../lib/knowledgeApi';

// ============================================================
// Groups — "the legal team", "everyone in support".
//
// The thing this screen must never let a customer forget: a group is not an
// address book. It carries access. Adding somebody to a group gives them
// everything the group can reach, everywhere it can reach it — so every row
// shows what the group HOLDS, not just how many people are in it, and deleting
// one says out loud how much access it is about to destroy.
// ============================================================

const LEVEL_NAME = ['No access', 'Viewer', 'Contributor', 'Editor', 'Publisher', 'Knowledge manager', 'Full access'];

export default function KnowledgeGroupsPanel({ canManage }: { canManage: boolean }) {
  const [groups, setGroups] = useState<PrincipalGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PrincipalGroup | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PrincipalGroup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setGroups(await listPrincipalGroups()); setError(null); }
    catch (e) { setError((e as Error)?.message || 'Could not load groups.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  return (
    <>
      <PanelCard
        title="Groups"
        badge={groups.length > 0 ? <Chip tone="neutral">{groups.length}</Chip> : undefined}
        actions={canManage ? <Button kind="primary" size="sm" onClick={() => setCreating(true)}>New group</Button> : undefined}
      >
        {notice && <Banner tone="info" className="mb-3">{notice}</Banner>}

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1].map(i => <div key={i} className="h-14 rounded-xl border border-dt-border bg-dt-panel animate-pulse" />)}
          </div>
        ) : error ? (
          <Banner tone="danger">
            <div className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button size="sm" onClick={() => void load()}>Try again</Button>
            </div>
          </Banner>
        ) : groups.length === 0 ? (
          <EmptyState
            icon="◍"
            headline="No groups yet"
            action={canManage ? <Button kind="primary" size="sm" onClick={() => setCreating(true)}>New group</Button> : undefined}
          >
            A group lets you give the same access to several people at once — "the legal team",
            "everyone in support" — and change it in one place when somebody joins or leaves.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {groups.map(g => (
              <EntityRow
                key={g.id}
                title={g.name}
                chips={
                  g.max_level > 0
                    ? <Chip tone={g.max_level >= 5 ? 'accent' : 'ok'}>Grants {LEVEL_NAME[g.max_level]}</Chip>
                    : <Chip tone="neutral">No access granted yet</Chip>
                }
                meta={
                  <>
                    {g.member_count} {g.member_count === 1 ? 'person' : 'people'}
                    {' · '}
                    {g.grant_count === 0
                      ? 'not used to grant access anywhere yet'
                      : `used in ${g.grant_count} place${g.grant_count === 1 ? '' : 's'}`}
                    {g.description ? ` · ${g.description}` : ''}
                  </>
                }
                actions={canManage
                  ? <Button kind="ghost" size="sm" onClick={() => setConfirmDelete(g)}>Delete</Button>
                  : undefined}
                onOpen={() => setOpen(g)}
              />
            ))}
          </div>
        )}
      </PanelCard>

      {open && (
        <GroupMembersDrawer
          group={open}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onChanged={async (msg) => { setNotice(msg); await load(); }}
        />
      )}

      {creating && (
        <Modal title="New group" onClose={() => setCreating(false)}>
          <CreateGroupForm
            onCancel={() => setCreating(false)}
            onCreated={async (name) => { setCreating(false); setNotice(`Created "${name}".`); await load(); }}
          />
        </Modal>
      )}

      {confirmDelete && (
        <Modal title={`Delete "${confirmDelete.name}"?`} onClose={() => setConfirmDelete(null)}>
          <div className="space-y-4">
            {/* Deleting a group cascades its grants. Saying so BEFORE is the
                difference between a decision and an accident. */}
            {confirmDelete.grant_count > 0 ? (
              <Banner tone="warn">
                This group is used to give access in {confirmDelete.grant_count} place
                {confirmDelete.grant_count === 1 ? '' : 's'}. Deleting it takes that access away from
                its {confirmDelete.member_count} {confirmDelete.member_count === 1 ? 'member' : 'members'} straight away.
              </Banner>
            ) : (
              <p className="text-sm text-dt-support">
                This group isn't used to give access anywhere, so deleting it changes nothing for anyone.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setConfirmDelete(null)}>Keep it</Button>
              <Button kind="danger" onClick={async () => {
                try {
                  const r = await deletePrincipalGroup(confirmDelete.id);
                  setConfirmDelete(null);
                  setNotice(r.grants_removed > 0
                    ? `Deleted. ${r.grants_removed} grant${r.grants_removed === 1 ? '' : 's'} removed, affecting ${r.members_affected} ${r.members_affected === 1 ? 'person' : 'people'}.`
                    : 'Deleted. Nobody lost access.');
                  await load();
                } catch (e) { setNotice((e as Error)?.message || 'Could not delete that group.'); }
              }}>Delete group</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function GroupMembersDrawer({ group, canManage, onClose, onChanged }: {
  group: PrincipalGroup; canManage: boolean;
  onClose: () => void; onChanged: (msg: string) => Promise<void>;
}) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [people, setPeople] = useState<Array<{ user_id: string; full_name: string; role: string }>>([]);
  const [pick, setPick] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [myLevel, setMyLevel] = useState(0);   // fails closed

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [m, p, lvl] = await Promise.all([
        listGroupMembers(group.id), listWorkspacePeople(), myKnowledgeAdminLevel(null),
      ]);
      setMembers(m); setPeople(p); setMyLevel(lvl); setErr(null);
      const inGroup = new Set(m.map(x => x.user_id));
      setPick(p.find(x => !inGroup.has(x.user_id))?.user_id ?? '');
    } catch (e) {
      setErr((e as Error)?.message || 'Could not load this group.');
    } finally { setLoading(false); }
  }, [group.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The server refuses membership changes on a group that outranks you. Showing
  // that up front beats offering a control that errors.
  const outranksMe = group.max_level > myLevel;
  const editable = canManage && !outranksMe;
  const inGroup = new Set(members.map(m => m.user_id));
  const addable = people.filter(p => !inGroup.has(p.user_id));

  return (
    <Drawer title={group.name} onClose={onClose}>
      <div className="space-y-4">
        {err && <Banner tone="danger">{err}</Banner>}

        {group.max_level > 0 ? (
          <Banner tone={group.max_level >= 5 ? 'warn' : 'info'}>
            Everyone in this group gets <strong>{LEVEL_NAME[group.max_level].toLowerCase()}</strong>
            {group.grant_count > 0 ? ` in ${group.grant_count} place${group.grant_count === 1 ? '' : 's'}` : ''}.
            Adding someone here gives them that immediately.
          </Banner>
        ) : (
          <p className="text-xs text-dt-support">
            This group doesn't grant anything yet. Give it access from a space's
            "Who can see what" panel, and everyone in it gets that access.
          </p>
        )}

        {outranksMe && canManage && (
          <Banner tone="warn">
            This group carries more access than you hold, so you can't change who's in it.
            Someone with full access can.
          </Banner>
        )}

        <div>
          <p className="text-[10px] uppercase tracking-wide text-dt-muted mb-2">
            Members — {members.length}
          </p>
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1].map(i => <div key={i} className="h-10 rounded-lg border border-dt-border bg-dt-panel animate-pulse" />)}
            </div>
          ) : members.length === 0 ? (
            <EmptyState headline="Nobody in this group yet">
              Add someone below and they'll get whatever this group can reach.
            </EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {members.map(m => (
                <li key={m.user_id} className="flex items-center justify-between gap-3 rounded-lg border border-dt-border bg-dt-panel px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-dt-body truncate">{m.full_name}</p>
                    <p className="text-[11px] text-dt-muted truncate">{m.role}</p>
                  </div>
                  {editable && (
                    <Button kind="ghost" size="sm" disabled={busy} onClick={async () => {
                      setBusy(true);
                      try {
                        await removeGroupMember(group.id, m.user_id);
                        await refresh();
                        await onChanged(`${m.full_name} removed from ${group.name}.`);
                      } catch (e) { setErr((e as Error)?.message || 'Could not remove them.'); }
                      finally { setBusy(false); }
                    }}>Remove</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {editable && addable.length > 0 && (
          <div className="rounded-xl border border-dt-border bg-dt-inset px-4 py-3 space-y-3">
            <Field label="Add someone">
              <select value={pick} onChange={e => setPick(e.target.value)} className={INPUT_CLS}>
                {addable.map(p => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
              </select>
            </Field>
            <div className="flex justify-end">
              <Button kind="primary" size="sm" disabled={busy || !pick} onClick={async () => {
                setBusy(true);
                try {
                  await addGroupMember(group.id, pick);
                  const who = addable.find(p => p.user_id === pick)?.full_name ?? 'They';
                  await refresh();
                  await onChanged(`${who} added to ${group.name}.`);
                } catch (e) { setErr((e as Error)?.message || 'Could not add them.'); }
                finally { setBusy(false); }
              }}>Add to group</Button>
            </div>
          </div>
        )}
        {editable && addable.length === 0 && !loading && members.length > 0 && (
          <p className="text-xs text-dt-muted">Everyone in this workspace is already in this group.</p>
        )}
      </div>
    </Drawer>
  );
}

/* The form only. The panel wraps it in a Modal, the same way the delete
   confirmation works — a component that renders its own overlay is a second
   Modal implementation, which is what the design catalog exists to prevent. */
function CreateGroupForm({ onCancel, onCreated }: {
  onCancel: () => void; onCreated: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
      <div className="space-y-4">
        {err && <Banner tone="danger">{err}</Banner>}
        <Field label="Name" hint="What this group of people is called — “Legal”, “Support team”.">
          <input value={name} onChange={e => setName(e.target.value)} className={INPUT_CLS} placeholder="Legal" />
        </Field>
        <Field label="Description" hint="Optional — why this group exists.">
          <input value={desc} onChange={e => setDesc(e.target.value)} className={INPUT_CLS} placeholder="Contracts and compliance" />
        </Field>
        <p className="text-xs text-dt-support">
          A new group doesn't give anyone anything yet. You choose what it can reach from a
          space's access panel — then everyone you add to it gets that.
        </p>
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onCancel}>Cancel</Button>
          <Button kind="primary" disabled={saving || !name.trim()} onClick={async () => {
            setSaving(true); setErr(null);
            try { await createPrincipalGroup(name.trim(), desc.trim() || null); await onCreated(name.trim()); }
            catch (e) { setErr((e as Error)?.message || 'Could not create that group.'); }
            finally { setSaving(false); }
          }}>Create group</Button>
        </div>
      </div>
  );
}
