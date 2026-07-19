-- ════════════════════════════════════════════════════════════════════════════════════════
-- PROVISION WORKFORCE ASSISTANT DEs TO ALL ACTIVE TENANTS
-- ════════════════════════════════════════════════════════════════════════════════════════
-- This script provisions a Workforce Assistant DE to every active tenant
-- Idempotent: safe to run multiple times (skips if already provisioned)
-- ════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tenant_record RECORD;
  v_de_count INT;
  v_total_provisioned INT := 0;
  v_total_skipped INT := 0;
  v_total_failed INT := 0;
BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'STARTING WORKFORCE ASSISTANT PROVISIONING FOR ALL TENANTS';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Loop through all active tenants
  FOR v_tenant_record IN
    SELECT id, name, slug FROM tenants WHERE status = 'active' ORDER BY created_at ASC
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE 'Processing tenant: % (%)', v_tenant_record.name, v_tenant_record.id;

    -- Check if Workforce Assistant already exists for this tenant
    SELECT COUNT(*) INTO v_de_count
    FROM digital_employees
    WHERE tenant_id = v_tenant_record.id
      AND is_workforce_assistant = true;

    IF v_de_count > 0 THEN
      RAISE NOTICE '  ⊘ SKIPPED: Workforce Assistant already provisioned';
      v_total_skipped := v_total_skipped + 1;
    ELSE
      -- Create Workforce Assistant DE for this tenant
      BEGIN
        INSERT INTO digital_employees (
          tenant_id,
          name,
          status,
          charter,
          is_workforce_assistant,
          is_product_expert,
          created_by
        ) VALUES (
          v_tenant_record.id,
          'Workforce Assistant',
          'active',
          jsonb_build_object(
            'name', 'Workforce Assistant',
            'persona', 'You are a trusted advisor helping this organization hire, improve, and manage their digital workforce. You are an expert on the DreamTeamAI platform, including all features, patterns, and best practices.',
            'responsibilities', jsonb_build_array(
              'Help hire new DEs by understanding role requirements',
              'Suggest improvements to underperforming DEs based on metrics',
              'Monitor team performance and provide insights',
              'Help retire DEs and transition knowledge',
              'Train new tenants on DreamTeamAI features',
              'Recommend playbook patterns and guardrails'
            ),
            'guardrails', jsonb_build_array(
              'Never auto-approve DE changes without explicit user consent',
              'Always show evidence (CSAT, escalation, cost impact) for recommendations',
              'Prioritize user success over automation',
              'Escalate ambiguous decisions to the tenant admin'
            )
          ),
          true,
          true,
          auth.uid()
        );

        -- Create initial deployment stage (live)
        INSERT INTO de_deployment_stages (de_id, stage)
        SELECT id, 'live' FROM digital_employees
        WHERE tenant_id = v_tenant_record.id
          AND is_workforce_assistant = true
          AND NOT EXISTS (
            SELECT 1 FROM de_deployment_stages
            WHERE de_id = digital_employees.id
          );

        RAISE NOTICE '  ✓ PROVISIONED: Workforce Assistant created and activated';
        v_total_provisioned := v_total_provisioned + 1;

      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '  ✗ FAILED: % - %', SQLSTATE, SQLERRM;
        v_total_failed := v_total_failed + 1;
      END;
    END IF;

  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'PROVISIONING COMPLETE';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'Total Provisioned: %', v_total_provisioned;
  RAISE NOTICE 'Total Skipped (already existed): %', v_total_skipped;
  RAISE NOTICE 'Total Failed: %', v_total_failed;
  RAISE NOTICE 'All tenants now have Workforce Assistants ready at /workforce/chat';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

END $$;
