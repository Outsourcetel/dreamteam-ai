// OTel GenAI span emission (Frontier-20 #13, mig 177).
//
// One row per instrumented operation, attributes following the OpenTelemetry
// GenAI semantic conventions (gen_ai.operation.name, gen_ai.request.model,
// gen_ai.usage.input_tokens / output_tokens, …) plus dreamteam.* extras.
// BEST-EFFORT by contract: telemetry must never break the operation it
// observes — every failure is swallowed after a console.error.
//
// Export to a real collector is dormant until the platform_config key
// 'otel_collector_endpoint' is set; the otel-export fn ships rows then.
// deno-lint-ignore-file no-explicit-any

const hex = (bytes: number) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** New 32-hex OTLP trace id. */
export const newTraceId = () => hex(16);
/** New 16-hex OTLP span id. */
export const newSpanId = () => hex(8);

export interface SpanInput {
  tenant_id: string;
  name: string;                       // e.g. 'chat de-answer' | 'invoke_agent de-work'
  kind?: 'agent' | 'llm' | 'tool';
  trace_id?: string;                  // omit → new trace
  parent_span_id?: string | null;
  started_at: string;                 // ISO
  attributes?: Record<string, unknown>;
}

/** Write one span row (ended now). Never throws. Returns ids for children. */
export async function recordSpan(admin: any, span: SpanInput): Promise<{ trace_id: string; span_id: string }> {
  const trace_id = span.trace_id ?? newTraceId();
  const span_id = newSpanId();
  try {
    await admin.from('otel_spans').insert({
      tenant_id: span.tenant_id,
      trace_id, span_id,
      parent_span_id: span.parent_span_id ?? null,
      name: span.name,
      kind: span.kind ?? 'agent',
      started_at: span.started_at,
      ended_at: new Date().toISOString(),
      attributes: span.attributes ?? {},
    });
  } catch (e) {
    console.error('otel recordSpan:', e);
  }
  return { trace_id, span_id };
}
