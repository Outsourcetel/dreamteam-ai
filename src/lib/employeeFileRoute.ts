import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Page } from '../types';

// Employee File deep-linking. The file lives at /workforce/employee?de=<id> —
// URLSync only reconciles PATHNAMES, so the ?de= query rides along untouched
// as long as the navigate() lands before the page-state change settles (both
// happen in the same handler tick here). Cold deep links work because
// URL_TO_PAGE matches the bare pathname and the page reads ?de= itself.
// An optional ?tab=<key> rides the same way: the page reads it once on mount
// and whitelists it against its own tab set (never trust the URL to open a
// section) — an unknown key simply lands on the default tab.

export const EMPLOYEE_FILE_PATH = '/workforce/employee';

export function useOpenEmployeeFile(setPage: (p: Page) => void) {
  const navigate = useNavigate();
  return useCallback((deId: string, tab?: string) => {
    navigate(`${EMPLOYEE_FILE_PATH}?de=${encodeURIComponent(deId)}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
    setPage('workforce_de_file');
  }, [navigate, setPage]);
}

export function useEmployeeFileDeId(): string | null {
  const location = useLocation();
  return new URLSearchParams(location.search).get('de');
}
