/**
 * topicRouting — ONE classification, used for BOTH who answers and what the
 * conversation is labelled. Migration 760.
 *
 * ⚠⚠ WHY THIS IS A SHARED MODULE AND NOT THREE COPIES. There are THREE places
 * that insert a row into de_conversations:
 *
 *   · widget-ask/index.ts        — channel widget | hosted
 *   · email-inbound/index.ts     — channel email
 *   · de-answer/index.ts         — channel exam | portal | dock, and it created
 *                                  446 of the 460 conversations that exist
 *
 * Every one of them has to make the same three decisions in the same order, and
 * a fourth writer added tomorrow has to make them too. Three copies of "classify,
 * pick the owner, stamp all four triage columns" is three chances for one of
 * them to drift into stamping only `category` — see THE SILENT REGRESSION below,
 * which is not hypothetical.
 *
 * ⚠⚠⚠ THE SILENT REGRESSION, and it is the reason `triageColumns()` exists as a
 * function rather than as a comment. `de_conversations.priority` is NOT NULL
 * DEFAULT 'normal'; `severity` and `triaged_at` are nullable with no default.
 * `trg_triage_support_conversation` (migration 671) returns EARLY when
 * `category IS NOT NULL`. So a routed insert that stamped only the category
 * would leave severity NULL and priority stuck at 'normal' forever — on exactly
 * the traffic where a Safety rule writes sev1/urgent today. All four columns
 * come from this one function, together, or none of them do.
 *
 * ⚠⚠ AND WHAT GETS CLASSIFIED IS THE CUSTOMER'S QUESTION AND NOTHING ELSE.
 * The trigger historically classified `subject || ' ' || content`, and
 * widget-ask stores the first message as `[channel · displayName · account ref]
 * question`. `classify_support_text` matches BARE SUBSTRINGS, the live Safety
 * pattern contains `fire`, and Safety runs at rule_order 10 ahead of Billing at
 * 60 — so an account called "Fireside Media" asking about invoice payment terms
 * classified as a SAFETY EMERGENCY. Proven live 2026-08-18. Today that is a
 * wrong label; under routing it would be a COMPANY NAME deciding who answers.
 * Callers pass the question. Nothing else.
 *
 * ⚠ EVERY FAILURE PATH FALLS BACK TO EXACTLY TODAY'S BEHAVIOUR. An untriaged
 * channel, an RPC error, a tenant with no rules, a topic nobody owns, an owner
 * who has been retired or has never been published — all of them return an
 * owner of null, and the caller then does precisely what it did before this
 * module existed. That is the founder's decision 3, and it is expressed as the
 * shape of the return value rather than as a promise in a comment.
 *
 * ⚠⚠⚠ FIX ROUND (R1/R2) — ROUTING IS A DECISION MADE ONCE, AND THE FIRST
 * VERSION OF THIS MODULE MADE IT ON EVERY TURN.
 *
 * `classifyAndRoute` was called BEFORE the conversation-reuse check on all
 * three writers and was not gated on "is this thread new":
 * de-answer/index.ts:525 sat in the de_id-absent branch while conversation
 * resolution happened seventy lines later at :596; widget-ask computed
 * `routed` at :287 and only reached its `if (convId)` reuse check at :352;
 * email-inbound routed at :195 and looked for the 14-day thread at :212 —
 * with a comment at :203 claiming a reused thread is not re-routed.
 *
 * So turn 2 of an open thread could be answered, CHARGED and ESCALATED by
 * employee B while `de_conversations.de_id` still said employee A — the column
 * get_de_economics, get_de_performance_metrics, get_de_csat_metrics,
 * de_eval_quality, snapshot_de_kpi_readings, get_benchmark_report and
 * compose_weekly_value_digest all count by. Attribution frozen, execution
 * moving: this file's own two-paths-one-counted, inverted. Reachable in
 * shipped code — EndUserChatPage.tsx:190/:259 pass a stored conversationId
 * with de_id null on the multi-turn portal, and public/widget.js:144 sends
 * conversation_id on every turn.
 *
 * THE FOUNDER'S RULING IS THE STRONGER FORM, not merely "skip classification
 * when conversation_id is present": ON A THREAD THAT ALREADY EXISTS, READ THE
 * ROW'S de_id AND USE IT. That also closes the case that predates topic
 * routing entirely — the roster changes mid-thread (the oldest eligible
 * employee is retired, a widget key is re-bound) and the answering employee
 * silently shifts while the recorded owner does not. Nothing ever consulted
 * the recorded owner at all.
 *
 * `chooseAnswerer` below is that precedence, written ONCE as a pure function.
 * The three writers are Deno and cannot be imported by the test runner; this
 * can, so the precedence is inverted in a test instead of being argued about
 * in three files.
 */

/** The channels `trg_triage_support_conversation` triages (migration 671). A
 *  channel outside this set is deliberately NOT labelled — 282 exam
 *  conversations wearing customer-support categories is how the first taxonomy
 *  analysis reached a false verdict — and it is therefore not routed either.
 *  Routing a channel the platform refuses to label would be a second taxonomy
 *  with no screen behind it. */
export const TRIAGED_CHANNELS: readonly string[] = ['widget', 'hosted', 'portal', 'email', 'dock'];

export function isTriagedChannel(channel: string | null | undefined): boolean {
  return typeof channel === 'string' && TRIAGED_CHANNELS.includes(channel);
}

/** What `classify_support_text` returns. `rule_id` and `owner_de_id` are new in
 *  migration 760; the other four have been there since migration 233. */
export interface TopicTriage {
  category: string | null;
  priority: string | null;
  severity: string | null;
  rule: string | null;
  rule_id: string | null;
  /** The employee who answers this topic — already filtered to the same tenant,
   *  not the Workspace Assistant, and a lifecycle that can front customer chat.
   *  NULL means "the workspace's usual choice", which is every rule that
   *  existed before migration 760. */
  owner_de_id: string | null;
}

export interface RoutedTopic {
  triage: TopicTriage | null;
  /** The owning employee's row, resolved once, or null. `external_reply_mode`
   *  rides along because widget-ask reads it to decide draft vs auto send — it
   *  is a property of WHOEVER answers, so it has to move with the routing. */
  owner: { id: string; external_reply_mode: string | null } | null;
}

const EMPTY: RoutedTopic = { triage: null, owner: null };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>; from: (t: string) => any };

/**
 * Classify the customer's question and resolve who answers it — ONE call,
 * ONE answer, used for both the routing and the stored label.
 *
 * Returns `{triage: null, owner: null}` for anything that is not a triaged
 * channel, and on any RPC failure. A caller holding that value must behave
 * exactly as it did before this module existed.
 */
export async function classifyAndRoute(
  admin: Admin,
  tenantId: string,
  question: string,
  channel: string | null | undefined,
): Promise<RoutedTopic> {
  if (!isTriagedChannel(channel)) return EMPTY;
  const text = String(question ?? '').trim();
  if (!text) return EMPTY;

  let triage: TopicTriage | null = null;
  try {
    const { data, error } = await admin.rpc('classify_support_text', {
      p_tenant_id: tenantId, p_text: text,
    });
    // ⚠ BOTH halves. `.rpc()` RESOLVES on a Postgres error — it does not throw —
    // so checking only the catch would treat a failed classification as a
    // successful "no owner, no category" and silently stop labelling every
    // conversation on the platform.
    if (error || !data || typeof data !== 'object') return EMPTY;
    triage = data as TopicTriage;
  } catch {
    return EMPTY;
  }

  // A classification with no category is not a classification. Refusing it here
  // keeps `triageColumns` honest: it never returns a partial set.
  if (!triage || !triage.category || !triage.priority || !triage.severity) return EMPTY;

  if (!triage.owner_de_id) return { triage, owner: null };

  // The owner id came back already filtered by the SQL function (same tenant,
  // not the Workspace Assistant, not paused/retired/archived/designed). This
  // read is only for `external_reply_mode`, which the widget needs and the
  // classifier has no business returning.
  try {
    const { data, error } = await admin.from('digital_employees')
      .select('id, external_reply_mode')
      .eq('id', triage.owner_de_id).eq('tenant_id', tenantId).maybeSingle();
    if (error || !data) return { triage, owner: null };
    return { triage, owner: { id: String(data.id), external_reply_mode: data.external_reply_mode ?? null } };
  } catch {
    return { triage, owner: null };
  }
}

/** The employee who answers a turn, in the shape all four callers already
 *  hold. `external_reply_mode` rides along because widget-ask reads it to
 *  decide draft vs auto send and it is a property of WHOEVER answers. */
export interface Answerer { id: string; external_reply_mode: string | null }

/** Which of the four inputs decided. Returned rather than inferred so a caller
 *  can log it, and so the test can tell "the topic won" from "the topic was
 *  never asked" — two states that look identical from the id alone. */
export type AnswererReason = 'named' | 'thread' | 'topic' | 'fallback' | 'nobody';

/**
 * WHO ANSWERS THIS TURN — the whole precedence, in one place.
 *
 *   1. NAMED — a human or another server component said who: a caller-supplied
 *      `de_id` (the dock passes the Workspace Assistant; de-orchestrate passes
 *      the employee a supervisor or a topic chose; email-inbound passes the
 *      owner it just resolved), or an explicitly bound widget key (mig 323).
 *      "An employee somebody named always wins" is the sentence that was
 *      already in de-answer, and this is it as code.
 *   2. THREAD — the conversation already exists, so the employee is whoever
 *      `de_conversations.de_id` says. THIS IS THE FIX. It outranks the topic
 *      AND today's fallback, because de_id is write-once by design (twelve SQL
 *      functions UPDATE that table and not one names it) and every
 *      employee-performance reader counts by it: an answerer who is not the
 *      recorded owner is work attributed to somebody who did not do it.
 *   3. TOPIC — the customer wrote a rule saying who answers this kind of
 *      question. Only ever consulted on a thread that does not exist yet,
 *      which is why callers do not classify at all when they are reusing.
 *   4. FALLBACK — exactly what this platform did before any of this existed:
 *      external_reply_mode='auto' if any (it never has been — 'draft' on all
 *      109 employees across all 18 tenants), else the oldest eligible.
 *
 * Pure. No I/O. Every candidate is resolved and eligibility-checked by the
 * caller before it gets here, so this function decides ORDER and nothing else.
 */
export function chooseAnswerer(c: {
  named?: Answerer | null;
  thread?: Answerer | null;
  topic?: Answerer | null;
  fallback?: Answerer | null;
}): { who: Answerer | null; reason: AnswererReason } {
  if (c.named) return { who: c.named, reason: 'named' };
  if (c.thread) return { who: c.thread, reason: 'thread' };
  if (c.topic) return { who: c.topic, reason: 'topic' };
  if (c.fallback) return { who: c.fallback, reason: 'fallback' };
  return { who: null, reason: 'nobody' };
}

/**
 * MAY THE AI ROUTER CHOOSE? — the founder's R2 ruling, as one predicate.
 *
 * `de-orchestrate` shows a designated supervisor the roster and asks an LLM to
 * pick BY RESPONSIBILITY FIT, then calls de-answer with `de_id: chosen`. Since
 * a named employee wins, that model call silently overrode the owner the
 * customer named in the interview — AI overriding customer, as the default.
 *
 * The founder ruled the other way: AN OWNER THE CUSTOMER EXPLICITLY NAMED
 * WINS, AND THE ROUTER CHOOSES ONLY WHERE NO TOPIC MATCHED. It is dormant
 * today — `is_supervisor` is false on all 109 employees across all 18 tenants,
 * so `active_supervisors = 0` — which is exactly why it is pinned: switching
 * the router on must not be able to reverse a decision quietly.
 */
export function routerMayChoose(routed: RoutedTopic | null | undefined): boolean {
  return !routed?.owner;
}

/** Lifecycles that never front customer chat. widget-ask and email-inbound
 *  have excluded these four at the front desk since long before topic routing;
 *  `classify_support_text` applies the same four to a topic owner. A thread's
 *  RECORDED owner is held to the same bar — a conversation whose employee has
 *  since been retired or un-published must still get answered, and it gets
 *  answered by the fallback, never by a classification. */
export const NEVER_FRONTS_CUSTOMER_CHAT: readonly string[] = ['paused', 'retired', 'archived', 'designed'];

/**
 * The four triage columns, TOGETHER OR NOT AT ALL — see the header. Spread into
 * the de_conversations insert; `{}` when there is nothing to stamp, which leaves
 * the trigger to do exactly what it does today.
 */
export function triageColumns(triage: TopicTriage | null): Record<string, unknown> {
  if (!triage || !triage.category || !triage.priority || !triage.severity) return {};
  return {
    category: triage.category,
    severity: triage.severity,
    priority: triage.priority,
    triaged_at: new Date().toISOString(),
  };
}
