import { supabase } from '../supabase';

export interface DEExecuteResult {
  response: string;
  confidence: number;
  threshold: number;
  status: 'answered' | 'escalated';
  sources: { title: string; similarity: number }[];
  chunks_found: number;
  search_mode: 'semantic' | 'fulltext';
  de_name: string;
  error?: string;
}

export async function executeDE(params: {
  tenantId: string;
  deId?: string;
  message: string;
  conversationId?: string;
}): Promise<DEExecuteResult> {
  const { data, error } = await supabase.functions.invoke('de-execute', {
    body: {
      tenant_id: params.tenantId,
      de_id: params.deId ?? null,
      message: params.message,
      conversation_id: params.conversationId ?? null,
    },
  });

  if (error) {
    return {
      response: '',
      confidence: 0,
      threshold: 75,
      status: 'escalated',
      sources: [],
      chunks_found: 0,
      search_mode: 'fulltext',
      de_name: 'Digital Employee',
      error: error.message,
    };
  }

  return data as DEExecuteResult;
}
