import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { PageHeader, th, td } from '../../../components/ui';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { useDataMode } from '../../../lib/dataMode';
import LiveConnectorsPage from './LiveConnectorsPage';

// ── Types ─────────────────────────────────────────────────────────

type ConnStatus = 'connected' | 'error' | 'disconnected';

interface BoundDE {
  name: string;
  accessLevel: 'read' | 'read_write' | 'admin';
}

interface ConnectorAction {
  id: string;
  label: string;
  description: string;
  requiresApproval: boolean;
  params: string[];
}

interface ConnectorWebhook {
  event: string;
  description: string;
}

interface Connector {
  id: string;
  name: string;
  type: string;
  category: string;
  status: ConnStatus;
  boundDEs: BoundDE[];
  lastSync: string;
  actions: ConnectorAction[];
  webhooks: ConnectorWebhook[];
  dataScope: string[];
  note?: string;
}

// ── Actions & webhooks (harvested from legacy DataConnectorsPage) ─

const ZUORA_ACTIONS: ConnectorAction[] = [
  { id: 'create_invoice', label: 'Generate Invoice', description: 'Create a new invoice for a subscription', requiresApproval: true, params: ['subscription_id', 'amount', 'due_date'] },
  { id: 'mark_paid', label: 'Mark Invoice Paid', description: 'Record payment received and update invoice status', requiresApproval: false, params: ['invoice_id', 'payment_amount', 'payment_date'] },
  { id: 'send_payment_reminder', label: 'Send Payment Reminder', description: 'Trigger a payment reminder email via Zuora', requiresApproval: false, params: ['invoice_id', 'contact_email'] },
  { id: 'cancel_subscription', label: 'Cancel Subscription', description: 'Cancel a subscription at period end', requiresApproval: true, params: ['subscription_id', 'reason'] },
];

const GAINSIGHT_ACTIONS: ConnectorAction[] = [
  { id: 'update_renewal_status', label: 'Update Renewal Status', description: 'Set the renewal stage in Gainsight (Renewed/Churned/At Risk)', requiresApproval: false, params: ['company_id', 'status', 'notes'] },
  { id: 'create_ctd', label: 'Create Call to Action', description: 'Create a CTA for the CSM to follow up', requiresApproval: false, params: ['company_id', 'type', 'due_date', 'priority'] },
  { id: 'log_timeline', label: 'Log Timeline Activity', description: 'Log an interaction or event to Gainsight timeline', requiresApproval: false, params: ['company_id', 'type', 'notes'] },
];

const ZUORA_WEBHOOKS: ConnectorWebhook[] = [
  { event: 'payment.received', description: 'Fires when a payment is successfully processed' },
  { event: 'invoice.created', description: 'Fires when a new invoice is generated' },
  { event: 'subscription.renewal_upcoming', description: 'Fires 30/15/7 days before renewal' },
];

const GAINSIGHT_WEBHOOKS: ConnectorWebhook[] = [
  { event: 'health_score.changed', description: 'Fires when a company health score changes significantly' },
  { event: 'renewal.approaching', description: 'Fires when renewal is within configured days' },
];

// ── Seed connectors (bound DEs match WorkforceDEsPage systems) ────

const TCP_CONNECTORS: Connector[] = [
  {
    id: 'zendesk', name: 'Zendesk', type: 'zendesk', category: 'Support', status: 'connected',
    boundDEs: [{ name: 'Alex', accessLevel: 'read_write' }], lastSync: '2 min ago',
    actions: [
      { id: 'create_ticket', label: 'Create Ticket', description: 'Open a new support ticket on behalf of a customer', requiresApproval: false, params: ['requester_email', 'subject', 'priority'] },
      { id: 'update_ticket', label: 'Update Ticket', description: 'Change status, priority, or add internal notes', requiresApproval: false, params: ['ticket_id', 'status', 'comment'] },
      { id: 'merge_tickets', label: 'Merge Tickets', description: 'Merge duplicate tickets into a primary thread', requiresApproval: true, params: ['primary_id', 'duplicate_ids'] },
    ],
    webhooks: [
      { event: 'ticket.created', description: 'Fires when a new ticket is opened' },
      { event: 'ticket.escalated', description: 'Fires when a ticket is escalated to L2' },
    ],
    dataScope: ['Tickets', 'Customers', 'Satisfaction ratings'],
  },
  {
    id: 'confluence', name: 'Confluence', type: 'confluence', category: 'Knowledge', status: 'connected',
    boundDEs: [{ name: 'Alex', accessLevel: 'read' }], lastSync: '15 min ago',
    actions: [
      { id: 'search_pages', label: 'Search Pages', description: 'Full-text search across knowledge spaces', requiresApproval: false, params: ['query', 'space_key'] },
      { id: 'draft_page', label: 'Draft KB Article', description: 'Create a draft page for human review', requiresApproval: true, params: ['space_key', 'title', 'body'] },
    ],
    webhooks: [{ event: 'page.updated', description: 'Fires when a watched page changes' }],
    dataScope: ['Product Docs space', 'Support KB space'],
  },
  {
    id: 'jira', name: 'Jira', type: 'jira', category: 'Project', status: 'connected',
    boundDEs: [{ name: 'Alex', accessLevel: 'read' }], lastSync: '5 min ago',
    actions: [
      { id: 'search_issues', label: 'Search Issues', description: 'Query issues by JQL for known-bug lookups', requiresApproval: false, params: ['jql'] },
      { id: 'link_ticket', label: 'Link Support Ticket', description: 'Attach a Zendesk ticket reference to an engineering issue', requiresApproval: false, params: ['issue_key', 'ticket_id'] },
    ],
    webhooks: [{ event: 'issue.resolved', description: 'Fires when a linked engineering issue is resolved' }],
    dataScope: ['ENG project (read)', 'Bug tracker'],
  },
  {
    id: 'salesforce', name: 'Salesforce', type: 'salesforce', category: 'CRM', status: 'connected',
    boundDEs: [{ name: 'Alex', accessLevel: 'read' }, { name: 'Casey', accessLevel: 'read_write' }], lastSync: '30 min ago',
    actions: [
      { id: 'lookup_account', label: 'Lookup Account', description: 'Fetch account, contract, and contact records', requiresApproval: false, params: ['account_id'] },
      { id: 'update_opportunity', label: 'Update Opportunity', description: 'Update renewal opportunity stage and amount', requiresApproval: true, params: ['opportunity_id', 'stage', 'amount'] },
      { id: 'log_activity', label: 'Log Activity', description: 'Log a call, email, or task against a record', requiresApproval: false, params: ['record_id', 'type', 'notes'] },
    ],
    webhooks: [{ event: 'opportunity.stage_changed', description: 'Fires when a renewal opportunity moves stage' }],
    dataScope: ['Accounts', 'Opportunities', 'Contacts'],
  },
  {
    id: 'zuora', name: 'Zuora', type: 'zuora', category: 'Billing', status: 'connected',
    boundDEs: [{ name: 'Casey', accessLevel: 'read_write' }], lastSync: '5 min ago',
    actions: ZUORA_ACTIONS, webhooks: ZUORA_WEBHOOKS,
    dataScope: ['Subscriptions', 'Invoices', 'Payments'],
  },
  {
    id: 'gainsight', name: 'Gainsight', type: 'gainsight', category: 'CS Platform', status: 'connected',
    boundDEs: [{ name: 'Casey', accessLevel: 'read_write' }], lastSync: '10 min ago',
    actions: GAINSIGHT_ACTIONS, webhooks: GAINSIGHT_WEBHOOKS,
    dataScope: ['Health scores', 'Renewal timeline', 'CTAs'],
  },
  {
    id: 'workday', name: 'Workday', type: 'workday', category: 'HRIS', status: 'error',
    boundDEs: [{ name: 'Riley', accessLevel: 'read_write' }], lastSync: '2 hrs ago',
    actions: [
      { id: 'fetch_employee', label: 'Fetch Employee Record', description: 'Read employee profile, role, and leave balances', requiresApproval: false, params: ['employee_id'] },
      { id: 'submit_leave', label: 'Submit Leave Request', description: 'File a leave request on behalf of an employee', requiresApproval: true, params: ['employee_id', 'type', 'start_date', 'end_date'] },
    ],
    webhooks: [{ event: 'employee.hired', description: 'Fires when a new hire record is created' }],
    dataScope: ['Employee records', 'Leave balances', 'Org chart'],
    note: 'Connector timeout — last 3 sync attempts failed. Riley is retrying.',
  },
  {
    id: 'greenhouse', name: 'Greenhouse', type: 'greenhouse', category: 'ATS', status: 'connected',
    boundDEs: [{ name: 'Riley', accessLevel: 'read' }], lastSync: '1 hr ago',
    actions: [
      { id: 'fetch_candidates', label: 'Fetch Candidates', description: 'Read candidate pipeline for open roles', requiresApproval: false, params: ['job_id', 'stage'] },
    ],
    webhooks: [{ event: 'offer.accepted', description: 'Fires when a candidate accepts an offer' }],
    dataScope: ['Open roles', 'Candidate pipeline'],
  },
  {
    id: 'lattice', name: 'Lattice', type: 'lattice', category: 'Performance', status: 'connected',
    boundDEs: [{ name: 'Riley', accessLevel: 'read' }], lastSync: '45 min ago',
    actions: [
      { id: 'fetch_reviews', label: 'Fetch Review Cycles', description: 'Read performance review cycle status', requiresApproval: false, params: ['cycle_id'] },
    ],
    webhooks: [{ event: 'review.completed', description: 'Fires when a review cycle completes' }],
    dataScope: ['Review cycles', 'Goals'],
  },
];

const PWC_CONNECTORS: Connector[] = [
  {
    id: 'salesforce', name: 'Salesforce', type: 'salesforce', category: 'CRM', status: 'connected',
    boundDEs: [{ name: 'Morgan', accessLevel: 'read_write' }], lastSync: '10 min ago',
    actions: [
      { id: 'lookup_client', label: 'Lookup Client', description: 'Fetch client engagement and contact records', requiresApproval: false, params: ['account_id'] },
      { id: 'log_activity', label: 'Log Activity', description: 'Log client interactions against the engagement record', requiresApproval: false, params: ['record_id', 'type', 'notes'] },
    ],
    webhooks: [{ event: 'engagement.stage_changed', description: 'Fires when an engagement moves stage' }],
    dataScope: ['Clients', 'Engagements', 'Contacts'],
  },
  {
    id: 'sharepoint', name: 'SharePoint', type: 'sharepoint', category: 'Document Mgmt', status: 'connected',
    boundDEs: [{ name: 'Morgan', accessLevel: 'read_write' }, { name: 'Avery', accessLevel: 'read_write' }], lastSync: '20 min ago',
    actions: [
      { id: 'search_documents', label: 'Search Documents', description: 'Full-text search across engagement document libraries', requiresApproval: false, params: ['query', 'library'] },
      { id: 'file_document', label: 'File Document', description: 'Save a memo or workpaper to the engagement library', requiresApproval: true, params: ['library', 'filename', 'content'] },
    ],
    webhooks: [{ event: 'document.uploaded', description: 'Fires when a new document lands in a watched library' }],
    dataScope: ['Engagement libraries', 'Tax memos', 'Workpapers'],
  },
  {
    id: 'docusign', name: 'DocuSign', type: 'docusign', category: 'eSignature', status: 'connected',
    boundDEs: [{ name: 'Morgan', accessLevel: 'read_write' }], lastSync: '1 hr ago',
    actions: [
      { id: 'send_envelope', label: 'Send Envelope', description: 'Send an engagement letter for signature', requiresApproval: true, params: ['template_id', 'signer_email'] },
      { id: 'check_status', label: 'Check Envelope Status', description: 'Poll signature status on outstanding envelopes', requiresApproval: false, params: ['envelope_id'] },
    ],
    webhooks: [{ event: 'envelope.completed', description: 'Fires when all parties have signed' }],
    dataScope: ['Engagement letters', 'Signature status'],
  },
  {
    id: 'thomson', name: 'Thomson Reuters', type: 'thomson', category: 'Tax Research', status: 'connected',
    boundDEs: [{ name: 'Avery', accessLevel: 'read' }], lastSync: '1 hr ago',
    actions: [
      { id: 'search_checkpoint', label: 'Search Checkpoint', description: 'Query the Checkpoint tax research database', requiresApproval: false, params: ['query', 'jurisdiction'] },
    ],
    webhooks: [{ event: 'ruling.published', description: 'Fires when a new ruling matches a watched topic' }],
    dataScope: ['Tax code', 'Rulings', 'Commentary'],
  },
  {
    id: 'bloomberg', name: 'Bloomberg Tax', type: 'bloomberg', category: 'Tax Research', status: 'connected',
    boundDEs: [{ name: 'Avery', accessLevel: 'read' }], lastSync: '1 hr ago',
    actions: [
      { id: 'search_portfolios', label: 'Search Portfolios', description: 'Query Bloomberg Tax Management Portfolios', requiresApproval: false, params: ['query', 'portfolio'] },
    ],
    webhooks: [{ event: 'update.published', description: 'Fires on daily tax-law update digest' }],
    dataScope: ['Portfolios', 'Daily updates'],
  },
];

const CONNECTORS: Record<CompanyId, Connector[]> = { tcp: TCP_CONNECTORS, pwc: PWC_CONNECTORS };

// ── Add-connector catalog ─────────────────────────────────────────

const CATALOG: { name: string; category: string; description: string }[] = [
  { name: 'Slack', category: 'Communication', description: 'Channel notifications and DE chat surface' },
  { name: 'Microsoft Teams', category: 'Communication', description: 'Teams chat and channel integration' },
  { name: 'HubSpot', category: 'CRM', description: 'Marketing and CRM data sync' },
  { name: 'Stripe', category: 'Billing', description: 'Payments, subscriptions, and invoicing' },
  { name: 'NetSuite', category: 'ERP', description: 'Financials, AR/AP, and GL data' },
  { name: 'ServiceNow', category: 'ITSM', description: 'IT service tickets and change management' },
  { name: 'BambooHR', category: 'HRIS', description: 'Employee records and time-off tracking' },
  { name: 'Notion', category: 'Knowledge', description: 'Docs and wiki as a knowledge source' },
  { name: 'QuickBooks', category: 'Accounting', description: 'Invoices, expenses, and reports' },
];

// ── Helpers ───────────────────────────────────────────────────────

function statusDot(status: ConnStatus) {
  const color = status === 'connected' ? 'bg-emerald-400' : status === 'error' ? 'bg-red-400' : 'bg-slate-600';
  return <span className={`inline-block w-2 h-2 rounded-full ${color} flex-shrink-0`} />;
}

function statusLabel(status: ConnStatus) {
  const cls = status === 'connected' ? 'text-emerald-400' : status === 'error' ? 'text-red-400' : 'text-dt-muted';
  const label = status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : 'Disconnected';
  return <span className={`text-xs ${cls}`}>{label}</span>;
}

function accessBadge(level: BoundDE['accessLevel']) {
  const styles = { read: 'bg-blue-500/20 text-blue-400', read_write: 'bg-indigo-500/20 text-indigo-400', admin: 'bg-amber-500/20 text-amber-400' };
  const labels = { read: 'Read', read_write: 'Read/Write', admin: 'Admin' };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[level]}`}>{labels[level]}</span>;
}

function DEAvatar({ name }: { name: string }) {
  return (
    <span className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-[10px] font-semibold" title={name}>
      {name[0]}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function ConnectorsPage({ setPage }: { setPage: (p: Page) => void }) {
  const dataMode = useDataMode();
  const { activeCompanyId } = useAuth();
  return <LiveConnectorsPage />;
  const connectors = CONNECTORS[activeCompanyId];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);

  useEffect(() => { setSelectedId(null); setShowCatalog(false); }, [activeCompanyId]);

  const selected = connectors.find(c => c.id === selectedId) ?? null;
  const errorCount = connectors.filter(c => c.status === 'error').length;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <PageHeader
          title="Connectors"
          subtitle={`${connectors.length} system integrations · ${connectors.length - errorCount} healthy${errorCount ? ` · ${errorCount} in error` : ''} — every connector is bound to specific Digital Employees with scoped access`}
        />
        <button onClick={() => setShowCatalog(true)} className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded-lg transition-colors flex-shrink-0">
          + Add connector
        </button>
      </div>

      {/* Connector grid */}
      <div className="grid grid-cols-3 gap-4">
        {connectors.map(conn => (
          <button
            key={conn.id}
            onClick={() => setSelectedId(conn.id)}
            className={`text-left bg-dt-card border rounded-xl p-4 transition-all hover:border-dt-border-strong ${conn.status === 'error' ? 'border-red-500/40' : 'border-dt-border'}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {statusDot(conn.status)}
                <span className="text-sm font-semibold text-white">{conn.name}</span>
              </div>
              {statusLabel(conn.status)}
            </div>
            <div className="text-[10px] text-dt-muted mb-3">{conn.category}</div>

            <div className="flex items-center gap-2 mb-3">
              <div className="flex -space-x-1.5">
                {conn.boundDEs.map(de => <DEAvatar key={de.name} name={de.name} />)}
              </div>
              <span className="text-xs text-dt-support">{conn.boundDEs.map(d => d.name).join(', ')}</span>
            </div>

            <div className="flex items-center justify-between text-[10px] text-dt-muted border-t border-dt-border pt-2.5">
              <span>{conn.actions.length} actions · {conn.webhooks.length} webhooks</span>
              <span>Last sync {conn.lastSync}</span>
            </div>
            {conn.note && <p className="mt-2 text-[11px] text-red-300">{conn.note}</p>}
          </button>
        ))}
      </div>

      {/* Detail slide-over */}
      {selected && (
        <>
          <div className="fixed inset-0 z-40 bg-dt-inset" onClick={() => setSelectedId(null)} />
          <div className="fixed right-0 top-0 bottom-0 z-50 w-[480px] bg-dt-card border-l border-dt-border flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-dt-border">
              <div className="flex items-center gap-2">
                {statusDot(selected.status)}
                <h2 className="text-sm font-semibold text-white">{selected.name}</h2>
                <span className="text-xs text-dt-muted">{selected.category}</span>
              </div>
              <button onClick={() => setSelectedId(null)} className="w-7 h-7 rounded-lg bg-dt-panel text-dt-support hover:text-white flex items-center justify-center text-xs">×</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {selected.note && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                  <p className="text-xs text-red-300">{selected.note}</p>
                </div>
              )}

              {/* Bound-DE access table */}
              <div>
                <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Bound Digital Employees</p>
                <div className="rounded-xl border border-dt-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-dt-inset">
                      <tr><th className={th}>DE</th><th className={th}>Access</th></tr>
                    </thead>
                    <tbody>
                      {selected.boundDEs.map(de => (
                        <tr key={de.name} className="border-t border-dt-border">
                          <td className={td}>
                            <button onClick={() => setPage('workforce_des')} className="flex items-center gap-2 text-dt-body hover:text-indigo-300 transition-colors">
                              <DEAvatar name={de.name} /> {de.name}
                            </button>
                          </td>
                          <td className={td}>{accessBadge(de.accessLevel)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Actions */}
              <div>
                <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Available Actions</p>
                <div className="space-y-2">
                  {selected.actions.map(a => (
                    <div key={a.id} className="bg-dt-page border border-dt-border rounded-xl p-3">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-sm font-medium text-white">{a.label}</span>
                        {a.requiresApproval
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-700/30">Requires Approval</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-600/50 text-dt-support">Auto-approved</span>}
                      </div>
                      <p className="text-xs text-dt-support">{a.description}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {a.params.map(p => (
                          <span key={p} className="text-[10px] px-1.5 py-0.5 bg-dt-panel text-dt-muted rounded font-mono">{p}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Webhooks */}
              <div>
                <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Webhooks</p>
                <div className="space-y-2">
                  {selected.webhooks.map(w => (
                    <div key={w.event} className="flex items-start gap-3 bg-dt-page border border-dt-border rounded-lg px-3 py-2">
                      <span className="text-[10px] px-1.5 py-0.5 bg-dt-panel text-indigo-300 rounded font-mono flex-shrink-0">{w.event}</span>
                      <span className="text-xs text-dt-support">{w.description}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Data scope */}
              <div>
                <p className="text-xs font-medium text-dt-muted uppercase tracking-wider mb-2">Data Scope</p>
                <div className="flex flex-wrap gap-1.5">
                  {selected.dataScope.map(s => (
                    <span key={s} className="text-xs px-2 py-1 rounded-lg bg-dt-panel text-dt-support">{s}</span>
                  ))}
                </div>
                <p className="text-[11px] text-dt-muted mt-2">Data outside this scope is never readable by bound DEs. Scope changes are versioned in the audit trail.</p>
              </div>
            </div>

            <div className="p-5 border-t border-dt-border flex gap-3">
              <button className="flex-1 px-3 py-2 rounded-lg bg-dt-panel text-dt-support hover:bg-dt-panel text-xs transition-colors">Re-sync now</button>
              <button className="flex-1 px-3 py-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/30 text-xs transition-colors">Disconnect</button>
            </div>
          </div>
        </>
      )}

      {/* Add-connector catalog modal */}
      {showCatalog && (
        <>
          <div className="fixed inset-0 z-40 bg-dt-page/70" onClick={() => setShowCatalog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-2xl bg-dt-card border border-dt-border-strong rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">
              <div className="flex items-center justify-between p-5 border-b border-dt-border">
                <div>
                  <h2 className="text-sm font-semibold text-white">Connector catalog</h2>
                  <p className="text-xs text-dt-muted mt-0.5">Connecting a system makes its data and actions available to DEs you bind to it.</p>
                </div>
                <button onClick={() => setShowCatalog(false)} className="w-7 h-7 rounded-lg bg-dt-panel text-dt-support hover:text-white flex items-center justify-center text-xs">×</button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 grid grid-cols-3 gap-3">
                {CATALOG.map(c => (
                  <div key={c.name} className="bg-dt-page border border-dt-border rounded-xl p-3 flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-white">{c.name}</span>
                    <span className="text-[10px] text-dt-muted">{c.category}</span>
                    <p className="text-xs text-dt-support flex-1">{c.description}</p>
                    <button className="mt-1 text-xs px-2 py-1.5 rounded-lg bg-dt-panel text-dt-support hover:bg-indigo-600 hover:text-white transition-colors">Connect</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
