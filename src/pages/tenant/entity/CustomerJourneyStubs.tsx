import type { Page } from '../../../types';
import CustomerSuccessLive from './CustomerSuccessLive';
import { CustomerBDLive, CustomerSalesLive } from './PipelineLive';

// ============================================================
// Customer journey pages: Business Development, Sales, Success.
// Thin routes onto the live pipeline components — all data comes
// from the database via the *Live components below.
// ============================================================

export const CustomerBDPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerBDLive />;
};

export const CustomerSalesPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerSalesLive />;
};

export const CustomerSuccessPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerSuccessLive />;
};
