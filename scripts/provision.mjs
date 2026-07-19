#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_ANON_KEY not set');
  console.error('Set them in .env.local or .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function provisionWorkforceAssistants() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('PROVISIONING WORKFORCE ASSISTANTS TO ALL TENANTS');
  console.log('════════════════════════════════════════════════════════════════\n');

  try {
    // Get all active tenants
    const { data: tenants, error: tenantsError } = await supabase
      .from('tenants')
      .select('id, name')
      .eq('status', 'active')
      .order('created_at', { ascending: true });

    if (tenantsError) {
      console.error('❌ Failed to fetch tenants:', tenantsError.message);
      process.exit(1);
    }

    console.log(`Found ${tenants.length} active tenants\n`);

    let provisioned = 0;
    let skipped = 0;
    let failed = 0;

    for (const tenant of tenants) {
      process.stdout.write(`Processing ${tenant.name}... `);

      // Check if already provisioned
      const { data: existing, error: checkError } = await supabase
        .from('digital_employees')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('is_workforce_assistant', true)
        .maybeSingle();

      if (checkError) {
        console.log(`❌ FAILED (check error)`);
        failed++;
        continue;
      }

      if (existing) {
        console.log(`⊘ SKIPPED (already exists)`);
        skipped++;
        continue;
      }

      // Create Workforce Assistant
      const { data: deData, error: deError } = await supabase
        .from('digital_employees')
        .insert([{
          tenant_id: tenant.id,
          name: 'Workforce Assistant',
          status: 'active',
          charter: {
            name: 'Workforce Assistant',
            persona: 'You are a trusted advisor helping this organization hire, improve, and manage their digital workforce. You are an expert on the DreamTeamAI platform.',
            responsibilities: [
              'Help hire new DEs by understanding role requirements',
              'Suggest improvements to underperforming DEs based on metrics',
              'Monitor team performance and provide insights',
              'Help retire DEs and transition knowledge',
              'Train new tenants on DreamTeamAI features'
            ],
            guardrails: [
              'Never auto-approve DE changes without explicit user consent',
              'Always show evidence for recommendations',
              'Prioritize user success over automation',
              'Escalate ambiguous decisions to the tenant admin'
            ]
          },
          is_workforce_assistant: true,
          is_product_expert: true,
          description: 'Conversational workforce management assistant'
        }])
        .select('id');

      if (deError) {
        console.log(`❌ FAILED (${deError.message})`);
        failed++;
        continue;
      }

      // Create deployment stage
      const deId = deData[0].id;
      const { error: stageError } = await supabase
        .from('de_deployment_stages')
        .insert([{
          de_id: deId,
          stage: 'live'
        }]);

      if (stageError) {
        console.log(`⚠️  CREATED but stage failed (${stageError.message})`);
        provisioned++;
        continue;
      }

      console.log(`✓ PROVISIONED`);
      provisioned++;
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('PROVISIONING COMPLETE');
    console.log('════════════════════════════════════════════════════════════════');
    console.log(`Total Provisioned: ${provisioned}`);
    console.log(`Total Skipped: ${skipped}`);
    console.log(`Total Failed: ${failed}`);
    console.log(`\n✅ All Workforce Assistants are live at /workforce/chat`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  }
}

provisionWorkforceAssistants();
