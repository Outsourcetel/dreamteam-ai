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

// ⚠ The preview browser's remaining scaffolding was DELETED 2026-08-22, for the
// same reason and by the same rule as FilterSelect below. Removed, all verified
// as definition-only with no reference anywhere in src/:
//
//   KArticle    the preview's row shape. Its only consumer was isStale.
//   v()         a version-tuple helper for the preview's fixture data. Zero calls.
//   TODAY       `new Date('2026-07-03')` — a FROZEN clock. Nothing read it but
//               daysSince, and a hardcoded "today" is a bug waiting for a reader.
//   daysSince   only ever called by isStale.
//   isStale     zero call sites.
//   typeBadge   } the preview's per-row colour maps. Zero reads; the live page
//   entityBadge } (LiveKnowledgeLibrary) has its own.
//   DEAvatars   zero render sites.
//
// Recoverable at 5c76d8a.
//
// ⚠ What survives below is NOT dead and must not be swept with it:
// KEntity/KAudience/KType/K_TYPES are imported by KnowledgeGapsPage, and
// ConfidenceBar by KnowledgeQualityPage.

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


// ⚠ FilterSelect was DELETED 2026-08-21. This file is a five-line wrapper —
// everything it renders is <LiveKnowledgeLibrary/> — and that page has carried
// its own facet dropdowns (`<select className={SELECT_CLS}>`, plus the
// FilterBar primitive) since it replaced the preview browser. FilterSelect was
// the preview's bespoke recipe: zero render sites, and the design system names
// SELECT_CLS-inside-FilterBar as what a facet dropdown must be instead.
// Recoverable at fe6081a6. (The rest of the preview scaffolding followed it on
// 2026-08-22 — see the note above the survivors at the top of this file, which
// is where the "what is still live" list now lives, next to the things it
// describes rather than sixty lines away from them.)

const KnowledgeLibraryPage = ({ setPage }: { setPage?: (p: import('../../../types').Page) => void }) => {
  return <LiveKnowledgeLibrary setPage={setPage} />;
};

export default KnowledgeLibraryPage;
