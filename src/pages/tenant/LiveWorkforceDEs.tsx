// ════════════════════════════════════════════════════════════
// Workforce roster — the DEs list and the Teams panel.
//
// The Employee File's own panels used to live in this file too (4,414 lines,
// two unrelated surfaces in one module). They now sit in ./EmployeeFileSections,
// which is where EmployeeFilePage imports them from. Nothing moved between the
// two halves except useCanManageDe, which both need and which stays here.
// ════════════════════════════════════════════════════════════

import { useIsTenantAdmin } from '../../lib/useRoleGate';
import { useConfirm } from '../../components/useDialog';
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../supabase';
import type { Page } from '../../types';
import { useOpenEmployeeFile } from '../../lib/employeeFileRoute';
import AISessionPanel from '../../components/AISessionPanel';
import { PanelCard, Button, EntityRow, EmployeeCard, Banner, EmptyState, Drawer } from '../../design/primitives';
import { say, DE_STATUS } from '../../design/statusVocabulary';
import { summariseWork, workCells } from '../../lib/workSummary';
import type { WorkSummary } from '../../lib/workSummary';
import { getDeInquiryMetrics, getDeActionMetrics, getDeCostMetricsRanged, getOutcomeMetering } from '../../lib/api';
import { countDeOutputs } from '../../lib/deWorkbenchApi';
import { listDigitalEmployees, createDigitalEmployee } from '../../lib/digitalEmployeesApi';
import type { DigitalEmployee } from '../../lib/digitalEmployeesApi';
import { listDeHealth, DE_HEALTH_LABELS } from '../../lib/deHealthApi';
import type { DEHealth } from '../../lib/deHealthApi';
import { listAuditEvents } from '../../lib/guardrailApi';
import type { AuditEvent } from '../../lib/guardrailApi';

// ════════════════════════════════════════════════════════════
// ⚠ WHO MAY CHANGE AN EMPLOYEE.
//
// This page is ALL_TENANT in navAccess — a tenant_user can open any employee's
// file. But every set_de_* / lifecycle / team RPC below is owner/admin-gated in
// the DATABASE, so a tenant_user could fill in Identity, Voice, KPIs or hit
// Pause and get an error back. Nineteen controls across ten panels behaved that
// way; DEActionDials was the only one that took a permission prop.
//
// The database was never wrong — it refused correctly. The UI was offering
// controls it knew would fail, which is precisely what navAccess's own header
// says default-deny exists to stop.
//
// One hook, matching the server's gate exactly. Panels use it to disable their
// MUTATING controls only — navigation, refresh and read-only views stay live,
// because a viewer who cannot edit can still legitimately look.
// ════════════════════════════════════════════════════════════
export function useCanManageDe(): boolean {
  const { authedUser, isDTUser } = useAuth();
  return isDTUser || ['tenant_owner', 'tenant_admin'].includes(authedUser?.role ?? '');
}

/** One line, same wording everywhere, so "you cannot edit this" never reads as
 *  a bug. Rendered by a panel when the viewer may look but not change. */
export function ReadOnlyNote({ what }: { what: string }) {
  return (
    <p className="text-[11px] text-dt-muted mb-2">
      You can see {what} here, but changing it needs an owner or admin.
    </p>
  );
}

// ── Roster + "Add a Digital Employee" — the generic persona-creation
// capability (migration 037). Domain-agnostic: creates ANY future DE,
// not just Account/Finance/etc. Simple enough for a non-technical
// admin: name + role label are the only required fields.
function RosterPanel({ onSelect, setPage }: { onSelect: (de: DigitalEmployee) => void; setPage: (p: Page) => void }) {
  const { currentTenant } = useAuth();
  // ⚠ HIRING IS NOW A ROUTE, AND THE ROUTE IS ADMIN-ONLY. While the wizard
  // was a modal this button always opened SOMETHING and the wizard disabled
  // its own draft button for non-admins. As a page, handleSetPage simply
  // refuses for anyone below admin — so an ungated button would take the
  // click and do nothing at all, which reads as a broken product rather than
  // as a boundary. Same tier as PAGE_ACCESS.workforce_hire, deliberately.
  const canHire = useIsTenantAdmin();
  const [des, setDes] = useState<DigitalEmployee[] | null>(null);
  const [health, setHealth] = useState<Record<string, DEHealth>>({});
  // What each employee actually DID, from the same four sources the Results
  // tab reads, summarised by the same function — so the two screens cannot
  // drift into disagreeing about what "handled" means.
  const [work, setWork] = useState<Record<string, WorkSummary>>({});
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Which employee the plain-language editor is open for, if any.
  const [editingDe, setEditingDe] = useState<{ id: string; label: string } | null>(null);
  // Retired/archived employees are kept but hidden until asked for.
  const [showRetired, setShowRetired] = useState(false);
  const [retiredCount, setRetiredCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [personaName, setPersonaName] = useState('');
  const [department, setDepartment] = useState('');
  const [description, setDescription] = useState('');

  const refresh = useCallback(async () => {
    try {
      // Fetch both so the "retired" count is honest without a second trip.
      const all = await listDigitalEmployees(true);
      const active = all.filter(d => !['retired', 'archived'].includes(String(d.lifecycle_status)));
      setRetiredCount(all.length - active.length);
      setDes(showRetired ? all : active);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load the roster.');
    }
    try {
      const h = await listDeHealth();
      setHealth(Object.fromEntries(h.map(x => [x.de_id, x])));
    } catch { /* health is supplementary — a roster still renders without it */ }
    // Work summary is supplementary too: if any of this fails the roster still
    // lists everyone, it just cannot say what they have been doing.
    try {
      const tid = currentTenant?.id ?? null;
      if (tid) {
        const [inq, act, cost, om] = await Promise.all([
          getDeInquiryMetrics(tid, 30), getDeActionMetrics(tid, 30),
          getDeCostMetricsRanged(tid, 30), getOutcomeMetering(tid, 30),
        ]);
        const iBy = new Map(inq.map(x => [x.de_id, x]));
        const aBy = new Map(act.map(x => [x.de_id, x]));
        const cBy = new Map(cost.map(x => [x.de_id, x]));
        const mBy = new Map((om?.by_de ?? []).map(x => [x.de_id, x]));
        const ids = new Set([...iBy.keys(), ...aBy.keys(), ...cBy.keys(), ...mBy.keys(), ...(des ?? []).map(d => d.id)]);
        const outs = new Map<string, { items_done?: number; deliverables?: number }>();
        await Promise.all([...ids].map(async id => {
          try { outs.set(id, await countDeOutputs(id, 30)); } catch { /* per-employee */ }
        }));
        const next: Record<string, WorkSummary> = {};
        for (const id of ids) {
          next[id] = summariseWork({ inquiry: iBy.get(id), action: aBy.get(id), cost: cBy.get(id), metering: mBy.get(id), outputs: outs.get(id) });
        }
        setWork(next);
      }
    } catch { /* the roster is still a roster without it */ }
  }, [showRetired, currentTenant?.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    if (!name.trim()) { setError('Give the new Digital Employee a name or role label.'); return; }
    setBusy(true); setError(null);
    try {
      await createDigitalEmployee({
        name: name.trim(),
        personaName: personaName.trim() || undefined,
        department: department.trim() || undefined,
        description: description.trim() || undefined,
      });
      setName(''); setPersonaName(''); setDepartment(''); setDescription('');
      setAdding(false);
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || 'Failed to create the Digital Employee. Only workspace owners/admins can do this.');
    } finally {
      setBusy(false);
    }
  };

  if (des === null) return null;

  return (
    <PanelCard
      title="Your workforce"
      actions={!adding && (
        <>
          {/* Retiring an employee used to leave it in this list forever,
              so the action looked like it had done nothing. */}
          {retiredCount > 0 && (
            <Button kind="ghost" size="sm" onClick={() => setShowRetired(v => !v)}>
              {showRetired ? 'Hide retired' : `Show retired (${retiredCount})`}
            </Button>
          )}
          {canHire && <Button kind="primary" size="sm" onClick={() => setPage('workforce_hire')}>✨ Hire with AI</Button>}
          <Button kind="secondary" size="sm" onClick={() => setAdding(true)}>+ Add manually</Button>
        </>
      )}
    >
      <div>
      {editingDe && (
        // ── A conversation belongs beside the list, not on top of it ────────
        //
        // This was a Modal at size="2xl" with a fixed h-[600px]. Changing how
        // an employee behaves is a conversation you have WHILE looking at who
        // you're changing — a dialog covers the roster with the answer to a
        // question the roster was asking. As a drawer the list stays visible
        // behind it, which is the context that makes the chat legible.
        //
        // chrome={false} because AISessionPanel draws its own header and close
        // button; it still gains Escape, scroll-lock and focus return from the
        // primitive, which is what it was missing when hand-rolled.
        <Drawer wide chrome={false} padded={false} onClose={() => setEditingDe(null)}>
          <div className="h-full flex flex-col overflow-hidden">
            <AISessionPanel
              subjectKind="de"
              subjectId={editingDe.id}
              subjectLabel={editingDe.label}
              onChanged={() => { void refresh(); }}
              onClose={() => setEditingDe(null)}
            />
          </div>
        </Drawer>
      )}
      <p className="text-xs text-dt-muted mb-4">
        Everyone working for {des.length > 0 ? 'your company' : 'you'} today. Each one is set up independently below —
        data access, playbooks, and trust build up the same way for every department.
      </p>

      {error && <Banner tone="danger" className="mb-3">{error}</Banner>}

      <div className="grid grid-cols-dt-cards gap-dt mb-3">
        {des.map(de => {
          const w = work[de.id];
          const cells = w ? workCells(w) : [];
          const state = say(DE_STATUS, de.status);
          const h = health[de.id];
          return (
            <EmployeeCard
              key={de.id}
              onOpen={() => onSelect(de)}
              avatar={
                <div className="w-10 h-10 rounded-lg bg-dt-accent-soft border border-dt-accent/30 flex items-center justify-center text-dt-accent-text font-semibold flex-shrink-0">
                  {(de.persona_name || de.name).charAt(0).toUpperCase()}
                </div>
              }
              name={de.persona_name || de.name}
              state={{ label: state.label, tone: state.tone, means: state.means }}
              role={`${de.department || de.category} · ${de.description || 'No description yet.'}`}
              stats={cells}
              /* ⚠ Says which it is. "0 handled" and "nothing recorded" look the
                 same on a card and mean opposite things — one is an employee
                 doing nothing, the other is a measurement gap. */
              lastAction={cells.length === 0
                ? (h ? DE_HEALTH_LABELS[h.state]?.label ?? 'Nothing recorded in the last 30 days' : 'Nothing recorded in the last 30 days')
                : undefined}
              actions={
                <Button kind="ai" size="sm" title="Describe what to change, in plain language"
                  onClick={() => setEditingDe({ id: de.id, label: de.persona_name || de.name })}>
                  ✨ Edit with AI
                </Button>
              }
            />
          );
        })}
        {des.length === 0 && (
          <EmptyState headline="No digital employees yet">
            Hire your first one with AI above — it starts supervised, with no data access until you grant it.
          </EmptyState>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-dt-border-strong bg-dt-inset p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-dt-support">
              Role / label (required)
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Account Success DE"
                className="mt-1 w-full bg-dt-card border border-dt-border-strong rounded-lg px-2.5 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
            </label>
            <label className="text-xs text-dt-support">
              Persona name (optional)
              <input value={personaName} onChange={e => setPersonaName(e.target.value)} placeholder="e.g. Jordan"
                className="mt-1 w-full bg-dt-card border border-dt-border-strong rounded-lg px-2.5 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
            </label>
          </div>
          <label className="text-xs text-dt-support block">
            Department
            <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="e.g. Account Success"
              className="mt-1 w-full bg-dt-card border border-dt-border-strong rounded-lg px-2.5 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="text-xs text-dt-support block">
            What does this Digital Employee do?
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="Plain language — what this DE is responsible for"
              className="mt-1 w-full bg-dt-card border border-dt-border-strong rounded-lg px-2.5 py-1.5 text-dt-body text-xs focus:border-indigo-500 focus:outline-none" />
          </label>
          <p className="text-[11px] text-dt-muted">
            Starts supervised with no data access and no playbooks — you (or an admin) grant those next, the same way for every DE.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => void submit()} disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40 transition-colors">
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button onClick={() => setAdding(false)} className="text-xs text-dt-muted hover:text-dt-support">Cancel</button>
          </div>
        </div>
      )}
      </div>
    </PanelCard>
  );
}

// ── Workforce Teams panel — fallback chains (DE-C2, migration 128).
// Rank 1 = primary responder; higher ranks are backups that take over
// a shared work source automatically when everyone ranked above them
// is paused or unavailable. Teams never grant access — a backup still
// needs its own grant on the source (Control Fabric stays sovereign).
type TeamRow = { id: string; name: string; purpose: string; status: string };
type TeamMemberRow = {
  id: string; team_id: string; de_id: string; fallback_rank: number;
  digital_employees: { name: string; persona_name: string | null; lifecycle_status: string; status: string } | null;
};
function TeamsPanel() {
  const canManage = useCanManageDe();
  const { confirm, confirmUI } = useConfirm();
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [des, setDes] = useState<Array<{ id: string; name: string; lifecycle_status: string }>>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [addDe, setAddDe] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: t, error: tErr }, { data: m }, { data: d }] = await Promise.all([
      supabase.from('workforce_teams').select('id, name, purpose, status').eq('status', 'active').order('created_at'),
      supabase.from('workforce_team_members')
        .select('id, team_id, de_id, fallback_rank, digital_employees(name, persona_name, lifecycle_status, status)')
        .order('fallback_rank'),
      supabase.from('digital_employees').select('id, name, persona_name, lifecycle_status')
        .not('lifecycle_status', 'in', '(retired,archived)').order('name'),
    ]);
    if (tErr) { setError(tErr.message); return; }
    setTeams((t ?? []) as TeamRow[]);
    setMembers((m ?? []) as unknown as TeamMemberRow[]);
    // Same rule as the member rows below: the name the employee answers to,
    // falling back to the internal role name. The picker used to show the role
    // name while the row it added showed the persona.
    setDes(((d ?? []) as Array<{ id: string; name: string; persona_name: string | null; lifecycle_status: string }>)
      .map((row) => ({ id: row.id, name: row.persona_name || row.name, lifecycle_status: row.lifecycle_status })));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    await load();
    setBusy(false);
  };

  const createTeam = () => run(async () => {
    const res = await supabase.rpc('upsert_workforce_team', { p_name: name.trim(), p_purpose: purpose.trim() });
    if (!res.error) { setName(''); setPurpose(''); setShowCreate(false); }
    return res;
  });

  const addMember = (teamId: string) => {
    const deId = addDe[teamId];
    if (!deId) return;
    const teamMembers = members.filter(m => m.team_id === teamId);
    const nextRank = teamMembers.length === 0 ? 1 : Math.max(...teamMembers.map(m => m.fallback_rank)) + 1;
    void run(() => supabase.rpc('set_workforce_team_member', { p_team_id: teamId, p_de_id: deId, p_fallback_rank: nextRank }));
    setAddDe(prev => ({ ...prev, [teamId]: '' }));
  };

  return (
    <div className="rounded-2xl border border-dt-border bg-dt-card p-6 mt-6">
      <div className="mb-1 flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-white">Backup &amp; coverage — Workforce Teams</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">fallback chains</span>
        <button onClick={() => setShowCreate(s => !s)}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-panel text-dt-body">
          {showCreate ? 'Cancel' : '+ New team'}
        </button>
      </div>
      <p className="text-[11px] text-dt-muted mb-3">
        This answers one question: if an employee is paused, retired, or falls unhealthy, who picks
        up its work? Within a team, the highest-ranked available employee owns each shared inbox;
        backups take over automatically when it is paused or unavailable, and the specialist desk
        covers after that. Teams never grant access — a backup still needs its own grant on the
        system it covers. Optional: with one employee per function, you can ignore this entirely.
      </p>
      {error && <p className="text-xs text-rose-300 mb-2">{error}</p>}

      {showCreate && (
        <div className="mb-4 rounded-xl border border-dt-border bg-dt-page p-3 space-y-2">
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Team name — e.g. Support Workforce"
            className="w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="Purpose (optional)"
            className="w-full bg-dt-card border border-dt-border text-dt-body text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500" />
          <button onClick={() => void createTeam()} disabled={busy || !canManage || !name.trim()}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40">
            Create team
          </button>
        </div>
      )}

      {teams === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : teams.length === 0 ? (
        <p className="text-xs text-dt-muted">No teams yet — a team defines who owns an inbox and who covers when they can’t.</p>
      ) : (
        <div className="space-y-4">
          {teams.map(team => {
            const teamMembers = members.filter(m => m.team_id === team.id).sort((a, b) => a.fallback_rank - b.fallback_rank);
            const memberIds = new Set(teamMembers.map(m => m.de_id));
            return (
              <div key={team.id} className="rounded-xl border border-dt-border bg-dt-page p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-white font-medium">{team.name}</span>
                  <button onClick={async () => {
                    if (!await confirm({
                      title: `Archive the "${team.name}" team?`,
                      message: 'Its fallback chain stops applying, so work that used to pass down this team goes wherever the next matching rule sends it.',
                      confirmLabel: 'Archive it',
                    })) return;
                    void run(() => supabase.rpc('archive_workforce_team', { p_team_id: team.id }));
                  }}
                    disabled={busy || !canManage}
                    className="ml-auto text-xs text-dt-muted hover:text-rose-300">
                    Archive
                  </button>
                </div>
                {team.purpose && <p className="text-[11px] text-dt-muted mt-0.5">{team.purpose}</p>}
                <div className="mt-2 space-y-1">
                  {teamMembers.length === 0 && <p className="text-[11px] text-dt-faint">No members yet.</p>}
                  {teamMembers.map(m => {
                    const de = m.digital_employees;
                    const eligible = de && ['assigned', 'active', 'improving'].includes(de.lifecycle_status) && de.status === 'active';
                    return (
                      <div key={m.id} className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${m.fallback_rank === 1 ? 'bg-indigo-500/15 text-indigo-300' : 'bg-dt-panel text-dt-support'}`}>
                          {m.fallback_rank === 1 ? 'Primary' : `Backup #${m.fallback_rank - 1}`}
                        </span>
                        <span className="text-dt-support">{de?.persona_name || de?.name || 'Unknown'}</span>
                        <span className={`text-[10px] ${eligible ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {eligible ? 'on duty' : (de?.lifecycle_status ?? '')}
                        </span>
                        <button onClick={() => void run(() => supabase.rpc('set_workforce_team_member', { p_team_id: team.id, p_de_id: m.de_id, p_fallback_rank: null }))}
                          disabled={busy || !canManage}
                          className="ml-auto text-[10px] text-dt-faint hover:text-rose-300">
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <select value={addDe[team.id] ?? ''} disabled={busy || !canManage}
                    onChange={e => setAddDe(prev => ({ ...prev, [team.id]: e.target.value }))}
                    className="flex-1 bg-dt-card border border-dt-border text-dt-support text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500">
                    <option value="">Add a member…</option>
                    {des.filter(d => !memberIds.has(d.id)).map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <button onClick={() => addMember(team.id)} disabled={busy || !canManage || !addDe[team.id]}
                    className="text-xs px-3 py-1.5 rounded-lg bg-dt-panel hover:bg-dt-panel text-dt-body disabled:opacity-40">
                    Add
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {confirmUI}
    </div>
  );
}

export default function LiveWorkforceDEs({ setPage }: { setPage: (p: Page) => void }) {
  const openFile = useOpenEmployeeFile(setPage);
  const { liveTenantName } = useAuth();
  return (
    <div className="p-6">
      {/* Rendered under the Workforce hub — the hub names the view. One
          employee, one page: a click goes straight to the Employee File. */}
      <p className="text-dt-support text-sm mb-5">
        {liveTenantName || 'Your company'} · Click an employee to open their file — work, performance, setup and trust in one place
      </p>
      {/* max-w-3xl (768px) was a reading-width cap wrapped around a card grid
          on a page with 1278px to spend — the roster got one column and the
          rest of the screen went to nothing. A Tailwind default standing in
          for a decision nobody made, which is the reason --dt-content-max
          exists. */}
      <div className="max-w-dt-content">
        <RosterPanel onSelect={de => openFile(de.id)} setPage={setPage} />
        <TeamsPanel />
      </div>
    </div>
  );
}
