import React from 'react';

// Starter draft, not a finished legal document — see the banner below.
// Added during the pre-launch readiness review (2026-07-08): the signup
// form claimed "By signing up you agree to DreamTeam's terms of service"
// with no actual document behind it anywhere. This is a first pass for a
// lawyer to review before it's treated as real/binding.
const TermsOfServicePage = ({ onBack }: { onBack?: () => void }) => (
  <div className="min-h-screen bg-slate-950 text-slate-300 overflow-y-auto">
    <div className="max-w-3xl mx-auto px-6 py-12">
      {onBack && (
        <button onClick={onBack} className="text-sm text-indigo-400 hover:text-indigo-300 mb-6">← Back</button>
      )}

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-8">
        <p className="text-sm font-medium text-amber-300 mb-1">Draft — not yet reviewed by a lawyer</p>
        <p className="text-xs text-amber-400/80">
          This is a starting-point draft written to reflect what DreamTeam AI actually does today. It is not final
          and should not be relied on as a binding legal agreement until reviewed by qualified legal counsel and the
          bracketed placeholders below are filled in.
        </p>
      </div>

      <h1 className="text-2xl font-bold text-white mb-2">Terms of Service</h1>
      <p className="text-sm text-slate-500 mb-8">Last updated: [date] · Effective: [date]</p>

      <div className="space-y-8 text-sm leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold text-white mb-2">1. Who this agreement is between</h2>
          <p>
            These Terms of Service ("Terms") govern access to and use of DreamTeam AI (the "Service"), operated by
            [Legal Entity Name] ("DreamTeam AI," "we," "us," or "our"). By creating an account or otherwise using the
            Service, you ("Customer," "you") agree to these Terms on behalf of yourself and the organization you
            represent.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">2. What the Service is</h2>
          <p>
            DreamTeam AI provides software that deploys AI-driven "Digital Employees" to help run parts of your
            business — including customer support, sales, onboarding, customer success, and related workflows. The
            Service processes data you connect or upload (including customer data, documents, and business records)
            to power these AI features. The Service may use third-party AI providers (including Anthropic, OpenAI,
            and Google) to generate responses; see our Privacy Policy for how that data is handled.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">3. Accounts and eligibility</h2>
          <p>
            You must provide accurate information when creating an account and keep your login credentials secure.
            You're responsible for all activity that happens under your organization's account, including actions
            taken by team members you invite. You must be authorized to bind your organization to these Terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">4. Acceptable use</h2>
          <p>You agree not to use the Service to:</p>
          <ul className="list-disc list-inside mt-2 space-y-1 text-slate-400">
            <li>Violate any law or the rights of any third party</li>
            <li>Upload or process data you don't have the right to use</li>
            <li>Attempt to breach, disable, or circumvent the Service's security or access controls</li>
            <li>Use the Service to build a directly competing product</li>
            <li>Resell or provide the Service to third parties without our written consent</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">5. Trials, plans, and billing</h2>
          <p>
            New accounts may start with a free trial period. [Placeholder: describe trial length, what happens at
            trial's end, plan tiers, and billing/payment terms once a real billing system is in place. Today,
            billing is handled manually outside the product — this section needs to be finalized once a payment
            provider is integrated.]
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">6. Your data</h2>
          <p>
            You retain ownership of the data you upload or connect to the Service ("Customer Data"). We use Customer
            Data only to provide and improve the Service on your behalf, as described in our Privacy Policy. You can
            request deletion of your account and Customer Data by contacting us (see Section 10).
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">7. AI-generated output</h2>
          <p>
            The Service uses AI models to generate responses, recommendations, and automated actions. AI output can
            be incorrect or incomplete. You're responsible for reviewing AI-driven actions before relying on them,
            particularly for anything involving payments, legal, medical, or other high-stakes decisions. The Service
            includes human-review and approval gates for certain actions — you should configure these appropriately
            for your use case.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">8. Termination</h2>
          <p>
            Either party may terminate this agreement at any time. We may suspend or terminate your access if you
            violate these Terms, if your account is inactive past a trial period without upgrading, or for
            non-payment. Upon termination, you can request an export of your Customer Data for [30] days, after
            which it may be deleted.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">9. Disclaimers and limitation of liability</h2>
          <p>
            [Placeholder: standard "as-is" disclaimer, limitation of liability cap, and indemnification language —
            this section in particular should be drafted by legal counsel, not left as a template.]
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">10. Contact</h2>
          <p>
            Questions about these Terms can be sent to{' '}
            <a href="mailto:bkhan@outsourcetel.com" className="text-indigo-400 hover:underline">bkhan@outsourcetel.com</a>.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-white mb-2">11. Governing law</h2>
          <p>[Placeholder: governing jurisdiction, to be set by legal counsel.]</p>
        </section>
      </div>
    </div>
  </div>
);

export default TermsOfServicePage;
