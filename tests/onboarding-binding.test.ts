import { describe, it, expect } from 'vitest';
import { resolveParams } from '../src/lib/onboardingTypes';

describe('resolveParams', () => {
  const binding = {
    action_key: 'configure_customer_setup',
    params: { external_ref: '@account', territory: '@ask', payment_terms: 'Net 30' },
  };

  it('fills @account, @ask and literals', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'Grant Plastics Ltd.',
      requirements: { 'configure_customer_setup.territory': 'United Kingdom' },
    });
    expect(r.missing).toEqual([]);
    expect(r.params).toEqual({
      external_ref: 'Grant Plastics Ltd.',
      territory: 'United Kingdom',
      payment_terms: 'Net 30',
    });
  });

  it('names every unanswered @ask instead of guessing', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'Grant Plastics Ltd.', requirements: {},
    });
    expect(r.missing).toEqual(['territory']);
    expect(r.params.territory).toBeUndefined();
  });

  it('does not read another verb\'s answer for the same param name', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'X',
      requirements: { territory: 'Wrong' },
    });
    expect(r.missing).toEqual(['territory']);
    expect(r.params.territory).toBeUndefined();
  });

  it('treats empty-string @ask answer as missing', () => {
    const r = resolveParams(binding, {
      accountExternalRef: 'Grant Plastics Ltd.',
      requirements: { 'configure_customer_setup.territory': '' },
    });
    expect(r.missing).toEqual(['territory']);
    expect(r.params.territory).toBeUndefined();
  });

  it('treats null accountExternalRef as missing for @account params', () => {
    const localBinding = {
      action_key: 'setup',
      params: { company_id: '@account' },
    };
    const r = resolveParams(localBinding, {
      accountExternalRef: null,
      requirements: {},
    });
    expect(r.missing).toEqual(['company_id']);
    expect(r.params.company_id).toBeUndefined();
  });
});
