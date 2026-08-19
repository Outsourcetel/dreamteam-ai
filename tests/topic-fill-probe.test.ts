import { describe, it, expect } from 'vitest';
import { validatePayload, applyModelFill, FILL_WHITELIST } from '../supabase/functions/_shared/discoveryProposals.ts';

describe('the topic fill path, end to end through the REAL modules', () => {
  it('a model response shaped like the new prompt asks for produces a VALID conversation_type proposal', () => {
    // Exactly the shape the deployed prompt now demands: label, set_category,
    // match_pattern, optional owner_ref.
    const filled = applyModelFill('conversation_type', {}, {
      label: 'Late delivery',
      set_category: 'late_delivery',
      match_pattern: 'where is my order|not arrived|still waiting for delivery',
      owner_ref: 'archetype:cs_manager',
    });
    expect(() => validatePayload('conversation_type', filled)).not.toThrow();
    expect(filled.set_category).toBe('late_delivery');
    expect(filled.match_pattern).toContain('not arrived');
  });

  it('the whitelist admits exactly the fields the prompt asks for — RED if the two drift apart', () => {
    // This is the pair that was broken: the whitelist named fields the prompt
    // never asked the model to write, so every slot came back empty.
    const wl = [...FILL_WHITELIST.conversation_type].sort();
    expect(wl).toContain('label');
    expect(wl).toContain('set_category');
    expect(wl).toContain('match_pattern');
  });

  // ⚠ THIS ONE IS DEFENCE IN DEPTH, NOT A SINGLE PIN, AND I MEASURED IT.
  // Deleting validatePayload's 'has no payload to decide on' throw leaves this
  // GREEN — because the label guard catches the same case:
  //   'conversation_type proposal has no label — the customer has to be able
  //    to read what the topic is called'
  // So an inversion here is not proof the first guard exists; it is proof the
  // BEHAVIOUR survives losing either one. Recorded because a future reader
  // inverting the first throw will see green and reasonably suspect theatre.
  it('an UNFILLED slot is still refused — RED only if BOTH guards go', () => {
    expect(() => validatePayload('conversation_type', {})).toThrow();
  });
});
