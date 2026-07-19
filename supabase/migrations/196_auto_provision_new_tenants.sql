-- ════════════════════════════════════════════════════════════════════════════════════════
-- AUTO-PROVISION: Supabase Trigger for New Tenant Provisioning
-- ════════════════════════════════════════════════════════════════════════════════════════
-- When a new tenant is created with status='active', automatically provision:
--   - Workforce Assistant (meta-DE for conversational management)
--   - Initial deployment stage
-- This ensures 100% coverage: every tenant gets all features immediately on creation
-- ════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.auto_provision_new_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_de_id UUID;
BEGIN
  -- Only provision if tenant is created with status='active'
  IF NEW.status = 'active' THEN
    RAISE NOTICE 'Auto-provisioning features for new tenant: %', NEW.name;

    -- Create Workforce Assistant DE
    INSERT INTO digital_employees (
      tenant_id,
      name,
      status,
      charter,
      is_workforce_assistant,
      is_product_expert,
      created_by,
      description
    ) VALUES (
      NEW.id,
      'Workforce Assistant',
      'active',
      jsonb_build_object(
        'name', 'Workforce Assistant',
        'persona', 'You are a trusted advisor helping this organization hire, improve, and manage their digital workforce. You are an expert on the DreamTeamAI platform.',
        'responsibilities', jsonb_build_array(
          'Help hire new DEs by understanding role requirements',
          'Suggest improvements to underperforming DEs based on metrics',
          'Monitor team performance and provide insights',
          'Help retire DEs and transition knowledge',
          'Train new tenants on DreamTeamAI features'
        ),
        'guardrails', jsonb_build_array(
          'Never auto-approve DE changes without explicit user consent',
          'Always show evidence for recommendations',
          'Prioritize user success over automation',
          'Escalate ambiguous decisions to the tenant admin'
        )
      ),
      true,
      true,
      auth.uid(),
      'Conversational workforce management assistant'
    ) RETURNING id INTO v_de_id;

    -- Create initial deployment stage
    INSERT INTO de_deployment_stages (de_id, stage)
    VALUES (v_de_id, 'live');

    RAISE NOTICE 'Auto-provisioned Workforce Assistant for tenant: %', NEW.name;
  END IF;

  RETURN NEW;
END;
$function$;

-- Drop trigger if exists (idempotent)
DROP TRIGGER IF EXISTS auto_provision_new_tenant_trigger ON tenants;

-- Create trigger
CREATE TRIGGER auto_provision_new_tenant_trigger
AFTER INSERT ON tenants
FOR EACH ROW
EXECUTE FUNCTION public.auto_provision_new_tenant();

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.auto_provision_new_tenant() TO service_role;
