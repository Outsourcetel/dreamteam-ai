// Shared helpers for the live (production-track) API libs.
// Extracted in cleanup pass #6 — these were byte-identical copies in 11 libs.
import { CustomerApiError, isMissingTableError, getSessionTenantId } from './customerApi';

/** Log + throw a typed error for a failed Supabase call. */
export function raise(context: string, error: { code?: string; message: string }): never {
  console.error(`${context}:`, error.message);
  throw new CustomerApiError(error.message, isMissingTableError(error));
}

/** Resolve the session tenant id or throw. */
export async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) throw new CustomerApiError('No tenant found for the current session.', false);
  return tid;
}
