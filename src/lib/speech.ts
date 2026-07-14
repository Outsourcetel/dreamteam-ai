// Thin speech abstraction. Free browser Web Speech API by default; a premium
// provider (via the voice-relay edge function) upgrades it when a key is
// configured — the ChatCore never talks to a vendor directly, only to this.
import { SUPABASE_URL } from './env';

const RELAY = `${SUPABASE_URL}/functions/v1/voice-relay`;

export interface SpeechProvider {
  readonly sttSupported: boolean;
  readonly ttsSupported: boolean;
  /** Start listening. Returns a stop() function. */
  startListening(onResult: (text: string) => void, onEnd: () => void, lang?: string): () => void;
  speak(text: string, lang?: string): void;
  stopSpeaking(): void;
}

// Map a DE-reported language name to a BCP-47 tag for the browser APIs.
function langTag(name?: string | null): string | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  const map: Record<string, string> = {
    english: 'en-US', spanish: 'es-ES', french: 'fr-FR', german: 'de-DE',
    italian: 'it-IT', portuguese: 'pt-PT', dutch: 'nl-NL', japanese: 'ja-JP',
    chinese: 'zh-CN', korean: 'ko-KR', arabic: 'ar-SA', hindi: 'hi-IN', russian: 'ru-RU',
  };
  for (const k of Object.keys(map)) if (n.includes(k)) return map[k];
  return undefined;
}

class BrowserSpeechProvider implements SpeechProvider {
  // deno-lint-ignore no-explicit-any
  private Recognition: any;
  private synth: SpeechSynthesis | null;

  constructor() {
    // deno-lint-ignore no-explicit-any
    const w = (typeof window !== 'undefined' ? window : {}) as any;
    this.Recognition = w.SpeechRecognition || w.webkitSpeechRecognition || null;
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  }

  get sttSupported(): boolean { return !!this.Recognition; }
  get ttsSupported(): boolean { return !!this.synth; }

  startListening(onResult: (text: string) => void, onEnd: () => void, lang?: string): () => void {
    if (!this.Recognition) { onEnd(); return () => {}; }
    const rec = new this.Recognition();
    rec.lang = langTag(lang) || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    // deno-lint-ignore no-explicit-any
    rec.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript ?? '';
      if (text) onResult(text);
    };
    rec.onerror = () => onEnd();
    rec.onend = () => onEnd();
    try { rec.start(); } catch { onEnd(); }
    return () => { try { rec.stop(); } catch { /* noop */ } };
  }

  speak(text: string, lang?: string): void {
    if (!this.synth || !text) return;
    try {
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const tag = langTag(lang);
      if (tag) u.lang = tag;
      u.rate = 1.02;
      this.synth.speak(u);
    } catch { /* noop */ }
  }

  stopSpeaking(): void { try { this.synth?.cancel(); } catch { /* noop */ } }
}

export const speechProvider: SpeechProvider = new BrowserSpeechProvider();

// ── Premium provider (Phase 3): routes STT/TTS through the voice-relay,
// which holds the vendor key server-side. Dormant until a key is set —
// resolveSpeechProvider() only returns this when the relay reports it's on.
async function relay(widgetKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(RELAY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widget_key: widgetKey, ...payload }),
  });
  return await res.json().catch(() => ({}));
}
function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
}

class PremiumSpeechProvider implements SpeechProvider {
  readonly sttSupported: boolean;
  readonly ttsSupported = true;
  private key: string;
  private audio: HTMLAudioElement | null = null;
  constructor(widgetKey: string) {
    this.key = widgetKey;
    this.sttSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined';
  }
  startListening(onResult: (text: string) => void, onEnd: () => void): () => void {
    if (!this.sttSupported) { onEnd(); return () => {}; }
    let stopped = false;
    // deno-lint-ignore no-explicit-any
    let recorder: any = null;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      const chunks: Blob[] = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        try {
          const r = await relay(this.key, { action: 'stt', audio: await blobToB64(blob), mime: blob.type });
          if (typeof r.text === 'string' && r.text.trim()) onResult(r.text.trim());
        } catch { /* noop */ }
        onEnd();
      };
      recorder.start();
    }).catch(() => onEnd());
    return () => { stopped = true; try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* noop */ } };
  }
  speak(text: string, lang?: string): void {
    relay(this.key, { action: 'tts', text, lang }).then((r) => {
      if (typeof r.audio === 'string') {
        this.audio = new Audio(`data:${(r.mime as string) || 'audio/mpeg'};base64,${r.audio}`);
        this.audio.play().catch(() => { /* autoplay may be blocked */ });
      }
    }).catch(() => { /* noop */ });
  }
  stopSpeaking(): void { try { this.audio?.pause(); } catch { /* noop */ } }
}

// Pick the best available voice: premium if the relay reports it's configured
// (and this browser can record), else the free browser provider.
export async function resolveSpeechProvider(widgetKey: string): Promise<SpeechProvider> {
  try {
    const cfg = await relay(widgetKey, { action: 'config' });
    const premium = new PremiumSpeechProvider(widgetKey);
    if (cfg.stt === true && cfg.tts === true && premium.sttSupported) return premium;
  } catch { /* fall through */ }
  return speechProvider;
}
