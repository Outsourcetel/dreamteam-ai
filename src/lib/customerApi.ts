// ============================================================
// Customer entity — LIVE data layer (production track P1).
// Typed CRUD over the tables in supabase/migrations/011_customer_entity.sql.
// All functions derive tenant_id from the session profile (cached).
// Money is stored in cents.
// ============================================================
import { supabase } from '../supabase';

// ── Types ─────────────────────────────────────────────────────────

export type AccountStatus = 'active' | 'at_risk' | 'churned';
export interface CustomerAccount {
  id: string;
  tenant_id: string;
  name: string;
  arr_cents: number;
  health_score: number;
  csm: string;
  status: AccountStatus;
  renewal_date: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'escalated';
export type TicketPriority = 'p1' | 'p2' | 'p3' | 'p4';
export interface SupportTicket {
  id: string;
  tenant_id: string;
  account_id: string | null;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: 'de' | 'human';
  de_confidence: number | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type InvoiceStatus = 'pending_generation' | 'awaiting_approval' | 'sent' | 'paid' | 'overdue';
export interface RenewalInvoice {
  id: string;
  tenant_id: string;
  account_id: string;
  amount_cents: number;
  status: InvoiceStatus;
  due_date: string | null;
  cadence_stage: number;
  created_at: string;
  updated_at: string;
  /** joined account (select alias) */
  customer_accounts?: { name: string; health_score: number } | null;
}

export type HumanTaskType = 'approval_gate' | 'review_gate' | 'escalation' | 'override' | 'training_feedback';
export interface DBHumanTask {
  id: string;
  tenant_id: string;
  type: HumanTaskType;
  title: string;
  detail: string;
  source: 'de' | 'chat' | 'system';
  related_table: string | null;
  related_id: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ActivityEventType = 'resolved' | 'escalated' | 'kb_gap' | 'error' | 'config_change' | 'approval';
export interface ActivityEvent {
  id: string;
  tenant_id: string;
  actor: string;
  actor_type: 'de' | 'human' | 'system';
  event_type: ActivityEventType;
  text: string;
  confidence: number | null;
  created_at: string;
}

// ── Errors ────────────────────────────────────────────────────────

/** True when the error means the migration hasn't been applied yet
 *  (missing table / not in PostgREST schema cache). */
export function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST204') return true;
  const msg = (e.message || String(err)).toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache')
  );
}

export class CustomerApiError extends Error {
  missingTables: boolean;
  constructor(message: string, missingTables: boolean) {
    super(message);
    this.name = 'CustomerApiError';
    this.missingTables = missingTables;
  }
}

function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

// ── Tenant resolution (cached per module) ─────────────────────────

let cachedTenantId: string | null = null;
let tenantPromise: Promise<string | null> | null = null;

export async function getSessionTenantId(): Promise<string | null> {
  if (cachedTenantId) return cachedTenantId;
  if (!tenantPromise) {
    tenantPromise = (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('tenant_id')
        .eq('user_id', user.id)
        .single();
      if (error || !data?.tenant_id) return null;
      cachedTenantId = data.tenant_id as string;
      return cachedTenantId;
    })();
  }
  const tid = await tenantPromise;
  if (!tid) tenantPromise = null; // allow retry after login
  return tid;
}

export function clearTenantCache() {
  cachedTenantId = null;
  tenantPromise = null;
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}

// ── Accounts ──────────────────────────────────────────────────────

export async function listAccounts(): Promise<CustomerAccount[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('customer_accounts')
    .select('*')
    .eq('tenant_id', tid)
    .order('arr_cents', { ascending: false });
  if (error) raise('listAccounts', error);
  return data ?? [];
}

export async function createAccount(
  a: Partial<CustomerAccount> & { name: string }
): Promise<CustomerAccount> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('customer_accounts')
    .insert({ ...a, tenant_id: tid })
    .select()
    .single();
  if (error) raise('createAccount', error);
  return data as CustomerAccount;
}

export async function updateAccount(
  id: string,
  updates: Partial<CustomerAccount>
): Promise<CustomerAccount> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('customer_accounts')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tid)
    .select()
    .single();
  if (error) raise('updateAccount', error);
  return data as CustomerAccount;
}

// ── Tickets ───────────────────────────────────────────────────────

export async function listTickets(): Promise<SupportTicket[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listTickets', error);
  return data ?? [];
}

export async function createTicket(
  t: Partial<SupportTicket> & { subject: string }
): Promise<SupportTicket> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('support_tickets')
    .insert({ ...t, tenant_id: tid })
    .select()
    .single();
  if (error) raise('createTicket', error);
  return data as SupportTicket;
}

export async function updateTicket(
  id: string,
  updates: Partial<SupportTicket>
): Promise<SupportTicket> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('support_tickets')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tid)
    .select()
    .single();
  if (error) raise('updateTicket', error);
  return data as SupportTicket;
}

// ── Renewal invoices ──────────────────────────────────────────────

/** Invoices above this amount route through a human approval gate. */
export const INVOICE_APPROVAL_THRESHOLD_CENTS = 10_000 * 100; // $10K

export async function listInvoices(): Promise<RenewalInvoice[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('renewal_invoices')
    .select('*, customer_accounts(name, health_score)')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listInvoices', error);
  return (data ?? []) as RenewalInvoice[];
}

export async function updateInvoice(
  id: string,
  updates: Partial<RenewalInvoice>
): Promise<void> {
  const tid = await requireTenantId();
  const { error } = await supabase
    .from('renewal_invoices')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tid);
  if (error) raise('updateInvoice', error);
}

/**
 * Generate a renewal invoice for an account. Amounts above the $10K
 * threshold are gated: status 'awaiting_approval' + a human_task; below
 * threshold they go straight to 'sent'. An activity event is always logged.
 */
export async function generateInvoice(
  account: Pick<CustomerAccount, 'id' | 'name' | 'arr_cents' | 'renewal_date'>
): Promise<{ invoice: RenewalInvoice; gated: boolean }> {
  const tid = await requireTenantId();
  const gated = account.arr_cents > INVOICE_APPROVAL_THRESHOLD_CENTS;
  const { data, error } = await supabase
    .from('renewal_invoices')
    .insert({
      tenant_id: tid,
      account_id: account.id,
      amount_cents: account.arr_cents,
      status: gated ? 'awaiting_approval' : 'sent',
      due_date: account.renewal_date,
    })
    .select()
    .single();
  if (error) raise('generateInvoice', error);
  const invoice = data as RenewalInvoice;

  if (gated) {
    await createHumanTask({
      type: 'approval_gate',
      title: `Invoice approval — ${account.name}`,
      detail: fmtMoney(account.arr_cents),
      source: 'system',
      related_table: 'renewal_invoices',
      related_id: invoice.id,
    });
  }
  await logActivity({
    actor: 'Renewal DE',
    actor_type: 'de',
    event_type: gated ? 'escalated' : 'resolved',
    text: gated
      ? `Renewal invoice for ${account.name} (${fmtMoney(account.arr_cents)}) exceeds the $10K threshold — routed to human approval`
      : `Renewal invoice sent — ${account.name} (${fmtMoney(account.arr_cents)})`,
  });
  return { invoice, gated };
}

// ── Human tasks ───────────────────────────────────────────────────

export async function listHumanTasks(): Promise<DBHumanTask[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('human_tasks')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false });
  if (error) raise('listHumanTasks', error);
  return data ?? [];
}

export async function createHumanTask(
  t: Partial<DBHumanTask> & { title: string; type: HumanTaskType }
): Promise<DBHumanTask> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('human_tasks')
    .insert({ ...t, tenant_id: tid })
    .select()
    .single();
  if (error) raise('createHumanTask', error);
  return data as DBHumanTask;
}

/**
 * Decide a human task: persists the decision (decided_by = auth user),
 * appends an activity event, and — if the task gates an invoice approval —
 * flips the invoice to 'sent' on approve.
 */
export async function decideHumanTask(
  task: DBHumanTask,
  decision: 'approved' | 'rejected'
): Promise<DBHumanTask> {
  const tid = await requireTenantId();
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('human_tasks')
    .update({
      status: decision,
      decided_by: user?.id ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq('id', task.id)
    .eq('tenant_id', tid)
    .select()
    .single();
  if (error) raise('decideHumanTask', error);

  if (
    decision === 'approved' &&
    task.related_table === 'renewal_invoices' &&
    task.related_id
  ) {
    await updateInvoice(task.related_id, { status: 'sent' });
  }
  await logActivity({
    actor: 'You',
    actor_type: 'human',
    event_type: 'approval',
    text: `${decision === 'approved' ? 'Approved' : 'Rejected'} — ${task.title}`,
  });
  return data as DBHumanTask;
}

// ── Activity ──────────────────────────────────────────────────────

export async function listActivity(limit = 20): Promise<ActivityEvent[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from('activity_events')
    .select('*')
    .eq('tenant_id', tid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) raise('listActivity', error);
  return data ?? [];
}

export async function logActivity(
  e: Partial<ActivityEvent> & { text: string }
): Promise<void> {
  try {
    const tid = await requireTenantId();
    const { error } = await supabase
      .from('activity_events')
      .insert({ actor: 'system', actor_type: 'system', event_type: 'config_change', ...e, tenant_id: tid });
    if (error) console.error('logActivity:', error.message);
  } catch (err) {
    console.error('logActivity:', err);
  }
}

// ── Money formatting ──────────────────────────────────────────────

export function fmtMoney(cents: number): string {
  return '$' + Math.round(cents / 100).toLocaleString();
}

/** $84K style rendering used across the Customer pages. */
export function fmtMoneyK(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return '$' + (dollars / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (dollars >= 1_000) return '$' + Math.round(dollars / 1_000) + 'K';
  return '$' + Math.round(dollars).toLocaleString();
}

// ── CSV parsing + import ──────────────────────────────────────────

/**
 * Small, robust CSV parser: handles quoted fields, embedded commas,
 * escaped quotes ("") and CRLF/LF line endings. Returns rows of cells.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0].trim() !== '') rows.push(row);
  return rows;
}

/** Parse a money string like "$210K", "210,000", "84000.50" into cents. */
export function parseMoneyToCents(raw: string): number {
  const s = (raw || '').trim().replace(/[$,\s]/g, '').toLowerCase();
  if (!s) return 0;
  let mult = 100;
  let num = s;
  if (s.endsWith('k')) { mult = 100 * 1_000; num = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 100 * 1_000_000; num = s.slice(0, -1); }
  const n = parseFloat(num);
  return Number.isFinite(n) ? Math.round(n * mult) : 0;
}

export interface ImportRowError { row: number; message: string }
export interface ImportResult { imported: number; errors: ImportRowError[] }

export interface AccountImportRow {
  name?: string;
  arr?: string;
  health_score?: string;
  csm?: string;
  status?: string;
  renewal_date?: string;
  notes?: string;
}

export async function importAccountsCsv(rows: AccountImportRow[]): Promise<ImportResult> {
  const tid = await requireTenantId();
  const errors: ImportRowError[] = [];
  const inserts: Record<string, unknown>[] = [];
  rows.forEach((r, i) => {
    const name = (r.name || '').trim();
    if (!name) { errors.push({ row: i + 1, message: 'Missing account name' }); return; }
    const health = r.health_score !== undefined && r.health_score !== ''
      ? Math.max(0, Math.min(100, Math.round(Number(r.health_score)) || 0))
      : 70;
    const status = ['active', 'at_risk', 'churned'].includes((r.status || '').trim().toLowerCase())
      ? (r.status || '').trim().toLowerCase()
      : 'active';
    const renewal = (r.renewal_date || '').trim();
    inserts.push({
      tenant_id: tid,
      name,
      arr_cents: parseMoneyToCents(r.arr || '0'),
      health_score: health,
      csm: (r.csm || '').trim(),
      status,
      renewal_date: /^\d{4}-\d{2}-\d{2}$/.test(renewal) ? renewal : null,
      notes: (r.notes || '').trim(),
    });
  });
  let imported = 0;
  if (inserts.length > 0) {
    const { error, data } = await supabase.from('customer_accounts').insert(inserts).select('id');
    if (error) raise('importAccountsCsv', error);
    imported = data?.length ?? inserts.length;
  }
  return { imported, errors };
}

export interface TicketImportRow {
  subject?: string;
  body?: string;
  status?: string;
  priority?: string;
  assignee?: string;
}

export async function importTicketsCsv(rows: TicketImportRow[]): Promise<ImportResult> {
  const tid = await requireTenantId();
  const errors: ImportRowError[] = [];
  const inserts: Record<string, unknown>[] = [];
  rows.forEach((r, i) => {
    const subject = (r.subject || '').trim();
    if (!subject) { errors.push({ row: i + 1, message: 'Missing subject' }); return; }
    const status = ['open', 'pending', 'resolved', 'escalated'].includes((r.status || '').trim().toLowerCase())
      ? (r.status || '').trim().toLowerCase() : 'open';
    const priority = ['p1', 'p2', 'p3', 'p4'].includes((r.priority || '').trim().toLowerCase())
      ? (r.priority || '').trim().toLowerCase() : 'p3';
    const assignee = (r.assignee || '').trim().toLowerCase() === 'human' ? 'human' : 'de';
    inserts.push({
      tenant_id: tid,
      subject,
      body: (r.body || '').trim(),
      status,
      priority,
      assignee,
    });
  });
  let imported = 0;
  if (inserts.length > 0) {
    const { error, data } = await supabase.from('support_tickets').insert(inserts).select('id');
    if (error) raise('importTicketsCsv', error);
    imported = data?.length ?? inserts.length;
  }
  return { imported, errors };
}
