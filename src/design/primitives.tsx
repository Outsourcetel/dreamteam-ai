import React, { createContext, useContext } from 'react';

/* ═══════════════════════════════════════════════════════════════════════════
   DreamTeam Design System v1 — THE SCHEMA KIT
   The approved component vocabulary. Every screen composes from these; a
   screen inventing its own StatCard/Modal/Banner is a design-drift bug.
   Spec + do/don't: docs/design-system.md. Tokens: src/design/tokens.css.

   Founder profile (2026-07-22): indigo accent · comfortable density with
   compact data tables · dark now/light-ready · excellent at 1280px.
   ═══════════════════════════════════════════════════════════════════════════ */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent';

/* ── Buttons (5 kinds, 2 sizes) ─────────────────────────────────────────── */
const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dt-accent';
const BTN_SIZE = { sm: 'text-xs px-3 py-1.5', md: 'text-sm px-4 py-2' } as const;
const BTN_KIND = {
  primary: 'bg-dt-accent-strong hover:bg-dt-accent-hover text-white',
  secondary: 'border border-dt-border-strong text-dt-body hover:border-dt-muted hover:bg-dt-panel',
  ghost: 'text-dt-support hover:text-dt-body hover:bg-dt-panel',
  danger: 'bg-rose-600 hover:bg-rose-500 text-white',
  success: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  ai: 'border border-dt-accent/40 bg-dt-accent-soft text-dt-accent-text hover:border-dt-accent',
} as const;

export function Button({ kind = 'secondary', size = 'md', className = '', ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: keyof typeof BTN_KIND; size?: keyof typeof BTN_SIZE }) {
  return <button className={`${BTN_BASE} ${BTN_SIZE[size]} ${BTN_KIND[kind]} ${className}`} {...rest} />;
}

/* ── Chips — the status vocabulary (dot + label, one recipe per tone) ───── */
const CHIP_TONE: Record<Tone, string> = {
  ok: 'bg-dt-ok-soft text-dt-ok border-dt-ok-border',
  warn: 'bg-dt-warn-soft text-dt-warn border-dt-warn-border',
  danger: 'bg-dt-danger-soft text-dt-danger border-dt-danger-border',
  info: 'bg-dt-info-soft text-dt-info border-dt-info-border',
  neutral: 'bg-dt-neutral-soft text-dt-neutral border-dt-neutral-border',
  accent: 'bg-dt-accent-soft text-dt-accent-text border-dt-accent/30',
};
export function Chip({ tone = 'neutral', dot, pulse, children, className = '' }:
  { tone?: Tone; dot?: boolean; pulse?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border ${CHIP_TONE[tone]} ${className}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full bg-current ${pulse ? 'animate-pulse' : ''}`} />}
      {children}
    </span>
  );
}

/* ── PanelCard — any titled section (the ONE card container) ────────────── */
export function PanelCard({ title, badge, actions, children, className = '' }:
  { title?: React.ReactNode; badge?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-dt-border bg-dt-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-1">
          <div className="flex items-center gap-2 min-w-0">
            {title && <h2 className="text-base font-semibold text-dt-title truncate">{title}</h2>}
            {badge}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className="px-5 pb-5 pt-2">{children}</div>
    </section>
  );
}

/* ── StatTile — a number at a glance ────────────────────────────────────── */
export function StatTile({ label, value, sub, tone }:
  { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  const v = tone ? { ok: 'text-dt-ok', warn: 'text-dt-warn', danger: 'text-dt-danger', info: 'text-dt-info', neutral: 'text-dt-title', accent: 'text-dt-accent-text' }[tone] : 'text-dt-title';
  return (
    <div className="rounded-xl border border-dt-border bg-dt-card px-4 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-1">{label}</div>
      <div className={`text-xl font-semibold ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-dt-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* ── DetailTile — a labeled fact (Employee-File-strip style) ────────────── */
export function DetailTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dt-border bg-dt-card px-4 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-dt-muted mb-1">{label}</div>
      {children}
    </div>
  );
}

/* ── EntityRow — roster/tasks/conversations list item ───────────────────── */
export function EntityRow({ avatar, title, titleExtra, chips, meta, actions, onOpen, selected }:
  { avatar?: React.ReactNode; title: React.ReactNode; titleExtra?: React.ReactNode; chips?: React.ReactNode;
    meta?: React.ReactNode; actions?: React.ReactNode; onOpen?: () => void; selected?: boolean }) {
  return (
    <div className={`group flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
      selected ? 'border-dt-accent/40 bg-dt-accent-soft' : 'border-dt-border bg-dt-card hover:bg-dt-panel hover:border-dt-border-strong'}`}>
      {avatar}
      <button onClick={onOpen} className="flex-1 min-w-0 text-left" disabled={!onOpen}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-dt-title truncate">{title}</span>
          {titleExtra}
          {chips}
        </div>
        {meta && <div className="text-xs text-dt-support mt-0.5 truncate">{meta}</div>}
      </button>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onOpen && <button onClick={onOpen} aria-label="Open" className="text-dt-faint group-hover:text-dt-support transition-colors">→</button>}
      </div>
    </div>
  );
}

/* ── QueueCard — an item awaiting a human decision ──────────────────────── */
export function QueueCard({ tone = 'warn', title, detail, chips, actions }:
  { tone?: Tone; title: React.ReactNode; detail?: React.ReactNode; chips?: React.ReactNode; actions?: React.ReactNode }) {
  const edge = { ok: 'border-l-dt-ok', warn: 'border-l-dt-warn', danger: 'border-l-dt-danger', info: 'border-l-dt-info', neutral: 'border-l-dt-neutral', accent: 'border-l-dt-accent' }[tone];
  return (
    <div className={`rounded-xl border border-dt-border border-l-2 ${edge} bg-dt-card px-4 py-3`}>
      <div className="text-sm font-medium text-dt-title">{title}</div>
      {detail && <div className="text-xs text-dt-support mt-1">{detail}</div>}
      {(chips || actions) && (
        <div className="flex items-center justify-between gap-3 mt-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">{chips}</div>
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        </div>
      )}
    </div>
  );
}

/* ── TimelineStep — audit replays, case steps ───────────────────────────── */
export function TimelineStep({ n, action, detail, at }:
  { n: number; action: React.ReactNode; detail?: React.ReactNode; at?: React.ReactNode }) {
  return (
    <li className="flex gap-3 rounded-lg border border-dt-border bg-dt-panel p-3">
      <span className="shrink-0 w-6 h-6 rounded-full bg-dt-inset border border-dt-border text-dt-support text-xs flex items-center justify-center">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-dt-body">{action}</div>
        {detail && <div className="text-xs text-dt-support mt-0.5">{detail}</div>}
      </div>
      {at && <span className="text-[11px] text-dt-muted shrink-0">{at}</span>}
    </li>
  );
}

/* ── EmptyState — every empty list earns one (never a blank box) ────────── */
export function EmptyState({ icon, headline, children, action }:
  { icon?: React.ReactNode; headline: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-dt-border px-6 py-10 text-center">
      {icon && <div className="mx-auto mb-3 w-10 h-10 rounded-xl bg-dt-panel flex items-center justify-center text-dt-support">{icon}</div>}
      <p className="text-sm font-medium text-dt-body">{headline}</p>
      {children && <div className="text-xs text-dt-support mt-1.5 max-w-md mx-auto">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ── Banner — info/warn/danger notice (one recipe per severity) ─────────── */
export function Banner({ tone = 'info', children, className = '' }:
  { tone?: Extract<Tone, 'info' | 'warn' | 'danger' | 'neutral'>; children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border px-4 py-3 text-sm ${CHIP_TONE[tone]} ${className}`}>{children}</div>;
}

/* ── Form field — label · hint · control · error ────────────────────────── */
export const INPUT_CLS = 'w-full rounded-lg bg-dt-inset border border-dt-border-strong px-3 py-2 text-sm text-dt-body placeholder:text-dt-faint focus:outline-none focus:ring-2 focus:ring-dt-accent focus:border-transparent';
export function Field({ label, hint, error, children }:
  { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-dt-body mb-1">{label}</label>
      {hint && <p className="text-xs text-dt-muted mb-1.5">{hint}</p>}
      {children}
      {error && <p className="text-xs text-dt-danger mt-1">{error}</p>}
    </div>
  );
}

/* ── TabBar — the hub/profile tab strip ─────────────────────────────────── */
export function TabBar<T extends string>({ tabs, active, onSelect }:
  { tabs: { key: T; label: string; badge?: React.ReactNode }[]; active: T; onSelect: (k: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-dt-border overflow-x-auto scrollbar-none">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onSelect(t.key)}
          className={`shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            active === t.key ? 'border-dt-accent text-dt-title' : 'border-transparent text-dt-support hover:text-dt-body'}`}>
          {t.label}{t.badge}
        </button>
      ))}
    </div>
  );
}

/* ── Data tables — COMPACT density (founder profile: calm cards, dense data)
   Wrap wide tables in <TableScroll> so the PAGE never scrolls sideways. ─── */
export const TH = 'py-2 px-3 text-[11px] uppercase tracking-wide text-dt-muted font-medium text-left whitespace-nowrap';
export const TD = 'py-2 px-3 text-sm text-dt-body';
export function TableScroll({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`overflow-x-auto rounded-xl border border-dt-border ${className}`}>{children}</div>;
}

/* ── Overlays — the ONE modal and the ONE right-drawer ──────────────────── */
export function Modal({ title, onClose, children, wide }:
  { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto bg-dt-page border border-dt-border-strong rounded-2xl p-6`}
        onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-dt-title">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-dt-muted hover:text-dt-body text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Drawer({ title, onClose, children }:
  { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-dt-page border-l border-dt-border-strong overflow-y-auto p-6"
        onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="text-lg font-semibold text-dt-title">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-dt-muted hover:text-dt-body text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Page scaffolding — header + the InHub demotion contract ────────────── */
export const InHubContextV2 = createContext(false);
export function PageHeaderV2({ title, subtitle, actions }:
  { title: string; subtitle?: string; actions?: React.ReactNode }) {
  const inHub = useContext(InHubContextV2);
  if (inHub) return subtitle ? <p className="text-sm text-dt-support mb-5 max-w-3xl">{subtitle}</p> : null;
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold text-dt-title">{title}</h1>
        {subtitle && <p className="text-sm text-dt-support mt-1 max-w-3xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
