import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Refund Policy — Renderball",
};

export default function RefundsPage() {
  return (
    <LegalShell title="Refund Policy" updated="June 2026">
      <Clause heading="1. Subscription">
        <p>
          Renderball is offered as a single monthly subscription at $49.99 per
          month. The subscription renews automatically until you cancel.
        </p>
      </Clause>
      <Clause heading="2. Cancel anytime">
        <p>
          You can cancel from your billing settings at any time. Cancellation
          takes effect at the end of the current billing period and stops all
          future charges. You keep access through the end of the period you
          already paid for.
        </p>
      </Clause>
      <Clause heading="3. Failed builds">
        <p>
          You approve the outline before any document is built, so you only pay
          for work you have already agreed to. If a build or export fails for a
          technical reason on our side, we will re-run it at no extra cost.
        </p>
      </Clause>
      <Clause heading="4. Dissatisfaction within 14 days">
        <p>
          If you are dissatisfied with the Service, contact us within 14 days of
          a subscription charge and we will review your request in good faith.
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
