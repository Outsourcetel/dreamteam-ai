import React, { useEffect, useState } from 'react';
import { SELECT_CLS, INPUT_CLS, Field, EmptyState } from '../../../../design/primitives';
import { listActionDefinitions } from '../../../../lib/connectorApi';
import type { ActionDefinition } from '../../../../lib/connectorApi';
import type { TemplateItem } from '../../../../lib/onboardingApi';

// ============================================================
// VerbBinding — Task 6 (onboarding-item-execution, mig 674).
// Binds a template item to the verb (action_definition) a digital employee
// performs for it, in the template editor. An item that names no verb keeps
// behaving exactly as it always has — this is purely additive, and renders
// nothing at all unless the item is DE-owned (a human or "either" item has
// nothing here for a DE to run; validate_onboarding_items enforces the same
// rule server-side at publish time).
//
// Selection is keyed by the action_definition's own id, not its action_key:
// the same action_key legitimately exists across several providers (e.g.
// send_payment_reminder registered under erpnext, quickbooks, stripe AND
// xero) and a native <select> cannot disambiguate options that share a
// value. Only the plain action_key string is ever written onto the item —
// that is the identifier the rest of the system (resolveParams, de-work's
// perform_onboarding_item) binds by.
// ============================================================

const ACCOUNT = '@account';
const ASK = '@ask';
const LITERAL = '__literal__';
const UNSET = '';

export default function VerbBinding({ item, onChange }: {
  item: TemplateItem;
  onChange: (next: TemplateItem) => void;
}) {
  const [actions, setActions] = useState<ActionDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (item.owner_type !== 'de') { setLoading(false); return; }
    let cancelled = false;
    listActionDefinitions()
      .then(rows => { if (!cancelled) setActions(rows); })
      .catch(() => { if (!cancelled) setActions([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.owner_type]);

  // Hooks above run unconditionally; the early-out has to come after them.
  if (item.owner_type !== 'de') return null;

  const selectedDef = actions.find(a => a.action_key === item.action_key);
  const params = item.params ?? {};

  // Group by category, matching the same picker pattern already used for
  // connector-action steps in the playbook builder (LivePlaybookBuilder's
  // ConnectorActionEditor) — raw category string, not CATEGORY_LABELS: the
  // live table carries category values (e.g. "platform_admin") that fall
  // outside the browser's SystemCategory union, and a lookup miss there
  // would silently render "undefined" as a group label.
  const byCategory = actions.reduce<Record<string, ActionDefinition[]>>((acc, a) => {
    (acc[a.category] ??= []).push(a);
    return acc;
  }, {});

  const pickAction = (id: string) => {
    if (!id) { onChange({ ...item, action_key: undefined, params: undefined }); return; }
    const def = actions.find(a => a.id === id);
    if (!def) return;
    const nextParams: Record<string, string> = {};
    for (const p of def.param_schema) {
      // external_ref → "we already know this"; every other REQUIRED param
      // must be NAMED here (validate_onboarding_items rule (d) rejects a
      // required param missing as a key) so it defaults to "ask"; optional
      // params default to unset/omitted rather than guessing an answer.
      if (p.name === 'external_ref') nextParams[p.name] = ACCOUNT;
      else if (p.required) nextParams[p.name] = ASK;
    }
    onChange({ ...item, action_key: def.action_key, params: nextParams });
  };

  const setParam = (name: string, value: string | undefined) => {
    const next = { ...params };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange({ ...item, params: next });
  };

  return (
    <div className="w-full pl-6 mt-1.5 pt-1.5 border-t border-dt-border space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-dt-accent-text font-medium whitespace-nowrap">Performs:</span>
        {!loading && actions.length === 0 ? (
          <span className="text-[11px] text-dt-faint">No registered verb — this employee records progress by hand.</span>
        ) : (
          <select
            className={SELECT_CLS}
            disabled={loading}
            value={selectedDef?.id ?? ''}
            onChange={e => pickAction(e.target.value)}
          >
            <option value="">{loading ? 'Loading…' : 'No verb — record only'}</option>
            {Object.entries(byCategory).map(([cat, list]) => (
              <optgroup key={cat} label={cat.replace(/_/g, ' ')}>
                {list.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.label}{a.risk?.destructive ? ' ⚠' : ''}{a.scope === 'tenant' ? ' (yours)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </div>

      {!loading && actions.length === 0 && (
        <EmptyState icon="🔌" headline="No connected system offers an action this employee could run">
          Register or connect a system with a bindable verb, then this item can name it — until then, leave it unbound and the DE records progress by hand, exactly as every item does today.
        </EmptyState>
      )}

      {selectedDef && selectedDef.param_schema.length > 0 && (
        <div className="space-y-2">
          {selectedDef.param_schema.map(p => {
            const spec = params[p.name];
            const isLiteral = spec !== undefined && spec !== ACCOUNT && spec !== ASK;
            const selectValue = spec === undefined ? UNSET : (spec === ACCOUNT || spec === ASK) ? spec : LITERAL;
            return (
              <Field key={p.name} label={`${p.name}${p.required ? ' *' : ''}`} hint={p.help}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select
                    className={SELECT_CLS}
                    value={selectValue}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === UNSET) setParam(p.name, undefined);
                      else if (v === LITERAL) setParam(p.name, '');
                      else setParam(p.name, v);
                    }}
                  >
                    <option value={UNSET}>Leave unset{p.required ? ' (required — publish will reject this)' : ' (optional)'}</option>
                    <option value={ACCOUNT}>We already know this</option>
                    <option value={ASK}>Ask when we set the customer up</option>
                    <option value={LITERAL}>Always use…</option>
                  </select>
                  {isLiteral && (
                    <input
                      className={INPUT_CLS}
                      value={spec ?? ''}
                      placeholder="literal value"
                      onChange={e => setParam(p.name, e.target.value)}
                    />
                  )}
                </div>
              </Field>
            );
          })}
        </div>
      )}
    </div>
  );
}
