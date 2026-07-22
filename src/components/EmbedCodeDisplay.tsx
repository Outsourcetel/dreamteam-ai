import React, { useState } from 'react'
import { getEmbedToken, getEmbedCodeSnippet } from '../lib/embedTokenApi'

interface EmbedCodeDisplayProps {
  tenant_id: string
  de_id: string
  de_name: string
}

export function EmbedCodeDisplay({ tenant_id, de_id, de_name }: EmbedCodeDisplayProps) {
  const [embedCode, setEmbedCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleGenerateCode = async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getEmbedToken(tenant_id, de_id)
      const code = getEmbedCodeSnippet(token.embed_url)
      setEmbedCode(code)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate embed code')
    } finally {
      setLoading(false)
    }
  }

  const handleCopyCode = async () => {
    if (embedCode) {
      try {
        await navigator.clipboard.writeText(embedCode)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        setError('Failed to copy to clipboard')
      }
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white mb-2">Embed {de_name} Widget</h3>
        <p className="text-xs text-dt-support mb-4">
          Get the HTML code to embed {de_name} chat widget into your website.
        </p>
      </div>

      {!embedCode ? (
        <button
          onClick={handleGenerateCode}
          disabled={loading}
          className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? 'Generating...' : '📋 Get Embed Code'}
        </button>
      ) : (
        <div className="space-y-3">
          <div className="bg-dt-page border border-dt-border rounded-lg p-4 font-mono text-xs text-dt-support overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
            {embedCode}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCopyCode}
              className="flex-1 px-4 py-2 bg-dt-panel hover:bg-dt-panel text-dt-body rounded-lg text-sm font-medium transition-colors"
            >
              {copied ? '✓ Copied!' : '📋 Copy to Clipboard'}
            </button>
            <button
              onClick={() => setEmbedCode(null)}
              className="flex-1 px-4 py-2 bg-dt-panel hover:bg-dt-panel text-dt-body rounded-lg text-sm font-medium transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="bg-emerald-900/20 border border-emerald-700/50 rounded-lg p-3">
            <p className="text-xs text-emerald-300">
              ✓ Paste this code into your website's HTML. The chat widget will appear in an iframe.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-lg p-3">
          <p className="text-xs text-red-300">⚠ {error}</p>
        </div>
      )}
    </div>
  )
}
