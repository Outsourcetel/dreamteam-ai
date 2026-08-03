/**
 * mcp-demo-server — a MINIMAL but REAL MCP server (Streamable HTTP, JSON-RPC
 * 2.0, protocol 2026-07-28) used to build + prove the governed-MCP-connector
 * feature (docs/mcp-governed-connector-design.md). NOT a mock: it speaks the
 * actual protocol our mcp-client speaks. Three tools, chosen to prove risk
 * derivation AND the fail-safe:
 *   - echo          → readOnlyHint:true   (should auto-execute under trust)
 *   - delete_widget → destructiveHint:true (should be human-gated)
 *   - poke          → NO annotations       (fail-safe ⇒ treated destructive)
 *
 * Deploy with --no-verify-jwt (it authenticates nothing; it's a demo target).
 * Public HTTPS URL passes the SSRF guard; add it to mcp_server_allowlist.
 *
 * ⚠ NOT DEPLOYED. Undeployed from production on 2026-08-04 along with its
 * connector and approvals (migration 548) — an unauthenticated public endpoint
 * has no business living in the production project once the proof is done.
 * The source is kept because it is the only MCP server we control, so it is
 * how the governed-MCP path gets re-tested. deploy.mjs only deploys functions
 * named with --fn, so it cannot come back by accident:
 *   node scripts/deploy.mjs --no-migrations --fn mcp-demo-server
 * If you redeploy it, remember to remove it again afterwards.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PROTOCOL_VERSION = '2026-07-28';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back a message. A safe, read-only demo tool.',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'Text to echo' } }, required: ['message'] },
    annotations: { title: 'Echo', readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'delete_widget',
    description: 'Delete a widget by id. A DESTRUCTIVE demo tool.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Widget id to delete' } }, required: ['id'] },
    annotations: { title: 'Delete widget', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'poke',
    description: 'Poke the server. Deliberately UN-annotated to exercise the fail-safe default.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    // no annotations on purpose
  },
];

function callTool(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
  if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${String(args.message ?? '')}` }] };
  if (name === 'delete_widget') return { content: [{ type: 'text', text: `Deleted widget "${String(args.id ?? '')}".` }] };
  if (name === 'poke') return { content: [{ type: 'text', text: `poked${args.note ? ` (${String(args.note)})` : ''}` }] };
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }] };
}

serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  return (async () => {
    let body: { jsonrpc?: string; id?: number | null; method?: string; params?: Record<string, unknown> } = {};
    try { body = await req.json(); } catch { /* notification bodies may be empty */ }
    const { id, method, params } = body;
    const headers = { ...CORS, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'demo-session' };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers });
    const rpcError = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers });

    // Notifications (id absent) — ack with 202, no body.
    if (id === undefined || id === null) return new Response(null, { status: 202, headers: CORS });

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'DreamTeam MCP Demo', version: '1.0.0' },
        });
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (!TOOLS.some((t) => t.name === name)) return rpcError(-32602, `unknown tool: ${name}`);
        return reply(callTool(name, args));
      }
      default:
        return rpcError(-32601, `method not found: ${method}`);
    }
  })();
});
