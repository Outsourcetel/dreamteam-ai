export type ModelProvider = 'anthropic' | 'openai' | 'google';
export type ModelTier = 'economy' | 'balanced' | 'premium' | 'reasoning';

export interface ModelDef {
  provider: ModelProvider;
  id: string;
  name: string;
  tier: ModelTier;
  inputCostPer1M: number;   // USD per 1M input tokens
  outputCostPer1M: number;  // USD per 1M output tokens
  contextK: number;         // context window in thousands of tokens
  badge: string;            // short selling point
  recommended?: boolean;
}

export const MODELS: ModelDef[] = [
  // ── Anthropic ───────────────────────────────────────────────────
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    tier: 'economy',
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00,
    contextK: 200,
    badge: 'Fastest · Best for high-volume',
    recommended: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    tier: 'balanced',
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00,
    contextK: 200,
    badge: 'Best balance of quality + speed',
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    tier: 'premium',
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00,
    contextK: 200,
    badge: 'Highest capability · Complex tasks',
  },

  // ── OpenAI ──────────────────────────────────────────────────────
  {
    provider: 'openai',
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    tier: 'economy',
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60,
    contextK: 128,
    badge: 'Cheapest OpenAI model',
    recommended: true,
  },
  {
    provider: 'openai',
    id: 'gpt-4o',
    name: 'GPT-4o',
    tier: 'balanced',
    inputCostPer1M: 2.50,
    outputCostPer1M: 10.00,
    contextK: 128,
    badge: 'Most popular · Strong reasoning',
  },
  {
    provider: 'openai',
    id: 'o1-mini',
    name: 'o1 Mini',
    tier: 'reasoning',
    inputCostPer1M: 3.00,
    outputCostPer1M: 12.00,
    contextK: 128,
    badge: 'Step-by-step reasoning',
  },

  // ── Google ──────────────────────────────────────────────────────
  {
    provider: 'google',
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    tier: 'economy',
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30,
    contextK: 1000,
    badge: 'Cheapest of all · 1M context',
    recommended: true,
  },
  {
    provider: 'google',
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    tier: 'economy',
    inputCostPer1M: 0.10,
    outputCostPer1M: 0.40,
    contextK: 1000,
    badge: 'Latest fast model · 1M context',
  },
  {
    provider: 'google',
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    tier: 'balanced',
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.00,
    contextK: 2000,
    badge: 'Best long-doc reasoning · 2M context',
  },
];

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

export const TIER_COLORS: Record<ModelTier, string> = {
  economy: 'text-emerald-400 bg-emerald-400/10',
  balanced: 'text-blue-400 bg-blue-400/10',
  premium: 'text-purple-400 bg-purple-400/10',
  reasoning: 'text-amber-400 bg-amber-400/10',
};

export function getModel(id: string): ModelDef | undefined {
  return MODELS.find(m => m.id === id);
}

export const DEFAULT_MODEL_ID = 'claude-haiku-4-5-20251001';
export const DEFAULT_PROVIDER: ModelProvider = 'anthropic';

// ── Task types — each maps to the best-suited model ───────────────────────────
export interface TaskTypeDef {
  id: string;
  label: string;
  description: string;
  bestProvider: ModelProvider;
  bestModelId: string;
  escalationModelId: string;  // upgrade to this model if primary is not confident
  icon: string;
}

export const TASK_TYPES: TaskTypeDef[] = [
  {
    id: 'chat',
    label: 'Chat & Q&A',
    description: 'Fast conversational responses from knowledge base',
    bestProvider: 'anthropic',
    bestModelId: 'claude-haiku-4-5-20251001',
    escalationModelId: 'claude-sonnet-5',
    icon: '💬',
  },
  {
    id: 'summarisation',
    label: 'Summarisation',
    description: 'Summarise long documents — uses Gemini 1M+ context window',
    bestProvider: 'google',
    bestModelId: 'gemini-1.5-pro',
    escalationModelId: 'claude-sonnet-5',
    icon: '📄',
  },
  {
    id: 'compliance',
    label: 'Compliance & Legal',
    description: 'Precise, careful checks — uses most capable model to minimise errors',
    bestProvider: 'anthropic',
    bestModelId: 'claude-opus-4-8',
    escalationModelId: 'claude-opus-4-8',
    icon: '⚖️',
  },
  {
    id: 'reasoning',
    label: 'Complex Reasoning',
    description: 'Multi-step analysis, synthesis across sources',
    bestProvider: 'anthropic',
    bestModelId: 'claude-sonnet-5',
    escalationModelId: 'claude-opus-4-8',
    icon: '🧠',
  },
  {
    id: 'data_analysis',
    label: 'Data & Finance',
    description: 'Structured data, numbers, spreadsheet-style tasks',
    bestProvider: 'openai',
    bestModelId: 'gpt-4o',
    escalationModelId: 'claude-sonnet-5',
    icon: '📊',
  },
  {
    id: 'drafting',
    label: 'Content Drafting',
    description: 'Emails, proposals, reports — quality writing',
    bestProvider: 'anthropic',
    bestModelId: 'claude-sonnet-5',
    escalationModelId: 'claude-opus-4-8',
    icon: '✍️',
  },
  {
    id: 'classification',
    label: 'Classification & Tagging',
    description: 'Routing, labelling, intent detection — minimal cost',
    bestProvider: 'google',
    bestModelId: 'gemini-1.5-flash',
    escalationModelId: 'claude-haiku-4-5-20251001',
    icon: '🏷️',
  },
];
