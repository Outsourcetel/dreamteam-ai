import React, { useState, useEffect, useCallback } from 'react';
import {
  loadOrgTree, createUnit, renameUnit, setUnitActive, addMember, setMemberRole, removeMember,
  listAssignablePeople, listAssignmentRules, saveRule, setRuleActive, deleteRule,
  reassignUnowned, loadOwnerLoad, ALLOWED_CHILDREN, KIND_LABEL,
} from '../../lib/orgApi';
import type {
  OrgUnit, UnitKind, AssignmentRule, AssignablePerson, AssignStrategy, OwnerLoad,
} from '../../lib/orgApi';
import { LiveLoadingSkeleton, LiveErrorNotice } from '../../components/LiveDataStates';
import {
  Button, Chip, EmptyState, PanelCard, StatTile, Banner, Field, INPUT_CLS,
  TableScroll, TH, TD, Modal, TabBar,
} from '../../design/primitives';

// ============================================================
// Organisation — who works where, and whose job each approval is.
//
// The problem this page exists to solve: 349 approvals had been raised and 318
// were still waiting, every one of them with an empty `assigned_user_id`. Work
// arrived in a shared queue, and a shared queue is precisely a place where no
// individual item is anybody's job. The columns to fix it had existed for
// months and nothing had ever written to them, because there was nothing to
// write — no structure in the product grouped humans at all.
//
// Three things live here, in the order you need them:
//   1. STRUCTURE — the tree. Location or branch, then department, then team.
//   2. PEOPLE    — who is in each unit, and who leads it.
//   3. RULES     — which unit a kind of work belongs to.
//
// An empty unit is SAFE. If a rule points at a team nobody has joined yet, the
// router walks up to the nearest staffed parent rather than dropping the work,
// so the chart can be drawn before it is filled in. The unit that was AIMED at
// is still recorded on the task, which is what makes "Finance has no one in
// it" visible instead of silent.
// ============================================================

const TABS = [
  { key: 'structure' as const, label: 'Structure' },
  { key: 'rules' as const, label: 'Assignment rules' },
  { key: 'load' as const, label: 'Who holds the work' },
];
type TabId = typeof TABS[number]['key'];

const STRATEGY_LABEL: Record<AssignStrategy, string> = {
  lead: 'The unit lead',
  lead_then_round_robin: 'The lead, or rotate if there is none',
  round_robin: 'Rotate through everyone in the unit',
};

/** The task shapes the platform actually raises. Offered as a picker so a rule
 *  cannot be written against a `related_table` that will never appear — a typo
 *  here produces a rule that silently matches nothing. */
const MATCH_TARGETS: { value: string; label: string }[] = [
  { value: '', label: 'Any work (catch-all)' },
  { value: 'renewal_invoices', label: 'Invoices & collections' },
  { value: 'de_conversations', label: 'Customer conversations' },
  { value: 'action_executions', label: 'Action approvals' },
  { value: 'evidence_runs', label: 'Inquiry reviews' },
  { value: 'playbook_amendments', label: 'Playbook changes' },
  { value: 'workforce_entity_amendments', label: 'Employee record changes' },
  { value: 'trust_policies', label: 'Trust promotions & demotions' },
  { value: 'knowledge_revision_requests', label: 'Knowledge revisions' },
];

const targetLabel = (v: string | null) =>
  MATCH_TARGETS.find((t) => t.value === (v ?? ''))?.label ?? v;

function UnitRow({
  unit, people, onChanged, onAddChild,
}: {
  unit: OrgUnit;
  people: AssignablePerson[];
  onChanged: () => void;
  onAddChild: (u: OrgUnit) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onChanged(); } finally { setBusy(false); }
  };

  const memberIds = new Set(unit.members.map((m) => m.user_id));
  const available = people.filter((p) => !memberIds.has(p.user_id));
  const canHaveChildren = ALLOWED_CHILDREN[unit.kind].length > 0;

  return (
    <div
      className="border-t border-dt-border py-3"
      style={{ paddingLeft: `${unit.depth * 24}px` }}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-dt-body">{unit.name}</span>
            <Chip tone={unit.kind === 'team' ? 'accent' : 'neutral'}>{KIND_LABEL[unit.kind]}</Chip>
            {!unit.is_active && <Chip tone="warn">INACTIVE</Chip>}
            {unit.member_count === 0 && (
              <Chip tone="info">EMPTY — WORK ESCALATES UP</Chip>
            )}
            {unit.open_tasks > 0 && (
              <Chip tone="warn">{unit.open_tasks} WAITING</Chip>
            )}
          </div>

          {unit.members.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unit.members.map((m) => (
                <span
                  key={m.user_id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-dt-inset border border-dt-border px-2 py-0.5 text-xs text-dt-body"
                >
                  {m.name || 'Unnamed user'}
                  {m.role_in_unit === 'lead' && <Chip tone="ok">LEAD</Chip>}
                  <button
                    className="text-dt-muted hover:text-dt-danger"
                    disabled={busy}
                    title={m.role_in_unit === 'lead' ? 'Make a member' : 'Make the lead'}
                    onClick={() => run(() => setMemberRole(unit.id, m.user_id, m.role_in_unit === 'lead' ? 'member' : 'lead'))}
                  >⇅</button>
                  <button
                    className="text-dt-muted hover:text-dt-danger"
                    disabled={busy}
                    title="Remove from this unit"
                    onClick={() => run(() => removeMember(unit.id, m.user_id))}
                  >×</button>
                </span>
              ))}
            </div>
          )}

          {adding && (
            <div className="mt-2 flex gap-2 items-center flex-wrap">
              <select className={`${INPUT_CLS} max-w-xs`} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a person…</option>
                {available.map((p) => (
                  <option key={p.user_id} value={p.user_id}>{p.full_name || 'Unnamed user'}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!pick || busy}
                onClick={() => run(async () => { await addMember(unit.id, pick, 'member'); setPick(''); setAdding(false); })}
              >Add</Button>
              <Button size="sm" kind="ghost" onClick={() => { setAdding(false); setPick(''); }}>Cancel</Button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {available.length > 0 && !adding && (
            <Button size="sm" kind="ghost" onClick={() => setAdding(true)}>Add person</Button>
          )}
          {canHaveChildren && (
            <Button size="sm" kind="ghost" onClick={() => onAddChild(unit)}>Add unit</Button>
          )}
          <Button
            size="sm"
            kind="ghost"
            disabled={busy}
            onClick={() => {
              const next = window.prompt('Rename this unit', unit.name);
              if (next && next.trim() && next !== unit.name) run(() => renameUnit(unit.id, next));
            }}
          >Rename</Button>
          <Button
            size="sm"
            kind="ghost"
            disabled={busy}
            onClick={() => run(() => setUnitActive(unit.id, !unit.is_active))}
          >{unit.is_active ? 'Deactivate' : 'Reactivate'}</Button>
        </div>
      </div>
    </div>
  );
}

export default function OrganisationPage() {
  const [tab, setTab] = useState<TabId>('structure');
  const [tree, setTree] = useState<OrgUnit[]>([]);
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [load, setLoad] = useState<OwnerLoad[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newUnitParent, setNewUnitParent] = useState<OrgUnit | null | 'root'>(null);
  const [newUnitKind, setNewUnitKind] = useState<UnitKind>('department');
  const [newUnitName, setNewUnitName] = useState('');
  const [editRule, setEditRule] = useState<Partial<AssignmentRule> | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [t, p, r, l] = await Promise.all([
        loadOrgTree(), listAssignablePeople(), listAssignmentRules(), loadOwnerLoad(),
      ]);
      setTree(t); setPeople(p); setRules(r); setLoad(l);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const unitById = new Map(tree.map((u) => [u.id, u]));
  const unrouted = load.find((l) => l.user_id === null)?.pending ?? 0;
  const emptyUnits = tree.filter((u) => u.is_active && u.member_count === 0).length;
  const totalPending = load.reduce((n, l) => n + l.pending, 0);

  const openNewUnit = (parent: OrgUnit | 'root') => {
    setNewUnitParent(parent);
    setNewUnitKind(parent === 'root' ? 'location' : ALLOWED_CHILDREN[parent.kind][0]);
    setNewUnitName('');
  };

  const submitNewUnit = async () => {
    if (!newUnitParent || !newUnitName.trim()) return;
    try {
      await createUnit({
        parentId: newUnitParent === 'root' ? null : newUnitParent.id,
        kind: newUnitKind,
        name: newUnitName,
      });
      setNewUnitParent(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const submitRule = async () => {
    if (!editRule?.name?.trim() || !editRule.target_unit_id) return;
    try {
      await saveRule(editRule as AssignmentRule & { name: string; target_unit_id: string });
      setEditRule(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <LiveLoadingSkeleton />;
  if (err && tree.length === 0) return <LiveErrorNotice message={err} onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-dt-body">Organisation</h1>
        <p className="text-sm text-dt-support mt-1">
          Who works where, and whose job each approval is. Work that reaches a named
          person gets decided; work that reaches a queue waits.
        </p>
      </div>

      {err && <Banner tone="danger">{err}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="People placed" value={String(new Set(tree.flatMap((u) => u.members.map((m) => m.user_id))).size)} sub={`of ${people.length} in this workspace`} />
        <StatTile label="Units" value={String(tree.filter((u) => u.is_active).length)} sub={`${emptyUnits} with nobody in them`} tone={emptyUnits > 0 ? 'warn' : undefined} />
        <StatTile label="Approvals waiting" value={String(totalPending)} sub="pending decisions" />
        <StatTile
          label="Nobody's job"
          value={String(unrouted)}
          sub={unrouted > 0 ? 'no rule matched' : 'every item has an owner'}
          tone={unrouted > 0 ? 'danger' : 'ok'}
        />
      </div>

      {unrouted > 0 && (
        <Banner tone="warn">
          {unrouted} pending {unrouted === 1 ? 'approval has' : 'approvals have'} no owner — no
          assignment rule matched them. Add a catch-all rule, then re-run routing.
          <Button
            size="sm"
            className="ml-3"
            onClick={async () => {
              const res = await reassignUnowned();
              setNotice(`Routed ${res.assigned}; ${res.unroutable} still had no matching rule.`);
              await refresh();
            }}
          >Re-run routing</Button>
        </Banner>
      )}

      <TabBar<TabId> tabs={TABS} active={tab} onSelect={setTab} />

      {tab === 'structure' && (
        <PanelCard
          title="Structure"
          actions={<Button size="sm" onClick={() => openNewUnit('root')}>Add location</Button>}
        >
          {tree.length === 0 ? (
            <EmptyState
              icon="◫"
              headline="No structure yet"
              action={<Button onClick={() => openNewUnit('root')}>Add your first location</Button>}
            >
              Start with a location or head office, then add departments and teams beneath it.
            </EmptyState>
          ) : (
            <div>
              {tree.map((u) => (
                <UnitRow key={u.id} unit={u} people={people} onChanged={refresh} onAddChild={openNewUnit} />
              ))}
            </div>
          )}
        </PanelCard>
      )}

      {tab === 'rules' && (
        <PanelCard
          title="Assignment rules"
          actions={
            <Button size="sm" onClick={() => setEditRule({ name: '', priority: 100, strategy: 'lead_then_round_robin', is_active: true })}>
              Add rule
            </Button>
          }
        >
          <Banner tone="info" className="mb-3">
            The most <strong>specific</strong> matching rule wins, and only then the priority
            number. A catch-all cannot swallow work a specific rule was written for, however
            low its number.
          </Banner>
          {rules.length === 0 ? (
            <EmptyState icon="⇉" headline="No rules yet">
              Without a rule, approvals stay in the shared queue with no owner.
            </EmptyState>
          ) : (
            <TableScroll>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={TH}>Rule</th>
                    <th className={TH}>Applies to</th>
                    <th className={TH}>Goes to</th>
                    <th className={TH}>Who exactly</th>
                    <th className={TH}>Priority</th>
                    <th className={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => {
                    const target = unitById.get(r.target_unit_id);
                    return (
                      <tr key={r.id} className="border-t border-dt-border">
                        <td className={TD}>
                          <span className="font-medium">{r.name}</span>
                          {!r.is_active && <Chip tone="warn" className="ml-2">OFF</Chip>}
                        </td>
                        <td className={`${TD} text-dt-support`}>{targetLabel(r.match_related_table)}</td>
                        <td className={TD}>
                          {target ? target.path : <span className="text-dt-danger">missing unit</span>}
                          {target && target.member_count === 0 && (
                            <Chip tone="info" className="ml-2">EMPTY — ESCALATES UP</Chip>
                          )}
                        </td>
                        <td className={`${TD} text-dt-support`}>{STRATEGY_LABEL[r.strategy]}</td>
                        <td className={TD}>{r.priority}</td>
                        <td className={TD}>
                          <div className="flex gap-1.5 justify-end">
                            <Button size="sm" kind="ghost" onClick={() => setEditRule(r)}>Edit</Button>
                            <Button size="sm" kind="ghost" onClick={async () => { await setRuleActive(r.id, !r.is_active); await refresh(); }}>
                              {r.is_active ? 'Turn off' : 'Turn on'}
                            </Button>
                            <Button
                              size="sm"
                              kind="ghost"
                              onClick={async () => {
                                if (window.confirm(`Delete "${r.name}"? Work it used to route will fall to the next matching rule.`)) {
                                  await deleteRule(r.id); await refresh();
                                }
                              }}
                            >Delete</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          )}
        </PanelCard>
      )}

      {tab === 'load' && (
        <PanelCard title="Who holds the work">
          {load.length === 0 ? (
            <EmptyState icon="✓" headline="Nothing is waiting">
              No pending approvals in this workspace.
            </EmptyState>
          ) : (
            <TableScroll>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={TH}>Person</th>
                    <th className={TH}>Waiting on them</th>
                    <th className={TH}>Oldest item</th>
                  </tr>
                </thead>
                <tbody>
                  {load.map((l) => (
                    <tr key={l.user_id ?? 'none'} className="border-t border-dt-border">
                      <td className={TD}>
                        {l.user_id === null ? <Chip tone="danger">{l.name}</Chip> : l.name}
                      </td>
                      <td className={TD}>{l.pending}</td>
                      <td className={TD}>
                        {l.oldest_days === 0 ? 'today' : `${l.oldest_days} days`}
                        {l.oldest_days >= 7 && <Chip tone="warn" className="ml-2">STALE</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </PanelCard>
      )}

      {newUnitParent && (
        <Modal title="Add a unit" onClose={() => setNewUnitParent(null)}>
          <div className="space-y-3">
            <p className="text-sm text-dt-support">
              {newUnitParent === 'root'
                ? 'A top-level location — a site, office or region.'
                : <>Inside <strong className="text-dt-body">{newUnitParent.path}</strong>.</>}
            </p>
            <Field label="Type">
              <select
                className={INPUT_CLS}
                value={newUnitKind}
                onChange={(e) => setNewUnitKind(e.target.value as UnitKind)}
              >
                {(newUnitParent === 'root'
                  ? (['location', 'branch', 'department'] as UnitKind[])
                  : ALLOWED_CHILDREN[newUnitParent.kind]
                ).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </Field>
            <Field label="Name">
              <input
                className={INPUT_CLS}
                value={newUnitName}
                autoFocus
                placeholder="e.g. Manchester, Finance, Accounts Receivable"
                onChange={(e) => setNewUnitName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitNewUnit(); }}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button kind="ghost" onClick={() => setNewUnitParent(null)}>Cancel</Button>
              <Button disabled={!newUnitName.trim()} onClick={submitNewUnit}>Create</Button>
            </div>
          </div>
        </Modal>
      )}

      {editRule && (
        <Modal title={editRule.id ? 'Edit rule' : 'Add rule'} onClose={() => setEditRule(null)}>
          <div className="space-y-3">
            <Field label="Name">
              <input
                className={INPUT_CLS}
                value={editRule.name ?? ''}
                autoFocus
                placeholder="e.g. Invoice & collections → Accounts Receivable"
                onChange={(e) => setEditRule({ ...editRule, name: e.target.value })}
              />
            </Field>
            <Field label="Applies to">
              <select
                className={INPUT_CLS}
                value={editRule.match_related_table ?? ''}
                onChange={(e) => setEditRule({ ...editRule, match_related_table: e.target.value || null })}
              >
                {MATCH_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Goes to">
              <select
                className={INPUT_CLS}
                value={editRule.target_unit_id ?? ''}
                onChange={(e) => setEditRule({ ...editRule, target_unit_id: e.target.value })}
              >
                <option value="">Choose a unit…</option>
                {tree.filter((u) => u.is_active).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.path}{u.member_count === 0 ? ' (empty — escalates up)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Who exactly">
              <select
                className={INPUT_CLS}
                value={editRule.strategy ?? 'lead_then_round_robin'}
                onChange={(e) => setEditRule({ ...editRule, strategy: e.target.value as AssignStrategy })}
              >
                {(Object.keys(STRATEGY_LABEL) as AssignStrategy[]).map((s) => (
                  <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority" hint="Only breaks ties between rules that are equally specific. Lower runs first.">
              <input
                type="number"
                className={INPUT_CLS}
                value={editRule.priority ?? 100}
                onChange={(e) => setEditRule({ ...editRule, priority: Number(e.target.value) })}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button kind="ghost" onClick={() => setEditRule(null)}>Cancel</Button>
              <Button disabled={!editRule.name?.trim() || !editRule.target_unit_id} onClick={submitRule}>
                {editRule.id ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
