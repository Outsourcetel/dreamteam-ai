// DreamTeam Browser Operator — runtime worker entrypoint.
// Loop: register as an active runtime → heartbeat → poll for APPROVED browser
// tasks → claim (the mig-182 atomic gate) → drive Chrome via Steel+Playwright
// under governance → write the step audit → finish. Self-hosted; the governed
// alternative to ungoverned agents (Manus): every action is allowlisted,
// human-approved, step-bounded, credential-safe, and fully recorded.
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright-core';
import { Db, type BrowserTask, type AuditStep } from './db.js';
import { Steel } from './steel.js';
import { runTask, type CredentialHook } from './agent.js';

const env = (k: string, d = ''): string => process.env[k] ?? d;
const num = (k: string, d: number): number => Number(process.env[k]) || d;

async function main() {
  const url = env('SUPABASE_URL'); const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const model = env('ANTHROPIC_MODEL', 'claude-sonnet-5');
  const steelBase = env('STEEL_BASE_URL', 'http://localhost:3000'); const steelKey = env('STEEL_API_KEY');
  const runtimeName = env('RUNTIME_NAME', 'browser-operator-1');
  if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

  const db = new Db(url, key);

  // Anthropic key: env wins; else the platform vault (mig 087) — the SAME key
  // the edge functions use, so the worker needs only the service-role secret.
  let anthropicKey = env('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    anthropicKey = (await db.platformConfig('ANTHROPIC_API_KEY')) ?? '';
    if (anthropicKey) console.log('[browser-operator] ANTHROPIC_API_KEY resolved from platform vault');
  }
  if (!anthropicKey) { console.error('No ANTHROPIC_API_KEY in env or platform vault (platform_config)'); process.exit(1); }
  const steel = new Steel(steelBase, steelKey);
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // Vault login for the 'vault_injected' policy — the mig-243 get_browser_login
  // resolves the connector's stored UI login for the domain. Model-blind.
  const credentials: CredentialHook = { get: (tenantId, domain) => db.browserLogin(tenantId, domain) };

  const runtimeId = await db.registerRuntime(runtimeName, steelBase);
  console.log(`[browser-operator] registered runtime ${runtimeId} (${runtimeName}) → Steel ${steelBase}`);

  // Heartbeat so the mig-241 reaper keeps this runtime "active".
  setInterval(() => { db.heartbeat(runtimeId).catch((e) => console.error('heartbeat:', e.message)); }, num('HEARTBEAT_INTERVAL_MS', 45000));

  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try {
      const task = await db.nextApprovedTask();
      if (task && await db.claim(task.id, runtimeId)) { await execute(db, steel, anthropic, model, credentials, task); }
    } catch (e) { console.error('tick:', (e as Error).message); }
    finally { running = false; }
  };
  setInterval(tick, num('POLL_INTERVAL_MS', 5000));
  console.log('[browser-operator] polling for approved tasks…');
}

async function execute(db: Db, steel: Steel, anthropic: Anthropic, model: string, credentials: CredentialHook, task: BrowserTask) {
  console.log(`[browser-operator] running task ${task.id}: ${task.goal.slice(0, 80)}`);
  let sessionId = ''; let stepNo = 0;
  const onStep = async (s: Omit<AuditStep, 'step' | 'at'>) => {
    stepNo += 1;
    await db.appendStep(task.id, { ...s, step: stepNo, at: new Date().toISOString() }).catch((e) => console.error('appendStep:', e.message));
  };
  try {
    const session = await steel.createSession(); sessionId = session.id;
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    const out = await runTask(page, task, { anthropic, model, credentials, liveViewUrl: steel.liveViewUrl(sessionId), onStep });
    await browser.close().catch(() => {});
    await db.finish(task.id, out.status, out.result);
    console.log(`[browser-operator] task ${task.id} → ${out.status}`);
  } catch (e) {
    console.error(`[browser-operator] task ${task.id} failed:`, (e as Error).message);
    await db.finish(task.id, 'failed', `Runtime error: ${(e as Error).message}`.slice(0, 8000)).catch(() => {});
  } finally {
    if (sessionId) await steel.release(sessionId);
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
