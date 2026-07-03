import React from 'react';

// Shared UI primitives for the entity/outcome pages (Phases 2-4).
// Extracted from identical copies in CustomerJourneyStubs, VendorPages,
// WorkforcePages and OutcomePages.

/** Table header / cell class strings shared by every seeded data table. */
export const th = 'py-2.5 px-4 text-[11px] uppercase tracking-wide text-slate-500 font-medium text-left';
export const td = 'py-3 px-4';

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      <p className="text-slate-400 text-sm mt-1">{subtitle}</p>
    </div>
  );
}
