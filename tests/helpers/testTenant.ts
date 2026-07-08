// ============================================================
// Creates a real, isolated tenant + signed-in user for a test run,
// using the exact same public signup path the real app uses
// (auth.signUp -> handle_new_user trigger creates a tenant_id=NULL
// profile -> complete_signup() RPC creates the tenant and links it)
// rather than a service-role shortcut. This means these tests
// exercise the real signup flow itself, not just a synthetic stand-in.
// ============================================================
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY } from '../setup';

export interface TestTenant {
  client: SupabaseClient;
  userId: string;
  tenantId: string;
  email: string;
}

let counter = 0;

/** Signs up a brand-new user and completes signup for a brand-new
 *  tenant. Each call gets its own SupabaseClient instance so sessions
 *  never bleed into each other within a test file. */
export async function createTestTenant(orgNamePrefix: string): Promise<TestTenant> {
  counter += 1;
  const unique = `${Date.now()}-${counter}`;
  const email = `test-suite-${unique}@dreamteam-ai-tests.invalid`;
  const password = `TestPass!${unique}`;

  const client = createClient(TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY);

  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email,
    password,
    options: { data: { full_name: 'Test Suite User', role: 'tenant_owner', layer: 'tenant' } },
  });
  if (signUpError) throw new Error(`signUp failed: ${signUpError.message}`);
  if (!signUpData.session) {
    throw new Error('signUp did not return a session — is mailer_autoconfirm enabled on the dev project?');
  }

  const { data: completeData, error: completeError } = await client.rpc('complete_signup', {
    p_org_name: `${orgNamePrefix} ${unique}`,
  });
  if (completeError) throw new Error(`complete_signup failed: ${completeError.message}`);
  if (!completeData?.ok) throw new Error(`complete_signup returned not-ok: ${JSON.stringify(completeData)}`);

  return {
    client,
    userId: signUpData.user!.id,
    tenantId: completeData.tenant_id,
    email,
  };
}
