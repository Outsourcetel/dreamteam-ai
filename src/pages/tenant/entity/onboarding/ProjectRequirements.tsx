import React, { useEffect, useMemo, useState } from 'react';
import { PanelCard, Field, INPUT_CLS, Button, EmptyState } from '../../../../design/primitives';
import { listActionDefinitions } from '../../../../lib/connectorApi';
import type { ActionDefinition } from '../../../../lib/connectorApi';
import { saveRequirements } from '../../../../lib/onboardingApi';
import type { OnboardingProject, TemplateVersion } from '../../../../lib/onboardingApi';

// ============================================================
// ProjectRequirements — Task 7 (onboarding-item-execution, mig 674).
// The card that asks a human for the values a bound verb needs, on the
// customer's own project. Every '@ask' param across the version's bound
// items is collected, deduped by '<action_key>.<param>' (resolveParams'
// own keying — two verbs can both take a "territory" meaning different
// things), and rendered using the verb's OWN param_schema.help as the
// question. Nobody writes these prompts twice; they are generated from the
// verb the template author already picked in VerbBinding.
//
// Shows EmptyState when nothing on this checklist is bound yet — the
// honest state for most templates today, since binding a verb is brand new.
// ============================================================

interface AskField {
  /** '<action_key>.<param>' — the exact key resolveParams reads. */
  key: string;
  param: string;
  verbLabel: string;
  hint?: string;
}

export default function ProjectRequirements({ project, version, accountName, onSaved }: {
  project: OnboardingProject;
  version: TemplateVersion;
  accountName: string;
  onSaved: (requirements: Record<string, string>) => void;
}) {
  const [actions, setActions] = useState<ActionDefinition[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>(project.requirements ?? {});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    listActionDefinitions().then(setActions).catch(() => setActions([]));
  }, []);

  useEffect(() => { setDraft(project.requirements ?? {}); }, [project.id, project.requirements]);

  // First offer wins on a duplicate action_key, matching de-work's own
  // actionByKey tie-break — the same verb can be registered under several
  // providers with different param_schema, and this is only for the hint
  // text, not for execution.
  const byActionKey = useMemo(() => {
    const m = new Map<string, ActionDefinition>();
    for (const a of actions) if (!m.has(a.action_key)) m.set(a.action_key, a);
    return m;
  }, [actions]);

  const fields = useMemo<AskField[]>(() => {
    const seen = new Set<string>();
    const out: AskField[] = [];
    for (const item of version.items) {
      if (!item.action_key || !item.params) continue;
      const def = byActionKey.get(item.action_key);
      for (const [param, spec] of Object.entries(item.params)) {
        if (spec !== '@ask') continue;
        const key = `${item.action_key}.${param}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const schema = def?.param_schema.find(p => p.name === param);
        out.push({ key, param, verbLabel: def?.label ?? item.action_key, hint: schema?.help });
      }
    }
    return out;
  }, [version.items, byActionKey]);

  const title = `${accountName} — what we need to set them up`;

  if (fields.length === 0) {
    return (
      <PanelCard title={title} className="mb-4">
        <EmptyState icon="🧾" headline="Nothing bound here asks for customer answers yet">
          No item on this checklist names a verb with an "ask when we set the customer up" parameter — bind one in the template editor and its questions appear here automatically.
        </EmptyState>
      </PanelCard>
    );
  }

  const save = async () => {
    setSaving(true); setErr(null); setSaved(false);
    try {
      await saveRequirements(project.id, draft);
      onSaved(draft);
      setSaved(true);
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <PanelCard title={title} className="mb-4"
      actions={<Button kind="primary" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save answers'}</Button>}>
      <div className="grid sm:grid-cols-2 gap-3">
        {fields.map(f => (
          <Field key={f.key} label={`${f.param} — ${f.verbLabel}`} hint={f.hint}>
            <input
              className={INPUT_CLS}
              value={draft[f.key] ?? ''}
              onChange={e => { setSaved(false); setDraft(d => ({ ...d, [f.key]: e.target.value })); }}
            />
          </Field>
        ))}
      </div>
      {err && <p className="text-xs text-dt-danger mt-3">{err}</p>}
      {saved && !err && <p className="text-xs text-dt-ok mt-3">Saved — the next time a bound item runs, it uses these answers.</p>}
    </PanelCard>
  );
}
