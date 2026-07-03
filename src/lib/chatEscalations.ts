import type { CompanyId } from '../data/companies';

// ── Chat escalations — written by DEChatDock, surfaced in Human Tasks ─
// Stored in localStorage under dt_chat_escalations_${companyId}.

export interface ChatEscalation {
  id: string;
  type: 'review_gate';
  title: string;
  de: string;
  createdAt: string; // ISO
  status: 'pending' | 'approved' | 'rejected';
  source: string; // 'de_chat_dock'
}

const escKey = (c: CompanyId) => `dt_chat_escalations_${c}`;

export function loadChatEscalations(companyId: CompanyId): ChatEscalation[] {
  try {
    const raw = localStorage.getItem(escKey(companyId));
    if (raw) return JSON.parse(raw) as ChatEscalation[];
  } catch { /* noop */ }
  return [];
}

export function countPendingChatEscalations(companyId: CompanyId): number {
  return loadChatEscalations(companyId).filter(e => e.status === 'pending').length;
}

export function setChatEscalationStatus(
  companyId: CompanyId,
  id: string,
  status: 'approved' | 'rejected',
): void {
  try {
    const list = loadChatEscalations(companyId).map(e => (e.id === id ? { ...e, status } : e));
    localStorage.setItem(escKey(companyId), JSON.stringify(list));
    window.dispatchEvent(new Event('dt-state-changed'));
  } catch { /* noop */ }
}

export function chatEscalationAge(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''}`;
}
