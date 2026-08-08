import React, { useState, useEffect, useCallback } from 'react';
import {
  loadOrgTree, createUnit, renameUnit, setUnitActive, addMember, setMemberRole, removeMember,
  listAssignablePeople, listAssignmentRules, saveRule, setRuleActive, deleteRule,
  reassignUnowned, loadOwnerLoad, ALLOWED_CHILDREN, KIND_LABEL,
  listPlaceableDigitalEmployees, setDeOrgUnit,
  listApprovalAuthority, saveApprovalAuthority, deleteApprovalAuthority, AUTHORITY_CATEGORIES,
} from '../../lib/orgApi';
import type {
  OrgUnit, UnitKind, AssignmentRule, AssignablePerson, AssignStrategy, OwnerLoad, OrgDigitalEmployee,
  ApprovalAuthority,
} from '../../lib/orgApi';
import { LiveLoadingSkeleton, LiveErrorNotice } from '../../components/LiveDataStates';
import { useConfirm, usePromptText } from '../../components/useDialog';
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
  { key: 'authority' as const, label: 'Approval limits' },
  { key: 'load' as const, label: 'Who holds the work' },
];
type TabId = typeof TABS[number]['key'];

/** Money in, money out — the database stores minor units (cents/paisa) so a
 *  rounding error cannot creep into a spending limit. */
const toCents = (s: string): number | null => {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(s).trim() !== '' ? Math.round(n * 100) : null;
};
const fromCents = (c: number | null | undefined): string =>
  c === null || c === undefined ? '' : (c / 100).toFixed(2);

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

/** Visual weight by level, so the three tiers read as three tiers. The first
 *  version indented by 24px per level and nothing else, which made one team
 *  buried under eleven sibling departments effectively invisible — the founder
 *  reported seeing "only departments" when all three levels were present. */
const KIND_STYLE: Record<UnitKind, { text: string; icon: string }> = {
  location:   { text: 'text-sm font-semibold text-dt-title', icon: '⌂' },
  branch:     { text: 'text-sm font-semibold text-dt-title', icon: '⌂' },
  department: { text: 'text-sm font-medium text-dt-body',    icon: '▦' },
  team:       { text: 'text-[13px] text-dt-body',            icon: '◦' },
};

function UnitRow({
  unit, people, des, onChanged, onAddChild, hasChildren, isOpen, onToggle,
}: {
  unit: OrgUnit;
  people: AssignablePerson[];
  /** The whole active roster, so one can be moved into a unit it is not in yet. */
  des: OrgDigitalEmployee[];
  onChanged: () => void;
  onAddChild: (u: OrgUnit) => void;
  hasChildren: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { promptText, promptUI } = usePromptText();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [addingDe, setAddingDe] = useState(false);
  const [pickDe, setPickDe] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onChanged(); } finally { setBusy(false); }
  };

  const memberIds = new Set(unit.members.map((m) => m.user_id));
  const available = people.filter((p) => !memberIds.has(p.user_id));
  const canHaveChildren = ALLOWED_CHILDREN[unit.kind].length > 0;
  const hereIds = new Set(unit.digital_employees.map((d) => d.de_id));
  const availableDes = des.filter((d) => !hereIds.has(d.de_id));

  const style = KIND_STYLE[unit.kind];

  return (
    <div className="py-2">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* A disclosure control only where there is something to disclose;
                a chevron on a leaf teaches people it means nothing. */}
            {hasChildren ? (
              <button
                onClick={onToggle}
                className="text-dt-muted hover:text-dt-body w-4 text-xs shrink-0"
                title={isOpen ? 'Collapse' : 'Expand'}
              >{isOpen ? '▾' : '▸'}</button>
            ) : (
              <span className="w-4 shrink-0 text-dt-faint text-xs text-center">{style.icon}</span>
            )}
            <span className={style.text}>{unit.name}</span>
            <Chip tone={unit.kind === 'team' ? 'accent' : 'neutral'}>{KIND_LABEL[unit.kind]}</Chip>
            {!unit.is_active && <Chip tone="warn">INACTIVE</Chip>}
            {unit.member_count === 0 && unit.de_count === 0 && (
              <Chip tone="info">EMPTY — WORK ESCALATES UP</Chip>
            )}
            {/* A unit staffed only by digital employees is NOT staffed for
                approvals — the rota is people. Said here rather than left for
                someone to discover when a chase fails to route. */}
            {unit.member_count === 0 && unit.de_count > 0 && (
              <Chip tone="warn">NO PEOPLE — APPROVALS ESCALATE UP</Chip>
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

          {/* Digital employees in the same department (mig 600). Shown in their
              own row, not blended with the people above: they belong to the
              same unit, but only people enter the approval rota and one mixed
              list would hide that distinction. */}
          {unit.digital_employees.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] uppercase tracking-wide text-dt-muted mr-1">Digital</span>
              {unit.digital_employees.map((d) => (
                <span
                  key={d.de_id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-dt-inset border border-dt-accent/40 px-2 py-0.5 text-xs text-dt-body"
                  title={`${d.title || d.name} · trust: ${d.trust_level ?? 'unknown'}`}
                >
                  <span className="text-dt-accent-text">◆</span>
                  {d.name}
                  {d.trust_level && <span className="text-dt-muted text-[10px]">{d.trust_level}</span>}
                  <button
                    className="text-dt-muted hover:text-dt-danger"
                    disabled={busy}
                    title="Remove from this department"
                    onClick={() => run(() => setDeOrgUnit(d.de_id, null))}
                  >×</button>
                </span>
              ))}
            </div>
          )}

          {addingDe && (
            <div className="mt-2 flex gap-2 items-center flex-wrap">
              <select className={`${INPUT_CLS} max-w-xs`} value={pickDe} onChange={(e) => setPickDe(e.target.value)}>
                <option value="">Choose a digital employee…</option>
                {availableDes.map((d) => (
                  <option key={d.de_id} value={d.de_id}>{d.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!pickDe || busy}
                onClick={() => run(async () => { await setDeOrgUnit(pickDe, unit.id); setPickDe(''); setAddingDe(false); })}
              >Add</Button>
              <Button size="sm" kind="ghost" onClick={() => { setAddingDe(false); setPickDe(''); }}>Cancel</Button>
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
          {availableDes.length > 0 && !addingDe && (unit.kind === 'department' || unit.kind === 'team') && (
            <Button size="sm" kind="ghost" onClick={() => setAddingDe(true)}>Add digital</Button>
          )}
          {canHaveChildren && (
            <Button size="sm" kind="ghost" onClick={() => onAddChild(unit)}>Add unit</Button>
          )}
          <Button
            size="sm"
            kind="ghost"
            disabled={busy}
            onClick={async () => {
              const next = await promptText({
                title: `Rename ${unit.name}`,
                label: 'What should it be called?',
                initialValue: unit.name,
                confirmLabel: 'Rename it',
              });
              if (next && next !== unit.name) run(() => renameUnit(unit.id, next));
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
      {promptUI}
    </div>
  );
}

/** Renders one unit and everything under it. The nesting is drawn with a real
 *  indent guide rather than left-padding alone, because padding by itself does
 *  not read as containment — which is exactly how a three-level tree looked
 *  like a flat list of departments. */
function UnitBranch({
  unit, childrenOf, people, des, onChanged, onAddChild, collapsed, onToggle,
}: {
  unit: OrgUnit;
  childrenOf: Map<string, OrgUnit[]>;
  people: AssignablePerson[];
  des: OrgDigitalEmployee[];
  onChanged: () => void;
  onAddChild: (u: OrgUnit) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const kids = childrenOf.get(unit.id) ?? [];
  const isOpen = !collapsed.has(unit.id);
  return (
    <div>
      <UnitRow
        unit={unit}
        people={people}
        des={des}
        onChanged={onChanged}
        onAddChild={onAddChild}
        hasChildren={kids.length > 0}
        isOpen={isOpen}
        onToggle={() => onToggle(unit.id)}
      />
      {isOpen && kids.length > 0 && (
        <div className="ml-2 pl-4 border-l border-dt-border">
          {kids.map((k) => (
            <UnitBranch
              key={k.id}
              unit={k}
              childrenOf={childrenOf}
              people={people}
              des={des}
              onChanged={onChanged}
              onAddChild={onAddChild}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrganisationPage() {
  const { confirm, confirmUI } = useConfirm();
  const [tab, setTab] = useState<TabId>('structure');
  const [tree, setTree] = useState<OrgUnit[]>([]);
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [des, setDes] = useState<OrgDigitalEmployee[]>([]);
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [authority, setAuthority] = useState<ApprovalAuthority[]>([]);
  const [editAuth, setEditAuth] = useState<Partial<ApprovalAuthority> | null>(null);
  const [load, setLoad] = useState<OwnerLoad[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newUnitParent, setNewUnitParent] = useState<OrgUnit | null | 'root'>(null);
  const [newUnitKind, setNewUnitKind] = useState<UnitKind>('department');
  const [newUnitName, setNewUnitName] = useState('');
  const [editRule, setEditRule] = useState<Partial<AssignmentRule> | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [t, p, r, l, a, d] = await Promise.all([
        loadOrgTree(), listAssignablePeople(), listAssignmentRules(), loadOwnerLoad(),
        listApprovalAuthority(), listPlaceableDigitalEmployees(),
      ]);
      setTree(t); setPeople(p); setRules(r); setLoad(l); setAuthority(a); setDes(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const unitById = new Map(tree.map((u) => [u.id, u]));
  const childrenOf = new Map<string, OrgUnit[]>();
  for (const u of tree) {
    if (!u.parent_id) continue;
    const list = childrenOf.get(u.parent_id) ?? [];
    list.push(u);
    childrenOf.set(u.parent_id, list);
  }
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
              {tree.filter((u) => u.parent_id === null).map((u) => (
                <UnitBranch
                  key={u.id}
                  unit={u}
                  childrenOf={childrenOf}
                  people={people}
                  des={des}
                  onChanged={refresh}
                  onAddChild={openNewUnit}
                  collapsed={collapsed}
                  onToggle={(id) => setCollapsed((s) => {
                    const next = new Set(s);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  })}
                />
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
                                if (await confirm({
                                  title: `Delete the "${r.name}" rule?`,
                                  message: 'Work this rule used to route will fall through to the next rule that matches it — or to nobody, if none does.',
                                  confirmLabel: 'Delete the rule',
                                })) {
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

      {tab === 'authority' && (
        <PanelCard
          title="Approval limits"
          actions={
            <Button size="sm" onClick={() => setEditAuth({ is_active: true })}>Add limit</Button>
          }
        >
          {authority.length === 0 ? (
            <>
              <Banner tone="warn" className="mb-3">
                <strong>No limits are set, so there are none.</strong> Today anyone who can
                see an approval can grant it — a large credit hold and a small refund are
                checked identically. Adding the first limit below turns this on for
                everybody at once, so add one for yourself first.
              </Banner>
              <EmptyState icon="⚖" headline="Nobody has a signing limit yet">
                A limit says who may approve which kind of work, up to what value, and when
                a second pair of eyes is needed.
              </EmptyState>
            </>
          ) : (
            <>
              <Banner tone="info" className="mb-3">
                Limits are <strong>in force</strong>. Anyone without a matching limit can no
                longer approve — they can still reject, which is always allowed. A limit on a
                department also covers the teams inside it.
              </Banner>
              <TableScroll>
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={TH}>Who</th>
                      <th className={TH}>May approve</th>
                      <th className={TH}>Up to</th>
                      <th className={TH}>Second signature above</th>
                      <th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {authority.map((a) => {
                      const unit = a.org_unit_id ? unitById.get(a.org_unit_id) : null;
                      const person = a.user_id ? people.find((p) => p.user_id === a.user_id) : null;
                      return (
                        <tr key={a.id} className="border-t border-dt-border">
                          <td className={TD}>
                            {unit ? unit.path : person ? (person.full_name || 'Unnamed user')
                              : a.role ? `Everyone with the ${a.role.replace('tenant_', '')} role`
                              : <span className="text-dt-danger">nobody</span>}
                            {!a.is_active && <Chip tone="warn" className="ml-2">OFF</Chip>}
                          </td>
                          <td className={`${TD} text-dt-support`}>
                            {AUTHORITY_CATEGORIES.find((c) => c.value === (a.category ?? ''))?.label ?? a.category}
                          </td>
                          <td className={TD}>
                            {a.max_amount_cents === null
                              ? <Chip tone="warn">NO CEILING</Chip>
                              : fromCents(a.max_amount_cents)}
                          </td>
                          <td className={`${TD} text-dt-support`}>
                            {a.second_approver_above_cents === null ? '—' : fromCents(a.second_approver_above_cents)}
                          </td>
                          <td className={TD}>
                            <div className="flex gap-1.5 justify-end">
                              <Button size="sm" kind="ghost" onClick={() => setEditAuth(a)}>Edit</Button>
                              <Button
                                size="sm"
                                kind="ghost"
                                onClick={async () => {
                                  if (await confirm({
                                    title: 'Remove this approval limit?',
                                    message: 'Whoever relied on it stops being able to approve at this level, and anything waiting on them will need someone else.',
                                    confirmLabel: 'Remove the limit',
                                  })) {
                                    await deleteApprovalAuthority(a.id); await refresh();
                                  }
                                }}
                              >Remove</Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            </>
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

      {editAuth && (
        <Modal title={editAuth.id ? 'Edit approval limit' : 'Add approval limit'} onClose={() => setEditAuth(null)}>
          <div className="space-y-3">
            {authority.length === 0 && !editAuth.id && (
              <Banner tone="warn">
                This is the first limit in the workspace. Until now everyone could approve
                everything; once you save this, only people covered by a limit can approve.
                Make sure this one covers you.
              </Banner>
            )}
            <Field label="Who holds it" hint="Pick a department or team, a role, or one person. A department limit also covers the teams inside it.">
              <select
                className={INPUT_CLS}
                value={editAuth.org_unit_id ? `unit:${editAuth.org_unit_id}`
                     : editAuth.user_id ? `user:${editAuth.user_id}`
                     : editAuth.role ? `role:${editAuth.role}` : ''}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(':');
                  setEditAuth({
                    ...editAuth,
                    org_unit_id: kind === 'unit' ? id : null,
                    user_id: kind === 'user' ? id : null,
                    role: kind === 'role' ? id : null,
                  });
                }}
              >
                <option value="">Choose…</option>
                <optgroup label="Org unit">
                  {tree.filter((u) => u.is_active).map((u) => (
                    <option key={u.id} value={`unit:${u.id}`}>{u.path}</option>
                  ))}
                </optgroup>
                <optgroup label="Role">
                  <option value="role:tenant_owner">Everyone with the owner role</option>
                  <option value="role:tenant_admin">Everyone with the admin role</option>
                  <option value="role:tenant_manager">Everyone with the manager role</option>
                  <option value="role:approver">Everyone with the approver role</option>
                </optgroup>
                <optgroup label="One person">
                  {people.map((p) => (
                    <option key={p.user_id} value={`user:${p.user_id}`}>{p.full_name || 'Unnamed user'}</option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field label="May approve">
              <select
                className={INPUT_CLS}
                value={editAuth.category ?? ''}
                onChange={(e) => setEditAuth({ ...editAuth, category: e.target.value || null })}
              >
                {AUTHORITY_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Up to" hint="Leave blank for no ceiling. Work with no money attached is always covered.">
              <input
                className={INPUT_CLS}
                inputMode="decimal"
                placeholder="e.g. 5000"
                value={fromCents(editAuth.max_amount_cents)}
                onChange={(e) => setEditAuth({ ...editAuth, max_amount_cents: toCents(e.target.value) })}
              />
            </Field>
            <Field label="Second signature above" hint="Leave blank if one approval is always enough. Above this, a different person must approve as well.">
              <input
                className={INPUT_CLS}
                inputMode="decimal"
                placeholder="optional"
                value={fromCents(editAuth.second_approver_above_cents)}
                onChange={(e) => setEditAuth({ ...editAuth, second_approver_above_cents: toCents(e.target.value) })}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button kind="ghost" onClick={() => setEditAuth(null)}>Cancel</Button>
              <Button
                disabled={!editAuth.org_unit_id && !editAuth.user_id && !editAuth.role}
                onClick={async () => {
                  try {
                    await saveApprovalAuthority(editAuth);
                    setEditAuth(null);
                    await refresh();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >{editAuth.id ? 'Save' : 'Create'}</Button>
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
      {confirmUI}
    </div>
  );
}
