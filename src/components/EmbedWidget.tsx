import React, { useState, useRef, useEffect } from 'react'
import { supabase } from '../supabase'

interface EmbedWidgetProps {
  tenant_id: string
  de_id: string
  position?: 'bottom-right' | 'bottom-left' | 'center'
  theme?: 'light' | 'dark'
  branding?: {
    title?: string
    subtitle?: string
    brandColor?: string
  }
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  sources?: Array<{ title: string; url: string }>
}

export function EmbedWidget({
  tenant_id,
  de_id,
  position = 'bottom-right',
  theme = 'dark',
  branding = {},
}: EmbedWidgetProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const { data, error: err } = await supabase.rpc('de_answer_headless', {
        p_tenant_id: tenant_id,
        p_de_id: de_id,
        p_question: input,
      })

      if (err) throw err

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.answer || 'I was unable to generate a response. Please try again.',
        timestamp: new Date().toISOString(),
        sources: data.sources,
      }

      setMessages(prev => [...prev, assistantMessage])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send message')
      console.error('Embed widget error:', e)
    } finally {
      setLoading(false)
    }
  }

  const positionClasses = {
    'bottom-right': 'bottom-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    center: 'inset-0 flex items-center justify-center',
  }

  const bgColor = theme === 'dark' ? 'bg-dt-card' : 'bg-white'
  const textColor = theme === 'dark' ? 'text-dt-body' : 'text-slate-900'
  const borderColor = theme === 'dark' ? 'border-dt-border' : 'border-slate-200'
  const inputBg = theme === 'dark' ? 'bg-dt-page' : 'bg-slate-100'
  const brandColor = branding.brandColor || '#6366f1'

  return (
    <div className={`fixed ${positionClasses[position]} z-50 pointer-events-none`}>
      {isOpen ? (
        <div className={`pointer-events-auto w-96 h-96 ${bgColor} border ${borderColor} rounded-lg shadow-2xl flex flex-col overflow-hidden`}>
          {/* Header */}
          <div
            className="px-4 py-3 text-white flex items-center justify-between"
            style={{ backgroundColor: brandColor }}
          >
            <div>
              <h3 className="font-semibold text-sm">{branding.title || 'Support'}</h3>
              {branding.subtitle && <p className="text-xs opacity-90">{branding.subtitle}</p>}
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white hover:bg-white/20 rounded p-1 transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.length === 0 && (
              <div className={`text-center text-sm ${textColor} opacity-60`}>
                <p>👋 Hello! How can I help you today?</p>
              </div>
            )}
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-xs px-3 py-2 rounded text-sm ${
                    msg.role === 'user'
                      ? `text-white` // user messages
                      : `${textColor} ${theme === 'dark' ? 'bg-dt-inset' : 'bg-slate-100'}`
                  }`}
                  style={msg.role === 'user' ? { backgroundColor: brandColor } : {}}
                >
                  {msg.content}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-current opacity-60 text-xs space-y-1">
                      {msg.sources.map((s, idx) => (
                        <a key={idx} href={s.url} target="_blank" rel="noopener noreferrer" className="block hover:underline">
                          📎 {s.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className={`px-3 py-2 rounded text-sm ${textColor} opacity-60`}>
                  ⏳ Thinking...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-2 bg-red-900/20 border-t border-red-700/50">
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}

          {/* Input */}
          <form onSubmit={handleSendMessage} className={`border-t ${borderColor} px-4 py-3`}>
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ask a question..."
                disabled={loading}
                className={`flex-1 ${inputBg} border ${borderColor} rounded px-3 py-2 text-xs ${textColor} focus:outline-none focus:border-indigo-500 disabled:opacity-50`}
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="px-3 py-2 text-white rounded text-xs font-medium disabled:opacity-50 transition-colors"
                style={{ backgroundColor: brandColor }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                →
              </button>
            </div>
          </form>

          {/* Powered By */}
          <div className="px-4 py-2 text-center border-t border-dt-border">
            <a href="https://dreamteam.ai" target="_blank" rel="noopener noreferrer" className="text-xs text-dt-muted hover:text-dt-support">
              Powered by DreamTeam
            </a>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsOpen(true)}
          className="pointer-events-auto w-14 h-14 rounded-full shadow-lg hover:shadow-xl transition-shadow flex items-center justify-center text-white font-bold text-xl"
          style={{ backgroundColor: brandColor }}
          title="Open support chat"
        >
          💬
        </button>
      )}
    </div>
  )
}
