import React, { useCallback, useEffect, useState } from 'react';
import { deriveDeAutonomyDials, setDeActionDial } from '../../lib/autonomyApi';
import type { DerivedDial } from '../../lib/autonomyApi';
import { listDefinitions } from '../../lib/playbookBuilderApi';
import type { PlaybookDefinition } from '../../lib/playbookBuilderApi';
import { PanelCard, Button, Chip, Banner, EmptyState, Field, INPUT_CLS } from '../../design/primitives';

// ════════════════════════════════════════════════════════════════════
// What this employee may do on its own — one dial per system it can reach.
//
// The list is DERIVED (migrations 618/619) from the categories this employee
// actually holds a grant to, so a Finance employee reaching nine systems sees
// nine rows and a Growth employee sees two. Never a fixed list: a dial for work
// an employee cannot do is noise, and an action it CAN do with no dial is
// ungoverned.
//
// ⚠ UNSET MEANS NO. Migration 618 removed the workspace default tier, so a
// category with no rule is not "inherit" — the employee does nothing
// automatically there. The empty state says so rather than looking merely
// unconfigured.
//
// The playbook selector writes a rule that applies ONLY while that playbook
// runs, overriding the employee's own rule for the same category. Precedence,
// most specific first: playbook+category → playbook → category → employee → no.
// ════════════════════════════════════════════════════════════════════

interface Draft { enabled: boolean; amount: string; confidence: string }

const centsToInput = (c: number | null): string => (c === null ? '' : String(Math.round(c / 100)));
const inputToCents = (s: string): number | null => {
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return s.trim() === '' || Number.isNaN(n) ? null : Math.round(n * 100);
};

export default function DEActionDials({ deId, canEdit }: { deId: string; canEdit: boolean }) {
  const [dials, setDials] = useState<DerivedDial[] | null>(null);
  const [playbooks, setPlaybooks] = useState<PlaybookDefinition[]>([]);
  const [scope, setScope] = useState<string>('');          // '' = the employee itself
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await deriveDeAutonomyDials(deId);
      setDials(rows);
      const next: Record<string, Draft> = {};
      for (const d of rows) {
        next[d.action_type] = {
          enabled: d.enabled,
          amount: centsToInput(d.max_amount_cents),
          confidence: d.min_confidence === null ? '' : String(d.min_confidence),
        };
      }
      setDrafts(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDials([]);
    }
  }, [deId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Best-effort: a workspace with no playbooks simply has no scope choice.
    void listDefinitions().then((d) => setPlaybooks(d.filter((x) => x.status === 'published'))).catch(() => { /* noop */ });
  }, []);

  const save = async (d: DerivedDial) => {
    const draft = drafts[d.action_type];
    if (!draft) return;
    setSavingKey(d.action_type); setError(null); setSavedKey(null);
    try {
      await setDeActionDial(
        deId,
        { action_type: d.action_type, source_category: d.source_category, label: d.label },
        {
          enabled: draft.enabled,
          max_amount_cents: inputToCents(draft.amount),
          min_confidence: draft.confidence.trim() === '' ? null : Number(draft.confidence),
        },
        scope || null,
      );
      setSavedKey(d.action_type);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSavingKey(null); }
  };

  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts((p) => ({ ...p, [key]: { ...p[key], ...patch } }));

  const scopeLabel = scope
    ? playbooks.find((p) => p.id === scope)?.name ?? 'this playbook'
    : 'this employee everywhere';

  return (
    <PanelCard
      title="What this employee may do on its own"
      badge={dials ? <Chip tone={dials.some((d) => d.configured && d.enabled) ? 'ok' : 'warn'}>
        {dials.filter((d) => d.configured && d.enabled).length} of {dials.length} allowed
      </Chip> : undefined}
    >
      <p className="text-xs text-dt-support mb-3">
        One row per system this employee can actually reach — derived from its own access, not a
        fixed list. A row with no rule means it never acts alone there; it prepares the work and a
        person decides.
      </p>

      {playbooks.length > 0 && (
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <label className="text-[11px] text-dt-support">These rules apply to</label>
          <select
            className={`${INPUT_CLS} !py-1.5 !text-xs max-w-[300px]`}
            value={scope}
            onChange={(e) => { setScope(e.target.value); setSavedKey(null); }}
          >
            <option value="">This employee, everywhere</option>
            {playbooks.map((p) => <option key={p.id} value={p.id}>Only while running: {p.name}</option>)}
          </select>
          {scope && (
            <span className="text-[10px] text-dt-faint">
              A playbook rule overrides the employee’s own rule while that playbook runs, and is
              ignored everywhere else.
            </span>
          )}
        </div>
      )}

      {error && <Banner tone="danger" className="mb-3">{error}</Banner>}

      {dials === null ? (
        <p className="text-xs text-dt-muted">Loading…</p>
      ) : dials.length === 0 ? (
        <EmptyState icon="🔌" headline="This employee cannot reach any system yet">
          Dials appear here for each system it is granted access to, under
          Governance → Data access. Until then there is nothing for it to do on its own.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {dials.map((d) => {
            const draft = drafts[d.action_type] ?? { enabled: false, amount: '', confidence: '' };
            const busy = savingKey === d.action_type;
            return (
              <div key={d.action_type} className="rounded-xl border border-dt-border bg-dt-inset p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm text-dt-body">{d.label}</p>
                    {d.description && <p className="text-[11px] text-dt-muted">{d.description}</p>}
                  </div>
                  {!d.configured
                    ? <Chip tone="warn">Always asks a person</Chip>
                    : d.enabled ? <Chip tone="ok">Acts on its own</Chip> : <Chip tone="neutral">Always asks</Chip>}
                </div>

                {canEdit && (
                  <div className="mt-2 flex items-end gap-2 flex-wrap">
                    <label className="flex items-center gap-2 text-[11px] text-dt-support">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => set(d.action_type, { enabled: e.target.checked })}
                        className="rounded border-dt-border-strong bg-dt-panel"
                      />
                      May act without asking
                    </label>
                    <Field label="Up to (£)">
                      <input
                        className={`${INPUT_CLS} !py-1.5 !text-xs w-28`}
                        value={draft.amount}
                        onChange={(e) => set(d.action_type, { amount: e.target.value })}
                        placeholder="no limit"
                        disabled={!draft.enabled}
                      />
                    </Field>
                    <Field label="Only if sure (%)">
                      <input
                        className={`${INPUT_CLS} !py-1.5 !text-xs w-24`}
                        value={draft.confidence}
                        onChange={(e) => set(d.action_type, { confidence: e.target.value })}
                        placeholder="any"
                        disabled={!draft.enabled}
                      />
                    </Field>
                    <Button size="sm" kind="secondary" disabled={busy} onClick={() => void save(d)}>
                      {busy ? 'Saving…' : 'Save'}
                    </Button>
                    {savedKey === d.action_type && (
                      <span className="text-[11px] text-emerald-300">Saved for {scopeLabel}.</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!canEdit && dials !== null && dials.length > 0 && (
        <p className="mt-3 text-[10px] text-dt-faint">
          Only a workspace owner, admin or manager can change these.
        </p>
      )}
    </PanelCard>
  );
}
