/**
 * voice-relay — PREMIUM voice for the support chat (Phase 3), dormant-honest.
 *
 * The client (ChatCore / widget.js) never talks to a speech vendor directly:
 * it calls this relay, authed by the same publishable widget key. Keeps the
 * provider secret server-side and lets the provider be swapped without any
 * client change. Reference provider = Deepgram (one key covers STT + TTS);
 * ElevenLabs/others slot in behind the same actions.
 *
 * If DEEPGRAM_API_KEY is unset the relay reports { stt:false, tts:false }
 * and the client falls back to the free browser Web Speech API — so voice
 * always works; premium simply upgrades it when a key is added.
 *
 * Actions (POST JSON, widget_key required):
 *   { action:'config' }                       → { stt, tts }
 *   { action:'stt', audio:<base64>, mime }    → { text }
 *   { action:'tts', text, lang? }             → { audio:<base64>, mime }
 *
 * Deployed verify_jwt=false — the widget key is the auth.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';
import { durableRateLimited, clientIp } from '../_shared/rateLimit.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Cost + abuse guards — the widget key is publishable (embedded on the
// tenant's site), so a key holder could otherwise drive unbounded
// Deepgram STT/TTS spend. Mirrors widget-ask's sliding window; voice
// calls are heavier per request, so the per-minute ceiling is lower.
// (Per-isolate, like widget-ask: a distributed attacker across cold
// isolates can exceed the global cap by some multiple — acceptable as a
// first-line throttle; provider-side spend caps are the backstop.)
const RATE_LIMIT_PER_MIN = 60;
const MAX_AUDIO_B64_CHARS = 2_000_000; // ~1.5 MB decoded — short utterances, not file uploads
const rateWindows = new Map<string, number[]>();
function rateLimited(keyId: string): boolean {
  const now = Date.now();
  const win = (rateWindows.get(keyId) ?? []).filter((t) => now - t < 60_000);
  win.push(now);
  rateWindows.set(keyId, win);
  return win.length > RATE_LIMIT_PER_MIN;
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Deepgram TTS voice per (best-effort) language — English-centric provider;
// unknown languages fall back to the default voice.
function ttsModel(lang?: string | null): string {
  const custom = Deno.env.get('DEEPGRAM_TTS_MODEL');
  if (custom) return custom;
  return 'aura-asteria-en';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const widgetKey = body.widget_key;
    if (!widgetKey || typeof widgetKey !== 'string') return json({ error: 'widget_key required' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const keyHash = await sha256Hex(widgetKey.trim());
    const { data: keyRow } = await admin.from('widget_keys').select('id, tenant_id').eq('key_hash', keyHash).eq('active', true).maybeSingle();
    if (!keyRow) return json({ error: 'invalid_widget_key' }, 401);

    const providerKey = await getAIKey(admin, 'DEEPGRAM_API_KEY');
    const action = body.action ?? 'config';

    if (action === 'config') {
      return json({ stt: !!providerKey, tts: !!providerKey, provider: providerKey ? 'deepgram' : null });
    }
    if (!providerKey) return json({ error: 'voice_not_configured' });

    // Throttle the spend paths (stt/tts) per widget key.
    // In-memory = free first line; durable DB counter is authoritative
    // (mig 198), with a tighter per-IP bucket for single-source floods.
    if (rateLimited(keyRow.id)) return json({ error: 'rate_limited' }, 429);
    if (await durableRateLimited(admin, `voice:${keyRow.id}`, RATE_LIMIT_PER_MIN)) {
      return json({ error: 'rate_limited' }, 429);
    }
    const ip = clientIp(req);
    if (ip && (await durableRateLimited(admin, `voice:${keyRow.id}:${ip}`, 20))) {
      return json({ error: 'rate_limited' }, 429);
    }

    if (action === 'stt') {
      const audioB64 = typeof body.audio === 'string' ? body.audio : '';
      if (!audioB64) return json({ error: 'audio required' }, 400);
      if (audioB64.length > MAX_AUDIO_B64_CHARS) return json({ error: 'audio_too_large' }, 413);
      const mime = typeof body.mime === 'string' ? body.mime : 'audio/webm';
      const res = await fetch('https://api.deepgram.com/v1/listen?smart_format=true&detect_language=true', {
        method: 'POST',
        headers: { Authorization: `Token ${providerKey}`, 'Content-Type': mime },
        body: b64ToBytes(audioB64),
      });
      if (!res.ok) return json({ error: 'stt_failed', status: res.status }, 502);
      const d = await res.json();
      const text = String(d?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
      return json({ text });
    }

    if (action === 'tts') {
      const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
      if (!text) return json({ error: 'text required' }, 400);
      const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(ttsModel(body.lang))}`, {
        method: 'POST',
        headers: { Authorization: `Token ${providerKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return json({ error: 'tts_failed', status: res.status }, 502);
      const buf = new Uint8Array(await res.arrayBuffer());
      return json({ audio: bytesToB64(buf), mime: res.headers.get('content-type') || 'audio/mpeg' });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (err) {
    console.error('voice-relay error:', err);
    return json({ error: String(err) }, 500);
  }
});
