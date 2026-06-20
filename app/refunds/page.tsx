import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Refund Policy — Renderball",
};

export default function RefundsPage() {
  return (
    <LegalShell title="Refund Policy" updated="June 2026">
      <Clause heading="1. Free first minute">
        <p>
          Your first minute of video is free and requires no card, so you can try
          Renderball and see the output quality before you pay anything.
        </p>
      </Clause>
      <Clause heading="2. Failed renders">
        <p>
          You approve the script before any video is rendered, so you only pay
          for work you have already agreed to. If a render fails for a technical
          reason on our side, we will re-render it at no extra cost or refund the
          amount charged for that video.
        </p>
      </Clause>
      <Clause heading="3. Pay-as-you-go and credits">
        <p>
          Per-minute charges and credit packs are for delivered renders. Unused
          credits remain on your account. If you were charged in error, contact
          us and we will make it right.
        </p>
      </Clause>
      <Clause heading="4. Subscriptions">
        <p>
          Subscriptions renew automatically and can be cancelled at any time from
          your account; cancellation takes effect at the end of the current
          billing period and stops future charges. If you are dissatisfied with a
          subscription, contact us within 14 days of a charge and we will review
          your request in good faith.
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
