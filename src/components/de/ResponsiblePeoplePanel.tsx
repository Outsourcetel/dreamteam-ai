/**
 * ResponsiblePeoplePanel — who is accountable for this digital employee.
 *
 * WHY THIS EXISTS
 * A digital employee is described throughout this product as an employee, not a
 * bot. Employees have a line manager and a department head; until now DEs had
 * nobody. 116 of them existed in production and not one had a named owner —
 * `digital_employees.owner_id` was a column that had been declared and never
 * filled, referenced by no policy. So "who do I ask about this one?" had no
 * answer anywhere in the product.
 *
 * This panel is the answer, and it is also the input to permissions: the
 * assignments shown here are what `can_access_de()` reads when deciding whether
 * somebody below manager may see a DE at all (migration 385, docs/29 §5).
 *
 * WHY THREE RELATIONS AND WHY THEY STACK
 *   primary    responsible day to day, and for its knowledge
 *   manager    their line manager for this DE
 *   executive  the C-level accountable for it
 *
 * They are not exclusive. The same person may hold two — in a small team the
 * manager often IS the primary — so this renders a list per relation rather
 * than a single dropdown, which would quietly force a choice the org has not
 * made.
 *
 * WHAT THIS PANEL DOES NOT DO
 * It does not decide access. It records responsibility; the database decides
 * access from it. Nothing here can widen what somebody sees — a person added
 * as `primary` gains access because `can_access_de()` reads the row, not
 * because this component rendered a chip. That distinction matters the day
 * somebody reads this file wondering whether the UI can be tricked.
 *
 * HONEST EMPTY STATE
 * An unassigned DE is a governance gap, not a neutral default, so the empty
 * state says so plainly rather than showing a tidy "—".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../supabase';
import { useAuth } from '../../context/AuthContext';

type Relation = 'primary' | 'manager' | 'executive';

const RELATIONS: { key: Relation; label: string; help: string }[] = [
  { key: 'primary',   label: 'Primary',   help: 'Runs this employee day to day and owns its knowledge.' },
  { key: 'manager',   label: 'Manager',   help: 'Line manager — approves its escalations and sets its trust level.' },
  { key: 'executive', label: 'Executive', help: 'Accountable at leadership level. Sees it, signs off on it.' },
];

type Assignment = { id: string; user_id: string; relation: Relation; full_name: string | null; email: string | null };
type Member = { user_id: string; full_name: string | null; email: string | null };

export default function ResponsiblePeoplePanel({ deId, deName }: { deId: string; deName?: string }) {
  const { currentTenant } = useAuth();
  const [rows, setRows] = useState<Assignment[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase.rpc('list_de_assignments', { p_de_id: deId });
    if (e) setError(e.message); else { setError(null); setRows((data ?? []) as Assignment[]); }
    setLoading(false);
  }, [deId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!currentTenant?.id) return;
    // Same RPC the team page uses: profiles has no email column, so listing
    // members means joining auth.users server-side (migration 089).
    supabase.rpc('list_team_members_full', { p_tenant_id: currentTenant.id }).then(({ data }) => {
      setMembers(((data ?? []) as Record<string, unknown>[]).map(r => ({
        user_id: String(r.user_id ?? ''),
        full_name: (r.full_name as string) ?? null,
        email: (r.email as string) ?? null,
      })).filter(m => m.user_id));
    });
  }, [currentTenant?.id]);

  const assign = async (userId: string, relation: Relation) => {
    if (!userId) return;
    setBusy(relation); setError(null);
    const { error: e } = await supabase.rpc('set_de_assignment',
      { p_de_id: deId, p_user_id: userId, p_relation: relation });
    // The server's own sentence, verbatim. "insufficient_permission: assigning
    // responsibility requires manager" tells somebody what to do next;
    // "Failed to save" does not.
    if (e) setError(e.message);
    await load();
    setBusy(null);
  };

  const unassign = async (id: string) => {
    setBusy(id); setError(null);
    const { error: e } = await supabase.rpc('remove_de_assignment', { p_id: id });
    if (e) setError(e.message);
    await load();
    setBusy(null);
  };

  const nameOf = (m: { full_name: string | null; email: string | null }) =>
    m.full_name || m.email || 'Unnamed person';

  const totalAssigned = rows.length;

  return (
    <div className="bg-dt-card border border-dt-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
        <h2 className="text-sm font-semibold text-white">Responsible people</h2>
        {!loading && totalAssigned === 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">Nobody assigned</span>
        )}
      </div>
      <p className="text-xs text-dt-muted mb-4">
        Who answers for {deName ? <span className="text-dt-body">{deName}</span> : 'this employee'}. This is also what
        decides who can see it: people below manager level see only the digital employees they are named on.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          {RELATIONS.map(rel => {
            const mine = rows.filter(r => r.relation === rel.key);
            const unassignedMembers = members.filter(m => !mine.some(r => r.user_id === m.user_id));
            return (
              <div key={rel.key} className="border-t border-dt-border/60 pt-3 first:border-t-0 first:pt-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs font-medium text-dt-body">{rel.label}</span>
                  <span className="text-[11px] text-dt-muted">{rel.help}</span>
                </div>

                <div className="flex flex-wrap gap-2 mt-2">
                  {mine.map(r => (
                    <span key={r.id}
                      className="inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full bg-dt-panel text-dt-body">
                      {r.full_name || r.email || 'Unnamed person'}
                      <button
                        onClick={() => unassign(r.id)}
                        disabled={busy === r.id}
                        title={`Remove as ${rel.label.toLowerCase()}`}
                        className="text-dt-muted hover:text-red-400 disabled:opacity-40"
                      >×</button>
                    </span>
                  ))}
                  {mine.length === 0 && (
                    <span className="text-xs text-amber-300/80">No {rel.label.toLowerCase()} named</span>
                  )}
                </div>

                <select
                  value=""
                  disabled={busy === rel.key || unassignedMembers.length === 0}
                  onChange={e => assign(e.target.value, rel.key)}
                  className="mt-2 text-xs bg-dt-inset border border-dt-border rounded-lg px-2 py-1.5 text-dt-body disabled:opacity-40"
                >
                  <option value="">
                    {unassignedMembers.length === 0 ? 'Everyone is already named here' : `Add ${rel.label.toLowerCase()}…`}
                  </option>
                  {unassignedMembers.map(m => (
                    <option key={m.user_id} value={m.user_id}>{nameOf(m)}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {!loading && totalAssigned === 0 && (
        <p className="text-xs text-dt-muted mt-4">
          Nobody is named on this digital employee. It still works — but if it makes a bad call, there is no
          record of who should have caught it.
        </p>
      )}
    </div>
  );
}
