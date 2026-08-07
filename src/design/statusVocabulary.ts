// ═══════════════════════════════════════════════════════════════════════════
// DreamTeam Design System v2 — STATUS VOCABULARY
//
// Database enums leak into the UI everywhere. `needs_human` is a column value;
// it is not a thing to show a business owner. This is the one place that
// translates, so a screen never invents its own wording — six pages had grown
// their own STATUS_META map before this existed, and they disagreed.
//
// ⚠ COLOUR MEANINGS ARE UNCHANGED (design-system §4). Only the words are:
// emerald = healthy, amber = needs a human, rose = failed or blocked,
// sky = informational, indigo = selected/active/AI. Every tone below is the
// tone that value already carried.
//
// ⚠ GROUNDED IN THE REAL ENUMS, read from check constraints on 2026-08-07, not
// from a design document. The handoff that prompted this listed
// `lifecycle: draft → "Not started"`; there is no `draft` in
// digital_employees_lifecycle_status_check. The twelve values below are what
// the column actually permits, and `designed` is the one that means "hired,
// but not set up yet".
//
// ⚠ CODE KEEPS THE ENUM. Never compare against these labels, never store one.
// They are display only — `label(deStatus, 'active')`, never
// `if (x === 'Working')`.
// ═══════════════════════════════════════════════════════════════════════════

import type { Tone } from './primitives';

export interface StatusWord {
  /** What the owner reads. Plain English, no product jargon. */
  label: string;
  /** One clause explaining what it MEANS, for tooltips and empty states. */
  means: string;
  /** The semantic tone this value already carried — unchanged by v2. */
  tone: Tone;
}

type Vocab<K extends string> = Record<K, StatusWord>;

/** `digital_employees.status` — what it is doing right now. */
export type DeStatus = 'active' | 'idle' | 'disabled';
export const DE_STATUS: Vocab<DeStatus> = {
  active:   { label: 'Working',   means: 'Doing its job right now',                  tone: 'ok' },
  idle:     { label: 'Waiting',   means: 'Set up and ready, with nothing to do yet',  tone: 'neutral' },
  disabled: { label: 'Paused',    means: 'Stopped by someone, and will not pick work up until restarted', tone: 'warn' },
};

/** `digital_employees.lifecycle_status` — how far through setup it is. */
export type DeLifecycle =
  | 'designed' | 'configured' | 'trained' | 'tested' | 'certified'
  | 'published' | 'assigned' | 'active' | 'improving' | 'paused'
  | 'retired' | 'archived';
export const DE_LIFECYCLE: Vocab<DeLifecycle> = {
  designed:   { label: 'Not started',      means: 'Hired, but not set up yet',                       tone: 'neutral' },
  configured: { label: 'Being set up',     means: 'Its job is described; it has not learned it yet',  tone: 'info' },
  trained:    { label: 'Learning',         means: 'It has the knowledge and is being taught the work', tone: 'info' },
  tested:     { label: 'In rehearsal',     means: 'Practising on real cases without touching anything', tone: 'info' },
  certified:  { label: 'Passed its test',  means: 'Proved it can do the work; not live yet',          tone: 'ok' },
  published:  { label: 'Ready',            means: 'Live and able to take work',                       tone: 'ok' },
  assigned:   { label: 'Has an owner',     means: 'Someone is responsible for it',                    tone: 'ok' },
  active:     { label: 'Working',          means: 'Doing its job right now',                          tone: 'ok' },
  improving:  { label: 'Being improved',   means: 'Still working, while someone changes how it works', tone: 'info' },
  paused:     { label: 'Paused',           means: 'Stopped by someone, and will not pick work up until restarted', tone: 'warn' },
  retired:    { label: 'Retired',          means: 'No longer working; its record is kept',            tone: 'neutral' },
  archived:   { label: 'Archived',         means: 'Filed away and out of the way',                    tone: 'neutral' },
};

/** `de_conversations.status` — where a piece of work has got to. */
export type ConversationStatus = 'needs_human' | 'human_owned' | string;
export const CONVERSATION_STATUS: Record<string, StatusWord> = {
  needs_human: { label: 'Blocked',  means: 'Stopped, and cannot start again without you',  tone: 'warn' },
  human_owned: { label: 'Yours',    means: 'You took it over; the employee stepped back',   tone: 'info' },
};

/** `de_messages.delivery` — what happened to something it wrote. */
export const MESSAGE_DELIVERY: Record<string, StatusWord> = {
  draft_pending: { label: 'Reply ready to send', means: 'Written, and nothing is sent until you approve', tone: 'warn' },
};

/** `de_incidents.kind` — what went wrong. */
export const INCIDENT_KIND: Record<string, StatusWord> = {
  eval_regression: { label: 'Got something wrong', means: 'Failed a test it used to pass', tone: 'danger' },
};

// ── Words retired from anything an owner reads ──────────────────────────────
//
// They stay in code, in the database and in docs/. They do not belong on a
// screen: every one of them asks the reader to have built the product.
// Left here as an executable list so a lint or a review can check copy against
// it, rather than as a paragraph in a document nobody greps.
export const RETIRED_FROM_UI = [
  'DE', 'Digital Employee', 'Proving Ground', 'Self-Learning',
  'At Work cockpit', 'trust dial', 'guardrail block', 'Human Tasks',
] as const;

/**
 * Translate one enum value. Falls back to the raw value made readable rather
 * than to an empty string — an unknown status must still say something, and a
 * blank cell reads as "nothing here" when it means "we did not recognise this".
 */
export function say(vocab: Record<string, StatusWord>, value: string | null | undefined): StatusWord {
  if (!value) return { label: 'Unknown', means: 'No status recorded', tone: 'neutral' };
  return vocab[value] ?? {
    label: value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    means: '',
    tone: 'neutral',
  };
}
