import React, { createContext, useContext } from 'react';

// Shared UI primitives for the entity/outcome pages (Phases 2-4).
// Extracted from identical copies in CustomerJourneyStubs, VendorPages,
// WorkforcePages and OutcomePages.

/** Table header / cell class strings shared by every seeded data table. */
export const th = 'py-2.5 px-4 text-[11px] uppercase tracking-wide text-dt-muted font-medium text-left';
export const td = 'py-3 px-4';

// Inside a hub (Knowledge/Workforce/Governance/…) the hub header + active tab
// already name the view — pages rendered there keep only their subtitle line.
// Providers live in the hub pages; standalone renders are unaffected.
export const InHubContext = createContext(false);

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const inHub = useContext(InHubContext);
  if (inHub) {
    return <p className="text-dt-support text-sm mb-5 max-w-3xl">{subtitle}</p>;
  }
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      <p className="text-dt-support text-sm mt-1">{subtitle}</p>
    </div>
  );
}
