// discoveryApi.ts — data layer for the discovery proposal screen
// (.superpowers/sdd/2026-08-13-discovery-proposals-and-creation, Task 2).
//
// Reads discovery_sessions, discovery_proposals, discovery_dimensions and
// discovery_capability_gaps (all migrations 733-737). WRITES NOTHING — this
// task's hard rule is "no decision writes"; decide_discovery_proposal does
// not exist yet (Task 3). Every function here is a plain select.
//
// ⚠ Never reads or writes a digital_employees row at all (discovery_proposals
// is deliberately uncoupled from digital_employees — an 'employee' kind's
// payload is a jsonb DRAFT, not a foreign key), so is_workforce_assistant is
// trivially out of scope, the same way it was for Task 1's discoveryProposals.ts.
import { supabase } from '../supabase';
import { getSessionTenantId, CustomerApiError, isMissingTableError } from './customerApi';
import type { ProposalKind, ProposalState } from './discoveryProposalPresentation';

export type { ProposalKind, ProposalState };

export interface DiscoveryProposal {
  id: string;
  session_id: string;
  tenant_id: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  rationale: string | null;
  source_dimension: string | null;
  state: ProposalState;
  decided_by: string | null;
  decided_at: string | null;
  created_object_id: string | null;
  created_at: string;
}

export interface DiscoveryCoverageEntry {
  state: 'heard' | 'parked' | 'skipped' | 'not_heard';
  evidence: string | null;
  recorded_at?: string;
}

export interface DiscoverySession {
  id: string;
  tenant_id: string;
  status: 'running' | 'proposed' | 'accepted' | 'parked' | 'abandoned';
  coverage: Record<string, DiscoveryCoverageEntry>;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryDimension {
  key: string;
  title: string;
  ordinal: number;
}

export interface DiscoveryCapabilityGap {
  dimension_key: string;
  title: string;
  serves_archetypes: string[];
  planned_archetypes: string[];
  customer_message: string;
}

async function requireTenantId(): Promise<string> {
  const tid = await getSessionTenantId();
  if (!tid) {
    throw new CustomerApiError(
      'This is a live-workspace screen — sign into your live workspace to see setup recommendations. (Demo companies have no discovery session to review.)',
      false,
    );
  }
  return tid;
}

/** The most recently-touched discovery session for this tenant that has at
 *  least one proposal. Deliberately NOT filtered by session status: natural
 *  completion inside discovery-interview/index.ts's 'answer' action never
 *  flips discovery_sessions.status off 'running' (only the caller-stops
 *  'end' action does, into 'parked'/'abandoned') — so "status = proposed"
 *  would silently miss the common case. "Has a proposal at all" is the only
 *  signal that is actually true today. */
export async function getLatestSessionWithProposals(): Promise<DiscoverySession | null> {
  const tenantId = await requireTenantId();
  const { data, error } = await supabase
    .from('discovery_proposals')
    .select('session_id, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  const sessionId = data && data.length > 0 ? (data[0].session_id as string) : null;
  if (!sessionId) return null;
  return getDiscoverySession(sessionId);
}

export async function getDiscoverySession(sessionId: string): Promise<DiscoverySession | null> {
  const tenantId = await requireTenantId();
  const { data, error } = await supabase
    .from('discovery_sessions')
    .select('id, tenant_id, status, coverage, created_at, updated_at')
    .eq('id', sessionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data as DiscoverySession | null) ?? null;
}

export async function listDiscoveryProposals(sessionId: string): Promise<DiscoveryProposal[]> {
  const tenantId = await requireTenantId();
  const { data, error } = await supabase
    .from('discovery_proposals')
    .select('id, session_id, tenant_id, kind, payload, rationale, source_dimension, state, decided_by, decided_at, created_object_id, created_at')
    .eq('tenant_id', tenantId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data ?? []) as DiscoveryProposal[];
}

/** discovery_dimensions has no tenant scoping — it's the shared spine, read
 *  by every workspace alike (migration 733's own RLS: `for select to
 *  authenticated using (true)`). Used only to turn a proposal's
 *  source_dimension key into the title shown in its Drawer. */
export async function listDiscoveryDimensions(): Promise<DiscoveryDimension[]> {
  const { data, error } = await supabase
    .from('discovery_dimensions')
    .select('key, title, ordinal')
    .order('ordinal', { ascending: true });
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data ?? []) as DiscoveryDimension[];
}

/** discovery_capability_gaps is a platform-wide VIEW (migration 734), not
 *  tenant data — every dimension carrying a planned_ archetype appears
 *  regardless of who is looking. Narrowed here to the dimensions THIS
 *  session actually marked 'heard', so the banner only ever states what
 *  this customer was actually told, not the platform's full unstaffed list. */
export async function listCapabilityGapsForHeardDimensions(heardKeys: readonly string[]): Promise<DiscoveryCapabilityGap[]> {
  if (heardKeys.length === 0) return [];
  const { data, error } = await supabase
    .from('discovery_capability_gaps')
    .select('dimension_key, title, serves_archetypes, planned_archetypes, customer_message')
    .in('dimension_key', heardKeys);
  if (error) throw new CustomerApiError(error.message, isMissingTableError(error));
  return (data ?? []) as DiscoveryCapabilityGap[];
}
