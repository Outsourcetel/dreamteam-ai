/**
 * Embed Token API
 *
 * Generates JWT tokens for embedded widget authentication.
 * Tokens are tenant+DE scoped, answer-only (no write permissions).
 */

import { supabase } from '../supabase'

export interface EmbedToken {
  token: string
  embed_url: string
  expires_at: string
}

/**
 * Generate embed token for a tenant's Support DE
 *
 * Returns a JWT that can be passed to the embed widget iframe.
 * Token grants: tenant_id access, de_id scope, answer endpoint only.
 */
export async function generateEmbedToken(
  tenant_id: string,
  de_id: string,
  expires_in_hours: number = 24
): Promise<EmbedToken> {
  try {
    const { data, error } = await supabase.rpc('generate_embed_token', {
      p_tenant_id: tenant_id,
      p_de_id: de_id,
      p_expires_in_hours: expires_in_hours,
    })

    if (error) throw error

    return {
      token: data.token,
      embed_url: `${window.location.origin}/embed?tenant_id=${tenant_id}&de_id=${de_id}&token=${data.token}`,
      expires_at: data.expires_at,
    }
  } catch (e) {
    console.error('Failed to generate embed token:', e)
    throw e
  }
}

/**
 * Get or create embed token for tenant
 *
 * Reuses existing token if still valid, creates new one if expired.
 * Useful for embedding code that needs to stay the same across page loads.
 */
export async function getEmbedToken(tenant_id: string, de_id: string): Promise<EmbedToken> {
  try {
    const { data, error } = await supabase.rpc('get_or_create_embed_token', {
      p_tenant_id: tenant_id,
      p_de_id: de_id,
    })

    if (error) throw error

    return {
      token: data.token,
      embed_url: `${window.location.origin}/embed?tenant_id=${tenant_id}&de_id=${de_id}&token=${data.token}`,
      expires_at: data.expires_at,
    }
  } catch (e) {
    console.error('Failed to get embed token:', e)
    throw e
  }
}

/**
 * Get embed code snippet for tenant (for copy-paste into customer website)
 */
export function getEmbedCodeSnippet(embedUrl: string): string {
  return `<!-- DreamTeam Support Widget -->
<div id="dreamteam-widget" style="width: 100%; height: 100%; min-height: 600px;">
  <iframe
    src="${embedUrl}"
    style="width: 100%; height: 100%; border: none; border-radius: 8px;"
    allow="microphone; camera"
  ></iframe>
</div>`
}
