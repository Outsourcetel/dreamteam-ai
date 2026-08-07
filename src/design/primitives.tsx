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
    // 12px floor (v2). Was text-[11px] — and a chip is not always a one-word
    // badge: DecisionCard's staleness slot puts "Nothing's happened in 5 days"
    // in one, and the floor rule exists precisely so a SENTENCE never renders
    // below 12. Fixed on the primitive rather than at the call sites, which
    // lifts every chip in the app in one line.
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${CHIP_TONE[tone]} ${className}`}>
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
export function StatTile({ label, value, sub, tone, icon, onClick }:
  { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon?: React.ReactNode; onClick?: () => void }) {
  const v = tone ? { ok: 'text-dt-ok', warn: 'text-dt-warn', danger: 'text-dt-danger', info: 'text-dt-info', neutral: 'text-dt-title', accent: 'text-dt-accent-text' }[tone] : 'text-dt-title';
  const border = tone === 'warn' ? 'border-dt-warn-border' : tone === 'danger' ? 'border-dt-danger-border' : 'border-dt-border';
  const inner = (
    <>
      {icon && <div className={`text-base mb-2 ${tone === 'warn' ? 'text-dt-warn' : 'text-dt-support'}`}>{icon}</div>}
      <div className="text-xs uppercase tracking-wide text-dt-muted mb-1">{label}</div>
      <div className={`text-xl font-semibold ${v}`}>{value}</div>
      {sub && <div className="text-xs text-dt-muted mt-0.5">{sub}</div>}
    </>
  );
  if (onClick) {
    return <button onClick={onClick} className={`rounded-xl border ${border} bg-dt-card px-4 py-3 min-w-0 text-left hover:border-dt-border-strong transition-colors`}>{inner}</button>;
  }
  return <div className={`rounded-xl border ${border} bg-dt-card px-4 py-3 min-w-0`}>{inner}</div>;
}

/* ── DetailTile — a labeled fact (Employee-File-strip style) ────────────── */
export function DetailTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dt-border bg-dt-card px-4 py-3 min-w-0">
      <div className="text-xs uppercase tracking-wide text-dt-muted mb-1">{label}</div>
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
      {at && <span className="text-xs text-dt-muted shrink-0">{at}</span>}
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
export const TH = 'py-2 px-3 text-xs uppercase tracking-wide text-dt-muted font-medium text-left whitespace-nowrap';
export const TD = 'py-2 px-3 text-sm text-dt-body';
export function TableScroll({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`overflow-x-auto rounded-xl border border-dt-border ${className}`}>{children}</div>;
}

/* ── Overlays — the ONE modal and the ONE right-drawer ──────────────────── */
/**
 * The behaviour every dialog owes its user, in one place.
 *
 * None of it existed: no modal in this application closed on Escape — not the
 * ten hand-rolled ones, and not this shared component either, so using the
 * primitive correctly still left you trapped. The page also kept scrolling
 * behind an open dialog, and focus stayed wherever it had been, so a keyboard
 * user tabbed through the page underneath.
 *
 * Fixing it here reaches every dialog that uses these primitives at once.
 */
function useDialogBehaviour(onClose: () => void) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);

    // Stop the page scrolling underneath. Restore whatever was there rather
    // than assuming '' — another dialog may already have locked it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus INTO the dialog: the first control if there is one, else the
    // panel itself, so the next Tab stays inside rather than starting from the
    // page behind.
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? panelRef.current)?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();   // put focus back where the user left it
    };
  }, [onClose]);

  return panelRef;
}

/** Dialog widths. A confirm prompt in a 2xl box is as wrong as a wizard in a
 *  small one, so the primitive offers the sizes the hand-rolled dialogs were
 *  reaching for rather than forcing everything to one of two. */
const MODAL_WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl', '2xl': 'max-w-2xl', '3xl': 'max-w-3xl' } as const;
export type ModalSize = keyof typeof MODAL_WIDTH;

export function Modal({ title, onClose, children, wide, size, padded = true, chrome = true, panelClass }:
  { title?: React.ReactNode; onClose: () => void; children: React.ReactNode;
    wide?: boolean; size?: ModalSize;
    /** Off when the body manages its own padding — a full-height wizard with a
     *  sticky footer cannot live inside the default box padding. */
    padded?: boolean;
    /** Off when the CHILD already draws a header and close button of its own
     *  (AISessionPanel does). Without this the dialog shows two titles and two
     *  close buttons, so such screens stayed hand-rolled and silently missed
     *  Escape, scroll-lock and focus return — the whole point of this
     *  primitive. The behaviour is what matters; the chrome is optional. */
    chrome?: boolean;
    /** Extra classes for the panel, for the rare dialog with a fixed height. */
    panelClass?: string }) {
  const panelRef = useDialogBehaviour(onClose);
  const width = MODAL_WIDTH[size ?? (wide ? '2xl' : 'lg')];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div ref={panelRef} tabIndex={-1}
        className={`w-full ${width} max-h-[90vh] overflow-y-auto ${chrome ? 'bg-dt-page border border-dt-border-strong rounded-2xl' : ''} ${padded && chrome ? 'p-6' : ''} ${panelClass ?? ''} focus:outline-none`}
        onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        {/* When the body brings its own padding, the header still needs some —
            otherwise the title sits flush against the panel edge. */}
        {chrome && (
          <div className={`flex items-center justify-between ${padded ? 'mb-4' : 'px-6 pt-6 pb-4'}`}>
            <h3 className="text-lg font-semibold text-dt-title">{title}</h3>
            <button onClick={onClose} aria-label="Close" className="text-dt-muted hover:text-dt-body text-xl leading-none">×</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
export function Drawer({ title, onClose, children }:
  { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  const panelRef = useDialogBehaviour(onClose);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div ref={panelRef} tabIndex={-1}
        className="w-full max-w-xl h-full bg-dt-page border-l border-dt-border-strong overflow-y-auto p-6 focus:outline-none"
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

/* ═══════════════════════════════════════════════════════════════════════════
   v2 SCHEMAS — four, and no more (design handoff 00 §06)
   Everything else composes from the primitives above. Each has a row in the
   catalog table in docs/design-system.md §2, per that document's own rule.

   ⚠ 12px IS THE TYPE FLOOR, and the v1 primitives above now meet it too:
   Chip, StatTile, DetailTile, TimelineStep and TH were carrying 10–11px
   labels. Lifted 2026-08-07 and checked in the schema gallery at all three
   widths — nothing reflowed, because these are labels above or beside their
   values, not table columns competing for width.

   ⚠ NO VARIANT PROPS FOR WIDTH. The handoff asks for container queries so one
   card works in a page grid, a narrow column and a drawer. Tailwind 3.4 here
   has no container-query plugin, and adding a build dependency to avoid
   writing `flex-wrap` is a poor trade — these use intrinsic layout instead:
   wrapping rows and auto-fit grids that reflow on their own width. Same
   outcome, no new build surface. If the plugin ever lands, these become
   @container without changing a call site.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── EmployeeCard — one digital employee, reporting work rather than config ─
   Avatar · name · live state · one-clause role · up to three stat cells ·
   what it last did OR why it stopped · a state-specific action.

   `blockedReason` is deliberately not just another `detail`: when an employee
   has stopped, why it stopped is the most important sentence on the card and
   it takes the warning tone. When it is working, the same slot carries its
   last action in muted text. One slot, two meanings, driven by state. */
export function EmployeeCard({ avatar, name, state, role, stats, lastAction, blockedReason, actions, onOpen }: {
  avatar?: React.ReactNode;
  name: React.ReactNode;
  /** Already-translated words — see src/design/statusVocabulary.ts. Never an enum. */
  state?: { label: string; tone?: Tone };
  /** One clause. "Customer support · answering chat & email" */
  role?: React.ReactNode;
  stats?: Array<{ label: string; value: React.ReactNode }>;
  lastAction?: React.ReactNode;
  /** When present this wins: a stopped employee's reason outranks its history. */
  blockedReason?: React.ReactNode;
  actions?: React.ReactNode;
  onOpen?: () => void;
}) {
  return (
    <article className="rounded-xl border border-dt-border bg-dt-card p-5 min-w-0 flex flex-col gap-3">
      <div className="flex items-start gap-3 min-w-0">
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {onOpen
              ? <button onClick={onOpen} className="text-[15px] font-semibold text-dt-title hover:text-dt-accent-text transition-colors truncate">{name}</button>
              : <span className="text-[15px] font-semibold text-dt-title truncate">{name}</span>}
            {state && <Chip tone={state.tone ?? 'neutral'} dot>{state.label}</Chip>}
          </div>
          {role && <p className="text-[13px] text-dt-support mt-0.5">{role}</p>}
        </div>
      </div>

      {/* auto-fit, so three cells become two and then one without a prop */}
      {stats && stats.length > 0 && (
        <dl className="grid grid-cols-dt-tiles gap-dt-tight">
          {stats.map((s, i) => (
            <div key={i} className="rounded-lg bg-dt-inset px-3 py-2 min-w-0">
              {/* ⚠ The label WRAPS; it does not truncate. Measured at the design
                  target, three cells leave ~78px and "closed without you" needs
                  100 — truncating rendered it as "closed without…", which is
                  worse than two lines. Only the VALUE truncates: values are
                  short by construction, labels are chosen by the caller. */}
              <dt className="text-xs text-dt-muted leading-tight">{s.label}</dt>
              <dd className="text-sm font-semibold text-dt-title truncate mt-0.5">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {blockedReason
        ? <p className="text-[13px] text-dt-warn">{blockedReason}</p>
        : lastAction ? <p className="text-[13px] text-dt-muted">{lastAction}</p> : null}

      {actions && <div className="flex items-center gap-2 flex-wrap mt-auto pt-1">{actions}</div>}
    </article>
  );
}

/* ── DecisionCard — one thing waiting on a human ────────────────────────────
   What it is · who prepared it and why they stopped · how long it has waited ·
   two or three real choices. Replaces QueueCard, which nothing imports.

   `nudge` is the pattern that makes this queue shrink: "you have approved
   every Meridian renewal for two years — let Marcus send these himself". A
   queue that never teaches you how to make it shorter is a treadmill. */
export function DecisionCard({ tone = 'warn', title, detail, meta, stale, actions, nudge }: {
  tone?: Tone;
  title: React.ReactNode;
  /** Who prepared it, and why they stopped. Plain sentences. */
  detail?: React.ReactNode;
  /** "Waiting 2 hours · Marcus · renewal invoice" — already in English. */
  meta?: React.ReactNode;
  /** Only when something has genuinely gone quiet. Not an SLA countdown. */
  stale?: React.ReactNode;
  actions?: React.ReactNode;
  nudge?: React.ReactNode;
}) {
  const edge = { ok: 'border-l-dt-ok', warn: 'border-l-dt-warn', danger: 'border-l-dt-danger',
                 info: 'border-l-dt-info', neutral: 'border-l-dt-neutral', accent: 'border-l-dt-accent' }[tone];
  return (
    <article className={`rounded-xl border border-dt-border border-l-2 ${edge} bg-dt-card p-5 min-w-0`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-dt-title min-w-0">{title}</h3>
        {stale && <span className="shrink-0"><Chip tone="warn">{stale}</Chip></span>}
      </div>
      {detail && <p className="text-sm text-dt-support mt-1.5">{detail}</p>}
      {meta && <p className="text-xs text-dt-muted mt-2">{meta}</p>}
      {actions && <div className="flex items-center gap-2 flex-wrap mt-4">{actions}</div>}
      {nudge && <p className="text-[13px] text-dt-accent-text mt-3 pt-3 border-t border-dt-border">{nudge}</p>}
    </article>
  );
}

/* ── FilterBar — one implementation for every list and report ───────────────
   Date presets · facets · search · saved views. Built as SLOTS rather than a
   config object: every list in this app filters on something different, and a
   schema that tries to own the filter LOGIC ends up with a prop per page. */
export function FilterBar({ presets, facets, search, views, className = '' }: {
  /** Usually Chips or small Buttons — 7 days / 30 days / this year. */
  presets?: React.ReactNode;
  facets?: React.ReactNode;
  search?: React.ReactNode;
  views?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-dt-tight flex-wrap rounded-xl border border-dt-border bg-dt-panel px-4 py-2.5 ${className}`}>
      {presets && <div className="flex items-center gap-1.5 flex-wrap">{presets}</div>}
      {facets && <div className="flex items-center gap-1.5 flex-wrap">{facets}</div>}
      {search && <div className="min-w-[180px] max-w-dt-field flex-1">{search}</div>}
      {views && <div className="flex items-center gap-1.5 ml-auto shrink-0">{views}</div>}
    </div>
  );
}

/* ── SetupChecklist — "hired, but not finished" ─────────────────────────────
   What is missing · why that matters · ONE button · an honest time estimate.

   EmptyState cannot say this: an unfinished employee is not an empty list, it
   is a thing half-built, and the difference matters to whoever has to finish
   it. Done items are struck through rather than hidden — progress is the
   reason anyone continues. */
export function SetupChecklist({ title, why, items, action, estimate }: {
  title: React.ReactNode;
  /** Why finishing this matters, in one sentence. */
  why?: React.ReactNode;
  items: Array<{ label: React.ReactNode; done?: boolean }>;
  action?: React.ReactNode;
  /** Plain and believable — "about 5 minutes". An estimate nobody trusts is
   *  worse than none at all. */
  estimate?: React.ReactNode;
}) {
  const left = items.filter((i) => !i.done).length;
  return (
    <div className="rounded-xl border border-dt-warn-border bg-dt-warn-soft p-5 min-w-0">
      <h3 className="text-[15px] font-semibold text-dt-title">{title}</h3>
      {why && <p className="text-[13px] text-dt-support mt-1">{why}</p>}
      <ul className="mt-3 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            <span className={it.done ? 'text-dt-ok' : 'text-dt-muted'} aria-hidden>{it.done ? '✓' : '○'}</span>
            <span className={it.done ? 'text-dt-muted line-through' : 'text-dt-body'}>{it.label}</span>
          </li>
        ))}
      </ul>
      {(action || estimate) && (
        <div className="flex items-center gap-3 flex-wrap mt-4">
          {action}
          {estimate && <span className="text-xs text-dt-muted">{estimate}</span>}
        </div>
      )}
      <p className="sr-only">{left} step{left === 1 ? '' : 's'} remaining</p>
    </div>
  );
}
