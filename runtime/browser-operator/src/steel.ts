// Steel (self-hosted) session lifecycle. Steel gives each task its own isolated
// Chrome; we connect Playwright to it over CDP. Docs: https://docs.steel.dev —
// the REST shape below matches Steel's /v1/sessions. Swap for the official
// `steel-sdk` if you prefer; kept as fetch to stay dependency-light.
export interface SteelSession {
  id: string;
  connectUrl: string; // CDP websocket URL for Playwright connectOverCDP
}

export class Steel {
  constructor(private baseUrl: string, private apiKey: string) {}

  private headers() {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['steel-api-key'] = this.apiKey;
    return h;
  }

  /** Create an isolated browser session. `isolated` = fresh profile, no shared
   * cookies/logins (the safety posture Anthropic's own in-app browser uses). */
  async createSession(): Promise<SteelSession> {
    const res = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ isolated: true, blockAds: true }),
    });
    if (!res.ok) throw new Error(`steel createSession ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const s = await res.json() as { id: string; websocketUrl?: string; connectUrl?: string; wsUrl?: string };
    const connectUrl = s.websocketUrl || s.connectUrl || s.wsUrl || '';
    if (!connectUrl) throw new Error('steel createSession: no CDP connect url in response');
    return { id: s.id, connectUrl };
  }

  /** A human-viewable live URL (for the human_login credential policy). */
  liveViewUrl(sessionId: string): string {
    return `${this.baseUrl}/v1/sessions/${sessionId}/live`;
  }

  async release(sessionId: string): Promise<void> {
    try { await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/release`, { method: 'POST', headers: this.headers() }); }
    catch { /* best-effort teardown */ }
  }
}
