import React from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import CustomerSuccessLive from './CustomerSuccessLive';
import { CustomerBDLive, CustomerSalesLive } from './PipelineLive';

interface Opportunity {
  name: string;
  value: string;
  stage: string;
  closeDate: string;
  owner: string;
}
interface Account {
  name: string;
  health: number;
  arr: string;
  csm: string;
  trend: 'up' | 'down' | 'flat';
  note?: string;
}

// ============================================================
// Customer journey pages: Business Development, Sales, Success.
// Lighter than the migrated pages but fully seeded and
// company-aware. Numbers reconciled with companies.ts and
// DashboardPage ($2.1M TCP pipeline, 12 opps, 3 at-risk, etc).
// ============================================================



// ── Business Development ───────────────────────────────────────

interface Prospect {
  company: string;
  stage: string;
  source: string;
  owner: string;
  ownerIsDE: boolean;
  lastTouch: string;
}

const PROSPECTS: Record<CompanyId, Prospect[]> = {
  tcp: [
    { company: 'Lakeside Retail', stage: 'Qualified', source: 'Inbound demo request', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '3 hrs ago' },
    { company: 'Vertex Logistics', stage: 'Contacted', source: 'Outbound sequence', owner: 'S. Mitchell', ownerIsDE: false, lastTouch: '1 day ago' },
    { company: 'BluePeak Media', stage: 'New', source: 'Webinar signup', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '1 day ago' },
    { company: 'Orchard Health', stage: 'Qualified', source: 'Referral — Northfield Co', owner: 'S. Mitchell', ownerIsDE: false, lastTouch: '2 days ago' },
    { company: 'Ridgeline Manufacturing', stage: 'Contacted', source: 'Trade show', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '2 days ago' },
    { company: 'Summit Legal', stage: 'New', source: 'Content download', owner: 'Unassigned', ownerIsDE: false, lastTouch: '3 days ago' },
    { company: 'Cobalt Energy', stage: 'Nurture', source: 'Outbound sequence', owner: 'S. Mitchell', ownerIsDE: false, lastTouch: '5 days ago' },
    { company: 'Fairview Foods', stage: 'Nurture', source: 'Website chat', owner: 'J. Cooper', ownerIsDE: false, lastTouch: '1 week ago' },
  ],
  pwc: [
    { company: 'Beacon Capital', stage: 'Qualified', source: 'Partner referral', owner: 'D. Whitmore', ownerIsDE: false, lastTouch: '2 hrs ago' },
    { company: 'Ironwood Estates', stage: 'Contacted', source: 'Existing client expansion', owner: 'L. Ahmed', ownerIsDE: false, lastTouch: '1 day ago' },
    { company: 'Meridian Trust', stage: 'New', source: 'Industry event', owner: 'D. Whitmore', ownerIsDE: false, lastTouch: '2 days ago' },
    { company: 'Halcyon Ventures', stage: 'Qualified', source: 'Partner referral', owner: 'L. Ahmed', ownerIsDE: false, lastTouch: '3 days ago' },
    { company: 'Stonebridge Group', stage: 'Nurture', source: 'Alumni network', owner: 'D. Whitmore', ownerIsDE: false, lastTouch: '1 week ago' },
    { company: 'Crescent Partners', stage: 'Nurture', source: 'Industry event', owner: 'L. Ahmed', ownerIsDE: false, lastTouch: '2 weeks ago' },
  ],
};

const FUNNEL: Record<CompanyId, { stage: string; count: number; color: string }[]> = {
  tcp: [
    { stage: 'Prospects', count: 14, color: 'bg-indigo-500' },
    { stage: 'Contacted', count: 9, color: 'bg-indigo-400' },
    { stage: 'Qualified', count: 5, color: 'bg-emerald-500' },
    { stage: 'Handed to Sales', count: 3, color: 'bg-emerald-400' },
  ],
  pwc: [
    { stage: 'Pursuits', count: 6, color: 'bg-indigo-500' },
    { stage: 'Contacted', count: 4, color: 'bg-indigo-400' },
    { stage: 'Qualified', count: 2, color: 'bg-emerald-500' },
    { stage: 'Proposal stage', count: 1, color: 'bg-emerald-400' },
  ],
};

const stageBadge = (stage: string) => {
  if (stage === 'Qualified') return 'bg-emerald-500/15 text-emerald-300';
  if (stage === 'Contacted') return 'bg-indigo-500/15 text-indigo-300';
  if (stage === 'Nurture') return 'bg-amber-500/15 text-amber-300';
  return 'bg-slate-600/50 text-dt-support';
};

export const CustomerBDPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerBDLive />;
};

const OPPORTUNITIES: Record<CompanyId, Opportunity[]> = {
  tcp: [
    { name: 'Ironbridge Systems — Enterprise', value: '$156K', stage: 'Negotiation', closeDate: 'Jul 18', owner: 'J. Cooper' },
    { name: 'Lakeside Retail — Growth', value: '$96K', stage: 'Proposal', closeDate: 'Jul 25', owner: 'S. Mitchell' },
    { name: 'Vertex Logistics — Growth', value: '$84K', stage: 'Demo', closeDate: 'Aug 1', owner: 'J. Cooper' },
    { name: 'Orchard Health — Enterprise', value: '$210K', stage: 'Proposal', closeDate: 'Aug 8', owner: 'S. Mitchell' },
    { name: 'BluePeak Media — Starter', value: '$36K', stage: 'Discovery', closeDate: 'Aug 15', owner: 'J. Cooper' },
    { name: 'Ridgeline Manufacturing — Growth', value: '$120K', stage: 'Demo', closeDate: 'Aug 22', owner: 'S. Mitchell' },
    { name: 'Summit Legal — Starter', value: '$42K', stage: 'Discovery', closeDate: 'Aug 29', owner: 'J. Cooper' },
    { name: 'Cobalt Energy — Enterprise', value: '$340K', stage: 'Negotiation', closeDate: 'Sep 5', owner: 'S. Mitchell' },
    { name: 'Fairview Foods — Growth', value: '$88K', stage: 'Discovery', closeDate: 'Sep 12', owner: 'J. Cooper' },
    { name: 'Harborview Clinics — Growth', value: '$132K', stage: 'Demo', closeDate: 'Sep 19', owner: 'S. Mitchell' },
    { name: 'Atlas Freight — Enterprise', value: '$496K', stage: 'Proposal', closeDate: 'Sep 26', owner: 'J. Cooper' },
    { name: 'Juniper Analytics — Growth', value: '$300K', stage: 'Discovery', closeDate: 'Oct 3', owner: 'S. Mitchell' },
  ],
  pwc: [
    { name: 'Beacon Capital — Tax Advisory', value: '$180K', stage: 'Proposal sent', closeDate: 'Jul 30', owner: 'D. Whitmore' },
    { name: 'Halcyon Ventures — Audit', value: '$240K', stage: 'Proposal sent', closeDate: 'Aug 12', owner: 'L. Ahmed' },
    { name: 'Ironwood Estates — Advisory', value: '$95K', stage: 'Proposal drafting', closeDate: 'Aug 28', owner: 'D. Whitmore' },
  ],
};

const oppStageBadge = (stage: string) => {
  if (stage.startsWith('Negotiation')) return 'bg-emerald-500/15 text-emerald-300';
  if (stage.startsWith('Proposal')) return 'bg-indigo-500/15 text-indigo-300';
  if (stage === 'Demo') return 'bg-sky-500/15 text-sky-300';
  return 'bg-slate-600/50 text-dt-support';
};

export const CustomerSalesPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerSalesLive />;
};

const ACCOUNTS: Record<CompanyId, Account[]> = {
  tcp: [
    { name: 'Northfield Co', health: 81, arr: '$210K', csm: 'P. Sharma', trend: 'up' },
    { name: 'Lakeshore Analytics', health: 72, arr: '$84K', csm: 'P. Sharma', trend: 'flat' },
    { name: 'Harbor Tech', health: 61, arr: '$67K', csm: 'T. Smith', trend: 'up' },
    { name: 'Meridian Group', health: 58, arr: '$156K', csm: 'T. Smith', trend: 'down', note: 'Renewal at risk — invoice pending' },
    { name: 'Brightline Studios', health: 76, arr: '$52K', csm: 'P. Sharma', trend: 'up' },
    { name: 'Kestrel Systems', health: 68, arr: '$91K', csm: 'J. Lee', trend: 'flat' },
    { name: 'Apex Systems', health: 34, arr: '$43K', csm: 'J. Lee', trend: 'down', note: 'Open P1 escalation — API auth failure' },
    { name: 'Silverpine Labs', health: 44, arr: '$38K', csm: 'T. Smith', trend: 'down', note: 'Usage dropped 40% in 30 days' },
    { name: 'Crownfield Insurance', health: 39, arr: '$74K', csm: 'P. Sharma', trend: 'down', note: 'Champion left the company' },
    { name: 'Oakhurst Retail', health: 83, arr: '$110K', csm: 'J. Lee', trend: 'up' },
    { name: 'Pinnacle Freight', health: 71, arr: '$66K', csm: 'T. Smith', trend: 'flat' },
    { name: 'Waverly Health', health: 78, arr: '$95K', csm: 'P. Sharma', trend: 'up' },
  ],
  pwc: [
    { name: 'Harbor Financial — Audit', health: 82, arr: '$310K', csm: 'D. Whitmore', trend: 'up' },
    { name: 'Crestview Holdings — Advisory', health: 74, arr: '$120K', csm: 'L. Ahmed', trend: 'flat' },
    { name: 'Sterling Group — Tax', health: 69, arr: '$85K', csm: 'D. Whitmore', trend: 'flat' },
    { name: 'Beacon Capital — Advisory', health: 47, arr: '$60K', csm: 'L. Ahmed', trend: 'down', note: 'Deliverable deadline slipped twice' },
  ],
};

const healthColor = (h: number) => (h >= 70 ? 'bg-emerald-500' : h >= 45 ? 'bg-amber-500' : 'bg-red-500');
const healthText = (h: number) => (h >= 70 ? 'text-emerald-300' : h >= 45 ? 'text-amber-300' : 'text-red-300');
const trendIcon = (t: Account['trend']) => (t === 'up' ? '↑' : t === 'down' ? '↓' : '→');

export const CustomerSuccessPage = ({ setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerSuccessLive />;
};

