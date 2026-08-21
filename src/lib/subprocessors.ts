/**
 * subprocessors — the ONE list of third parties this codebase can send
 * customer data to, and what puts each of them in the path.
 *
 * ── Why this file exists (register item A-8) ────────────────────────────
 * The privacy policy used to carry the list as prose, including two claims
 * about TODAY'S CONFIGURATION: "it is the only provider currently receiving
 * any customer content" and "none of the three is configured today". Both
 * were true when written. Neither is something a static page can keep true:
 * `supabase/functions/_shared/llm.ts` puts a provider in the failover chain
 * the moment its key resolves — Settings → AI Engine, a per-tenant
 * credential, or an edge-function env secret — with no deploy, no policy
 * change and no customer notice. The person pasting the key is not thinking
 * about the privacy policy, and nothing asked them to.
 *
 * A warning on the settings screen would be advice. This is a mechanism:
 * the disclosure is DERIVED from this list, this list is checked against
 * what the code can actually reach AND against what is actually configured
 * (certify › subprocessor-disclosure), and the check names any vendor that
 * appears in one and not the other.
 *
 * ── What belongs here ───────────────────────────────────────────────────
 * Every entry is a FACTUAL statement about this repository: which module
 * performs the egress, and which credential or configuration arms it. That
 * is engineering fact, verifiable from `anchor` and `armedBy`.
 *
 * ⛔ NOTHING HERE IS A LEGAL COMMITMENT. `purpose` describes what the code
 * sends; it does not characterise how a vendor handles it, whether a DPA is
 * in place, whether the vendor trains on the data, or where it is stored.
 * Those are the founder's and their counsel's to write — see
 * COUNSEL_PLACEHOLDER below and docs/62 §5.
 *
 * ── The limit of the mechanism, stated rather than hidden ───────────────
 * `aiKeys.ts` falls back to `Deno.env.get(name)`, so a provider can also be
 * armed by an edge-function secret that no database query can see. The
 * certify check says so in its own output and covers the two stores it CAN
 * see (`platform_config`, `tenant_llm_credentials`). The edge runtime is the
 * only thing that can see both, and it already reports:
 * `supabase/functions/ai-engine-status/index.ts` returns per-tier
 * `source: config | env | both | none`.
 */

/** What puts this vendor in the path of customer data. */
export type SubprocessorArming =
  /** In the path whenever the Service runs. No key, no toggle. */
  | 'always'
  /** Joins the moment a credential resolves — the A-8 mechanism. */
  | 'credential'
  /** Only when a customer connects it themselves, to their own account. */
  | 'customer-configured';

export interface Subprocessor {
  /** Stable id. Never reused, never renamed once published. */
  id: string;
  /** The vendor as it should be named in a disclosure. */
  vendor: string;
  /** What THIS CODEBASE sends them. Engineering fact, not a legal claim. */
  purpose: string;
  arming: SubprocessorArming;
  /**
   * Credential / configuration key names that arm this vendor, exactly as
   * `_shared/aiKeys.ts` resolves them. certify compares this against the
   * key names the code actually reads and against the keys actually set.
   */
  armedBy: string[];
  /** The module that performs the egress. certify does not follow it; a human does. */
  anchor: string;
  /**
   * Set only for tiers of the LLM failover chain, using the exact provider
   * token `_shared/llm.ts` pushes onto `available[]`. certify derives that
   * list from the source and compares both directions.
   */
  llmProvider?: 'anthropic' | 'bedrock' | 'openai' | 'google';
}

/**
 * Shown verbatim on the privacy policy. It is a marker, not prose to be
 * polished: the page must not read as though the legal questions are
 * answered when they are not.
 */
export const COUNSEL_PLACEHOLDER =
  'Placeholder for counsel: for each vendor below, confirm the data-processing '
  + 'terms, whether the vendor trains its own models on this data (opt out wherever '
  + 'the vendor allows it), the processing locations, and whether a DPA is in place. '
  + 'This table states which vendors the software can send data to and what puts them '
  + 'in that path — it does not yet state how any of them handles it.';

export const SUBPROCESSORS: Subprocessor[] = [
  // ── The LLM failover chain (supabase/functions/_shared/llm.ts) ─────────
  {
    id: 'anthropic',
    vendor: 'Anthropic (Claude)',
    purpose: 'Generates Digital Employee responses. Receives the prompt, the retrieved knowledge and the conversation turns sent with it.',
    arming: 'credential',
    armedBy: ['ANTHROPIC_API_KEY'],
    anchor: 'supabase/functions/_shared/llm.ts',
    llmProvider: 'anthropic',
  },
  {
    id: 'aws-bedrock',
    vendor: 'Amazon Web Services (Bedrock)',
    purpose: 'Second tier of the model failover chain — the same Claude models via AWS. Receives the same content as the primary when it is reached.',
    arming: 'credential',
    armedBy: ['BEDROCK_API_KEY'],
    anchor: 'supabase/functions/_shared/llm.ts',
    llmProvider: 'bedrock',
  },
  {
    id: 'openai',
    vendor: 'OpenAI',
    purpose: 'Cross-vendor failover tier. Receives the same content, translated to the OpenAI request shape, when it is reached.',
    arming: 'credential',
    armedBy: ['OPENAI_API_KEY'],
    anchor: 'supabase/functions/_shared/llm.ts',
    llmProvider: 'openai',
  },
  {
    id: 'google-gemini',
    vendor: 'Google (Gemini)',
    purpose: 'Cross-vendor failover tier. Receives the same content, translated to the Gemini request shape, when it is reached.',
    arming: 'credential',
    armedBy: ['GOOGLE_AI_KEY'],
    anchor: 'supabase/functions/_shared/llm.ts',
    llmProvider: 'google',
  },

  // ── Everything else that leaves, on the same paste-a-key mechanism ─────
  // Found while establishing A-8's ground truth: the disclosure was honest
  // about models and silent about these, which is the same defect one layer
  // over. Each is armed the same way — a key resolves, and it is in the path.
  {
    id: 'deepgram',
    vendor: 'Deepgram',
    purpose: 'Voice calls: speech-to-text on caller audio, and text-to-speech on the reply. Receives the audio and the spoken text.',
    arming: 'credential',
    armedBy: ['DEEPGRAM_API_KEY'],
    anchor: 'supabase/functions/voice-relay/index.ts',
  },
  {
    id: 'resend',
    vendor: 'Resend',
    purpose: 'Outbound email delivery, and receipt of inbound replies. Receives message bodies, subjects and addresses.',
    arming: 'credential',
    armedBy: ['RESEND_API_KEY', 'RESEND_INBOUND_SECRET'],
    anchor: 'supabase/functions/_shared/sendEmail.ts',
  },
  {
    id: 'google-workspace-smtp',
    vendor: 'Google (Gmail SMTP)',
    purpose: 'Alternative outbound email path, tried before Resend when its credentials resolve. Receives message bodies, subjects and addresses.',
    arming: 'credential',
    armedBy: ['GMAIL_SMTP_USER', 'GMAIL_SMTP_APP_PASSWORD'],
    anchor: 'supabase/functions/_shared/sendEmail.ts',
  },
  {
    id: 'render-fetch',
    vendor: 'Page-rendering service (operator-chosen; ScrapingBee is the documented example)',
    purpose: 'Fetches JavaScript-rendered web pages during knowledge ingestion. Receives the URL being ingested.',
    arming: 'credential',
    armedBy: ['RENDER_FETCH_URL', 'RENDER_FETCH_HEADER'],
    anchor: 'supabase/functions/_shared/browserFetch.ts',
  },
  {
    id: 'sentry',
    vendor: 'Sentry',
    purpose: 'Front-end crash reporting. Receives error messages and stack traces, which can carry whatever the failing screen held.',
    arming: 'credential',
    armedBy: ['VITE_SENTRY_DSN'],
    anchor: 'src/lib/sentry.ts',
  },

  // ── Always in the path ─────────────────────────────────────────────────
  {
    id: 'supabase',
    vendor: 'Supabase',
    purpose: 'Database, file storage, authentication, and the runtime that executes the Service\'s backend. Holds the data at rest, and computes the search embeddings in-runtime rather than sending them anywhere.',
    arming: 'always',
    armedBy: [],
    anchor: 'supabase/functions/_shared/knowledgeEmbed.ts',
  },
  {
    id: 'vercel',
    vendor: 'Vercel',
    purpose: 'Hosts and serves the web application.',
    arming: 'always',
    armedBy: [],
    anchor: 'vercel.json',
  },
  {
    id: 'web-push',
    vendor: 'Browser push services (Google, Apple, Mozilla — whichever the recipient\'s browser uses)',
    purpose: 'Delivers push notifications. Receives the encrypted notification payload and the browser-issued subscription endpoint.',
    arming: 'always',
    armedBy: [],
    anchor: 'supabase/functions/push-send/index.ts',
  },

  // ── Chosen by the customer, per workspace ──────────────────────────────
  {
    id: 'connectors',
    vendor: 'Business systems a workspace connects (the connector catalogue)',
    purpose: 'Reads from and writes to the systems a workspace connects, using credentials that workspace supplies. Which vendors these are is decided per workspace, not by us.',
    arming: 'customer-configured',
    armedBy: [],
    anchor: 'supabase/functions/connector-hub/index.ts',
  },
  {
    id: 'mcp-servers',
    vendor: 'MCP servers a workspace registers (any URL that workspace supplies)',
    purpose: 'Calls tools on a server whose address the workspace chooses. The destination is not fixed by this codebase.',
    arming: 'customer-configured',
    armedBy: [],
    anchor: 'supabase/functions/mcp-client/index.ts',
  },
];

/** Grouping used by the disclosure, in the order it should read. */
export const ARMING_GROUPS: { arming: SubprocessorArming; heading: string; note: string }[] = [
  {
    arming: 'always',
    heading: 'Always in the path',
    note: 'These operate the Service itself. There is no configuration in which they are absent.',
  },
  {
    arming: 'credential',
    heading: 'In the path once a credential is configured',
    note: 'Each of these joins the moment its key resolves — from workspace settings, from platform settings, or from a backend secret. No deploy and no change to this page is involved, which is exactly why this page is generated from the list the code is checked against rather than maintained by hand.',
  },
  {
    arming: 'customer-configured',
    heading: 'Chosen by your workspace',
    note: 'Destinations your own workspace selects and supplies credentials for. We do not choose these on your behalf.',
  },
];
