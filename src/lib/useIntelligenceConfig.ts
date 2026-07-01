import { useState, useEffect, useCallback } from 'react';

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'azure' | 'aws';
export type EmbeddingProvider = 'supabase' | 'openai' | 'cohere';

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
}

export interface IntelligenceConfig {
  provider: ModelProvider;
  modelId: string;
  temperature: number;
  maxTokens: number;
  fallbackProvider?: ModelProvider;
  fallbackModelId?: string;
  embeddingProvider: EmbeddingProvider;
  embeddingModelId: string;
  confidenceThreshold: number;
  safetyLevel: 'strict' | 'balanced' | 'permissive';
  byokEnabled: boolean;
  apiKeyConfigured: boolean;
}

export const PROVIDER_MODELS: Record<ModelProvider, ProviderModel[]> = {
  anthropic: [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200000, costPer1kInput: 3.0, costPer1kOutput: 15.0, supportsVision: true, supportsFunctionCalling: true },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000, costPer1kInput: 0.8, costPer1kOutput: 4.0, supportsVision: true, supportsFunctionCalling: true },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 200000, costPer1kInput: 15.0, costPer1kOutput: 75.0, supportsVision: true, supportsFunctionCalling: true },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, costPer1kInput: 2.5, costPer1kOutput: 10.0, supportsVision: true, supportsFunctionCalling: true },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, costPer1kInput: 0.15, costPer1kOutput: 0.6, supportsVision: true, supportsFunctionCalling: true },
    { id: 'o3-mini', name: 'o3-mini', contextWindow: 200000, costPer1kInput: 1.1, costPer1kOutput: 4.4, supportsVision: false, supportsFunctionCalling: true },
  ],
  google: [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1000000, costPer1kInput: 0.1, costPer1kOutput: 0.4, supportsVision: true, supportsFunctionCalling: true },
    { id: 'gemini-2.0-pro', name: 'Gemini 2.0 Pro', contextWindow: 2000000, costPer1kInput: 1.25, costPer1kOutput: 5.0, supportsVision: true, supportsFunctionCalling: true },
  ],
  azure: [
    { id: 'azure-gpt-4o', name: 'Azure GPT-4o', contextWindow: 128000, costPer1kInput: 2.5, costPer1kOutput: 10.0, supportsVision: true, supportsFunctionCalling: true },
    { id: 'azure-gpt-4o-mini', name: 'Azure GPT-4o Mini', contextWindow: 128000, costPer1kInput: 0.15, costPer1kOutput: 0.6, supportsVision: true, supportsFunctionCalling: true },
  ],
  aws: [
    { id: 'amazon-nova-pro', name: 'Amazon Nova Pro', contextWindow: 300000, costPer1kInput: 0.8, costPer1kOutput: 3.2, supportsVision: true, supportsFunctionCalling: true },
    { id: 'amazon-nova-lite', name: 'Amazon Nova Lite', contextWindow: 300000, costPer1kInput: 0.06, costPer1kOutput: 0.24, supportsVision: true, supportsFunctionCalling: true },
  ],
};

export const EMBEDDING_MODELS: Record<EmbeddingProvider, { id: string; name: string; dims: number }[]> = {
  supabase: [{ id: 'gte-small', name: 'GTE Small (Supabase)', dims: 384 }],
  openai: [
    { id: 'text-embedding-3-small', name: 'text-embedding-3-small', dims: 1536 },
    { id: 'text-embedding-3-large', name: 'text-embedding-3-large', dims: 3072 },
  ],
  cohere: [{ id: 'embed-english-v3.0', name: 'embed-english-v3.0', dims: 1024 }],
};

const DEFAULT_CONFIG: IntelligenceConfig = {
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
  temperature: 0.3,
  maxTokens: 1024,
  fallbackProvider: 'anthropic',
  fallbackModelId: 'claude-haiku-4-5-20251001',
  embeddingProvider: 'supabase',
  embeddingModelId: 'gte-small',
  confidenceThreshold: 0.55,
  safetyLevel: 'balanced',
  byokEnabled: false,
  apiKeyConfigured: false,
};

const STORAGE_KEY = 'dt_intelligence_config';

function load(): IntelligenceConfig | null {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function save(s: IntelligenceConfig) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function useIntelligenceConfig() {
  const [config, setConfig] = useState<IntelligenceConfig>(() => load() ?? DEFAULT_CONFIG);

  useEffect(() => { save(config); }, [config]);

  const updateConfig = useCallback((updates: Partial<IntelligenceConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  }, []);

  const currentModel = PROVIDER_MODELS[config.provider]?.find(m => m.id === config.modelId);
  const fallbackModel = config.fallbackProvider
    ? PROVIDER_MODELS[config.fallbackProvider]?.find(m => m.id === config.fallbackModelId)
    : undefined;

  return { config, updateConfig, currentModel, fallbackModel };
}
