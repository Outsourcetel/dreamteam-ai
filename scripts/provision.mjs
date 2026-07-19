#!/usr/bin/env node

/**
 * PROVISION WORKFORCE ASSISTANTS TO ALL TENANTS — ONE COMMAND
 * Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/provision.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  console.error("❌ ERROR: SUPABASE_ANON_KEY environment variable not set");
  console.error("");
  console.error("USAGE:");
  console.error("  export SUPABASE_URL='https://your-project.supabase.co'");
  console.error("  export SUPABASE_ANON_KEY='your-supabase-anon-key'");
  console.error("  node scripts/provision.mjs");
  console.error("");
  process.exit(1);
}

console.log("════════════════════════════════════════════════════════════════");
console.log("PROVISIONING WORKFORCE ASSISTANTS TO ALL TENANTS");
console.log("════════════════════════════════════════════════════════════════");
console.log("");
console.log(`Endpoint: ${SUPABASE_URL}/functions/v1/provision-workforce-assistants`);
console.log("");

(async () => {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/provision-workforce-assistants`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ PROVISIONING FAILED");
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify(result, null, 2));

    console.log("");
    console.log("════════════════════════════════════════════════════════════════");
    console.log("PROVISIONING COMPLETE ✅");
    console.log("════════════════════════════════════════════════════════════════");
    console.log("");
    console.log(`Provisioned: ${result.provisioned}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Failed: ${result.failed}`);
    console.log("");
    console.log("✅ All tenants now have Workforce Assistants provisioned");
    console.log("✅ Ready at /workforce/chat on every tenant");
    console.log("");
  } catch (error) {
    console.error("❌ ERROR:", error.message);
    process.exit(1);
  }
})();
