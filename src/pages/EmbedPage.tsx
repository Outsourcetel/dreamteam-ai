/**
 * Embed Page
 *
 * Renders the Support DE widget in an iframe.
 * Authenticates via query params: tenant_id, de_id, token
 */

import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmbedWidget } from '../components/EmbedWidget'
import { supabase } from '../supabase'

export function EmbedPage() {
  const [searchParams] = useSearchParams()
  const [authenticated, setAuthenticated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tenant_id = searchParams.get('tenant_id')
  const de_id = searchParams.get('de_id')
  const token = searchParams.get('token')

  useEffect(() => {
    const verify = async () => {
      if (!tenant_id || !de_id || !token) {
        setError('Missing required parameters: tenant_id, de_id, token')
        return
      }

      try {
        // The embed token is an OPAQUE random secret (not a JWT): the server
        // stores only its SHA-256 hash and verify_embed_token checks the
        // hash + tenant + DE + expiry. Nothing is decoded client-side.
        const { data, error: err } = await supabase.rpc('verify_embed_token', {
          p_token: token,
          p_tenant_id: tenant_id,
          p_de_id: de_id,
        })

        if (err || !data) {
          setError('Invalid or expired token')
          return
        }

        setAuthenticated(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Authentication failed')
      }
    }

    verify()
  }, [tenant_id, de_id, token])

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-dt-page p-4">
        <div className="text-center max-w-sm">
          <p className="text-red-300 text-sm font-medium mb-2">⚠️ {error}</p>
          <p className="text-dt-support text-xs">
            If this problem persists, contact support@dreamteam.ai
          </p>
        </div>
      </div>
    )
  }

  if (!authenticated) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-dt-page">
        <p className="text-dt-support text-sm">Initializing...</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full bg-dt-page">
      {tenant_id && de_id && (
        <EmbedWidget
          tenant_id={tenant_id}
          de_id={de_id}
          position="center"
          theme="dark"
          branding={{
            title: 'Support',
            subtitle: 'How can we help?',
            brandColor: '#6366f1',
          }}
        />
      )}
    </div>
  )
}
