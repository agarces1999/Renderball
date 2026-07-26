import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Refund Policy — Renderball",
};

/**
 * Must describe the model the customer is actually charged under. This page
 * still said "a single monthly subscription at $49.99 per month" after the
 * pivot to usage-based token pricing — a legal document contradicting the
 * checkout is the worst possible mismatch, so it tracks lib/metering.ts and
 * the pricing block on the landing.
 */
export default function RefundsPage() {
  return (
    <LegalShell title="Refund Policy" updated="July 2026">
      <Clause heading="1. How billing works">
        <p>
          Renderball is usage-based. There is no subscription and no monthly
          fee. Editing an existing document — moving, resizing, rewriting,
          reordering, deleting, undoing — is always free and is never metered.
          You are charged only when Renderball generates something for you, and
          only for the tokens that generation consumes.
        </p>
        <p>
          Your first 1,000,000 tokens are free. Beyond that, usage is billed per
          token in arrears through our payment processor.
        </p>
      </Clause>
      <Clause heading="2. Nothing to cancel">
        <p>
          Because there is no recurring subscription, there is nothing to
          cancel. If you stop generating, you stop being charged. You keep
          access to documents you have already created, and you can keep editing
          and exporting them at no cost.
        </p>
      </Clause>
      <Clause heading="3. Failed builds and generations">
        <p>
          You approve the outline before any document is built, so you only pay
          for work you have already agreed to. If a build, generation, or export
          fails for a technical reason on our side, we do not charge you for it;
          where usage has already been recorded, we credit it back. If you are
          charged for a generation that failed, tell us and we will refund it.
        </p>
      </Clause>
      <Clause heading="4. Disputed usage">
        <p>
          If a charge does not look right to you, contact us within 30 days of
          the invoice and we will review the underlying usage with you in good
          faith. Your recorded usage is visible on your account page at any
          time.
        </p>
      </Clause>
      <Clause heading="5. How to request a refund">
        <p>
          Email{" "}
          <a className="text-accent-text underline" href="mailto:support@renderball.com">
            support@renderball.com
          </a>{" "}
          with your account email and the charge in question. Refunds are issued
          to the original payment method through our payment processor, which acts
          as the merchant of record for your purchase.
        </p>
      </Clause>
    </LegalShell>
  );
}
