#!/usr/bin/env node

/**
 * Apply Supabase migration 20260720_reply_mode_system.sql
 * Usage: node apply-migration.js
 *
 * Requires environment variables:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

const fs = require('fs');
const path = require('path');

// Import Supabase client
const { createClient } = require('@supabase/supabase-js');

async function applyMigration() {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://rfsvmhcqeiyrxivbmpel.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    console.error('❌ ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable not set');
    console.error('');
    console.error('To apply the migration, please set:');
    console.error('  export SUPABASE_SERVICE_ROLE_KEY=your_service_role_key');
    console.error('  node apply-migration.js');
    process.exit(1);
  }

  console.log('🔧 Connecting to Supabase...');
  console.log(`   URL: ${supabaseUrl}`);

  // Create admin client with service role key
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    // Read migration file
    const migrationPath = path.join(__dirname, 'supabase/migrations/20260720_reply_mode_system.sql');
    console.log(`📖 Reading migration: ${migrationPath}`);

    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationPath}`);
    }

    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');
    console.log(`✓ Migration file loaded (${migrationSQL.length} bytes)`);

    // Split by statements, filter comments and empty lines
    const statements = migrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--') && stmt.length > 0);

    console.log(`\n📊 Found ${statements.length} SQL statements to execute`);
    console.log('');

    // Execute each statement
    let executedCount = 0;
    for (const statement of statements) {
      try {
        console.log(`  [${executedCount + 1}/${statements.length}] Executing SQL statement...`);

        // Execute raw SQL using rpc call to a custom function
        // Since we don't have direct SQL execution, we'll use the REST API
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/sql_exec`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
            'apikey': serviceRoleKey,
          },
          body: JSON.stringify({ sql: statement + ';' }),
        });

        if (!response.ok) {
          // Fallback: try direct SQL execution via Postgres
          const { data, error } = await admin.rpc('sql_exec', {
            sql: statement + ';',
          });

          if (error) throw error;
          console.log(`    ✓ Executed`);
        } else {
          console.log(`    ✓ Executed`);
        }

        executedCount++;
      } catch (err) {
        console.error(`\n❌ ERROR executing statement ${executedCount + 1}:`);
        console.error(`   ${err.message}`);
        console.error(`   SQL: ${statement.substring(0, 100)}...`);
        throw err;
      }
    }

    console.log(`\n✅ SUCCESS! Applied ${executedCount} SQL statements`);
    console.log('');
    console.log('Migration 20260720_reply_mode_system.sql applied successfully!');
    console.log('');
    console.log('Created:');
    console.log('  ✓ draft_responses table (reply-mode drafts)');
    console.log('  ✓ embed_tokens table (iframe auth)');
    console.log('  ✓ config_schema_templates table (support template)');
    console.log('  ✓ 8 RPC functions (backend layer)');
    console.log('  ✓ RLS policies (tenant isolation)');
    console.log('  ✓ Support template schema');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Deploy edge function: supabase functions deploy de-answer');
    console.log('  2. Deploy frontend: git push origin main (Vercel auto-deploys)');
    console.log('  3. Run integration tests');
    console.log('  4. Monitor Sentry for errors');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ MIGRATION FAILED');
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

applyMigration();
