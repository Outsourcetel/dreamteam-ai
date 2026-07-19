/**
 * provision-workforce-assistants — job-only endpoint that provisions the
 * Workforce Assistant DE to every active tenant.
 *
 * Auth: service/dispatch callers ONLY. Requires either the dispatch
 * secret (x-dispatch-secret) or the service-role key as the bearer.
 * Rejects before any privileged read — a browser JWT is never enough to
 * trigger tenant-wide provisioning. Responses carry counts + tenant ids
 * only (no tenant names) to avoid leaking directory metadata.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secureEqual } from "../_shared/secureCompare.ts";

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Auth FIRST, before any privileged client work ──
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const dispatchSecret = Deno.env.get("PLAYBOOK_DISPATCH_SECRET") ?? "";
  const headerSecret = req.headers.get("x-dispatch-secret") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");

  const isDispatch = dispatchSecret !== "" && (await secureEqual(headerSecret, dispatchSecret));
  const isServiceRole = serviceKey !== "" && (await secureEqual(bearer, serviceKey));
  if (!isDispatch && !isServiceRole) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey);

  try {
    const { data: tenants, error: tenantsError } = await supabase
      .from("tenants")
      .select("id")
      .eq("status", "active");

    if (tenantsError || !tenants) {
      throw new Error(`Failed to fetch tenants: ${tenantsError?.message}`);
    }

    const results: Array<{ tenant_id: string; status: string; de_id?: string; error?: string }> = [];

    for (const tenant of tenants) {
      try {
        const { data: existing } = await supabase
          .from("digital_employees")
          .select("id")
          .eq("tenant_id", tenant.id)
          .eq("is_workforce_assistant", true)
          .maybeSingle();

        if (existing) {
          results.push({ tenant_id: tenant.id, status: "skipped" });
          continue;
        }

        const { data: result, error: rpcError } = await supabase.rpc(
          "create_workforce_assistant_de",
          { p_tenant_id: tenant.id },
        );

        if (rpcError) throw new Error(rpcError.message);
        if (result?.success) {
          results.push({ tenant_id: tenant.id, status: "success", de_id: result.de_id });
        } else {
          throw new Error(result?.error || "unknown_error");
        }
      } catch (error) {
        results.push({
          tenant_id: tenant.id,
          status: "failed",
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    const summary = {
      total_tenants: tenants.length,
      provisioned: results.filter((r) => r.status === "success").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      details: results,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("provision-workforce-assistants error:", error instanceof Error ? error.message : "error");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
