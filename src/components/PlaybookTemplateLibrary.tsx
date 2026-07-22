import React, { useState } from 'react';
import { supabase } from '../supabase';

interface PlaybookTemplate {
  id: string;
  name: string;
  domain: string;
  description: string;
  step_count: number;
  published: boolean;
  created_at: string;
}

const PLAYBOOK_TEMPLATES: PlaybookTemplate[] = [
  {
    id: 'template-support-triage',
    name: 'Resolve Support Ticket',
    domain: 'Support',
    description: 'Baseline template for handling support tickets. Handles triage, escalation, and resolution tracking.',
    step_count: 8,
    published: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'template-billing-followup',
    name: 'Process Invoice & Follow Up',
    domain: 'Billing',
    description: 'Handle overdue invoicing, payment failures, and collections procedures.',
    step_count: 9,
    published: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'template-sales-qualify',
    name: 'Lead Qualification Flow',
    domain: 'Sales',
    description: 'Qualify incoming leads, assess company fit, and route to sales team.',
    step_count: 6,
    published: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'template-csm-health',
    name: 'Account Health Check',
    domain: 'Customer Success',
    description: 'Monitor customer health, detect at-risk accounts, and plan outreach.',
    step_count: 7,
    published: false,
    created_at: new Date().toISOString(),
  },
];

export function PlaybookTemplateLibrary() {
  const [cloning, setCloning] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);

  const handleCloneTemplate = async (template: PlaybookTemplate) => {
    setCloning(template.id);
    try {
      // Clone template → create as draft in current workspace
      const { data, error } = await supabase.rpc('clone_playbook_template', {
        p_template_id: template.id,
        p_name: `${template.name} (Draft)`,
      });

      if (!error && data) {
        // TODO: Navigate to the new playbook for editing
        console.log('Template cloned:', data);
      }
    } catch (e) {
      console.error('Failed to clone template:', e);
    } finally {
      setCloning(null);
    }
  };

  const domains = ['Support', 'Billing', 'Sales', 'Customer Success'];
  const filtered = selectedDomain
    ? PLAYBOOK_TEMPLATES.filter(t => t.domain === selectedDomain)
    : PLAYBOOK_TEMPLATES;

  return (
    <div className="space-y-4">
      <div className="text-xs text-dt-support mb-4">
        Baseline templates for each operational domain. Clone any template to start a new playbook in your workspace.
      </div>

      {/* Domain Filter */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setSelectedDomain(null)}
          className={`px-3 py-1 text-xs rounded-full transition-colors ${
            selectedDomain === null
              ? 'bg-indigo-600 text-white'
              : 'bg-dt-panel text-dt-support hover:bg-dt-panel'
          }`}
        >
          All Domains
        </button>
        {domains.map(domain => (
          <button
            key={domain}
            onClick={() => setSelectedDomain(domain)}
            className={`px-3 py-1 text-xs rounded-full transition-colors ${
              selectedDomain === domain
                ? 'bg-indigo-600 text-white'
                : 'bg-dt-panel text-dt-support hover:bg-dt-panel'
            }`}
          >
            {domain}
          </button>
        ))}
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map(template => (
          <div
            key={template.id}
            className="bg-dt-card border border-dt-border rounded-lg p-4 space-y-3"
          >
            <div>
              <div className="flex items-start justify-between gap-2 mb-1">
                <h4 className="text-sm font-semibold text-white">{template.name}</h4>
                <span className="text-xs bg-dt-panel text-dt-support px-2 py-1 rounded">
                  {template.domain}
                </span>
              </div>
              <p className="text-xs text-dt-support">{template.description}</p>
            </div>

            <div className="text-xs text-dt-muted">
              {template.step_count} steps · {template.published ? 'Published' : 'Draft'}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => handleCloneTemplate(template)}
                disabled={cloning === template.id}
                className="flex-1 px-3 py-2 text-xs bg-indigo-600 hover:bg-indigo-700 rounded font-medium transition-colors disabled:opacity-50"
              >
                {cloning === template.id ? 'Cloning...' : 'Clone Template'}
              </button>
              <button className="flex-1 px-3 py-2 text-xs bg-dt-panel hover:bg-dt-panel rounded transition-colors">
                Preview
              </button>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="bg-dt-card border border-dt-border rounded-lg p-8 text-center">
          <p className="text-sm text-dt-support">No templates in {selectedDomain} domain yet.</p>
        </div>
      )}

      <div className="border-t border-dt-border pt-3">
        <p className="text-xs text-dt-muted">
          💡 Templates are read-only. Cloning creates an editable draft in your workspace.
        </p>
      </div>
    </div>
  );
}
