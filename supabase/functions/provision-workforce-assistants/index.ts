import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseServiceKey);

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    console.log("Starting Workforce Assistant provisioning...");

    // Get all active tenants
    const { data: tenants, error: tenantsError } = await supabase
      .from("tenants")
      .select("id, name, slug")
      .eq("status", "active");

    if (tenantsError || !tenants) {
      throw new Error(`Failed to fetch tenants: ${tenantsError?.message}`);
    }

    console.log(`Found ${tenants.length} active tenants`);

    const results = [];

    // Provision Workforce Assistant to each tenant
    for (const tenant of tenants) {
      try {
        console.log(`Provisioning Workforce Assistant for tenant: ${tenant.name} (${tenant.id})`);

        // Check if already provisioned
        const { data: existing } = await supabase
          .from("digital_employees")
          .select("id")
          .eq("tenant_id", tenant.id)
          .eq("is_workforce_assistant", true)
          .single();

        if (existing) {
          console.log(`Workforce Assistant already exists for ${tenant.name}`);
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            status: "skipped",
            reason: "Already provisioned",
          });
          continue;
        }

        // Call RPC to create Workforce Assistant (using service role)
        const { data: result, error: rpcError } = await supabase.rpc(
          "create_workforce_assistant_de",
          { p_tenant_id: tenant.id }
        );

        if (rpcError) {
          throw new Error(`RPC failed: ${rpcError.message}`);
        }

        if (result.success) {
          console.log(`✓ Workforce Assistant provisioned for ${tenant.name}`);
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            status: "success",
            de_id: result.de_id,
          });
        } else {
          throw new Error(result.error || "Unknown error");
        }
      } catch (error) {
        console.error(`✗ Failed to provision for ${tenant.name}:`, error);
        results.push({
          tenant_id: tenant.id,
          tenant_name: tenant.name,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Summary
    const summary = {
      total_tenants: tenants.length,
      provisioned: results.filter((r) => r.status === "success").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      details: results,
      timestamp: new Date().toISOString(),
    };

    console.log("Provisioning complete:", JSON.stringify(summary, null, 2));

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Provisioning error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
