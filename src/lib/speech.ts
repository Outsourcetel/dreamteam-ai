// Thin speech abstraction. Phase 1 ships the FREE browser Web Speech API.
// A premium provider (Deepgram/ElevenLabs) implements this same interface
// later — the ChatCore never talks to a vendor directly, only to this.
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
