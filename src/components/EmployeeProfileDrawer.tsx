import React, { useState, useEffect, useCallback } from 'react';
import {
  getEmployeeRecord, updateEmployeeProfile, updateEmployeePrivate, setEmployeeCompensation,
  EMPLOYMENT_TYPES, EMPLOYMENT_STATUSES, PAY_FREQUENCIES,
} from '../lib/employeeApi';
import type { EmployeeRecord, EmployeeProfile, EmployeePrivate } from '../lib/employeeApi';
import { loadOrgTree, listAssignablePeople } from '../lib/orgApi';
import type { OrgUnit, AssignablePerson } from '../lib/orgApi';
import { Drawer, Button, Chip, Field, INPUT_CLS, Banner, TabBar, TableScroll, TH, TD } from '../design/primitives';

// ============================================================
// The employee record — what ADP and Salesforce would call a person.
//
// Three sections, and the split is not cosmetic: it is who may see what.
// Directory facts are workspace-visible. Personal details (address, date of
// birth, emergency contact) belong to the person and to owners/admins — a
// manager approving someone's work is not a reason to hold their home address.
// Pay is readable by the person and owners/admins and writable by owners and
// admins alone, because being able to read your own salary is reasonable and
// being able to set it is not.
//
// When a section is withheld the drawer SAYS SO rather than rendering empty.
// A blank panel that might mean "nothing recorded" and might mean "not for you"
// is worse than either answer.
// ============================================================

const TABS = [
  { key: 'job' as const, label: 'Job' },
  { key: 'personal' as const, label: 'Personal' },
  { key: 'pay' as const, label: 'Pay' },
];
type TabId = typeof TABS[number]['key'];

const money = (cents: number) => (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });

export function EmployeeProfileDrawer({ userId, onClose, inline }: {
  userId: string;
  onClose?: () => void;
  /** Render without the drawer chrome, so the same record can BE a page.
   *  "My profile" needs to be somewhere a person can reach without first
   *  finding the admin screen for managing everyone else. */
  inline?: boolean;
}) {
  const [tab, setTab] = useState<TabId>('job');
  const [rec, setRec] = useState<EmployeeRecord | null>(null);
  const [tree, setTree] = useState<OrgUnit[]>([]);
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [job, setJob] = useState<Partial<EmployeeProfile>>({});
  const [priv, setPriv] = useState<Partial<EmployeePrivate>>({});
  const [pay, setPay] = useState({ amount: '', currency: 'USD', frequency: 'annual', from: '', note: '' });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [r, t, p] = await Promise.all([getEmployeeRecord(userId), loadOrgTree(), listAssignablePeople()]);
      setRec(r); setTree(t); setPeople(p);
      setJob({ ...r.profile });
      setPriv({ ...(r.private ?? {}) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  const flash = (m: string) => { setSaved(m); window.setTimeout(() => setSaved(null), 2500); };

  const saveJob = async () => {
    if (!rec) return;
    setErr(null);
    // Send only what changed. The server refuses a field this caller may not
    // edit BY NAME, so sending the whole record would turn an ordinary save
    // into a refusal for anyone but an admin.
    const patch: Record<string, unknown> = {};
    const original = rec.profile as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(job)) {
      if (original[k] !== v) patch[k] = v ?? null;
    }
    if (Object.keys(patch).length === 0) { flash('Nothing to save'); return; }
    try { await updateEmployeeProfile(userId, patch); await load(); flash('Saved'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const savePrivate = async () => {
    setErr(null);
    try { await updateEmployeePrivate(userId, priv); await load(); flash('Saved'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const savePay = async () => {
    setErr(null);
    const cents = Math.round(Number(pay.amount.replace(/[^0-9.]/g, '')) * 100);
    if (!Number.isFinite(cents) || !pay.from) { setErr('An amount and a start date are needed.'); return; }
    try {
      await setEmployeeCompensation({
        userId, amountCents: cents, currency: pay.currency,
        payFrequency: pay.frequency, effectiveFrom: pay.from, note: pay.note || undefined,
      });
      setPay({ amount: '', currency: pay.currency, frequency: pay.frequency, from: '', note: '' });
      await load(); flash('Pay recorded');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const title = rec
    ? (rec.profile.preferred_name || rec.profile.full_name || 'Employee')
    : 'Employee';

  const body = (
    <>
      {!rec ? (
        <div className="text-sm text-dt-muted">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            {rec.profile.job_title && <Chip tone="accent">{rec.profile.job_title}</Chip>}
            {rec.profile.employment_status && (
              <Chip tone={rec.profile.employment_status === 'active' ? 'ok' : 'warn'}>
                {EMPLOYMENT_STATUSES.find((s) => s.value === rec.profile.employment_status)?.label
                  ?? rec.profile.employment_status}
              </Chip>
            )}
            {rec.profile.employee_number && <Chip tone="neutral">#{rec.profile.employee_number}</Chip>}
          </div>

          {err && <Banner tone="danger">{err}</Banner>}
          {saved && <Banner tone="info">{saved}</Banner>}

          <TabBar<TabId> tabs={TABS} active={tab} onSelect={setTab} />

          {tab === 'job' && (
            <div className="space-y-3">
              {!rec.can_edit_job && (
                <Banner tone="info">You can view this but not change it. Job details are edited by an owner, admin or manager.</Banner>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name">
                  <input className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.first_name ?? ''}
                    onChange={(e) => setJob({ ...job, first_name: e.target.value })} />
                </Field>
                <Field label="Last name">
                  <input className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.last_name ?? ''}
                    onChange={(e) => setJob({ ...job, last_name: e.target.value })} />
                </Field>
                <Field label="Preferred name">
                  <input className={INPUT_CLS} value={job.preferred_name ?? ''}
                    onChange={(e) => setJob({ ...job, preferred_name: e.target.value })} />
                </Field>
                <Field label="Pronouns">
                  <input className={INPUT_CLS} placeholder="e.g. they/them" value={job.pronouns ?? ''}
                    onChange={(e) => setJob({ ...job, pronouns: e.target.value })} />
                </Field>
                <Field label="Employee number">
                  <input className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.employee_number ?? ''}
                    onChange={(e) => setJob({ ...job, employee_number: e.target.value })} />
                </Field>
                <Field label="Job title">
                  <input className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.job_title ?? ''}
                    onChange={(e) => setJob({ ...job, job_title: e.target.value })} />
                </Field>
                <Field label="Department or team">
                  <select className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.org_unit_id ?? ''}
                    onChange={(e) => setJob({ ...job, org_unit_id: e.target.value || null })}>
                    <option value="">Not set</option>
                    {tree.filter((u) => u.is_active).map((u) => (
                      <option key={u.id} value={u.id}>{u.path}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Reports to">
                  <select className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.reports_to_user_id ?? ''}
                    onChange={(e) => setJob({ ...job, reports_to_user_id: e.target.value || null })}>
                    <option value="">Not set</option>
                    {people.filter((p) => p.user_id !== userId).map((p) => (
                      <option key={p.user_id} value={p.user_id}>{p.full_name || 'Unnamed user'}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Employment type">
                  <select className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.employment_type ?? ''}
                    onChange={(e) => setJob({ ...job, employment_type: e.target.value || null })}>
                    <option value="">Not set</option>
                    {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Status">
                  <select className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.employment_status ?? ''}
                    onChange={(e) => setJob({ ...job, employment_status: e.target.value || null })}>
                    <option value="">Not set</option>
                    {EMPLOYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </Field>
                <Field label="Started">
                  <input type="date" className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.hire_date ?? ''}
                    onChange={(e) => setJob({ ...job, hire_date: e.target.value || null })} />
                </Field>
                <Field label="Left">
                  <input type="date" className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.end_date ?? ''}
                    onChange={(e) => setJob({ ...job, end_date: e.target.value || null })} />
                </Field>
                <Field label="Work email">
                  <input className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.work_email ?? ''}
                    onChange={(e) => setJob({ ...job, work_email: e.target.value })} />
                </Field>
                <Field label="Work phone">
                  <input className={INPUT_CLS} value={job.work_phone ?? ''}
                    onChange={(e) => setJob({ ...job, work_phone: e.target.value })} />
                </Field>
                <Field label="Mobile">
                  <input className={INPUT_CLS} value={job.mobile_phone ?? ''}
                    onChange={(e) => setJob({ ...job, mobile_phone: e.target.value })} />
                </Field>
                <Field label="Work location">
                  <input className={INPUT_CLS} disabled={!rec.can_edit_job} value={job.work_location ?? ''}
                    onChange={(e) => setJob({ ...job, work_location: e.target.value })} />
                </Field>
                <Field label="Time zone">
                  <input className={INPUT_CLS} placeholder="e.g. Europe/London" value={job.time_zone ?? ''}
                    onChange={(e) => setJob({ ...job, time_zone: e.target.value })} />
                </Field>
                <Field label="Language">
                  <input className={INPUT_CLS} placeholder="e.g. en-GB" value={job.locale ?? ''}
                    onChange={(e) => setJob({ ...job, locale: e.target.value })} />
                </Field>
              </div>
              <div className="flex justify-end"><Button onClick={saveJob}>Save</Button></div>
            </div>
          )}

          {tab === 'personal' && (
            !rec.can_edit_private ? (
              <Banner tone="warn">
                Personal details are visible to this person and to owners and admins only.
                Approving someone's work is not a reason to hold their home address.
              </Banner>
            ) : (
              <div className="space-y-3">
                <Banner tone="info">Visible to {rec.profile.preferred_name || rec.profile.full_name} and to owners and admins. Not to managers.</Banner>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date of birth">
                    <input type="date" className={INPUT_CLS} value={priv.date_of_birth ?? ''}
                      onChange={(e) => setPriv({ ...priv, date_of_birth: e.target.value || null })} />
                  </Field>
                  <Field label="Personal email">
                    <input className={INPUT_CLS} value={priv.personal_email ?? ''}
                      onChange={(e) => setPriv({ ...priv, personal_email: e.target.value })} />
                  </Field>
                  <Field label="Personal phone">
                    <input className={INPUT_CLS} value={priv.personal_phone ?? ''}
                      onChange={(e) => setPriv({ ...priv, personal_phone: e.target.value })} />
                  </Field>
                  <Field label="Country">
                    <input className={INPUT_CLS} value={priv.country ?? ''}
                      onChange={(e) => setPriv({ ...priv, country: e.target.value })} />
                  </Field>
                  <Field label="Address">
                    <input className={INPUT_CLS} value={priv.address_line1 ?? ''}
                      onChange={(e) => setPriv({ ...priv, address_line1: e.target.value })} />
                  </Field>
                  <Field label="Address line 2">
                    <input className={INPUT_CLS} value={priv.address_line2 ?? ''}
                      onChange={(e) => setPriv({ ...priv, address_line2: e.target.value })} />
                  </Field>
                  <Field label="City">
                    <input className={INPUT_CLS} value={priv.city ?? ''}
                      onChange={(e) => setPriv({ ...priv, city: e.target.value })} />
                  </Field>
                  <Field label="Region or state">
                    <input className={INPUT_CLS} value={priv.state_region ?? ''}
                      onChange={(e) => setPriv({ ...priv, state_region: e.target.value })} />
                  </Field>
                  <Field label="Postcode">
                    <input className={INPUT_CLS} value={priv.postal_code ?? ''}
                      onChange={(e) => setPriv({ ...priv, postal_code: e.target.value })} />
                  </Field>
                </div>
                <div className="text-[11px] uppercase tracking-wide text-dt-muted pt-2">In an emergency</div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Name">
                    <input className={INPUT_CLS} value={priv.emergency_contact_name ?? ''}
                      onChange={(e) => setPriv({ ...priv, emergency_contact_name: e.target.value })} />
                  </Field>
                  <Field label="Relationship">
                    <input className={INPUT_CLS} value={priv.emergency_contact_relationship ?? ''}
                      onChange={(e) => setPriv({ ...priv, emergency_contact_relationship: e.target.value })} />
                  </Field>
                  <Field label="Phone">
                    <input className={INPUT_CLS} value={priv.emergency_contact_phone ?? ''}
                      onChange={(e) => setPriv({ ...priv, emergency_contact_phone: e.target.value })} />
                  </Field>
                </div>
                <div className="flex justify-end"><Button onClick={savePrivate}>Save</Button></div>
              </div>
            )
          )}

          {tab === 'pay' && (
            rec.compensation === null ? (
              <Banner tone="warn">
                Pay is visible to this person and to owners and admins only.
              </Banner>
            ) : (
              <div className="space-y-3">
                {rec.compensation.length === 0 ? (
                  <Banner tone="info">No pay has been recorded for this person.</Banner>
                ) : (
                  <TableScroll>
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className={TH}>Amount</th>
                          <th className={TH}>From</th>
                          <th className={TH}>Until</th>
                          <th className={TH}>Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rec.compensation.map((c) => (
                          <tr key={c.id} className="border-t border-dt-border">
                            <td className={TD}>
                              {c.currency} {money(c.amount_cents)}
                              <span className="text-dt-muted text-xs">
                                {' '}{PAY_FREQUENCIES.find((f) => f.value === c.pay_frequency)?.label ?? c.pay_frequency}
                              </span>
                            </td>
                            <td className={TD}>{c.effective_from}</td>
                            <td className={TD}>
                              {c.effective_to ?? <Chip tone="ok">CURRENT</Chip>}
                            </td>
                            <td className={`${TD} text-dt-support`}>{c.note ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}

                {rec.can_edit_pay && (
                  <div className="border-t border-dt-border pt-3 space-y-3">
                    <div className="text-[11px] uppercase tracking-wide text-dt-muted">
                      Record a change — the current record is closed the day before, never overwritten
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Amount">
                        <input className={INPUT_CLS} inputMode="decimal" placeholder="e.g. 55000"
                          value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                      </Field>
                      <Field label="Currency">
                        <input className={INPUT_CLS} value={pay.currency}
                          onChange={(e) => setPay({ ...pay, currency: e.target.value.toUpperCase() })} />
                      </Field>
                      <Field label="Frequency">
                        <select className={INPUT_CLS} value={pay.frequency}
                          onChange={(e) => setPay({ ...pay, frequency: e.target.value })}>
                          {PAY_FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Effective from">
                        <input type="date" className={INPUT_CLS} value={pay.from}
                          onChange={(e) => setPay({ ...pay, from: e.target.value })} />
                      </Field>
                    </div>
                    <Field label="Note" hint="Why it changed — promotion, review, correction.">
                      <input className={INPUT_CLS} value={pay.note}
                        onChange={(e) => setPay({ ...pay, note: e.target.value })} />
                    </Field>
                    <div className="flex justify-end"><Button onClick={savePay}>Record</Button></div>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </>
  );

  if (inline) return <div className="max-w-4xl">{body}</div>;
  return <Drawer title={title} onClose={onClose ?? (() => {})}>{body}</Drawer>;
}

export default EmployeeProfileDrawer;
