import { DEFAULT_ACCENT } from '../design/branding';
import type { Page } from '../types';

export const PORTAL_TABS: { id: Page; label: string }[] = [
  { id: 'entity_customer_support', label: 'Support Control Room' },
  { id: 'eu_chat', label: 'Customer View' },
];

const PageTabs = ({
  tabs,
  page,
  setPage,
  accentColor,
}: {
  tabs: { id: Page; label: string }[];
  page?: Page;
  setPage?: (p: Page) => void;
  accentColor?: string;
}) => (
  <div className="flex flex-wrap gap-1 bg-dt-panel rounded-xl p-1 mb-6 w-fit">
    {tabs.map((t) => (
      <button
        key={t.id}
        onClick={() => setPage && setPage(t.id)}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
          page === t.id ? 'text-white' : 'text-dt-support hover:text-dt-body'
        }`}
        style={page === t.id ? { backgroundColor: accentColor || DEFAULT_ACCENT } : {}}
      >
        {t.label}
      </button>
    ))}
  </div>
);

export default PageTabs;
