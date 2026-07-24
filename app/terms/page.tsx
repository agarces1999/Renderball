import type { Metadata } from "next";
import { Clause, LegalShell } from "../../components/LegalShell";

export const metadata: Metadata = {
  title: "Terms of Service — Renderball",
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="June 2026">
      <Clause heading="1. Agreement">
        <p>
          These Terms of Service govern your access to and use of Renderball (the
          &ldquo;Service&rdquo;), operated by Renderball, Inc. By creating an
          account or using the Service, you agree to these terms. If you do not
          agree, do not use the Service.
        </p>
      </Clause>
      <Clause heading="2. The service">
        <p>
          Renderball generates on-brand design documents — presentation decks,
          graphics, and, where offered, animated video — from a brief you
          provide. You describe the document, review and approve a generated
          outline, and we build it into an editable document you can export
          (PDF, PNG, or MP4 where offered). Output quality depends on the
          inputs you provide and the nature of generative AI; we do not
          guarantee any specific result.
        </p>
      </Clause>
      <Clause heading="3. Accounts">
        <p>
          You must provide accurate information and keep your account secure. You
          are responsible for activity under your account. You must be at least
          18 years old, or the age of majority in your jurisdiction.
        </p>
      </Clause>
      <Clause heading="4. Acceptable use">
        <p>You agree not to use the Service to create, upload, or distribute content that:</p>
        <p>
          (a) infringes anyone&rsquo;s intellectual property, publicity, or
          privacy rights; (b) uses a brand, logo, or trademark you are not
          authorized to use; (c) is unlawful, deceptive, defamatory, hateful, or
          harassing; (d) impersonates a person or organization; or (e) violates
          any applicable law. We may suspend or terminate accounts that violate
          this section and remove content in response to valid complaints.
        </p>
      </Clause>
      <Clause heading="5. Your content and brand assets">
        <p>
          You retain ownership of the briefs, text, logos, images, and other
          materials you provide (&ldquo;Your Content&rdquo;) and of the
          documents you generate. You represent and warrant that you own or have the rights
          to use Your Content, including any brand assets you upload or that we
          extract from a website you submit.
        </p>
        <p>
          You grant Renderball a limited license to host, process, and transmit
          Your Content solely to operate and provide the Service. You agree to
          indemnify Renderball against claims arising from Your Content or from
          your use of brand assets you were not authorized to use.
        </p>
      </Clause>
      <Clause heading="6. Payment">
        <p>
          Paid plans and credits are billed through our third-party payment
          processor, which acts as the merchant of record for your purchase.
          Subscriptions renew automatically until cancelled. You can cancel at
          any time; cancellation stops future renewals and takes effect at the
          end of the current billing period. Prices are shown at checkout and may
          change with notice.
        </p>
      </Clause>
      <Clause heading="7. Refunds">
        <p>
          Refunds are handled under our{" "}
          <a className="text-accent-text underline" href="/refunds">
            Refund Policy
          </a>
          .
        </p>
      </Clause>
      <Clause heading="8. Disclaimers">
        <p>
          The Service is provided &ldquo;as is&rdquo; without warranties of any
          kind, express or implied, including merchantability, fitness for a
          particular purpose, and non-infringement. AI-generated output may
          contain errors; you are responsible for reviewing any output before
          you publish or distribute it.
        </p>
      </Clause>
      <Clause heading="9. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Renderball will not be liable
          for indirect, incidental, special, or consequential damages, and our
          total liability for any claim will not exceed the amount you paid us in
          the 3 months before the claim arose.
        </p>
      </Clause>
      <Clause heading="10. Termination">
        <p>
          You may stop using the Service at any time. We may suspend or terminate
          access for violations of these terms or to comply with the law.
        </p>
      </Clause>
      <Clause heading="11. Changes">
        <p>
          We may update these terms from time to time. Material changes will be
          posted on this page with a new effective date; continued use after a
          change constitutes acceptance.
        </p>
      </Clause>
      <Clause heading="12. Contact">
        <p>
          Questions about these terms:{" "}
          <a className="text-accent-text underline" href="mailto:support@renderball.com">
            support@renderball.com
          </a>
          .
        </p>
      </Clause>
    </LegalShell>
  );
}
