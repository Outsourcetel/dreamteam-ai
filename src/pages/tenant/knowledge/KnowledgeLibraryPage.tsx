import React, { useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { CompanyId } from '../../../data/companies';
import { PageHeader, th, td } from '../../../components/ui';
import LiveKnowledgeLibrary from './LiveKnowledgeLibrary';

// ============================================================
// Knowledge Library — the 4-dimension browser.
// Every item tagged Entity × Audience × Type × Confidence.
// Collections + coverage reconciled with WorkforceDEsPage DE
// knowledge configs (TCP: Alex/Casey/Riley; PWC: Morgan/Avery).
// ============================================================

export type KEntity = 'Customer' | 'Vendor' | 'Workforce';
export type KAudience = 'All DEs' | 'Customer DEs' | 'Specialist DEs' | 'Humans only';
export const K_TYPES = ['Reference', 'Procedural', 'Regulatory', 'Institutional', 'Customer (PII)', 'Competitive', 'Training'] as const;
export type KType = (typeof K_TYPES)[number];

export interface KArticle {
  id: string;
  title: string;
  collection: string;
  entity: KEntity;
  type: KType;
  audience: KAudience;
  confidence: number;
  lastVerified: string; // yyyy-mm-dd
  usedBy: string[]; // DE names
  access: { de: string; level: 'read' | 'read_write' }[];
  versions: { version: string; date: string; note: string }[];
}

const v = (n: string, d: string, note: string) => ({ version: n, date: d, note });

const TODAY = new Date('2026-07-03');
export const daysSince = (d: string) => Math.round((TODAY.getTime() - new Date(d).getTime()) / 86400000);
export const isStale = (a: KArticle) => daysSince(a.lastVerified) > 90;

const typeBadge: Record<KType, string> = {
  'Reference': 'bg-sky-500/20 text-sky-400',
  'Procedural': 'bg-indigo-500/20 text-indigo-400',
  'Regulatory': 'bg-red-500/20 text-red-400',
  'Institutional': 'bg-amber-500/20 text-amber-400',
  'Customer (PII)': 'bg-purple-500/20 text-purple-400',
  'Competitive': 'bg-pink-500/20 text-pink-400',
  'Training': 'bg-teal-500/20 text-teal-400',
};

const entityBadge: Record<KEntity, string> = {
  Customer: 'bg-indigo-500/20 text-indigo-400',
  Vendor: 'bg-amber-500/20 text-amber-400',
  Workforce: 'bg-teal-500/20 text-teal-400',
};

export function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 90 ? 'bg-emerald-400' : value >= 70 ? 'bg-amber-400' : 'bg-red-400';
  const text = value >= 90 ? 'text-emerald-400' : value >= 70 ? 'text-amber-400' : 'text-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-dt-panel overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-xs font-medium ${text}`}>{value}%</span>
    </div>
  );
}

export function DEAvatars({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-xs text-dt-faint">—</span>;
  return (
    <div className="flex -space-x-1.5">
      {names.map(n => (
        <div key={n} title={n} className="w-6 h-6 rounded-full bg-indigo-600 border border-dt-border flex items-center justify-center text-white text-[10px] font-bold">{n[0]}</div>
      ))}
    </div>
  );
}

// ⚠ FilterSelect was DELETED 2026-08-21. This file is a five-line wrapper —
// everything it renders is <LiveKnowledgeLibrary/> — and that page has carried
// its own facet dropdowns (`<select className={SELECT_CLS}>`, plus the
// FilterBar primitive) since it replaced the preview browser. FilterSelect was
// the preview's bespoke recipe: zero render sites, and the design system names
// SELECT_CLS-inside-FilterBar as what a facet dropdown must be instead.
// Recoverable at fe6081a6.
//
// ⚠ The rest of this file is NOT dead and must not be swept with it:
// KEntity/KAudience/KType/K_TYPES are imported by KnowledgeGapsPage and
// ConfidenceBar by KnowledgeQualityPage.

const KnowledgeLibraryPage = ({ setPage }: { setPage?: (p: import('../../../types').Page) => void }) => {
  return <LiveKnowledgeLibrary setPage={setPage} />;
};

export default KnowledgeLibraryPage;
