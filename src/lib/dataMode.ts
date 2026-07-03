// ============================================================
// Data mode — 'demo' (TCP/PWC seed story) vs 'live' (real
// Supabase data for a real tenant). The rule lives in
// AuthContext; this hook is the single import surface pages use.
// ============================================================
import { useAuth } from '../context/AuthContext';
import type { DataMode } from '../context/AuthContext';

export type { DataMode };

/** Returns 'live' for real tenants (not the demo tenant / dev demo login,
 *  and not while a live user is exploring the demo companies), else 'demo'. */
export function useDataMode(): DataMode {
  return useAuth().dataMode;
}
