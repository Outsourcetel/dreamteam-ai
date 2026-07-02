import React, { useState, useEffect, useRef } from 'react'
import { AuthUser, Tenant, Page } from '../../types'
import { Badge, StatCard, Modal, PageTabs, HUB_TABS } from '../../components'
import { DBKnowledgeArticle, DBProfile, upsertKnowledgeArticle, updateArticleStatus, fetchKnowledgeArticles, fetchTenantProfiles } from '../../lib/api'
import { ingestArticle } from '../../services/knowledgeIngestionService'

// ---- Search quality config ----
type SearchConfig = {
  rerankingModel: 'keyword' | 'semantic' | 'hybrid';
  topK: number;
  finalK: number;
  minConfidence: number;
  audienceFilter: { customer: boolean; internal: boolean; both: boolean };
};

function defaultSearchConfig(): SearchConfig {
  return { rerankingModel: 'hybrid', topK: 10, finalK: 3, minConfidence: 40, audienceFilter: { customer: true, internal: true, both: true } };
}

function loadSearchConfig(tenantId: string): SearchConfig {
  try {
    const raw = localStorage.getItem(`dt_kb_search_${tenantId}`);
    return raw ? { ...defaultSearchConfig(), ...JSON.parse(raw) } : defaultSearchConfig();
  } catch { return defaultSearchConfig(); }
}

function saveSearchConfig(tenantId: string, cfg: SearchConfig) {
  try { localStorage.setItem(`dt_kb_search_${tenantId}`, JSON.stringify(cfg)); } catch {}
}

function hybridScore(article: DBKnowledgeArticle, query: string, mode: 'keyword' | 'semantic' | 'hybrid'): { kw: number; semantic: number; final: number } {
  const q = query.toLowerCase();
  const titleWords = article.title.toLowerCase().split(/\s+/);
  const bodyWords = (article.body || '').toLowerCase().split(/\s+/).slice(0, 200);
  const tagWords = (article.tags || []).join(' ').toLowerCase().split(/\s+/);
  const queryWords = q.split(/\s+/).filter(w => w.length > 2);

  let kwScore = 0;
  for (const qw of queryWords) {
    if (titleWords.some(w => w.includes(qw))) kwScore += 3;
    if (bodyWords.some(w => w.includes(qw))) kwScore += 1;
    if (tagWords.some(w => w.includes(qw))) kwScore += 2;
  }

  const queryChars = new Set(q.replace(/\s/g, '').split(''));
  const titleChars = new Set(article.title.toLowerCase().replace(/\s/g, '').split(''));
  const overlap = [...queryChars].filter(c => titleChars.has(c)).length;
  const semanticScore = queryChars.size > 0 ? overlap / Math.max(queryChars.size, titleChars.size) : 0;

  const daysSinceUpdate = (Date.now() - new Date((article as any).updated_at || (article as any).created_at).getTime()) / 86400000;
  const freshnessBoost = daysSinceUpdate < 30 ? 0.1 : 0;

  let finalScore: number;
  if (mode === 'keyword') finalScore = kwScore;
  else if (mode === 'semantic') finalScore = semanticScore * 10 + freshnessBoost * 10;
  else finalScore = (kwScore * 0.6) + (semanticScore * 10 * 0.4) + (freshnessBoost * 10);

  return { kw: kwScore, semantic: semanticScore, final: finalScore };
}

// ---- Article quality score ----
function articleQualityScore(article: DBKnowledgeArticle): number {
  let score = 0;
  if (article.title && article.title.length > 10) score += 20;
  if (article.body && article.body.length > 200) score += 25;
  if (article.body && article.body.length > 1000) score += 10;
  if (article.summary && article.summary.length > 50) score += 15;
  if (article.tags && article.tags.filter(t => !t.startsWith('__')).length > 0) score += 10;
  if (article.category) score += 10;
  if (article.audience) score += 10;
  return Math.min(score, 100);
}

function qualityLabel(score: number): { label: string; color: string; bg: string } {
  if (score >= 80) return { label: 'Excellent', color: 'text-emerald-400', bg: 'bg-emerald-500/20' };
  if (score >= 60) return { label: 'Good', color: 'text-blue-400', bg: 'bg-blue-500/20' };
  if (score >= 40) return { label: 'Fair', color: 'text-amber-400', bg: 'bg-amber-500/20' };
  return { label: 'Needs work', color: 'text-red-400', bg: 'bg-red-500/20' };
}

function qualityMissingHints(article: DBKnowledgeArticle): string[] {
  const hints: string[] = [];
  if (!article.title || article.title.length <= 10) hints.push('Add a descriptive title (+20 pts)');
  if (!article.body || article.body.length <= 200) hints.push('Add more body content (+25 pts)');
  else if (article.body.length <= 1000) hints.push('Expand article for depth bonus (+10 pts)');
  if (!article.summary || article.summary.length <= 50) hints.push('Add a summary (+15 pts)');
  if (!article.tags || article.tags.filter(t => !t.startsWith('__')).length === 0) hints.push('Add tags to improve +10 pts');
  if (!article.category) hints.push('Set a category (+10 pts)');
  if (!article.audience) hints.push('Set audience (+10 pts)');
  return hints;
}

// ---- Coverage gaps data ----
const SAMPLE_GAPS = [
  { topic: 'Cancellation and churn process', queryCount: 47, covered: false },
  { topic: 'API rate limit errors', queryCount: 31, covered: false },
  { topic: 'SSO configuration guide', queryCount: 28, covered: true },
  { topic: 'Data export and GDPR requests', queryCount: 24, covered: false },
  { topic: 'Pricing and plan comparison', queryCount: 19, covered: true },
];

// ---- Article overlay (localStorage) helpers ----
type ArticleMeta = {
  status?: string;
  reviewNote?: string;
  reviewDate?: string;
  reviewerId?: string;
  scheduledAt?: string;
}

type ArticleVersion = {
  savedAt: string;
  title: string;
  body: string;
}

function loadMeta(tenantId: string): Record<string, ArticleMeta> {
  try { return JSON.parse(localStorage.getItem(`dt_article_meta_${tenantId}`) || '{}'); } catch { return {}; }
}

function saveMeta(tenantId: string, meta: Record<string, ArticleMeta>) {
  try { localStorage.setItem(`dt_article_meta_${tenantId}`, JSON.stringify(meta)); } catch {}
}

function patchMeta(tenantId: string, articleId: string, patch: Partial<ArticleMeta>) {
  const meta = loadMeta(tenantId);
  meta[articleId] = { ...(meta[articleId] || {}), ...patch };
  saveMeta(tenantId, meta);
}

function clearArticleMeta(tenantId: string, articleId: string) {
  const meta = loadMeta(tenantId);
  delete meta[articleId];
  saveMeta(tenantId, meta);
}

function getArticleStatus(article: DBKnowledgeArticle, meta: Record<string, ArticleMeta>): string {
  if (article.status === 'published') return 'published';
  return meta[article.id]?.status || 'draft';
}

function loadVersions(articleId: string): ArticleVersion[] {
  try { return JSON.parse(localStorage.getItem(`dt_article_versions_${articleId}`) || '[]'); } catch { return []; }
}

function pushVersion(articleId: string, version: ArticleVersion) {
  const versions = loadVersions(articleId);
  versions.unshift(version);
  const trimmed = versions.slice(0, 10);
  try { localStorage.setItem(`dt_article_versions_${articleId}`, JSON.stringify(trimmed)); } catch {}
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  draft: 'bg-slate-700/50 text-slate-400',
  in_review: 'bg-amber-500/15 text-amber-400',
  needs_revision: 'bg-red-500/15 text-red-400',
  approved: 'bg-blue-500/15 text-blue-400',
  published: 'bg-emerald-500/15 text-emerald-400',
  scheduled: 'bg-purple-500/15 text-purple-400',
  archived: 'bg-slate-800/50 text-slate-600',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  needs_revision: 'Needs Revision',
  approved: 'Approved',
  published: 'Published',
  scheduled: 'Scheduled',
  archived: 'Archived',
};

// ---- Local types ----
type KnowledgeItemType =
  | 'article'
  | 'release_note'
  | 'resolved_ticket'
  | 'file'
  | 'video'
  | 'policy';

interface KnowledgeItem {
  id: string;
  title: string;
  type: KnowledgeItemType;
  audience: string;
  productId: string;
  moduleId: string;
  sectionId: string;
  subSectionId: string;
  tags: string[];
  subTags: string[];
  summary: string;
  author: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  freshnessScore: number;
  viewCount: number;
  helpfulRating: number;
  embedStatus: 'indexed' | 'pending' | 'stale' | 'failed';
  chunkCount: number;
}

const mockKnowledgeItems: KnowledgeItem[] = [
  {
    id: 'ki1',
    title: 'How to Request a Refund',
    type: 'article',
    audience: 'Customer',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's9',
    subSectionId: 'ss25',
    tags: ['billing', 'refund'],
    subTags: ['refund', 'credit'],
    summary:
      'Step-by-step guide for customers requesting refunds through the portal or by contacting support.',
    author: 'Sarah Kim',
    version: '2.1',
    createdAt: '2025-11-01',
    updatedAt: '2026-06-10',
    freshnessScore: 98,
    viewCount: 4821,
    helpfulRating: 94,
    embedStatus: 'indexed',
    chunkCount: 6,
  },
  {
    id: 'ki2',
    title: 'Understanding Your Invoice',
    type: 'article',
    audience: 'Both',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's9',
    subSectionId: 'ss23',
    tags: ['billing'],
    subTags: ['invoice', 'payment'],
    summary:
      'Explains each line item on the DreamTeam monthly invoice including token usage, seat costs, and add-ons.',
    author: 'James Patel',
    version: '3.0',
    createdAt: '2025-09-15',
    updatedAt: '2026-05-22',
    freshnessScore: 95,
    viewCount: 3210,
    helpfulRating: 91,
    embedStatus: 'indexed',
    chunkCount: 8,
  },
  {
    id: 'ki3',
    title: 'Setting Up Two-Factor Authentication',
    type: 'article',
    audience: 'Customer',
    productId: 'p2',
    moduleId: 'm5',
    sectionId: 's10',
    subSectionId: 'ss27',
    tags: ['security'],
    subTags: ['2fa', 'password'],
    summary:
      'Complete guide to enabling and managing 2FA on your account using authenticator apps or SMS.',
    author: 'Maria Chen',
    version: '1.4',
    createdAt: '2025-08-20',
    updatedAt: '2026-06-01',
    freshnessScore: 99,
    viewCount: 5643,
    helpfulRating: 97,
    embedStatus: 'indexed',
    chunkCount: 5,
  },
  {
    id: 'ki4',
    title: 'Agent Pipeline Design Best Practices',
    type: 'article',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm2',
    sectionId: 's4',
    subSectionId: 'ss10',
    tags: ['agents'],
    subTags: ['pipeline', 'configuration'],
    summary:
      'Internal guide covering optimal pipeline stage ordering, confidence threshold tuning, and validation bot selection for different use cases.',
    author: 'Alex Rivera',
    version: '1.2',
    createdAt: '2026-01-10',
    updatedAt: '2026-06-15',
    freshnessScore: 100,
    viewCount: 892,
    helpfulRating: 98,
    embedStatus: 'indexed',
    chunkCount: 14,
  },
  {
    id: 'ki5',
    title: 'Salesforce CRM Integration Setup',
    type: 'article',
    audience: 'Both',
    productId: 'p3',
    moduleId: 'm8',
    sectionId: 's16',
    subSectionId: 'ss44',
    tags: ['integrations'],
    subTags: ['crm', 'oauth'],
    summary:
      'Complete walkthrough for connecting Salesforce to DreamTeam including OAuth flow, field mapping, and sync configuration.',
    author: 'Jordan Blake',
    version: '2.3',
    createdAt: '2025-10-05',
    updatedAt: '2026-04-18',
    freshnessScore: 87,
    viewCount: 2107,
    helpfulRating: 89,
    embedStatus: 'indexed',
    chunkCount: 11,
  },
  {
    id: 'ki6',
    title: 'Release Notes v4.2 — Agent Enhancements',
    type: 'release_note',
    audience: 'Both',
    productId: 'p1',
    moduleId: 'm2',
    sectionId: 's4',
    subSectionId: 'ss9',
    tags: ['release-notes'],
    subTags: ['v4-2', 'improvements'],
    summary:
      'New multi-model routing, sub-agent orchestration improvements, and validation bot thresholds made configurable per action type.',
    author: 'Product Team',
    version: '4.2',
    createdAt: '2026-05-01',
    updatedAt: '2026-05-01',
    freshnessScore: 100,
    viewCount: 8941,
    helpfulRating: 96,
    embedStatus: 'indexed',
    chunkCount: 7,
  },
  {
    id: 'ki7',
    title: 'Resolved: Billing Agent double-charge on plan upgrade',
    type: 'resolved_ticket',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    subSectionId: 'ss22',
    tags: ['billing', 'troubleshooting'],
    subTags: ['subscription', 'known-issues'],
    summary:
      'Root cause analysis and resolution for billing agent incorrectly triggering two charges on same-day plan upgrades. Patched in v4.1.3.',
    author: 'Support Team',
    version: '4.1.3',
    createdAt: '2026-03-14',
    updatedAt: '2026-03-14',
    freshnessScore: 92,
    viewCount: 441,
    helpfulRating: 100,
    embedStatus: 'indexed',
    chunkCount: 4,
  },
  {
    id: 'ki8',
    title: 'RBAC Roles and Permissions Reference',
    type: 'policy',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm1',
    sectionId: 's1',
    subSectionId: 'ss3',
    tags: ['security'],
    subTags: ['rbac', 'permissions'],
    summary:
      'Complete reference for all 8 RBAC roles across DT Platform and Tenant tiers — what each role can access, configure, and execute.',
    author: 'Alex Rivera',
    version: '2.0',
    createdAt: '2025-07-01',
    updatedAt: '2026-06-01',
    freshnessScore: 96,
    viewCount: 1823,
    helpfulRating: 99,
    embedStatus: 'indexed',
    chunkCount: 9,
  },
  {
    id: 'ki9',
    title: 'How to Submit a Support Ticket',
    type: 'article',
    audience: 'Customer',
    productId: 'p2',
    moduleId: 'm6',
    sectionId: 's12',
    subSectionId: 'ss32',
    tags: ['troubleshooting'],
    subTags: ['faq'],
    summary:
      'Guide for customers on submitting, tracking, and escalating support tickets through the Customer Portal.',
    author: 'Sarah Kim',
    version: '1.0',
    createdAt: '2025-06-15',
    updatedAt: '2026-03-10',
    freshnessScore: 88,
    viewCount: 9102,
    helpfulRating: 93,
    embedStatus: 'indexed',
    chunkCount: 5,
  },
  {
    id: 'ki10',
    title: 'Knowledge Taxonomy Design Guide',
    type: 'article',
    audience: 'Internal',
    productId: 'p1',
    moduleId: 'm3',
    sectionId: 's6',
    subSectionId: 'ss15',
    tags: ['knowledge'],
    subTags: ['taxonomy', 'articles'],
    summary:
      'Internal guide for content authors on how to correctly classify articles using the Product-Module-Section-SubSection hierarchy and tagging system.',
    author: 'Jordan Blake',
    version: '1.1',
    createdAt: '2026-02-01',
    updatedAt: '2026-06-18',
    freshnessScore: 100,
    viewCount: 347,
    helpfulRating: 97,
    embedStatus: 'indexed',
    chunkCount: 8,
  },
  {
    id: 'ki11',
    title: 'Plan Upgrade Guide — Enterprise Features',
    type: 'article',
    audience: 'Customer',
    productId: 'p1',
    moduleId: 'm4',
    sectionId: 's8',
    subSectionId: 'ss22',
    tags: ['billing'],
    subTags: ['subscription', 'upgrade'],
    summary:
      'Everything included in the Enterprise plan upgrade: dedicated support, unlimited agents, custom SLA, and white-labelling.',
    author: 'James Patel',
    version: '2.0',
    createdAt: '2026-01-20',
    updatedAt: '2026-06-05',
    freshnessScore: 97,
    viewCount: 3421,
    helpfulRating: 95,
    embedStatus: 'indexed',
    chunkCount: 6,
  },
  {
    id: 'ki12',
    title: 'SSO Configuration with Okta',
    type: 'article',
    audience: 'Both',
    productId: 'p3',
    moduleId: 'm7',
    sectionId: 's14',
    subSectionId: 'ss39',
    tags: ['security', 'integrations'],
    subTags: ['sso', 'oauth'],
    summary:
      'Step-by-step for configuring single sign-on using Okta as the identity provider with SAML 2.0 or OIDC.',
    author: 'Maria Chen',
    version: '1.3',
    createdAt: '2025-12-01',
    updatedAt: '2026-05-10',
    freshnessScore: 94,
    viewCount: 1654,
    helpfulRating: 96,
    embedStatus: 'indexed',
    chunkCount: 10,
  },
];

type TenantPage =
  | 'hub_overview'
  | 'hub_articles'
  | 'hub_ingestion'
  | 'hub_training'
  | 'hub_analytics'
  | string;

const KnowledgeHubPage = ({
  user,
  tenant,
  subPage,
    dbArticles = [],
    setPage,
}: {
  user?: AuthUser;
  tenant?: Tenant;
  subPage: TenantPage;
  dbArticles?: DBKnowledgeArticle[];
  setPage: (p: Page) => void;
}) => {
  // Local live article state — refreshed after create/edit/status changes
  const [liveArticles, setLiveArticles] = useState<DBKnowledgeArticle[]>(dbArticles);
  const [articleMeta, setArticleMeta] = useState<Record<string, ArticleMeta>>({});
  const [tenantProfiles, setTenantProfiles] = useState<DBProfile[]>([]);

  const refreshArticles = async () => {
    if (tenant?.id) {
      const fresh = await fetchKnowledgeArticles(tenant.id);
      setLiveArticles(fresh);
      setArticleMeta(loadMeta(tenant.id));
    }
  };
  useEffect(() => {
    setLiveArticles(dbArticles);
    if (tenant?.id) setArticleMeta(loadMeta(tenant.id));
  }, [dbArticles, tenant?.id]);

  // Edit modal state
  const [editArticle, setEditArticle] = useState<DBKnowledgeArticle | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editAudience, setEditAudience] = useState<'customer' | 'internal' | 'both'>('both');
  const [editCategory, setEditCategory] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editStatus, setEditStatus] = useState<'draft' | 'published'>('draft');
  const [editSaving, setEditSaving] = useState(false);
  const [editToast, setEditToast] = useState('');
  // Edit modal extra fields
  const [editReviewDate, setEditReviewDate] = useState('');
  const [editReviewerId, setEditReviewerId] = useState('');
  const [showScheduleInput, setShowScheduleInput] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [showRevisionInput, setShowRevisionInput] = useState(false);
  const [revisionNote, setRevisionNote] = useState('');
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [editVersions, setEditVersions] = useState<ArticleVersion[]>([]);

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  const openEdit = (a: DBKnowledgeArticle | null) => {
    setEditArticle(a);
    setEditTitle(a?.title || '');
    setEditBody(a?.body || '');
    setEditSummary(a?.summary || '');
    setEditAudience((a?.audience as any) || 'both');
    setEditCategory(a?.category || '');
    setEditTags((a?.tags || []).join(', '));
    setEditStatus((a?.status === 'published' ? 'published' : 'draft') as any);
    setShowScheduleInput(false);
    setShowRevisionInput(false);
    setRevisionNote('');
    setScheduleDate('');
    setShowVersionHistory(false);
    if (a?.id) {
      const meta = tenant?.id ? loadMeta(tenant.id) : {};
      setEditReviewDate(meta[a.id]?.reviewDate || '');
      setEditReviewerId(meta[a.id]?.reviewerId || '');
      setEditVersions(loadVersions(a.id));
      // Load profiles
      if (tenant?.id && tenantProfiles.length === 0) {
        fetchTenantProfiles(tenant.id).then(setTenantProfiles);
      }
    } else {
      setEditReviewDate('');
      setEditReviewerId('');
      setEditVersions([]);
      if (tenant?.id && tenantProfiles.length === 0) {
        fetchTenantProfiles(tenant.id).then(setTenantProfiles);
      }
    }
  };

  const saveEdit = async (publishNow?: boolean) => {
    if (!editTitle.trim() || !editBody.trim() || !tenant?.id) return;
    setEditSaving(true);
    // Push version before saving
    const targetId = editArticle?.id;
    if (targetId) {
      pushVersion(targetId, { savedAt: new Date().toISOString(), title: editTitle, body: editBody });
    }
    const status = publishNow ? 'published' : editStatus;
    const tagsArr = editTags.split(',').map(t => t.trim()).filter(Boolean);
    const saved = await upsertKnowledgeArticle({
      ...(editArticle ? { id: editArticle.id } : {}),
      tenant_id: tenant.id,
      title: editTitle.trim(),
      body: editBody.trim(),
      summary: editSummary.trim() || editBody.trim().slice(0, 200),
      status,
      audience: editAudience,
      category: editCategory.trim() || 'General',
      tags: tagsArr,
      quality_score: editArticle?.quality_score ?? 0,
      freshness_score: 100,
      view_count: editArticle?.view_count ?? 0,
      helpful_count: editArticle?.helpful_count ?? 0,
      not_helpful_count: editArticle?.not_helpful_count ?? 0,
      created_by: user?.id ?? undefined,
    });
    if (saved) {
      // Update overlay meta for review date / reviewer
      if (editReviewDate || editReviewerId) {
        patchMeta(tenant.id, saved.id, {
          ...(editReviewDate ? { reviewDate: editReviewDate } : {}),
          ...(editReviewerId ? { reviewerId: editReviewerId } : {}),
        });
      }
      if (publishNow) {
        clearArticleMeta(tenant.id, saved.id);
        ingestArticle({ tenantId: tenant.id, content: editBody.trim(), title: editTitle.trim(), articleId: saved.id, sourceType: 'article' }).catch(() => {});
      }
      await refreshArticles();
      setEditToast(publishNow ? 'Published and indexed for AI' : 'Saved as draft');
      setTimeout(() => setEditToast(''), 3000);
      setEditArticle(undefined as any);
    }
    setEditSaving(false);
  };

  const submitForReview = () => {
    if (!editArticle?.id || !tenant?.id) return;
    patchMeta(tenant.id, editArticle.id, { status: 'in_review' });
    setArticleMeta(loadMeta(tenant.id));
    setEditToast('Submitted for review');
    setTimeout(() => setEditToast(''), 3000);
    setEditArticle(undefined as any);
  };

  const approveAndPublish = async (article: DBKnowledgeArticle) => {
    if (!tenant?.id) return;
    await updateArticleStatus(article.id, 'published');
    ingestArticle({ tenantId: tenant.id, content: article.body, title: article.title, articleId: article.id, sourceType: 'article' }).catch(() => {});
    clearArticleMeta(tenant.id, article.id);
    await refreshArticles();
    setEditToast('Published and indexed for AI');
    setTimeout(() => setEditToast(''), 3000);
    setEditArticle(undefined as any);
  };

  const sendRevisionRequest = (articleId: string, note: string) => {
    if (!tenant?.id) return;
    patchMeta(tenant.id, articleId, { status: 'needs_revision', reviewNote: note });
    setArticleMeta(loadMeta(tenant.id));
    setShowRevisionInput(false);
    setRevisionNote('');
    setEditToast('Revision requested');
    setTimeout(() => setEditToast(''), 3000);
    setEditArticle(undefined as any);
  };

  // Use real DB articles when available, fallback to mock
  const allKnowledgeItems = liveArticles.length > 0
    ? liveArticles.map(a => ({
        id: a.id, title: a.title, type: 'article' as const,
        audience: a.audience, tags: a.tags || [], subTags: [],
        summary: a.summary || '', author: '', version: '1.0',
        createdAt: a.created_at, updatedAt: a.updated_at,
        freshnessScore: a.freshness_score, viewCount: a.view_count,
        helpfulRating: a.helpful_count, embedStatus: a.status === 'published' ? 'indexed' as const : 'pending' as const,
        chunkCount: 0, status: a.status as any, category: a.category || '',
        productId: '', moduleId: '', sectionId: '', subSectionId: '',
        qualityScore: a.quality_score, body: a.body,
        rawArticle: a,
      }))
    : mockKnowledgeItems.map(a => ({ ...a, rawArticle: null }));

  const accentColor = tenant?.primaryColor || '#6366f1';
  const [searchQ, setSearchQ] = useState('');
  const [searchConfig, setSearchConfig] = useState<SearchConfig>(() => loadSearchConfig(tenant?.id || 'demo'));
  const [searchQualityOpen, setSearchQualityOpen] = useState(false);
  const [previewQuery, setPreviewQuery] = useState('');
  const [previewResults, setPreviewResults] = useState<{ article: DBKnowledgeArticle; kw: number; semantic: number; final: number; fresh: boolean }[]>([]);
  const [qualityTooltip, setQualityTooltip] = useState<string | null>(null);

  const updateSearchConfig = (patch: Partial<SearchConfig>) => {
    const next = { ...searchConfig, ...patch };
    setSearchConfig(next);
    saveSearchConfig(tenant?.id || 'demo', next);
  };

  const runPreview = () => {
    if (!previewQuery.trim() || liveArticles.length === 0) return;
    const scored = liveArticles.map(a => {
      const s = hybridScore(a, previewQuery, searchConfig.rerankingModel);
      const daysSince = (Date.now() - new Date((a as any).updated_at || (a as any).created_at).getTime()) / 86400000;
      return { article: a, ...s, fresh: daysSince < 30 };
    });
    scored.sort((a, b) => b.final - a.final);
    const aboveThreshold = scored.filter(r => {
      const maxPossible = 30;
      return (r.final / maxPossible) * 100 >= searchConfig.minConfidence;
    });
    setPreviewResults(aboveThreshold.slice(0, 5));
  };
  const [selectedArticle, setSelectedArticle] = useState<null | {
    id: string;
    title: string;
    category: string;
    tags: string[];
    status: string;
    views: number;
    helpful: number;
    audience: string;
    updated: string;
    content: string;
  }>(null);
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [createType, setCreateType] = React.useState<
  'write' | 'upload' | 'url' | 'template' | null
  >(null);
  const [newTitle, setNewTitle] = React.useState('');
  const [newBody, setNewBody] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<string>('all');
  const [filterAudience, setFilterAudience] = React.useState<string>('all');
  const [articleFilterStatus, setArticleFilterStatus] = React.useState<string>('all');
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(new Set());
  // --- RAG document ingestion ---
  const uploadInputRef = React.useRef(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [uploadResult, setUploadResult] = React.useState(null);
  const [uploadedArticles, setUploadedArticles] = React.useState([]);
  const [urlInput, setUrlInput] = React.useState('');
  const [urlTitle, setUrlTitle] = React.useState('');
  const [urlAudience, setUrlAudience] = React.useState<'both'|'internal'|'customer'>('both');
  const [isIngestingUrl, setIsIngestingUrl] = React.useState(false);
  const [ingestLog, setIngestLog] = React.useState<{msg: string; ok: boolean; ts: string}[]>([]);

  const addLog = (msg: string, ok = true) => {
    const ts = new Date().toLocaleTimeString();
    setIngestLog(prev => [{ msg, ok, ts }, ...prev].slice(0, 20));
  };

  const handleFileUpload = async (file) => {
    setIsUploading(true);
    let text = "";
    try {
      const isText = /\.(txt|md|csv|json)$/i.test(file.name);
      if (isText) { text = await file.text(); } else { text = ""; }
    } catch (e) { text = ""; }
    const cleaned = text.replace(/\s+/g, " ").trim();
    const words = cleaned ? cleaned.split(" ").filter(Boolean) : [];
    const CHUNK = 600;
    const chunkCount = cleaned.length > 0
      ? Math.max(1, Math.ceil(cleaned.length / CHUNK))
      : Math.max(1, Math.round(file.size / 1800));
    const preview = cleaned ? cleaned.slice(0, 220) : "";
    const title = file.name.replace(/\.[^.]+$/, "");
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'file';

    const localDoc = {
      id: 'up_' + Date.now(),
      title,
      category: 'Uploaded',
      tags: ['upload', ext],
      status: 'published',
      views: 0, helpful: 0,
      audience: 'both',
      updated: 'just now',
      content: cleaned || (file.name + " (binary document registered for embedding)"),
    };

    // Persist to Supabase if tenant is available
    if (tenant?.id) {
      const saved = await upsertKnowledgeArticle({
        tenant_id: tenant.id,
        title,
        body: cleaned || file.name,
        summary: preview || title,
        status: 'published',
        audience: 'both',
        category: 'Uploaded',
        tags: ['upload', ext],
        quality_score: 0,
        freshness_score: 100,
        view_count: 0,
        helpful_count: 0,
        not_helpful_count: 0,
        created_by: user?.id ?? null,
      });
      if (saved) {
        addLog(`File uploaded: ${file.name} — generating embeddings…`);
        const ingestResult = await ingestArticle({
          tenantId: tenant.id,
          content: cleaned || file.name,
          title,
          articleId: saved.id,
          sourceType: 'file',
        });
        if (ingestResult.success) {
          addLog(`Embeddings ready: ${ingestResult.chunks_created} chunks (${ingestResult.mode})`);
        } else {
          addLog(`Saved without embeddings — add OPENAI_API_KEY to Supabase secrets to enable semantic search`, false);
        }
      } else {
        addLog(`File saved locally: ${file.name} (Supabase not connected)`, false);
      }
    } else {
      addLog(`File saved locally: ${file.name} (connect Supabase to persist)`, false);
    }

    setUploadedArticles((prev) => [localDoc, ...prev]);
    setUploadResult({
      fileName: file.name,
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
      wordCount: words.length,
      chunkCount,
      preview,
    });
    setIsUploading(false);
  };

  const handleUrlIngest = async () => {
    if (!urlInput.trim()) return;
    setIsIngestingUrl(true);
    const title = urlTitle.trim() || new URL(urlInput.trim()).hostname;
    let body = '';
    // Try Edge Function first (server-side, no CORS restrictions)
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      if (supabaseUrl && supabaseKey) {
        const efRes = await fetch(`${supabaseUrl}/functions/v1/ingest-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseKey}` },
          body: JSON.stringify({ url: urlInput.trim() }),
        });
        if (efRes.ok) {
          const ef = await efRes.json();
          if (!ef.error) {
            body = ef.body ?? '';
            if (!urlTitle.trim() && ef.title) setUrlTitle(ef.title);
          }
        }
      }
    } catch { /* fall through */ }
    if (!body) {
      try {
        // Direct fetch — works for CORS-permissive URLs
        const res = await fetch(urlInput.trim());
        const html = await res.text();
        body = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
      } catch {
        // Both failed — create a reference stub
        body = `Source URL: ${urlInput.trim()}\n\nContent extraction requires the ingest-url Edge Function (supabase/functions/ingest-url/index.ts). Deploy it in Supabase Dashboard → Edge Functions to enable full server-side ingestion.`;
      }
    }
    const summary = body.slice(0, 200);
    const localDoc = {
      id: 'url_' + Date.now(),
      title,
      category: 'URL Source',
      tags: ['url', 'web'],
      status: 'published',
      views: 0, helpful: 0,
      audience: urlAudience,
      updated: 'just now',
      content: body,
    };
    if (tenant?.id) {
      const saved = await upsertKnowledgeArticle({
        tenant_id: tenant.id,
        title,
        body,
        summary,
        status: 'published',
        audience: urlAudience,
        category: 'URL Source',
        tags: ['url', 'web'],
        quality_score: 0,
        freshness_score: 100,
        view_count: 0,
        helpful_count: 0,
        not_helpful_count: 0,
        created_by: user?.id ?? null,
      });
      if (saved) {
        addLog(`URL ingested: ${title} — generating embeddings…`);
        const ingestResult = await ingestArticle({
          tenantId: tenant.id,
          content: body,
          title,
          articleId: saved.id,
          sourceType: 'url',
          sourceUrl: urlInput.trim(),
        });
        if (ingestResult.success) {
          addLog(`Embeddings ready: ${ingestResult.chunks_created} chunks (${ingestResult.mode})`);
        } else {
          addLog(`Saved without embeddings — add OPENAI_API_KEY to Supabase secrets to enable semantic search`, false);
        }
      } else {
        addLog(`URL stub saved locally: ${title} (Supabase not connected)`, false);
      }
    } else {
      addLog(`URL stub saved locally: ${title}`, false);
    }
    setUploadedArticles(prev => [localDoc, ...prev]);
    setUrlInput('');
    setUrlTitle('');
    setIsIngestingUrl(false);
  };

  const articles = [...uploadedArticles,
    {
      id: 'k1',
      title: 'Getting Started Guide',
      category: 'Onboarding',
      tags: ['setup', 'beginner'],
      status: 'published',
      views: 1842,
      helpful: 94,
      audience: 'both',
      updated: '2 days ago',
      content:
        'Welcome to our platform. This guide walks you through initial setup, configuration, and your first steps.',
    },
    {
      id: 'k2',
      title: 'Password Reset and Account Recovery',
      category: 'Security',
      tags: ['password', 'account'],
      status: 'published',
      views: 3201,
      helpful: 98,
      audience: 'customer',
      updated: '1 week ago',
      content:
        'Step-by-step instructions for resetting your password and recovering your account through email or SMS verification.',
    },
    {
      id: 'k3',
      title: 'Benefits Enrollment Process',
      category: 'HR',
      tags: ['benefits', 'enrollment'],
      status: 'published',
      views: 567,
      helpful: 92,
      audience: 'internal',
      updated: '3 days ago',
      content:
        'Annual benefits enrollment opens November 1. This guide covers all available plans, how to enroll, and key deadlines.',
    },
    {
      id: 'k4',
      title: 'API Integration Reference',
      category: 'Technical',
      tags: ['api', 'developers'],
      status: 'published',
      views: 2109,
      helpful: 89,
      audience: 'customer',
      updated: '5 days ago',
      content:
        'Complete API documentation including authentication, endpoints, rate limits, and code examples.',
    },
    {
      id: 'k5',
      title: 'Data Retention and Privacy Policy',
      category: 'Compliance',
      tags: ['privacy', 'gdpr'],
      status: 'published',
      views: 445,
      helpful: 86,
      audience: 'both',
      updated: '2 weeks ago',
      content:
        'Our data retention policy describes how long we keep data and how customers can request deletion.',
    },
    {
      id: 'k6',
      title: 'Expense Report Submission Guide',
      category: 'Finance',
      tags: ['expenses', 'finance'],
      status: 'draft',
      views: 0,
      helpful: 0,
      audience: 'internal',
      updated: 'Draft',
      content:
        'How to submit expense reports using our finance system, including approval thresholds and reimbursement timelines.',
    },
    {
      id: 'k7',
      title: 'Billing and Invoice FAQ',
      category: 'Billing',
      tags: ['billing', 'invoice'],
      status: 'published',
      views: 1654,
      helpful: 91,
      audience: 'customer',
      updated: '4 days ago',
      content:
        'Answers to common billing questions: payment methods, invoice generation, plan upgrades, and credit notes.',
    },
    {
      id: 'k8',
      title: 'Remote Work Policy',
      category: 'HR',
      tags: ['remote', 'policy'],
      status: 'published',
      views: 892,
      helpful: 88,
      audience: 'internal',
      updated: '1 month ago',
      content:
        'Company policy on remote and hybrid work arrangements, equipment allowances, and communication expectations.',
    },
    {
      id: 'k9',
      title: 'Product Release Notes v4.2',
      category: 'Releases',
      tags: ['release', 'changelog'],
      status: 'published',
      views: 2341,
      helpful: 95,
      audience: 'both',
      updated: '1 day ago',
      content:
        'Version 4.2 release notes including new features, improvements, bug fixes, and migration notes.',
    },
    {
      id: 'k10',
      title: 'SLA and Support Tiers',
      category: 'Support',
      tags: ['sla', 'support'],
      status: 'published',
      views: 1102,
      helpful: 93,
      audience: 'customer',
      updated: '1 week ago',
      content:
        'Details on our support tier system, response time guarantees, and how to escalate to higher support levels.',
    },
  ];

  const ingestionSources = [
    {
      name: 'Confluence Wiki',
      status: 'syncing',
      docs: 1248,
      lastSync: '10 min ago',
      icon: 'C',
    },
    {
      name: 'Zendesk Tickets',
      status: 'active',
      docs: 8421,
      lastSync: '1 hr ago',
      icon: 'Z',
    },
    {
      name: 'Google Drive',
      status: 'active',
      docs: 342,
      lastSync: '30 min ago',
      icon: 'G',
    },
    {
      name: 'Notion Workspace',
      status: 'active',
      docs: 567,
      lastSync: '2 hr ago',
      icon: 'N',
    },
    {
      name: 'GitHub READMEs',
      status: 'active',
      docs: 89,
      lastSync: '1 day ago',
      icon: 'H',
    },
    {
      name: 'PDF Uploads',
      status: 'active',
      docs: 124,
      lastSync: 'Continuous',
      icon: 'P',
    },
  ];

  const trainingModules = [
    {
      title: 'Product Overview and Features',
      completions: 87,
      duration: '45 min',
      category: 'Onboarding',
    },
    {
      title: 'Security Best Practices',
      completions: 92,
      duration: '30 min',
      category: 'Security',
    },
    {
      title: 'Customer Communication Standards',
      completions: 78,
      duration: '60 min',
      category: 'Service',
    },
    {
      title: 'Billing and Pricing Deep Dive',
      completions: 64,
      duration: '40 min',
      category: 'Finance',
    },
    {
      title: 'Compliance and Data Privacy',
      completions: 95,
      duration: '50 min',
      category: 'Compliance',
    },
    {
      title: 'Using the AI Assistant Effectively',
      completions: 71,
      duration: '25 min',
      category: 'AI Tools',
    },
  ];

  const filteredArticles = articles.filter(
    (a) =>
      a.title.toLowerCase().includes(searchQ.toLowerCase()) ||
      a.category.toLowerCase().includes(searchQ.toLowerCase())
  );

  if (subPage === 'hub_overview') {
    const inReviewCount = liveArticles.filter(a => {
      const s = getArticleStatus(a, articleMeta);
      return s === 'in_review' || s === 'needs_revision';
    }).length;
    return (<>
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={HUB_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Knowledge Hub</h1>
          <p className="text-slate-400 text-sm mt-1">
            AI-powered knowledge for customers and internal staff — one source
            of truth, served intelligently
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Articles"
            value="2,847"
            icon="◈"
            color="indigo"
            trend="+127 this month"
          />
          <StatCard
            label="Sources Syncing"
            value="6"
            icon="⇄"
            color="emerald"
            trend="All healthy"
          />
          <StatCard
            label="Queries Answered"
            value="12,481"
            icon="◆"
            color="blue"
            trend="+18% this week"
          />
          <StatCard
            label="Coverage Score"
            value="94%"
            icon="◎"
            color="amber"
            trend="+2% vs last month"
          />
        </div>
        {inReviewCount > 0 && (
          <div className="mb-6">
            <StatCard label="Awaiting Review" value={String(inReviewCount)} icon="◈" color="amber" />
          </div>
        )}
        {/* Knowledge Gaps section */}
        <div className="bg-slate-900 border border-amber-800/40 rounded-xl overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-amber-950/10">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-sm">&#9888;</span>
              <span className="text-xs font-semibold text-slate-400 tracking-widest">KNOWLEDGE GAPS</span>
              <span className="text-slate-600 mx-1">&#183;</span>
              <span className="text-xs text-slate-500">TOPICS WITH UNANSWERED QUERIES</span>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-900/30 text-amber-300 border border-amber-800/50">AI-DETECTED</span>
          </div>
          <div className="divide-y divide-slate-800/50">
            {SAMPLE_GAPS.map((gap, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-800/20 transition-colors">
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-slate-200">{gap.topic}</span>
                </div>
                <span className={`text-xs font-semibold ${gap.covered ? 'text-slate-500' : 'text-amber-400'}`}>
                  {gap.queryCount} {gap.covered ? 'queries' : 'unanswered queries'}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${gap.covered ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                  {gap.covered ? 'Covered' : 'Not covered'}
                </span>
                {!gap.covered && (
                  <button
                    onClick={() => { openEdit(null); setEditTitle(gap.topic); }}
                    className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 transition-colors whitespace-nowrap"
                  >
                    Create Article →
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Audience Coverage
            </h2>
            <div className="space-y-3">
              {[
                {
                  label: 'Customer-Facing Articles',
                  count: 1420,
                  pct: 50,
                  color: '#3b82f6',
                },
                {
                  label: 'Internal Staff Articles',
                  count: 892,
                  pct: 31,
                  color: '#8b5cf6',
                },
                {
                  label: 'Shared Both Audiences',
                  count: 535,
                  pct: 19,
                  color: '#10b981',
                },
              ].map((item, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>{item.label}</span>
                    <span className="text-white">
                      {item.count.toLocaleString()} ({item.pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: item.pct + '%',
                        backgroundColor: item.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Top Categories
            </h2>
            <div className="space-y-2">
              {[
                { name: 'Product and Features', count: 612 },
                { name: 'Billing and Payments', count: 489 },
                { name: 'Security and Compliance', count: 341 },
                { name: 'HR and People Ops', count: 298 },
                { name: 'Technical and API', count: 267 },
                { name: 'Onboarding', count: 224 },
              ].map((c, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50"
                >
                  <span className="flex-1 text-sm text-white">{c.name}</span>
                  <span className="text-xs text-slate-400">
                    {c.count} articles
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {editArticle !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 flex-shrink-0">
              <h2 className="text-base font-semibold text-white">New Article</h2>
              <button onClick={() => setEditArticle(undefined as any)} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
            </div>
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">TITLE</label>
                <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="Article title…"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">CONTENT</label>
                <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={8}
                  placeholder="Write article content here…"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none font-mono" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex-shrink-0 flex gap-2">
              <button onClick={() => saveEdit(false)} disabled={editSaving || !editTitle.trim() || !editBody.trim()}
                className="px-4 py-2 rounded-xl text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40">Save Draft</button>
              <button onClick={() => saveEdit(true)} disabled={editSaving || !editTitle.trim() || !editBody.trim()}
                className="px-4 py-2 rounded-xl text-sm text-white disabled:opacity-40" style={{ backgroundColor: accentColor }}>Publish</button>
              <button onClick={() => setEditArticle(undefined as any)} className="ml-auto text-sm text-slate-400 hover:text-white">Cancel</button>
            </div>
          </div>
        </div>
      )}
      {editToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl">{editToast}</div>
      )}
    </>);
  }

  if (subPage === 'hub_articles') {
    const kbItems = allKnowledgeItems.filter((a) =>
      searchQ ? a.title.toLowerCase().includes(searchQ.toLowerCase()) : true
    );
    // Status counts using overlay for DB articles
    const statusCounts = {
      all: kbItems.length,
      published: kbItems.filter(a => (a as any).rawArticle ? getArticleStatus((a as any).rawArticle, articleMeta) === 'published' : a.embedStatus === 'indexed').length,
      in_review: kbItems.filter(a => (a as any).rawArticle ? getArticleStatus((a as any).rawArticle, articleMeta) === 'in_review' : false).length,
      draft: kbItems.filter(a => (a as any).rawArticle ? getArticleStatus((a as any).rawArticle, articleMeta) === 'draft' : a.embedStatus === 'pending').length,
      needs_revision: kbItems.filter(a => (a as any).rawArticle ? getArticleStatus((a as any).rawArticle, articleMeta) === 'needs_revision' : false).length,
      archived: kbItems.filter(a => (a as any).rawArticle ? getArticleStatus((a as any).rawArticle, articleMeta) === 'archived' : false).length,
    };
    const published = statusCounts.published;
    const drafts = statusCounts.draft;
    const stale = kbItems.filter((a) => a.embedStatus === 'stale').length;
    const avgFresh = Math.round(
      kbItems.reduce((s, a) => s + a.freshnessScore, 0) / (kbItems.length || 1)
    );
    const avgQuality = Math.round(
      kbItems.reduce(
        (s, a) =>
          s +
          Math.min(
            100,
            Math.round(a.freshnessScore * 0.6 + (a.chunkCount / 30) * 40)
          ),
        0
      ) / (kbItems.length || 1)
    );
    const coverageGaps = [
      { topic: 'API Rate Limits & Throttling', activeCases: 47, articles: 0 },
      { topic: 'Multi-Factor Authentication Setup', activeCases: 34, articles: 0 },
      { topic: 'Bulk Data Export Guide', activeCases: 28, articles: 1 },
      { topic: 'Webhook Configuration', activeCases: 19, articles: 0 },
    ];

    const filteredKbItems = kbItems.filter(a => {
      if (articleFilterStatus === 'all') return true;
      const rawA = (a as any).rawArticle as DBKnowledgeArticle | null;
      const effStatus = rawA ? getArticleStatus(rawA, articleMeta) : (a.embedStatus === 'indexed' ? 'published' : 'draft');
      return effStatus === articleFilterStatus;
    }).filter(a => filterAudience === 'all' || a.audience === filterAudience);

    const bulkAction = async (action: 'review' | 'publish' | 'archive') => {
      if (!tenant?.id) return;
      for (const id of Array.from(checkedIds)) {
        const raw = liveArticles.find(a => a.id === id);
        if (!raw) continue;
        if (action === 'review') {
          patchMeta(tenant.id, id, { status: 'in_review' });
        } else if (action === 'publish') {
          await updateArticleStatus(id, 'published');
          clearArticleMeta(tenant.id, id);
          ingestArticle({ tenantId: tenant.id, content: raw.body, title: raw.title, articleId: id, sourceType: 'article' }).catch(() => {});
        } else if (action === 'archive') {
          patchMeta(tenant.id, id, { status: 'archived' });
        }
      }
      setCheckedIds(new Set());
      await refreshArticles();
    };

    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={HUB_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Knowledge Base</h1>
            <p className="text-slate-400 text-sm mt-1">
              Articles, docs, and release notes tagged and indexed for AI retrieval
            </p>
          </div>
          <button
            onClick={() => openEdit(null)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold shadow-lg hover:opacity-90 transition-opacity"
            style={{ backgroundColor: accentColor }}
          >
            + New Article
          </button>
        </div>
        <div className="grid grid-cols-6 gap-3 mb-6">
          {[
            { label: 'ARTICLES', value: kbItems.length, color: 'text-white' },
            { label: 'PUBLISHED', value: published, color: 'text-emerald-400' },
            { label: 'DRAFTS', value: drafts, color: 'text-yellow-400' },
            { label: 'STALE', value: stale, color: 'text-orange-400' },
            { label: 'AVG QUALITY', value: avgQuality + '%', color: 'text-violet-300' },
            { label: 'AVG FRESHNESS', value: avgFresh + '%', color: 'text-blue-300' },
          ].map((stat) => (
            <div key={stat.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <p className="text-slate-500 text-xs font-semibold tracking-widest mb-1">{stat.label}</p>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Status filter chips */}
        <div className="flex flex-wrap gap-2 mb-4">
          {([
            { key: 'all', label: 'All' },
            { key: 'published', label: 'Published' },
            { key: 'in_review', label: 'In Review' },
            { key: 'draft', label: 'Drafts' },
            { key: 'needs_revision', label: 'Needs Revision' },
            { key: 'archived', label: 'Archived' },
          ] as const).map(chip => (
            <button
              key={chip.key}
              onClick={() => setArticleFilterStatus(chip.key)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${articleFilterStatus === chip.key ? 'text-white border-transparent' : 'text-slate-400 border-slate-700 hover:border-slate-500'}`}
              style={articleFilterStatus === chip.key ? { backgroundColor: accentColor, borderColor: accentColor } : {}}
            >
              {chip.label} ({statusCounts[chip.key] ?? kbItems.length})
            </button>
          ))}
        </div>

        {/* Search Quality Panel */}
        <div className="mb-4">
          <button
            onClick={() => setSearchQualityOpen(v => !v)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-400 bg-slate-800 border border-slate-700 hover:border-slate-600 hover:text-white transition-all"
          >
            <span>&#9881;</span>
            <span>Search Quality</span>
            <span className="text-slate-600">{searchQualityOpen ? '▲' : '▼'}</span>
          </button>
          {searchQualityOpen && (
            <div className="mt-2 bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-5">
              {/* Retrieval Settings */}
              <div>
                <h3 className="text-xs font-semibold text-slate-300 tracking-wider mb-3">RETRIEVAL SETTINGS</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Reranking model</label>
                    <select
                      value={searchConfig.rerankingModel}
                      onChange={e => updateSearchConfig({ rerankingModel: e.target.value as any })}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="keyword">None (keyword only)</option>
                      <option value="semantic">Semantic (simulated)</option>
                      <option value="hybrid">Hybrid (keyword + semantic, recommended)</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Top-K retrieved</label>
                      <input type="number" min={3} max={20} value={searchConfig.topK}
                        onChange={e => updateSearchConfig({ topK: Math.min(20, Math.max(3, parseInt(e.target.value) || 10)) })}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
                      <p className="text-[10px] text-slate-600 mt-0.5">More = better recall but slower</p>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Final results to DE</label>
                      <input type="number" min={1} max={10} value={searchConfig.finalK}
                        onChange={e => updateSearchConfig({ finalK: Math.min(10, Math.max(1, parseInt(e.target.value) || 3)) })}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Minimum confidence threshold: <span className="text-white">{searchConfig.minConfidence}%</span></label>
                    <input type="range" min={0} max={100} value={searchConfig.minConfidence}
                      onChange={e => updateSearchConfig({ minConfidence: parseInt(e.target.value) })}
                      className="w-full accent-indigo-500" />
                    <p className="text-[10px] text-slate-600 mt-0.5">Articles scoring below this are excluded from results</p>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-2">Audience filter</label>
                    <div className="flex gap-3">
                      {(['customer', 'internal', 'both'] as const).map(a => (
                        <label key={a} className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox"
                            checked={searchConfig.audienceFilter[a]}
                            onChange={e => updateSearchConfig({ audienceFilter: { ...searchConfig.audienceFilter, [a]: e.target.checked } })}
                            className="accent-indigo-500" />
                          <span className="text-xs text-slate-300 capitalize">{a}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Reranking Preview */}
              <div className="border-t border-slate-800 pt-4">
                <h3 className="text-xs font-semibold text-slate-300 tracking-wider mb-3">RERANKING PREVIEW</h3>
                <div className="flex gap-2 mb-3">
                  <input
                    value={previewQuery}
                    onChange={e => setPreviewQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && runPreview()}
                    placeholder="Type a test query…"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={runPreview}
                    disabled={!previewQuery.trim() || liveArticles.length === 0}
                    className="px-4 py-2 rounded-lg text-xs font-medium text-white disabled:opacity-40 transition-all"
                    style={{ backgroundColor: accentColor }}
                  >
                    Preview results
                  </button>
                </div>
                {liveArticles.length === 0 && (
                  <p className="text-xs text-slate-600">Load real KB articles to preview reranking (mock items not supported).</p>
                )}
                {previewResults.length > 0 && (
                  <div className="space-y-2">
                    {(() => {
                      const maxScore = Math.max(...previewResults.map(r => r.final), 0.01);
                      return previewResults.map((r, idx) => (
                        <div key={r.article.id} className="bg-slate-800 border border-slate-700 rounded-xl p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                              style={{ backgroundColor: accentColor }}>#{idx + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-white truncate">{r.article.title}</div>
                              <div className="text-xs text-slate-500">{r.article.category || 'General'}</div>
                            </div>
                            {r.fresh && <span className="text-[10px] text-emerald-400 flex items-center gap-1">&#127807; Recently updated</span>}
                          </div>
                          <div className="flex items-center gap-2 mb-1.5">
                            <div className="flex gap-1.5">
                              <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded">KW: {r.kw.toFixed(1)}</span>
                              <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 text-slate-300 rounded">Semantic: {r.semantic.toFixed(2)}</span>
                              <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/20 text-indigo-300 rounded">Final: {r.final.toFixed(1)}</span>
                            </div>
                          </div>
                          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${(r.final / maxScore) * 100}%`, backgroundColor: accentColor }} />
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 mb-4">
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search articles, tags, KB IDs..."
            className="flex-1 max-w-sm bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
          />
          <select
            value={filterAudience}
            onChange={(e) => setFilterAudience(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-violet-500"
          >
            <option value="all">All Audiences</option>
            <option value="Customer">Customer</option>
            <option value="Internal">Internal</option>
            <option value="Both">Both</option>
          </select>
          <span className="text-slate-500 text-sm ml-auto">{filteredKbItems.length} articles</span>
        </div>

        {/* Bulk action bar */}
        {checkedIds.size > 0 && (
          <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl">
            <span className="text-sm text-white font-medium">{checkedIds.size} selected</span>
            <button onClick={() => bulkAction('review')} className="px-3 py-1 rounded-lg text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-all">Submit for Review</button>
            <button onClick={() => bulkAction('publish')} className="px-3 py-1 rounded-lg text-xs bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-all">Publish Selected</button>
            <button onClick={() => bulkAction('archive')} className="px-3 py-1 rounded-lg text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 transition-all">Archive Selected</button>
            <button onClick={() => setCheckedIds(new Set())} className="ml-auto text-slate-500 hover:text-white text-xs">Clear</button>
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950">
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" className="accent-indigo-500"
                    checked={checkedIds.size === filteredKbItems.filter(a => (a as any).rawArticle).length && checkedIds.size > 0}
                    onChange={e => {
                      if (e.target.checked) setCheckedIds(new Set(filteredKbItems.filter(a => (a as any).rawArticle).map(a => a.id)));
                      else setCheckedIds(new Set());
                    }}
                  />
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-24">KB ID</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3">ARTICLE</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-28">STATUS</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-24">QUALITY</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-36">TAGS</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-28">REVIEW DUE</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-20">CITED</th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-24">AUDIENCE</th>
                <th className="text-right text-xs font-semibold text-slate-500 tracking-wider px-4 py-3 w-28">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filteredKbItems.map((article, idx) => {
                const rawA = (article as any).rawArticle as DBKnowledgeArticle | null;
                const effStatus = rawA ? getArticleStatus(rawA, articleMeta) : (article.embedStatus === 'indexed' ? 'published' : 'draft');
                const badgeClass = STATUS_BADGE_CLASS[effStatus] || STATUS_BADGE_CLASS.draft;
                const badgeLabel = STATUS_LABEL[effStatus] || effStatus;

                // Citation count seeded from id
                const citationCount = rawA
                  ? rawA.id.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0) % 150
                  : 0;

                // Review date
                const reviewDate = rawA ? articleMeta[rawA.id]?.reviewDate : undefined;
                let reviewDateEl: React.ReactNode = <span className="text-slate-600">—</span>;
                if (reviewDate) {
                  const rd = new Date(reviewDate);
                  const now = new Date();
                  const diffDays = (rd.getTime() - now.getTime()) / 86400000;
                  if (diffDays < 0) reviewDateEl = <span className="text-red-400 text-xs">⚠ Overdue</span>;
                  else if (diffDays <= 14) reviewDateEl = <span className="text-amber-400 text-xs">Due soon</span>;
                  else reviewDateEl = <span className="text-slate-400 text-xs">{rd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>;
                }

                const kbId = 'KB-' + String(1000 + idx * 37 + article.chunkCount).padStart(4, '0').substring(0, 4);
                const isChecked = checkedIds.has(article.id);

                return (
                  <tr
                    key={article.id}
                    className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors group"
                  >
                    <td className="px-4 py-3">
                      {rawA && (
                        <input type="checkbox" className="accent-indigo-500" checked={isChecked}
                          onChange={e => {
                            const next = new Set(checkedIds);
                            if (e.target.checked) next.add(article.id); else next.delete(article.id);
                            setCheckedIds(next);
                          }}
                        />
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-500 text-xs">
                      {kbId} <span className="text-slate-700">v1</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-white text-sm leading-snug">{article.title}</div>
                      <div className="text-slate-500 text-xs mt-0.5 truncate max-w-xs">{article.summary}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass}`}>{badgeLabel}</span>
                    </td>
                    <td className="px-4 py-3 relative">
                      {rawA ? (() => {
                        const qs = articleQualityScore(rawA);
                        const ql = qualityLabel(qs);
                        const hints = qualityMissingHints(rawA);
                        const tooltipId = `qt_${rawA.id}`;
                        return (
                          <div className="relative inline-block">
                            <button
                              onMouseEnter={() => setQualityTooltip(tooltipId)}
                              onMouseLeave={() => setQualityTooltip(null)}
                              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${ql.bg} ${ql.color} cursor-default`}
                            >
                              <span>{qs}</span>
                              <span className="text-[9px] opacity-70">{ql.label}</span>
                            </button>
                            {qualityTooltip === tooltipId && hints.length > 0 && (
                              <div className="absolute left-0 top-full mt-1 z-20 bg-slate-800 border border-slate-700 rounded-xl p-3 shadow-xl w-52">
                                <p className="text-[10px] font-semibold text-slate-400 mb-1.5 tracking-wider">TO IMPROVE</p>
                                {hints.map((h, i) => (
                                  <p key={i} className="text-[10px] text-slate-300 mb-0.5">• {h}</p>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })() : <span className="text-slate-600 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {article.tags.slice(0, 2).map((t) => (
                          <span key={t} className="px-2 py-0.5 rounded-full text-xs bg-slate-800 text-slate-300 border border-slate-700">{t}</span>
                        ))}
                        {article.tags.length > 2 && <span className="px-2 py-0.5 rounded-full text-xs text-slate-500">+{article.tags.length - 2}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">{reviewDateEl}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{effStatus === 'published' ? `${citationCount}×` : '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${article.audience === 'Customer' ? 'bg-blue-900/40 text-blue-300 border border-blue-800' : article.audience === 'Internal' ? 'bg-purple-900/40 text-purple-300 border border-purple-800' : 'bg-teal-900/40 text-teal-300 border border-teal-800'}`}>
                        {article.audience}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => rawA && openEdit(rawA)}
                          className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                        >
                          Edit
                        </button>
                        {effStatus !== 'published' && rawA && (
                          <button
                            onClick={async () => {
                              await updateArticleStatus(rawA.id, 'published');
                              if (tenant?.id) clearArticleMeta(tenant.id, rawA.id);
                              ingestArticle({ tenantId: tenant!.id, content: rawA.body, title: article.title, articleId: rawA.id, sourceType: 'article' }).catch(() => {});
                              await refreshArticles();
                            }}
                            className="px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-900/30 rounded transition-colors"
                          >
                            Publish
                          </button>
                        )}
                        {effStatus === 'published' && (
                          <span className="px-2 py-1 text-xs text-emerald-600">Live</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="bg-slate-900 border border-amber-800/40 rounded-xl overflow-hidden mb-6">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-amber-950/10">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-sm">&#9888;</span>
              <span className="text-xs font-semibold text-slate-400 tracking-widest">
                COVERAGE GAPS
              </span>
              <span className="text-slate-600 mx-1">&#183;</span>
              <span className="text-xs text-slate-500">
                TOPICS WITH ZERO KB ARTICLES
              </span>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-900/30 text-amber-300 border border-amber-800/50">
              AI-DETECTED
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-2">
                  TOPIC
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-2 w-36">
                  ACTIVE CASES
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 tracking-wider px-4 py-2 w-24">
                  ARTICLES
                </th>
                <th className="px-4 py-2 w-36"></th>
              </tr>
            </thead>
            <tbody>
              {coverageGaps.map((gap, i) => (
                <tr
                  key={i}
                  className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors"
                >
                  <td className="px-4 py-3 text-slate-300 text-sm">
                    {gap.topic}
                  </td>
                  <td className="px-4 py-3 text-amber-400 font-semibold text-sm">
                    {gap.activeCases}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-sm">
                    {gap.articles}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => {
                        setShowCreateModal(true);
                        setNewTitle(gap.topic);
                        setCreateType('write');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 transition-colors ml-auto"
                    >
                      + Create Draft
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Toast */}
        {editToast && (
          <div className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl">
            {editToast}
          </div>
        )}

        {/* Create / Edit article modal */}
        {editArticle !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 flex-shrink-0">
                <h2 className="text-base font-semibold text-white">
                  {editArticle ? 'Edit Article' : 'New Article'}
                </h2>
                <button onClick={() => setEditArticle(undefined as any)} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
              </div>

              <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">TITLE</label>
                  <input
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    placeholder="Article title…"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">CONTENT</label>
                  <textarea
                    value={editBody}
                    onChange={e => setEditBody(e.target.value)}
                    placeholder="Write the full article content here. This is what your Digital Employees will use to answer customer questions."
                    rows={10}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none font-mono leading-relaxed"
                  />
                  <p className="text-xs text-slate-600 mt-1">{editBody.length} chars · ~{Math.ceil(editBody.split(/\s+/).filter(Boolean).length / 600)} chunk(s) when published</p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">SUMMARY <span className="font-normal text-slate-600">(optional — shown in search results)</span></label>
                  <input
                    value={editSummary}
                    onChange={e => setEditSummary(e.target.value)}
                    placeholder="One-sentence description of this article…"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">AUDIENCE</label>
                    <select
                      value={editAudience}
                      onChange={e => setEditAudience(e.target.value as any)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500"
                    >
                      <option value="customer">Customer</option>
                      <option value="internal">Internal</option>
                      <option value="both">Both</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">CATEGORY</label>
                    <input
                      value={editCategory}
                      onChange={e => setEditCategory(e.target.value)}
                      placeholder="e.g. Billing, HR, IT…"
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">TAGS</label>
                    <input
                      value={editTags}
                      onChange={e => setEditTags(e.target.value)}
                      placeholder="refund, billing, faq"
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                </div>

                {/* Review date + Assign reviewer */}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">REVIEW BY DATE</label>
                    <input
                      type="date"
                      value={editReviewDate}
                      onChange={e => setEditReviewDate(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                    />
                  </div>
                  {tenant?.id && (
                    <div>
                      <label className="text-xs font-semibold text-slate-400 block mb-1.5 tracking-wider">ASSIGN REVIEWER</label>
                      <select
                        value={editReviewerId}
                        onChange={e => setEditReviewerId(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                      >
                        <option value="">— None —</option>
                        {tenantProfiles.map(p => (
                          <option key={p.id} value={p.id}>{p.full_name || p.id}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Version History */}
                <div className="border-t border-slate-800 pt-2">
                  <button
                    onClick={() => setShowVersionHistory(v => !v)}
                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
                  >
                    {showVersionHistory ? '▾' : '▸'} Version History ({editVersions.length})
                  </button>
                  {showVersionHistory && (
                    <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                      {editVersions.length === 0 && <p className="text-xs text-slate-600">No saved versions yet.</p>}
                      {editVersions.map((v, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-slate-400 bg-slate-800/50 rounded-lg px-3 py-1.5">
                          <span className="flex-1">Saved {new Date(v.savedAt).toLocaleString()} · {v.body.length} chars</span>
                          <button
                            onClick={() => { setEditBody(v.body); setEditTitle(v.title); }}
                            className="text-indigo-400 hover:text-indigo-300 transition-colors"
                          >
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Inline revision feedback input */}
                {showRevisionInput && (
                  <div className="border-t border-slate-800 pt-3 space-y-2">
                    <label className="text-xs font-semibold text-slate-400 tracking-wider">REVISION FEEDBACK</label>
                    <textarea
                      value={revisionNote}
                      onChange={e => setRevisionNote(e.target.value)}
                      placeholder="Your feedback to the author…"
                      rows={3}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => editArticle?.id && sendRevisionRequest(editArticle.id, revisionNote)}
                        disabled={!revisionNote.trim()}
                        className="px-3 py-1.5 rounded-lg text-xs text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 transition-all"
                      >
                        Send Revision Request
                      </button>
                      <button onClick={() => setShowRevisionInput(false)} className="text-xs text-slate-500 hover:text-white">Cancel</button>
                    </div>
                  </div>
                )}

                {/* Inline schedule input */}
                {showScheduleInput && (
                  <div className="border-t border-slate-800 pt-3 space-y-2">
                    <label className="text-xs font-semibold text-slate-400 tracking-wider">SCHEDULE PUBLISH DATE</label>
                    <div className="flex gap-2">
                      <input
                        type="datetime-local"
                        value={scheduleDate}
                        onChange={e => setScheduleDate(e.target.value)}
                        className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                      />
                      <button
                        onClick={() => {
                          if (!editArticle?.id || !tenant?.id || !scheduleDate) return;
                          patchMeta(tenant.id, editArticle.id, { status: 'scheduled', scheduledAt: scheduleDate });
                          setArticleMeta(loadMeta(tenant.id));
                          setShowScheduleInput(false);
                          setEditToast('Scheduled for publish');
                          setTimeout(() => setEditToast(''), 3000);
                          setEditArticle(undefined as any);
                        }}
                        disabled={!scheduleDate}
                        className="px-3 py-1.5 rounded-lg text-xs text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-40 transition-all"
                      >
                        Schedule
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Button bar */}
              <div className="px-6 py-4 border-t border-slate-800 flex-shrink-0 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {/* Save Draft — always */}
                  <button
                    onClick={() => saveEdit(false)}
                    disabled={editSaving || !editTitle.trim() || !editBody.trim()}
                    className="px-4 py-2 rounded-xl text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-40"
                  >
                    Save Draft
                  </button>

                  {/* Submit for Review — when draft or needs_revision */}
                  {(() => {
                    const curStatus = editArticle ? getArticleStatus(editArticle, articleMeta) : 'draft';
                    return (curStatus === 'draft' || curStatus === 'needs_revision') && (
                      <button
                        onClick={submitForReview}
                        disabled={!editArticle?.id}
                        className="px-4 py-2 rounded-xl text-sm bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-all disabled:opacity-40"
                      >
                        Submit for Review
                      </button>
                    );
                  })()}

                  {/* Admin: Approve & Publish + Request Revision */}
                  {isAdmin && (() => {
                    const curStatus = editArticle ? getArticleStatus(editArticle, articleMeta) : 'draft';
                    return (curStatus === 'in_review' || curStatus === 'approved') && editArticle && (<>
                      <button
                        onClick={() => approveAndPublish(editArticle)}
                        disabled={editSaving}
                        className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-500 transition-all disabled:opacity-40"
                      >
                        Approve & Publish
                      </button>
                      <button
                        onClick={() => setShowRevisionInput(v => !v)}
                        className="px-4 py-2 rounded-xl text-sm bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 transition-all"
                      >
                        Request Revision
                      </button>
                    </>);
                  })()}

                  {/* Schedule — when draft / in_review / needs_revision */}
                  {(() => {
                    const curStatus = editArticle ? getArticleStatus(editArticle, articleMeta) : 'draft';
                    return ['draft','in_review','needs_revision'].includes(curStatus) && editArticle && (
                      <button
                        onClick={() => setShowScheduleInput(v => !v)}
                        className="px-4 py-2 rounded-xl text-sm bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-all"
                      >
                        Schedule
                      </button>
                    );
                  })()}

                  {/* Archive — when published */}
                  {editArticle && getArticleStatus(editArticle, articleMeta) === 'published' && tenant?.id && (
                    <button
                      onClick={async () => {
                        await updateArticleStatus(editArticle.id, 'draft');
                        patchMeta(tenant!.id, editArticle.id, { status: 'archived' });
                        await refreshArticles();
                        setEditToast('Article archived');
                        setTimeout(() => setEditToast(''), 3000);
                        setEditArticle(undefined as any);
                      }}
                      className="px-4 py-2 rounded-xl text-sm bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700 transition-all"
                    >
                      Archive
                    </button>
                  )}

                  <button
                    onClick={() => setEditArticle(undefined as any)}
                    className="text-sm text-slate-400 hover:text-white transition-colors ml-auto"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (subPage === 'hub_review') {
    const ReviewQueue = () => {
      const [selectedId, setSelectedId] = React.useState<string | null>(null);
      const [reviewNote, setReviewNote] = React.useState('');
      const [showReviewInput, setShowReviewInput] = React.useState(false);
      const [toast, setToast] = React.useState('');

      const queueItems = liveArticles.filter(a => {
        const s = getArticleStatus(a, articleMeta);
        return s === 'in_review' || s === 'needs_revision';
      });

      const selectedArticle = queueItems.find(a => a.id === selectedId) || null;
      const selectedStatus = selectedArticle ? getArticleStatus(selectedArticle, articleMeta) : '';
      const selectedMeta = selectedArticle ? articleMeta[selectedArticle.id] : undefined;

      const doApprove = async () => {
        if (!selectedArticle || !tenant?.id) return;
        await updateArticleStatus(selectedArticle.id, 'published');
        ingestArticle({ tenantId: tenant.id, content: selectedArticle.body, title: selectedArticle.title, articleId: selectedArticle.id, sourceType: 'article' }).catch(() => {});
        clearArticleMeta(tenant.id, selectedArticle.id);
        await refreshArticles();
        setSelectedId(null);
        setToast('Published and indexed');
        setTimeout(() => setToast(''), 3000);
      };

      const doRevision = () => {
        if (!selectedArticle || !tenant?.id || !reviewNote.trim()) return;
        patchMeta(tenant.id, selectedArticle.id, { status: 'needs_revision', reviewNote });
        setArticleMeta(loadMeta(tenant.id));
        setShowReviewInput(false);
        setReviewNote('');
        setToast('Revision requested');
        setTimeout(() => setToast(''), 3000);
      };

      const doArchive = () => {
        if (!selectedArticle || !tenant?.id) return;
        patchMeta(tenant.id, selectedArticle.id, { status: 'archived' });
        setArticleMeta(loadMeta(tenant.id));
        setSelectedId(null);
        setToast('Archived');
        setTimeout(() => setToast(''), 3000);
      };

      return (
        <div className="flex-1 overflow-hidden bg-slate-950 flex flex-col">
          <div className="px-6 pt-6">
            <PageTabs tabs={HUB_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
            <div className="mb-4">
              <h1 className="text-2xl font-bold text-white">Review Queue</h1>
              <p className="text-slate-400 text-sm mt-1">Articles awaiting editorial review before publishing</p>
            </div>
          </div>
          {queueItems.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-3 text-slate-700">◈</div>
                <p className="text-slate-400 text-sm">No articles awaiting review</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 overflow-hidden border-t border-slate-800">
              {/* Left panel */}
              <div className="w-72 border-r border-slate-800 overflow-y-auto flex-shrink-0">
                {queueItems.map(a => {
                  const s = getArticleStatus(a, articleMeta);
                  return (
                    <button
                      key={a.id}
                      onClick={() => { setSelectedId(a.id); setShowReviewInput(false); setReviewNote(''); }}
                      className={`w-full text-left px-4 py-3 border-b border-slate-800/50 hover:bg-slate-800/50 transition-colors ${selectedId === a.id ? 'bg-slate-800' : ''}`}
                    >
                      <div className="font-medium text-white text-sm truncate mb-1">{a.title}</div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_BADGE_CLASS[s]}`}>{STATUS_LABEL[s]}</span>
                      </div>
                      <div className="text-xs text-slate-500">{a.category || 'General'} · {new Date(a.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                    </button>
                  );
                })}
              </div>

              {/* Right panel */}
              <div className="flex-1 overflow-y-auto p-6">
                {!selectedArticle ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-slate-500 text-sm">Select an article to review</p>
                  </div>
                ) : (
                  <div className="max-w-2xl">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h2 className="text-xl font-bold text-white mb-1">{selectedArticle.title}</h2>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE_CLASS[selectedStatus]}`}>{STATUS_LABEL[selectedStatus]}</span>
                          <span className="text-xs text-slate-500">Last updated {new Date(selectedArticle.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                        </div>
                      </div>
                    </div>

                    {selectedMeta?.reviewNote && (
                      <div className="mb-4 px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl">
                        <p className="text-xs font-semibold text-yellow-400 mb-1">AUTHOR NOTE</p>
                        <p className="text-sm text-yellow-200">{selectedMeta.reviewNote}</p>
                      </div>
                    )}

                    <pre className="whitespace-pre-wrap text-sm text-slate-300 leading-relaxed bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4 max-h-64 overflow-y-auto">
                      {selectedArticle.body}
                    </pre>

                    <div className="flex flex-wrap gap-3 text-xs text-slate-400 mb-6">
                      <span>Audience: <span className="text-white">{selectedArticle.audience}</span></span>
                      <span>Category: <span className="text-white">{selectedArticle.category || 'General'}</span></span>
                      {(selectedArticle.tags || []).length > 0 && (
                        <span>Tags: <span className="text-white">{(selectedArticle.tags || []).join(', ')}</span></span>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2 mb-4">
                      <button
                        onClick={doApprove}
                        className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-500 transition-all"
                      >
                        Approve & Publish
                      </button>
                      <button
                        onClick={() => setShowReviewInput(v => !v)}
                        className="px-4 py-2 rounded-xl text-sm bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-all"
                      >
                        Request Revision
                      </button>
                      <button
                        onClick={doArchive}
                        className="px-4 py-2 rounded-xl text-sm bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700 transition-all"
                      >
                        Archive
                      </button>
                    </div>

                    {showReviewInput && (
                      <div className="space-y-2">
                        <textarea
                          value={reviewNote}
                          onChange={e => setReviewNote(e.target.value)}
                          placeholder="Your feedback to the author…"
                          rows={3}
                          className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
                        />
                        <button
                          onClick={doRevision}
                          disabled={!reviewNote.trim()}
                          className="px-4 py-2 rounded-xl text-sm bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 transition-all"
                        >
                          Send Revision Request
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {toast && (
            <div className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl">{toast}</div>
          )}
        </div>
      );
    };
    return <ReviewQueue />;
  }

  if (subPage === 'hub_ingestion') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
        <PageTabs tabs={HUB_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Ingestion Pipeline</h1>
            <p className="text-slate-400 text-sm mt-1">
              Upload files or add URLs — content is chunked, embedded, and indexed into the KB
            </p>
          </div>
        </div>

        {/* File Upload */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Upload File</h2>
            <div
              className="border-2 border-dashed border-slate-700 rounded-xl p-8 text-center hover:border-slate-500 transition-all cursor-pointer"
              onClick={() => (uploadInputRef.current as any)?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileUpload(f); }}
            >
              <div className="text-3xl mb-3">↑</div>
              <p className="text-slate-400 text-sm">Drag & drop or click to browse</p>
              <p className="text-slate-600 text-xs mt-1">.txt · .md · .csv · .json · .pdf</p>
              <input
                ref={uploadInputRef}
                type="file"
                className="hidden"
                accept=".txt,.md,.csv,.json,.pdf"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }}
              />
            </div>
            {isUploading && (
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                <span className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                Processing and indexing…
              </div>
            )}
            {uploadResult && !isUploading && (
              <div className="mt-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-xs space-y-1">
                <div className="text-emerald-400 font-medium">Indexed: {(uploadResult as any).fileName}</div>
                <div className="text-slate-400">
                  {(uploadResult as any).wordCount.toLocaleString()} words · {(uploadResult as any).chunkCount} chunks · {(uploadResult as any).sizeKb} KB
                </div>
                {(uploadResult as any).preview && (
                  <p className="text-slate-500 mt-1 line-clamp-2">{(uploadResult as any).preview}…</p>
                )}
              </div>
            )}
          </div>

          {/* URL Ingestion */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Add URL Source</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">URL</label>
                <input
                  type="url"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  placeholder="https://docs.yourproduct.com/guide"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Title (optional)</label>
                <input
                  type="text"
                  value={urlTitle}
                  onChange={e => setUrlTitle(e.target.value)}
                  placeholder="Leave blank to auto-detect"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Audience</label>
                <div className="flex gap-2">
                  {(['both','customer','internal'] as const).map(a => (
                    <button
                      key={a}
                      onClick={() => setUrlAudience(a)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${urlAudience === a ? 'text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                      style={urlAudience === a ? { backgroundColor: accentColor } : {}}
                    >
                      {a.charAt(0).toUpperCase() + a.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={handleUrlIngest}
                disabled={!urlInput.trim() || isIngestingUrl}
                className="w-full py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 transition-all flex items-center justify-center gap-2"
                style={{ backgroundColor: accentColor }}
              >
                {isIngestingUrl ? (
                  <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Ingesting…</>
                ) : '+ Ingest URL'}
              </button>
              <p className="text-xs text-slate-600">CORS-permissive URLs are fetched directly. Others create a reference stub — deploy the <code className="text-slate-500">ingest-url</code> Edge Function for full content extraction.</p>
            </div>
          </div>
        </div>

        {/* Connected Sources */}
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-white mb-3">Connected Sources</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {ingestionSources.map((src, i) => (
              <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-xl bg-indigo-500/20 flex items-center justify-center text-lg text-indigo-300">
                    {src.icon}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">{src.name}</div>
                    <Badge label={src.status === 'syncing' ? 'Syncing' : 'Active'} color={src.status === 'syncing' ? 'yellow' : 'green'} />
                  </div>
                </div>
                <div className="flex justify-between text-xs text-slate-400 mb-3">
                  <span>{src.docs.toLocaleString()} docs</span>
                  <span>{src.lastSync}</span>
                </div>
                <div className="flex gap-2">
                  <button className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">Sync Now</button>
                  <button className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 rounded-lg transition-all">Settings</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Activity Log */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Pipeline Activity</h2>
          <div className="space-y-2">
            {ingestLog.length > 0 ? ingestLog.map((entry, i) => (
              <div key={i} className="flex items-start gap-3 text-xs">
                <span className={entry.ok ? 'text-emerald-400 mt-0.5' : 'text-amber-400 mt-0.5'}>{entry.ok ? '✓' : '!'}</span>
                <span className="text-slate-300 flex-1">{entry.msg}</span>
                <span className="text-slate-600">{entry.ts}</span>
              </div>
            )) : [
              { msg: 'Zendesk: 42 new tickets ingested and embedded', ts: '2 min ago', ok: true },
              { msg: 'Confluence: 8 pages updated, KB refresh triggered', ts: '12 min ago', ok: true },
              { msg: 'Google Drive: Policy doc v3.2 detected, diff processed', ts: '1 hr ago', ok: true },
              { msg: 'GitHub: 3 README files changed, embeddings updated', ts: '1 day ago', ok: true },
            ].map((entry, i) => (
              <div key={i} className="flex items-start gap-3 text-xs">
                <span className="text-emerald-400 mt-0.5">✓</span>
                <span className="text-slate-300 flex-1">{entry.msg}</span>
                <span className="text-slate-600">{entry.ts}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (subPage === 'hub_training') {
    // Per-module completion tracking stored in state
    const TrainingCenter = () => {
      const [moduleCompletions, setModuleCompletions] = React.useState<Record<string, Record<string, boolean>>>(() => {
        try { return JSON.parse(localStorage.getItem('dt_training_completions') || '{}'); } catch { return {}; }
      });
      const [expandedMod, setExpandedMod] = React.useState<string | null>(null);
      const [assigningMod, setAssigningMod] = React.useState<string | null>(null);
      const [assignedModules, setAssignedModules] = React.useState<Record<string, string[]>>(() => {
        try { return JSON.parse(localStorage.getItem('dt_training_assignments') || '{}'); } catch { return {}; }
      });

      const staff = [
        { id: 's1', name: 'Sarah Mitchell', dept: 'Leadership', avatar: 'SM' },
        { id: 's2', name: 'James Okafor', dept: 'IT', avatar: 'JO' },
        { id: 's3', name: 'Priya Nair', dept: 'Operations', avatar: 'PN' },
        { id: 's4', name: 'Tom Bergmann', dept: 'Finance', avatar: 'TB' },
        { id: 's5', name: 'Elena Vasquez', dept: 'Customer Success', avatar: 'EV' },
        { id: 's6', name: 'Marcus Webb', dept: 'Revenue', avatar: 'MW' },
      ];

      const saveCompletions = (next: Record<string, Record<string, boolean>>) => {
        setModuleCompletions(next);
        try { localStorage.setItem('dt_training_completions', JSON.stringify(next)); } catch {}
      };

      const saveAssignments = (next: Record<string, string[]>) => {
        setAssignedModules(next);
        try { localStorage.setItem('dt_training_assignments', JSON.stringify(next)); } catch {}
      };

      const toggleComplete = (modTitle: string, staffId: string) => {
        const next = {
          ...moduleCompletions,
          [modTitle]: {
            ...(moduleCompletions[modTitle] || {}),
            [staffId]: !(moduleCompletions[modTitle]?.[staffId]),
          },
        };
        saveCompletions(next);
      };

      const toggleAssign = (modTitle: string, staffId: string) => {
        const current = assignedModules[modTitle] || [];
        const next = current.includes(staffId)
          ? current.filter(id => id !== staffId)
          : [...current, staffId];
        saveAssignments({ ...assignedModules, [modTitle]: next });
      };

      const getModCompletion = (modTitle: string) => {
        const assigned = assignedModules[modTitle] || staff.map(s => s.id);
        if (assigned.length === 0) return 0;
        const done = assigned.filter(id => moduleCompletions[modTitle]?.[id]).length;
        return Math.round((done / assigned.length) * 100);
      };

      const totalAssigned = Object.values(assignedModules).flat().length;
      const totalCompleted = Object.entries(moduleCompletions).reduce((sum, [, perStaff]) =>
        sum + Object.values(perStaff).filter(Boolean).length, 0);

      return (
        <div className="flex-1 overflow-auto bg-slate-950 p-6">
          <PageTabs tabs={HUB_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Training Center</h1>
              <p className="text-slate-400 text-sm mt-1">
                AI-generated modules from your Knowledge Base — assign to staff and track completion
              </p>
            </div>
            <button
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
              style={{ backgroundColor: accentColor }}
            >
              + Generate Module
            </button>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {[
              { label: 'Modules', value: String(trainingModules.length), sub: 'From KB' },
              { label: 'Staff Enrolled', value: String(staff.length), sub: 'Active members' },
              { label: 'Completions', value: String(totalCompleted), sub: 'This month' },
              { label: 'Avg Completion', value: `${Math.round(trainingModules.reduce((s, m) => s + getModCompletion(m.title), 0) / trainingModules.length)}%`, sub: 'Across all modules' },
            ].map((k, i) => (
              <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="text-2xl font-bold text-white mb-1">{k.value}</div>
                <div className="text-xs text-slate-400">{k.label}</div>
                <div className="text-xs text-slate-600 mt-0.5">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Module cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {trainingModules.map((mod, i) => {
              const pct = getModCompletion(mod.title);
              const assigned = assignedModules[mod.title] || staff.map(s => s.id);
              const doneCount = assigned.filter(id => moduleCompletions[mod.title]?.[id]).length;
              return (
                <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all">
                  <div className="mb-3">
                    <div className="text-sm font-semibold text-white mb-1">{mod.title}</div>
                    <div className="flex items-center gap-2">
                      <Badge label={mod.category} color="indigo" />
                      <span className="text-xs text-slate-500">{mod.duration}</span>
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>{doneCount}/{assigned.length} completed</span>
                      <span className={pct === 100 ? 'text-emerald-400' : pct >= 70 ? 'text-white' : 'text-amber-400'}>{pct}%</span>
                    </div>
                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>

                  {/* Staff avatars */}
                  <div className="flex items-center gap-1 mb-3">
                    {assigned.slice(0, 6).map(id => {
                      const s = staff.find(s => s.id === id);
                      const done = moduleCompletions[mod.title]?.[id];
                      return s ? (
                        <button
                          key={id}
                          title={`${s.name} — ${done ? 'completed' : 'pending'}`}
                          onClick={() => toggleComplete(mod.title, id)}
                          className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center border-2 transition-all ${
                            done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400' : 'border-slate-700 bg-slate-800 text-slate-400'
                          }`}
                        >
                          {s.avatar[0]}
                        </button>
                      ) : null;
                    })}
                    {assigned.length > 6 && <span className="text-xs text-slate-500">+{assigned.length - 6}</span>}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setExpandedMod(expandedMod === mod.title ? null : mod.title)}
                      className="flex-1 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-all"
                    >
                      {expandedMod === mod.title ? 'Hide' : 'View'} progress
                    </button>
                    <button
                      onClick={() => setAssigningMod(assigningMod === mod.title ? null : mod.title)}
                      className="px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-all"
                    >
                      Assign
                    </button>
                  </div>

                  {/* Per-person progress */}
                  {expandedMod === mod.title && (
                    <div className="mt-3 pt-3 border-t border-slate-700 space-y-1.5">
                      {assigned.map(id => {
                        const s = staff.find(s => s.id === id);
                        const done = moduleCompletions[mod.title]?.[id];
                        return s ? (
                          <div key={id} className="flex items-center gap-2">
                            <div className="w-5 h-5 rounded-full bg-slate-700 text-xs flex items-center justify-center text-slate-400 flex-shrink-0">{s.avatar[0]}</div>
                            <span className="flex-1 text-xs text-slate-300">{s.name}</span>
                            <button
                              onClick={() => toggleComplete(mod.title, id)}
                              className={`text-xs px-2 py-0.5 rounded transition-all ${done ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500 hover:text-slate-300'}`}
                            >
                              {done ? '✓ Done' : 'Pending'}
                            </button>
                          </div>
                        ) : null;
                      })}
                    </div>
                  )}

                  {/* Assign modal inline */}
                  {assigningMod === mod.title && (
                    <div className="mt-3 pt-3 border-t border-slate-700">
                      <p className="text-xs text-slate-400 mb-2">Toggle staff assignment:</p>
                      <div className="space-y-1">
                        {staff.map(s => {
                          const isAssigned = (assignedModules[mod.title] || staff.map(s => s.id)).includes(s.id);
                          return (
                            <button
                              key={s.id}
                              onClick={() => toggleAssign(mod.title, s.id)}
                              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all ${isAssigned ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                            >
                              <div className="w-5 h-5 rounded-full bg-slate-700 text-xs flex items-center justify-center flex-shrink-0">{s.avatar[0]}</div>
                              <span className="flex-1 text-left">{s.name}</span>
                              <span className="text-slate-500">{s.dept}</span>
                              {isAssigned && <span className="text-indigo-400">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Staff completion summary */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Staff Completion Summary</h2>
            <div className="space-y-2">
              {staff.map(s => {
                const total = trainingModules.length;
                const done = trainingModules.filter(m => moduleCompletions[m.title]?.[s.id]).length;
                const pct = Math.round((done / total) * 100);
                return (
                  <div key={s.id} className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-slate-800 text-xs font-bold flex items-center justify-center flex-shrink-0"
                      style={{ color: accentColor }}>{s.avatar}</div>
                    <div className="flex-1">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-white">{s.name}</span>
                        <span className={pct === 100 ? 'text-emerald-400' : 'text-slate-400'}>{done}/{total} modules</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#10b981' : accentColor }} />
                      </div>
                    </div>
                    <span className="text-xs text-slate-500 w-8 text-right">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      );
    };
    return <TrainingCenter />;
  }

  if (subPage === 'hub_analytics') {
    return (
      <div className="flex-1 overflow-auto bg-slate-950 p-6">
      <PageTabs tabs={HUB_TABS} page={subPage} setPage={setPage} accentColor={accentColor} />
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">KB Analytics</h1>
          <p className="text-slate-400 text-sm mt-1">
            Understand how your knowledge base is performing for customers and
            staff
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Queries"
            value="12,481"
            icon="◆"
            color="indigo"
            trend="+18%"
          />
          <StatCard
            label="Self-Served"
            value="89%"
            icon="★"
            color="emerald"
            trend="No human needed"
          />
          <StatCard
            label="Escalation Rate"
            value="11%"
            icon="⚠"
            color="amber"
            trend="-3% this month"
          />
          <StatCard
            label="Avg Confidence"
            value="87%"
            icon="⚡"
            color="blue"
            trend="+5% this month"
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Knowledge Gap Detection — computed from real articles */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Knowledge Gap Detection</h2>
              <span className="text-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded">
                {[
                  ...articles.filter(a => (a.views ?? 0) === 0),
                  ...articles.filter(a => {
                    if (!a.updated) return false;
                    const daysAgo = (Date.now() - new Date(a.updated).getTime()) / 86400000;
                    return daysAgo > 90;
                  }),
                ].length} gaps found
              </span>
            </div>
            <div className="space-y-2">
              {/* Zero-view articles */}
              {articles.filter(a => (a.views ?? 0) === 0).slice(0, 3).map((a, i) => (
                <div key={`nv-${i}`} className="flex items-center gap-3 p-2.5 rounded-lg bg-red-500/5 border border-red-500/10">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white font-medium truncate">{a.title}</div>
                    <div className="text-xs text-slate-500">{a.category} · 0 views — never seen by a customer or DE</div>
                  </div>
                  <Badge label="Unread" color="red" />
                </div>
              ))}
              {/* Stale articles (not updated in >90 days) */}
              {articles.filter(a => {
                const updated = a.updated || a.updatedAt || '';
                if (!updated || updated.includes('ago') || updated.includes('day') || updated.includes('hour')) return false;
                const daysAgo = (Date.now() - new Date(updated).getTime()) / 86400000;
                return daysAgo > 90;
              }).slice(0, 2).map((a, i) => (
                <div key={`st-${i}`} className="flex items-center gap-3 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white font-medium truncate">{a.title}</div>
                    <div className="text-xs text-slate-500">{a.category} · Last updated {a.updated || a.updatedAt}</div>
                  </div>
                  <Badge label="Stale" color="yellow" />
                </div>
              ))}
              {/* Static high-signal queries with no KB coverage */}
              {[
                { q: 'How do I export data to CSV?', count: 147 },
                { q: 'Can I have multiple payment methods?', count: 76 },
                { q: 'How to set up SSO with Okta?', count: 68 },
              ].map((item, i) => (
                <div key={`qg-${i}`} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-800/50">
                  <div className="flex-1">
                    <div className="text-xs text-white">{item.q}</div>
                    <div className="text-xs text-slate-500">{item.count} customer queries — no article found</div>
                  </div>
                  <button className="text-xs px-2 py-1 rounded text-white bg-indigo-600 hover:bg-indigo-500 transition-all whitespace-nowrap">
                    + Draft article
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4">
              Query Volume Last 7 Days
            </h2>
            <div className="space-y-2">
              {[1800, 2100, 1950, 2300, 2450, 2280, 2601].map((v, i) => {
                const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const pct = (v / 2601) * 100;
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs text-slate-500 w-8">
                      {days[i]}
                    </span>
                    <div className="flex-1 h-2 bg-slate-800 rounded-full">
                      <div
                        className="h-full bg-indigo-500 rounded-full"
                        style={{ width: pct + '%' }}
                      />
                    </div>
                    <span className="text-xs text-slate-300 w-12 text-right">
                      {v.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6">
      <p className="text-slate-400">Knowledge Hub</p>
    </div>
  );
};

export default KnowledgeHubPage;
