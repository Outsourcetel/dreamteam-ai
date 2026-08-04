// _shared/confidence — THE deterministic inquiry-confidence formula, one place.
//
// Twin of public.compute_inquiry_confidence in SQL (migration 567). The two
// must stay byte-parallel; tests/confidence-parity.test.ts runs both over the
// same inputs and fails on drift — the same protection the content-hash twins
// have, added after that pair was found capable of drifting silently.
//
// WHY denied access carries NO penalty (migration 567, founder-directed):
// the formula prices missing evidence through FORGONE BONUSES — a DE that
// cannot read the CRM can never earn +12 account context, one that cannot read
// the helpdesk can never earn up to +24 corroborations. A further −15 per
// denied system double-counted the same absence as if it were evidence of
// error. Under the deny-by-default permissions model (docs/29) denied grants
// are the NORM, so the penalty systematically punished least-privilege
// configuration: a KB-only employee answering a KB question perfectly scored
// 40 + 8 − 30 = 18. Denied systems remain RECORDED in confidence_inputs and in
// the evidence steps — visible, just not priced as doubt.
//
// systems_failed keeps its penalty: a system the employee WAS supposed to read
// and could not is genuine uncertainty — the answer may contradict whatever is
// in the unreachable system, and a retry might have found it.

export function computeInquiryConfidence(inputs: Record<string, unknown>): number {
  const num = (v: unknown) => typeof v === 'number' ? v : 0;
  const bool = (v: unknown) => v === true;
  const raw = 40
    + Math.min(24, 8 * num(inputs.knowledge_hits))
    + Math.min(24, 8 * num(inputs.history_corroborations))
    + (bool(inputs.account_context_found) ? 12 : 0)
    - 15 * num(inputs.systems_failed);
  return Math.max(0, Math.min(97, Math.round(raw)));
}
