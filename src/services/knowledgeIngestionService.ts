import { supabase } from '../supabase';

export interface IngestResult {
  success: boolean;
  chunks_created: number;
  mode: 'embeddings' | 'text-only';
  error?: string;
}

export async function ingestArticle(params: {
  tenantId: string;
  content: string;
  title: string;
  articleId?: string;
  sourceType?: 'manual' | 'file' | 'url';
  sourceUrl?: string;
}): Promise<IngestResult> {
  const { data, error } = await supabase.functions.invoke('ingest-knowledge', {
    body: {
      tenant_id: params.tenantId,
      content: params.content,
      title: params.title,
      article_id: params.articleId ?? null,
      source_type: params.sourceType ?? 'manual',
      source_url: params.sourceUrl ?? null,
    },
  });

  if (error) {
    return { success: false, chunks_created: 0, mode: 'text-only', error: error.message };
  }
  return data as IngestResult;
}

export async function fetchChunkCount(tenantId: string): Promise<number> {
  const { count } = await supabase
    .from('knowledge_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  return count ?? 0;
}
