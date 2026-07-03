import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../../context/AuthContext';
import type { Page } from '../../../types';

// ============================================================
// Onboarding — Customer entity
// AI onboarding co-pilot migrated from ImplementationWorkspacePage:
// project sidebar, checklist, data upload with AI column mapping,
// configuration review, audit trail, and DE assistant chat.
// ============================================================

// ─── Types ───────────────────────────────────────────────────────────────────

type ProjectStatus = 'not_started' | 'in_progress' | 'complete' | 'blocked';
type StepStatus = 'complete' | 'in_progress' | 'pending_review' | 'not_started';
type StepHandler = 'de' | 'human' | null;
type ActiveTab = 'checklist' | 'upload' | 'configuration' | 'audit';
type AuditFilter = 'all' | 'de' | 'human' | 'pending_review' | 'approved';

interface OnboardingProject {
  id: string;
  client: string;
  product: string;
  specialist: string;
  status: ProjectStatus;
  progress: number;
  startDate: string;
  dueDate: string;
}

interface ChecklistStep {
  id: string;
  title: string;
  description: string;
  status: StepStatus;
  handler: StepHandler;
  itemCount: number | null;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  actor: 'DE' | 'Human';
  action: string;
  detail: string;
  status: 'auto' | 'approved' | 'pending' | 'pending_review';
}

interface ChatMessage {
  id: string;
  role: 'de' | 'user';
  text: string;
  time: string;
}

interface UploadMapping {
  yourColumn: string;
  humanityField: string;
  confidence: number;
  status: 'ok' | 'warn' | 'unmapped';
}

// ─── Seed Data ────────────────────────────────────────────────────────────────

const SEED_PROJECTS: OnboardingProject[] = [
  {
    id: 'proj-001',
    client: 'TCP Inc',
    product: 'Humanity.com',
    specialist: 'Morgan Chen',
    status: 'in_progress',
    progress: 45,
    startDate: '2026-06-15',
    dueDate: '2026-07-10',
  },
  {
    id: 'proj-002',
    client: 'Apex Systems',
    product: 'BambooHR',
    specialist: 'Taylor Smith',
    status: 'not_started',
    progress: 0,
    startDate: '2026-07-05',
    dueDate: '2026-07-25',
  },
  {
    id: 'proj-003',
    client: 'Northfield Co',
    product: 'Zendesk',
    specialist: 'Jordan Lee',
    status: 'complete',
    progress: 100,
    startDate: '2026-05-01',
    dueDate: '2026-05-20',
  },
];

const HUMANITY_STEPS: ChecklistStep[] = [
  { id: 'step-1', title: 'Employee Data Upload', description: 'Upload all employees with roles, locations, and employment types.', status: 'complete', handler: 'de', itemCount: 142 },
  { id: 'step-2', title: 'Location Setup', description: 'Configure all work locations, addresses, and time zones.', status: 'complete', handler: 'human', itemCount: 4 },
  { id: 'step-3', title: 'Positions & Roles', description: 'Define job positions and their scheduling requirements.', status: 'in_progress', handler: 'de', itemCount: 8 },
  { id: 'step-4', title: 'Leave Rules Configuration', description: 'Set PTO, sick leave, unpaid leave, and accrual policies.', status: 'pending_review', handler: 'de', itemCount: null },
  { id: 'step-5', title: 'Shift Templates', description: 'Define recurring shift patterns and break rules.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-6', title: 'Availability & Preferences', description: 'Import employee availability windows and scheduling preferences.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-7', title: 'Overtime & Compliance Rules', description: 'Configure overtime thresholds, rest period rules, and compliance settings.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-8', title: 'Integration Connections', description: 'Connect payroll (ADP/Gusto) and HR systems.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-9', title: 'Validation & QA Review', description: 'DE scans all configuration for gaps, conflicts, and missing required fields.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-10', title: 'Handoff & Go-Live', description: 'Training session scheduled, admin credentials transferred, go-live confirmed.', status: 'not_started', handler: null, itemCount: null },
];

const DEFAULT_STEPS: ChecklistStep[] = [
  { id: 'step-1', title: 'Initial Setup', description: 'Configure basic account and organization settings.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-2', title: 'User Import', description: 'Import users and assign roles.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-3', title: 'Integration Setup', description: 'Connect to existing tools and data sources.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-4', title: 'Configuration Review', description: 'Review and approve all configuration settings.', status: 'not_started', handler: null, itemCount: null },
  { id: 'step-5', title: 'Validation & Go-Live', description: 'Run final checks and launch the system.', status: 'not_started', handler: null, itemCount: null },
];

const AUDIT_LOG: AuditEntry[] = [
  { id: 'a1', timestamp: '2026-06-15 09:12', actor: 'DE', action: 'Project created', detail: 'Onboarding project initialized for TCP Inc / Humanity.com', status: 'auto' },
  { id: 'a2', timestamp: '2026-06-15 09:15', actor: 'DE', action: 'Product framework loaded', detail: 'Loaded Humanity.com onboarding checklist — 10 steps identified', status: 'auto' },
  { id: 'a3', timestamp: '2026-06-16 10:30', actor: 'Human', action: 'Employee CSV uploaded', detail: 'employees_tcp.csv — 142 rows processed', status: 'approved' },
  { id: 'a4', timestamp: '2026-06-16 10:31', actor: 'DE', action: 'Column mapping proposed', detail: '8/10 columns auto-mapped, 2 required specialist review', status: 'auto' },
  { id: 'a5', timestamp: '2026-06-16 10:35', actor: 'Human', action: 'Column mapping approved', detail: 'Specialist confirmed: Emp Type → employment_type, Office → location', status: 'approved' },
  { id: 'a6', timestamp: '2026-06-16 10:36', actor: 'DE', action: '138 employees uploaded', detail: '3 skipped (missing email), 1 corrected (employment_type)', status: 'auto' },
  { id: 'a7', timestamp: '2026-06-17 14:00', actor: 'Human', action: 'Locations configured', detail: '4 locations created: London HQ, New York, Singapore, Remote', status: 'approved' },
  { id: 'a8', timestamp: '2026-06-18 09:00', actor: 'DE', action: 'Positions auto-configured', detail: '5 of 8 positions created from employee role data. 3 need review.', status: 'pending' },
  { id: 'a9', timestamp: '2026-06-20 11:22', actor: 'DE', action: 'Leave rules proposed', detail: 'Matched TCP leave policy from HR handbook. 2 fields need clarification.', status: 'pending_review' },
];

const UPLOAD_MAPPINGS: UploadMapping[] = [
  { yourColumn: 'First Name', humanityField: 'first_name', confidence: 99, status: 'ok' },
  { yourColumn: 'Last Name', humanityField: 'last_name', confidence: 99, status: 'ok' },
  { yourColumn: 'Email Address', humanityField: 'email', confidence: 97, status: 'ok' },
  { yourColumn: 'Job Title', humanityField: 'position', confidence: 91, status: 'ok' },
  { yourColumn: 'Department', humanityField: 'department', confidence: 88, status: 'ok' },
  { yourColumn: 'Start Date', humanityField: 'hire_date', confidence: 85, status: 'ok' },
  { yourColumn: 'Emp Type', humanityField: 'employment_type', confidence: 72, status: 'warn' },
  { yourColumn: 'Mobile', humanityField: 'phone', confidence: 90, status: 'ok' },
  { yourColumn: 'Office', humanityField: 'location', confidence: 68, status: 'warn' },
  { yourColumn: 'Manager', humanityField: '*(unmapped)*', confidence: 0, status: 'unmapped' },
];

const SEED_CHAT: ChatMessage[] = [
  {
    id: 'c1',
    role: 'de',
    text: "I've loaded the Humanity.com onboarding framework for TCP Inc. We have 10 steps to complete. You're currently at 45% — steps 1 and 2 are done.\n\nStep 3 (Positions) is in progress — I've auto-configured 5 positions from the employee data. Want me to continue with the remaining 3, or do you want to review what I've done first?",
    time: '09:12',
  },
  {
    id: 'c2',
    role: 'user',
    text: 'Review first',
    time: '09:14',
  },
  {
    id: 'c3',
    role: 'de',
    text: "Here are the 5 positions I configured:\n• Support Agent — Grade 1, shift-eligible, min 2/shift\n• Team Lead — Grade 3, shift-eligible, min 1/shift\n• Quality Analyst — Grade 2, not shift-eligible\n• Billing Specialist — Grade 2, shift-eligible, min 1/shift\n• IT Support — Grade 2, on-call eligible\n\nThe 3 I couldn't auto-configure: \"Operations Manager\", \"Temp Staff\", and \"Contractor\" — these don't have enough employee data to infer shift settings. Should I use standard defaults, or do you want to set them manually?",
    time: '09:15',
  },
  {
    id: 'c4',
    role: 'user',
    text: 'Use standard defaults for Temp Staff and Contractor. Set Operations Manager as non-shift, Grade 4.',
    time: '09:20',
  },
  {
    id: 'c5',
    role: 'de',
    text: "Done. All 8 positions are now configured. Moving to Step 4 (Leave Rules) — I'll draft the configuration based on the HR handbook. Ready when you are.",
    time: '09:21',
  },
];

const PRODUCTS = ['Humanity.com', 'BambooHR', 'Zendesk', 'Salesforce', 'HubSpot', 'Other'];
const SPECIALISTS = ['Morgan Chen', 'Taylor Smith', 'Jordan Lee', 'You'];

// ─── Helper functions ─────────────────────────────────────────────────────────

function getStepsForProject(project: OnboardingProject): ChecklistStep[] {
  if (project.id === 'proj-001') return HUMANITY_STEPS;
  return DEFAULT_STEPS;
}

function getStatusDotColor(status: ProjectStatus): string {
  switch (status) {
    case 'complete': return 'bg-emerald-400';
    case 'in_progress': return 'bg-blue-400';
    case 'not_started': return 'bg-slate-500';
    case 'blocked': return 'bg-red-400';
  }
}

function getStepStatusIcon(status: StepStatus): { icon: string; color: string } {
  switch (status) {
    case 'complete': return { icon: '✓', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/30' };
    case 'in_progress': return { icon: '⟳', color: 'text-blue-400 bg-blue-400/10 border-blue-500/30' };
    case 'pending_review': return { icon: '⚠', color: 'text-amber-400 bg-amber-400/10 border-amber-500/30' };
    case 'not_started': return { icon: '○', color: 'text-slate-500 bg-slate-800 border-slate-600/30' };
  }
}

function deReply(input: string): string {
  const lower = input.toLowerCase();
  if (lower.includes('leave')) {
    return "Got it — checking Leave Rules (Step 4). I've already drafted a full configuration based on TCP's HR handbook. There are 2 items flagged for your review: the carryover cap and bereavement leave aren't specified in the uploaded documents. Would you like me to set standard defaults for those, or do you want to define them manually?";
  }
  if (lower.includes('upload') || lower.includes('csv') || lower.includes('file')) {
    return "Employee data upload completed — 138 employees uploaded successfully, 3 skipped (missing email), 1 corrected (employment_type normalized to \"Part Time\"). The data is now live in Humanity.com. Want me to run a validation check to confirm all records look correct?";
  }
  if (lower.includes('position') || lower.includes('role')) {
    return "All 8 positions are configured in Humanity.com. I used the standard defaults for Temp Staff and Contractor, and set Operations Manager as non-shift at Grade 4 as you requested. Do you want me to move ahead to Step 4 (Leave Rules) now?";
  }
  if (lower.includes('next') || lower.includes('step')) {
    return "The next pending step is Step 4 — Leave Rules Configuration. I've already drafted a proposal based on TCP's HR handbook. It's currently awaiting your review and approval before I can apply it. Want to go there now?";
  }
  if (lower.includes('progress') || lower.includes('status') || lower.includes('complete')) {
    return "Current progress: 45% complete. Steps 1 (Employee Data) and 2 (Locations) are done. Step 3 (Positions) just completed. Step 4 (Leave Rules) is pending your review. Steps 5–10 haven't started yet. Estimated time to completion at current pace: ~3 days.";
  }
  return "Got it. Let me check the current configuration status for that. Based on the project data, everything in steps 1–3 is configured and ready. The main blocker right now is Step 4 (Leave Rules) which needs your approval before I can proceed. Should I proceed or would you like to review first?";
}

// ─── Main Component ───────────────────────────────────────────────────────────

const CustomerOnboardingPage = ({ setPage: _setPage }: { setPage?: (p: Page) => void }) => {
  const { activeCompanyId, activeCompany } = useAuth();

  const [projects, setProjects] = useState<OnboardingProject[]>(SEED_PROJECTS);
  const [activeProject, setActiveProject] = useState<OnboardingProject | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('checklist');

  const [newProjectModal, setNewProjectModal] = useState(false);
  const [newClient, setNewClient] = useState('');
  const [newProduct, setNewProduct] = useState('');
  const [newSpecialist, setNewSpecialist] = useState('Morgan Chen');
  const [showProductSuggestions, setShowProductSuggestions] = useState(false);

  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [configSections, setConfigSections] = useState<Record<string, boolean>>({
    general: true, scheduling: false, leave: false, notifications: false, integrations: false,
  });

  const [uploadStep, setUploadStep] = useState<0 | 1 | 2 | 3>(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [mappings, setMappings] = useState<UploadMapping[]>(UPLOAD_MAPPINGS);
  const [editingMapping, setEditingMapping] = useState<string | null>(null);

  const [auditFilter, setAuditFilter] = useState<AuditFilter>('all');

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(SEED_CHAT);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [toastMsg, setToastMsg] = useState('');
  const [toastVisible, setToastVisible] = useState(false);

  function showToast(message: string) {
    setToastMsg(message);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 3000);
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    if (uploadStep === 3 && uploadProgress > 0 && !uploadDone) {
      const interval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 100) {
            clearInterval(interval);
            setUploadDone(true);
            return 100;
          }
          return prev + 5;
        });
      }, 100);
      return () => clearInterval(interval);
    }
  }, [uploadStep, uploadProgress, uploadDone]);

  function handleCreateProject() {
    if (!newClient.trim() || !newProduct.trim()) return;
    const proj: OnboardingProject = {
      id: `proj-${Date.now()}`,
      client: newClient.trim(),
      product: newProduct.trim(),
      specialist: newSpecialist,
      status: 'not_started',
      progress: 0,
      startDate: '2026-07-02',
      dueDate: '2026-07-30',
    };
    setProjects(prev => [...prev, proj]);
    setActiveProject(proj);
    setNewProjectModal(false);
    setNewClient('');
    setNewProduct('');
    setActiveTab('checklist');
  }

  function sendChat(text: string) {
    if (!text.trim()) return;
    const userMsg: ChatMessage = {
      id: `cm-${Date.now()}`,
      role: 'user',
      text: text.trim(),
      time: '09:' + String(Math.floor(Math.random() * 59)).padStart(2, '0'),
    };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);
    setTimeout(() => {
      const deMsg: ChatMessage = {
        id: `cm-${Date.now() + 1}`,
        role: 'de',
        text: deReply(text),
        time: '09:' + String(Math.floor(Math.random() * 59)).padStart(2, '0'),
      };
      setChatMessages(prev => [...prev, deMsg]);
      setChatLoading(false);
    }, 1500);
  }

  function sendQuickAction(type: 'next' | 'issues' | 'progress') {
    const prompts: Record<string, string> = {
      next: "What's next?",
      issues: "Any issues?",
      progress: "Progress summary",
    };
    sendChat(prompts[type]);
  }

  const steps = activeProject ? getStepsForProject(activeProject) : [];

  const filteredAudit = AUDIT_LOG.filter(entry => {
    if (auditFilter === 'all') return true;
    if (auditFilter === 'de') return entry.actor === 'DE';
    if (auditFilter === 'human') return entry.actor === 'Human';
    if (auditFilter === 'pending_review') return entry.status === 'pending_review' || entry.status === 'pending';
    if (auditFilter === 'approved') return entry.status === 'approved';
    return true;
  });

  // PWC — Onboarding is a lighter function (engagement setup)
  if (activeCompanyId !== 'tcp') {
    return (
      <div className="flex-1 flex flex-col overflow-auto bg-slate-950 p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Onboarding — Customer entity</h1>
          <p className="text-slate-400 text-sm mt-1">{activeCompany.name} · Client engagement setup</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-xl mb-4">⚙</div>
          <h2 className="text-lg font-semibold text-slate-200 mb-2">1 engagement setup in progress</h2>
          <p className="text-sm text-slate-500 max-w-sm mb-5">
            Harbor Financial — engagement setup is 60% complete. Morgan is verifying KYC documents
            and preparing the engagement letter for partner review.
          </p>
          <div className="w-64 bg-slate-800 rounded-full h-1.5 mb-2">
            <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: '60%' }} />
          </div>
          <p className="text-xs text-slate-600">Due 2026-07-20 · Handled by Morgan</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-slate-950 overflow-hidden">
      {toastVisible && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-800 border border-slate-600 text-white text-sm px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2">
          <span className="text-emerald-400">✓</span>
          {toastMsg}
        </div>
      )}

      {/* Projects Sidebar */}
      <div className="w-64 flex-shrink-0 bg-slate-900 border-r border-slate-700/50 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
          <span className="text-sm font-semibold text-white">Onboarding Projects</span>
          <button
            onClick={() => setNewProjectModal(true)}
            className="text-xs px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {projects.map(proj => (
            <button
              key={proj.id}
              onClick={() => { setActiveProject(proj); setActiveTab('checklist'); setOpenStepId(null); }}
              className={`w-full text-left p-3 rounded-xl border transition-all ${
                activeProject?.id === proj.id
                  ? 'border-indigo-500/50 bg-indigo-500/10'
                  : 'border-slate-700/50 bg-slate-800/50 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-white truncate">{proj.client}</span>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ml-1 ${getStatusDotColor(proj.status)}`} />
              </div>
              <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 mb-2">{proj.product}</span>
              <div className="text-xs text-slate-400 mb-2">{proj.specialist}</div>
              <div className="w-full bg-slate-700 rounded-full h-1 mb-1">
                <div className="h-1 rounded-full bg-indigo-500 transition-all" style={{ width: `${proj.progress}%` }} />
              </div>
              <div className="flex justify-between text-xs text-slate-500">
                <span>{proj.progress}%</span>
                <span>Due {proj.dueDate}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      {!activeProject ? (
        <div className="flex-1 flex items-center justify-center bg-slate-950">
          <div className="text-center">
            <div className="text-4xl mb-4">📋</div>
            <div className="text-lg font-semibold text-white mb-1">Select or create a project</div>
            <div className="text-sm text-slate-400 mb-6">Choose an onboarding project from the sidebar to get started</div>
            <button
              onClick={() => setNewProjectModal(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              + New Project
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Session panel */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/50 bg-slate-900 flex-shrink-0">
              <div className="flex items-center gap-2 text-sm flex-wrap">
                <span className="text-slate-400">Onboarding — Customer entity</span>
                <span className="text-slate-600">/</span>
                <span className="text-slate-300">{activeProject.client}</span>
                <span className="text-slate-600">/</span>
                <span className="text-white font-medium">{activeProject.product}</span>
                <span className={`ml-2 text-xs px-2 py-0.5 rounded-full border font-medium ${
                  activeProject.status === 'in_progress' ? 'text-blue-400 bg-blue-400/10 border-blue-500/30' :
                  activeProject.status === 'complete' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-500/30' :
                  activeProject.status === 'blocked' ? 'text-red-400 bg-red-400/10 border-red-500/30' :
                  'text-slate-400 bg-slate-700 border-slate-600'
                }`}>
                  {activeProject.status.replace('_', ' ')}
                </span>
              </div>
              <button
                onClick={() => setActiveTab('audit')}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex-shrink-0"
              >
                View Audit Log
              </button>
            </div>

            <div className="flex items-center gap-1 px-5 py-2 border-b border-slate-700/50 bg-slate-900 flex-shrink-0">
              {(['checklist', 'upload', 'configuration', 'audit'] as ActiveTab[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {tab === 'upload' ? 'Data Upload' : tab === 'audit' ? 'Audit Log' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-5">

              {/* CHECKLIST TAB */}
              {activeTab === 'checklist' && (
                <div className="space-y-3">
                  {steps.map(step => {
                    const { icon, color } = getStepStatusIcon(step.status);
                    const isOpen = openStepId === step.id;
                    return (
                      <div key={step.id} className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
                        <div className="flex items-center gap-4 p-4">
                          <div className={`w-8 h-8 rounded-full border flex items-center justify-center text-sm font-bold flex-shrink-0 ${color}`}>
                            {icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-white">{step.title}</span>
                              {step.handler === 'de' && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">DE handled</span>
                              )}
                              {step.handler === 'human' && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 border border-slate-600">Human handled</span>
                              )}
                              {step.itemCount !== null && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">{step.itemCount} items</span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5">{step.description}</div>
                          </div>
                          <div className="flex-shrink-0">
                            {step.status === 'complete' && (
                              <button onClick={() => setOpenStepId(isOpen ? null : step.id)} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors">
                                {isOpen ? 'Close' : 'View Details'}
                              </button>
                            )}
                            {step.status === 'in_progress' && (
                              <button onClick={() => setOpenStepId(isOpen ? null : step.id)} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
                                {isOpen ? 'Close' : 'Continue →'}
                              </button>
                            )}
                            {step.status === 'pending_review' && (
                              <button onClick={() => setOpenStepId(isOpen ? null : step.id)} className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors">
                                {isOpen ? 'Close' : 'Review & Approve'}
                              </button>
                            )}
                            {step.status === 'not_started' && (
                              <button onClick={() => setOpenStepId(isOpen ? null : step.id)} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 transition-colors">
                                {isOpen ? 'Close' : 'Start'}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Step 4 — Leave Rules review */}
                        {isOpen && step.id === 'step-4' && (
                          <div className="border-t border-slate-700/50 p-5 bg-slate-800/30">
                            <div className="flex items-center justify-between mb-4">
                              <h3 className="text-sm font-semibold text-white">Leave Rules — Proposed by DE</h3>
                              <div className="flex gap-2">
                                <button className="text-xs px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">Edit</button>
                                <button onClick={() => showToast('All leave rules approved and applied.')} className="text-xs px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors">Approve All</button>
                              </div>
                            </div>
                            <div className="space-y-2.5">
                              {[
                                { label: 'Annual PTO', value: '15 days/year, accrues monthly', s: 'ok' as const },
                                { label: 'Sick Leave', value: '10 days/year, available immediately', s: 'ok' as const },
                                { label: 'Unpaid Leave', value: 'Allowed, requires manager approval', s: 'ok' as const },
                                { label: 'Carryover', value: 'Not configured — carries over full balance', s: 'warn' as const },
                                { label: 'Parental Leave', value: '12 weeks, paid at 100%', s: 'ok' as const },
                                { label: 'Bereavement', value: 'Not configured', s: 'error' as const },
                              ].map(row => (
                                <div key={row.label} className={`flex items-start gap-3 p-3 rounded-lg border ${
                                  row.s === 'ok' ? 'bg-emerald-500/5 border-emerald-500/10' :
                                  row.s === 'warn' ? 'bg-amber-500/5 border-amber-500/10' :
                                  'bg-red-500/5 border-red-500/10'
                                }`}>
                                  <span className={`text-sm mt-0.5 flex-shrink-0 ${
                                    row.s === 'ok' ? 'text-emerald-400' : row.s === 'warn' ? 'text-amber-400' : 'text-red-400'
                                  }`}>
                                    {row.s === 'ok' ? '✓' : row.s === 'warn' ? '⚠' : '✗'}
                                  </span>
                                  <div className="flex-1">
                                    <div className="text-xs font-medium text-white">{row.label}</div>
                                    <div className="text-xs text-slate-400 mt-0.5">{row.value}</div>
                                    {row.s === 'warn' && (
                                      <div className="mt-1.5">
                                        <input placeholder="Set limit: ___ days" className="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white w-40 focus:outline-none focus:border-indigo-500" />
                                      </div>
                                    )}
                                    {row.s === 'error' && (
                                      <div className="mt-1.5 flex gap-2">
                                        <button className="text-xs px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">Add rule</button>
                                        <button className="text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors">Skip</button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="mt-4 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20">
                              <div className="text-xs text-slate-300 font-medium mb-1">DE note</div>
                              <div className="text-xs text-slate-400">I've matched TCP's leave policy from the HR handbook uploaded in step 1. The carryover cap and bereavement leave were not specified — please confirm or I can set standard defaults.</div>
                            </div>
                            <div className="flex justify-end gap-2 mt-4">
                              <button className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 transition-colors">Request changes</button>
                              <button
                                onClick={() => { showToast('Leave rules approved and applied to Humanity.com.'); setOpenStepId(null); }}
                                className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
                              >
                                Approve & Apply
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Step 3 — Positions table */}
                        {isOpen && step.id === 'step-3' && (
                          <div className="border-t border-slate-700/50 p-5 bg-slate-800/30">
                            <h3 className="text-sm font-semibold text-white mb-3">Positions & Roles</h3>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-slate-400 border-b border-slate-700">
                                    <th className="text-left py-2 pr-4">Position</th>
                                    <th className="text-left py-2 pr-4">Min Staff</th>
                                    <th className="text-left py-2 pr-4">Shift Eligible</th>
                                    <th className="text-left py-2 pr-4">Pay Grade</th>
                                    <th className="text-left py-2">Status</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                  {[
                                    { pos: 'Team Lead', min: 2, shift: true, grade: 'Grade 3' },
                                    { pos: 'Support Agent', min: 8, shift: true, grade: 'Grade 1' },
                                    { pos: 'Quality Analyst', min: 2, shift: false, grade: 'Grade 2' },
                                    { pos: 'Billing Specialist', min: 1, shift: true, grade: 'Grade 2' },
                                    { pos: 'IT Support', min: 1, shift: false, grade: 'Grade 2' },
                                  ].map(row => (
                                    <tr key={row.pos} className="text-slate-300">
                                      <td className="py-2 pr-4 font-medium">{row.pos}</td>
                                      <td className="py-2 pr-4">{row.min}</td>
                                      <td className="py-2 pr-4">{row.shift ? 'Yes' : 'No'}</td>
                                      <td className="py-2 pr-4">{row.grade}</td>
                                      <td className="py-2"><span className="text-emerald-400">✓</span></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="mt-3 flex items-center gap-2 text-xs text-blue-400 bg-blue-400/5 border border-blue-500/20 px-3 py-2 rounded-lg">
                              <span className="animate-spin inline-block">⟳</span>
                              DE is configuring remaining 3 positions (Operations Manager, Temp Staff, Contractor)...
                            </div>
                          </div>
                        )}

                        {/* Generic panel */}
                        {isOpen && step.id !== 'step-3' && step.id !== 'step-4' && (
                          <div className="border-t border-slate-700/50 p-4 bg-slate-800/30">
                            <div className="text-xs">
                              {step.status === 'complete' && (
                                <span className="text-emerald-400">✓ This step was completed successfully. All items are configured in {activeProject.product}.</span>
                              )}
                              {step.status === 'not_started' && (
                                <div className="flex items-center gap-2">
                                  <span className="animate-spin inline-block text-blue-400">⟳</span>
                                  <span className="text-blue-300">DE is initializing this step and reviewing requirements...</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* DATA UPLOAD TAB */}
              {activeTab === 'upload' && (
                <div>
                  {uploadStep === 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-white mb-1">Data Upload</h2>
                      <p className="text-xs text-slate-400 mb-5">Upload employee, location, or position data. The DE will auto-map columns to {activeProject.product} fields.</p>
                      <div className="border-2 border-dashed border-slate-600 hover:border-indigo-500/50 rounded-xl p-10 text-center mb-4 transition-colors cursor-pointer bg-slate-800/20">
                        <div className="text-3xl mb-3">📂</div>
                        <div className="text-sm font-medium text-white mb-1">Drop a CSV or Excel file here, or click to browse</div>
                        <div className="text-xs text-slate-400">Supported: Employees, Locations, Positions, Leave Balances</div>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs text-slate-400">Or use a sample file:</span>
                        {['Employees CSV', 'Locations CSV', 'Positions CSV'].map(label => (
                          <button key={label} onClick={() => setUploadStep(1)} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors">
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {uploadStep === 1 && (
                    <div>
                      <div className="flex items-center gap-2 mb-4">
                        <button onClick={() => setUploadStep(0)} className="text-xs text-slate-400 hover:text-white">← Back</button>
                        <span className="text-xs text-slate-600">/</span>
                        <span className="text-xs text-white">File Preview</span>
                      </div>
                      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4 mb-4">
                        <div className="flex items-center gap-2 mb-3">
                          <span>📄</span>
                          <span className="text-sm font-medium text-white">employees_tcp.csv</span>
                          <span className="text-xs text-slate-400">— 142 rows detected</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-400 border-b border-slate-700">
                                {['First Name','Last Name','Email Address','Job Title','Department','Start Date','Emp Type','Mobile','Office','Manager'].map(h => (
                                  <th key={h} className="text-left py-2 pr-3 font-medium whitespace-nowrap">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {[
                                ['Sarah','Mitchell','s.m@tcp.com','Support Agent','Ops','2023-01-10','FT','07700900001','London HQ','J. Cooper'],
                                ['James','Cooper','j.c@tcp.com','Team Lead','Ops','2022-03-01','FT','07700900002','New York',''],
                                ['Priya','Nair','p.n@tcp.com','QA Analyst','Quality','2023-06-15','PT','07700900003','Singapore','J. Cooper'],
                              ].map((row, i) => (
                                <tr key={i} className="text-slate-300">
                                  {row.map((cell, j) => <td key={j} className="py-2 pr-3 whitespace-nowrap">{cell}</td>)}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-2 text-xs text-slate-500">Showing 3 of 142 rows</div>
                      </div>
                      <button onClick={() => setUploadStep(2)} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
                        Continue to Column Mapping →
                      </button>
                    </div>
                  )}

                  {uploadStep === 2 && (
                    <div>
                      <div className="flex items-center gap-2 mb-4">
                        <button onClick={() => setUploadStep(1)} className="text-xs text-slate-400 hover:text-white">← Back</button>
                        <span className="text-xs text-slate-600">/</span>
                        <span className="text-xs text-white">AI Column Mapping</span>
                      </div>
                      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4 mb-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold text-white">Column Mapping</h3>
                          <span className="text-xs text-slate-400">DE auto-mapped 8 of 10 columns</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-400 border-b border-slate-700">
                                <th className="text-left py-2 pr-4">Your Column</th>
                                <th className="text-center py-2 pr-4">→</th>
                                <th className="text-left py-2 pr-4">Humanity.com Field</th>
                                <th className="text-left py-2 pr-4">Confidence</th>
                                <th className="text-left py-2"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {mappings.map(m => (
                                <tr key={m.yourColumn} className={m.status === 'warn' ? 'bg-amber-500/5' : m.status === 'unmapped' ? 'bg-red-500/5' : ''}>
                                  <td className="py-2 pr-4 text-white font-medium">{m.yourColumn}</td>
                                  <td className="py-2 pr-4 text-center text-slate-500">→</td>
                                  <td className="py-2 pr-4">
                                    {editingMapping === m.yourColumn ? (
                                      <select
                                        className="text-xs bg-slate-800 border border-indigo-500 rounded px-2 py-1 text-white focus:outline-none"
                                        defaultValue={m.humanityField}
                                        onChange={e => {
                                          setMappings(prev => prev.map(x =>
                                            x.yourColumn === m.yourColumn
                                              ? { ...x, humanityField: e.target.value, status: 'ok', confidence: 95 }
                                              : x
                                          ));
                                          setEditingMapping(null);
                                        }}
                                      >
                                        {['first_name','last_name','email','position','department','hire_date','employment_type','contract_type','phone','location','manager'].map(f => (
                                          <option key={f} value={f}>{f}</option>
                                        ))}
                                      </select>
                                    ) : (
                                      <span className={m.status === 'unmapped' ? 'text-red-400 italic' : 'text-slate-300'}>{m.humanityField}</span>
                                    )}
                                  </td>
                                  <td className="py-2 pr-4">
                                    {m.status === 'ok' && <span className="text-emerald-400">✓ {m.confidence}%</span>}
                                    {m.status === 'warn' && <span className="text-amber-400">⚠ {m.confidence}%</span>}
                                    {m.status === 'unmapped' && <span className="text-red-400">✗ —</span>}
                                  </td>
                                  <td className="py-2">
                                    {(m.status === 'warn' || m.status === 'unmapped') && (
                                      <button
                                        onClick={() => setEditingMapping(m.yourColumn)}
                                        className={`text-xs px-2 py-0.5 rounded transition-colors ${
                                          m.status === 'unmapped' ? 'bg-red-600/20 text-red-300 hover:bg-red-600/40' : 'bg-amber-600/20 text-amber-300 hover:bg-amber-600/40'
                                        }`}
                                      >
                                        {m.status === 'unmapped' ? 'map' : 'edit'}
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20 mb-4">
                        <div className="text-xs text-slate-300 font-medium mb-1">DE note</div>
                        <div className="text-xs text-slate-400">I matched 8 of 10 columns automatically. 2 need your review: 'Emp Type' might be 'employment_type' or 'contract_type', and 'Office' could be 'location' or 'department'. Please confirm.</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setUploadStep(1)} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-sm transition-colors">Back</button>
                        <button
                          onClick={() => { setUploadStep(3); setUploadDone(false); setUploadProgress(0); }}
                          className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                        >
                          Approve Mapping & Continue →
                        </button>
                      </div>
                    </div>
                  )}

                  {uploadStep === 3 && !uploadDone && (
                    <div>
                      <div className="flex items-center gap-2 mb-4">
                        <button onClick={() => setUploadStep(2)} className="text-xs text-slate-400 hover:text-white">← Back</button>
                        <span className="text-xs text-slate-600">/</span>
                        <span className="text-xs text-white">Validation Preview</span>
                      </div>
                      <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4 mb-4">
                        <h3 className="text-sm font-semibold text-white mb-3">Mapped Data Preview</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-400 border-b border-slate-700">
                                {['first_name','last_name','email','position','employment_type','location'].map(h => (
                                  <th key={h} className="text-left py-2 pr-4 font-medium">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {[
                                ['Sarah','Mitchell','s.m@tcp.com','Support Agent','Full Time','London HQ'],
                                ['James','Cooper','j.c@tcp.com','Team Lead','Full Time','New York'],
                                ['Priya','Nair','p.n@tcp.com','QA Analyst','Part Time','Singapore'],
                                ['Ali','Hassan','a.h@tcp.com','Billing Specialist','Full Time','London HQ'],
                                ['Emily','Torres','e.t@tcp.com','IT Support','Full Time','Remote'],
                              ].map((row, i) => (
                                <tr key={i} className="text-slate-300">
                                  {row.map((cell, j) => <td key={j} className="py-2 pr-4 whitespace-nowrap">{cell}</td>)}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-2 text-xs text-slate-500">Showing 5 of 142 rows</div>
                      </div>
                      <div className="p-3 rounded-lg bg-slate-900 border border-slate-700/50 mb-4 space-y-1.5">
                        <div className="flex items-center gap-2 text-xs text-emerald-400"><span>✓</span><span>138 rows ready to upload</span></div>
                        <div className="flex items-center gap-2 text-xs text-amber-400"><span>⚠</span><span>3 rows have missing email — will be skipped</span></div>
                        <div className="flex items-center gap-2 text-xs text-amber-400"><span>⚠</span><span>1 row has invalid employment_type value "PT" — will default to "Part Time"</span></div>
                      </div>
                      {uploadProgress === 0 ? (
                        <button
                          onClick={() => setUploadProgress(1)}
                          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                        >
                          Upload 138 Employees →
                        </button>
                      ) : (
                        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-4">
                          <div className="text-xs text-slate-400 mb-2">Uploading employees...</div>
                          <div className="w-full bg-slate-800 rounded-full h-2 mb-1">
                            <div className="h-2 rounded-full bg-emerald-500 transition-all duration-100" style={{ width: `${uploadProgress}%` }} />
                          </div>
                          <div className="text-xs text-slate-400">{uploadProgress}%</div>
                        </div>
                      )}
                    </div>
                  )}

                  {uploadDone && (
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-6 text-center">
                      <div className="text-3xl mb-3">✓</div>
                      <div className="text-sm font-semibold text-emerald-400 mb-1">138 employees uploaded successfully</div>
                      <div className="text-xs text-slate-400 mb-1">3 skipped (missing email)</div>
                      <div className="text-xs text-slate-400 mb-4">1 corrected (employment_type normalized)</div>
                      <div className="text-xs text-slate-500 mb-4">This action was logged to the audit trail.</div>
                      <div className="flex justify-center gap-2">
                        <button onClick={() => setActiveTab('audit')} className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors">View Audit Entry</button>
                        <button onClick={() => { setUploadStep(0); setUploadDone(false); setUploadProgress(0); }} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">Upload Another File</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* CONFIGURATION TAB */}
              {activeTab === 'configuration' && (
                <div>
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold text-white">{activeProject.product} Configuration — {activeProject.client}</h2>
                    <p className="text-xs text-slate-400 mt-0.5">Review and manage all product settings</p>
                  </div>
                  <div className="space-y-3 mb-5">
                    {([
                      {
                        key: 'general',
                        title: 'General Settings',
                        configStatus: 'complete',
                        items: [
                          { label: 'Company name', value: 'TCP Inc' },
                          { label: 'Time zone', value: 'GMT+0 (London)' },
                          { label: 'Week start day', value: 'Monday' },
                          { label: 'Currency', value: 'GBP £' },
                        ],
                      },
                      {
                        key: 'scheduling',
                        title: 'Scheduling',
                        configStatus: 'needs_review',
                        items: [
                          { label: 'Min hours/week', value: null as string | null },
                          { label: 'Max hours/week', value: '48' },
                          { label: 'Break rules', value: '30min after 6hrs' },
                          { label: 'Shift overlap buffer', value: '15 min' },
                        ],
                      },
                      {
                        key: 'leave',
                        title: 'Leave Management',
                        configStatus: 'pending',
                        items: [] as { label: string; value: string | null }[],
                      },
                      {
                        key: 'notifications',
                        title: 'Notifications',
                        configStatus: 'not_configured',
                        items: [
                          { label: 'Shift reminder', value: null as string | null },
                          { label: 'Swap request alerts', value: null as string | null },
                          { label: 'Payroll export', value: null as string | null },
                        ],
                      },
                      {
                        key: 'integrations',
                        title: 'Integrations',
                        configStatus: 'not_started',
                        items: [
                          { label: 'Payroll connector', value: null as string | null },
                          { label: 'HR sync', value: null as string | null },
                        ],
                      },
                    ] as const).map(section => {
                      const isOpen = configSections[section.key];
                      const statusLabel: Record<string, string> = {
                        complete: 'Complete', needs_review: 'Needs Review', pending: 'Pending Approval',
                        not_configured: 'Not Configured', not_started: 'Not Started',
                      };
                      const statusColor: Record<string, string> = {
                        complete: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/30',
                        needs_review: 'text-amber-400 bg-amber-400/10 border-amber-500/30',
                        pending: 'text-indigo-400 bg-indigo-400/10 border-indigo-500/30',
                        not_configured: 'text-slate-400 bg-slate-700 border-slate-600',
                        not_started: 'text-slate-500 bg-slate-800 border-slate-700',
                      };
                      return (
                        <div key={section.key} className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
                          <button
                            className="w-full flex items-center justify-between px-4 py-3 text-left"
                            onClick={() => setConfigSections(prev => ({ ...prev, [section.key]: !prev[section.key] }))}
                          >
                            <span className="text-sm font-semibold text-white">{section.title}</span>
                            <div className="flex items-center gap-2">
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusColor[section.configStatus]}`}>
                                {statusLabel[section.configStatus]}
                              </span>
                              <span className="text-slate-600 text-xs">{isOpen ? '▲' : '▼'}</span>
                            </div>
                          </button>
                          {isOpen && (
                            <div className="border-t border-slate-800 px-4 pb-4 pt-3 space-y-2">
                              {section.key === 'leave' ? (
                                <div className="text-xs text-slate-400">
                                  Leave rules are pending your approval from Step 4.{' '}
                                  <button
                                    onClick={() => { setActiveTab('checklist'); setOpenStepId('step-4'); }}
                                    className="text-indigo-400 hover:text-indigo-300 underline"
                                  >
                                    Go to Checklist → step 4
                                  </button>
                                </div>
                              ) : section.items.map(item => (
                                <div key={item.label} className="flex items-center justify-between py-1 border-b border-slate-800 last:border-0">
                                  <span className="text-xs text-slate-400">├ {item.label}</span>
                                  <div className="flex items-center gap-2">
                                    {item.value ? (
                                      <>
                                        <span className="text-xs text-white">{item.value}</span>
                                        {section.configStatus === 'complete' && <span className="text-xs text-emerald-400">✓</span>}
                                      </>
                                    ) : (
                                      <>
                                        <span className="text-xs text-slate-600">—</span>
                                        <button
                                          onClick={() => showToast('Opening in Humanity.com...')}
                                          className="text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                                        >
                                          {section.configStatus === 'not_started' ? 'Connect' : section.configStatus === 'not_configured' ? 'Configure' : 'Set default'}
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="p-4 rounded-xl bg-indigo-500/5 border border-indigo-500/20">
                    <div className="text-xs font-semibold text-white mb-1">DE Configuration Summary</div>
                    <div className="text-xs text-slate-400">The DE has configured 4 of 7 sections. 2 sections need your review before they can be applied. 1 section is waiting for your approval from the Leave Rules step.</div>
                    <div className="mt-2 text-xs text-slate-400">Estimated time to complete: <span className="text-white">~45 minutes</span> with current progress.</div>
                  </div>
                </div>
              )}

              {/* AUDIT LOG TAB */}
              {activeTab === 'audit' && (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-white">Audit Log — {activeProject.client}</h2>
                    <button
                      onClick={() => showToast('Audit report downloaded as PDF')}
                      className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                    >
                      Export Audit Report
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mb-4 flex-wrap">
                    {(['all', 'de', 'human', 'pending_review', 'approved'] as AuditFilter[]).map(f => (
                      <button
                        key={f}
                        onClick={() => setAuditFilter(f)}
                        className={`text-xs px-3 py-1 rounded-lg font-medium transition-colors ${
                          auditFilter === f ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'
                        }`}
                      >
                        {f === 'de' ? 'DE Actions' : f === 'human' ? 'Human Actions' : f === 'pending_review' ? 'Pending Review' : f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div className="bg-slate-900 border border-slate-700/50 rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700 bg-slate-800/50">
                          <th className="text-left py-2.5 px-4 font-medium">Timestamp</th>
                          <th className="text-left py-2.5 px-4 font-medium">Actor</th>
                          <th className="text-left py-2.5 px-4 font-medium">Action</th>
                          <th className="text-left py-2.5 px-4 font-medium hidden lg:table-cell">Detail</th>
                          <th className="text-left py-2.5 px-4 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {filteredAudit.map(entry => (
                          <tr key={entry.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">{entry.timestamp}</td>
                            <td className="py-2.5 px-4">
                              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                                entry.actor === 'DE' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-700 text-slate-400'
                              }`}>
                                {entry.actor}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-white font-medium whitespace-nowrap">{entry.action}</td>
                            <td className="py-2.5 px-4 text-slate-400 hidden lg:table-cell">{entry.detail}</td>
                            <td className="py-2.5 px-4">
                              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                                entry.status === 'approved' ? 'bg-emerald-500/20 text-emerald-400' :
                                entry.status === 'auto' ? 'bg-slate-700 text-slate-400' :
                                entry.status === 'pending_review' ? 'bg-amber-500/20 text-amber-400' :
                                'bg-blue-500/20 text-blue-400'
                              }`}>
                                {entry.status === 'auto' ? 'Auto' : entry.status === 'approved' ? 'Approved' : entry.status === 'pending_review' ? 'Pending Review' : 'Pending'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* AI Assistant Panel */}
          <div className="w-80 flex-shrink-0 bg-slate-900 border-l border-slate-700/50 flex flex-col overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/50 flex-shrink-0">
              <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">DE</div>
              <div>
                <div className="text-sm font-semibold text-white">Onboarding Assistant</div>
                <div className="flex items-center gap-1 text-xs text-emerald-400">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Online
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMessages.map(msg => (
                <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'de' && (
                    <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs flex-shrink-0 mt-0.5">DE</div>
                  )}
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
                    <div className="text-xs whitespace-pre-line leading-relaxed">{msg.text}</div>
                    <div className={`text-xs mt-1 ${msg.role === 'user' ? 'text-indigo-200' : 'text-slate-500'}`}>{msg.time}</div>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex gap-2 justify-start">
                  <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs flex-shrink-0 mt-0.5">DE</div>
                  <div className="bg-slate-800 rounded-xl px-3 py-3">
                    <div className="flex gap-1 items-center">
                      {[0, 150, 300].map(delay => (
                        <div key={delay} className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="px-3 py-2 border-t border-slate-700/50 flex gap-1 flex-wrap">
              <button onClick={() => sendQuickAction('next')} className="text-xs px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors">📋 What's next?</button>
              <button onClick={() => sendQuickAction('issues')} className="text-xs px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors">⚠ Any issues?</button>
              <button onClick={() => sendQuickAction('progress')} className="text-xs px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors">📊 Progress</button>
            </div>
            <div className="px-3 pb-3 flex-shrink-0">
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(chatInput); } }}
                  placeholder="Ask the DE anything..."
                  className="flex-1 text-xs bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                <button
                  onClick={() => sendChat(chatInput)}
                  disabled={!chatInput.trim()}
                  className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs transition-colors"
                >
                  →
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* New Project Modal */}
      {newProjectModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-white">New Onboarding Project</h2>
              <button onClick={() => setNewProjectModal(false)} className="text-slate-500 hover:text-white text-xl leading-none transition-colors">×</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Client Name</label>
                <input
                  value={newClient}
                  onChange={e => setNewClient(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="w-full text-sm bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
              <div className="relative">
                <label className="block text-xs text-slate-400 mb-1.5">Product</label>
                <input
                  value={newProduct}
                  onChange={e => { setNewProduct(e.target.value); setShowProductSuggestions(true); }}
                  onFocus={() => setShowProductSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowProductSuggestions(false), 150)}
                  placeholder="e.g. Humanity.com"
                  className="w-full text-sm bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                {showProductSuggestions && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded-xl overflow-hidden z-10">
                    {PRODUCTS.filter(p => !newProduct || p.toLowerCase().includes(newProduct.toLowerCase())).map(p => (
                      <button
                        key={p}
                        onMouseDown={() => { setNewProduct(p); setShowProductSuggestions(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Assign Specialist</label>
                <select
                  value={newSpecialist}
                  onChange={e => setNewSpecialist(e.target.value)}
                  className="w-full text-sm bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-indigo-500 transition-colors"
                >
                  {SPECIALISTS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => setNewProjectModal(false)} className="flex-1 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-sm transition-colors">Cancel</button>
              <button
                onClick={handleCreateProject}
                disabled={!newClient.trim() || !newProduct.trim()}
                className="flex-1 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                Create Project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerOnboardingPage;
