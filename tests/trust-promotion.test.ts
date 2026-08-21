import { describe, it, expect } from 'vitest';
import { trustPromotionCardCopy } from '../src/lib/trustPromotionPresentation';

describe('a trust promotion card states what the evidence actually is', () => {
  it('says plainly when the evidence is thin — RED if a no-history request looks the same as an earned one', () => {
    const copy = trustPromotionCardCopy({
      employeeName: 'Billing DE',
      category: 'action_execute',
      currentLevel: 0,
      targetLevel: 1,
      // ⚠ The decided-human count is NOT a top-level key. The live payload
      // carries it inside `criteria[]` under key 'human_samples'. An earlier
      // draft of this plan invented `human_decided`, which no task produces.
      evidence: { corroborated_successes: 0, corroborated_refusals: 0,
                  pending_reviews: 208,
                  criteria: [{ key: 'human_samples', actual: 0, required: 3, met: false }] },
    });
    expect(copy.detail).toMatch(/no approved actions/i);
    expect(copy.detail).toMatch(/208/);
  });

  it('does NOT say thin when there is real evidence — RED if every card cries thin', () => {
    const copy = trustPromotionCardCopy({
      employeeName: 'Billing DE',
      category: 'action_execute',
      currentLevel: 0,
      targetLevel: 1,
      evidence: { corroborated_successes: 12, corroborated_refusals: 3,
                  pending_reviews: 0,
                  criteria: [{ key: 'human_samples', actual: 5, required: 3, met: true }] },
    });
    expect(copy.detail).not.toMatch(/no approved actions/i);
  });
});
