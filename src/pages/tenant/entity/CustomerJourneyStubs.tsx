import type { Page } from '../../../types';
import CustomerSuccessLive from './CustomerSuccessLive';
import { CustomerSalesLive } from './PipelineLive';

// ============================================================
// Customer journey pages: Pipeline and Success. Thin routes onto
// the live components — all data comes from the database.
//
// ⚠ THERE IS NO CustomerBDPage ANY MORE, and its absence is the fix
// rather than an omission. CustomersHubPage NORMALIZEs
// `entity_customer_bd` → `entity_customer_sales` (founder restructure
// 280f5c51, "BD folds into Sales"), so a BD wrapper could only ever
// render nowhere — which is exactly what happened for a month, taking
// "+ Add prospect" and "+ Import CSV" down with it (register B-19).
// Those controls now live on CustomerSalesLive, the surface the hub
// actually renders.
// ============================================================

export const CustomerSalesPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerSalesLive />;
};

export const CustomerSuccessPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  return <CustomerSuccessLive />;
};
