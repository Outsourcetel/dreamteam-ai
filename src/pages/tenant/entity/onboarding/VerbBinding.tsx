import React, { useEffect, useMemo, useState } from 'react';
import { SELECT_CLS, INPUT_CLS, Field, EmptyState } from '../../../../design/primitives';
import { listActionDefinitions, listConnectors } from '../../../../lib/connectorApi';
import type { ActionDefinition, Connector } from '../../../../lib/connectorApi';
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
//
// REACHABILITY (fix after review; server side closed by mig 681): until
// mig 681, validate_onboarding_items checked only that action_key named an
// active definition VISIBLE to the tenant, and platform actions
// (tenant_id is null) are visible to EVERY tenant — so nothing stopped a
// template author binding an action this workspace has no connector to
// actually run. This picker offering only reachable verbs is the first line;
// mig 681 made it the enforced one, rejecting an unreachable binding at
// publish time and tightening certify's onboarding-bindings-are-runnable
// probe to match.
//
// ⚠ mig 693 — THIS PICKER IS NOW THE WEAKEST OF THE THREE, ON PURPOSE.
// The server enforces a SECOND gate this list cannot: the runtime filters the
// same definitions through de_may_use_action (action_definitions.requires_role),
// so a verb needing 'workforce_assistant' or 'finance' never reaches the offer
// list of an onboarding employee without that role — and the item could never
// run. That check needs to know which employee the workspace routes onboarding
// to, which is server-side state (work_watchers / de_objectives), and it lives
// in public.onboarding_verb_verdict, which is deliberately NOT granted to
// `authenticated` (it takes a tenant id as a parameter, and a tenant id as a
// parameter IS the authorisation). So this picker can still offer a verb that
// publish will refuse; the refusal names the item, the verb, the role and the
// employee. Do not "fix" that by widening the function's grant.
//
// What this list DOES enforce, and still must, is CONNECTOR reachability —
// the exact predicate
// get_agentic_tools_for_de already uses to decide what a DE may run: a
// CONNECTED connector whose category matches the action's, and whose
// provider matches too (category alone once offered an ERPNext-connected
// workspace the Stripe/QuickBooks/Xero tools in the same erp_financials
// category — those could only ever fail, there being no such connector to
// run them against). provider='internal' actions (generate_invoice,
// start_onboarding) are engine primitives with their own step types, never
// reachable through a connector — get_agentic_tools_for_de excludes them
// outright and this does too.
// ============================================================

const ACCOUNT = '@account';
const ASK = '@ask';
const LITERAL = '__literal__';
const UNSET = '';

export default function VerbBinding({ item, onChange }: {
  item: TemplateItem;
  onChange: (next: TemplateItem) => void;
}) {
  const [rawActions, setRawActions] = useState<ActionDefinition[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (item.owner_type !== 'de') { setLoading(false); return; }
    let cancelled = false;
    Promise.all([listActionDefinitions(), listConnectors()])
      .then(([actionRows, connectorRows]) => {
        if (cancelled) return;
        setRawActions(actionRows);
        setConnectors(connectorRows);
      })
      .catch(() => { if (!cancelled) { setRawActions([]); setConnectors([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.owner_type]);

  // Same predicate get_agentic_tools_for_de applies server-side: a CONNECTED
  // connector whose category matches, and whose provider matches (or the
  // action names no specific provider, or is the generic 'template' demo
  // provider) — not category alone.
  const connected = useMemo(() => connectors.filter(c => c.status === 'connected'), [connectors]);
  const actions = useMemo(() => rawActions.filter(a =>
    a.provider !== 'internal' &&
    connected.some(c => c.category === a.category && (!a.provider || a.provider === c.provider || a.provider === 'template')),
  ), [rawActions, connected]);

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
