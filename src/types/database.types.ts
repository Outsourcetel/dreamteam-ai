// ============================================================
// GENERATED — do not edit by hand.
//
// Schema-derived types for the whole public schema (Tables/Views/
// Functions/Enums). Source of truth is the live Postgres schema on
// project rfsvmhcqeiyrxivbmpel.
//
// Regenerate after any migration:
//   npm run gen:types
// (Supabase CLI: `supabase gen types typescript --project-id
//  rfsvmhcqeiyrxivbmpel --schema public`.)
//
// NOT YET wired into the client: src/supabase.ts still calls
// createClient() without <Database>, so today this file is reference-
// only. Switching to createClient<Database>(...) is a deliberate
// follow-up — it turns the ~217 hand-written `as SomeInterface` casts
// across src/lib/*Api.ts into checked conversions, which will surface
// real schema/interface drift as compile errors to reconcile.
// ============================================================
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      action_definitions: {
        Row: {
          action_key: string
          category: string
          created_at: string
          created_by: string | null
          description: string
          execution: Json
          id: string
          label: string
          param_schema: Json
          provider: string
          risk: Json
          scope: string
          status: string
          template_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          action_key: string
          category: string
          created_at?: string
          created_by?: string | null
          description?: string
          execution?: Json
          id?: string
          label: string
          param_schema?: Json
          provider: string
          risk?: Json
          scope: string
          status?: string
          template_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          action_key?: string
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string
          execution?: Json
          id?: string
          label?: string
          param_schema?: Json
          provider?: string
          risk?: Json
          scope?: string
          status?: string
          template_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_definitions_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "action_definitions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "adapter_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_definitions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      action_executions: {
        Row: {
          action_definition_id: string
          connector_id: string | null
          created_at: string
          decision: string
          dedupe_key: string | null
          destructive: boolean
          id: string
          idempotent: boolean
          mode: string
          params: Json
          receipt: string | null
          request_summary: string
          result: Json | null
          subject_id: string | null
          subject_kind: string | null
          task_id: string | null
          tenant_id: string
        }
        Insert: {
          action_definition_id: string
          connector_id?: string | null
          created_at?: string
          decision: string
          dedupe_key?: string | null
          destructive?: boolean
          id?: string
          idempotent?: boolean
          mode: string
          params?: Json
          receipt?: string | null
          request_summary?: string
          result?: Json | null
          subject_id?: string | null
          subject_kind?: string | null
          task_id?: string | null
          tenant_id: string
        }
        Update: {
          action_definition_id?: string
          connector_id?: string | null
          created_at?: string
          decision?: string
          dedupe_key?: string | null
          destructive?: boolean
          id?: string
          idempotent?: boolean
          mode?: string
          params?: Json
          receipt?: string | null
          request_summary?: string
          result?: Json | null
          subject_id?: string | null
          subject_kind?: string | null
          task_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_executions_action_definition_id_fkey"
            columns: ["action_definition_id"]
            isOneToOne: false
            referencedRelation: "action_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_executions_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_executions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_executions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_events: {
        Row: {
          account_id: string | null
          actor: string
          actor_type: string
          confidence: number | null
          created_at: string
          event_type: string
          id: string
          tenant_id: string
          text: string
        }
        Insert: {
          account_id?: string | null
          actor?: string
          actor_type?: string
          confidence?: number | null
          created_at?: string
          event_type?: string
          id?: string
          tenant_id: string
          text: string
        }
        Update: {
          account_id?: string | null
          actor?: string
          actor_type?: string
          confidence?: number | null
          created_at?: string
          event_type?: string
          id?: string
          tenant_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      adapter_templates: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          definition: Json
          description: string
          id: string
          name: string
          scope: string
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          definition?: Json
          description?: string
          id?: string
          name: string
          scope?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          definition?: Json
          description?: string
          id?: string
          name?: string
          scope?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "adapter_templates_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "adapter_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_actions: {
        Row: {
          action_type: string
          agent_name: string
          approved_at: string | null
          approved_by: string | null
          confidence_score: number | null
          conversation_id: string | null
          created_at: string | null
          description: string | null
          id: string
          payload: Json | null
          requires_approval: boolean | null
          result: Json | null
          status: string
          tenant_id: string
        }
        Insert: {
          action_type: string
          agent_name: string
          approved_at?: string | null
          approved_by?: string | null
          confidence_score?: number | null
          conversation_id?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          payload?: Json | null
          requires_approval?: boolean | null
          result?: Json | null
          status?: string
          tenant_id: string
        }
        Update: {
          action_type?: string
          agent_name?: string
          approved_at?: string | null
          approved_by?: string | null
          confidence_score?: number | null
          conversation_id?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          payload?: Json | null
          requires_approval?: boolean | null
          result?: Json | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_actions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agentic_step_messages: {
        Row: {
          agentic_step_run_id: string
          content: Json
          created_at: string
          id: string
          role: string
          turn_index: number
        }
        Insert: {
          agentic_step_run_id: string
          content: Json
          created_at?: string
          id?: string
          role: string
          turn_index: number
        }
        Update: {
          agentic_step_run_id?: string
          content?: Json
          created_at?: string
          id?: string
          role?: string
          turn_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "agentic_step_messages_agentic_step_run_id_fkey"
            columns: ["agentic_step_run_id"]
            isOneToOne: false
            referencedRelation: "agentic_step_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agentic_step_policies: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          max_cost_cents: number
          max_iterations: number
          max_no_progress_iterations: number
          max_tokens: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          max_cost_cents?: number
          max_iterations?: number
          max_no_progress_iterations?: number
          max_tokens?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          max_cost_cents?: number
          max_iterations?: number
          max_no_progress_iterations?: number
          max_tokens?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agentic_step_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agentic_step_runs: {
        Row: {
          completed_at: string | null
          cost_used_cents: number
          created_at: string
          de_id: string
          goal: string
          id: string
          iteration_count: number
          last_gated_human_task_id: string | null
          last_progress_hash: string | null
          playbook_run_id: string
          result: Json | null
          status: string
          step_index: number
          tenant_id: string
          tokens_used: number
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          cost_used_cents?: number
          created_at?: string
          de_id: string
          goal: string
          id?: string
          iteration_count?: number
          last_gated_human_task_id?: string | null
          last_progress_hash?: string | null
          playbook_run_id: string
          result?: Json | null
          status?: string
          step_index: number
          tenant_id: string
          tokens_used?: number
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          cost_used_cents?: number
          created_at?: string
          de_id?: string
          goal?: string
          id?: string
          iteration_count?: number
          last_gated_human_task_id?: string | null
          last_progress_hash?: string | null
          playbook_run_id?: string
          result?: Json | null
          status?: string
          step_index?: number
          tenant_id?: string
          tokens_used?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agentic_step_runs_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agentic_step_runs_last_gated_human_task_id_fkey"
            columns: ["last_gated_human_task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agentic_step_runs_playbook_run_id_fkey"
            columns: ["playbook_run_id"]
            isOneToOne: false
            referencedRelation: "playbook_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agentic_step_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_model_pricing: {
        Row: {
          input_price_per_million: number
          model_id: string
          output_price_per_million: number
          updated_at: string
        }
        Insert: {
          input_price_per_million: number
          model_id: string
          output_price_per_million: number
          updated_at?: string
        }
        Update: {
          input_price_per_million?: number
          model_id?: string
          output_price_per_million?: number
          updated_at?: string
        }
        Relationships: []
      }
      ai_usage_events: {
        Row: {
          actor_user_id: string | null
          capability_id: string | null
          created_at: string
          digital_employee_id: string | null
          duration_ms: number | null
          estimated_cost_usd: number
          id: string
          input_tokens: number
          metadata: Json
          model_name: string
          model_provider: string
          output_tokens: number
          playbook_id: string | null
          purpose: string
          success: boolean
          tenant_id: string | null
          workspace_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          capability_id?: string | null
          created_at?: string
          digital_employee_id?: string | null
          duration_ms?: number | null
          estimated_cost_usd?: number
          id?: string
          input_tokens?: number
          metadata?: Json
          model_name?: string
          model_provider?: string
          output_tokens?: number
          playbook_id?: string | null
          purpose?: string
          success?: boolean
          tenant_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          capability_id?: string | null
          created_at?: string
          digital_employee_id?: string | null
          duration_ms?: number | null
          estimated_cost_usd?: number
          id?: string
          input_tokens?: number
          metadata?: Json
          model_name?: string
          model_provider?: string
          output_tokens?: number
          playbook_id?: string | null
          purpose?: string
          success?: boolean
          tenant_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      answer_cache: {
        Row: {
          account_id: string | null
          answer: string
          confidence: number
          hits: number
          id: string
          invalidated: boolean
          question: string
          question_embedding: string | null
          sources: Json
          tenant_id: string
          verified_at: string
        }
        Insert: {
          account_id?: string | null
          answer: string
          confidence?: number
          hits?: number
          id?: string
          invalidated?: boolean
          question: string
          question_embedding?: string | null
          sources?: Json
          tenant_id: string
          verified_at?: string
        }
        Update: {
          account_id?: string | null
          answer?: string
          confidence?: number
          hits?: number
          id?: string
          invalidated?: boolean
          question?: string
          question_embedding?: string | null
          sources?: Json
          tenant_id?: string
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "answer_cache_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answer_cache_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor: string
          actor_type: string
          category: string
          created_at: string
          detail: Json
          hash: string
          id: string
          prev_hash: string
          tenant_id: string
        }
        Insert: {
          action: string
          actor?: string
          actor_type?: string
          category: string
          created_at?: string
          detail?: Json
          hash: string
          id?: string
          prev_hash?: string
          tenant_id: string
        }
        Update: {
          action?: string
          actor?: string
          actor_type?: string
          category?: string
          created_at?: string
          detail?: Json
          hash?: string
          id?: string
          prev_hash?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_evidence: {
        Row: {
          action: string
          ai_reasoning: string | null
          approver: string | null
          approver_name: string | null
          confidence: number | null
          created_at: string
          exception_id: string | null
          final_treatment: string | null
          id: string
          source_evidence: string | null
          tenant_id: string
          workspace_id: string | null
        }
        Insert: {
          action: string
          ai_reasoning?: string | null
          approver?: string | null
          approver_name?: string | null
          confidence?: number | null
          created_at?: string
          exception_id?: string | null
          final_treatment?: string | null
          id?: string
          source_evidence?: string | null
          tenant_id: string
          workspace_id?: string | null
        }
        Update: {
          action?: string
          ai_reasoning?: string | null
          approver?: string | null
          approver_name?: string | null
          confidence?: number | null
          created_at?: string
          exception_id?: string | null
          final_treatment?: string | null
          id?: string
          source_evidence?: string | null
          tenant_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_evidence_exception_id_fkey"
            columns: ["exception_id"]
            isOneToOne: false
            referencedRelation: "exceptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_evidence_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          after_data: Json | null
          before_data: Json | null
          created_at: string
          entity_id: string | null
          entity_name: string | null
          entity_type: string
          id: string
          metadata: Json
          tenant_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_name?: string | null
          entity_type: string
          id?: string
          metadata?: Json
          tenant_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_name?: string | null
          entity_type?: string
          id?: string
          metadata?: Json
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_login_lockouts: {
        Row: {
          failed_count: number
          last_attempt_at: string
          locked_until: string | null
          user_id: string
        }
        Insert: {
          failed_count?: number
          last_attempt_at?: string
          locked_until?: string | null
          user_id: string
        }
        Update: {
          failed_count?: number
          last_attempt_at?: string
          locked_until?: string | null
          user_id?: string
        }
        Relationships: []
      }
      bank_transactions: {
        Row: {
          account_id: string | null
          amount: number
          category: string | null
          created_at: string
          description: string | null
          external_ref: string | null
          id: string
          is_matched: boolean
          matched_payment_id: string | null
          tenant_id: string
          txn_date: string | null
          workspace_id: string | null
        }
        Insert: {
          account_id?: string | null
          amount?: number
          category?: string | null
          created_at?: string
          description?: string | null
          external_ref?: string | null
          id?: string
          is_matched?: boolean
          matched_payment_id?: string | null
          tenant_id: string
          txn_date?: string | null
          workspace_id?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number
          category?: string | null
          created_at?: string
          description?: string | null
          external_ref?: string | null
          id?: string
          is_matched?: boolean
          matched_payment_id?: string | null
          tenant_id?: string
          txn_date?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "fin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_matched_payment_id_fkey"
            columns: ["matched_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      bills: {
        Row: {
          account_id: string | null
          amount: number
          amount_paid: number
          bill_number: string
          created_at: string
          currency: string
          due_date: string | null
          has_receipt: boolean
          id: string
          issue_date: string | null
          status: string
          tenant_id: string
          vendor_id: string | null
          workspace_id: string | null
        }
        Insert: {
          account_id?: string | null
          amount?: number
          amount_paid?: number
          bill_number: string
          created_at?: string
          currency?: string
          due_date?: string | null
          has_receipt?: boolean
          id?: string
          issue_date?: string | null
          status?: string
          tenant_id: string
          vendor_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number
          amount_paid?: number
          bill_number?: string
          created_at?: string
          currency?: string
          due_date?: string | null
          has_receipt?: boolean
          id?: string
          issue_date?: string | null
          status?: string
          tenant_id?: string
          vendor_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bills_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "fin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bills_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bills_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      capabilities: {
        Row: {
          approval_required: boolean
          assigned_des: string[]
          avg_confidence: number | null
          created_at: string
          created_by: string | null
          description: string
          icon: string
          id: string
          inputs: string[]
          last_run_at: string | null
          name: string
          outputs: string[]
          required_connectors: string[]
          required_knowledge: string[]
          risk_level: string
          run_count: number
          slug: string | null
          status: string
          tenant_id: string
          updated_at: string
          workspace: string
        }
        Insert: {
          approval_required?: boolean
          assigned_des?: string[]
          avg_confidence?: number | null
          created_at?: string
          created_by?: string | null
          description?: string
          icon?: string
          id?: string
          inputs?: string[]
          last_run_at?: string | null
          name: string
          outputs?: string[]
          required_connectors?: string[]
          required_knowledge?: string[]
          risk_level?: string
          run_count?: number
          slug?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          workspace?: string
        }
        Update: {
          approval_required?: boolean
          assigned_des?: string[]
          avg_confidence?: number | null
          created_at?: string
          created_by?: string | null
          description?: string
          icon?: string
          id?: string
          inputs?: string[]
          last_run_at?: string | null
          name?: string
          outputs?: string[]
          required_connectors?: string[]
          required_knowledge?: string[]
          risk_level?: string
          run_count?: number
          slug?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          workspace?: string
        }
        Relationships: [
          {
            foreignKeyName: "capabilities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      close_tasks: {
        Row: {
          category: string | null
          created_at: string
          id: string
          sort_order: number
          status: string
          tenant_id: string
          title: string
          workspace_id: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          sort_order?: number
          status?: string
          tenant_id: string
          title: string
          workspace_id?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          sort_order?: number
          status?: string
          tenant_id?: string
          title?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "close_tasks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      close_workspaces: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          id: string
          name: string
          period_end: string
          period_start: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          name: string
          period_end: string
          period_start: string
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          id?: string
          name?: string
          period_end?: string
          period_start?: string
          status?: string
          tenant_id?: string
        }
        Relationships: []
      }
      connector_actions: {
        Row: {
          action_key: string
          connector_id: string
          created_at: string
          enabled: boolean
          id: string
          updated_at: string
        }
        Insert: {
          action_key: string
          connector_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          updated_at?: string
        }
        Update: {
          action_key?: string
          connector_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_actions_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
        ]
      }
      connector_ingest_candidates: {
        Row: {
          connector_id: string
          decided_at: string | null
          decided_by: string | null
          discovered_at: string
          external_ref: string
          file_type: string
          id: string
          ingested_at: string | null
          path: string
          size_bytes: number | null
          status: string
          tenant_id: string
          title: string
        }
        Insert: {
          connector_id: string
          decided_at?: string | null
          decided_by?: string | null
          discovered_at?: string
          external_ref: string
          file_type?: string
          id?: string
          ingested_at?: string | null
          path?: string
          size_bytes?: number | null
          status?: string
          tenant_id: string
          title?: string
        }
        Update: {
          connector_id?: string
          decided_at?: string | null
          decided_by?: string | null
          discovered_at?: string
          external_ref?: string
          file_type?: string
          id?: string
          ingested_at?: string | null
          path?: string
          size_bytes?: number | null
          status?: string
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_ingest_candidates_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_ingest_candidates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connector_objects: {
        Row: {
          connector_id: string
          created_at: string
          enabled: boolean
          id: string
          last_synced_at: string | null
          mode: string
          object_type: string
          sync_interval_mins: number
          updated_at: string
        }
        Insert: {
          connector_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_synced_at?: string | null
          mode?: string
          object_type: string
          sync_interval_mins?: number
          updated_at?: string
        }
        Update: {
          connector_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_synced_at?: string | null
          mode?: string
          object_type?: string
          sync_interval_mins?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_objects_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
        ]
      }
      connector_secrets: {
        Row: {
          connector_id: string
          created_at: string
          secret: string | null
          secret_id: string | null
          updated_at: string
        }
        Insert: {
          connector_id: string
          created_at?: string
          secret?: string | null
          secret_id?: string | null
          updated_at?: string
        }
        Update: {
          connector_id?: string
          created_at?: string
          secret?: string | null
          secret_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connector_secrets_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: true
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
        ]
      }
      connectors: {
        Row: {
          access_mode: string
          base_url: string
          category: string
          config: Json
          consecutive_failures: number
          created_at: string
          display_name: string
          field_map: Json
          id: string
          last_error: string | null
          last_error_at: string | null
          last_ok_at: string | null
          last_sync_at: string | null
          provider: string
          status: string
          template_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          access_mode?: string
          base_url: string
          category?: string
          config?: Json
          consecutive_failures?: number
          created_at?: string
          display_name?: string
          field_map?: Json
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_ok_at?: string | null
          last_sync_at?: string | null
          provider: string
          status?: string
          template_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          access_mode?: string
          base_url?: string
          category?: string
          config?: Json
          consecutive_failures?: number
          created_at?: string
          display_name?: string
          field_map?: Json
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_ok_at?: string | null
          last_sync_at?: string | null
          provider?: string
          status?: string
          template_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connectors_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "connectors_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "adapter_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connectors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_facts: {
        Row: {
          conversation_id: string
          established_at: string
          fact_key: string
          fact_value: Json
          id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          conversation_id: string
          established_at?: string
          fact_key: string
          fact_value: Json
          id?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          conversation_id?: string
          established_at?: string
          fact_key?: string
          fact_value?: Json
          id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_facts_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "de_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_facts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_to: string | null
          channel: string
          confidence_score: number | null
          created_at: string | null
          csat_score: number | null
          csat_submitted_at: string | null
          customer_email: string | null
          customer_name: string | null
          id: string
          metadata: Json | null
          opened_at: string | null
          resolution_type: string | null
          resolved_at: string | null
          sentiment: string | null
          status: string
          subject: string | null
          tags: string[] | null
          tenant_id: string
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          channel?: string
          confidence_score?: number | null
          created_at?: string | null
          csat_score?: number | null
          csat_submitted_at?: string | null
          customer_email?: string | null
          customer_name?: string | null
          id?: string
          metadata?: Json | null
          opened_at?: string | null
          resolution_type?: string | null
          resolved_at?: string | null
          sentiment?: string | null
          status?: string
          subject?: string | null
          tags?: string[] | null
          tenant_id: string
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          channel?: string
          confidence_score?: number | null
          created_at?: string | null
          csat_score?: number | null
          csat_submitted_at?: string | null
          customer_email?: string | null
          customer_name?: string | null
          id?: string
          metadata?: Json | null
          opened_at?: string | null
          resolution_type?: string | null
          resolved_at?: string | null
          sentiment?: string | null
          status?: string
          subject?: string | null
          tags?: string[] | null
          tenant_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_accounts: {
        Row: {
          arr_cents: number
          attributes: Json
          created_at: string
          csm: string
          external_ref: string | null
          health_components: Json | null
          health_score: number
          id: string
          name: string
          notes: string
          renewal_date: string | null
          status: string
          tenant_id: string
          tier: string | null
          updated_at: string
        }
        Insert: {
          arr_cents?: number
          attributes?: Json
          created_at?: string
          csm?: string
          external_ref?: string | null
          health_components?: Json | null
          health_score?: number
          id?: string
          name: string
          notes?: string
          renewal_date?: string | null
          status?: string
          tenant_id: string
          tier?: string | null
          updated_at?: string
        }
        Update: {
          arr_cents?: number
          attributes?: Json
          created_at?: string
          csm?: string
          external_ref?: string | null
          health_components?: Json | null
          health_score?: number
          id?: string
          name?: string
          notes?: string
          renewal_date?: string | null
          status?: string
          tenant_id?: string
          tier?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          tenant_id?: string
        }
        Relationships: []
      }
      data_access_grants: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          note: string
          permission: string
          resource_category: string | null
          resource_id: string | null
          resource_kind: string
          subject_id: string
          subject_kind: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          note?: string
          permission: string
          resource_category?: string | null
          resource_id?: string | null
          resource_kind: string
          subject_id: string
          subject_kind: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          note?: string
          permission?: string
          resource_category?: string | null
          resource_id?: string | null
          resource_kind?: string
          subject_id?: string
          subject_kind?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_access_grants_resource_category_fkey"
            columns: ["resource_category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "data_access_grants_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_access_grants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_autonomy: {
        Row: {
          action_type: string
          created_at: string
          de_id: string | null
          enabled: boolean
          id: string
          max_amount_cents: number | null
          min_confidence: number | null
          source_category: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          action_type: string
          created_at?: string
          de_id?: string | null
          enabled?: boolean
          id?: string
          max_amount_cents?: number | null
          min_confidence?: number | null
          source_category?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string
          de_id?: string | null
          enabled?: boolean
          id?: string
          max_amount_cents?: number | null
          min_confidence?: number | null
          source_category?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "de_autonomy_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_autonomy_source_category_fkey"
            columns: ["source_category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "de_autonomy_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_certifications: {
        Row: {
          cert_type: string
          created_at: string
          de_id: string
          expires_at: string
          id: string
          issued_at: string
          issued_by: string | null
          issued_by_name: string
          note: string
          revoked_reason: string | null
          scope: string
          status: string
          tenant_id: string
          warned_at: string | null
        }
        Insert: {
          cert_type: string
          created_at?: string
          de_id: string
          expires_at: string
          id?: string
          issued_at?: string
          issued_by?: string | null
          issued_by_name?: string
          note?: string
          revoked_reason?: string | null
          scope?: string
          status?: string
          tenant_id: string
          warned_at?: string | null
        }
        Update: {
          cert_type?: string
          created_at?: string
          de_id?: string
          expires_at?: string
          id?: string
          issued_at?: string
          issued_by?: string | null
          issued_by_name?: string
          note?: string
          revoked_reason?: string | null
          scope?: string
          status?: string
          tenant_id?: string
          warned_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "de_certifications_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_certifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_consultation_grants: {
        Row: {
          active: boolean
          category: string
          created_at: string
          created_by: string | null
          id: string
          requester_de_id: string
          target_de_id: string
          tenant_id: string
        }
        Insert: {
          active?: boolean
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          requester_de_id: string
          target_de_id: string
          tenant_id: string
        }
        Update: {
          active?: boolean
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          requester_de_id?: string
          target_de_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_consultation_grants_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "de_consultation_grants_requester_de_id_fkey"
            columns: ["requester_de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_consultation_grants_target_de_id_fkey"
            columns: ["target_de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_consultation_grants_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_conversations: {
        Row: {
          account_external_ref: string | null
          account_id: string | null
          channel: string
          created_at: string
          csat_score: number | null
          csat_submitted_at: string | null
          de_id: string | null
          detected_language: string | null
          end_user_name: string | null
          end_user_ref: string | null
          handoff_summary: string | null
          id: string
          last_message_at: string | null
          owner_user_id: string | null
          priority: string
          status: string
          subject: string | null
          tenant_id: string
        }
        Insert: {
          account_external_ref?: string | null
          account_id?: string | null
          channel?: string
          created_at?: string
          csat_score?: number | null
          csat_submitted_at?: string | null
          de_id?: string | null
          detected_language?: string | null
          end_user_name?: string | null
          end_user_ref?: string | null
          handoff_summary?: string | null
          id?: string
          last_message_at?: string | null
          owner_user_id?: string | null
          priority?: string
          status?: string
          subject?: string | null
          tenant_id: string
        }
        Update: {
          account_external_ref?: string | null
          account_id?: string | null
          channel?: string
          created_at?: string
          csat_score?: number | null
          csat_submitted_at?: string | null
          de_id?: string | null
          detected_language?: string | null
          end_user_name?: string | null
          end_user_ref?: string | null
          handoff_summary?: string | null
          id?: string
          last_message_at?: string | null
          owner_user_id?: string | null
          priority?: string
          status?: string
          subject?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_conversations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_conversations_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_development_items: {
        Row: {
          assigned_to: string | null
          baseline_value: number | null
          completed_at: string | null
          consequence: string | null
          created_at: string
          created_by: string | null
          de_id: string
          description: string
          due_date: string | null
          id: string
          item_type: string
          priority: string
          source: string
          status: string
          target_metric: string | null
          target_value: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          baseline_value?: number | null
          completed_at?: string | null
          consequence?: string | null
          created_at?: string
          created_by?: string | null
          de_id: string
          description: string
          due_date?: string | null
          id?: string
          item_type: string
          priority?: string
          source: string
          status?: string
          target_metric?: string | null
          target_value?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          baseline_value?: number | null
          completed_at?: string | null
          consequence?: string | null
          created_at?: string
          created_by?: string | null
          de_id?: string
          description?: string
          due_date?: string | null
          id?: string
          item_type?: string
          priority?: string
          source?: string
          status?: string
          target_metric?: string | null
          target_value?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_development_items_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_development_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_escalation_rules: {
        Row: {
          always_escalate_topics: string[]
          de_id: string | null
          frustration_threshold: number | null
          id: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          always_escalate_topics?: string[]
          de_id?: string | null
          frustration_threshold?: number | null
          id?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          always_escalate_topics?: string[]
          de_id?: string | null
          frustration_threshold?: number | null
          id?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "de_escalation_rules_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_escalation_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_experience: {
        Row: {
          category: string
          created_at: string
          external_ref: string
          fact_summary: Json
          id: string
          source_action_execution_id: string | null
          source_evidence_run_id: string | null
          subject_id: string
          subject_kind: string
          tenant_id: string
        }
        Insert: {
          category: string
          created_at?: string
          external_ref: string
          fact_summary: Json
          id?: string
          source_action_execution_id?: string | null
          source_evidence_run_id?: string | null
          subject_id: string
          subject_kind: string
          tenant_id: string
        }
        Update: {
          category?: string
          created_at?: string
          external_ref?: string
          fact_summary?: Json
          id?: string
          source_action_execution_id?: string | null
          source_evidence_run_id?: string | null
          subject_id?: string
          subject_kind?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_experience_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "de_experience_source_action_execution_id_fkey"
            columns: ["source_action_execution_id"]
            isOneToOne: false
            referencedRelation: "action_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_experience_source_evidence_run_id_fkey"
            columns: ["source_evidence_run_id"]
            isOneToOne: false
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_experience_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_incidents: {
        Row: {
          created_at: string
          de_id: string | null
          detail: Json
          id: string
          kind: string
          occurred_at: string
          resolution_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          severity: string
          source_id: string
          source_table: string
          status: string
          tenant_id: string
          title: string
        }
        Insert: {
          created_at?: string
          de_id?: string | null
          detail?: Json
          id?: string
          kind: string
          occurred_at: string
          resolution_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          source_id: string
          source_table: string
          status?: string
          tenant_id: string
          title: string
        }
        Update: {
          created_at?: string
          de_id?: string | null
          detail?: Json
          id?: string
          kind?: string
          occurred_at?: string
          resolution_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          source_id?: string
          source_table?: string
          status?: string
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_incidents_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_incidents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_kpis: {
        Row: {
          created_at: string
          de_id: string
          direction: string
          id: string
          metric_key: string
          name: string
          owner_user_id: string | null
          target: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          de_id: string
          direction: string
          id?: string
          metric_key: string
          name: string
          owner_user_id?: string | null
          target: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          de_id?: string
          direction?: string
          id?: string
          metric_key?: string
          name?: string
          owner_user_id?: string | null
          target?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_kpis_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_kpis_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_learned_behavior_cluster_members: {
        Row: {
          added_at: string
          cluster_id: string
          evidence_run_id: string
          human_task_id: string | null
          id: string
          similarity_to_representative: number | null
        }
        Insert: {
          added_at?: string
          cluster_id: string
          evidence_run_id: string
          human_task_id?: string | null
          id?: string
          similarity_to_representative?: number | null
        }
        Update: {
          added_at?: string
          cluster_id?: string
          evidence_run_id?: string
          human_task_id?: string | null
          id?: string
          similarity_to_representative?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "de_learned_behavior_cluster_members_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "de_learned_behavior_clusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_cluster_members_evidence_run_id_fkey"
            columns: ["evidence_run_id"]
            isOneToOne: true
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_cluster_members_human_task_id_fkey"
            columns: ["human_task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      de_learned_behavior_clusters: {
        Row: {
          category: string | null
          created_at: string
          de_id: string
          first_seen_at: string
          fix_applied_at: string | null
          guardrail_rule_id: string | null
          human_task_id: string | null
          id: string
          last_seen_at: string
          member_count: number
          pre_fix_avg_confidence: number | null
          proposed_rule: Json | null
          recurred_after_fix: boolean
          recurrence_count: number
          representative_run_id: string
          resulting_guardrail_rule_id: string | null
          severity_score: number
          status: string
          tenant_id: string
          updated_at: string
          verdict_type: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          de_id: string
          first_seen_at?: string
          fix_applied_at?: string | null
          guardrail_rule_id?: string | null
          human_task_id?: string | null
          id?: string
          last_seen_at?: string
          member_count?: number
          pre_fix_avg_confidence?: number | null
          proposed_rule?: Json | null
          recurred_after_fix?: boolean
          recurrence_count?: number
          representative_run_id: string
          resulting_guardrail_rule_id?: string | null
          severity_score?: number
          status?: string
          tenant_id: string
          updated_at?: string
          verdict_type: string
        }
        Update: {
          category?: string | null
          created_at?: string
          de_id?: string
          first_seen_at?: string
          fix_applied_at?: string | null
          guardrail_rule_id?: string | null
          human_task_id?: string | null
          id?: string
          last_seen_at?: string
          member_count?: number
          pre_fix_avg_confidence?: number | null
          proposed_rule?: Json | null
          recurred_after_fix?: boolean
          recurrence_count?: number
          representative_run_id?: string
          resulting_guardrail_rule_id?: string | null
          severity_score?: number
          status?: string
          tenant_id?: string
          updated_at?: string
          verdict_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_learned_behavior_clusters_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_clusters_guardrail_rule_id_fkey"
            columns: ["guardrail_rule_id"]
            isOneToOne: false
            referencedRelation: "guardrail_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_clusters_human_task_id_fkey"
            columns: ["human_task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_clusters_representative_run_id_fkey"
            columns: ["representative_run_id"]
            isOneToOne: false
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_clusters_resulting_guardrail_rule_id_fkey"
            columns: ["resulting_guardrail_rule_id"]
            isOneToOne: false
            referencedRelation: "guardrail_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_learned_behavior_clusters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_learning_policies: {
        Row: {
          category: string | null
          created_at: string
          enabled: boolean
          id: string
          min_cluster_size: number
          similarity_threshold: number
          tenant_id: string
          updated_at: string
          window_days: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          min_cluster_size?: number
          similarity_threshold?: number
          tenant_id: string
          updated_at?: string
          window_days?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          min_cluster_size?: number
          similarity_threshold?: number
          tenant_id?: string
          updated_at?: string
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "de_learning_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_lifecycle_events: {
        Row: {
          actor_id: string | null
          actor_label: string
          created_at: string
          criteria_snapshot: Json
          de_id: string
          from_stage: string
          id: string
          note: string | null
          tenant_id: string
          to_stage: string
        }
        Insert: {
          actor_id?: string | null
          actor_label?: string
          created_at?: string
          criteria_snapshot?: Json
          de_id: string
          from_stage: string
          id?: string
          note?: string | null
          tenant_id: string
          to_stage: string
        }
        Update: {
          actor_id?: string | null
          actor_label?: string
          created_at?: string
          criteria_snapshot?: Json
          de_id?: string
          from_stage?: string
          id?: string
          note?: string | null
          tenant_id?: string
          to_stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_lifecycle_events_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_lifecycle_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_messages: {
        Row: {
          account_id: string | null
          audio_url: string | null
          confidence: number | null
          content: string
          conversation_id: string
          created_at: string
          delivery: string
          escalated: boolean
          id: string
          lang: string | null
          role: string
          tenant_id: string
        }
        Insert: {
          account_id?: string | null
          audio_url?: string | null
          confidence?: number | null
          content: string
          conversation_id: string
          created_at?: string
          delivery?: string
          escalated?: boolean
          id?: string
          lang?: string | null
          role: string
          tenant_id: string
        }
        Update: {
          account_id?: string | null
          audio_url?: string | null
          confidence?: number | null
          content?: string
          conversation_id?: string
          created_at?: string
          delivery?: string
          escalated?: boolean
          id?: string
          lang?: string | null
          role?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "de_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_performance_reviews: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          de_id: string
          id: string
          metrics_snapshot: Json
          period_end: string
          period_start: string
          status: string
          summary: string
          tenant_id: string
          verdict: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          de_id: string
          id?: string
          metrics_snapshot?: Json
          period_end: string
          period_start: string
          status?: string
          summary: string
          tenant_id: string
          verdict: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          de_id?: string
          id?: string
          metrics_snapshot?: Json
          period_end?: string
          period_start?: string
          status?: string
          summary?: string
          tenant_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_performance_reviews_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_performance_reviews_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_playbook_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          digital_employee_id: string
          id: string
          is_primary: boolean
          playbook_id: string
          tenant_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          digital_employee_id: string
          id?: string
          is_primary?: boolean
          playbook_id: string
          tenant_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          digital_employee_id?: string
          id?: string
          is_primary?: boolean
          playbook_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_playbook_assignments_digital_employee_id_fkey"
            columns: ["digital_employee_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_playbook_assignments_playbook_id_fkey"
            columns: ["playbook_id"]
            isOneToOne: false
            referencedRelation: "playbooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_playbook_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_playbook_charter: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          de_id: string
          id: string
          playbook_id: string
          priority: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          de_id: string
          id?: string
          playbook_id: string
          priority?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          de_id?: string
          id?: string
          playbook_id?: string
          priority?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_playbook_charter_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_playbook_charter_playbook_id_fkey"
            columns: ["playbook_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_playbook_charter_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_profile_fields: {
        Row: {
          created_at: string
          created_by: string | null
          field_key: string
          field_type: string
          id: string
          label: string
          position: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          field_key: string
          field_type?: string
          id?: string
          label: string
          position?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          field_key?: string
          field_type?: string
          id?: string
          label?: string
          position?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_profile_fields_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_skills: {
        Row: {
          assessed_at: string
          de_id: string
          detail: string
          id: string
          proficiency: number | null
          sample_size: number
          signal_value: number | null
          skill_key: string
          tenant_id: string
        }
        Insert: {
          assessed_at?: string
          de_id: string
          detail?: string
          id?: string
          proficiency?: number | null
          sample_size?: number
          signal_value?: number | null
          skill_key: string
          tenant_id: string
        }
        Update: {
          assessed_at?: string
          de_id?: string
          detail?: string
          id?: string
          proficiency?: number | null
          sample_size?: number
          signal_value?: number | null
          skill_key?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_skills_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_skills_skill_key_fkey"
            columns: ["skill_key"]
            isOneToOne: false
            referencedRelation: "skill_catalog"
            referencedColumns: ["skill_key"]
          },
          {
            foreignKeyName: "de_skills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_specialist_assignments: {
        Row: {
          created_at: string
          created_by: string | null
          de_id: string
          id: string
          rank: number
          specialist_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          de_id: string
          id?: string
          rank: number
          specialist_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          de_id?: string
          id?: string
          rank?: number
          specialist_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_specialist_assignments_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_specialist_assignments_specialist_id_fkey"
            columns: ["specialist_id"]
            isOneToOne: false
            referencedRelation: "specialist_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_specialist_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      de_token_usage: {
        Row: {
          created_at: string
          de_id: string | null
          id: string
          input_tokens: number
          model_id: string
          output_tokens: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          de_id?: string | null
          id?: string
          input_tokens?: number
          model_id: string
          output_tokens?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          de_id?: string | null
          id?: string
          input_tokens?: number
          model_id?: string
          output_tokens?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "de_token_usage_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "de_token_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          color: string
          created_at: string
          created_by: string | null
          description: string
          head_name: string | null
          id: string
          member_count: number
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string
          head_name?: string | null
          id?: string
          member_count?: number
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string
          head_name?: string | null
          id?: string
          member_count?: number
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      digital_employees: {
        Row: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        Insert: {
          attributes?: Json
          availability?: Json
          capabilities?: string[]
          catalog_id?: string | null
          category?: string
          channels?: string[]
          confidence_threshold?: number
          config_version?: number
          cost_center?: string
          created_at?: string
          created_by?: string | null
          department?: string
          description?: string
          display_title?: string
          employee_code?: string
          escalation_model_id?: string
          escalation_threshold?: number
          external_reply_mode?: string
          fte_equivalent?: number | null
          icon?: string
          id?: string
          knowledge_sources?: string[]
          lifecycle_status?: string
          location?: string
          model_config?: Json
          model_id?: string
          model_provider?: string
          name: string
          owner_id?: string | null
          persona_name?: string | null
          primary_business_outcome?: string
          purpose_statement?: string
          required_approval?: boolean
          responsibilities?: string[]
          skills?: Json
          status?: string
          success_rate?: number
          tags?: string[]
          task_type?: string
          tasks_this_month?: number
          tenant_id: string
          trust_level?: string
          updated_at?: string
          workspace?: string
        }
        Update: {
          attributes?: Json
          availability?: Json
          capabilities?: string[]
          catalog_id?: string | null
          category?: string
          channels?: string[]
          confidence_threshold?: number
          config_version?: number
          cost_center?: string
          created_at?: string
          created_by?: string | null
          department?: string
          description?: string
          display_title?: string
          employee_code?: string
          escalation_model_id?: string
          escalation_threshold?: number
          external_reply_mode?: string
          fte_equivalent?: number | null
          icon?: string
          id?: string
          knowledge_sources?: string[]
          lifecycle_status?: string
          location?: string
          model_config?: Json
          model_id?: string
          model_provider?: string
          name?: string
          owner_id?: string | null
          persona_name?: string | null
          primary_business_outcome?: string
          purpose_statement?: string
          required_approval?: boolean
          responsibilities?: string[]
          skills?: Json
          status?: string
          success_rate?: number
          tags?: string[]
          task_type?: string
          tasks_this_month?: number
          tenant_id?: string
          trust_level?: string
          updated_at?: string
          workspace?: string
        }
        Relationships: [
          {
            foreignKeyName: "digital_employees_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      end_user_sessions: {
        Row: {
          account_external_ref: string | null
          created_at: string
          display_name: string | null
          end_user_ref: string | null
          id: string
          last_seen_at: string
          tenant_id: string
        }
        Insert: {
          account_external_ref?: string | null
          created_at?: string
          display_name?: string | null
          end_user_ref?: string | null
          id?: string
          last_seen_at?: string
          tenant_id: string
        }
        Update: {
          account_external_ref?: string | null
          created_at?: string
          display_name?: string | null
          end_user_ref?: string | null
          id?: string
          last_seen_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "end_user_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      escalations: {
        Row: {
          assigned_to: string | null
          confidence: number | null
          conversation_id: string | null
          created_at: string
          draft_answer: string | null
          id: string
          question: string | null
          reason: string
          resolved_at: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          assigned_to?: string | null
          confidence?: number | null
          conversation_id?: string | null
          created_at?: string
          draft_answer?: string | null
          id?: string
          question?: string | null
          reason: string
          resolved_at?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          assigned_to?: string | null
          confidence?: number | null
          conversation_id?: string | null
          created_at?: string
          draft_answer?: string | null
          id?: string
          question?: string | null
          reason?: string
          resolved_at?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "escalations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_runs: {
        Row: {
          failed: number
          finished_at: string | null
          id: string
          passed: number
          results: Json
          started_at: string
          status: string
          tenant_id: string
          total: number
          trigger: string
        }
        Insert: {
          failed?: number
          finished_at?: string | null
          id?: string
          passed?: number
          results?: Json
          started_at?: string
          status?: string
          tenant_id: string
          total?: number
          trigger?: string
        }
        Update: {
          failed?: number
          finished_at?: string | null
          id?: string
          passed?: number
          results?: Json
          started_at?: string
          status?: string
          tenant_id?: string
          total?: number
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "eval_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      event_definitions: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          description: string
          event_key: string
          id: string
          kind: string
          label: string
          params_schema: Json
          scope: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          description?: string
          event_key: string
          id?: string
          kind?: string
          label: string
          params_schema?: Json
          scope: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          description?: string
          event_key?: string
          id?: string
          kind?: string
          label?: string
          params_schema?: Json
          scope?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_definitions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_feedback: {
        Row: {
          created_at: string
          evidence_run_id: string
          id: string
          notes: string
          reviewer_user_id: string | null
          tenant_id: string
          verdict: string
        }
        Insert: {
          created_at?: string
          evidence_run_id: string
          id?: string
          notes?: string
          reviewer_user_id?: string | null
          tenant_id: string
          verdict: string
        }
        Update: {
          created_at?: string
          evidence_run_id?: string
          id?: string
          notes?: string
          reviewer_user_id?: string | null
          tenant_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "evidence_feedback_evidence_run_id_fkey"
            columns: ["evidence_run_id"]
            isOneToOne: false
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_run_decisions: {
        Row: {
          action_execution_id: string | null
          confidence: number | null
          connector_id: string | null
          created_at: string
          decision: string
          evidence_run_id: string
          external_ref: string | null
          frustration_score: number | null
          guardrail_rule_id: string | null
          human_task_id: string | null
          id: string
          reasoning: string
          source: string
          source_category: string | null
          tenant_id: string
          trust_level: number | null
        }
        Insert: {
          action_execution_id?: string | null
          confidence?: number | null
          connector_id?: string | null
          created_at?: string
          decision: string
          evidence_run_id: string
          external_ref?: string | null
          frustration_score?: number | null
          guardrail_rule_id?: string | null
          human_task_id?: string | null
          id?: string
          reasoning?: string
          source: string
          source_category?: string | null
          tenant_id: string
          trust_level?: number | null
        }
        Update: {
          action_execution_id?: string | null
          confidence?: number | null
          connector_id?: string | null
          created_at?: string
          decision?: string
          evidence_run_id?: string
          external_ref?: string | null
          frustration_score?: number | null
          guardrail_rule_id?: string | null
          human_task_id?: string | null
          id?: string
          reasoning?: string
          source?: string
          source_category?: string | null
          tenant_id?: string
          trust_level?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "evidence_run_decisions_action_execution_id_fkey"
            columns: ["action_execution_id"]
            isOneToOne: false
            referencedRelation: "action_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_run_decisions_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_run_decisions_evidence_run_id_fkey"
            columns: ["evidence_run_id"]
            isOneToOne: true
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_run_decisions_guardrail_rule_id_fkey"
            columns: ["guardrail_rule_id"]
            isOneToOne: false
            referencedRelation: "guardrail_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_run_decisions_human_task_id_fkey"
            columns: ["human_task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_run_decisions_source_category_fkey"
            columns: ["source_category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "evidence_run_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_runs: {
        Row: {
          account_ref: string | null
          answer: string | null
          answer_status: string
          completed_at: string | null
          confidence_inputs: Json
          created_at: string
          de_id: string | null
          id: string
          inquiry: string
          inquiry_embedding: string | null
          specialist_id: string | null
          status: string
          steps: Json
          tenant_id: string
        }
        Insert: {
          account_ref?: string | null
          answer?: string | null
          answer_status?: string
          completed_at?: string | null
          confidence_inputs?: Json
          created_at?: string
          de_id?: string | null
          id?: string
          inquiry: string
          inquiry_embedding?: string | null
          specialist_id?: string | null
          status?: string
          steps?: Json
          tenant_id: string
        }
        Update: {
          account_ref?: string | null
          answer?: string | null
          answer_status?: string
          completed_at?: string | null
          confidence_inputs?: Json
          created_at?: string
          de_id?: string | null
          id?: string
          inquiry?: string
          inquiry_embedding?: string | null
          specialist_id?: string | null
          status?: string
          steps?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "evidence_runs_specialist_id_fkey"
            columns: ["specialist_id"]
            isOneToOne: false
            referencedRelation: "specialist_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      exceptions: {
        Row: {
          account_id: string | null
          ai_reasoning: string | null
          amount: number | null
          confidence: number
          created_at: string
          detail: string | null
          exception_type: string
          final_treatment: string | null
          id: string
          is_risky: boolean
          proposed_action: string | null
          ref_id: string | null
          ref_table: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          status: string
          tenant_id: string
          title: string
          workspace_id: string | null
        }
        Insert: {
          account_id?: string | null
          ai_reasoning?: string | null
          amount?: number | null
          confidence?: number
          created_at?: string
          detail?: string | null
          exception_type: string
          final_treatment?: string | null
          id?: string
          is_risky?: boolean
          proposed_action?: string | null
          ref_id?: string | null
          ref_table?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string
          tenant_id: string
          title: string
          workspace_id?: string | null
        }
        Update: {
          account_id?: string | null
          ai_reasoning?: string | null
          amount?: number | null
          confidence?: number
          created_at?: string
          detail?: string | null
          exception_type?: string
          final_treatment?: string | null
          id?: string
          is_risky?: boolean
          proposed_action?: string | null
          ref_id?: string | null
          ref_table?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string
          tenant_id?: string
          title?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exceptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "fin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exceptions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_registry: {
        Row: {
          category: string | null
          created_at: string
          default_enabled: boolean
          description: string | null
          key: string
          label: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          default_enabled?: boolean
          description?: string | null
          key: string
          label: string
        }
        Update: {
          category?: string | null
          created_at?: string
          default_enabled?: boolean
          description?: string | null
          key?: string
          label?: string
        }
        Relationships: []
      }
      fin_accounts: {
        Row: {
          code: string
          created_at: string
          id: string
          is_bank: boolean
          name: string
          subtype: string | null
          tenant_id: string
          type: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_bank?: boolean
          name: string
          subtype?: string | null
          tenant_id: string
          type: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_bank?: boolean
          name?: string
          subtype?: string | null
          tenant_id?: string
          type?: string
        }
        Relationships: []
      }
      fin_documents: {
        Row: {
          created_at: string
          doc_type: string
          filename: string
          id: string
          ingested_count: number
          parse_summary: string | null
          row_count: number
          status: string
          storage_path: string | null
          tenant_id: string
          uploaded_by: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          doc_type: string
          filename: string
          id?: string
          ingested_count?: number
          parse_summary?: string | null
          row_count?: number
          status?: string
          storage_path?: string | null
          tenant_id: string
          uploaded_by?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          doc_type?: string
          filename?: string
          id?: string
          ingested_count?: number
          parse_summary?: string | null
          row_count?: number
          status?: string
          storage_path?: string | null
          tenant_id?: string
          uploaded_by?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_documents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      golden_qa: {
        Row: {
          active: boolean
          category: string
          created_at: string
          expected_fragments: string[]
          id: string
          min_confidence: number
          question: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          category?: string
          created_at?: string
          expected_fragments?: string[]
          id?: string
          min_confidence?: number
          question: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string
          created_at?: string
          expected_fragments?: string[]
          id?: string
          min_confidence?: number
          question?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "golden_qa_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      guardrail_rules: {
        Row: {
          active: boolean
          applies_to: string
          created_at: string
          created_by: string | null
          id: string
          pattern: string | null
          rule: string
          rule_type: string
          scope: string
          scope_ref: string | null
          severity: string
          tenant_id: string
          threshold: number | null
          updated_at: string
          version: number
        }
        Insert: {
          active?: boolean
          applies_to?: string
          created_at?: string
          created_by?: string | null
          id?: string
          pattern?: string | null
          rule: string
          rule_type: string
          scope?: string
          scope_ref?: string | null
          severity?: string
          tenant_id: string
          threshold?: number | null
          updated_at?: string
          version?: number
        }
        Update: {
          active?: boolean
          applies_to?: string
          created_at?: string
          created_by?: string | null
          id?: string
          pattern?: string | null
          rule?: string
          rule_type?: string
          scope?: string
          scope_ref?: string | null
          severity?: string
          tenant_id?: string
          threshold?: number | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "guardrail_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      health_score_config: {
        Row: {
          last_computed_at: string | null
          tenant_id: string
          thresholds: Json
          updated_at: string
          updated_by: string | null
          weights: Json
        }
        Insert: {
          last_computed_at?: string | null
          tenant_id: string
          thresholds?: Json
          updated_at?: string
          updated_by?: string | null
          weights?: Json
        }
        Update: {
          last_computed_at?: string | null
          tenant_id?: string
          thresholds?: Json
          updated_at?: string
          updated_by?: string | null
          weights?: Json
        }
        Relationships: [
          {
            foreignKeyName: "health_score_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      human_tasks: {
        Row: {
          account_id: string | null
          checklist_state: Json
          created_at: string
          decided_at: string | null
          decided_by: string | null
          detail: string
          id: string
          related_id: string | null
          related_table: string | null
          source: string
          status: string
          tenant_id: string
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          checklist_state?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          detail?: string
          id?: string
          related_id?: string | null
          related_table?: string | null
          source?: string
          status?: string
          tenant_id: string
          title: string
          type?: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          checklist_state?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          detail?: string
          id?: string
          related_id?: string | null
          related_table?: string | null
          source?: string
          status?: string
          tenant_id?: string
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "human_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "human_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_watch_state: {
        Row: {
          connector_id: string
          created_at: string
          id: string
          last_polled_at: string | null
          last_seen_external_ref: string | null
          last_seen_timestamp: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          connector_id: string
          created_at?: string
          id?: string
          last_polled_at?: string | null
          last_seen_external_ref?: string | null
          last_seen_timestamp?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          connector_id?: string
          created_at?: string
          id?: string
          last_polled_at?: string | null
          last_seen_external_ref?: string | null
          last_seen_timestamp?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_watch_state_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbox_watch_state_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount: number
          amount_paid: number
          created_at: string
          currency: string
          customer_id: string | null
          due_date: string | null
          has_pdf: boolean
          id: string
          invoice_number: string
          issue_date: string | null
          status: string
          tenant_id: string
          workspace_id: string | null
        }
        Insert: {
          amount?: number
          amount_paid?: number
          created_at?: string
          currency?: string
          customer_id?: string | null
          due_date?: string | null
          has_pdf?: boolean
          id?: string
          invoice_number: string
          issue_date?: string | null
          status?: string
          tenant_id: string
          workspace_id?: string | null
        }
        Update: {
          amount?: number
          amount_paid?: number
          created_at?: string
          currency?: string
          customer_id?: string | null
          due_date?: string | null
          has_pdf?: boolean
          id?: string
          invoice_number?: string
          issue_date?: string | null
          status?: string
          tenant_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entries: {
        Row: {
          account_id: string | null
          created_at: string
          credit: number
          debit: number
          entry_date: string | null
          id: string
          memo: string | null
          source: string | null
          tenant_id: string
          workspace_id: string | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          credit?: number
          debit?: number
          entry_date?: string | null
          id?: string
          memo?: string | null
          source?: string | null
          tenant_id: string
          workspace_id?: string | null
        }
        Update: {
          account_id?: string | null
          created_at?: string
          credit?: number
          debit?: number
          entry_date?: string | null
          id?: string
          memo?: string | null
          source?: string | null
          tenant_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "fin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_articles: {
        Row: {
          audience: string
          body: string
          category: string | null
          created_at: string | null
          created_by: string | null
          embedding: string | null
          freshness_score: number | null
          helpful_count: number | null
          id: string
          module: string | null
          not_helpful_count: number | null
          product: string | null
          published_at: string | null
          quality_score: number | null
          search_tsv: unknown
          status: string
          summary: string | null
          tags: string[] | null
          tenant_id: string
          title: string
          updated_at: string | null
          view_count: number | null
        }
        Insert: {
          audience?: string
          body: string
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          embedding?: string | null
          freshness_score?: number | null
          helpful_count?: number | null
          id?: string
          module?: string | null
          not_helpful_count?: number | null
          product?: string | null
          published_at?: string | null
          quality_score?: number | null
          search_tsv?: unknown
          status?: string
          summary?: string | null
          tags?: string[] | null
          tenant_id: string
          title: string
          updated_at?: string | null
          view_count?: number | null
        }
        Update: {
          audience?: string
          body?: string
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          embedding?: string | null
          freshness_score?: number | null
          helpful_count?: number | null
          id?: string
          module?: string | null
          not_helpful_count?: number | null
          product?: string | null
          published_at?: string | null
          quality_score?: number | null
          search_tsv?: unknown
          status?: string
          summary?: string | null
          tags?: string[] | null
          tenant_id?: string
          title?: string
          updated_at?: string | null
          view_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_articles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_chunks: {
        Row: {
          article_id: string | null
          chunk_index: number
          content: string
          created_at: string
          embedding: string | null
          id: string
          metadata: Json
          source_type: string
          source_url: string | null
          tenant_id: string
          title: string
        }
        Insert: {
          article_id?: string | null
          chunk_index?: number
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json
          source_type?: string
          source_url?: string | null
          tenant_id: string
          title?: string
        }
        Update: {
          article_id?: string | null
          chunk_index?: number
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          metadata?: Json
          source_type?: string
          source_url?: string | null
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_chunks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_doc_chunks: {
        Row: {
          account_id: string | null
          chunk_index: number
          content: string
          created_at: string
          doc_id: string
          embedding: string | null
          id: string
          tenant_id: string
        }
        Insert: {
          account_id?: string | null
          chunk_index?: number
          content: string
          created_at?: string
          doc_id: string
          embedding?: string | null
          id?: string
          tenant_id: string
        }
        Update: {
          account_id?: string | null
          chunk_index?: number
          content?: string
          created_at?: string
          doc_id?: string
          embedding?: string | null
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_doc_chunks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_doc_chunks_doc_id_fkey"
            columns: ["doc_id"]
            isOneToOne: false
            referencedRelation: "knowledge_docs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_doc_chunks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_doc_scopes: {
        Row: {
          created_at: string
          doc_id: string
          id: string
          subject_id: string
          subject_kind: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          doc_id: string
          id?: string
          subject_id: string
          subject_kind: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          doc_id?: string
          id?: string
          subject_id?: string
          subject_kind?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_doc_scopes_doc_id_fkey"
            columns: ["doc_id"]
            isOneToOne: false
            referencedRelation: "knowledge_docs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_doc_scopes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_docs: {
        Row: {
          account_id: string | null
          content: string
          created_at: string
          external_ref: string | null
          id: string
          is_current: boolean
          last_verified_at: string | null
          previous_version_id: string | null
          search_tsv: unknown
          source: string
          tags: string[]
          tenant_id: string
          title: string
          updated_at: string
          visibility: string
        }
        Insert: {
          account_id?: string | null
          content?: string
          created_at?: string
          external_ref?: string | null
          id?: string
          is_current?: boolean
          last_verified_at?: string | null
          previous_version_id?: string | null
          search_tsv?: unknown
          source?: string
          tags?: string[]
          tenant_id: string
          title: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          account_id?: string | null
          content?: string
          created_at?: string
          external_ref?: string | null
          id?: string
          is_current?: boolean
          last_verified_at?: string | null
          previous_version_id?: string | null
          search_tsv?: unknown
          source?: string
          tags?: string[]
          tenant_id?: string
          title?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_docs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_docs_previous_version_id_fkey"
            columns: ["previous_version_id"]
            isOneToOne: false
            referencedRelation: "knowledge_docs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_docs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_gap_cluster_members: {
        Row: {
          added_at: string
          cluster_id: string
          evidence_run_id: string
          frustration_score: number
          id: string
          similarity_to_representative: number | null
        }
        Insert: {
          added_at?: string
          cluster_id: string
          evidence_run_id: string
          frustration_score?: number
          id?: string
          similarity_to_representative?: number | null
        }
        Update: {
          added_at?: string
          cluster_id?: string
          evidence_run_id?: string
          frustration_score?: number
          id?: string
          similarity_to_representative?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_gap_cluster_members_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "knowledge_gap_clusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_gap_cluster_members_evidence_run_id_fkey"
            columns: ["evidence_run_id"]
            isOneToOne: true
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_gap_clusters: {
        Row: {
          category: string | null
          created_at: string
          first_seen_at: string
          fix_applied_at: string | null
          id: string
          last_seen_at: string
          member_count: number
          pre_fix_avg_confidence: number | null
          recurred_after_fix: boolean
          recurrence_count: number
          representative_run_id: string
          reviewer_summary: string | null
          revision_request_id: string | null
          root_cause_category: string | null
          severity_score: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          first_seen_at?: string
          fix_applied_at?: string | null
          id?: string
          last_seen_at?: string
          member_count?: number
          pre_fix_avg_confidence?: number | null
          recurred_after_fix?: boolean
          recurrence_count?: number
          representative_run_id: string
          reviewer_summary?: string | null
          revision_request_id?: string | null
          root_cause_category?: string | null
          severity_score?: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          first_seen_at?: string
          fix_applied_at?: string | null
          id?: string
          last_seen_at?: string
          member_count?: number
          pre_fix_avg_confidence?: number | null
          recurred_after_fix?: boolean
          recurrence_count?: number
          representative_run_id?: string
          reviewer_summary?: string | null
          revision_request_id?: string | null
          root_cause_category?: string | null
          severity_score?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_gap_clusters_representative_run_id_fkey"
            columns: ["representative_run_id"]
            isOneToOne: false
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_gap_clusters_revision_request_id_fkey"
            columns: ["revision_request_id"]
            isOneToOne: false
            referencedRelation: "knowledge_revision_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_gap_clusters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_gap_policies: {
        Row: {
          category: string | null
          created_at: string
          enabled: boolean
          id: string
          min_cluster_size: number
          min_confidence_floor: number
          similarity_threshold: number
          tenant_id: string
          updated_at: string
          window_days: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          min_cluster_size?: number
          min_confidence_floor?: number
          similarity_threshold?: number
          tenant_id: string
          updated_at?: string
          window_days?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          min_cluster_size?: number
          min_confidence_floor?: number
          similarity_threshold?: number
          tenant_id?: string
          updated_at?: string
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_gap_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_revision_requests: {
        Row: {
          applied_doc_id: string | null
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          evidence_run_id: string
          feedback_id: string
          id: string
          proposed_body_md: string
          proposed_title: string
          source_doc_id: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          applied_doc_id?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          evidence_run_id: string
          feedback_id: string
          id?: string
          proposed_body_md: string
          proposed_title: string
          source_doc_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          applied_doc_id?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          evidence_run_id?: string
          feedback_id?: string
          id?: string
          proposed_body_md?: string
          proposed_title?: string
          source_doc_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_revision_requests_applied_doc_id_fkey"
            columns: ["applied_doc_id"]
            isOneToOne: false
            referencedRelation: "knowledge_docs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_revision_requests_evidence_run_id_fkey"
            columns: ["evidence_run_id"]
            isOneToOne: false
            referencedRelation: "evidence_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_revision_requests_feedback_id_fkey"
            columns: ["feedback_id"]
            isOneToOne: false
            referencedRelation: "evidence_feedback"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_revision_requests_source_doc_id_fkey"
            columns: ["source_doc_id"]
            isOneToOne: false
            referencedRelation: "knowledge_docs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_revision_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      media_assets: {
        Row: {
          created_at: string
          created_by: string | null
          definition_id: string | null
          extracted: boolean
          id: string
          kind: string
          knowledge_doc_id: string | null
          mime: string
          profile_id: string | null
          quality_flags: Json
          size_bytes: number
          sort_order: number
          storage_path: string
          tags: string[]
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          definition_id?: string | null
          extracted?: boolean
          id?: string
          kind: string
          knowledge_doc_id?: string | null
          mime?: string
          profile_id?: string | null
          quality_flags?: Json
          size_bytes?: number
          sort_order?: number
          storage_path: string
          tags?: string[]
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          definition_id?: string | null
          extracted?: boolean
          id?: string
          kind?: string
          knowledge_doc_id?: string | null
          mime?: string
          profile_id?: string | null
          quality_flags?: Json
          size_bytes?: number
          sort_order?: number
          storage_path?: string
          tags?: string[]
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_assets_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_assets_knowledge_doc_id_fkey"
            columns: ["knowledge_doc_id"]
            isOneToOne: false
            referencedRelation: "knowledge_docs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_assets_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "specialist_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          audit_note: string | null
          audit_verdict: string | null
          confidence_score: number | null
          content: string
          conversation_id: string
          created_at: string | null
          id: string
          metadata: Json | null
          requires_approval: boolean | null
          role: string
          sources: Json | null
          tenant_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          audit_note?: string | null
          audit_verdict?: string | null
          confidence_score?: number | null
          content: string
          conversation_id: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          requires_approval?: boolean | null
          role: string
          sources?: Json | null
          tenant_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          audit_note?: string | null
          audit_verdict?: string | null
          confidence_score?: number | null
          content?: string
          conversation_id?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          requires_approval?: boolean | null
          role?: string
          sources?: Json | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          payload: Json
          sent_at: string | null
          status: string
          tenant_id: string
          type: string
        }
        Insert: {
          created_at?: string
          id?: string
          payload?: Json
          sent_at?: string | null
          status?: string
          tenant_id: string
          type: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          sent_at?: string | null
          status?: string
          tenant_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_connect_states: {
        Row: {
          connector_id: string
          created_at: string
          provider: string
          redirect_uri: string
          state: string
          tenant_id: string
        }
        Insert: {
          connector_id: string
          created_at?: string
          provider: string
          redirect_uri: string
          state: string
          tenant_id: string
        }
        Update: {
          connector_id?: string
          created_at?: string
          provider?: string
          redirect_uri?: string
          state?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_connect_states_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_connect_states_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_projects: {
        Row: {
          account_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          items_state: Json
          name: string
          progress_pct: number
          status: string
          target_golive: string | null
          template_version_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          items_state?: Json
          name: string
          progress_pct?: number
          status?: string
          target_golive?: string | null
          template_version_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          items_state?: Json
          name?: string
          progress_pct?: number
          status?: string
          target_golive?: string | null
          template_version_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_projects_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_projects_template_version_id_fkey"
            columns: ["template_version_id"]
            isOneToOne: false
            referencedRelation: "onboarding_template_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_projects_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_template_versions: {
        Row: {
          description: string
          id: string
          items: Json
          name: string
          published_at: string
          published_by: string | null
          template_id: string
          tenant_id: string
          version: number
        }
        Insert: {
          description?: string
          id?: string
          items: Json
          name: string
          published_at?: string
          published_by?: string | null
          template_id: string
          tenant_id: string
          version: number
        }
        Update: {
          description?: string
          id?: string
          items?: Json
          name?: string
          published_at?: string
          published_by?: string | null
          template_id?: string
          tenant_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_template_versions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "onboarding_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_template_versions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_templates: {
        Row: {
          created_at: string
          description: string
          id: string
          items: Json
          name: string
          status: string
          tenant_id: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          items?: Json
          name: string
          status?: string
          tenant_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          items?: Json
          name?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunities: {
        Row: {
          account_id: string | null
          amount_cents: number | null
          close_date: string | null
          closed_at: string | null
          company_name: string
          created_at: string
          external_ref: string | null
          id: string
          lost_reason: string | null
          name: string
          owner: string
          source: string
          stage: string
          stage_history: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          amount_cents?: number | null
          close_date?: string | null
          closed_at?: string | null
          company_name?: string
          created_at?: string
          external_ref?: string | null
          id?: string
          lost_reason?: string | null
          name: string
          owner?: string
          source?: string
          stage?: string
          stage_history?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          amount_cents?: number | null
          close_date?: string | null
          closed_at?: string | null
          company_name?: string
          created_at?: string
          external_ref?: string | null
          id?: string
          lost_reason?: string | null
          name?: string
          owner?: string
          source?: string
          stage?: string
          stage_history?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opportunities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          bill_id: string | null
          created_at: string
          currency: string
          direction: string
          external_ref: string | null
          id: string
          invoice_id: string | null
          paid_date: string | null
          source: string | null
          tenant_id: string
          workspace_id: string | null
        }
        Insert: {
          amount?: number
          bill_id?: string | null
          created_at?: string
          currency?: string
          direction: string
          external_ref?: string | null
          id?: string
          invoice_id?: string | null
          paid_date?: string | null
          source?: string | null
          tenant_id: string
          workspace_id?: string | null
        }
        Update: {
          amount?: number
          bill_id?: string | null
          created_at?: string
          currency?: string
          direction?: string
          external_ref?: string | null
          id?: string
          invoice_id?: string | null
          paid_date?: string | null
          source?: string | null
          tenant_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "close_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_access_events: {
        Row: {
          created_at: string
          detail: Json
          event: string
          id: string
          operator_name: string | null
          operator_user_id: string | null
          session_key: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          event: string
          id?: string
          operator_name?: string | null
          operator_user_id?: string | null
          session_key: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          event?: string
          id?: string
          operator_name?: string | null
          operator_user_id?: string | null
          session_key?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_access_events_operator_user_id_fkey"
            columns: ["operator_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "platform_access_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_capability_grants: {
        Row: {
          capability: string
          created_at: string
          effect: string
          granted_by: string | null
          id: string
          note: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capability: string
          created_at?: string
          effect: string
          granted_by?: string | null
          id?: string
          note?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capability?: string
          created_at?: string
          effect?: string
          granted_by?: string | null
          id?: string
          note?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_capability_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "platform_capability_grants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      platform_config: {
        Row: {
          key: string
          secret_id: string | null
          updated_at: string
          value: string | null
        }
        Insert: {
          key: string
          secret_id?: string | null
          updated_at?: string
          value?: string | null
        }
        Update: {
          key?: string
          secret_id?: string | null
          updated_at?: string
          value?: string | null
        }
        Relationships: []
      }
      platform_invites: {
        Row: {
          created_at: string
          email: string
          id: string
          invite_code: string
          invited_by: string | null
          redeemed_at: string | null
          redeemed_by: string | null
          role: string
          status: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          invite_code?: string
          invited_by?: string | null
          redeemed_at?: string | null
          redeemed_by?: string | null
          role: string
          status?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          invite_code?: string
          invited_by?: string | null
          redeemed_at?: string | null
          redeemed_by?: string | null
          role?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "platform_invites_redeemed_by_fkey"
            columns: ["redeemed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      playbook_definitions: {
        Row: {
          created_at: string
          created_by: string | null
          de_id: string | null
          description: string
          id: string
          intended_de_name: string | null
          key: string
          name: string
          status: string
          steps: Json
          tenant_id: string
          trigger_type: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          de_id?: string | null
          description?: string
          id?: string
          intended_de_name?: string | null
          key: string
          name: string
          status?: string
          steps?: Json
          tenant_id: string
          trigger_type?: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          de_id?: string | null
          description?: string
          id?: string
          intended_de_name?: string | null
          key?: string
          name?: string
          status?: string
          steps?: Json
          tenant_id?: string
          trigger_type?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "playbook_definitions_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_definitions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      playbook_event_rules: {
        Row: {
          active: boolean
          cooldown_hours: number
          created_at: string
          created_by: string | null
          definition_id: string
          event_key: string
          id: string
          last_fired_at: string | null
          params: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          cooldown_hours?: number
          created_at?: string
          created_by?: string | null
          definition_id: string
          event_key: string
          id?: string
          last_fired_at?: string | null
          params?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          cooldown_hours?: number
          created_at?: string
          created_by?: string | null
          definition_id?: string
          event_key?: string
          id?: string
          last_fired_at?: string | null
          params?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "playbook_event_rules_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_event_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      playbook_runs: {
        Row: {
          account_id: string | null
          context: Json
          created_at: string
          current_step: number
          definition_id: string | null
          definition_version: number | null
          id: string
          parent_run_id: string | null
          playbook_key: string
          resume_at: string | null
          status: string
          steps: Json
          tenant_id: string
          updated_at: string
          waiting_task_id: string | null
        }
        Insert: {
          account_id?: string | null
          context?: Json
          created_at?: string
          current_step?: number
          definition_id?: string | null
          definition_version?: number | null
          id?: string
          parent_run_id?: string | null
          playbook_key?: string
          resume_at?: string | null
          status?: string
          steps?: Json
          tenant_id: string
          updated_at?: string
          waiting_task_id?: string | null
        }
        Update: {
          account_id?: string | null
          context?: Json
          created_at?: string
          current_step?: number
          definition_id?: string | null
          definition_version?: number | null
          id?: string
          parent_run_id?: string | null
          playbook_key?: string
          resume_at?: string | null
          status?: string
          steps?: Json
          tenant_id?: string
          updated_at?: string
          waiting_task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "playbook_runs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_runs_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_runs_parent_run_id_fkey"
            columns: ["parent_run_id"]
            isOneToOne: false
            referencedRelation: "playbook_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      playbook_schedules: {
        Row: {
          account_selector: Json
          active: boolean
          cadence: string
          created_at: string
          created_by: string | null
          definition_id: string
          id: string
          last_fired_at: string | null
          monthly_day: number | null
          next_fire_at: string | null
          run_at_hour: number
          tenant_id: string
          updated_at: string
          weekly_day: number | null
        }
        Insert: {
          account_selector?: Json
          active?: boolean
          cadence: string
          created_at?: string
          created_by?: string | null
          definition_id: string
          id?: string
          last_fired_at?: string | null
          monthly_day?: number | null
          next_fire_at?: string | null
          run_at_hour?: number
          tenant_id: string
          updated_at?: string
          weekly_day?: number | null
        }
        Update: {
          account_selector?: Json
          active?: boolean
          cadence?: string
          created_at?: string
          created_by?: string | null
          definition_id?: string
          id?: string
          last_fired_at?: string | null
          monthly_day?: number | null
          next_fire_at?: string | null
          run_at_hour?: number
          tenant_id?: string
          updated_at?: string
          weekly_day?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "playbook_schedules_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_schedules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      playbook_trigger_fires: {
        Row: {
          definition_id: string | null
          detail: string
          event_rule_id: string | null
          fired_at: string
          id: string
          run_id: string | null
          schedule_id: string | null
          source: string
          status: string
          target_account_id: string | null
          target_ref: string | null
          tenant_id: string
        }
        Insert: {
          definition_id?: string | null
          detail?: string
          event_rule_id?: string | null
          fired_at?: string
          id?: string
          run_id?: string | null
          schedule_id?: string | null
          source: string
          status?: string
          target_account_id?: string | null
          target_ref?: string | null
          tenant_id: string
        }
        Update: {
          definition_id?: string | null
          detail?: string
          event_rule_id?: string | null
          fired_at?: string
          id?: string
          run_id?: string | null
          schedule_id?: string | null
          source?: string
          status?: string
          target_account_id?: string | null
          target_ref?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "playbook_trigger_fires_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_trigger_fires_event_rule_id_fkey"
            columns: ["event_rule_id"]
            isOneToOne: false
            referencedRelation: "playbook_event_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_trigger_fires_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "playbook_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_trigger_fires_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "playbook_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbook_trigger_fires_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      playbook_versions: {
        Row: {
          definition_id: string
          id: string
          published_at: string
          published_by: string | null
          steps: Json
          version: number
        }
        Insert: {
          definition_id: string
          id?: string
          published_at?: string
          published_by?: string | null
          steps: Json
          version: number
        }
        Update: {
          definition_id?: string
          id?: string
          published_at?: string
          published_by?: string | null
          steps?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "playbook_versions_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "playbook_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      playbooks: {
        Row: {
          approval_points: Json
          business_objective: string
          capabilities_used: string[]
          certified_at: string | null
          certified_by: string | null
          connector_requirements: Json
          created_at: string
          created_by: string | null
          de_handled_rate: number
          decision_rules: Json
          digital_employee_id: string | null
          domain: string
          escalation_rules: Json
          estimated_cost_usd: number | null
          estimated_duration_ms: number | null
          exception_handlers: Json
          expected_outputs: Json
          human_approval_required: boolean
          id: string
          is_base_playbook: boolean
          knowledge_collections: string[]
          kpis: Json
          lifecycle_status: string
          name: string
          next_review_due: string | null
          owner_role: string | null
          parent_playbook_id: string | null
          risk_level: string
          slug: string
          success_rate: number
          tasks_this_month: number
          tenant_id: string
          trigger_type: string
          updated_at: string
          version: number
        }
        Insert: {
          approval_points?: Json
          business_objective?: string
          capabilities_used?: string[]
          certified_at?: string | null
          certified_by?: string | null
          connector_requirements?: Json
          created_at?: string
          created_by?: string | null
          de_handled_rate?: number
          decision_rules?: Json
          digital_employee_id?: string | null
          domain?: string
          escalation_rules?: Json
          estimated_cost_usd?: number | null
          estimated_duration_ms?: number | null
          exception_handlers?: Json
          expected_outputs?: Json
          human_approval_required?: boolean
          id?: string
          is_base_playbook?: boolean
          knowledge_collections?: string[]
          kpis?: Json
          lifecycle_status?: string
          name: string
          next_review_due?: string | null
          owner_role?: string | null
          parent_playbook_id?: string | null
          risk_level?: string
          slug: string
          success_rate?: number
          tasks_this_month?: number
          tenant_id: string
          trigger_type?: string
          updated_at?: string
          version?: number
        }
        Update: {
          approval_points?: Json
          business_objective?: string
          capabilities_used?: string[]
          certified_at?: string | null
          certified_by?: string | null
          connector_requirements?: Json
          created_at?: string
          created_by?: string | null
          de_handled_rate?: number
          decision_rules?: Json
          digital_employee_id?: string | null
          domain?: string
          escalation_rules?: Json
          estimated_cost_usd?: number | null
          estimated_duration_ms?: number | null
          exception_handlers?: Json
          expected_outputs?: Json
          human_approval_required?: boolean
          id?: string
          is_base_playbook?: boolean
          knowledge_collections?: string[]
          kpis?: Json
          lifecycle_status?: string
          name?: string
          next_review_due?: string | null
          owner_role?: string | null
          parent_playbook_id?: string | null
          risk_level?: string
          slug?: string
          success_rate?: number
          tasks_this_month?: number
          tenant_id?: string
          trigger_type?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "playbooks_digital_employee_id_fkey"
            columns: ["digital_employee_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbooks_parent_playbook_id_fkey"
            columns: ["parent_playbook_id"]
            isOneToOne: false
            referencedRelation: "playbooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "playbooks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar: string | null
          created_at: string | null
          department: string
          full_name: string | null
          id: string
          invited_by: string | null
          is_active: boolean | null
          last_seen_at: string | null
          layer: string
          role: string
          tenant_id: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          avatar?: string | null
          created_at?: string | null
          department?: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          is_active?: boolean | null
          last_seen_at?: string | null
          layer?: string
          role?: string
          tenant_id?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          avatar?: string | null
          created_at?: string | null
          department?: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          is_active?: boolean | null
          last_seen_at?: string | null
          layer?: string
          role?: string
          tenant_id?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      remote_access_write_log: {
        Row: {
          created_at: string
          id: number
          new_data: Json | null
          old_data: Json | null
          operation: string
          operator_name: string | null
          operator_user_id: string
          row_pk: string | null
          session_key: string | null
          table_name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          operation: string
          operator_name?: string | null
          operator_user_id: string
          row_pk?: string | null
          session_key?: string | null
          table_name: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          operation?: string
          operator_name?: string | null
          operator_user_id?: string
          row_pk?: string | null
          session_key?: string | null
          table_name?: string
          tenant_id?: string
        }
        Relationships: []
      }
      renewal_invoices: {
        Row: {
          account_id: string
          amount_cents: number
          cadence_stage: number
          created_at: string
          due_date: string | null
          id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          amount_cents?: number
          cadence_stage?: number
          created_at?: string
          due_date?: string | null
          id?: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          amount_cents?: number
          cadence_stage?: number
          created_at?: string
          due_date?: string | null
          id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "renewal_invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "renewal_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scribe_requests: {
        Row: {
          action_definition_id: string | null
          action_key: string
          connector_id: string
          consultation_id: string
          created_at: string
          executed_at: string | null
          external_ref: string
          id: string
          payload: Json
          payload_source: string
          profile_id: string
          result: Json | null
          status: string
          task_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          action_definition_id?: string | null
          action_key: string
          connector_id: string
          consultation_id: string
          created_at?: string
          executed_at?: string | null
          external_ref: string
          id?: string
          payload?: Json
          payload_source?: string
          profile_id: string
          result?: Json | null
          status?: string
          task_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          action_definition_id?: string | null
          action_key?: string
          connector_id?: string
          consultation_id?: string
          created_at?: string
          executed_at?: string | null
          external_ref?: string
          id?: string
          payload?: Json
          payload_source?: string
          profile_id?: string
          result?: Json | null
          status?: string
          task_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scribe_requests_action_definition_id_fkey"
            columns: ["action_definition_id"]
            isOneToOne: false
            referencedRelation: "action_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scribe_requests_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scribe_requests_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "spec_consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scribe_requests_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "specialist_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scribe_requests_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scribe_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_catalog: {
        Row: {
          category: string
          description: string
          higher_is_better: boolean
          min_sample: number
          name: string
          signal_label: string
          skill_key: string
          sort_order: number
        }
        Insert: {
          category: string
          description: string
          higher_is_better?: boolean
          min_sample: number
          name: string
          signal_label: string
          skill_key: string
          sort_order?: number
        }
        Update: {
          category?: string
          description?: string
          higher_is_better?: boolean
          min_sample?: number
          name?: string
          signal_label?: string
          skill_key?: string
          sort_order?: number
        }
        Relationships: []
      }
      spec_consultations: {
        Row: {
          answer: string | null
          confidence: number | null
          created_at: string
          id: string
          profile_id: string
          question: string
          requested_by: string
          run_id: string | null
          sources_used: Json
          status: string
          tenant_id: string
        }
        Insert: {
          answer?: string | null
          confidence?: number | null
          created_at?: string
          id?: string
          profile_id: string
          question: string
          requested_by?: string
          run_id?: string | null
          sources_used?: Json
          status?: string
          tenant_id: string
        }
        Update: {
          answer?: string | null
          confidence?: number | null
          created_at?: string
          id?: string
          profile_id?: string
          question?: string
          requested_by?: string
          run_id?: string | null
          sources_used?: Json
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "spec_consultations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "specialist_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spec_consultations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      specialist_profiles: {
        Row: {
          charter: string
          created_at: string
          id: string
          key: string
          name: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          charter?: string
          created_at?: string
          id?: string
          key: string
          name: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          charter?: string
          created_at?: string
          id?: string
          key?: string
          name?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "specialist_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      specialist_source_secrets: {
        Row: {
          created_at: string
          secret: string | null
          secret_id: string | null
          source_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          secret?: string | null
          secret_id?: string | null
          source_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          secret?: string | null
          secret_id?: string | null
          source_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "specialist_source_secrets_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: true
            referencedRelation: "specialist_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      specialist_sources: {
        Row: {
          access_mode: string
          config: Json
          created_at: string
          enabled: boolean
          id: string
          label: string
          profile_id: string
          source_type: string
          updated_at: string
        }
        Insert: {
          access_mode: string
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          profile_id: string
          source_type: string
          updated_at?: string
        }
        Update: {
          access_mode?: string
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          profile_id?: string
          source_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "specialist_sources_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "specialist_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staleness_escalations: {
        Row: {
          created_at: string
          first_detected_at: string
          human_task_id: string | null
          id: string
          last_escalated_at: string
          resolved_at: string | null
          target_id: string
          target_kind: string
          tenant_id: string
          tier: string
        }
        Insert: {
          created_at?: string
          first_detected_at?: string
          human_task_id?: string | null
          id?: string
          last_escalated_at?: string
          resolved_at?: string | null
          target_id: string
          target_kind: string
          tenant_id: string
          tier: string
        }
        Update: {
          created_at?: string
          first_detected_at?: string
          human_task_id?: string | null
          id?: string
          last_escalated_at?: string
          resolved_at?: string | null
          target_id?: string
          target_kind?: string
          tenant_id?: string
          tier?: string
        }
        Relationships: [
          {
            foreignKeyName: "staleness_escalations_human_task_id_fkey"
            columns: ["human_task_id"]
            isOneToOne: false
            referencedRelation: "human_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staleness_escalations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staleness_policies: {
        Row: {
          breach_after: string
          created_at: string
          enabled: boolean
          id: string
          target_kind: string
          tenant_id: string
          updated_at: string
          warning_after: string
        }
        Insert: {
          breach_after: string
          created_at?: string
          enabled?: boolean
          id?: string
          target_kind: string
          tenant_id: string
          updated_at?: string
          warning_after: string
        }
        Update: {
          breach_after?: string
          created_at?: string
          enabled?: boolean
          id?: string
          target_kind?: string
          tenant_id?: string
          updated_at?: string
          warning_after?: string
        }
        Relationships: [
          {
            foreignKeyName: "staleness_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          account_id: string | null
          assignee: string
          body: string
          created_at: string
          de_confidence: number | null
          external_ref: string | null
          id: string
          priority: string
          resolved_at: string | null
          source: string
          status: string
          subject: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          assignee?: string
          body?: string
          created_at?: string
          de_confidence?: number | null
          external_ref?: string | null
          id?: string
          priority?: string
          resolved_at?: string | null
          source?: string
          status?: string
          subject: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          assignee?: string
          body?: string
          created_at?: string
          de_confidence?: number | null
          external_ref?: string | null
          id?: string
          priority?: string
          resolved_at?: string | null
          source?: string
          status?: string
          subject?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "customer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      system_categories: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          key: string
          label: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string
          key: string
          label: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          key?: string
          label?: string
        }
        Relationships: []
      }
      tenant_activity_log: {
        Row: {
          actor_name: string | null
          actor_role: string | null
          actor_user_id: string
          created_at: string
          id: number
          new_data: Json | null
          old_data: Json | null
          operation: string
          row_pk: string | null
          table_name: string
          tenant_id: string
        }
        Insert: {
          actor_name?: string | null
          actor_role?: string | null
          actor_user_id: string
          created_at?: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          operation: string
          row_pk?: string | null
          table_name: string
          tenant_id: string
        }
        Update: {
          actor_name?: string | null
          actor_role?: string | null
          actor_user_id?: string
          created_at?: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          operation?: string
          row_pk?: string | null
          table_name?: string
          tenant_id?: string
        }
        Relationships: []
      }
      tenant_ai_usage: {
        Row: {
          id: string
          tenant_id: string
          tokens_used: number
          updated_at: string
          year_month: string
        }
        Insert: {
          id?: string
          tenant_id: string
          tokens_used?: number
          updated_at?: string
          year_month: string
        }
        Update: {
          id?: string
          tenant_id?: string
          tokens_used?: number
          updated_at?: string
          year_month?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ai_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ancestry: {
        Row: {
          ancestor_id: string
          depth: number
          tenant_id: string
        }
        Insert: {
          ancestor_id: string
          depth: number
          tenant_id: string
        }
        Update: {
          ancestor_id?: string
          depth?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ancestry_ancestor_id_fkey"
            columns: ["ancestor_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_ancestry_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          display_hint: string
          id: string
          key_hash: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          display_hint: string
          id?: string
          key_hash: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes?: string[]
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          display_hint?: string
          id?: string
          key_hash?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_api_keys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tenant_api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_entity_fields: {
        Row: {
          created_at: string
          created_by: string | null
          field_key: string
          field_type: string
          id: string
          label: string
          position: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          field_key: string
          field_type?: string
          id?: string
          label: string
          position?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          field_key?: string
          field_type?: string
          id?: string
          label?: string
          position?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_entity_fields_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_feature_overrides: {
        Row: {
          enabled: boolean
          feature_key: string
          note: string | null
          set_by: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          enabled: boolean
          feature_key: string
          note?: string | null
          set_by?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          feature_key?: string
          note?: string | null
          set_by?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_feature_overrides_feature_key_fkey"
            columns: ["feature_key"]
            isOneToOne: false
            referencedRelation: "feature_registry"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "tenant_feature_overrides_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tenant_feature_overrides_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ip_allowlist_entries: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          ip_range: unknown
          label: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          ip_range: unknown
          label?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          ip_range?: unknown
          label?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ip_allowlist_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tenant_ip_allowlist_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ip_allowlists: {
        Row: {
          enabled: boolean
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ip_allowlists_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_ip_allowlists_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      tenant_pipeline_stages: {
        Row: {
          created_at: string
          id: string
          label: string
          position: number
          stage_key: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          position?: number
          stage_key: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          position?: number
          stage_key?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_pipeline_stages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_provisioning_requests: {
        Row: {
          created_at: string
          created_tenant_id: string | null
          decided_at: string | null
          id: string
          proposed_industry: string | null
          proposed_name: string
          proposed_parent_tenant_id: string | null
          rejection_reason: string | null
          requested_by_user_id: string
          reviewed_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          created_tenant_id?: string | null
          decided_at?: string | null
          id?: string
          proposed_industry?: string | null
          proposed_name: string
          proposed_parent_tenant_id?: string | null
          rejection_reason?: string | null
          requested_by_user_id: string
          reviewed_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          created_tenant_id?: string | null
          decided_at?: string | null
          id?: string
          proposed_industry?: string | null
          proposed_name?: string
          proposed_parent_tenant_id?: string | null
          rejection_reason?: string | null
          requested_by_user_id?: string
          reviewed_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_provisioning_requests_created_tenant_id_fkey"
            columns: ["created_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_provisioning_requests_proposed_parent_tenant_id_fkey"
            columns: ["proposed_parent_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_provisioning_requests_requested_by_user_id_fkey"
            columns: ["requested_by_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "tenant_provisioning_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      tenant_session_policies: {
        Row: {
          mfa_required: boolean
          tenant_id: string
          timeout_minutes: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          mfa_required?: boolean
          tenant_id: string
          timeout_minutes?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          mfa_required?: boolean
          tenant_id?: string
          timeout_minutes?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_session_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_session_policies_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      tenants: {
        Row: {
          accent_color: string | null
          allow_self_serve_subtenants: boolean
          created_at: string | null
          id: string
          industry: string | null
          logo_url: string | null
          monthly_token_budget: number
          name: string
          parent_tenant_id: string | null
          plan: string
          settings: Json | null
          slug: string
          status: string
          trial_ends_at: string | null
          updated_at: string | null
          vocabulary: Json
        }
        Insert: {
          accent_color?: string | null
          allow_self_serve_subtenants?: boolean
          created_at?: string | null
          id?: string
          industry?: string | null
          logo_url?: string | null
          monthly_token_budget?: number
          name: string
          parent_tenant_id?: string | null
          plan?: string
          settings?: Json | null
          slug: string
          status?: string
          trial_ends_at?: string | null
          updated_at?: string | null
          vocabulary?: Json
        }
        Update: {
          accent_color?: string | null
          allow_self_serve_subtenants?: boolean
          created_at?: string | null
          id?: string
          industry?: string | null
          logo_url?: string | null
          monthly_token_budget?: number
          name?: string
          parent_tenant_id?: string | null
          plan?: string
          settings?: Json | null
          slug?: string
          status?: string
          trial_ends_at?: string | null
          updated_at?: string | null
          vocabulary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tenants_parent_tenant_id_fkey"
            columns: ["parent_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      trust_policies: {
        Row: {
          action_category: string
          baseline_level: number
          created_at: string
          criteria: Json
          current_level: number
          de_id: string | null
          id: string
          pending_evidence: Json | null
          pending_task_id: string | null
          requested_at: string | null
          requested_by: string | null
          source_category: string | null
          status: string
          target_level: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          action_category: string
          baseline_level?: number
          created_at?: string
          criteria?: Json
          current_level?: number
          de_id?: string | null
          id?: string
          pending_evidence?: Json | null
          pending_task_id?: string | null
          requested_at?: string | null
          requested_by?: string | null
          source_category?: string | null
          status?: string
          target_level?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          action_category?: string
          baseline_level?: number
          created_at?: string
          criteria?: Json
          current_level?: number
          de_id?: string | null
          id?: string
          pending_evidence?: Json | null
          pending_task_id?: string | null
          requested_at?: string | null
          requested_by?: string | null
          source_category?: string | null
          status?: string
          target_level?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_policies_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_policies_source_category_fkey"
            columns: ["source_category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "trust_policies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_metrics: {
        Row: {
          day: string
          id: string
          metric: string
          tenant_id: string
          value: number
        }
        Insert: {
          day?: string
          id?: string
          metric: string
          tenant_id: string
          value?: number
        }
        Update: {
          day?: string
          id?: string
          metric?: string
          tenant_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "usage_metrics_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          tax_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          tax_id?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          tax_id?: string | null
          tenant_id?: string
        }
        Relationships: []
      }
      widget_keys: {
        Row: {
          active: boolean
          created_at: string
          id: string
          key_hash: string
          label: string
          last_used_at: string | null
          request_count: number
          tenant_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          key_hash: string
          label?: string
          last_used_at?: string | null
          request_count?: number
          tenant_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          key_hash?: string
          label?: string
          last_used_at?: string | null
          request_count?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      work_item_claims: {
        Row: {
          category: string
          claimed_at: string
          connector_id: string
          evidence_run_decision_id: string | null
          external_ref: string
          id: string
          owner_subject_id: string
          owner_subject_kind: string
          tenant_id: string
        }
        Insert: {
          category: string
          claimed_at?: string
          connector_id: string
          evidence_run_decision_id?: string | null
          external_ref: string
          id?: string
          owner_subject_id: string
          owner_subject_kind: string
          tenant_id: string
        }
        Update: {
          category?: string
          claimed_at?: string
          connector_id?: string
          evidence_run_decision_id?: string | null
          external_ref?: string
          id?: string
          owner_subject_id?: string
          owner_subject_kind?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_item_claims_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: false
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_item_claims_evidence_run_decision_id_fkey"
            columns: ["evidence_run_decision_id"]
            isOneToOne: false
            referencedRelation: "evidence_run_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_item_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      work_item_framing: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          id: string
          scope: string
          template: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          scope: string
          template: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          scope?: string
          template?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_item_framing_category_fkey"
            columns: ["category"]
            isOneToOne: false
            referencedRelation: "system_categories"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "work_item_framing_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      workforce_baselines: {
        Row: {
          action_minutes: number | null
          avg_fte_cost_monthly_usd: number | null
          conversation_minutes: number | null
          inquiry_minutes: number | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          action_minutes?: number | null
          avg_fte_cost_monthly_usd?: number | null
          conversation_minutes?: number | null
          inquiry_minutes?: number | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          action_minutes?: number | null
          avg_fte_cost_monthly_usd?: number | null
          conversation_minutes?: number | null
          inquiry_minutes?: number | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workforce_baselines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      workforce_team_members: {
        Row: {
          created_at: string
          de_id: string
          fallback_rank: number
          id: string
          team_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          de_id: string
          fallback_rank: number
          id?: string
          team_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          de_id?: string
          fallback_rank?: number
          id?: string
          team_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workforce_team_members_de_id_fkey"
            columns: ["de_id"]
            isOneToOne: false
            referencedRelation: "digital_employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workforce_team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "workforce_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workforce_team_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      workforce_teams: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          purpose: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          purpose?: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          purpose?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workforce_teams_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          color: string
          created_at: string
          created_by: string | null
          description: string
          icon: string
          id: string
          name: string
          slug: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string
          icon?: string
          id?: string
          name: string
          slug: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string
          icon?: string
          id?: string
          name?: string
          slug?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      connector_secrets_decrypted: {
        Row: {
          connector_id: string | null
          secret: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connector_secrets_connector_id_fkey"
            columns: ["connector_id"]
            isOneToOne: true
            referencedRelation: "connectors"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_gate: {
        Row: {
          failed: number | null
          finished_at: string | null
          passed: number | null
          run_id: string | null
          status: string | null
          tenant_id: string | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "eval_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_summary: {
        Row: {
          amount_cents: number | null
          opp_count: number | null
          stage: string | null
          tenant_id: string | null
          win_rate_90d: number | null
        }
        Relationships: [
          {
            foreignKeyName: "opportunities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      specialist_source_secrets_decrypted: {
        Row: {
          secret: string | null
          source_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "specialist_source_secrets_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: true
            referencedRelation: "specialist_sources"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _assert_conv_member: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      access_permission_level: {
        Args: { p_permission: string }
        Returns: number
      }
      acknowledge_de_performance_review: {
        Args: { p_review_id: string }
        Returns: Json
      }
      add_tenant_ip_allowlist_entry: {
        Args: { p_ip_range: string; p_label?: string; p_tenant_id: string }
        Returns: Json
      }
      advance_de_lifecycle: {
        Args: { p_de_id: string; p_note?: string; p_to_stage: string }
        Returns: Json
      }
      append_audit_event: {
        Args: {
          p_action: string
          p_actor: string
          p_actor_type: string
          p_category: string
          p_detail?: Json
          p_tenant_id: string
        }
        Returns: {
          action: string
          actor: string
          actor_type: string
          category: string
          created_at: string
          detail: Json
          hash: string
          id: string
          prev_hash: string
          tenant_id: string
        }
        SetofOptions: {
          from: "*"
          to: "audit_events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      append_audit_event_internal: {
        Args: {
          p_action: string
          p_actor: string
          p_actor_type: string
          p_category: string
          p_detail?: Json
          p_tenant_id: string
        }
        Returns: undefined
      }
      apply_knowledge_revision: {
        Args: { p_request_id: string }
        Returns: Json
      }
      apply_onboarding_verification: {
        Args: {
          p_detail: string
          p_key: string
          p_project_id: string
          p_verified: boolean
        }
        Returns: Json
      }
      apply_trust_promotion: {
        Args: { p_decision: string; p_task_id: string }
        Returns: Json
      }
      approve_draft_reply: {
        Args: { p_edited_content?: string; p_message_id: string }
        Returns: undefined
      }
      approve_learned_behavior: {
        Args: {
          p_cluster_id: string
          p_final_pattern?: string
          p_final_threshold?: number
        }
        Returns: Json
      }
      approve_subtenant_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      archive_workforce_team: { Args: { p_team_id: string }; Returns: Json }
      assess_de_skills: {
        Args: never
        Returns: {
          assessed_at: string
          de_id: string
          detail: string
          id: string
          proficiency: number | null
          sample_size: number
          signal_value: number | null
          skill_key: string
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "de_skills"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      assess_de_skills_internal: {
        Args: { p_tenant_id?: string }
        Returns: Json
      }
      audit_tenant_provisioning: {
        Args: never
        Returns: {
          autonomy_rows: number
          baseline_complete: boolean
          connectors: number
          des: number
          guardrails: number
          onboarding_templates: number
          playbooks: number
          specialists: number
          tenant_id: string
          tenant_name: string
          tenant_status: string
          trust_policies: number
        }[]
      }
      auth_has_tenant_role: {
        Args: { required_roles: string[] }
        Returns: boolean
      }
      auth_tenant_id: { Args: never; Returns: string }
      caller_has_tenant_relationship: {
        Args: { p_tenant_id: string }
        Returns: boolean
      }
      certify_digital_employee: {
        Args: {
          p_cert_type: string
          p_de_id: string
          p_note: string
          p_scope: string
          p_valid_days?: number
        }
        Returns: {
          cert_type: string
          created_at: string
          de_id: string
          expires_at: string
          id: string
          issued_at: string
          issued_by: string | null
          issued_by_name: string
          note: string
          revoked_reason: string | null
          scope: string
          status: string
          tenant_id: string
          warned_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "de_certifications"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      check_de_retirement_readiness: {
        Args: { p_de_id: string }
        Returns: Json
      }
      check_ip_against_tenant_allowlist: {
        Args: { p_ip: string; p_tenant_id: string }
        Returns: Json
      }
      check_staleness: { Args: { p_tenant_id?: string }; Returns: Json }
      check_tenant_ai_budget: { Args: { p_tenant_id: string }; Returns: Json }
      claim_support_conversation: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      close_opportunity_lost: {
        Args: { p_opp: string; p_reason: string }
        Returns: Json
      }
      close_opportunity_won: {
        Args: {
          p_account_id?: string
          p_create_onboarding?: boolean
          p_opp: string
          p_template_version?: string
        }
        Returns: Json
      }
      cluster_gap_candidates: { Args: { p_tenant_id: string }; Returns: Json }
      cluster_learned_behavior_candidates: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      complete_signup: {
        Args: { p_industry?: string; p_org_name: string }
        Returns: Json
      }
      compute_account_health: { Args: { p_account: string }; Returns: Json }
      compute_account_health_core: {
        Args: { p_account: string }
        Returns: Json
      }
      compute_de_lifecycle_readiness: {
        Args: { p_de_id: string }
        Returns: Json
      }
      compute_inquiry_confidence: { Args: { p_inputs: Json }; Returns: number }
      compute_tenant_health: { Args: { p_force?: boolean }; Returns: Json }
      compute_tenant_health_service: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      compute_trust_evidence: {
        Args: { p_action_category: string; p_de_id: string }
        Returns: Json
      }
      count_pending_knowledge_gaps: {
        Args: { p_tenant_id: string }
        Returns: number
      }
      create_de_development_item: {
        Args: {
          p_assigned_to?: string
          p_de_id: string
          p_description: string
          p_due_date?: string
          p_priority?: string
          p_target_metric?: string
          p_target_value?: number
        }
        Returns: {
          assigned_to: string | null
          baseline_value: number | null
          completed_at: string | null
          consequence: string | null
          created_at: string
          created_by: string | null
          de_id: string
          description: string
          due_date: string | null
          id: string
          item_type: string
          priority: string
          source: string
          status: string
          target_metric: string | null
          target_value: number | null
          tenant_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "de_development_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_digital_employee: {
        Args: {
          p_category?: string
          p_confidence_threshold?: number
          p_department?: string
          p_description?: string
          p_name: string
          p_persona_name?: string
          p_required_approval?: boolean
          p_trust_level?: string
        }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_onboarding_project: {
        Args: {
          p_account_id: string
          p_name?: string
          p_target?: string
          p_tenant_id?: string
          p_version_id: string
        }
        Returns: Json
      }
      create_tenant_api_key: {
        Args: { p_name: string; p_scopes?: string[]; p_tenant_id: string }
        Returns: Json
      }
      de_governance_sweep_internal: { Args: never; Returns: Json }
      de_is_available: { Args: { p_availability: Json }; Returns: boolean }
      decide_action_execution: {
        Args: {
          p_action_label: string
          p_action_type?: string
          p_amount_cents?: number
          p_category: string
          p_de_id?: string
          p_destructive: boolean
          p_tenant_id: string
        }
        Returns: Json
      }
      decide_ingest_candidates: {
        Args: { p_connector_id: string; p_decision: string; p_refs: string[] }
        Returns: number
      }
      decide_inquiry_triage: {
        Args: {
          p_confidence: number
          p_de_id?: string
          p_inquiry: string
          p_tenant_id: string
        }
        Returns: Json
      }
      decide_work_item_triage: {
        Args: {
          p_category: string
          p_confidence: number
          p_de_id?: string
          p_inquiry: string
          p_tenant_id: string
        }
        Returns: Json
      }
      deprovision_starter_de_internal: {
        Args: { p_feature_key: string; p_tenant_id: string }
        Returns: undefined
      }
      detect_de_development_needs: {
        Args: { p_tenant_id: string }
        Returns: {
          assigned_to: string | null
          baseline_value: number | null
          completed_at: string | null
          consequence: string | null
          created_at: string
          created_by: string | null
          de_id: string
          description: string
          due_date: string | null
          id: string
          item_type: string
          priority: string
          source: string
          status: string
          target_metric: string | null
          target_value: number | null
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "de_development_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      detect_de_development_needs_internal: {
        Args: { p_tenant_id?: string }
        Returns: {
          assigned_to: string | null
          baseline_value: number | null
          completed_at: string | null
          consequence: string | null
          created_at: string
          created_by: string | null
          de_id: string
          description: string
          due_date: string | null
          id: string
          item_type: string
          priority: string
          source: string
          status: string
          target_metric: string | null
          target_value: number | null
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "de_development_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      detect_de_incidents_internal: {
        Args: { p_tenant_id?: string }
        Returns: Json
      }
      detect_exceptions: {
        Args: { p_tenant_id: string; p_workspace_id: string }
        Returns: number
      }
      dispatch_due_triggers: { Args: { p_tenant_id?: string }; Returns: Json }
      emit_tenant_event: {
        Args: {
          p_event_key: string
          p_payload?: Json
          p_target_account_id?: string
          p_target_ref?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      end_platform_remote_access: {
        Args: { p_session_key: string }
        Returns: Json
      }
      erd_human_task_id: { Args: { p_decision_id: string }; Returns: string }
      expire_trials: { Args: never; Returns: number }
      get_agentic_tools_for_de: {
        Args: { p_de_id: string; p_tenant_id: string }
        Returns: Json
      }
      get_conversation_facts: {
        Args: { p_conversation_id: string; p_tenant_id: string }
        Returns: Json
      }
      get_de_action_metrics: {
        Args: { p_days?: number; p_tenant_id: string }
        Returns: {
          approved_after_gate: number
          auto_executed: number
          autonomy_rate: number
          blocked: number
          de_id: string
          executed: number
          failed: number
          rejected: number
          sent_to_human: number
          total_events: number
        }[]
      }
      get_de_cost_metrics: {
        Args: { p_tenant_id: string }
        Returns: {
          de_id: string
          total_calls: number
          total_cost_usd: number
          total_input_tokens: number
          total_output_tokens: number
        }[]
      }
      get_de_cost_metrics_ranged: {
        Args: { p_days?: number; p_tenant_id: string }
        Returns: {
          de_id: string
          total_calls: number
          total_cost_usd: number
          total_input_tokens: number
          total_output_tokens: number
        }[]
      }
      get_de_csat_metrics: {
        Args: { p_tenant_id: string }
        Returns: {
          csat_pct: number
          de_id: string
          positive_ratings: number
          total_ratings: number
        }[]
      }
      get_de_economics: {
        Args: { p_days?: number; p_de_id?: string; p_tenant_id: string }
        Returns: Json
      }
      get_de_guardrail_activity: {
        Args: { p_days?: number; p_tenant_id: string }
        Returns: {
          blocked_count: number
          de_id: string
          de_name: string
          gated_count: number
          tenant_attributed_events: number
          tenant_total_events: number
        }[]
      }
      get_de_inquiry_metrics: {
        Args: { p_days?: number; p_tenant_id: string }
        Returns: {
          avg_confidence: number
          de_id: string
          escalation_rate: number
          resolution_rate: number
          total_decisions: number
        }[]
      }
      get_de_kpi_status: {
        Args: { p_de_id: string }
        Returns: {
          current: number
          direction: string
          kpi_id: string
          met: boolean
          metric_key: string
          name: string
          sample: number
          target: number
        }[]
      }
      get_de_performance_metrics: {
        Args: { p_tenant_id: string; p_weeks?: number }
        Returns: {
          avg_confidence: number
          avg_frustration_score: number
          blocked_guardrail_count: number
          de_id: string
          de_name: string
          error_rate: number
          escalation_rate: number
          high_frustration_count: number
          resolution_rate: number
          total_decisions: number
          total_runs: number
          trend: Json
        }[]
      }
      get_identity_inventory: {
        Args: { p_tenant_id: string }
        Returns: {
          autonomy_enabled: boolean
          connector_category: string
          connector_consecutive_failures: number
          connector_id: string
          connector_last_error_at: string
          connector_last_ok_at: string
          connector_name: string
          connector_provider: string
          connector_status: string
          has_stored_credential: boolean
          permission: string
          permission_via: string
          possible_actions: Json
          subject_id: string
          subject_kind: string
          subject_label: string
          subject_name: string
          subject_role: string
          subject_status: string
          trust_current_level: number
          trust_target_level: number
        }[]
      }
      get_knowledge_doc_citation_stats: {
        Args: { p_tenant_id: string }
        Returns: {
          accurate_count: number
          avg_confidence: number
          citation_count: number
          doc_id: string
          needs_improvement_count: number
        }[]
      }
      get_recent_eval_failures: {
        Args: { p_limit?: number; p_tenant_id: string }
        Returns: {
          failed: number
          finished_at: string
          id: string
          passed: number
          started_at: string
          total: number
          trigger: string
        }[]
      }
      get_tenant_ip_allowlist: { Args: { p_tenant_id: string }; Returns: Json }
      get_tenant_session_policy: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      get_tenant_token_usage_this_month: {
        Args: { p_tenant_id: string }
        Returns: number
      }
      get_unembedded_gap_candidates: {
        Args: { p_tenant_id: string }
        Returns: {
          evidence_run_id: string
          inquiry: string
        }[]
      }
      get_unembedded_learned_behavior_candidates: {
        Args: { p_tenant_id: string }
        Returns: {
          evidence_run_id: string
          inquiry: string
        }[]
      }
      guardrail_rules_for_de: {
        Args: {
          p_de_id: string
          p_playbook_def_id?: string
          p_rule_types: string[]
          p_tenant_id: string
        }
        Returns: {
          active: boolean
          applies_to: string
          created_at: string
          created_by: string | null
          id: string
          pattern: string | null
          rule: string
          rule_type: string
          scope: string
          scope_ref: string | null
          severity: string
          tenant_id: string
          threshold: number | null
          updated_at: string
          version: number
        }[]
        SetofOptions: {
          from: "*"
          to: "guardrail_rules"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      hook_before_user_created: { Args: { event: Json }; Returns: Json }
      hook_password_verification_attempt: {
        Args: { event: Json }
        Returns: Json
      }
      hybrid_match_knowledge: {
        Args: {
          p_account_id?: string
          p_match_count?: number
          p_max_distance?: number
          p_query_embedding?: string
          p_query_text: string
          p_subject_id?: string
          p_subject_kind?: string
          p_tenant_id: string
        }
        Returns: {
          account_id: string
          content: string
          distance: number
          doc_id: string
          doc_title: string
          id: string
          lexical_rank: number
          score: number
          semantic_rank: number
          visibility: string
        }[]
      }
      increment_metric: {
        Args: { p_delta?: number; p_metric: string }
        Returns: undefined
      }
      increment_metric_tenant: {
        Args: { p_delta?: number; p_metric: string; p_tenant_id: string }
        Returns: undefined
      }
      increment_tenant_token_usage: {
        Args: { p_tenant_id: string; p_tokens: number; p_year_month: string }
        Returns: undefined
      }
      ingest_document: {
        Args: {
          p_doc_type: string
          p_filename: string
          p_rows: Json
          p_tenant_id: string
          p_uploaded_by?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      install_starter_onboarding_template: { Args: never; Returns: Json }
      install_technical_specialist: { Args: never; Returns: Json }
      invite_platform_team_member: {
        Args: { p_email: string; p_role: string }
        Returns: Json
      }
      invoke_playbook_dispatch: { Args: never; Returns: string }
      is_ancestor_of: {
        Args: { p_ancestor_id: string; p_tenant_id: string }
        Returns: boolean
      }
      is_feature_enabled: {
        Args: { p_feature_key: string; p_tenant_id: string }
        Returns: boolean
      }
      is_feature_enabled_internal: {
        Args: { p_feature_key: string; p_tenant_id: string }
        Returns: boolean
      }
      is_platform_admin: { Args: never; Returns: boolean }
      is_safe_external_url: { Args: { p_url: string }; Returns: boolean }
      list_de_health: {
        Args: { p_tenant_id: string }
        Returns: {
          avg_confidence: number
          cost_per_task_usd: number
          cost_this_period_usd: number
          de_id: string
          de_name: string
          error_rate: number
          escalation_rate: number
          recent_guardrail_blocks: number
          signals: Json
          state: string
          total_decisions: number
        }[]
      }
      list_de_specialists: {
        Args: { p_de_id: string }
        Returns: {
          rank: number
          specialist_id: string
          specialist_key: string
          specialist_name: string
          specialist_status: string
        }[]
      }
      list_platform_capability_grants: {
        Args: { p_target_user_id?: string }
        Returns: {
          capability: string
          created_at: string
          effect: string
          granted_by: string | null
          id: string
          note: string
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "platform_capability_grants"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_platform_invites: {
        Args: never
        Returns: {
          created_at: string
          email: string
          id: string
          invite_code: string
          invited_by: string | null
          redeemed_at: string | null
          redeemed_by: string | null
          role: string
          status: string
        }[]
        SetofOptions: {
          from: "*"
          to: "platform_invites"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_platform_team: {
        Args: never
        Returns: {
          created_at: string
          email: string
          full_name: string
          is_active: boolean
          last_sign_in_at: string
          role: string
          user_id: string
        }[]
      }
      list_team_members_full: {
        Args: { p_tenant_id: string }
        Returns: {
          created_at: string
          department: string
          email: string
          full_name: string
          invited_by: string
          is_active: boolean
          last_seen_at: string
          role: string
          user_id: string
        }[]
      }
      list_team_mfa_status: {
        Args: { p_tenant_id: string }
        Returns: {
          mfa_verified: boolean
          user_id: string
        }[]
      }
      list_tenant_api_keys: {
        Args: { p_tenant_id: string }
        Returns: {
          created_at: string
          display_hint: string
          id: string
          last_used_at: string
          name: string
          revoked_at: string
          scopes: string[]
        }[]
      }
      match_cached_answer: {
        Args: {
          p_account_id: string
          p_max_distance?: number
          p_query_embedding: string
          p_tenant_id: string
        }
        Returns: {
          answer: string
          confidence: number
          distance: number
          id: string
          sources: Json
        }[]
      }
      match_doc_chunks: {
        Args: {
          p_account_id: string
          p_match_count?: number
          p_query_embedding: string
          p_subject_id?: string
          p_subject_kind?: string
          p_tenant_id: string
        }
        Returns: {
          account_id: string
          content: string
          distance: number
          doc_id: string
          id: string
          visibility: string
        }[]
      }
      match_knowledge_chunks: {
        Args: {
          match_count?: number
          match_tenant_id: string
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          similarity: number
          title: string
        }[]
      }
      my_account_status: { Args: never; Returns: Json }
      oauth_app_status: {
        Args: never
        Returns: {
          provider: string
        }[]
      }
      onboarding_check_complete: {
        Args: { p_project_id: string }
        Returns: boolean
      }
      p_workspace_period_end: {
        Args: { p_workspace_id: string }
        Returns: string
      }
      pause_digital_employee: {
        Args: { p_de_id: string; p_reason: string }
        Returns: Json
      }
      platform_capability_remaining_holders: {
        Args: { p_capability?: string; p_exclude_user_id: string }
        Returns: number
      }
      platform_config_get: { Args: { p_key: string }; Returns: string }
      platform_config_has_key: { Args: { p_key: string }; Returns: boolean }
      platform_config_set: { Args: { p_entries: Json }; Returns: boolean }
      platform_connector_health_summary: {
        Args: never
        Returns: {
          connector_id: string
          consecutive_failures: number
          display_name: string
          last_error: string
          last_error_at: string
          last_ok_at: string
          provider: string
          status: string
          tenant_id: string
          tenant_name: string
        }[]
      }
      playbook_next_fire_at: {
        Args: {
          p_cadence: string
          p_from: string
          p_monthly_day: number
          p_run_at_hour: number
          p_weekly_day: number
        }
        Returns: string
      }
      poll_de_work_sources_targets: {
        Args: { p_tenant_id?: string }
        Returns: {
          category: string
          connector_display_name: string
          connector_id: string
          connector_provider: string
          last_seen_external_ref: string
          last_seen_timestamp: string
          subject_id: string
          subject_kind: string
          subject_name: string
          tenant_id: string
        }[]
      }
      poll_support_inbox_targets: {
        Args: { p_tenant_id?: string }
        Returns: {
          connector_display_name: string
          connector_id: string
          connector_provider: string
          last_seen_external_ref: string
          last_seen_timestamp: string
          subject_id: string
          subject_kind: string
          subject_name: string
          tenant_id: string
        }[]
      }
      promote_gap_cluster: { Args: { p_cluster_id: string }; Returns: Json }
      propose_learned_behavior: {
        Args: { p_cluster_id: string }
        Returns: Json
      }
      provision_onboarding_architect: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      provision_starter_de_internal: {
        Args: { p_feature_key: string; p_tenant_id: string }
        Returns: string
      }
      provision_tenant_baseline_internal: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      publish_adapter_template: { Args: { p_id: string }; Returns: undefined }
      publish_onboarding_template: {
        Args: { p_template_id: string }
        Returns: Json
      }
      purge_connector_secret: {
        Args: { p_connector_id: string }
        Returns: undefined
      }
      recompute_tenant_ancestry: {
        Args: { p_tenant_id: string }
        Returns: undefined
      }
      reconcile_tenant_feature: {
        Args: { p_enabled: boolean; p_feature_key: string; p_tenant_id: string }
        Returns: undefined
      }
      record_action_execution: {
        Args: {
          p_action_definition_id: string
          p_connector_id: string
          p_create_task?: boolean
          p_decision: string
          p_dedupe_key: string
          p_destructive: boolean
          p_idempotent: boolean
          p_mode: string
          p_params: Json
          p_receipt: string
          p_request_summary: string
          p_result: Json
          p_subject_id: string
          p_subject_kind: string
          p_task_detail: string
          p_task_title: string
          p_tenant_id: string
        }
        Returns: Json
      }
      record_de_experience: {
        Args: {
          p_category: string
          p_decision_made: string
          p_external_ref: string
          p_outcome: string
          p_source_action_execution_id: string
          p_source_evidence_run_id: string
          p_subject_id: string
          p_subject_kind: string
          p_tenant_id: string
          p_what_happened: string
        }
        Returns: string
      }
      record_de_token_usage: {
        Args: {
          p_de_id: string
          p_input_tokens: number
          p_model_id: string
          p_output_tokens: number
          p_tenant_id: string
        }
        Returns: undefined
      }
      record_inquiry_decision: {
        Args: {
          p_confidence: number
          p_connector_id: string
          p_decision: string
          p_evidence_run_id: string
          p_external_ref: string
          p_frustration_score?: number
          p_guardrail_rule_id: string
          p_inquiry_title: string
          p_reasoning: string
          p_source: string
          p_source_category?: string
          p_tenant_id: string
          p_trust_level: number
        }
        Returns: Json
      }
      redeem_platform_invite: { Args: { p_invite_code: string }; Returns: Json }
      reject_knowledge_revision: {
        Args: { p_reason?: string; p_request_id: string }
        Returns: Json
      }
      reject_learned_behavior: {
        Args: { p_cluster_id: string; p_reason?: string }
        Returns: Json
      }
      reject_subtenant_request: {
        Args: { p_reason: string; p_request_id: string }
        Returns: Json
      }
      remove_team_member: { Args: { p_target_user_id: string }; Returns: Json }
      remove_tenant_ip_allowlist_entry: {
        Args: { p_entry_id: string }
        Returns: Json
      }
      request_subtenant: {
        Args: {
          p_industry?: string
          p_name: string
          p_parent_tenant_id: string
        }
        Returns: Json
      }
      request_trust_promotion: { Args: { p_policy_id: string }; Returns: Json }
      resolve_access: {
        Args: {
          p_connector_id: string
          p_needed: string
          p_subject_id: string
          p_subject_kind: string
          p_tenant_id: string
        }
        Returns: Json
      }
      resolve_action_definition_for_category: {
        Args: { p_category: string; p_tenant_id: string }
        Returns: {
          action_key: string
          category: string
          created_at: string
          created_by: string | null
          description: string
          execution: Json
          id: string
          label: string
          param_schema: Json
          provider: string
          risk: Json
          scope: string
          status: string
          template_id: string | null
          tenant_id: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "action_definitions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      resolve_action_execution_for_task: {
        Args: { p_task_id: string }
        Returns: {
          action_definition_id: string
          connector_id: string | null
          created_at: string
          decision: string
          dedupe_key: string | null
          destructive: boolean
          id: string
          idempotent: boolean
          mode: string
          params: Json
          receipt: string | null
          request_summary: string
          result: Json | null
          subject_id: string | null
          subject_kind: string | null
          task_id: string | null
          tenant_id: string
        }
        SetofOptions: {
          from: "*"
          to: "action_executions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resolve_category_access: {
        Args: {
          p_category: string
          p_needed: string
          p_subject_id: string
          p_subject_kind: string
          p_tenant_id: string
        }
        Returns: Json
      }
      resolve_de_autonomy: {
        Args: {
          p_action_type: string
          p_de_id?: string
          p_source_category?: string
          p_tenant_id: string
        }
        Returns: {
          enabled: boolean
          max_amount_cents: number
          min_confidence: number
        }[]
      }
      resolve_de_escalation: {
        Args: { p_de_id?: string; p_tenant_id: string }
        Returns: {
          always_escalate_topics: string[]
          frustration_threshold: number
        }[]
      }
      resolve_de_specialist_internal: {
        Args: { p_de_id: string; p_tenant_id: string }
        Returns: string
      }
      resolve_exception: {
        Args: {
          p_approver: string
          p_approver_name: string
          p_decision: string
          p_exception_id: string
          p_final_treatment: string
        }
        Returns: string
      }
      resolve_experience: {
        Args: {
          p_category: string
          p_external_ref: string
          p_limit?: number
          p_subject_id: string
          p_subject_kind: string
          p_tenant_id: string
        }
        Returns: Json
      }
      resolve_my_de_autonomy: {
        Args: {
          p_action_type: string
          p_de_id?: string
          p_source_category?: string
        }
        Returns: {
          enabled: boolean
          max_amount_cents: number
          min_confidence: number
        }[]
      }
      resolve_onboarding_signoff: {
        Args: { p_decision: string; p_task_id: string }
        Returns: Json
      }
      resolve_platform_capability: {
        Args: { p_capability: string; p_user_id: string }
        Returns: boolean
      }
      resolve_remote_access_tenant: {
        Args: { p_asserted_tenant_id: string; p_operator_user_id: string }
        Returns: string
      }
      resolve_work_item_framing: {
        Args: { p_category: string; p_tenant_id: string }
        Returns: string
      }
      resume_digital_employee: {
        Args: { p_de_id: string; p_note: string }
        Returns: Json
      }
      resume_playbook_on_task: {
        Args: { p_decision: string; p_task_id: string }
        Returns: Json
      }
      retire_digital_employee: {
        Args: { p_de_id: string; p_reason: string }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      review_de_incident: {
        Args: {
          p_incident_id: string
          p_resolution_note?: string
          p_status: string
        }
        Returns: Json
      }
      revoke_access_grant: {
        Args: {
          p_resource_category: string
          p_resource_id: string
          p_resource_kind: string
          p_subject_id: string
          p_subject_kind: string
        }
        Returns: Json
      }
      revoke_de_certification: {
        Args: { p_cert_id: string; p_reason: string }
        Returns: Json
      }
      revoke_platform_capability_grant: {
        Args: { p_capability: string; p_target_user_id: string }
        Returns: Json
      }
      revoke_platform_invite: { Args: { p_invite_id: string }; Returns: Json }
      revoke_tenant_api_key: { Args: { p_key_id: string }; Returns: Json }
      run_de_performance_review: {
        Args: never
        Returns: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          de_id: string
          id: string
          metrics_snapshot: Json
          period_end: string
          period_start: string
          status: string
          summary: string
          tenant_id: string
          verdict: string
        }[]
        SetofOptions: {
          from: "*"
          to: "de_performance_reviews"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      run_de_performance_review_internal: {
        Args: { p_de_id?: string; p_tenant_id?: string }
        Returns: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          de_id: string
          id: string
          metrics_snapshot: Json
          period_end: string
          period_start: string
          status: string
          summary: string
          tenant_id: string
          verdict: string
        }[]
        SetofOptions: {
          from: "*"
          to: "de_performance_reviews"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      save_adapter_template: {
        Args: {
          p_category: string
          p_definition: Json
          p_description: string
          p_id?: string
          p_name: string
          p_tenant_id?: string
        }
        Returns: string
      }
      score_frustration_internal: {
        Args: { p_tenant_id: string; p_text: string }
        Returns: number
      }
      search_knowledge:
        | {
            Args: {
              p_audience?: string
              p_limit?: number
              p_query: string
              p_tenant_id: string
            }
            Returns: {
              audience: string
              body: string
              category: string
              id: string
              rank: number
              summary: string
              tags: string[]
              title: string
            }[]
          }
        | {
            Args: { p_limit?: number; p_query: string; p_tenant_id: string }
            Returns: {
              body: string
              id: string
              similarity: number
              title: string
            }[]
          }
      seed_default_grants: {
        Args: { p_domain: string; p_subject_id: string; p_subject_kind: string }
        Returns: Json
      }
      seed_trust_policies: {
        Args: never
        Returns: {
          action_category: string
          baseline_level: number
          created_at: string
          criteria: Json
          current_level: number
          de_id: string | null
          id: string
          pending_evidence: Json | null
          pending_task_id: string | null
          requested_at: string | null
          requested_by: string | null
          source_category: string | null
          status: string
          target_level: number | null
          tenant_id: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "trust_policies"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      send_human_reply: {
        Args: { p_content: string; p_conversation_id: string }
        Returns: string
      }
      set_access_grant: {
        Args: {
          p_note?: string
          p_permission: string
          p_resource_category: string
          p_resource_id: string
          p_resource_kind: string
          p_subject_id: string
          p_subject_kind: string
        }
        Returns: Json
      }
      set_connector_ingest_config: {
        Args: { p_config: Json; p_connector_id: string }
        Returns: undefined
      }
      set_connector_secret: {
        Args: { p_connector_id: string; p_secret: string }
        Returns: undefined
      }
      set_connector_secret_sysadmin: {
        Args: { p_connector_id: string; p_secret: string }
        Returns: undefined
      }
      set_conversation_fact: {
        Args: {
          p_conversation_id: string
          p_fact_key: string
          p_fact_value: Json
          p_tenant_id: string
        }
        Returns: string
      }
      set_de_attributes: {
        Args: { p_attributes: Json; p_de_id: string }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_de_autonomy: {
        Args: {
          p_action_type: string
          p_de_id?: string
          p_enabled: boolean
          p_max_amount_cents?: number
          p_min_confidence?: number
          p_source_category?: string
        }
        Returns: {
          action_type: string
          created_at: string
          de_id: string | null
          enabled: boolean
          id: string
          max_amount_cents: number | null
          min_confidence: number | null
          source_category: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "de_autonomy"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_de_availability: {
        Args: {
          p_days?: number[]
          p_de_id: string
          p_end_hour?: number
          p_mode: string
          p_start_hour?: number
          p_timezone?: string
        }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_de_escalation_rules: {
        Args: {
          p_de_id?: string
          p_frustration_threshold?: number
          p_topics?: string[]
        }
        Returns: Json
      }
      set_de_external_reply_mode: {
        Args: { p_de_id: string; p_mode: string }
        Returns: undefined
      }
      set_de_identity: {
        Args: {
          p_cost_center?: string
          p_de_id: string
          p_display_title?: string
          p_employee_code?: string
          p_location?: string
          p_primary_business_outcome?: string
          p_purpose_statement?: string
          p_responsibilities?: string[]
        }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_de_kpi: {
        Args: {
          p_de_id: string
          p_direction: string
          p_metric_key: string
          p_name: string
          p_target: number
        }
        Returns: Json
      }
      set_de_specialist: {
        Args: { p_de_id: string; p_rank: number; p_specialist_id?: string }
        Returns: Json
      }
      set_doc_scope: {
        Args: { p_doc_id: string; p_subjects?: Json }
        Returns: Json
      }
      set_oauth_app: {
        Args: {
          p_client_id: string
          p_client_secret: string
          p_provider: string
        }
        Returns: undefined
      }
      set_onboarding_project_status: {
        Args: { p_project_id: string; p_status: string }
        Returns: Json
      }
      set_pipeline_stages: {
        Args: { p_stages: Json }
        Returns: {
          created_at: string
          id: string
          label: string
          position: number
          stage_key: string
          tenant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "tenant_pipeline_stages"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_platform_capability_grant: {
        Args: {
          p_capability: string
          p_effect: string
          p_note?: string
          p_target_user_id: string
        }
        Returns: Json
      }
      set_platform_team_active: {
        Args: { p_is_active: boolean; p_target_user_id: string }
        Returns: Json
      }
      set_specialist_source_secret: {
        Args: { p_secret: string; p_source_id: string }
        Returns: undefined
      }
      set_support_conversation_state: {
        Args: {
          p_conversation_id: string
          p_priority?: string
          p_status?: string
        }
        Returns: undefined
      }
      set_team_member_status: {
        Args: { p_is_active: boolean; p_target_user_id: string }
        Returns: Json
      }
      set_tenant_feature_override: {
        Args: {
          p_enabled: boolean
          p_feature_key: string
          p_note?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      set_tenant_ip_allowlist_enabled: {
        Args: { p_enabled: boolean; p_tenant_id: string }
        Returns: Json
      }
      set_tenant_monthly_budget: {
        Args: { p_budget: number; p_tenant_id: string }
        Returns: Json
      }
      set_tenant_plan: {
        Args: { p_plan: string; p_tenant_id: string }
        Returns: Json
      }
      set_tenant_self_serve: {
        Args: { p_allow: boolean; p_tenant_id: string }
        Returns: Json
      }
      set_tenant_session_policy: {
        Args: {
          p_mfa_required: boolean
          p_tenant_id: string
          p_timeout_minutes: number
        }
        Returns: Json
      }
      set_tenant_status: {
        Args: { p_status: string; p_tenant_id: string }
        Returns: Json
      }
      set_work_item_framing: {
        Args: { p_category: string; p_template: string }
        Returns: {
          category: string
          created_at: string
          created_by: string | null
          id: string
          scope: string
          template: string
          tenant_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "work_item_framing"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_workforce_baselines: {
        Args: {
          p_action_minutes?: number
          p_avg_fte_cost_monthly_usd?: number
          p_conversation_minutes?: number
          p_inquiry_minutes?: number
        }
        Returns: {
          action_minutes: number | null
          avg_fte_cost_monthly_usd: number | null
          conversation_minutes: number | null
          inquiry_minutes: number | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "workforce_baselines"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_workforce_team_member: {
        Args: { p_de_id: string; p_fallback_rank?: number; p_team_id: string }
        Returns: Json
      }
      stale_humanize_interval: { Args: { p_span: string }; Returns: string }
      stale_upsert_escalation: {
        Args: {
          p_related_id: string
          p_related_table: string
          p_target_id: string
          p_target_kind: string
          p_task_detail: string
          p_task_title: string
          p_tenant_id: string
          p_tier: string
        }
        Returns: string
      }
      start_platform_remote_access: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      submit_csat: {
        Args: {
          p_conversation_id: string
          p_score: number
          p_tenant_id: string
        }
        Returns: Json
      }
      submit_evidence_feedback: {
        Args: { p_evidence_run_id: string; p_notes?: string; p_verdict: string }
        Returns: Json
      }
      sync_de_lifecycle_auto_internal: { Args: never; Returns: Json }
      sync_de_lifecycle_from_development: {
        Args: { p_de_id: string }
        Returns: undefined
      }
      tenant_ancestors: {
        Args: { p_tenant_id: string }
        Returns: {
          depth: number
          tenant_id: string
        }[]
      }
      tenant_descendants: {
        Args: { p_tenant_id: string }
        Returns: {
          depth: number
          tenant_id: string
        }[]
      }
      touch_inbox_watch_state: {
        Args: { p_connector_id: string; p_tenant_id: string }
        Returns: undefined
      }
      transfer_de_ownership: {
        Args: { p_de_id: string; p_new_owner_user_id: string; p_note?: string }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      transfer_tenant_ownership: {
        Args: { p_new_owner_user_id: string }
        Returns: Json
      }
      trust_apply_level: {
        Args: {
          p_actor: string
          p_category: string
          p_de_id?: string
          p_level: number
          p_source_category?: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      trust_demote: {
        Args: {
          p_category: string
          p_evidence: Json
          p_reason: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      trust_evidence_for: {
        Args: {
          p_policy: Database["public"]["Tables"]["trust_policies"]["Row"]
        }
        Returns: Json
      }
      trust_level_settings: {
        Args: { p_category: string; p_level: number }
        Returns: Json
      }
      update_de_development_item_status: {
        Args: { p_item_id: string; p_status: string }
        Returns: {
          assigned_to: string | null
          baseline_value: number | null
          completed_at: string | null
          consequence: string | null
          created_at: string
          created_by: string | null
          de_id: string
          description: string
          due_date: string | null
          id: string
          item_type: string
          priority: string
          source: string
          status: string
          target_metric: string | null
          target_value: number | null
          tenant_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "de_development_items"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_digital_employee: {
        Args: {
          p_confidence_threshold?: number
          p_de_id: string
          p_department?: string
          p_description?: string
          p_escalation_model_id?: string
          p_escalation_threshold?: number
          p_icon?: string
          p_model_id?: string
          p_model_provider?: string
          p_name?: string
          p_persona_name?: string
          p_required_approval?: boolean
          p_task_type?: string
        }
        Returns: {
          attributes: Json
          availability: Json
          capabilities: string[]
          catalog_id: string | null
          category: string
          channels: string[]
          confidence_threshold: number
          config_version: number
          cost_center: string
          created_at: string
          created_by: string | null
          department: string
          description: string
          display_title: string
          employee_code: string
          escalation_model_id: string
          escalation_threshold: number
          external_reply_mode: string
          fte_equivalent: number | null
          icon: string
          id: string
          knowledge_sources: string[]
          lifecycle_status: string
          location: string
          model_config: Json
          model_id: string
          model_provider: string
          name: string
          owner_id: string | null
          persona_name: string | null
          primary_business_outcome: string
          purpose_statement: string
          required_approval: boolean
          responsibilities: string[]
          skills: Json
          status: string
          success_rate: number
          tags: string[]
          task_type: string
          tasks_this_month: number
          tenant_id: string
          trust_level: string
          updated_at: string
          workspace: string
        }
        SetofOptions: {
          from: "*"
          to: "digital_employees"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_onboarding_item: {
        Args: {
          p_assignee?: string
          p_key: string
          p_note?: string
          p_project_id: string
          p_status?: string
        }
        Returns: Json
      }
      update_platform_team_role: {
        Args: { p_new_role: string; p_target_user_id: string }
        Returns: Json
      }
      update_team_member_department: {
        Args: { p_department: string; p_target_user_id: string }
        Returns: Json
      }
      update_team_member_role: {
        Args: { p_new_role: string; p_target_user_id: string }
        Returns: Json
      }
      update_tenant_general_settings: {
        Args: {
          p_accent_color: string
          p_industry: string
          p_name: string
          p_tenant_id: string
          p_vocabulary?: Json
        }
        Returns: Json
      }
      upsert_action_definition: {
        Args: {
          p_action_key: string
          p_category: string
          p_description: string
          p_execution: Json
          p_id: string
          p_label: string
          p_param_schema: Json
          p_provider: string
          p_risk: Json
          p_scope: string
          p_template_id: string
          p_tenant_id: string
        }
        Returns: {
          action_key: string
          category: string
          created_at: string
          created_by: string | null
          description: string
          execution: Json
          id: string
          label: string
          param_schema: Json
          provider: string
          risk: Json
          scope: string
          status: string
          template_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "action_definitions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_event_definition: {
        Args: {
          p_description: string
          p_event_key: string
          p_id: string
          p_kind: string
          p_label: string
          p_params_schema: Json
          p_scope: string
          p_tenant_id: string
        }
        Returns: {
          active: boolean
          created_at: string
          created_by: string | null
          description: string
          event_key: string
          id: string
          kind: string
          label: string
          params_schema: Json
          scope: string
          tenant_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "event_definitions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_inbox_watch_state: {
        Args: {
          p_connector_id: string
          p_external_ref: string
          p_tenant_id: string
          p_timestamp: string
        }
        Returns: undefined
      }
      upsert_workforce_team: {
        Args: { p_name: string; p_purpose?: string; p_team_id?: string }
        Returns: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          purpose: string
          status: string
          tenant_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workforce_teams"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      validate_onboarding_items: { Args: { p_items: Json }; Returns: string[] }
      verify_audit_chain: { Args: { p_tenant_id: string }; Returns: Json }
      verify_tenant_api_key: { Args: { p_raw_key: string }; Returns: Json }
      visible_knowledge_docs: {
        Args: {
          p_subject_id?: string
          p_subject_kind?: string
          p_tenant_id: string
        }
        Returns: {
          content: string
          id: string
          tags: string[]
          title: string
          visibility: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
