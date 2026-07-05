// Shared helpers for the live (production-track) API libs.
// Extracted in cleanup pass #6 — these were byte-identical copies in 11 libs.
import { supabase } from '../supabase';
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

/** List every row for the caller's tenant from a table, ordered by one column.
 *  Extracted in cleanup pass #7 — connectorApi/trustApi/playbookBuilderApi each
 *  had a byte-identical "select * where tenant_id = ... order by ..." helper. */
export async function listTenantRows<T>(
  table: string,
  orderBy: string,
  ascending: boolean,
  context: string,
): Promise<T[]> {
  const tid = await requireTenantId();
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('tenant_id', tid)
    .order(orderBy, { ascending });
  if (error) raise(context, error);
  return (data ?? []) as T[];
}
