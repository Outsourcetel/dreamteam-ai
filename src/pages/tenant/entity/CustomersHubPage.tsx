import React from 'react';
import type { Page } from '../../../types';
import { InHubContext } from '../../../components/ui';
import { TabBar, Banner, Button } from '../../../design/primitives';
import { useVocabulary } from '../../../lib/vocabulary';
import { CustomerSalesPage, CustomerSuccessPage as CustomerSuccessPageWrapper } from './CustomerJourneyStubs';
import CustomerRenewalPage from './CustomerRenewalPage';
import CommercialContinuityPage from './CommercialContinuityPage';
import CustomerOnboardingLive from './CustomerOnboardingLive';
import CustomerOnboardingPage from './CustomerOnboardingPage';

// ═══════════════════════════════════════════════════════════════
// Customers hub (founder restructure 2026-07-22): the eight journey pages
// read like a mini-CRM and muddied the product story. ONE destination now —
// positioned explicitly as the WORKING COPY the employees act on, never the
// system of record. Tabs stay REAL Page keys so every old URL deep-links
// (the established hub pattern). Support lives in the Support hub — this
// hub points there instead of duplicating it.
// ═══════════════════════════════════════════════════════════════

const NORMALIZE: Partial<Record<Page, Page>> = {
  entity_customer: 'entity_customer_success',
  entity_customer_bd: 'entity_customer_sales',
};

const CustomersHubPage = ({ tab, setPage }: { tab: Page; setPage: (p: Page) => void }) => {
  const vocab = useVocabulary();
  const active = NORMALIZE[tab] ?? tab;

  const TABS: { key: Page; label: string }[] = [
    { key: 'entity_customer_success', label: `${vocab.party_plural}` },
    { key: 'entity_customer_sales', label: 'Pipeline' },
    { key: 'entity_customer_onboarding', label: 'Onboarding' },
    { key: 'entity_customer_renewal', label: `${vocab.renewal_label}s` },
    { key: 'entity_commercial_continuity', label: 'Agreements' },
  ];

  return (
    <div className="text-dt-body">
      <div className="px-6 pt-8">
        <h1 className="text-2xl font-semibold text-dt-title">{vocab.section_label}</h1>
        <p className="text-sm text-dt-support mt-1 max-w-3xl">
          The working copy your employees act on — accounts, pipeline, onboarding, renewals and agreements.
          Your CRM and helpdesk stay the systems of record; this is where the workforce reads, drafts, and writes back under approval.
        </p>
        <div className="mt-5">
          <TabBar tabs={TABS} active={active} onSelect={setPage} />
        </div>
      </div>
      <InHubContext.Provider value={true}>
        {tab === 'entity_customer_support' ? (
          <div className="p-6 max-w-2xl">
            <Banner tone="info">
              Support conversations moved to the Support hub — the live inbox, triage rules and the overview live there in one place.
            </Banner>
            <div className="mt-3">
              <Button kind="primary" onClick={() => setPage('support_inbox')}>Open the Support hub</Button>
            </div>
          </div>
        ) : active === 'entity_customer_success' ? (
          <CustomerSuccessPageWrapper setPage={setPage} />
        ) : active === 'entity_customer_sales' ? (
          <CustomerSalesPage setPage={setPage} />
        ) : active === 'entity_customer_onboarding' ? (
          <CustomerOnboardingLive setPage={setPage} />
        ) : active === 'entity_customer_renewal' ? (
          <CustomerRenewalPage setPage={setPage} />
        ) : (
          <CommercialContinuityPage setPage={setPage} />
        )}
      </InHubContext.Provider>
    </div>
  );
};

export default CustomersHubPage;
